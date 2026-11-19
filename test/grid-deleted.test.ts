// the page draws no grid. A step whose document carries a `grid` picture (CoCheck's own, with
// its sheet in pictures[].private, windowed or whole-sheet) shows its changes in words: no sheet table, no live grid, no cell, no formula popover, no error.
// The page is the real review.js in the vm harness (test/helpers/connector-v1-page.ts), fed the document the serve boundary builds (test/helpers/v1-served.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { ALL_PAIRS, drivePage, modelOf } from "./helpers/connector-v1-page.ts";
import { served } from "./helpers/v1-served.ts";

const cell = (ref: string, text: string, extra: Record<string, unknown> = {}) => ({ ref, text, ...extra });
const sheet = (full: boolean, b3: string) => ({
  sheet: "Inputs", state: "visible", merges: [], moreRows: 0, ...(full ? { full: true, lastRow: 4 } : {}),
  columns: [{ name: "A", width: null, hidden: false }, { name: "B", width: 12, hidden: false }],
  rows: [
    { row: 3, hidden: false, cells: { A: cell("A3", "Rate"), B: cell("B3", b3, { formula: "=B2*2", value: Number(b3), look: { font: { bold: true }, fill: "FFFF00", align: {}, border: {} } }) } },
    { row: 4, hidden: false, cells: { A: cell("A4", "Total") } },
  ],
});
const gridView = (full: boolean) => ({
  kind: "grid",
  before: [{ id: "Inputs", label: "Inputs", grid: sheet(full, "10") }],
  after: [{ id: "Inputs", label: "Inputs", grid: sheet(full, "12") }],
  changes: [{ id: "k1", loc: "Inputs!B3", kind: "cell", parent: null, boxes: [{ side: "before", pane: "Inputs", cell: "B3" }, { side: "after", pane: "Inputs", cell: "B3" }] }],
});

for (const full of [false, true]) {
  describe(`a step with a ${full ? "whole-sheet" : "windowed"} grid picture shows its changes in words, never a drawn grid`, () => {
    it("no grid element, every change in the words list, no error", async () => {
      const doc = served(gridView(full), { rowNotes: [{ location: "Inputs!B3", text: "Claude changed Inputs!B3 from 10 to 12" }] });
      assert.deepEqual(checkChanges(doc), []);
      assert.ok(doc.pictures.some((p) => p.type === "grid"), "the document carries a grid picture");
      const pm = await modelOf(ALL_PAIRS.find((p) => p.name === "xlsx-value-edit")!);
      const cap = await drivePage(pm, async () => JSON.parse(JSON.stringify(doc)));
      assert.equal(cap.gridNodes, 0, "a grid element is drawn");
      assert.deepEqual(cap.hits, []);
      assert.deepEqual(cap.boxes, [], "a cell outline is drawn");
      // one words row per side the change has (before and after), both for the one change
      assert.deepEqual(cap.wordsIds, ["k1", "k1"], JSON.stringify(cap.wordsList));
      assert.ok(cap.wordsList.some((t) => /Inputs!B3/.test(t)), JSON.stringify(cap.wordsList));
      assert.ok(cap.wordsList.every((t) => t.length > 0));
      for (const side of ["before", "after"] as const) assert.doesNotMatch(cap.paneText[side], /error|could not|failed/i, side);
    });
  });
}
