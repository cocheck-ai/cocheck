import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import { remapFormulaRows } from "../src/office/connector/xlsx/formula.ts";
import type { DiffRow, WorkbookSnapshot } from "../src/office/connector/xlsx/types.ts";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

function loadDiff(pairName: string): DiffRow[] {
  const before = readWorkbookSnapshot(readFileSync(`${fixturesDir}${pairName}-before.xlsx`));
  const after = readWorkbookSnapshot(readFileSync(`${fixturesDir}${pairName}-after.xlsx`));
  return diffWorkbooks(before, after);
}

function count(rows: DiffRow[], sheet: string, kind: string): number {
  return rows.filter((r) => r.sheet === sheet && r.kind === kind).length;
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

describe("live case: row insert plus appended block on the saas model (real Excel-saved pair)", () => {
  const rows = loadDiff("shifted-crosssheet");

  it("reports exactly one structure row, the inserted Inputs row", () => {
    const structure = rows.filter((r) => r.kind === "structure");
    assert.equal(structure.length, 1);
    assert.equal(structure[0]!.sheet, "Inputs");
    assert.equal(structure[0]!.cell, "10:10");
  });

  it("reports the 40x5 block H30:L69 as 200 plain new cells", () => {
    const block = rows.filter((r) => {
      if (r.sheet !== "Inputs" || r.kind === "structure") return false;
      const m = /^([H-L])([0-9]+)$/.exec(r.cell);
      return m !== null && Number(m[2]) >= 30 && Number(m[2]) <= 69;
    });
    assert.equal(block.length, 200);
  });

  it("reports no formula rows on IS/BS/CF: their Inputs refs only moved with the inserted row", () => {
    for (const sheet of ["IS", "BS", "CF"]) {
      assert.equal(count(rows, sheet, "formula"), 0, `${sheet} formula rows`);
    }
  });
});

describe("pure-shift formula detection", () => {
  it("drops a cross-sheet ref that only moved because the target sheet gained a row", () => {
    const before = wb({ A: [["A1", 1], ["A2", 2], ["A3", 3]], B: [["B1", 2, "A!A2*1"]] });
    const after = wb({ A: [["A1", 1], ["A2", 9], ["A3", 2], ["A4", 3]], B: [["B1", 2, "A!A3*1"]] });
    const rows = diffWorkbooks(before, after);
    assert.equal(rows.filter((r) => r.sheet === "B").length, 0);
    assert.equal(rows.filter((r) => r.kind === "structure").length, 1);
  });

  it("keeps a formula row when a shifted ref also changed for another reason", () => {
    const before = wb({ A: [["A1", 1], ["A2", 2], ["A3", 3]], B: [["B1", 2, "A!A2*1"]] });
    const after = wb({ A: [["A1", 1], ["A2", 9], ["A3", 2], ["A4", 3]], B: [["B1", 2, "A!A2*2"]] });
    const rows = diffWorkbooks(before, after);
    assert.equal(count(rows, "B", "formula"), 1);
  });

  it("does not treat a range that grew across an insert as a pure shift", () => {
    assert.equal(remapFormulaRows("SUM(D2:D4)", "S", (_s, r) => (r >= 3 ? r + 1 : r)).spanPreserved, false);
    assert.equal(remapFormulaRows("SUM(D5:D9)", "S", (_s, r) => (r >= 3 ? r + 1 : r)).spanPreserved, true);
    assert.equal(remapFormulaRows("SUM(D5:D9)", "S", (_s, r) => (r >= 3 ? r + 1 : r)).text, "SUM(D6:D10)");
  });

  it("qualifies refs by sheet and leaves string literals alone", () => {
    const mapRow = (sheet: string, r: number) => (sheet === "My Sheet" ? r + 2 : r);
    assert.equal(remapFormulaRows(`'My Sheet'!$C$10+C10+"C10"`, "Own", mapRow).text, `'My Sheet'!$C$12+C10+"C10"`);
  });
});

describe("rows appended below the previous last row", () => {
  it("are plain new cells, not a structure row", () => {
    const before = wb({ S: [["A1", 1], ["A2", 2]] });
    const after = wb({ S: [["A1", 1], ["A2", 2], ["A3", 3], ["A4", 4]] });
    const rows = diffWorkbooks(before, after);
    assert.equal(rows.filter((r) => r.kind === "structure").length, 0);
    assert.deepEqual(rows.map((r) => r.cell), ["A3", "A4"]);
  });
});

describe("case (j): a row and a column deleted on one sheet in one save", () => {
  // Dense 16x3 sheet T; the save deletes row 1 and column A. T!B5 lands at T!A4.
  const dense = (rowFrom: number, colFrom: number): Cells => {
    const cells: Cells = [];
    for (let r = rowFrom; r <= 16; r++) for (let c = colFrom; c <= 3; c++) cells.push([`${"ABC"[c - 1]}${r}`, r * 100 + c]);
    return cells;
  };
  const shiftedT = (): Cells => {
    const cells: Cells = [];
    for (let r = 2; r <= 16; r++) for (let c = 2; c <= 3; c++) cells.push([`${"ABC"[c - 2]}${r - 1}`, r * 100 + c]);
    return cells;
  };
  const before = () => wb({ S: [["B1", 1005 * 2, "T!B5*2"]], T: dense(1, 1) });

  it("reports one formula row for S!B1 =T!B5*2 kept by hand", () => {
    const rows = diffWorkbooks(before(), wb({ S: [["B1", 1005 * 2, "T!B5*2"]], T: shiftedT() }));
    assert.equal(count(rows, "S", "formula"), 1);
  });

  it("reports no formula row for Excel's own rewrite =T!A4*2", () => {
    const rows = diffWorkbooks(before(), wb({ S: [["B1", 1005 * 2, "T!A4*2"]], T: shiftedT() }));
    assert.equal(count(rows, "S", "formula"), 0);
  });
});
