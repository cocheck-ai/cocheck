import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRuns } from "../src/timeline/runs.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt, wakeText } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// A background agent's wake is a merge stop on its spawner's line, never a request. Hand-built op logs in the field names the
// adapter writes (agent_id, launch_tool_use_id, a prompt op with stamped requests); the wake text is shaped from a real wake.

const W = "/w/";
const agent = (id: string, launch?: string, type = "general-purpose") => ({ agent_id: id, agent_type: type, ...(launch ? { launch_tool_use_id: launch } : {}) });
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit", session = "s1") =>
  call(id, { session, tool, desc: id, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
const launch = (id: string, seq: number, session = "s1") => c(id, seq, { background: true }, [], "Agent", session);
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(buildTimeline(input(ops, fileStates)));
const changed = (file: string, sha: string, by: string, step: number) => [state(W + file, sha + "0", null, { step: 1 }), state(W + file, sha + "1", sha + "0", { open: [by], credited: [by], step })];
const ids = (r: { calls: Array<{ id: string }> }) => r.calls.map((x) => x.id);

describe("a wake is a merge stop on the right lane", () => {
  const ops = [
    prompt("s1", ["Ask A."], stamp(1)),
    launch("l1", 2),
    c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]),
    c("m1", 4, {}, [W + "y.txt"]),
    wakePrompt("s1", { toolUseId: "l1", summary: 'Agent "Edit x" finished' }, 5),
    stop("s1", "done"),
  ];
  const states = [...changed("x.txt", "x", "h1", 2), ...changed("y.txt", "y", "m1", 3)];

  it("the wake is a stop on Claude's line reading Helper 1 finished plus the summary, and it is the lane's merge point", () => {
    const m = model(ops, states);
    const wake = m.stops.find((s) => s.head.startsWith("Helper 1 finished"))!;
    assert.ok(wake, "no wake stop");
    assert.equal(wake.lane, "claude");
    assert.equal(wake.head, "Helper 1 finished", "a summary that only restates the finish is not repeated");
    const lane = m.actors.find((a) => a.id === "agent:1")!;
    assert.equal(lane.mergeId, wake.id);
    assert.equal(lane.parent, "claude");
  });

  it("is not a request: no request stop for it, the numbering skips it and the raw text is nowhere", () => {
    const m = model(ops, states);
    assert.deepEqual(m.stops.filter((s) => s.request).map((s) => s.head), ["You made request 1"]);
    assert.ok(!JSON.stringify(m).includes("task-notification"));
    assert.ok(!JSON.stringify(m).includes("a1b2c3d4e5f60718"));
  });

  it("names the status when it is not completed", () => {
    const failed = [...ops.slice(0, 4), wakePrompt("s1", { toolUseId: "l1", status: "failed", summary: 'Agent "Edit x" failed' }, 5), stop("s1")];
    const wake = model(failed, states).stops.find((s) => s.head.startsWith("Helper 1 finished"))!;
    assert.ok(/\(failed\)/.test(wake.head), wake.head);
    assert.ok(!/\(completed\)/.test(model(ops, states).stops.find((s) => s.head.startsWith("Helper 1 finished"))!.head));
  });

  it("clamps and scrubs the summary like other stop text", () => {
    const long = "A".repeat(5000) + " /Users/someone/secret folder/private.txt";
    const wake = model([...ops.slice(0, 4), wakePrompt("s1", { toolUseId: "l1", summary: long }, 5), stop("s1")], states).stops.find((s) => s.head.startsWith("Helper 1 finished"))!;
    assert.ok(wake.head.length < 400, String(wake.head.length));
    const sneaky = model([...ops.slice(0, 4), wakePrompt("s1", { toolUseId: "l1", summary: "see /Users/someone/secret folder/private.txt now" }, 5), stop("s1")], states).stops.find((s) => s.head.startsWith("Helper 1 finished"))!;
    assert.ok(!sneaky.head.includes("/Users/someone"), sneaky.head);
  });
});

