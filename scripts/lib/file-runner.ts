// Runs test files, each in its own `node --test <file>` process, a few at a time, with a wall-clock limit per file. A file that runs past its
// limit has its whole process tree ended (scripts/lib/kill-tree.ts) and is failed with a stated reason, so one hang can never take the run.
// Before, the whole tier was one `node --test` process: a test file that never exited (a review server left listening after its teardown threw,
// a connector child holding the file's pipe on Windows) held its concurrency slot until the CI job cap killed the run, and every later file was
// cancelled. Each file's output is printed whole when it ends (two files never interleave), its own summary lines folded into one totals block.
import { spawn } from "node:child_process";
import { killTree } from "./kill-tree.ts";

export interface FileRunOptions {
  /** Node flags placed before `--test` (e.g. `--import ./scripts/test-bootstrap.ts`). */
  nodeArgs: string[];
  /** Flags handed to `node --test` with each file (e.g. `--test-name-pattern=x`). */
  testArgs: string[];
  concurrency: number;
  timeoutMs: number;
  /** Where each file's finished output goes (default: process.stdout). */
  write?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface FileResult {
  file: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  ms: number;
  counts: Record<string, number>;
}

const SUMMARY = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)\s*$/;
const ANSI = /\x1b\[[0-9;]*m/g;

/** Splits a file's output into the lines it printed and its `ℹ <name> <n>` summary counts. */
export function foldSummary(text: string): { body: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const m = SUMMARY.exec(line.replace(ANSI, ""));
    if (m) counts[m[1]!] = (counts[m[1]!] ?? 0) + Number(m[2]);
    else kept.push(line);
  }
  return { body: kept.join("\n").replace(/\n+$/, ""), counts };
}

export function runOneFile(file: string, o: FileRunOptions): Promise<FileResult> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...o.nodeArgs, "--test", ...o.testArgs, file], {
      stdio: ["ignore", "pipe", "pipe"],
      env: o.env ?? process.env,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    let timedOut = false;
    let settled = false;
    let exitInfo: { status: number | null; signal: NodeJS.Signals | null } | undefined;
    let closeWait: NodeJS.Timeout | undefined;
    let pipeHeld = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeWait !== undefined) clearTimeout(closeWait);
      // A process the file started can still hold the pipe after the file's own process ended; the pipe is let go so it cannot hold this run.
      child.stdout.destroy();
      child.stderr.destroy();
      const { body, counts } = foldSummary(Buffer.concat(chunks).toString("utf8"));
      const ms = performance.now() - t0;
      const write = o.write ?? ((s: string) => void process.stdout.write(s));
      let text = body === "" ? "" : `${body}\n`;
      if (timedOut) {
        text += `✖ ${file}: TIMED OUT after ${Math.round(o.timeoutMs / 1000)} s; its process tree was ended. A test or a process it started never finished (a server left listening, a child left running).\n`;
      } else if (pipeHeld) {
        text += `⚠ ${file}: its test process ended but a process it started still held its output; that process may still be running.\n`;
      }
      if (!timedOut && (exitInfo?.status ?? 1) !== 0 && (counts.fail ?? 0) === 0) {
        text += `✖ ${file}: its test process exited with ${exitInfo?.signal ? `signal ${exitInfo.signal}` : `code ${exitInfo?.status}`} and reported no failing test.\n`;
      }
      text += `▷ ${file} ${(ms / 1000).toFixed(1)} s\n`;
      write(text);
      resolve({ file, status: exitInfo?.status ?? null, signal: exitInfo?.signal ?? null, timedOut, ms, counts });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // The process tree is gone; its exit is awaited briefly, and the file is failed either way.
      setTimeout(finish, 5_000).unref();
    }, o.timeoutMs);
    child.on("error", (error) => {
      chunks.push(Buffer.from(`could not start the test process: ${error.message}\n`));
      exitInfo = { status: null, signal: null };
      finish();
    });
    child.on("exit", (status, signal) => {
      exitInfo = { status, signal };
      // Normally the pipes close right after; a grandchild holding one gets two seconds, then the file is finished without it.
      closeWait = setTimeout(() => { pipeHeld = true; finish(); }, 2_000);
    });
    child.on("close", () => finish());
  });
}

export interface RunTotals {
  results: FileResult[];
  counts: Record<string, number>;
  failedFiles: string[];
  timedOutFiles: string[];
}

/** Runs every file through a pool of `concurrency` slots, in the given order. */
export async function runFiles(files: string[], o: FileRunOptions): Promise<RunTotals> {
  const results: FileResult[] = new Array(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const i = next++;
      results[i] = await runOneFile(files[i]!, o);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, files.length)) }, worker));
  const counts: Record<string, number> = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const r of results) for (const [k, v] of Object.entries(r.counts)) if (k !== "duration_ms") counts[k] = (counts[k] ?? 0) + v;
  const timedOutFiles = results.filter((r) => r.timedOut).map((r) => r.file);
  // A timed-out file, or one whose process failed without a failing test, counts as one failing test so the totals cannot read green.
  const failedFiles = results.filter((r) => r.timedOut || r.status !== 0).map((r) => r.file);
  for (const r of results) if (r.timedOut || (r.status !== 0 && (r.counts.fail ?? 0) === 0)) { counts.tests! += 1; counts.fail! += 1; }
  return { results, counts, failedFiles, timedOutFiles };
}
