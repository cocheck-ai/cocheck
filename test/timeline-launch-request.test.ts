import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt } from "./fixtures/timeline.ts";

// a helper's line leaves from the later of the parent's last own stop before the launch and the stop of the request that owns
// the launching call. Guarded against: a launch with no request in its turn (a wake turn), or one made by another helper, still
// leaves from its true parent and never from an unrelated request.

const W = "/w/";
const agent = (id: string, launch: string) => ({ agent_id: id, agent_type: "general-purpose", launch_tool_use_id: launch });
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit") =>
  call(id, { session: "s1", tool, desc: id, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
const launch = (id: string, seq: number, background: boolean) => c(id, seq, { background }, [], "Agent");
const input = (ops: RawOp[], fileStates: RawState[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[]) => buildRailModel(buildTimeline(input(ops, fileStates)));
const changed = (file: string, sha: string, by: string, step: number) => [state(W + file, sha + "0", null, { step: 1 }), state(W + file, sha + "1", sha + "0", { open: [by], credited: [by], step })];
const idx = (m: ReturnType<typeof model>, id: string | null | undefined) => m.stops.findIndex((s) => s.id === id);
// a launch is now a step of its own ("Started Helper n ...") on the launching lane, so a line leaves from that step. The rules below still
// hold: the step belongs to the same parent and the same request, and nothing but the launch's own step sits between the old anchor and it.
const stepOf = (m: ReturnType<typeof model>, id: string) => m.stops[idx(m, m.actors.find((a) => a.id === id)!.startId)]!;
const sinceLastOwn = (m: ReturnType<typeof model>, anchorId: string, startId: string) => m.stops.slice(idx(m, anchorId) + 1, idx(m, startId)).filter((s) => s.lane === m.stops[idx(m, anchorId)]!.lane);
const requests = (m: ReturnType<typeof model>) => m.stops.filter((s) => s.request);

for (const background of [true, false]) {
  const kind = background ? "background" : "foreground";
  describe(`a ${kind} helper branches from the request that launched it`, () => {
    // Request 1: Claude edits a.txt. Request 2: the very first action is the launch; the helper edits x.txt.
    const ops = [
      prompt("s1", ["Ask 1."], stamp(1)), c("ca", 2, {}, [W + "a.txt"]),
      prompt("s1", ["Ask 2."], stamp(5)), launch("l1", 6, background), c("h1", 7, agent("ag1", "l1"), [W + "x.txt"]), c("cb", 8, {}, [W + "b.txt"]),
      stop("s1"),
    ];
    const states = [...changed("a.txt", "a", "ca", 2), ...changed("x.txt", "x", "h1", 3), ...changed("b.txt", "b", "cb", 4)];
    it("launch in the second request after earlier Claude changes: leaves at the second request, not the first request's change", () => {
      const m = model(ops, states);
      const [, r2] = requests(m);
      // the line leaves from the launch's own step, which is the first step of Claude's after the second request, not the first request's change.
      const st = stepOf(m, "agent:1");
      assert.ok(st.id.startsWith("start-") && st.lane === "claude");
      assert.equal(sinceLastOwn(m, r2!.id, st.id).length, 0);
    });
    it("launch in the first request leaves at that request", () => {
      const m = model([prompt("s1", ["Ask 1."], stamp(1)), launch("l1", 2, background), c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]), stop("s1")], changed("x.txt", "x", "h1", 2));
      // the launch's own step, directly after the request.
      const st = stepOf(m, "agent:1");
      assert.ok(st.id.startsWith("start-") && st.lane === "claude");
      assert.equal(sinceLastOwn(m, requests(m)[0]!.id, st.id).length, 0);
    });
    it("a Claude change between the request and the launch is later than the request, so the line leaves from the change", () => {
      const o = [prompt("s1", ["Ask 1."], stamp(1)), c("ca", 2, {}, [W + "a.txt"]), launch("l1", 3, background), c("h1", 4, agent("ag1", "l1"), [W + "x.txt"]), stop("s1")];
      const m = model(o, [...changed("a.txt", "a", "ca", 2), ...changed("x.txt", "x", "h1", 3)]);
      const h = m.actors.find((a) => a.id === "agent:1")!;
      // the launch's own step, directly after the Claude change that came between the request and the launch.
      const st = m.stops[idx(m, h.startId)]!;
      assert.ok(st.id.startsWith("start-") && st.lane === "claude");
      const change = m.stops.findIndex((x) => x.change?.file === "a.txt");
      assert.ok(change >= 0 && change < idx(m, st.id));
      assert.equal(sinceLastOwn(m, m.stops[change]!.id, st.id).length, 0);
    });
  });
}

describe("the true parent, never an unrelated request", () => {
  it("a nested helper leaves from its parent helper's stop, not from the request that owns the root launch", () => {
    const o = [
      prompt("s1", ["Ask 1."], stamp(1)), c("m0", 2, {}, [W + "m.txt"]),
      prompt("s1", ["Ask 2."], stamp(5)), launch("l1", 6, true),
      c("h1", 7, agent("ag1", "l1"), [W + "x.txt"]),
      c("l2", 8, { ...agent("ag1", "l1"), background: true }, [], "Agent"),
      c("n1", 9, agent("ag2", "l2"), [W + "q.txt"]),
      stop("s1"),
    ];
    const m = model(o, [...changed("m.txt", "m", "m0", 2), ...changed("x.txt", "x", "h1", 3), ...changed("q.txt", "q", "n1", 4)]);
    const child = m.actors.find((a) => a.parent === "agent:1")!;
    assert.ok(child, "no nested lane");
    // the child leaves from its parent helper's launch step, on the parent's lane.
    assert.equal(m.stops[idx(m, child.startId)]!.lane, "agent:1");
    assert.ok(m.stops[idx(m, child.startId)]!.id.startsWith("start-"));
    // The root helper leaves from Claude's launch step in request 2, never from request 1's change.
    const root = stepOf(m, "agent:1");
    assert.ok(root.id.startsWith("start-") && root.lane === "claude");
    assert.ok(idx(m, root.id) > idx(m, requests(m)[1]!.id));
  });
  it("a launch in a wake turn (no request in that turn) leaves from Claude's last own stop, not the old request", () => {
    // Request 1 launches helper 1 and finishes it; request 2 comes; the wake turn then launches helper 2.
    const o = [
      prompt("s1", ["Ask 1."], stamp(1)), launch("l1", 2, true), c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]),
      wakePrompt("s1", { toolUseId: "l1" }, 4),
      c("cw", 5, {}, [W + "w.txt"]), launch("l2", 6, true), c("h2", 7, agent("ag2", "l2"), [W + "y.txt"]),
      stop("s1"),
    ];
    const m = model(o, [...changed("x.txt", "x", "h1", 2), ...changed("w.txt", "w", "cw", 3), ...changed("y.txt", "y", "h2", 4)]);
    const h2 = m.actors.find((a) => a.id === "agent:2")!;
    // the launch's own step, directly after Claude's change in the wake turn (never the old request).
    const st = m.stops[idx(m, h2.startId)]!;
    assert.ok(st.id.startsWith("start-") && st.lane === "claude");
    const w = m.stops.findIndex((x) => x.change?.file === "w.txt");
    assert.ok(w >= 0 && w < idx(m, st.id));
    assert.equal(sinceLastOwn(m, m.stops[w]!.id, st.id).length, 0);
  });
  it("a wake-turn launch with no Claude stop before it does not borrow the request", () => {
    const o = [
      prompt("s1", ["Ask 1."], stamp(1)), launch("l1", 2, false), c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]),
      wakePrompt("s1", { toolUseId: "l1" }, 4),
      launch("l2", 5, true), c("h2", 6, agent("ag2", "l2"), [W + "y.txt"]),
      stop("s1"),
    ];
    const m = model(o, [...changed("x.txt", "x", "h1", 2), ...changed("y.txt", "y", "h2", 3)]);
    const h2 = m.actors.find((a) => a.id === "agent:2")!;
    // The wake stop is Claude's own last stop before the launch, and it is later than the request: the line leaves from it.
    assert.notEqual(h2.startId, requests(m)[0]!.id);
    assert.ok(m.stops[idx(m, h2.startId)]!.lane === "claude");
  });
});
