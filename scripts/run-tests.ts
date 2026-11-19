#!/usr/bin/env node
// `npm test` / `npm run test:fast` / `npm run test:slow` entry (the runner takes the suite lock itself, see scripts/lib/suite-lock.ts): runs each
// test file in its own node test runner process with a time limit (scripts/lib/file-runner.ts), then stops any review process a test left
// running and says so. Tests stop their own; this is the net for a failed or interrupted one. Only
// processes whose COCHECK_HOME is under the temp dir AND named like a test home (`cocheck-*`) are signalled:
// a probe or fidelity run's `probe-*` / `cocheck-fidelity-*` home may belong to a run in another terminal,
// so those are reported, never stopped.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFiles } from "./lib/file-runner.ts";
import { ensurePdfHelper } from "./lib/pdf-helper-cache.ts";
import { scrubRecorderEnv } from "./lib/recorder-env.ts";
import { takeSuiteLock } from "./lib/suite-lock.ts";
import { captureGitState, writePassRecord } from "./lib/test-pass-record.ts";
import { discoverTests, selectTestArgs, tierArithmetic } from "./lib/test-tiers.ts";
import { killTempReviewProcesses, tempReviewProcesses } from "./lib/review-procs.ts";

// `--tier=fast|slow|all` (default all) picks the files; everything else is handed to the node test runner as before.
const tierArg = process.argv.slice(2).find((a) => a.startsWith("--tier="));
const tier = tierArg ? tierArg.slice("--tier=".length) : "all";
if (tier !== "fast" && tier !== "slow" && tier !== "all") {
  console.error(`unknown ${tierArg}: expected --tier=fast, --tier=slow or --tier=all`);
  process.exit(2);
}
const passThrough = process.argv.slice(2).filter((a) => a !== tierArg);

takeSuiteLock(import.meta.filename, process.argv.slice(2));

const tiers = discoverTests();
console.log(tierArithmetic(tiers));
// Every tier names its files explicitly. Node's own discovery also matches any .mjs/.js/.ts under a test/ directory, so it ran the
// stdio connector fixtures as tests and hung on stdin. The only other things it matched were helpers and the bootstrap preload,
// none of which hold a test. `all` is the whole `*.test.ts` set the tier arithmetic already checks.
const selected = selectTestArgs(passThrough, tiers[tier]);
console.log(`tier ${tier}: ${tiers[tier].length} test files`);

// The PDF helper is compiled once per run (or not at all on a warm cache) and handed to the tests, instead of each platform test
// file compiling its own. A COCHECK_PDF_HELPER already set by the caller is kept.
if (!process.env.COCHECK_PDF_HELPER) {
  const helper = ensurePdfHelper();
  if (helper) process.env.COCHECK_PDF_HELPER = helper;
}

// A recorded shell's attribution hooks never load into the runner or a test process; the hooks' own tests set them explicitly.
scrubRecorderEnv(process.env);

