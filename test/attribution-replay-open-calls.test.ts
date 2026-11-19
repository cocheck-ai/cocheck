import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvidenceCollector } from "../src/agent-transcripts.ts";
import { classifyToolResult, evidenceMayCredit, isReadOnlyMcpTool, runsOnAfterResult, toolNeverWrites, type CallEvidence } from "../src/credit-guard.ts";
import { evidenceSince } from "../src/agent-transcripts.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { buildTimeline, type Change, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";
import { readFixture, replayInput, score } from "./helpers/attribution-replay.ts";
import { workbookClaims, trackedClaims } from "./helpers/claims.ts";

// A call blocked by another PreToolUse hook never gets a Post, so it stayed open about 500 s and was credited with every
// write in that window; WebFetch, WebSearch and Agent calls were credited too; a helper's Bash in its own scratch folder was credited with files
// in the folder. Credit now needs evidence: transcript evidence closes calls that are done or never ran, tools that cannot write are never
// credited, and a Bash command that provably writes only outside the folder is not credited for a file inside it.

describe("replay harness: recorded runs scored against golden owners from transcripts", () => {
  it("recorded run A: every change of the run has its exact owner; nothing wrong, nothing outside", () => {
    const f = readFixture("recorded-run-a");
    const s = score(f, buildTimeline);
    assert.equal(s.wrongSingle, 0, s.misses.join("\n"));
    assert.equal(s.wronglyOutside, 0, s.misses.join("\n"));
    assert.equal(s.joint, 0, s.misses.join("\n"));
    // The run's 143 changes (states up to 361) are all exact. Later states are outside files in other repos that the orchestrator's own
    // helpers changed, recorded at a Pre with no call credited; they read "during agent calls" (no maker claimed).
    const drive = Object.keys(f.golden).filter((id) => Number(id) <= 361);
    assert.equal(drive.length, 143);
    const misses = s.misses.filter((m) => Number(m.split(" ")[0]) <= 361);
    assert.deepEqual(misses, []);
    assert.equal(s.exact + s.during, s.changes, s.misses.join("\n"));
  });

  it("recorded run A needs the transcripts: without them the blocked nested Agent launches (no Post, open to Stop) stay suspects", () => {
    const f = readFixture("recorded-run-a");
    const s = score(f, buildTimeline, replayInput(f, false));
    assert.ok(s.joint >= 50, `joint ${s.joint}`);
    assert.equal(s.wrongSingle + s.wronglyOutside, 0, s.misses.join("\n"));
  });

  it("recorded run B: no regression (116 of 117 exact, the last one during agent calls); nothing wrong, nothing outside", () => {
    const f = readFixture("recorded-run-b");
    const s = score(f, buildTimeline);
    assert.equal(s.wrongSingle, 0, s.misses.join("\n"));
    assert.equal(s.wronglyOutside, 0, s.misses.join("\n"));
    assert.equal(s.exact, 116, s.misses.join("\n"));
    assert.equal(s.changes, 117);
  });

  it("fixtures hold no file contents, no email address and no real home folder", () => {
    for (const name of ["recorded-run-b", "recorded-run-a", "recorded-run-c"]) {
      const f = readFixture(name);
      const text = JSON.stringify(f);
      for (const st of f.fileStates) assert.match(st.sha256, /^s\d+$/);
      for (const op of f.ops) assert.doesNotMatch(op.intent ?? "", /cat > [^ ]+\.(md|txt|csv|json)\s+<<'?(\w+)'?\n[^\n]+/);
      assert.doesNotMatch(text.replaceAll("user@example.com", ""), /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      assert.doesNotMatch(text, /\/Users\/(?!user\b)\w+/);
    }
  });
});

// ---- synthetic replays: the timeline's pass over recorded calls and sweeps ----

const W = "/w";
const T0 = 1_800_000_000_000;
const iso = (t: number) => new Date(T0 + t).toISOString();
let sid = 0;
/** A change state found at tick `at` (ms after T0), with the calls open and credited as the record holds them. */
const found = (file: string, at: number, credited: string[], phase: "Pre" | "Post" | "Stop" = "Pre"): RawState => {
  const id = ++sid;
  return { id, step_id: id + 1, task_id: 1, file_path: `${W}/${file}`, sha256: `h${id}`, prev_sha256: `p${id}`, phase, calls_open_json: JSON.stringify(credited), credited_json: JSON.stringify(credited), size: 1, kept: "whole", note: "", ts: iso(at) };
};
const helper = (id: string, agent: string, o: { tool?: string; cmd?: string; at: number; end: number; by?: string; background?: boolean; file?: string }): RawOp =>
  call(id, { tool: o.tool ?? "Bash", cmd: o.cmd ?? "python3 build.py", at: T0 + o.at, end: T0 + o.end, by: o.by ?? "post", background: o.background ?? false, extra: { agent_id: agent, agent_type: "general-purpose", ...(o.file ? { toolLabel: { fields: { file_path: o.file } } } : {}) } });

function replay(ops: RawOp[], states: RawState[], evidence: Record<string, CallEvidence> = {}): Change[] {
  const input: TimelineInput = {
    taskId: 1, build: "t", ops: [prompt("s1", ["go"]), ...ops, stop("s1")], fileStates: [{ ...found("seed", 0, []), prev_sha256: null, step_id: 1 }, ...states], folder: W,
    valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude", evidence: new Map(Object.entries(evidence)),
  };
  const t: Timeline = buildTimeline(input);
  const out = new Map<string, Change>();
  for (const r of t.requests) for (const run of r.runs) for (const c of run.calls) for (const ch of c.changes ?? []) out.set(ch.id, ch);
  for (const ch of t.unplaced) out.set(ch.id, ch);
  return states.map((s) => out.get(`c${s.id}`)!);
}
const who = (ch: Change) => ({ kind: ch.by.kind, calls: ch.by.calls });

describe("synthetic replays", () => {
  it("blocked at Pre: a Bash call another hook blocked (no Post, open to Stop) is credited with nothing", () => {
    const ops = [helper("blk", "A", { at: 0, end: 500_000, by: "stop" }), helper("wr", "B", { at: 1000, end: 9000 })];
    const [ch] = replay(ops, [found("model.xlsx", 5000, ["blk", "wr"])], { blk: { at: T0 + 150, kind: "blocked" } });
    assert.deepEqual(who(ch!), { kind: "call", calls: ["wr"] });
  });

  it("denied: a Write the permission prompt refused is credited with nothing, even for its own file", () => {
    const ops = [helper("den", "A", { tool: "Write", at: 0, end: 500_000, by: "stop", file: `${W}/model.xlsx` }), helper("wr", "B", { at: 1000, end: 9000 })];
    const [ch] = replay(ops, [found("model.xlsx", 5000, ["den", "wr"])], { den: { at: T0 + 2000, kind: "denied" } });
    assert.deepEqual(who(ch!), { kind: "call", calls: ["wr"] });
  });

  it("interrupted: a call stopped part way is credited up to the first sweep after its result (it may have written), not after", () => {
    const ops = [helper("int", "A", { at: 0, end: 500_000, by: "stop" }), helper("wr", "B", { at: 1000, end: 90_000 }), helper("other", "B", { tool: "Read", at: 20_000, end: 20_100 })];
    const states = [found("a.xlsx", 10_500, ["int", "wr"]), found("b.xlsx", 30_000, ["int", "wr"])];
    const [first, later] = replay(ops, states, { int: { at: T0 + 10_000, kind: "interrupted" } });
    assert.equal(first!.by.kind, "joint", "the sweep right after the interrupt may hold its partial write: both stay suspects");
    assert.deepEqual(who(later!), { kind: "call", calls: ["wr"] });
  });

  it("a later turn of the same agent closes its call, as a tool_result does", () => {
    // the next turn starts with a call (its Pre is a sweep); the change found at the sweep after that is not the closed call's
    const ops = [helper("done", "A", { at: 0, end: 500_000, by: "expiry" }), helper("wr", "B", { at: 1000, end: 90_000 }), helper("next", "A", { tool: "Read", at: 30_100, end: 30_200 })];
    const states = [found("a.xlsx", 2_000, ["done", "wr"]), found("b.xlsx", 40_000, ["done", "wr"])];
    const [first, later] = replay(ops, states, { done: { at: T0 + 30_000, kind: "turn" } });
    assert.equal(first!.by.kind, "joint");
    assert.deepEqual(who(later!), { kind: "call", calls: ["wr"] });
  });

  it("background Bash: its result comes back at once but its process keeps writing, so it stays a suspect", () => {
    const ops = [helper("bg", "A", { at: 0, end: 500_000, by: "stop", background: true }), helper("wr", "B", { at: 1000, end: 90_000 })];
    const [ch] = replay(ops, [found("a.xlsx", 60_000, ["bg", "wr"])], { bg: { at: T0 + 100, kind: "result" } });
    assert.equal(ch!.by.kind, "joint");
  });

  it("a long WebFetch (and WebSearch, ToolSearch, Skill, TodoWrite) is never credited", () => {
    const ops = [helper("wf", "A", { tool: "WebFetch", at: 0, end: 60_000 }), helper("ws", "A", { tool: "WebSearch", at: 0, end: 60_000 }), helper("wr", "B", { at: 1000, end: 90_000 })];
    const [ch] = replay(ops, [found("a.xlsx", 30_000, ["wf", "ws", "wr"])]);
    assert.deepEqual(who(ch!), { kind: "call", calls: ["wr"] });
  });

  it("a blocked nested Agent launch (no Post, open to Stop, no helper of its own) is closed by its transcript result, and only by it", () => {
    const ops = [helper("nest", "A", { tool: "Agent", cmd: "", at: 0, end: 500_000, by: "stop" }), helper("wr", "B", { at: 1000, end: 90_000 })];
    const [closed] = replay(ops, [found("a.xlsx", 30_000, ["nest", "wr"])], { nest: { at: T0 + 160, kind: "blocked" } });
    assert.deepEqual(who(closed!), { kind: "call", calls: ["wr"] });
    const [open] = replay(ops, [found("a.xlsx", 30_000, ["nest", "wr"])]);
    assert.equal(open!.by.kind, "joint");
  });

  it("a detached Bash (nohup ... &) is never closed on its result: its child may still be writing, so the change stays joint", () => {
    const ops = [helper("nh", "A", { cmd: "cd /w && nohup python3 long.py > /tmp/log 2>&1 &", at: 0, end: 600_000, by: "expiry" }), helper("wr", "B", { at: 1000, end: 90_000 })];
    const [ch] = replay(ops, [found("out.xlsx", 30_000, ["nh", "wr"])], { nh: { at: T0 + 300, kind: "result" } });
    assert.equal(ch!.by.kind, "joint");
  });

  it("an Agent launch whose helper left no call on record stays a suspect beside a background Bash", () => {
    const ops = [helper("ag", "main", { tool: "Agent", cmd: "", at: 0, end: 60_000 }), helper("bg", "main", { cmd: "npm run dev", at: 0, end: 600_000, by: "stop", background: true })];
    const [ch] = replay(ops, [found("report.xlsx", 30_000, ["ag", "bg"])]);
    assert.equal(ch!.by.kind, "call", "both are the main lane");
    assert.deepEqual([...ch!.by.calls].sort(), ["ag", "bg"]);
  });

  it("an Agent launch is no suspect while a call of its own helper is open at the sweep: that call carries the work", () => {
    const ops = [helper("ag", "X", { tool: "Agent", cmd: "", at: 0, end: 60_000 }), call("hc", { tool: "Bash", at: T0 + 500, end: T0 + 40_000, extra: { agent_id: "H", agent_type: "general-purpose", launch_tool_use_id: "ag" } })];
    const [ch] = replay(ops, [found("a.xlsx", 30_000, ["ag", "hc"])]);
    assert.deepEqual(who(ch!), { kind: "call", calls: ["hc"] });
  });

  it("two launches open, only one helper ever made calls, none of them open: the change stays joint between the launches", () => {
    const ops = [helper("agA", "X", { tool: "Agent", cmd: "", at: 0, end: 60_000 }), helper("agB", "Y", { tool: "Agent", cmd: "", at: 0, end: 60_000 }), call("hA", { tool: "Bash", at: T0 + 500, end: T0 + 900, extra: { agent_id: "A", agent_type: "general-purpose", launch_tool_use_id: "agA" } })];
    const [ch] = replay(ops, [found("a.xlsx", 30_000, ["agA", "agB"])]);
    assert.equal(ch!.by.kind, "joint");
    assert.deepEqual([...ch!.by.calls].sort(), ["agA", "agB"]);
  });

  it("a launch beside main's background Bash, its helper writing between its own calls: both stay suspects", () => {
    const ops = [helper("ag", "X", { tool: "Agent", cmd: "", at: 0, end: 60_000 }), helper("bg", "Y", { cmd: "npm run dev", at: 0, end: 600_000, by: "stop", background: true }), call("hc", { tool: "Bash", at: T0 + 500, end: T0 + 900, extra: { agent_id: "H", agent_type: "general-purpose", launch_tool_use_id: "ag" } })];
    const [ch] = replay(ops, [found("a.xlsx", 30_000, ["ag", "bg"])]);
    assert.equal(ch!.by.kind, "joint");
    assert.deepEqual([...ch!.by.calls].sort(), ["ag", "bg"]);
  });

  it("two genuinely overlapping Bash writers stay joint", () => {
    const ops = [helper("w1", "A", { at: 0, end: 60_000 }), helper("w2", "B", { cmd: "python3 other.py", at: 1000, end: 90_000 })];
    const [ch] = replay(ops, [found("a.xlsx", 30_000, ["w1", "w2"], "Post")], { w1: { at: T0 + 60_000, kind: "result" }, w2: { at: T0 + 90_000, kind: "result" } });
    assert.equal(ch!.by.kind, "joint");
    assert.deepEqual([...ch!.by.calls].sort(), ["w1", "w2"]);
  });

  it("must not: a change whose only open call never ran reads during agent calls, never outside", () => {
    const ops = [helper("blk", "A", { at: 0, end: 500_000, by: "stop" })];
    const [ch] = replay(ops, [found("a.xlsx", 5000, ["blk"])], { blk: { at: T0 + 150, kind: "blocked" } });
    assert.equal(ch!.by.kind, "during");
  });

  it("a call closed by its own Post keeps its window whatever the transcript's time says", () => {
    const ops = [helper("own", "A", { at: 0, end: 30_000 })];
    const [ch] = replay(ops, [found("a.xlsx", 30_000, ["own"], "Post")], { own: { at: T0 + 20_000, kind: "result" } });
    assert.deepEqual(who(ch!), { kind: "call", calls: ["own"] });
  });
});

// ---- the rules on their own ----

describe("rules", () => {
  it("classifies tool results: blocked, denied, interrupted, result", () => {
    assert.equal(classifyToolResult("PreToolUse:Agent hook error: BLOCKED: subagent nesting ceiling", true), "blocked");
    assert.equal(classifyToolResult("Error: PreToolUse:Bash hook error: [/usr/bin/python3 x.py]: no", true), "blocked");
    assert.equal(classifyToolResult("<tool_use_error>Blocked: sleep 5 followed by: cat</tool_use_error>", true), "blocked");
    assert.equal(classifyToolResult("The user doesn't want to proceed with this tool use. The tool use was rejected", true), "denied");
    assert.equal(classifyToolResult("Permission to use Bash with command rm -rf x has been denied.", true), "denied");
    assert.equal(classifyToolResult("The user doesn't want to take this action right now. STOP what you are doing", true), "interrupted");
    assert.equal(classifyToolResult("Exit code 1\nTraceback", true), "result");
    assert.equal(classifyToolResult("<tool_use_error>Sibling tool call errored</tool_use_error>", true), "result", "a parallel call aborted after it started may have run");
    assert.equal(classifyToolResult("<tool_use_error>Error: No such tool available: bas</tool_use_error>", true), "blocked");
    assert.equal(classifyToolResult("PreToolUse:Bash hook error: looks blocked", false), "result");
  });

  it("tools that cannot write", () => {
    for (const t of ["WebFetch", "WebSearch", "ToolSearch", "Skill", "TodoWrite", "Read", "Glob", "Grep", "SendMessage", "mcp__github__get_file_contents", "mcp__x__list_items", "mcp__vercel__search_vercel_documentation"]) assert.equal(toolNeverWrites(t), true, t);
    for (const t of ["Agent", "Task", "Bash", "Write", "Edit", "NotebookEdit", "mcp__github__create_or_update_file", "mcp__x__get_or_create_item", "mcp__gmail__send_message", "mcp__x__run_query", "mcp__fs__write_file"]) assert.equal(toolNeverWrites(t), false, t);
    assert.equal(isReadOnlyMcpTool("mcp__drive__download_file_content"), false, "a download can write a file");
  });

  it("calls whose work can outlive their result", () => {
    for (const cmd of ["nohup python3 x.py > l 2>&1 &", "python3 serve.py &", "setsid make", "python3 a.py & disown", "osascript -e 'tell application \"Excel\" to save'", "open -a Excel x.xlsx", "for f in a b; do python3 $f & done"]) assert.equal(runsOnAfterResult({ tool: "Bash", command: cmd }), true, cmd);
    for (const cmd of ["python3 x.py && echo ok", "ls 2>&1 | head", "cmd &> log", "echo 'a & b'"]) assert.equal(runsOnAfterResult({ tool: "Bash", command: cmd }), false, cmd);
    assert.equal(runsOnAfterResult({ tool: "Bash", command: "x", background: true }), true);
  });

  it("a result saying the call moved to the background gives no end", () => {
    const c = new EvidenceCollector();
    c.take(JSON.stringify({ type: "assistant", timestamp: iso(0), message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "python3 long.py" } }] } }));
    c.take(JSON.stringify({ type: "user", timestamp: iso(100), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Command was moved to the background with ID: b1" }] } }));
    assert.equal(c.evidence().has("t1"), false);
  });

  it("live reads are incremental: a long transcript is read in steps from where the last read stopped, never skipped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-inc-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "t.jsonl");
    const filler = JSON.stringify({ type: "user", timestamp: iso(1), message: { role: "user", content: "x".repeat(1024 * 1024) } }) + "\n";
    await writeFile(file, filler.repeat(10));
    await appendFile(file, JSON.stringify({ type: "user", timestamp: iso(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "late", is_error: true, content: "PreToolUse:Bash hook error: no" }] } }) + "\n");
    const first = evidenceSince(file, 0, new Set(["late"]));
    assert.equal(first.found.has("late"), false, "the first 8 MB hold no result");
    assert.ok(first.next > 0 && first.next % filler.length === 0);
    const second = evidenceSince(file, first.next, new Set(["late"]));
    assert.deepEqual(second.found.get("late"), { at: T0 + 5, kind: "blocked" });
  });

  it("evidence: never-ran is never credited; a ran call up to the first sweep after its result; a background or own-Post call keeps its window", () => {
    const first = (t: number) => (t <= 100 ? 100 : 200);
    assert.equal(evidenceMayCredit({ at: 0, kind: "blocked" }, { background: false, closedByOwnEvent: false }, 0, first), false);
    assert.equal(evidenceMayCredit({ at: 50, kind: "result" }, { background: false, closedByOwnEvent: false }, 100, first), true);
    assert.equal(evidenceMayCredit({ at: 50, kind: "result" }, { background: false, closedByOwnEvent: false }, 5000, first), false);
    assert.equal(evidenceMayCredit({ at: 50, kind: "result" }, { background: true, closedByOwnEvent: false }, 5000, first), true);
    assert.equal(evidenceMayCredit({ at: 50, kind: "result" }, { background: false, closedByOwnEvent: true }, 5000, first), true);
    assert.equal(evidenceMayCredit(undefined, { background: false, closedByOwnEvent: false }, 5000, first), true);
  });

  it("the transcript collector: tool_result, a later turn, and a background Bash", () => {
    const c = new EvidenceCollector();
    const line = (o: unknown) => c.take(JSON.stringify(o));
    line({ type: "assistant", timestamp: iso(0), message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "y" } }] } });
    line({ type: "user", timestamp: iso(100), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "PreToolUse:Bash hook error: BLOCKED" }] } });
    line({ type: "assistant", timestamp: iso(200), message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "z", run_in_background: true } }] } });
    line({ type: "user", timestamp: iso(250), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "Command running in background" }] } });
    line({ type: "assistant", timestamp: iso(300), message: { id: "m3", role: "assistant", content: [{ type: "text", text: "next" }] } });
    const ev = c.evidence();
    assert.deepEqual(ev.get("t1"), { at: T0 + 100, kind: "blocked" });
    assert.deepEqual(ev.get("t2"), { at: T0 + 200, kind: "turn" }, "t2 had no result line; the agent's next message (m2) closes it");
    assert.equal(ev.has("t3"), false, "a background Bash is not closed by its result");
  });
});

