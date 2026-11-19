import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// the calls that changed no watched file are not rail stops. Between two stops they ride on the earlier stop as one collapsed group
// (a count and each call's existing label); the page draws it as a quiet line, closed by default, with no keyboard stop.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, over: Record<string, unknown> = {}) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [], line: { text: `label ${id}`, source: "agent-description", label: "l" }, ...over });
const timeline = (calls: unknown[]) => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: calls.length, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls }] }] } as unknown as Timeline);

describe("calls that changed no file", () => {
  const model = buildRailModel(timeline([
    call("w1", 1, { changes: [change("c1", "a.xlsx", "w1")] }),
    call("q1", 2), call("q2", 3, { line: { text: "", source: "none", label: "" }, tool: "Read" }), call("q3", 4),
    call("w2", 5, { changes: [change("c2", "b.xlsx", "w2")] }),
  ]));
  const quietOf = (id: string) => (model.stops.find((s) => s.id === id) as unknown as { quiet?: { count: number; calls: Array<{ id: string; text: string }> } }).quiet;

  it("rides on the stop before them as one group with the count and each label, not as a stop", () => {
    assert.deepEqual(model.stops.map((s) => s.id), ["req-r0", "chg-c1", "chg-c2"]);
    const q = quietOf("chg-c1");
    assert.equal(q?.count, 3);
    // each call names its lane, so the page draws one quiet row per run of one actor's calls
    assert.deepEqual(q?.calls, [{ id: "q1", text: "label q1", lane: "claude" }, { id: "q2", text: "Read", lane: "claude" }, { id: "q3", text: "label q3", lane: "claude" }]);
    assert.equal(quietOf("chg-c2"), undefined);
  });

  // there is no start stop to ride on. Quiet calls before the first stop ride on the model itself, drawn at the origin marker;
  // none is dropped and none becomes a stop.
  it("before the first stop they ride on the model's origin, not on a stop and not dropped", () => {
    const tl = timeline([call("q0", 1), call("q00", 2), call("w1", 2000, { changes: [change("c1", "a.xlsx", "w1")] })]);
    tl.requests[0]!.at = 1000;
    const m = buildRailModel(tl) as unknown as { stops: Array<{ id: string; quiet?: unknown }>; quiet?: { count: number; calls: Array<{ id: string; text: string }> } };
    assert.deepEqual(m.stops.map((s) => s.id), ["req-r0", "chg-c1"]);
    assert.deepEqual(m.quiet, { count: 2, calls: [{ id: "q0", text: "label q0", lane: "claude" }, { id: "q00", text: "label q00", lane: "claude" }] });
    assert.ok(m.stops.every((s) => s.quiet === undefined));
    assert.equal(model.quiet, undefined, "a model whose quiet calls all follow a stop carries no origin group");
  });

  it("a failed call with no change keeps its own stop and is not counted", () => {
    const m = buildRailModel(timeline([call("q1", 1), call("f1", 2, { outcome: "failed", error: "boom" }), call("q2", 3)]));
    assert.ok(m.stops.some((s) => s.id === "fail-f1"));
    const all = m.stops.flatMap((s) => (s as unknown as { quiet?: { calls: Array<{ id: string }> } }).quiet?.calls.map((c) => c.id) ?? []);
    assert.deepEqual(all, ["q1", "q2"]);
  });

  it("the page draws it as a button that is not a step and reads the command only on an explicit open", async () => {
    const js = await readFile(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    assert.match(js, /\.quiet/);
    assert.match(js, /'\/command'/);
    // the quiet code is its own functions after buildRail; the block runs to the playhead's
    const block = js.slice(js.indexOf("Quiet calls:"), js.indexOf("function showCurrent"));
    assert.ok(block.length > 0);
    // the row is a button the keyboard reaches; it is never a step row, and the calls open in the main area, not in the rail
    assert.doesNotMatch(block, /class: 'row'/);
    assert.doesNotMatch(block, /tabindex: '-1'/);
    assert.doesNotMatch(block, /qlist/);
  });
});
