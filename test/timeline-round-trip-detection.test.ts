import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type Change, type Timeline } from "../src/timeline/timeline.ts";
import type { RawState } from "../src/timeline/runs.ts";

// A later step that undoes an earlier change says so, on both steps, in plain words (gdp.csv rounded, rebuilt
// unrounded by one call, rounded again by the next). Only a file that goes back to the exact bytes it had before is a round trip.

const sha = (c: string): string => c.repeat(64);
const ROUNDED = sha("a");
const RAW = sha("b");
const OTHER = sha("c");
let id = 0;
const st = (file: string, prev: string | null, now: string, step: number): RawState =>
  ({ id: ++id, step_id: step, task_id: 1, file_path: `/w/${file}`, sha256: now, prev_sha256: prev, phase: "post", calls_open_json: null, credited_json: null, size: 10, kept: "whole", note: null, ts: null } as unknown as RawState);

function build(rows: RawState[]): Change[] {
  const t: Timeline = buildTimeline({ taskId: 1, build: "t", ops: [], fileStates: rows, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
  return t.unplaced;
}
const byId = (cs: Change[], n: number): Change => cs.find((c) => c.id === `c${n}`)!;

describe("round trips", () => {
  it("rounded to unrounded to rounded: the first step is undone, the second restores, the net change is none", () => {
    id = 0;
    const rows = [st("base.csv", null, OTHER, 1), st("gdp.csv", null, ROUNDED, 1), st("gdp.csv", ROUNDED, RAW, 2), st("gdp.csv", RAW, ROUNDED, 3)];
    const cs = build(rows);
    const first = byId(cs, 3);
    const second = byId(cs, 4);
    assert.match(first.note.text, /\)\. The next change to this file undid this one\./);
    assert.doesNotMatch(first.note.text + second.note.text, /\bstep \d/);
    assert.match(second.note.text, /\)\. This puts the file back to how it was before the previous change to this file\./);
    assert.match(second.note.text, /net change.*none|ends as it began/i);
    assert.deepEqual(first.roundTrip, { role: "undone", with: "c4" });
    assert.deepEqual(second.roundTrip, { role: "restores", with: "c3" });
  });

  it("the same bytes reached from a different state is not a round trip", () => {
    id = 0;
    // h.csv: A to B, then C to A. The file ends as it began, but the second step did not start from where the first ended.
    const rows = [st("base.csv", null, OTHER, 1), st("h.csv", ROUNDED, RAW, 2), st("h.csv", OTHER, ROUNDED, 3)];
    const cs = build(rows);
    for (const c of cs) {
      assert.doesNotMatch(c.note.text, /undone by|restores the value/);
      assert.equal(c.roundTrip, undefined);
    }
  });

  it("another file with the same hashes is not linked", () => {
    id = 0;
    const rows = [st("base.csv", null, OTHER, 1), st("a.csv", ROUNDED, RAW, 2), st("b.csv", RAW, ROUNDED, 3)];
    for (const c of build(rows)) assert.equal(c.roundTrip, undefined);
  });

  it("a change in between breaks the long pair; only the adjacent one is named", () => {
    id = 0;
    const rows = [st("base.csv", null, OTHER, 1), st("g.csv", ROUNDED, RAW, 2), st("g.csv", RAW, OTHER, 3), st("g.csv", OTHER, RAW, 4), st("g.csv", RAW, ROUNDED, 5)];
    const cs = build(rows);
    assert.equal(byId(cs, 2).roundTrip, undefined);
    assert.equal(byId(cs, 5).roundTrip, undefined);
    assert.deepEqual(byId(cs, 3).roundTrip, { role: "undone", with: "c4" });
    assert.deepEqual(byId(cs, 4).roundTrip, { role: "restores", with: "c3" });
    assert.match(byId(cs, 5).note.text, /ends as it began/);
  });
});