// Each file runs in its own `node --test` process with a wall-clock limit (scripts/lib/file-runner.ts): past it, the file's whole process tree is
// ended and the file fails with a stated reason, so one hanging file can never hold the run until a CI job cap cancels every file after it.
// Windows CI is slower and that cap is near: 150 s there (the slowest fast file, office-connector, is ~42 s on a Mac and ~2.75x that on the runner); elsewhere 600 s, far past any fast file. COCHECK_TEST_FILE_TIMEOUT_MS overrides both.
// One temp folder for the run: every test file's process gets it as TMPDIR (TEMP and TMP for Windows), so whatever a file leaves in its temp
// folder (no cleanup, or a file ended at its time limit before its after hooks ran) is removed with this folder when the run ends, on a signal
// too (the suite lock turns SIGINT/SIGTERM/SIGHUP into an exit). Made after the PDF helper (its warm cache stays in the real temp folder) and
// before the bootstrap, so its homes and stand-ins are made inside it as well (tests check the stand-ins live in their temp folder). The runner
// itself takes it as its temp folder too, so the leaked review process sweep below looks there. A short name: macOS caps a socket path at
// 104 bytes, and Chrome puts one under TMPDIR.
const runTemp = mkdtempSync(path.join(tmpdir(), "ccr-"));
let runTempGone = false;
const removeRunTemp = (): void => {
  if (runTempGone) return;
  runTempGone = true;
  try {
    rmSync(runTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    // Windows: a process a test left running can still hold a file there; say so rather than crash the exit.
    console.error(`run-tests: could not remove the run's temp folder ${runTemp}: ${(error as Error).message}`);
  }
};
process.on("exit", removeRunTemp);
Object.assign(process.env, { TMPDIR: runTemp, TEMP: runTemp, TMP: runTemp });
// The run's temp homes (COCHECK_HOME, CLAUDE_CONFIG_DIR, the Office and Keychain stand-ins) are made once here, as the single `node --test`
// process made them before, and every file's process inherits them.
await import("./test-bootstrap.ts");
const timeoutMs = Number(process.env.COCHECK_TEST_FILE_TIMEOUT_MS) > 0 ? Number(process.env.COCHECK_TEST_FILE_TIMEOUT_MS) : process.platform === "win32" ? 150_000 : 600_000;
const concurrency = Number(process.env.COCHECK_TEST_CONCURRENCY) > 0 ? Number(process.env.COCHECK_TEST_CONCURRENCY) : 2;
const isFile = (a: string): boolean => !a.startsWith("-") && /\.(?:[cm]?[jt]s)$/.test(a);
const files = selected.filter(isFile);
const testArgs = selected.filter((a) => !isFile(a));
const env = process.stdout.isTTY && process.env.NO_COLOR === undefined ? { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" } : process.env;
// The tree's state before any file runs: a full green run on a clean tree leaves a pass record for HEAD (scripts/lib/test-pass-record.ts), which scripts/release.sh reads.
const startState = captureGitState(path.resolve(import.meta.dirname, ".."));
const t0 = performance.now();
const totals = await runFiles(files, { nodeArgs: ["--import", "./scripts/test-bootstrap.ts"], testArgs, concurrency, timeoutMs, env });
const slowest = [...totals.results].sort((a, b) => b.ms - a.ms).slice(0, 10);
console.log(`\nslowest files: ${slowest.map((r) => `${r.file} ${(r.ms / 1000).toFixed(1)} s`).join(", ")}`);
if (totals.timedOutFiles.length > 0) console.log(`timed out (${timeoutMs / 1000} s, process tree ended): ${totals.timedOutFiles.join(", ")}`);
if (totals.failedFiles.length > 0) console.log(`failing files (${totals.failedFiles.length}): ${totals.failedFiles.join(", ")}`);
for (const k of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]) console.log(`ℹ ${k} ${totals.counts[k] ?? 0}`);
console.log(`ℹ files ${files.length}`);
console.log(`ℹ files_timed_out ${totals.timedOutFiles.length}`);
console.log(`ℹ duration_ms ${(performance.now() - t0).toFixed(3)}`);
let leftInRunTemp = 0;
try {
  leftInRunTemp = readdirSync(runTemp).length;
} catch {
  // gone already
}
console.log(`ℹ run_temp_left ${leftInRunTemp} (removed with ${runTemp})`);
const status = totals.failedFiles.length > 0 ? 1 : 0;
const record = writePassRecord({
  root: path.resolve(import.meta.dirname, ".."),
  start: startState,
  tierArg,
  passThrough,
  counts: totals.counts,
  failedFiles: totals.failedFiles,
  timedOutFiles: totals.timedOutFiles,
  fileCount: files.length,
  expectedFileCount: tiers.all.length,
});
console.log("path" in record ? `ℹ pass_record ${record.path}` : `ℹ pass_record none (${record.reason})`);

const leaked = tempReviewProcesses();
if (leaked.length > 0) {
  const ours = (home: string) => /^cocheck-(?!fidelity-)/.test(path.basename(home));
  for (const p of leaked) {
    console.error(`${ours(p.home) ? "test leaked" : "not stopped (not a test home)"} a review process: pid=${p.pid} COCHECK_HOME=${p.home}`);
  }
  killTempReviewProcesses(leaked.filter((p) => ours(p.home)));
}
// After the sweep: a leaked review process may work in a home inside the run's temp folder.
removeRunTemp();
process.exit(status);
