import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, observedAt } from "../src/timeline/rail/model.ts";
import { call, prompt, stop, state } from "./fixtures/timeline.ts";

// A change sits at the time it was observed, never at the start of a call that spans other observations; a change never sorts
// before the start of the call that made it. Synthetic records, as in the neighbouring timeline tests.

const W = "/w/";
const T0 = Date.parse("2026-10-11T10:00:00Z");
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const c = (id: string, seq: number, named: string[]) => call(id, { tool: "Edit", desc: id, at: T0 + seq * 10, named, extra: { startSeq: seq } });
const input = (ops: RawOp[], fileStates: RawState[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[]) => buildRailModel(buildTimeline(input(ops, fileStates)));
const made = (file: string, sha: string, call: string, step: number, ms: number): RawState[] => [{ ...state(W + file, sha, null, { open: [call], credited: [call], step }), ts: iso(ms) }];
const changeFiles = (m: ReturnType<typeof model>): string[] => m.stops.filter((s) => s.change).map((s) => s.change!.file);

describe("the shape of a recorded session", () => {
  // The memo call starts first and stays open across c19 and c20; its file is observed last.
  const ops = [prompt("s1", ["Ask."], { requests: [{ seq: 1, at: T0 + 1, firstStep: null }] }), c("memo", 2, [W + "memo.md"]), c("k19", 3, [W + "c19.txt"]), c("k20", 4, [W + "c20.txt"]), stop("s1", "done")];
  const states = [...made("c19.txt", "a", "k19", 2, 40), ...made("c20.txt", "b", "k20", 3, 50), ...made("memo.md", "m", "memo", 4, 60)];
  const m = model(ops, states);
  it("the memo comes after c19 and c20", () => {
    assert.deepEqual(changeFiles(m), ["/w/c19.txt", "/w/c20.txt", "/w/memo.md"].map((f) => f.replace("/w/", "")).map((f) => changeFiles(m).find((x) => x.endsWith(f))!));
    assert.ok(changeFiles(m).at(-1)!.endsWith("memo.md"));
  });
  it("c20's before-tree does not list the memo, and the memo's does list c19 and c20", () => {
    const rows = (file: string) => JSON.stringify(m.stops.find((s) => s.change?.file.endsWith(file))!.change!.treeBefore);
    assert.ok(!rows("c20.txt").includes("memo.md"));
    assert.ok(rows("memo.md").includes("c20.txt") && rows("memo.md").includes("c19.txt"));
  });
});

describe("one rule for every change", () => {
  it("a joint change keeps its own time", () => {
    assert.equal(observedAt({ at: 500 }, 100), 500);
  });
  it("a change with no time of its own takes the call's start; no call start takes its own time", () => {
    assert.equal(observedAt({ at: null }, 100), 100);
    assert.equal(observedAt({ at: 70 }, null), 70);
    assert.equal(observedAt({ at: null }, null), null);
  });
  it("a change never sorts before the start of the call that made it", () => {
    assert.equal(observedAt({ at: 50 }, 100), 100);
  });
  it("property: over random spans the result is never before the call start, and is the observed time when that is later", () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 2000; i++) {
      const start = rnd() < 0.2 ? null : Math.floor(rnd() * 1000);
      const at = rnd() < 0.2 ? null : Math.floor(rnd() * 1000);
      const got = observedAt({ at }, start);
      if (start !== null && got !== null) assert.ok(got >= start);
      if (at !== null && (start === null || at >= start)) assert.equal(got, at);
      if (at === null) assert.equal(got, start);
    }
  });
  it("ties keep today's order: two changes observed at the same time stay in record order", () => {
    const ops = [prompt("s1", ["Ask."], { requests: [{ seq: 1, at: T0 + 1, firstStep: null }] }), c("a", 2, [W + "a.txt"]), c("b", 3, [W + "b.txt"]), stop("s1", "done")];
    const states = [...made("a.txt", "a", "a", 2, 40), ...made("b.txt", "b", "b", 3, 40)];
    assert.deepEqual(changeFiles(model(ops, states)), ["a.txt", "b.txt"].map((f) => changeFiles(model(ops, states)).find((x) => x.endsWith(f))!));
  });
});
