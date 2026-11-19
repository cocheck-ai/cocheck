import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRuns } from "../src/timeline/runs.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

// A call sits under the last request its session submitted before the call started, whatever Stop cut the ledger's turn
// around it. The shape is the one a first general-case session recorded (synthetic here: names, ids and stamps are made up):
// a request launches an agent; the agent keeps calling after the turn's Stop; its completion wakes the session with a new prompt,
// which the hook stamps after those calls started. The ledger puts the calls after a Stop in the NEXT turn's op range, so the
// turn that ends at the wake's Stop holds calls that started before the wake was sent.

const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const ids = (r: { calls: Array<{ id: string }> }) => r.calls.map((c) => c.id);

/** Ledger op order of the shape: a call's op is written at its close; a turn's prompt op and Stop op are written at the Stop. */
function wakeShape() {
  return [
    // turn 1 (request A, stamp 1): two calls, Stop
    call("a1", { desc: "a1", at: 20, extra: { startSeq: 2 } }),
    call("a2", { desc: "a2", at: 40, extra: { startSeq: 4 } }),
    prompt("s1", ["Ask A."], stamp(1)),
    stop("s1", "A done."),
    // turn 2 (request B, stamp 10): launches an agent (b1), runs b2; Stop. The agent's calls g1, g2 run on after the Stop.
    call("b1", { tool: "Agent", desc: "launch", at: 120, extra: { startSeq: 11 } }),
    call("b2", { desc: "b2", at: 140, extra: { startSeq: 13 } }),
    prompt("s1", ["Ask B."], stamp(10)),
    stop("s1", "B launched."),
    call("g1", { desc: "agent work 1", at: 210, extra: { startSeq: 21 } }),
    call("g2", { desc: "agent work 2", at: 230, extra: { startSeq: 23 } }),
    // turn 3: the agent's completion wakes the session (stamp 30, after g1 and g2 started); its own calls follow
    call("w1", { tool: "Agent", desc: "launch again", at: 320, extra: { startSeq: 32 } }),
    prompt("s1", ["Agent finished."], stamp(30)),
    stop("s1", "Woke."),
    // the second agent's calls run after that Stop, and its completion wakes the session once more (stamp 50)
    call("h1", { desc: "agent two work 1", at: 410, extra: { startSeq: 41 } }),
    call("h2", { desc: "agent two work 2", at: 430, extra: { startSeq: 43 } }),
    call("x1", { desc: "after wake", at: 520, extra: { startSeq: 52 } }),
    prompt("s1", ["Agent two finished."], stamp(50)),
    stop("s1", "Woke again."),
  ];
}

describe("a call sits under the last request submitted before it started", () => {
  it("calls an agent made after the Stop stay with the request that launched it, not the wake that follows them", () => {
    const { requests } = buildRuns(wakeShape(), []);
    assert.deepEqual(requests.map((r) => [r.texts[0], ids(r)]), [
      ["Ask A.", ["a1", "a2"]],
      ["Ask B.", ["b1", "b2", "g1", "g2"]],
      ["Agent finished.", ["w1", "h1", "h2"]],
      ["Agent two finished.", ["x1"]],
    ]);
  });

  it("never places a call under a request stamped after the call started, and never gives a request a call that started before it", () => {
    const { requests } = buildRuns(wakeShape(), []);
    for (const r of requests) for (const c of r.calls) assert.ok(c.startSeq! > r.anchorSeq!, `${c.id} (${c.startSeq}) under the request stamped ${r.anchorSeq}`);
    const placed = requests.flatMap((r) => r.calls.map((c) => [c.id, r.anchorSeq] as const));
    for (const [id, anchor] of placed) {
      const start = requests.flatMap((r) => r.calls).find((c) => c.id === id)!.startSeq!;
      const later = requests.map((r) => r.anchorSeq!).filter((a) => a < start && a > anchor!);
      assert.deepEqual(later, [], `${id} skipped a request submitted before it started`);
    }
  });

  it("each turn's closing claim stays with the request whose turn the Stop ended", () => {
    const { requests } = buildRuns(wakeShape(), []);
    assert.deepEqual(requests.map((r) => r.closing?.text ?? null), ["A done.", "B launched.", "Woke.", "Woke again."]);
  });

  it("a call that started before the session's first stamped request has no request, and the first request does not take it", () => {
    const ops = [
      call("early", { desc: "early", at: 10, extra: { startSeq: 2 } }),
      call("late", { desc: "late", at: 90, extra: { startSeq: 8 } }),
      prompt("s1", ["First ask."], stamp(5)),
      stop("s1"),
    ];
    const { requests } = buildRuns(ops, []);
    const byText = (t: string) => requests.find((r) => r.texts[0] === t);
    assert.deepEqual(ids(byText("First ask.")!), ["late"]);
    const orphan = requests.find((r) => !r.captured)!;
    assert.deepEqual(ids(orphan), ["early"]);
    assert.equal(requests[0], orphan, "it sorts first, by its start");
  });

  it("sessions are placed separately: another session's request never takes this session's calls", () => {
    const ops = [
      call("a1", { session: "A", desc: "a1", at: 10, extra: { startSeq: 11 } }),
      call("b1", { session: "B", desc: "b1", at: 20, extra: { startSeq: 12 } }),
      call("a2", { session: "A", desc: "a2", at: 50, extra: { startSeq: 22 } }),
      prompt("A", ["A asks."], stamp(10)),
      prompt("B", ["B asks."], stamp(20)),
      stop("A"),
      stop("B"),
    ];
    const { requests } = buildRuns(ops, []);
    const of = (s: string) => requests.filter((r) => r.session === s).map((r) => [r.texts[0], ids(r)]);
    assert.deepEqual(of("A"), [["A asks.", ["a1", "a2"]]]);
    // B's request was stamped at 20: b1 started at 12, before it, so it has no request; a2 (22) is A's and stays A's.
    assert.deepEqual(of("B"), [[undefined, ["b1"]], ["B asks.", []]]);
  });

  it("a record without start stamps keeps the older, per-turn placement", () => {
    const ops = [
      call("c1", { desc: "c1", at: 10 }),
      call("c2", { desc: "c2", at: 30 }),
      prompt("s1", ["Only ask."], stamp(5)),
      stop("s1"),
    ];
    const { requests } = buildRuns(ops, []);
    assert.deepEqual(requests.map((r) => [r.texts[0], ids(r)]), [["Only ask.", ["c1", "c2"]]]);
  });

  it("a chat-only turn still makes no request", () => {
    const ops = [call("a1", { desc: "a1", at: 10, extra: { startSeq: 2 } }), prompt("s1", ["Ask."], stamp(1)), stop("s1"), stop("s1")];
    assert.equal(buildRuns(ops, []).requests.length, 1);
  });
});