describe("a read-only background agent gets a lane", () => {
  const ops = [
    prompt("s1", ["Look it up."], stamp(1)),
    launch("l2", 2),
    c("r1", 3, agent("ag2", "l2"), [W + "x.txt"], "Read"),
    wakePrompt("s1", { toolUseId: "l2", summary: 'Agent "Look" finished' }, 4),
    stop("s1"),
  ];
  it("the lane exists with one moment (not yet claiming it changed no file), and merges at the wake", () => {
    const m = model(ops, [state(W + "x.txt", "x0", null, { step: 1 })]);
    const lane = m.actors.find((a) => a.id === "agent:1")!;
    assert.ok(lane, "no lane");
    const mine = m.stops.filter((s) => s.lane === "agent:1");
    assert.equal(mine.length, 1);
    assert.ok(!/changed no file/.test(mine[0]!.head), mine[0]!.head);
    assert.ok(mine[0]!.id.startsWith("idle-"), mine[0]!.id);
    const wake = m.stops.find((s) => s.head.startsWith("Helper 1 finished"))!;
    assert.equal(lane.mergeId, wake.id);
    assert.equal(lane.parent, "claude");
  });
  it("an agent with no call recorded at all is still a lane", () => {
    const m = model([prompt("s1", ["Go."], stamp(1)), launch("l3", 2), wakePrompt("s1", { toolUseId: "l3" }, 3), stop("s1")]);
    assert.deepEqual(m.actors.filter((a) => a.parent).map((a) => a.id), ["agent:1"]);
    assert.ok(m.stops.some((s) => s.lane === "agent:1" && s.id.startsWith("idle-")));
  });
  it("a foreground helper that changed nothing and was not woken has no lane", () => {
    const m = model([prompt("s1", ["Go."], stamp(1)), launch("l4", 2), c("r4", 3, agent("ag4", "l4"), [W + "x.txt"], "Read"), stop("s1")], [state(W + "x.txt", "x0", null, { step: 1 })]);
    assert.deepEqual(m.actors.map((a) => a.id), ["you", "claude", "other"]);
  });
});

describe("work after a wake belongs to the request that owns the woken agent", () => {
  const ops = [
    prompt("s1", ["Ask A."], stamp(1)),
    launch("l1", 2),
    c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]),
    prompt("s1", ["Ask B."], stamp(4)),
    c("b1", 5, {}, [W + "z.txt"]),
    wakePrompt("s1", { toolUseId: "l1" }, 6),
    c("w1", 7, {}, [W + "w.txt"]),
    stop("s1", "done"),
  ];
  const states = [...changed("x.txt", "x", "h1", 2), ...changed("z.txt", "z", "b1", 3), ...changed("w.txt", "w", "w1", 4)];
  it("the runs: A holds the launcher, its agent and the post-wake call; B holds only its own", () => {
    const { requests } = buildRuns(ops, states);
    assert.deepEqual(requests.map((r) => [r.texts[0], ids(r).sort()]), [["Ask A.", ["h1", "l1", "w1"]], ["Ask B.", ["b1"]]]);
  });
  it("the rail: the post-wake moment names Ask A, no third request exists", () => {
    const m = model(ops, states);
    assert.equal(m.stops.filter((s) => s.request).length, 2);
    assert.equal(m.stops.find((s) => s.change?.file === "w.txt")!.change!.ask, "Ask A.");
    assert.equal(m.stops.find((s) => s.change?.file === "z.txt")!.change!.ask, "Ask B.");
  });
  it("the same on the fallback path (one call lacks startSeq)", () => {
    const stripped = ops.map((o, i) => {
      if (i !== 1) return o;
      const a = JSON.parse(o.args_json!) as Record<string, unknown>;
      delete a.startSeq;
      return { ...o, args_json: JSON.stringify(a) };
    });
    const { requests } = buildRuns(stripped, states);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => !r.texts.some((t) => t.includes("task-notification"))));
  });
});

