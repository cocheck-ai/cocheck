import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import type { CellSnapshot, SheetSnapshot, WorkbookSnapshot } from "../src/office/connector/xlsx/types.ts";

function cell(address: string, value: CellSnapshot["value"], formula: string | null = null, numFmt = "General"): CellSnapshot {
  return { address, value, formula, numFmt };
}
function sheet(name: string, cells: CellSnapshot[]): SheetSnapshot {
  return { name, cells: new Map(cells.map((c) => [c.address, c])) };
}
function workbook(...sheets: SheetSnapshot[]): WorkbookSnapshot {
  return { sheets };
}

describe("row-alignment: signature collisions (reviewer repro 1)", () => {
  it("does not confuse an edited cell for a delete+insert when the edit makes one row's content collide with another row's original content", () => {
    // before: A1=100, A2=200. after: A1=200, A2=200 - only A1 changed, but "row 2 unchanged"
    // and "row 1 now reads what row 2 always read" look identical from row 1's new content.
    const before = workbook(sheet("Sheet1", [cell("A1", 100), cell("A2", 200)]));
    const after = workbook(sheet("Sheet1", [cell("A1", 200), cell("A2", 200)]));
    const rows = diffWorkbooks(before, after);
    assert.deepEqual(rows, [
      {
        sheet: "Sheet1",
        cell: "A1",
        kind: "value",
        valueBefore: 100,
        valueAfter: 200,
        formulaBefore: null,
        formulaAfter: null,
        numFmtBefore: "General",
        numFmtAfter: "General",
      },
    ]);
  });
});

describe("row-alignment: duplicate rows", () => {
  it("aligns two identical rows across an inserted row between them, instead of colliding on their shared signature", () => {
    const before = workbook(
      sheet("Sheet1", [cell("A2", "Same"), cell("A3", "Same"), cell("A4", "Beta")]),
    );
    const after = workbook(
      sheet("Sheet1", [cell("A2", "Same"), cell("A3", "New"), cell("A4", "Same"), cell("A5", "Beta")]),
    );
    const rows = diffWorkbooks(before, after);
    assert.deepEqual(rows, [
      { sheet: "Sheet1", cell: "3:3", kind: "structure", note: "row inserted" },
      { sheet: "Sheet1", cell: "A3", kind: "value", valueBefore: null, valueAfter: "New", formulaBefore: null, formulaAfter: null, numFmtAfter: "General" },
    ]);
  });
});

describe("row-alignment: an edited row next to an inserted row", () => {
  it("pairs the shifted-and-edited row with its own history rather than with the newly inserted neighbor", () => {
    const before = workbook(
      sheet("Sheet1", [
        cell("A2", "Keep1"),
        cell("B2", 1),
        cell("A3", "Item3"),
        cell("B3", 10),
        cell("A4", "Keep2"),
        cell("B4", 1),
      ]),
    );
    const after = workbook(
      sheet("Sheet1", [
        cell("A2", "Keep1"),
        cell("B2", 1),
        cell("A3", "Inserted"),
        cell("B3", 99),
        cell("A4", "Item3"),
        cell("B4", 20),
        cell("A5", "Keep2"),
        cell("B5", 1),
      ]),
    );
    const rows = diffWorkbooks(before, after);
    assert.deepEqual(rows, [
      { sheet: "Sheet1", cell: "3:3", kind: "structure", note: "row inserted" },
      { sheet: "Sheet1", cell: "A3", kind: "value", valueBefore: null, valueAfter: "Inserted", formulaBefore: null, formulaAfter: null, numFmtAfter: "General" },
      { sheet: "Sheet1", cell: "B3", kind: "value", valueBefore: null, valueAfter: 99, formulaBefore: null, formulaAfter: null, numFmtAfter: "General" },
      {
        sheet: "Sheet1",
        cell: "B3->B4",
        kind: "value",
        valueBefore: 10,
        valueAfter: 20,
        formulaBefore: null,
        formulaAfter: null,
        numFmtBefore: "General",
        numFmtAfter: "General",
      },
    ]);
  });
});

