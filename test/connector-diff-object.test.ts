import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PAIRS, readGold, type ViewCapture } from "./helpers/connector-migration.ts";
import { fromDiffObject, toDiffObject, type DiffChange } from "../src/connector/diff-object.ts";
import type { FormatChanges, FormatRow } from "../src/timeline/timeline.ts";
import type { View, ViewChange } from "../src/timeline/render/types.ts";

/*
 * DiffObject and its lossless shim from today's FormatChanges and View. The goldens are captures, not the types themselves, so a G1 case
 * becomes FormatChanges ({module: layer, rows, more: 0}) and a G2 case becomes a View (panes empty, the captured boxes and caveats kept).
 */
const g1 = readGold<Record<string, { layer: string; rows: unknown[] }>>("g1-layer-rows.json");
const g2 = readGold<Record<string, ViewCapture>>("g2-renderer-views.json");

const fcOf = (name: string): FormatChanges => ({ module: g1[name]!.layer, rows: g1[name]!.rows as FormatRow[], more: 0 });
const viewOf = (v: ViewCapture): View => ({ change: "c1", file: "/work/f", engine: v.engine as string, kind: "grid", before: [], after: [], boxes: v.boxes as View["boxes"], changes: v.changes as ViewChange[], caveats: v.caveats });
const emptyFc: FormatChanges = { module: "m", rows: [], more: 0 };
const publicOf = (c: DiffChange) => { const { builtin: _b, ...rest } = c; return rest; };
const row = (location: string, over: Partial<FormatRow> = {}): FormatRow => ({ location, kind: "value", before: "a", after: "b", text: `${location} changed`, ...over });
const vc = (id: string, loc: string | null, over: Partial<ViewChange> = {}): ViewChange => ({ id, loc, kind: "cell", parent: null, boxes: [{ side: "after", pane: "after:S", cell: "B3" }], ...over });

describe("round trip: fromDiffObject(toDiffObject(x)) deep-equals x", () => {
  for (const p of PAIRS) it(`${p.name}: G1 rows`, () => {
    const fc = fcOf(p.name);
    const d = toDiffObject("f", "xlsx", fc);
    assert.deepEqual(fromDiffObject(d), { changes: fc, view: null });
    assert.equal(d.changes.length, (fc as { rows: unknown[] }).rows.length, "no row dropped");
  });
  for (const p of PAIRS) it(`${p.name}: G2 view with every ViewChange field`, () => {
    const v = viewOf(g2[p.name]!);
    const d = toDiffObject("f", p.format, emptyFc, v);
    assert.deepEqual(fromDiffObject(d), { changes: emptyFc, view: v });
    assert.equal(d.changes.length, v.changes!.length, "no view change dropped");
  });
  for (const p of PAIRS.filter((x) => x.format === "xlsx")) it(`${p.name}: G1 rows and G2 view together`, () => {
    const fc = fcOf(p.name), v = viewOf(g2[p.name]!);
    assert.deepEqual(fromDiffObject(toDiffObject("f", "xlsx", fc, v)), { changes: fc, view: v });
  });
  it("more, moreIn, identicalParts and unavailable survive", () => {
    const fc: FormatChanges = { module: "xlsx", rows: [row("S!A1")], more: 7, moreIn: [{ place: "S", count: 7, from: 2, to: 9 }], identicalParts: true };
    const d = toDiffObject("f", "x", fc);
    assert.equal(d.more, 7);
    assert.deepEqual(fromDiffObject(d), { changes: fc, view: null });
    const un: FormatChanges = { unavailable: "values expired" };
    const du = toDiffObject("f", "x", un);
    assert.equal(du.unavailable, "values expired");
    assert.deepEqual(fromDiffObject(du), { changes: un, view: null });
  });
  it("a view with no change list and a null-loc change round trip", () => {
    const bare: View = { change: "c", file: "f", engine: "e", kind: "pages", before: [], after: [], boxes: [], caveats: ["c1"] };
    assert.deepEqual(fromDiffObject(toDiffObject("f", "x", emptyFc, bare)), { changes: emptyFc, view: bare });
    const px: View = { ...bare, changes: [vc("k1", null, { kind: "picture", label: "Something changed on page 3", boxes: [], unplaced: { before: "not marked" }, lines: ["x"] })] };
    assert.deepEqual(fromDiffObject(toDiffObject("f", "x", emptyFc, px)), { changes: emptyFc, view: px });
  });
});

