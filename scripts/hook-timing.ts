#!/usr/bin/env node
// Hook timing: runs the real hook CLI (one process per event, as a host would) around N edits of a COPY of a workbook
// and prints the median and max whole-hook-process time per tool call (node start to exit, Pre plus Post), not adapter overhead. Usage: node scripts/hook-timing.ts <workbook.xlsx> [calls] [decks] [transcript-mb]: every payload names a transcript of that size, read for narration; `decks` copies of test/fixtures/ppt-table-deck.pptx are added to the task folder (the hook watches every file).
// The original is never opened for writing; the copy and a throwaway COCHECK_HOME live in a temp dir.
// A fifth argument names a folder whose files are cloned into the task folder before the first event (a folder of 1 GB of
// workbooks); the output adds the first event (the Pre that copies the folder). The attribution hooks' variables are never passed to the hook processes.
import { spawnSync } from "node:child_process";
import { appendFileSync, constants, copyFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { setTracking } from "../src/tracking.ts";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const source = process.argv[2];
const calls = Number(process.argv[3] ?? 20);
const decks = Number(process.argv[4] ?? 0);
const transcriptMb = Number(process.argv[5] ?? 0);
const bulkDir = process.argv[6];
if (!source) throw new Error("usage: hook-timing.ts <workbook.xlsx> [calls] [decks] [transcript-mb]");

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "cocheck-hook-timing-")));
const home = path.join(tmp, "home");
const folder = path.join(tmp, "task");
const book = path.join(folder, path.basename(source));
try {
  spawnSync("mkdir", ["-p", home, folder]);
  copyFileSync(source, book);
  // A session records nothing until tracking is started for it, as `cocheck track start` would.
  setTracking(home, "claude", "timing", true, folder);
  if (bulkDir) for (const f of readdirSync(bulkDir)) copyFileSync(path.join(bulkDir, f), path.join(folder, f), constants.COPYFILE_FICLONE);
  for (let i = 0; i < decks; i++) copyFileSync(path.join(import.meta.dirname, "..", "test", "fixtures", "ppt-table-deck.pptx"), path.join(folder, `deck-${i}.pptx`));
  // With `transcript-mb`, every payload names a Claude Code style transcript of that size (tool-result lines), and each call appends
  // its narration (an assistant text line, then the tool_use line) before its Pre, so the offset is what keeps the read bounded.
  const transcript = path.join(tmp, "transcript.jsonl");
  if (transcriptMb > 0) {
    const filler = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "x".repeat(2000) }] } }) + "\n";
    writeFileSync(transcript, filler.repeat(Math.ceil((transcriptMb * 1024 * 1024) / filler.length)));
  }
  const narrate = (id: string): void => {
    if (transcriptMb <= 0) return;
    const line = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { id: `m-${id}`, role: "assistant", content } }) + "\n";
    appendFileSync(transcript, line([{ type: "text", text: `Running ${id}.` }]) + line([{ type: "tool_use", id, name: "Bash", input: {} }]));
  };
  const hook = (event: string, id: string): number => {
    const payload = { session_id: "timing", cwd: folder, hook_event_name: event, tool_name: "Bash", tool_input: { command: "python3 edit.py", description: "timing" }, tool_use_id: id, ...(transcriptMb > 0 ? { transcript_path: transcript } : {}) };
    const start = process.hrtime.bigint();
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "src", "hook.ts"), "--host", "claude", "--folder", folder], {
      input: JSON.stringify(payload),
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COCHECK_|NODE_OPTIONS$|PYTHONPATH$)/.test(k))), COCHECK_HOME: home },
      encoding: "utf8",
    });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (run.status !== 0) throw new Error(`hook ${event} failed: ${run.stderr}`);
    return ms;
  };
  /** Changes the first plain numeric constant (no formula, no shared string; an explicit t="n" counts, as openpyxl writes it) of the first sheet in the copy. */
  const edit = (n: number): void => {
    const zip = unzipSync(new Uint8Array(readFileSync(book)));
    for (const name of Object.keys(zip).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()) {
      const before = strFromU8(zip[name]!);
      const after = before.replace(/(<c (?![^>]* t="(?!n")[^"]*")[^>]*>)<v>[-\d.]+<\/v>/, (_m, head) => `${head}<v>${1000 + n}</v>`);
      if (after === before) continue;
      zip[name] = strToU8(after);
      writeFileSync(book, zipSync(zip, { mtime: new Date(2020, 0, 1) }));
      return;
    }
    throw new Error("the timing edit changed nothing; pick a workbook with a plain numeric constant");
  };
  const perCall: number[] = [];
  const pres: number[] = [];
  const posts: number[] = [];
  narrate("warm");
  const firstPre = hook("PreToolUse", "warm"); // first Pre opens the task and takes baselines; reported apart
  const first = hook("PostToolUse", "warm");
  for (let i = 0; i < calls; i++) {
    const id = `toolu_${i}`;
    narrate(id);
    const pre = hook("PreToolUse", id);
    edit(i);
    const post = hook("PostToolUse", id);
    pres.push(pre);
    posts.push(post);
    perCall.push(pre + post);
  }
  const stop = hook("Stop", "stop");
  const ledger = openLedger(home);
  // No op carries cell-level credit (hookCells): each edited call must instead leave a file state of the workbook credited to it.
  const withCells = ledger.fileStatesForTask(1).filter((s) => s.filePath === book && s.prevSha256 !== null && s.credited.length > 0).length;
  const narrated = ledger.okOpsForTask(1, 0, ledger.maxOpId()).filter((o) => o.argsJson.includes('"source":"agent"')).length;
  ledger.close();
  if (transcriptMb > 0 && narrated < calls) throw new Error(`only ${narrated} of ${calls} calls carried narration: the transcript variant did not exercise the read`);
  if (withCells < calls) throw new Error(`only ${withCells} of ${calls} edits left a credited state of the workbook: the timing run did not exercise the capture path on every call`);
  const med = (xs: number[]): number => {
    const v = [...xs].sort((a, b) => a - b);
    return v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
  };
  const sorted = [...perCall].sort((a, b) => a - b);
  const median = med(perCall);
  console.log(JSON.stringify({ workbook: path.basename(source), bytes: readFileSync(source).length, calls, decks, transcriptMb, narratedOps: narrated, creditedStates: withCells, medianMsPerCall: Math.round(median), medianPreMs: Math.round(med(pres)), medianPostMs: Math.round(med(posts)), maxMsPerCall: Math.round(sorted.at(-1)!), firstPreMs: Math.round(firstPre), firstPostMs: Math.round(first), stopMs: Math.round(stop), bulkDir: bulkDir ?? null }));
} finally {
  if (!process.env.KEEP) rmSync(tmp, { recursive: true, force: true }); else console.error(tmp);
}