describe("row-alignment: a deleted row plus an unrelated edit elsewhere", () => {
  it("resolves the deletion and the edit independently, each in its own gap between anchors", () => {
    const before = workbook(
      sheet("Sheet1", [
        cell("A2", "Keep1"),
        cell("A3", "ToDelete"),
        cell("A4", "Keep2"),
        cell("A5", "EditTarget"),
        cell("B5", 100),
        cell("A6", "Keep3"),
      ]),
    );
    const after = workbook(
      sheet("Sheet1", [
        cell("A2", "Keep1"),
        cell("A3", "Keep2"),
        cell("A4", "EditTarget"),
        cell("B4", 200),
        cell("A5", "Keep3"),
      ]),
    );
    const rows = diffWorkbooks(before, after);
    assert.deepEqual(rows, [
      { sheet: "Sheet1", cell: "3:3", kind: "structure", note: "row deleted" },
      { sheet: "Sheet1", cell: "A3", kind: "value", valueBefore: "ToDelete", valueAfter: null, formulaBefore: null, formulaAfter: null, numFmtBefore: "General" },
      {
        sheet: "Sheet1",
        cell: "B5->B4",
        kind: "value",
        valueBefore: 100,
        valueAfter: 200,
        formulaBefore: null,
        formulaAfter: null,
        numFmtBefore: "General",
        numFmtAfter: "General",
      },
    ]);
  });
});

describe("row-alignment: blank rows", () => {
  it("does not crash on a blank (formatting-only) row and reports nothing when nothing changed around it", () => {
    const before = workbook(sheet("Sheet1", [cell("A2", "X"), cell("C3", null), cell("A4", "Y")]));
    const after = workbook(sheet("Sheet1", [cell("A2", "X"), cell("C3", null), cell("A4", "Y")]));
    assert.deepEqual(diffWorkbooks(before, after), []);
  });
});

describe("row-alignment: whole-row references shift like cell references", () => {
  it("reports no formula change for a whole-row-ref formula whose own row and referenced row both shift by the same insert", () => {
    const before = workbook(
      sheet("Sheet1", [cell("A1", 1), cell("B2", 5, "SUM(3:3)"), cell("A3", 10)]),
    );
    const after = workbook(
      sheet("Sheet1", [cell("A1", 1), cell("A2", 77), cell("B3", 5, "SUM(4:4)"), cell("A4", 10)]),
    );
    const rows = diffWorkbooks(before, after);
    assert.deepEqual(rows, [
      { sheet: "Sheet1", cell: "2:2", kind: "structure", note: "row inserted" },
      { sheet: "Sheet1", cell: "A2", kind: "value", valueBefore: null, valueAfter: 77, formulaBefore: null, formulaAfter: null, numFmtAfter: "General" },
    ]);
  });
});

describe("row-alignment: sheet-qualified references survive a shift untouched", () => {
  it("does not report a formula change for a cell whose only formula reference is to another sheet, when the cell's own row shifts", () => {
    const before = workbook(
      sheet("Sheet1", [cell("A1", "Keep"), cell("B1", 42, "Sheet2!A1")]),
    );
    const after = workbook(
      sheet("Sheet1", [cell("A1", "Inserted"), cell("A2", "Keep"), cell("B2", 42, "Sheet2!A1")]),
    );
    const rows = diffWorkbooks(before, after);
    assert.deepEqual(rows, [
      { sheet: "Sheet1", cell: "1:1", kind: "structure", note: "row inserted" },
      { sheet: "Sheet1", cell: "A1", kind: "value", valueBefore: null, valueAfter: "Inserted", formulaBefore: null, formulaAfter: null, numFmtAfter: "General" },
    ]);
  });
});