describe("must not: nothing dropped or reordered", () => {
  it("duplicate locations, a view order that differs from the row order, and rows without a view entry all keep count and order", () => {
    const fc: FormatChanges = { module: "m", rows: [row("A"), row("B"), row("A", { after: "c" }), row("C")], more: 0 };
    const v: View = { change: "c", file: "f", engine: "e", kind: "grid", before: [], after: [], boxes: [], caveats: [], changes: [vc("k1", "C"), vc("k2", "A"), vc("k3", null, { kind: "picture" }), vc("k4", "A")] };
    const d = toDiffObject("f", "x", fc, v);
    const back = fromDiffObject(d);
    assert.deepEqual(back, { changes: fc, view: v });
    assert.equal(d.changes.length, 5, "4 rows + 1 view change with no row");
  });
  it("the view change and its row share one DiffChange", () => {
    const d = toDiffObject("f", "x", { module: "m", rows: [row("S!B3")], more: 0 }, { change: "c", file: "f", engine: "e", kind: "grid", before: [], after: [], boxes: [], caveats: [], changes: [vc("k1", "S!B3")] });
    assert.equal(d.changes.length, 1);
    assert.equal(d.changes[0]!.builtin!.row!.location, "S!B3");
    assert.equal(d.changes[0]!.builtin!.view!.id, "k1");
  });
});

describe("the public shape", () => {
  const all = [...PAIRS.map((p) => toDiffObject("f", p.format, fcOf(p.name), p.format === "xlsx" ? viewOf(g2[p.name]!) : null)), ...PAIRS.map((p) => toDiffObject("f", p.format, emptyFc, viewOf(g2[p.name]!)))];
  it("each DiffChange without builtin carries no extra key", () => {
    let n = 0;
    for (const d of all) {
      const pub = d.changes.map(publicOf);
      for (const c of pub) { n++; assert.deepEqual(Object.keys(c).filter((k) => !["anchors", "kind", "confidence", "before", "after", "note"].includes(k)), []); }
    }
    assert.ok(n > 10);
  });
  it("anchors carry the row location as label and the cell as entity; a change with no row is derived, layer rows exact", () => {
    const d = toDiffObject("f", "xlsx", { module: "xlsx", rows: [row("Sheet1!D5")], more: 0 }, { change: "c", file: "f", engine: "e", kind: "grid", before: [], after: [], boxes: [], caveats: [], changes: [vc("k1", "Sheet1!D5", { boxes: [{ side: "after", pane: "after:Sheet1", cell: "D5" }] }), vc("k2", null, { kind: "picture", boxes: [], label: "Something changed on page 3" })] });
    assert.deepEqual(d.changes[0]!.anchors, [{ label: "Sheet1!D5", entity: "D5" }]);
    assert.equal(d.changes[0]!.confidence, "exact");
    assert.equal(d.changes[1]!.anchors[0]!.label, "Something changed on page 3");
    assert.equal(d.changes[1]!.confidence, "derived");
  });
  it("payloads are text for strings and json for non-strings; null stays null", () => {
    const d = toDiffObject("f", "x", { module: "m", rows: [row("A", { before: null, after: "x" }), { ...row("B"), before: { formula: "SUM(A1)", value: 1 } as never, after: 4 as never }], more: 0 });
    assert.equal(d.changes[0]!.before, null);
    assert.deepEqual(d.changes[0]!.after, { type: "text", value: "x" });
    assert.deepEqual(d.changes[1]!.before, { type: "json", value: { formula: "SUM(A1)", value: 1 } });
    assert.deepEqual(d.changes[1]!.after, { type: "json", value: 4 });
  });
  it("top-level fields", () => {
    const d = toDiffObject("sub", "conn", emptyFc);
    assert.deepEqual({ ...d, builtin: undefined }, { spec: "cocheck.diff/1", subject: "sub", connector: "conn", producer: "builtin", before: { ref: null }, after: { ref: null }, changes: [], caveats: [], more: 0, builtin: undefined });
  });
});