describe("nested helpers", () => {
  const ops = (parentChanges: boolean) => [
    prompt("s1", ["Ask A."], stamp(1)),
    launch("l1", 2),
    c("h1", 3, agent("ag1", "l1"), [W + "x.txt"], parentChanges ? "Edit" : "Read"),
    c("l2", 4, { ...agent("ag1", "l1"), background: true }, [], "Agent"),
    c("n1", 5, agent("ag2", "l2"), [W + "q.txt"]),
    c("h2", 6, agent("ag1", "l1"), [W + "x.txt"], parentChanges ? "Edit" : "Read"),
    stop("s1"),
  ];
  const states = (parentChanges: boolean) => [...(parentChanges ? [...changed("x.txt", "x", "h1", 2), state(W + "x.txt", "x2", "x1", { open: ["h2"], credited: ["h2"], step: 4 })] : [state(W + "x.txt", "x0", null, { step: 1 })]), ...changed("q.txt", "q", "n1", 3)];
  it("a helper launched by a helper branches off and merges into its parent helper's lane", () => {
    const m = model(ops(true), states(true));
    const child = m.actors.find((a) => a.type !== undefined && a.id === "agent:2")!;
    assert.equal(m.actors.find((a) => a.id === "agent:1")!.parent, "claude");
    assert.equal(child.parent, "agent:1");
    const parentStops = m.stops.filter((s) => s.lane === "agent:1").map((s) => s.id);
    assert.ok(parentStops.includes(child.startId!));
    assert.ok(parentStops.includes(child.mergeId!));
  });
  it("a parent with no lane falls back to Claude", () => {
    const m = model(ops(false), states(false));
    assert.deepEqual(m.actors.filter((a) => a.parent).map((a) => [a.id, a.parent]), [["agent:1", "claude"]]);
  });
});

describe("only a real wake is a wake", () => {
  const typed = (text: string, sessionOfLauncher = "s1") => [
    launch("l1", 2, sessionOfLauncher),
    c("m1", 3, {}, [W + "y.txt"]),
    prompt("s1", [text], stamp(1)),
    stop("s1"),
  ];
  // The request line scrubs a path outside the folder like any request text; the output-file line is the only path in a wake, so it is set aside.
  const noPath = (t: string) => t.replace(/<output-file>.*?<\/output-file>/s, "");
  const requestTexts = (ops: RawOp[]) => model(ops, changed("y.txt", "y", "m1", 2)).stops.filter((s) => s.request && !s.request.missing).map((s) => noPath(s.request!.text)).filter((t) => t !== "");
  it("a typed prompt starting with <task-notification> that names no launcher call stays a request, with its text", () => {
    const text = wakeText({ toolUseId: "toolu_nothing" });
    assert.deepEqual(requestTexts(typed(text)), [noPath(text)]);
  });
  it("a typed prompt with no tool-use-id stays a request", () => {
    const text = "<task-notification>\n<summary>hello</summary>\n</task-notification>";
    assert.deepEqual(requestTexts(typed(text)), [noPath(text)]);
  });
  it("a prompt that only contains the notification mid-text stays a request", () => {
    const text = `please look at this ${wakeText({ toolUseId: "l1" })}`;
    assert.deepEqual(requestTexts(typed(text)), [noPath(text)]);
  });
  it("a wake naming a launcher in another session stays a request", () => {
    const text = wakeText({ toolUseId: "l1" });
    assert.deepEqual(requestTexts(typed(text, "s2")), [noPath(text)]);
  });
  it("a wake naming a call that is not a launcher stays a request", () => {
    const text = wakeText({ toolUseId: "m1" });
    assert.deepEqual(requestTexts(typed(text)), [noPath(text)]);
  });
  it("a stray lane is never made by a typed lookalike", () => {
    const m = model(typed(wakeText({ toolUseId: "toolu_nothing" })), changed("y.txt", "y", "m1", 2));
    assert.deepEqual(m.actors.map((a) => a.id), ["you", "claude", "other"]);
  });
});