// ---- live: the adapter reads the transcripts ----

const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function live() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const tdir = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-tx-")));
  cleanups.push(async () => {
    for (const d of [home, folder, tdir]) await rm(d, { recursive: true, force: true });
  });
  const book = path.join(folder, "book.xlsx");
  await copyFile(probe(0), book);
  const mainTx = path.join(tdir, "s1.jsonl");
  await writeFile(mainTx, "");
  await mkdir(path.join(tdir, "s1", "subagents"), { recursive: true });
  const txOf = (agent?: string) => (agent ? path.join(tdir, "s1", "subagents", `agent-${agent}.jsonl`) : mainTx);
  let clock = 1_000_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: mainTx, cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const who = (agent?: string) => (agent ? { agent_id: agent, agent_type: "general-purpose" } : {});
  const use = async (id: string, o: { tool?: string; input?: Record<string, unknown>; agent?: string }) => {
    await appendFile(txOf(o.agent), JSON.stringify({ type: "assistant", timestamp: new Date(clock).toISOString(), message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name: o.tool ?? "Bash", input: o.input ?? { command: "python3 edit.py" } }] } }) + "\n");
  };
  const pre = async (id: string, o: { tool?: string; input?: Record<string, unknown>; agent?: string } = {}) => {
    if (o.agent) await writeFile(txOf(o.agent), "", { flag: "a" });
    await use(id, o);
    return send({ hook_event_name: "PreToolUse", tool_name: o.tool ?? "Bash", tool_use_id: id, tool_input: o.input ?? { command: "python3 edit.py" }, ...who(o.agent) });
  };
  const post = (id: string, o: { tool?: string; input?: Record<string, unknown>; agent?: string } = {}) =>
    send({ hook_event_name: "PostToolUse", tool_name: o.tool ?? "Bash", tool_use_id: id, tool_input: o.input ?? { command: "python3 edit.py" }, ...who(o.agent) });
  const result = (id: string, text: string, isError: boolean, agent?: string) =>
    appendFile(txOf(agent), JSON.stringify({ type: "user", timestamp: new Date(clock).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } }) + "\n");
  const credits = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.filePath === book && s.prevSha256 !== null).map((s) => s.credited);
    } finally {
      l.close();
    }
  };
  await pre("warm");
  await post("warm");
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  return { pre, post, result, credits, write: (n: number) => copyFile(probe(n), book) };
}

