// The page pairs pictures by their v1.1 `group`: one row per (set, place), the k-th picture of a set on each side by `order`. Must not
// happen: a before picture shown beside an after picture of another set. Pure: view-table.js is loaded the way the browser loads it.
import assert from "node:assert/strict";
import { test } from "node:test";

await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
interface Pane { id: string; label?: string; group?: string; order?: number; seq?: number; absent?: true; picture?: { sha: string; width: number; height: number; cpic: boolean } }
interface Row { before: Pane | null; after: Pane | null; group?: string }
const VT = (globalThis as unknown as { CoCheckViewTable: { groupedRows(b: Pane[], a: Pane[]): Row[]; sceneOf(doc: unknown): { kind: string; before: Pane[]; after: Pane[] } } }).CoCheckViewTable;

const SHA = "a".repeat(64);
const pic = (id: string, side: string, group?: string, order?: number) => ({ id, side, type: "image", src: `cpic/${SHA}`, width: 100, height: 50, label: id, ...(group !== undefined ? { group } : {}), ...(order !== undefined ? { order } : {}) });
const source = { by: "connector", name: "toy", level: 2 };

test("sceneOf carries group and order onto panes and draws grouped connector pictures as paired pages", () => {
  const s = VT.sceneOf({ source, changes: [], pictures: [pic("b1", "before", "g1", 0), pic("a1", "after", "g1", 0), pic("a2", "after", "g1", 1)] });
  assert.equal(s.kind, "pages");
  assert.deepEqual(s.after.map((p) => [p.id, p.group, p.order]), [["a1", "g1", 0], ["a2", "g1", 1]]);
  // invalid values are not carried
  const bad = VT.sceneOf({ source, changes: [], pictures: [{ ...pic("b1", "before"), group: 3, order: -1 }] });
  assert.equal(bad.before[0]!.group, undefined);
  assert.equal(bad.before[0]!.order, undefined);
});

test("rows pair by set and place, never across sets (the guarded case), sets in the document's order", () => {
  // set a: 1 before + 2 after; set b: 2 before + 0 after; listed out of order and interleaved on purpose
  const doc = { source, changes: [], pictures: [pic("a-after-1", "after", "a", 1), pic("b-before-0", "before", "b", 0), pic("a-before-0", "before", "a", 0), pic("b-before-1", "before", "b", 1), pic("a-after-0", "after", "a", 0)] };
  const s = VT.sceneOf(doc);
  const rows = VT.groupedRows(s.before, s.after);
  assert.deepEqual(rows.map((r) => [r.group, r.before?.id ?? null, r.after?.id ?? null]), [
    ["a", "a-before-0", "a-after-0"],
    ["a", null, "a-after-1"],
    ["b", "b-before-0", null],
    ["b", "b-before-1", null],
  ]);
  for (const r of rows) for (const p of [r.before, r.after]) if (p) assert.equal(p.group, r.group, `${p.id} sits in the row of its own set`);
});

test("pictures without a set come after the sets, paired by position; ties in order keep the document's order", () => {
  const s = VT.sceneOf({ source, changes: [], pictures: [pic("x-b", "before"), pic("g-b2", "before", "g", 0), pic("g-a", "after", "g", 0), pic("g-b1", "before", "g", 0), pic("x-a", "after")] });
  assert.deepEqual(VT.groupedRows(s.before, s.after).map((r) => [r.group ?? null, r.before?.id ?? null, r.after?.id ?? null]), [
    ["g", "g-b2", "g-a"],
    ["g", "g-b1", null],
    [null, "x-b", "x-a"],
  ]);
});

test("a document without group draws exactly as before (paged only by page numbers)", () => {
  const s = VT.sceneOf({ source, changes: [], pictures: [pic("b1", "before"), pic("a1", "after")] });
  assert.equal(s.kind, "card");
});
