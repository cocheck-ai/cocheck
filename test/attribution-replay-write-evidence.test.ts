import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evidenceDir } from "../src/attribution/tag.ts";
import { writeEvidenceFromOps } from "../src/attribution/evidence.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { readRows } from "../src/timeline/load.ts";
import { buildTimeline, type Change, type TimelineInput } from "../src/timeline/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";
import { workbookClaims } from "./helpers/claims.ts";

// On the replay harness's seam: the per-call tag's write evidence reaches `creditWithEvidence` live (the adapter's `#writeEvidence`) and in the
// timeline (`TimelineInput.writeEvidence`, from the ops' `provenWrites`). The strict rule holds on both: two tagged Python helpers that
// overlap each get their own writes; a tagged and an untagged call overlapping stay joint.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-t135r-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);

function changesOf(input: TimelineInput, ids: number[]): Change[] {
  const t = buildTimeline(input);
  const out = new Map<string, Change>();
  for (const r of t.requests) for (const run of r.runs) for (const c of run.calls) for (const ch of c.changes ?? []) out.set(ch.id, ch);
  for (const ch of t.unplaced) out.set(ch.id, ch);
  return ids.map((id) => out.get(`c${id}`)!);
}
const who = (ch: Change) => ({ kind: ch.by.kind, calls: [...ch.by.calls].sort() });