describe("live adapter: credit only on evidence", () => {
  it("a helper's Bash blocked at Pre (its result in the helper's transcript) is not credited with another helper's write", async () => {
    const t = await live();
    await t.pre("blk", { agent: "A" });
    await t.result("blk", "PreToolUse:Bash hook error: BLOCKED: no", true, "A");
    await t.pre("wr", { agent: "B" });
    await t.write(1);
    await t.post("wr", { agent: "B" });
    assert.deepEqual(t.credits(), [["wr"]]);
  });

  it("a call whose result is in the transcript is credited by the next sweep only, not by later ones", async () => {
    const t = await live();
    await t.pre("a1", { agent: "A" });
    await t.pre("b1", { agent: "B" });
    await t.result("a1", "ok", false, "A");
    await t.pre("c1", { agent: "C", tool: "Read", input: { file_path: "/x" } }); // the sweep that sees a1's result; nothing moved yet
    await t.write(1);
    await t.post("b1", { agent: "B" });
    assert.deepEqual(t.credits(), [["b1"]]);
  });

  it("without a result line the default window stands: two open writers stay joint", async () => {
    const t = await live();
    await t.pre("a1", { agent: "A" });
    await t.pre("b1", { agent: "B" });
    await t.write(1);
    await t.post("b1", { agent: "B" });
    assert.deepEqual(t.credits(), [["a1", "b1"]]);
  });

  it("a background Bash with its immediate result stays a suspect; a WebFetch never is", async () => {
    const t = await live();
    await t.pre("bg", { agent: "A", input: { command: "python3 long.py", run_in_background: true } });
    await t.result("bg", "Command running in background with ID: x", false, "A");
    await t.pre("wf", { agent: "A", tool: "WebFetch", input: { url: "https://x.example" } });
    await t.pre("b1", { agent: "B" });
    await t.write(1);
    await t.post("b1", { agent: "B" });
    assert.deepEqual(t.credits(), [["b1", "bg"]]);
  });

  it("a detached Bash (`&`) with its result in the transcript stays a suspect", async () => {
    const t = await live();
    await t.pre("nh", { agent: "A", input: { command: "nohup python3 long.py > /tmp/cocheck-nohup.log 2>&1 &" } });
    await t.result("nh", "", false, "A");
    await t.pre("b1", { agent: "B" });
    await t.write(1);
    await t.post("b1", { agent: "B" });
    assert.deepEqual(t.credits(), [["b1", "nh"]]);
  });
});