// Batched notifications, an agent woken more than once, and a nested helper whose parent has no moment before it.
describe("several notifications in one prompt", () => {
  const two = (a: string, b: string, extraB: Record<string, unknown> = {}) => wakeText({ toolUseId: a, summary: 'Agent "one" finished' }) + "\n" + wakeText({ toolUseId: b, summary: 'Agent "two" finished', ...extraB });
  const base = (text: string) => [
    prompt("s1", ["Ask A."], stamp(1)),
    launch("l1", 2), launch("l2", 3),
    c("h1", 4, agent("ag1", "l1"), [W + "x.txt"]),
    c("h2", 5, agent("ag2", "l2"), [W + "y.txt"]),
    prompt("s1", [text], stamp(6)),
    stop("s1"),
  ];
  const states = [...changed("x.txt", "x", "h1", 2), ...changed("y.txt", "y", "h2", 3)];
  it("two blocks give two wake stops and each lane merges at its own", () => {
    const m = model(base(two("l1", "l2")), states);
    const wakes = m.stops.filter((s) => /^Helper \d finished/.test(s.head));
    assert.deepEqual(wakes.map((s) => s.head), ["Helper 1 finished", "Helper 2 finished"]);
    assert.equal(m.actors.find((a) => a.id === "agent:1")!.mergeId, wakes[0]!.id);
    assert.equal(m.actors.find((a) => a.id === "agent:2")!.mergeId, wakes[1]!.id);
    assert.equal(m.stops.filter((s) => s.request).length, 1);
  });
  it("one valid block and one naming no launcher: the valid one is a wake, the other's text is shown nowhere, and the prompt is not a request", () => {
    const text = wakeText({ toolUseId: "l1", summary: 'Agent "one" finished' }) + "\n" + wakeText({ toolUseId: "toolu_none", summary: "LEAKED-SUMMARY" });
    const m = model(base(text), states);
    assert.equal(m.stops.filter((s) => /^Helper \d finished/.test(s.head)).length, 1);
    assert.equal(m.stops.filter((s) => s.request).length, 1);
    assert.ok(!JSON.stringify(m).includes("LEAKED-SUMMARY"));
    assert.ok(!JSON.stringify(m).includes("task-notification"));
  });
  it("the invalid block may come first; the prompt still starts with a block", () => {
    const text = wakeText({ toolUseId: "toolu_none", summary: "LEAKED-SUMMARY" }) + "\n" + wakeText({ toolUseId: "l2" });
    const m = model(base(text), states);
    assert.equal(m.stops.filter((s) => /^Helper \d finished/.test(s.head)).length, 1);
    assert.ok(!JSON.stringify(m).includes("LEAKED-SUMMARY"));
  });
  it("guard: when no block names a launcher the whole prompt is a request", () => {
    const text = wakeText({ toolUseId: "toolu_a" }) + "\n" + wakeText({ toolUseId: "toolu_b" });
    const m = model(base(text), states);
    assert.equal(m.stops.filter((s) => s.request).length, 2);
  });
  it("guard: text before the first block makes it a request", () => {
    const m = model(base("hi " + two("l1", "l2")), states);
    assert.equal(m.stops.filter((s) => s.request).length, 2);
    assert.ok(!m.stops.some((s) => /^Helper \d finished/.test(s.head)));
  });
});

