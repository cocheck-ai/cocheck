import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import { numToCol, remapFormulaRows } from "../src/office/connector/xlsx/formula.ts";
import type { DiffRow, WorkbookSnapshot } from "../src/office/connector/xlsx/types.ts";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

function loadDiff(pairName: string): DiffRow[] {
  const before = readWorkbookSnapshot(readFileSync(`${fixturesDir}${pairName}-before.xlsx`));
  const after = readWorkbookSnapshot(readFileSync(`${fixturesDir}${pairName}-after.xlsx`));
  return diffWorkbooks(before, after);
}

type Cells = Array<[address: string, value: string | number | null, formula?: string]>;
function wb(sheets: Record<string, Cells>): WorkbookSnapshot {
  return {
    sheets: Object.entries(sheets).map(([name, cells]) => ({
      name,
      cells: new Map(cells.map(([address, value, formula]) => [address, { address, value, formula: formula ?? null, numFmt: "General" }])),
    })),
  };
}

const structure = (rows: DiffRow[]) => rows.filter((r) => r.kind === "structure");
const cellRows = (rows: DiffRow[], sheet: string) => rows.filter((r) => r.sheet === sheet && r.kind !== "structure");

describe("live column insert at Inputs!M (real Excel-saved pair)", () => {
  const rows = loadDiff("column-insert");

  it("reports exactly one structure row, Inputs M:M, column inserted", () => {
    const s = structure(rows);
    assert.equal(s.length, 1, JSON.stringify(s));
    assert.equal(s[0]!.sheet, "Inputs");
    assert.equal(s[0]!.cell, "M:M");
    assert.equal(s[0]!.note, "column inserted");
  });

  it("reports no value or formula rows for the cells the insert moved", () => {
    assert.deepEqual(cellRows(rows, "Inputs"), []);
    assert.equal(rows.length, 1);
  });
});

// Columns: A..E before; a column inserted at C shifts C..E to D..F.
const beforeGrid: Cells = [
  ["A1", "id"], ["B1", 10], ["C1", 20], ["D1", 30], ["E1", null, "B1+D1"],
  ["A2", "rate"], ["B2", 1], ["C2", 2], ["D2", 3], ["E2", null, "$D$2*2"],
];
const afterGrid: Cells = [
  ["A1", "id"], ["B1", 10], ["D1", 20], ["E1", 30], ["F1", null, "B1+E1"],
  ["A2", "rate"], ["B2", 1], ["D2", 2], ["E2", 3], ["F2", null, "$E$2*2"],
];

describe("synthetic column insert", () => {
  it("drops same-sheet formulas whose refs only moved with the inserted column", () => {
    const rows = diffWorkbooks(wb({ S: beforeGrid }), wb({ S: afterGrid }));
    assert.deepEqual(rows.map((r) => [r.cell, r.kind, r.note]), [["C:C", "structure", "column inserted"]]);
  });

  it("drops cross-sheet formulas whose refs only moved with the other sheet's inserted column", () => {
    const rows = diffWorkbooks(
      wb({ S: beforeGrid, T: [["A1", 30, "S!D1"], ["A2", 60, "SUM(S!C1:D1)"], ["A3", 1, "S!$B$2"]] }),
      wb({ S: afterGrid, T: [["A1", 30, "S!E1"], ["A2", 60, "SUM(S!D1:E1)"], ["A3", 1, "S!$B$2"]] }),
    );
    assert.deepEqual(rows.filter((r) => r.sheet === "T"), []);
    assert.equal(structure(rows).length, 1);
  });

  it("keeps a formula row when a shifted ref also changed for another reason", () => {
    const rows = diffWorkbooks(
      wb({ S: beforeGrid, T: [["A1", 30, "S!D1"]] }),
      wb({ S: afterGrid, T: [["A1", 60, "S!E1*2"]] }),
    );
    assert.equal(rows.filter((r) => r.sheet === "T" && r.kind === "formula").length, 1);
  });

  it("keeps a range that grew across the inserted column as a formula row", () => {
    const rows = diffWorkbooks(
      wb({ S: beforeGrid, T: [["A1", 60, "SUM(S!B1:D1)"]] }),
      wb({ S: afterGrid, T: [["A1", 60, "SUM(S!B1:E1)"]] }),
    );
    assert.equal(rows.filter((r) => r.sheet === "T" && r.kind === "formula").length, 1);
  });

  it("still reports a real value edit in a shifted column, at its new address", () => {
    const edited = afterGrid.map(([a, v, f]) => (a === "E2" ? ["E2", 99, f] : [a, v, f])) as Cells;
    const rows = diffWorkbooks(wb({ S: beforeGrid }), wb({ S: edited }));
    assert.deepEqual(rows.map((r) => [r.cell, r.kind]), [["C:C", "structure"], ["D2->E2", "value"]]);
  });
});

describe("synthetic column delete", () => {
  it("reports one structure row and the deleted column's cells, and drops refs that only moved", () => {
    const rows = diffWorkbooks(
      wb({ S: [["A1", 1], ["B1", 2], ["C1", 3], ["D1", 4], ["E1", 7, "D1+C1"], ["A2", "k"], ["B2", 5], ["C2", 6], ["D2", 8]], T: [["A1", 4, "S!D1"]] }),
      wb({ S: [["A1", 1], ["B1", 3], ["C1", 4], ["D1", 7, "C1+B1"], ["A2", "k"], ["B2", 6], ["C2", 8]], T: [["A1", 4, "S!C1"]] }),
    );
    const s = structure(rows);
    assert.deepEqual(s.map((r) => [r.sheet, r.cell, r.note]), [["S", "B:B", "column deleted"]]);
    assert.deepEqual(rows.filter((r) => r.sheet === "T"), []);
    assert.deepEqual(cellRows(rows, "S").map((r) => r.cell).sort(), ["B1", "B2"]);
  });
});