// ---- a Codex command the host refused never ran and takes no credit ----

describe("a refused Codex command is settled as never ran", async () => {
  const { mkdirSync, readFileSync: readSync2, writeFileSync } = await import("node:fs");
  const { mkdtemp: mk, realpath: rp, rm: rmDir, copyFile: cp, writeFile: wf } = await import("node:fs/promises");
  const { tmpdir: td } = await import("node:os");
  const SESSION = "01a173bf-f72a-77f1-87ec-82e7276d1799";
  // the refused command of a recorded run (paths scrubbed), as the fixture's rollout line quotes it
  const REFUSED = "python3 memo_builder.py\nrm -rf .memo_render\npython3 render_docx.py memo.docx --output_dir .memo_render";
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rmDir(d, { recursive: true, force: true });
  });
  /** Rust Debug string escaping, as the host applies it (twice) when it quotes the command in its error text. */
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  /** The recorded run rollout line (test/fixtures/codex-refused.jsonl) with `cmd` as the quoted command, stamped `ts`. */
  const refusalLine = (cmd: string, ts: number): string => {
    const d = JSON.parse(readSync2("test/fixtures/codex-refused.jsonl", "utf8"));
    const t = d.payload.output[1].text as string;
    assert.ok(t.includes(esc(esc(REFUSED))), "the fixture quotes the recorded command");
    d.payload.output[1].text = t.replace(esc(esc(REFUSED)), esc(esc(cmd)));
    d.timestamp = new Date(ts).toISOString();
    return JSON.stringify(d);
  };
  const ranLine = (ts: number): string =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_x", output: [{ type: "input_text", text: "Script completed\nWall time 0.3 seconds\nOutput:\n" }, { type: "input_text", text: "{}" }] } });

  async function rig() {
    const root = await rp(await mk(path.join(td(), "cocheck-")));
    dirs.push(root);
    const home = path.join(root, "home"), folder = path.join(root, "work"), sessions = path.join(root, "sessions");
    for (const d of [home, folder, sessions]) await mkdir(d);
    let clock = new Date(2026, 9, 25, 12, 0, 0).getTime();
    const day = path.join(sessions, "2026", "10", "25");
    mkdirSync(day, { recursive: true });
    const rollout = path.join(day, `rollout-2026-10-25T12-00-00-${SESSION}.jsonl`);
    writeFileSync(rollout, "");
    const hook = (o: Record<string, unknown>) =>
      handleHook({ session_id: SESSION, cwd: folder, model: "gpt-6.1-sol", permission_mode: "bypassPermissions", ...o } as unknown as HookPayload, { host: "codex", home, claimed: trackedClaims, folder, perSession: false, now: () => (clock += 1000), codexSessions: sessions });
    const pre = (id: string, command: string) => hook({ hook_event_name: "PreToolUse", tool_use_id: id, tool_name: "Bash", tool_input: { command } });
    const post = (id: string, command: string) => hook({ hook_event_name: "PostToolUse", tool_use_id: id, tool_name: "Bash", tool_input: { command }, tool_response: "" });
    const note = (line: string) => appendFile(rollout, line + "\n");
    const state = () => {
      const l = openLedger(home);
      try {
        return {
          credited: l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null).map((s) => s.credited),
          closedBy: Object.fromEntries(l.sessionOpRows(SESSION).filter((o) => o.toolUseId !== undefined).map((o) => [o.toolUseId!, o.closedBy])),
        };
      } finally {
        l.close();
      }
    };
    await wf(path.join(folder, "seed.txt"), "seed\n");
    await cp("test/fixtures/memo-v1.docx", path.join(folder, "memo.docx"));
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Build the memo" });
    return { folder, hook, pre, post, note, state, now: () => clock, memo: path.join(folder, "memo.docx") };
  }

  it("the refused call takes no credit and closes as refused; the call that ran (A) keeps the file", async () => {
    const r = await rig();
    await r.pre("exec-A", "python3 build_memo.py");
    await r.pre("exec-B", REFUSED);
    await r.note(refusalLine(REFUSED, r.now()));
    await cp("test/fixtures/memo-v3.docx", r.memo);
    await r.post("exec-A", "python3 build_memo.py");
    const s = r.state();
    assert.ok(s.credited.length > 0, "the memo changed");
    assert.deepEqual(s.credited.map((c) => c.includes("exec-B")), s.credited.map(() => false), `credited ${JSON.stringify(s.credited)}`);
    assert.ok(s.credited.every((c) => c.length === 1 && c[0] === "exec-A"), JSON.stringify(s.credited));
    assert.equal(s.closedBy["exec-B"], "refused");
    assert.equal(s.closedBy["exec-A"], "post");
  });

  it("an alone refused call is closed as refused, not left open to the Stop", async () => {
    const r = await rig();
    await r.pre("exec-B", REFUSED);
    await r.note(refusalLine(REFUSED, r.now()));
    await r.hook({ hook_event_name: "Stop", last_assistant_message: "done" });
    assert.equal(r.state().closedBy["exec-B"], "refused");
  });

  it("two open calls with the identical command: nothing changes", async () => {
    const r = await rig();
    await r.pre("exec-B1", REFUSED);
    await r.pre("exec-B2", REFUSED);
    await r.note(refusalLine(REFUSED, r.now()));
    await r.hook({ hook_event_name: "Stop", last_assistant_message: "done" });
    const s = r.state();
    assert.equal(s.closedBy["exec-B1"], "stop");
    assert.equal(s.closedBy["exec-B2"], "stop");
  });

  it("an exec that returned early (a result line, no rejection) is no evidence: the call stays open to its Post", async () => {
    const r = await rig();
    await r.pre("exec-B", REFUSED);
    await r.note(ranLine(r.now()));
    await r.post("exec-B", REFUSED);
    assert.equal(r.state().closedBy["exec-B"], "post");
  });

  it("a rejection of a different command, or from before this call began, settles nothing (the same command run again is not refused)", async () => {
    const r = await rig();
    await r.note(refusalLine(REFUSED, r.now() - 60_000));
    await r.pre("exec-B", REFUSED);
    await r.pre("exec-C", "python3 other.py");
    await r.note(refusalLine("python3 never_opened.py", r.now()));
    await r.post("exec-B", REFUSED);
    await r.post("exec-C", "python3 other.py");
    const s = r.state();
    assert.equal(s.closedBy["exec-B"], "post");
    assert.equal(s.closedBy["exec-C"], "post");
  });
});