describe("an agent woken more than once", () => {
  const states = [...changed("x.txt", "x", "h1", 2), state(W + "x.txt", "x2", "x1", { open: ["h3"], credited: ["h3"], step: 4 })];
  it("every wake is a stop, none a request; the lane merges at the first wake after its last call", () => {
    const ops = [
      prompt("s1", ["Ask."], stamp(1)), launch("l1", 2), c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]),
      wakePrompt("s1", { toolUseId: "l1", summary: "first done" }, 4),
      c("h3", 5, agent("ag1", "l1"), [W + "x.txt"]),
      wakePrompt("s1", { toolUseId: "l1", summary: "second done" }, 6),
      wakePrompt("s1", { toolUseId: "l1", summary: "third done" }, 7), stop("s1"),
    ];
    const m = model(ops, states);
    const wakes = m.stops.filter((s) => /^Helper 1 finished/.test(s.head));
    assert.equal(wakes.length, 3);
    assert.equal(m.stops.filter((s) => s.request).length, 1);
    assert.ok(wakes.every((w) => w.lane === "claude"));
    assert.equal(m.actors.find((a) => a.id === "agent:1")!.mergeId, wakes[1]!.id, "the wake after its last call");
    assert.equal(m.actors.filter((a) => a.parent).length, 1);
  });
  it("a lane with no later call merges at the first wake; later wakes stay stops on the spawner's line", () => {
    const ops = [prompt("s1", ["Ask."], stamp(1)), launch("l1", 2), c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]), wakePrompt("s1", { toolUseId: "l1", summary: "first" }, 4), wakePrompt("s1", { toolUseId: "l1", summary: "again" }, 5), stop("s1")];
    const m = model(ops, changed("x.txt", "x", "h1", 2));
    const wakes = m.stops.filter((s) => /^Helper 1 finished/.test(s.head));
    assert.equal(wakes.length, 2);
    assert.equal(m.actors.find((a) => a.id === "agent:1")!.mergeId, wakes[0]!.id);
  });
});

describe("a nested helper whose parent has no moment before its first", () => {
  // Claude edits (seq 2), launches helper 1 (seq 3); helper 1 launches helper 2 (seq 4), which edits first (seq 5); helper 1 edits only after (seq 6).
  const ops = [
    prompt("s1", ["Ask."], stamp(1)),
    c("m0", 2, {}, [W + "m.txt"]),
    launch("l1", 3),
    c("l2", 4, { ...agent("ag1", "l1"), background: true }, [], "Agent"),
    c("n1", 5, agent("ag2", "l2"), [W + "q.txt"]),
    c("h1", 6, agent("ag1", "l1"), [W + "x.txt"]),
    c("m9", 7, {}, [W + "z.txt"]),
    stop("s1"),
  ];
  const states = [...changed("m.txt", "m", "m0", 2), ...changed("q.txt", "q", "n1", 3), ...changed("x.txt", "x", "h1", 4), ...changed("z.txt", "z", "m9", 5)];
  it("branches off the parent's branch point, drawn from the parent's lane and not as a plain line", () => {
    const m = model(ops, states);
    const idx = (id: string | null | undefined) => m.stops.findIndex((s) => s.id === id);
    // Helpers are numbered by launch, so the parent (launched first) is Helper 1 and the child it launched Helper 2.
    const parent = m.actors.find((a) => a.id === "agent:1")!;
    const child = m.actors.find((a) => a.id === "agent:2")!;
    assert.equal(child.parent, "agent:1");
    const first = m.stops.findIndex((s) => s.lane === "agent:2");
    assert.ok(child.startId && idx(child.startId) >= 0 && idx(child.startId) < first, "the child has a branch stop before its first moment");
    // The parent's launch of the child is now a step on the parent's own lane ("Started Helper 2"), so the parent has a moment before the
    // child's first. The parent leaves from Claude's launch step; the child leaves from that parent-lane step, drawn from the parent's lane.
    assert.ok(m.stops[idx(parent.startId)]!.id.startsWith("start-") && m.stops[idx(parent.startId)]!.lane === "claude");
    assert.ok(m.stops[idx(child.startId)]!.id.startsWith("start-") && m.stops[idx(child.startId)]!.lane === "agent:1");
    assert.ok(idx(parent.startId) < idx(child.startId), "the child leaves after the parent has branched");
    assert.ok(child.mergeId && m.stops[idx(child.mergeId)]!.lane === "agent:1", "and merges into the parent's lane");
  });
});
