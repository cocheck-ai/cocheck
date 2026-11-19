import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { readRows } from "../src/timeline/load.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, stop, state } from "./fixtures/timeline.ts";
import { trackedClaims } from "./helpers/claims.ts";

// Within one call, changes are ordered by the file's modification time captured at the sweep (name only as a tiebreak); the
// rail shows a call's consecutive changes under one header.

const W = "/w/";
const T0 = Date.parse("2026-10-11T10:00:00Z");
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const input = (ops: RawOp[], fileStates: RawState[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[]) => buildRailModel(buildTimeline(input(ops, fileStates)));
const files = (m: ReturnType<typeof model>): string[] => m.stops.filter((s) => s.change).map((s) => s.change!.file);
const NS = 1_000_000n;
const written = (file: string, sha: string, callId: string, mtimeMs: number | null): RawState => ({
  ...state(W + file, sha, null, { open: [callId], credited: [callId], step: 2 }),
  ts: iso(40),
  ...(mtimeMs === null ? {} : { mtime_ns: String(BigInt(mtimeMs) * NS) }),
});
const ops = (): RawOp[] => [prompt("s1", ["Ask."], { requests: [{ seq: 1, at: T0 + 1, firstStep: null }] }), call("run", { tool: "Bash", desc: "run script", cmd: "python run.py", at: T0 + 10 }), stop("s1", "done")];

describe("order within one call", () => {
  it("a.csv, then z.xlsx, then b.csv written in that order read in that order, not by name", () => {
    const states = [written("a.csv", "a", "run", 1000), written("b.csv", "b", "run", 3000), written("z.xlsx", "z", "run", 2000)];
    assert.deepEqual(files(model(ops(), states)), ["a.csv", "z.xlsx", "b.csv"]);
  });
  it("the same modification time falls back to the name", () => {
    const states = [written("b.csv", "b", "run", 1000), written("a.csv", "a", "run", 1000)];
    assert.deepEqual(files(model(ops(), states)), ["a.csv", "b.csv"]);
  });
  it("records without a modification time keep today's order", () => {
    const states = [written("b.csv", "b", "run", null), written("a.csv", "a", "run", null)];
    assert.deepEqual(files(model(ops(), states)), ["b.csv", "a.csv"]);
  });
});

describe("one header per call on the rail", () => {
  it("consecutive changes from one call carry the same call, naming it; a lone change carries its own call", () => {
    const m = model(ops(), [written("a.csv", "a", "run", 1000), written("b.csv", "b", "run", 2000)]);
    const stops = m.stops.filter((s) => s.change);
    assert.equal(stops.length, 2);
    assert.ok(stops[0]!.call && stops[0]!.call.id === stops[1]!.call?.id);
    assert.match(stops[0]!.call!.text, /run/);
    const lone = model(ops(), [written("a.csv", "a", "run", 1000)]);
    assert.match(lone.stops.find((s) => s.change)!.call!.text, /run/);
  });
  it("changes from two different calls do not share a header", () => {
    const two = [...ops().slice(0, 2), call("run2", { tool: "Bash", desc: "second", cmd: "python two.py", at: T0 + 20 }), stop("s1", "done")];
    const m = model(two, [written("a.csv", "a", "run", 1000), { ...written("b.csv", "b", "run2", 2000), ts: iso(60), step_id: 3 }]);
    const ids = m.stops.filter((s) => s.change).map((s) => s.call?.id);
    assert.equal(ids.length, 2);
    assert.ok(ids.every((id) => id !== undefined) && ids[0] !== ids[1]);
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("the sweep captures the modification time", () => {
  it("one call writes a.csv, z.txt, b.csv with rising mtimes; the ledger holds each mtime and the rail reads write order", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
    cleanups.push(async () => {
      for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
    });
    await writeFile(path.join(folder, "seed.txt"), "seed\n");
    let clock = 1_000_000;
    const opts = { perSession: false, host: "claude" as const, home, claimed: trackedClaims, folder, now: () => clock };
    const send = async (over: Record<string, unknown>) => {
      clock += 1000;
      return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
    };
    const tool_input = { command: "python3 run.py", description: "run" };
    await send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "k1", tool_input });
    const base = Date.now() / 1000;
    for (const [i, name] of ["a.csv", "z.txt", "b.csv"].entries()) {
      const file = path.join(folder, name);
      await writeFile(file, `${name}\n`);
      await utimes(file, base + i, base + i);
    }
    await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "k1", tool_input });
    const ledger = openLedger(home);
    try {
      const rows = ledger.fileStatesForTask(1).filter((r) => path.basename(r.filePath) !== "seed.txt");
      assert.equal(rows.length, 3);
      for (const r of rows) assert.equal(r.mtimeNs, String((await stat(r.filePath, { bigint: true })).mtimeNs));
      const { ops: rawOps, fileStates } = readRows(ledger, 1);
      const m = buildRailModel(buildTimeline({ ...input(rawOps, fileStates), folder }));
      assert.deepEqual(files(m).map((f) => path.basename(f)), ["a.csv", "z.txt", "b.csv"]);
    } finally {
      ledger.close();
    }
  });
});