// ---- live: the adapter, its ledger, and the timeline rebuilt from that ledger ----
async function live() {
  const home = await tmp("home");
  const folder = await tmp("folder");
  const a = path.join(folder, "a.xlsx");
  const b = path.join(folder, "b.xlsx");
  await copyFile(probe(0), a);
  await copyFile(probe(0), b);
  let clock = Date.parse("2026-10-23T12:00:00Z");
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>, taggedCall = false) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, { ...opts, taggedCall });
  };
  const ag = (n: string) => ({ agent_id: `helper${n}`, agent_type: "general-purpose" });
  const pre = (id: string, n: string, tagged: boolean, command = "python3 run.py") => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, ...ag(n) }, tagged);
  const post = (id: string, n: string, command = "python3 run.py") => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, ...ag(n) });
  /** What the call's Python child's write hook appends (today's UTC date names the log, as the hooks name it). */
  const wrote = async (call: string, file: string, op = "write") => {
    await mkdir(evidenceDir(home), { recursive: true });
    await appendFile(path.join(evidenceDir(home), `writes-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ v: 1, call, agent: "x", pid: 1, ts: clock, op, path: file, via: "python" }) + "\n");
  };
  const ledgerCredits = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null).map((s) => `${path.basename(s.filePath)}:${[...s.credited].sort().join("+")}`);
    } finally {
      l.close();
    }
  };
  const timeline = () => {
    const l = openLedger(home);
    try {
      const { ops, fileStates } = readRows(l, 1);
      const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates, folder, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude", writeEvidence: writeEvidenceFromOps(ops) };
      const changed = fileStates.filter((s) => s.prev_sha256 !== null);
      return changesOf(input, changed.map((s) => s.id)).map((ch, i) => `${path.basename(changed[i]!.file_path)}:${who(ch).calls.join("+")}`);
    } finally {
      l.close();
    }
  };
  await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  return { pre, post, wrote, ledgerCredits, timeline, a, b, write: (file: string, n: number) => copyFile(probe(n), file), home };
}

describe("replay harness: the tag's write evidence through the replay harness's seam", () => {
  it("live: two tagged Python helpers overlapping: each write goes to its writer, in the ledger and in the timeline rebuilt from it", async () => {
    const t = await live();
    await t.pre("A", "1", true);
    await t.pre("B", "2", true);
    await t.wrote("A", "/usr/bin/python3", "start"); // each child's start record (the hook loaded and found the tag)
    await t.wrote("B", "/usr/bin/python3", "start");
    await t.write(t.a, 1);
    await t.wrote("A", t.a);
    await t.pre("A2", "1", true, "python3 -c pass"); // a sweep while both are open finds A's write
    await t.wrote("A2", "/usr/bin/python3", "start");
    await t.write(t.b, 2);
    await t.wrote("B", t.b);
    await t.post("B", "2");
    await t.post("A2", "1", "python3 -c pass");
    await t.post("A", "1");
    assert.deepEqual(t.ledgerCredits(), ["a.xlsx:A", "b.xlsx:B"]);
    assert.deepEqual(t.timeline(), ["a.xlsx:A", "b.xlsx:B"]);
    // the ops carry the proofs with ledger step ids: the timeline's side of the seam
    const l = openLedger(t.home);
    try {
      const proven = readRows(l, 1).ops.map((o) => JSON.parse(o.args_json ?? "{}")).filter((a) => Array.isArray(a.provenWrites)).map((a) => `${a.tool_use_id}:${a.provenWrites.map((w: { path: string }) => path.basename(w.path)).join(",")}`);
      assert.deepEqual(proven.sort(), ["A:a.xlsx", "B:b.xlsx"]);
    } finally {
      l.close();
    }
  });

  it("live: a tagged helper beside an untagged one stays joint, whatever the evidence says", async () => {
    const t = await live();
    await t.pre("A", "1", true);
    await t.pre("U", "2", false);
    await t.write(t.a, 1);
    await t.wrote("A", t.a);
    await t.post("U", "2");
    await t.post("A", "1");
    assert.deepEqual(t.ledgerCredits(), ["a.xlsx:A+U"]);
    assert.deepEqual(t.timeline(), ["a.xlsx:A+U"]);
  });

  // ---- timeline: a ledger whose states were credited jointly, with the ops' provenWrites ----
  const W = "/w";
  const T0 = 1_800_000_000_000;
  const state = (id: number, file: string, credited: string[]): RawState => ({ id, step_id: id + 1, task_id: 1, file_path: `${W}/${file}`, sha256: `h${id}`, prev_sha256: `p${id}`, phase: "Post", calls_open_json: JSON.stringify(credited), credited_json: JSON.stringify(credited), size: 1, kept: "whole", note: "", ts: new Date(T0 + id * 1000).toISOString() });
  const helperOp = (id: string, agent: string, proven: Array<{ path: string; step: number }>, cmd = "python3 build.py"): RawOp =>
    call(id, { tool: "Bash", cmd, at: T0, end: T0 + 60_000, extra: { agent_id: agent, agent_type: "general-purpose", tagged: true, ...(proven.length > 0 ? { provenWrites: proven } : {}) } });
  const replay = (ops: RawOp[], states: RawState[]) => {
    const all = [prompt("s1", ["go"]), ...ops, stop("s1")];
    const input: TimelineInput = { taskId: 1, build: "t", ops: all, fileStates: [{ ...state(100, "seed", []), prev_sha256: null, step_id: 1 }, ...states], folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude", writeEvidence: writeEvidenceFromOps(all) };
    return changesOf(input, states.map((s) => s.id)).map(who);
  };

  it("timeline: two overlapping tagged helpers recorded jointly; the ops' proofs give each write to its writer, matched by step", () => {
    const s1 = state(1, "a.xlsx", ["w1", "w2"]);
    const s2 = state(2, "b.xlsx", ["w1", "w2"]);
    const s3 = state(3, "a.xlsx", ["w1", "w2"]); // a later change of a.xlsx with no proof at its step stays joint
    const got = replay([helperOp("w1", "A", [{ path: `${W}/a.xlsx`, step: s1.step_id! }]), helperOp("w2", "B", [{ path: `${W}/b.xlsx`, step: s2.step_id! }])], [s1, s2, s3]);
    assert.deepEqual(got, [{ kind: "call", calls: ["w1"] }, { kind: "call", calls: ["w2"] }, { kind: "joint", calls: ["w1", "w2"] }]);
  });

  it("timeline: a proof naming a call not among the change's calls proves nothing", () => {
    const s1 = state(1, "a.xlsx", ["w2", "w3"]);
    const got = replay([helperOp("w1", "A", [{ path: `${W}/a.xlsx`, step: s1.step_id! }]), helperOp("w2", "B", []), helperOp("w3", "C", [])], [s1]);
    assert.deepEqual(got, [{ kind: "joint", calls: ["w2", "w3"] }]);
  });
});
