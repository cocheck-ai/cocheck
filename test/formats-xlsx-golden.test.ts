import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

function loadDiff(pairName: string) {
  const before = readWorkbookSnapshot(readFileSync(`${fixturesDir}${pairName}-before.xlsx`));
  const after = readWorkbookSnapshot(readFileSync(`${fixturesDir}${pairName}-after.xlsx`));
  return diffWorkbooks(before, after);
}

function loadGolden(pairName: string) {
  return JSON.parse(readFileSync(`${fixturesDir}golden/${pairName}.json`, "utf-8"));
}

describe("xlsx reader + diff against real-Excel golden fixtures", () => {
  it("value-edit: reports the edited input and both downstream cached-value changes, nothing else", () => {
    assert.deepEqual(loadDiff("value-edit"), loadGolden("value-edit"));
  });

  it("formula-edit: reports the formula change on a single row, no shift involved", () => {
    assert.deepEqual(loadDiff("formula-edit"), loadGolden("formula-edit"));
  });

  it("inserted-row: reports one structure row plus the new row's cells, and the shifted total's formula change - not the untouched rows that merely moved", () => {
    const rows = loadDiff("inserted-row");
    assert.deepEqual(rows, loadGolden("inserted-row"));

    // The rows that only shifted (Gadget/Gizmo, whose formulas moved from B3*C3/B4*C4 to
    // B4*C4/B5*C5) must not appear at all - this is the whole point of row alignment.
    const cells = rows.map((r: { cell: string }) => r.cell);
    assert.ok(!cells.includes("B4"), "shifted Gadget row must not be reported");
    assert.ok(!cells.includes("D4"), "shifted Gadget formula must not be reported");
    assert.ok(!cells.includes("B5"), "shifted Gizmo row must not be reported");
    assert.ok(!cells.includes("D5"), "shifted Gizmo formula must not be reported");
  });
});