describe("column alignment stays conservative", () => {
  it("does not invent a column shift when one column's content is replaced by another's", () => {
    const rows = diffWorkbooks(
      wb({ S: [["A1", "k"], ["A2", "j"], ["N1", 1]] }),
      wb({ S: [["A1", "k"], ["A2", "j"], ["O2", 2]] }),
    );
    assert.equal(structure(rows).length, 0);
    assert.deepEqual(rows.map((r) => r.cell).sort(), ["N1", "O2"]);
  });

  it("handles a row insert and a column insert in the same save", () => {
    const before: Cells = [["A1", "h"], ["B1", 1], ["C1", 2], ["A2", "g"], ["B2", 3], ["C2", 4], ["A3", "t"], ["B3", null, "B1+B2"], ["C3", null, "C1+C2"]];
    const after: Cells = [["A1", "h"], ["C1", 1], ["D1", 2], ["A2", "new"], ["A3", "g"], ["C3", 3], ["D3", 4], ["A4", "t"], ["C4", null, "C1+C3"], ["D4", null, "D1+D3"]];
    const rows = diffWorkbooks(wb({ S: before }), wb({ S: after }));
    assert.deepEqual(structure(rows).map((r) => r.cell).sort(), ["2:2", "B:B"]);
    assert.deepEqual(cellRows(rows, "S").map((r) => r.cell), ["A2"]);
  });
});

describe("qualified ranges", () => {
  it("maps the unqualified end of a cross-sheet range through that sheet, not the formula's own", () => {
    const mapRow = (sheet: string, row: number) => (sheet === "A" && row >= 3 ? row + 1 : row);
    assert.equal(remapFormulaRows("SUM(A!B2:B4)+B4", "T", mapRow).text, "SUM(A!B2:B5)+B4");
  });
});

describe("live column insert inside a range other sheets reference (real Excel-saved pair)", () => {
  // Inputs!D inserted; IS/BS/CF reference Inputs C-E, so their formula text shifted too.
  const rows = loadDiff("column-insert-crosssheet");

  it("reports one structure row and no formula rows", () => {
    assert.deepEqual(structure(rows).map((r) => [r.sheet, r.cell, r.note]), [["Inputs", "D:D", "column inserted"]]);
    assert.deepEqual(rows.filter((r) => r.kind === "formula"), []);
  });
});

/**
 * R rows x 20 columns: A a label, B the row number, C..T either `r*c` (values) or the left
 * neighbour times 1.05 (formulas, so C's refs cross an insert at C). `insert` puts a new row at
 * R/2 (label "NEW", B 999) and a new empty column at C, shifted the way Excel shifts them.
 */
function grid(rowCount: number, formulas: boolean, insert: boolean): WorkbookSnapshot {
  const cells: Cells = [];
  const at = insert ? rowCount / 2 : Infinity;
  const col = (c: number) => numToCol(insert && c >= 3 ? c + 1 : c);
  for (let r0 = 1; r0 <= rowCount; r0++) {
    const r = r0 >= at ? r0 + 1 : r0;
    cells.push([`A${r}`, `label ${r0}`], [`B${r}`, r0]);
    for (let c = 3; c <= 20; c++) {
      cells.push(formulas ? [`${col(c)}${r}`, r0 * 1.05 ** (c - 2), `${col(c - 1)}${r}*1.05`] : [`${col(c)}${r}`, r0 * c]);
    }
  }
  if (insert) cells.push([`A${at}`, "NEW"], [`B${at}`, 999]);
  return wb({ S: cells });
}

describe("row insert and column insert in one save", () => {
  for (const rowCount of [300, 1000]) {
    for (const formulas of [false, true]) {
      it(`${rowCount} rows, ${formulas ? "left-neighbour formulas" : "values"}: two structure rows and the new row's cells`, () => {
        const rows = diffWorkbooks(grid(rowCount, formulas, false), grid(rowCount, formulas, true));
        const at = rowCount / 2;
        assert.deepEqual(structure(rows).map((r) => [r.cell, r.note]), [["C:C", "column inserted"], [`${at}:${at}`, "row inserted"]]);
        assert.deepEqual(cellRows(rows, "S").map((r) => r.cell), [`A${at}`, `B${at}`]);
      });
    }
  }
});

describe("deleting the last used column", () => {
  const base: Cells = [["A1", "k"], ["B1", 1], ["C1", 2], ["A2", "j"], ["B2", 3], ["C2", 4], ["A3", "i"], ["B3", 5], ["C3", 6]];

  it("reports it like deleting the last used row: a structure row plus the removed cells", () => {
    const lastRow = diffWorkbooks(wb({ S: base }), wb({ S: base.filter(([a]) => !a.endsWith("3")) }));
    assert.deepEqual(lastRow.map((r) => [r.cell, r.kind]), [["3:3", "structure"], ["A3", "value"], ["B3", "value"], ["C3", "value"]]);
    const lastCol = diffWorkbooks(wb({ S: base }), wb({ S: base.filter(([a]) => !a.startsWith("C")) }));
    assert.deepEqual(lastCol.map((r) => [r.cell, r.kind, r.note]), [
      ["C:C", "structure", "column deleted"],
      ["C1", "value", undefined],
      ["C2", "value", undefined],
      ["C3", "value", undefined],
    ]);
  });
});
