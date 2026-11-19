import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// a helper that changed no file gets its step at its launch, right after "Started Helper n", and its calls follow it on its lane.
// Shapes from drives 10 and 11: a background Agent launch, the helper's own read-only calls, then the wake much later. Before, the step
// was pushed at the wake, so it sat after every call of the helper and carried the delivery time.

const W = "/w/";
const agent = (id: string, launch: string) => ({ agent_id: id, agent_type: "general-purpose", launch_tool_use_id: launch });
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit") =>
  call(id, { session: "s1", tool, desc: id, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
const launch = (id: string, seq: number) => c(id, seq, { background: true }, [], "Agent");
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(buildTimeline(input(ops, fileStates)));
const changed = (file: string, sha: string, by: string, step: number) => [state(W + file, sha + "0", null, { step: 1 }), state(W + file, sha + "1", sha + "0", { open: [by], credited: [by], step })];

describe("a helper that changed no file: its step sits at its launch", () => {
  // A recorded-run shape: launch, three read-only calls by the helper, a long gap, then the wake.
  const ops = [
    prompt("s1", ["Look it up."], stamp(1)),
    launch("l1", 2),
    c("r1", 3, agent("ag1", "l1"), [W + "x.txt"], "Read"),
    c("r2", 4, agent("ag1", "l1"), [W + "x.txt"], "Read"),
    c("r3", 5, agent("ag1", "l1"), [W + "x.txt"], "Read"),
    wakePrompt("s1", { toolUseId: "l1", summary: 'Agent "Look" finished' }, 20),
    stop("s1"),
  ];
  const states = [state(W + "x.txt", "x0", null, { step: 1 })];

  it("the step follows 'Started Helper 1' directly, at the launch time, before the wake", () => {
    const m = model(ops, states);
    const start = m.stops.findIndex((s) => s.head.startsWith("Started Helper 1"));
    const idle = m.stops.findIndex((s) => s.id.startsWith("idle-"));
    const wake = m.stops.findIndex((s) => s.head.startsWith("Helper 1 finished"));
    assert.ok(start >= 0 && idle === start + 1 && wake > idle, JSON.stringify(m.stops.map((s) => s.id)));
    assert.equal(m.stops[idle]!.lane, "agent:1");
    assert.equal(m.stops[idle]!.at, m.stops[start]!.at, "timed at the launch");
    assert.ok((m.stops[wake]!.at ?? 0) > (m.stops[idle]!.at ?? 0));
  });

  it("the helper's calls ride on that step, not on a stop before it", () => {
    const m = model(ops, states);
    const idle = m.stops.find((s) => s.id.startsWith("idle-"))!;
    assert.deepEqual((idle.quiet?.calls ?? []).filter((q) => q.lane === "agent:1").map((q) => q.id), ["r1", "r2", "r3"]);
  });

  it("the heading does not claim 'changed no file' before the end", () => {
    const m = model(ops, states);
    assert.ok(!/changed no file/i.test(m.stops.find((s) => s.id.startsWith("idle-"))!.head));
    assert.ok(!/changed no file/i.test(m.stops.find((s) => s.id.startsWith("idle-"))!.title ?? ""));
  });

  it("a second helper that changed a file keeps its own order and number", () => {
    const two = [
      prompt("s1", ["Go."], stamp(1)),
      launch("l1", 2),
      launch("l2", 3),
      c("e1", 4, agent("ag1", "l1"), [W + "y.txt"]),
      c("r1", 5, agent("ag2", "l2"), [W + "x.txt"], "Read"),
      wakePrompt("s1", { toolUseId: "l1" }, 20),
      wakePrompt("s1", { toolUseId: "l2" }, 21),
      stop("s1"),
    ];
    const m = model(two, [...states, ...changed("y.txt", "y", "e1", 2)]);
    const ids = m.stops.map((s) => s.id);
    // an idle- id names the agent, not its lane's number; only the second helper (which changed no file) has one.
    const idles = m.stops.filter((s) => s.id.startsWith("idle-"));
    assert.deepEqual(idles.map((s) => s.lane), ["agent:2"]);
    const starts = ids.filter((i) => i.startsWith("start-"));
    assert.ok(ids.indexOf(idles[0]!.id) > ids.indexOf(starts[1]!) && ids.indexOf(idles[0]!.id) < ids.findIndex((i) => i.startsWith("wake-")), ids.join(","));
  });
});
