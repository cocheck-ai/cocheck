import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromDiffObject, toDiffObject } from "../src/connector/diff-object.ts";
import type { FormatChanges, FormatRow } from "../src/timeline/timeline.ts";
import type { View } from "../src/timeline/render/types.ts";

// The shim keeps every field a rail row can carry. A row with label, note, styleText and cellsUnchanged (card is not a row field), and a view
// whose panes are not empty, go through toDiffObject and back deep-equal, and the DiffObject keeps one change per row.

const row: FormatRow = {
  location: "Summary!B3", kind: "value", before: "10", after: "12", text: "B3 changed from 10 to 12",
  label: "Revenue", note: { text: "Revenue went from 10 to 12.", source: "rule" },
  styleText: "turned bold", cellsUnchanged: true,
};
const other: FormatRow = { location: "Summary!C4", kind: "formula", before: null, after: "=B3*2", text: "C4 got a formula" };
const fc: FormatChanges = { module: "xlsx", rows: [row, other], more: 3, moreIn: [{ place: "Detail", count: 3 }] as never, identicalParts: true };
const view: View = {
  change: "c1", file: "/work/model.xlsx", engine: "CoCheck", kind: "grid", boxes: [], caveats: ["drawn from stored cells"],
  before: [{ id: "before:Summary", label: "Before", text: { lines: [{ n: 1, text: "ten", kind: "edit", marks: [[0, 3]] }, { gap: true, hidden: 4 }, { filler: true }] }, note: "pane note" }],
  after: [{ id: "after:Summary", label: "After", text: { lines: [{ n: 1, text: "twelve", kind: "edit", marks: [[0, 6]] }] } }],
  changes: [{ id: "k1", loc: "Summary!B3", kind: "cell", parent: null, boxes: [{ side: "after", pane: "after:Summary", cell: "B3" }], lines: ["1 formula cell recalculated"] }],
};

describe("round trip: a fully loaded row and view survive the shim", () => {
  it("rows carrying label, note, styleText and cellsUnchanged come back unchanged", () => {
    const d = toDiffObject("/work/model.xlsx", "xlsx", fc);
    assert.deepEqual(fromDiffObject(d), { changes: fc, view: null });
    assert.equal(d.changes.length, 2);
  });
  it("with a view whose panes are non-empty, the pair comes back unchanged and pane text is not shared by reference", () => {
    const d = toDiffObject("/work/model.xlsx", "xlsx", fc, view);
    const back = fromDiffObject(d);
    assert.deepEqual(back, { changes: fc, view });
    assert.notEqual(back.view!.before, view.before, "a copy, so a later edit of the object cannot move the original");
    assert.equal(back.view!.before[0]!.text!.lines.length, 3);
    assert.equal(d.changes[0]!.builtin!.view!.id, "k1", "the view entry rides on the row that names its location");
  });
});
