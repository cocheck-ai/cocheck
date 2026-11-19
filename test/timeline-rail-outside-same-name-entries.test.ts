import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// an outside file and an in-folder file with one file name are separate Files entries (the timeline body cuts an outside path to its bare name, so the key
// must say "outside"). The in-folder one is never flagged outside, whichever was written first. Outside files with one name in different directories stay one outside entry.

const W = "/w";
const sha = (c: string): string => c.repeat(64);

/** Each item is [path, writer id]; they are written in the order given. */
function build(writes: Array<[string, string]>): RailModel {
  const ops = [
    ...writes.map(([f, id], i) => call(id, { at: 10 + i * 5, end: 12 + i * 5, cmd: "python3 gen.py", named: [f], extra: { startSeq: 10 + i * 5 } })),
    prompt("s1", ["Make the numbers."], { requests: [{ seq: 1, at: 0, firstStep: null }] }),
    stop("s1", "done"),
  ];
  const fileStates = writes.map(([f, id], i) => state(f, sha("abcdef"[i]!), null, { open: [id], credited: [id] }));
  const input: TimelineInput = { taskId: 5, build: "t", ops, fileStates, folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}
const named = (m: RailModel, n: string) => m.files.filter((f) => f.name === n);

describe("an outside file and an in-folder file with one name", () => {
  const IN: [string, string] = [W + "/report.xlsx", "i1"], OUT: [string, string] = ["/tmp/x/report.xlsx", "o1"];
  for (const [label, order] of [["outside first", [OUT, IN]], ["in-folder first", [IN, OUT]]] as const) {
    it(`${label}: two entries, the in-folder one unflagged with its own strip`, () => {
      const m = build([...order]);
      const es = named(m, "report.xlsx");
      assert.equal(es.length, 2);
      const inside = es.filter((f) => !f.outside), out = es.filter((f) => f.outside);
      assert.equal(inside.length, 1);
      assert.equal(out.length, 1);
      assert.equal(inside[0]!.versions.length, 1);
      assert.equal(out[0]!.versions.length, 1);
      assert.equal(inside[0]!.versions[0]!.sha, sha(order[0] === IN ? "a" : "b"));
      assert.equal(inside[0]!.ref, undefined);
      assert.notEqual(out[0]!.ref, undefined);
    });
  }
  it("their hash addresses differ", () => {
    const es = named(build([IN, OUT]), "report.xlsx");
    assert.equal(new Set(es.map((f) => f.ref ?? f.file)).size, 2);
  });
});

describe("guarded case", () => {
  it("two outside files with one name in different directories never join an in-folder entry", () => {
    const m = build([["/tmp/a/report.xlsx", "o1"], [W + "/report.xlsx", "i1"], ["/tmp/b/report.xlsx", "o2"]]);
    const es = named(m, "report.xlsx");
    const inside = es.filter((f) => !f.outside);
    assert.equal(inside.length, 1);
    assert.equal(inside[0]!.versions.length, 1);
    assert.equal(es.filter((f) => f.outside).length, 1);
    assert.equal(es.filter((f) => f.outside)[0]!.versions.length, 2);
  });
  it("no in-folder file is ever marked outside, whatever is written beside it", () => {
    const m = build([["/tmp/a/data.csv", "o1"], [W + "/data.csv", "i1"], [W + "/sub/data.csv", "i2"], ["/tmp/b/memo.docx", "o2"], [W + "/memo.docx", "i3"]]);
    for (const f of m.files) if (f.versions.some((v) => v.sha === sha("b") || v.sha === sha("c") || v.sha === sha("e"))) assert.equal(f.outside, undefined, f.file);
  });
});
