#!/usr/bin/env node
// Lists the hook-adapter calls in a COCHECK_HOME and how each closed, so a run can be scored by hand.
// Usage: node scripts/hook-calls.ts <cocheck-home> [--all]
// One line per call: task, call id, closedBy, background or foreground, opened and closed times (UTC; - when unknown), joint count, intent.
// Each line ends with call runtime (wall, Pre to Post: the tool's own run, not overhead) and adapter overhead (processingMs) ("unknown" when a clock was missing or skewed, never 0);
// a final line gives the median adapter overhead and call runtime ms over the printed calls (unknown ones left out of the median, counted).
// Default: only calls closed by stop or expiry (a Post never arrived: ghost or background). --all lists every call.
import { existsSync } from "node:fs";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { hookCallOf } from "../src/tasks.ts";

const home = process.argv[2];
const all = process.argv.includes("--all");
if (!home) throw new Error("usage: hook-calls.ts <cocheck-home> [--all]");
if (!existsSync(path.join(home, "hooks"))) throw new Error(`${home} has no hooks/ directory: not a hook-adapter home`);

const ms = (v: unknown) => (typeof v === "number" ? v : undefined);
const medianOf = (xs: number[]) => {
  if (xs.length === 0) return "unknown";
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return String(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};
const processing: number[] = [];
const wall: number[] = [];
let unknownProcessing = 0;

const ledger = openLedger(home);
try {
  const seen = new Set<string>();
  for (const taskId of ledger.allTaskIds()) {
    for (const op of ledger.okOpsForTask(taskId, 0, ledger.maxOpId())) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(op.argsJson);
      } catch {
        continue;
      }
      const call = hookCallOf(args);
      if (!call) continue;
      const closedBy = call.closedBy ?? "unknown";
      if (!all && closedBy !== "stop" && closedBy !== "expiry") continue;
      const key = `${taskId}|${call.callId}|${closedBy}`;
      if (seen.has(key)) continue; // one line per call, not per workbook
      seen.add(key);
      const p = ms(args.processingMs);
      const w = ms(args.wallMs);
      if (p === undefined) unknownProcessing++;
      else processing.push(p);
      if (w !== undefined) wall.push(w);
      const time = (ms?: number) => (ms === undefined ? "-" : new Date(ms).toISOString());
      const joint = Array.isArray(args.jointWith) ? args.jointWith.length : 1;
      console.log([`task ${taskId}`, call.callId, closedBy, call.background ? "background" : "foreground", time(call.openedAt), time(call.closedAt), `joint with ${joint - 1} other`, `call runtime ${w ?? "unknown"} ms`, `adapter overhead ${p ?? "unknown"} ms`, op.intent.replace(/\s+/g, " ").slice(0, 100)].join("\t"));
    }
  }
  console.log(`median adapter overhead ${medianOf(processing)} ms, median call runtime ${medianOf(wall)} ms over ${processing.length} timed call(s); ${unknownProcessing} with unknown processing time`);
} finally {
  ledger.close();
}
