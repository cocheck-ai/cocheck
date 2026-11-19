import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, plainLines } from "../src/timeline/rail/model.ts";
import { summarize } from "../src/timeline/rail/stop-status.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// a message card holds no markdown syntax (tables and fences included), and a reply step changes no step or verdict count the page uses.

const W = "/w/";
const c = (id: string, seq: number, named: string[] = []) => call(id, { session: "s1", tool: "Edit", desc: id, at: seq * 10, named, extra: { startSeq: seq } });
const input = (ops: RawOp[], fileStates: RawState[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const stopAt = (text: string | null, at: number): RawOp => {
  const o = stop("s1", text);
  return { ...o, args_json: JSON.stringify({ ...JSON.parse(o.args_json as string), at }) };
};
const REPLY = ["Here is the result.", "", "| Slide | Title |", "| --- | :---: |", "| 1 | **Intro** |", "| 2 | `Plan` |", "", "```ts", "const n = 8; // **not bold**", "```", "Done."].join("\n");
const ops = (reply: string | null): RawOp[] => [
  prompt("s1", ["Make the deck."], { requests: [{ seq: 1, at: 10, firstStep: null }] }),
  c("c1", 2, [W + "a.txt"]), c("c2", 3, [W + "b.txt"]),
  stopAt(reply, 100),
];
const states: RawState[] = [state(W + "a.txt", "a0", null, { step: 1 }), state(W + "a.txt", "a1", "a0", { open: ["c1"], credited: ["c1"], step: 2 }), state(W + "b.txt", "b0", null, { step: 1 }), state(W + "b.txt", "b1", "b0", { open: ["c2"], credited: ["c2"], step: 3 })];
const timeline = (reply: string | null) => buildTimeline(input(ops(reply), states));

describe("plain message cards", () => {
  it("a table reads as cells joined by a dot and a fence keeps its code lines", () => {
    assert.deepEqual(plainLines(REPLY.split("\n")), ["Here is the result.", "Slide · Title", "1 · Intro", "2 · Plan", "const n = 8; // **not bold**", "Done."]);
  });
  it("the reply step holds no pipe, fence or markdown mark", () => {
    const m = buildRailModel(timeline(REPLY));
    const lines = m.stops.find((s) => s.id.startsWith("reply-"))!.message!.lines;
    assert.deepEqual(lines, ["Here is the result.", "Slide · Title", "1 · Intro", "2 · Plan", "const n = 8; // **not bold**", "Done."]);
    assert.ok(lines.every((l) => !l.includes("|") && !l.includes("```") && !l.includes("`")));
  });
});

describe("a reply step changes no count", () => {
  it("steps that take a verdict, verdict counts, blocking and eligibility are the same with and without a reply", () => {
    const [withR, without] = [buildRailModel(timeline(REPLY)), buildRailModel(timeline(null))];
    assert.ok(withR.stops.some((s) => s.id.startsWith("reply-")) && !without.stops.some((s) => s.id.startsWith("reply-")));
    const reviewable = (m: typeof withR) => m.stops.filter((s) => s.change).map((s) => s.id);
    assert.deepEqual(reviewable(withR), reviewable(without));
    assert.equal(reviewable(withR).length, 2);
    assert.equal(withR.stops.length, without.stops.length + 1);
    const a = summarize(withR, timeline(REPLY), []), b = summarize(without, timeline(null), []);
    const onChanges = (m: typeof withR, s: typeof a) => m.stops.filter((x) => x.change).map((x) => s.stops[x.id]!.status);
    assert.deepEqual(onChanges(withR, a), onChanges(without, b));
    assert.deepEqual([a.submit.blocking, a.submit.eligible, a.anyFailed], [b.submit.blocking, b.submit.eligible, b.anyFailed]);
    // The reply is an unreviewed step like a request is: it adds exactly one to the not-reviewed list, and nothing to passed or failed.
    assert.equal(a.counts.passed, b.counts.passed);
    assert.equal(a.counts.failed, b.counts.failed);
    assert.equal(a.counts.not_reviewed, b.counts.not_reviewed + 1);
  });
});
