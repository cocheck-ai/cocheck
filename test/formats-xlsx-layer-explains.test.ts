import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import type { LayerDiffRow, LayerOp } from "../src/formats/layer.ts";
import type { DiffRow } from "../src/office/connector/xlsx/types.ts";
import { hookCell, hookOp } from "./helpers/hook-cell-op.ts";

const FILE = "/tmp/book.xlsx";
const layer = createXlsxLayer({ openState: async () => "closed" });

function row(d: DiffRow): LayerDiffRow {
  return { location: `${d.sheet}!${d.cell}`, kind: d.kind, before: null, after: null, derivable: false, detail: { ...d } };
}
const cell = (sheet: string, address: string) => row({ sheet, cell: address, kind: "value", valueBefore: 1, valueAfter: 2 });
const inserted = (sheet: string, r: number) => row({ sheet, cell: `${r}:${r}`, kind: "structure", note: "row inserted" });

describe("xlsx layer explains: a hook op's recorded cells", () => {
  it("touches and explains its recorded sheet and cell, nothing else", () => {
    const o = hookOp(1, FILE, [hookCell("Data", "A1", 2)]);
    assert.equal(layer.explains(o, FILE, cell("Data", "A1")), true);
    assert.equal(layer.explains(o, FILE, cell("Other", "A1")), false);
    assert.equal(layer.explains(o, FILE, cell("Data", "A2")), false);
    assert.equal(layer.touches(o, FILE, cell("Other", "A1")), false);
    assert.equal(layer.touches(o, "/tmp/other.xlsx", cell("Data", "A1")), false);
  });

  it("an op that recorded no cells touches nothing", () => {
    const o = hookOp(1, FILE, []);
    assert.equal(layer.touches(o, FILE, cell("Sheet1", "A1")), false);
    assert.equal(layer.explains(o, FILE, cell("Sheet1", "A1")), false);
  });

  it("explains every cell it recorded, each against its own hash", () => {
    const o = hookOp(1, FILE, [hookCell("S", "B2", 1), hookCell("S", "C2", "x"), hookCell("S", "B3", 4, "A1*2"), hookCell("S", "C3", null)]);
    const valueRow = (address: string, valueAfter: DiffRow["valueAfter"]) =>
      row({ sheet: "S", cell: address, kind: "value", valueBefore: 1, valueAfter });
    assert.equal(layer.explains(o, FILE, valueRow("B2", 1)), true);
    assert.equal(layer.explains(o, FILE, valueRow("C2", "x")), true);
    assert.equal(layer.explains(o, FILE, row({ sheet: "S", cell: "B3", kind: "formula", valueBefore: 1, valueAfter: 4, formulaBefore: "A1", formulaAfter: "A1*2" })), true);
    assert.equal(layer.explains(o, FILE, valueRow("C3", null)), true);
    assert.equal(layer.explains(o, FILE, valueRow("B2", "x")), false, "C2's value in B2 is not what B2 got");
    assert.equal(layer.explains(o, FILE, valueRow("C2", "y")), false);
    assert.equal(layer.touches(o, FILE, valueRow("C2", "y")), true);
  });

  it("explains a cell only when the after-value is what the hook saw", () => {
    const valueRow = (valueAfter: DiffRow["valueAfter"]) => row({ sheet: "S", cell: "A1", kind: "value", valueBefore: 1, valueAfter });
    const o = hookOp(1, FILE, [hookCell("S", "A1", 10)]);
    assert.equal(layer.explains(o, FILE, valueRow(10)), true);
    assert.equal(layer.explains(o, FILE, valueRow(10.000000000000002)), true, "float noise past 15 digits tolerated");
    assert.equal(layer.explains(o, FILE, valueRow(10.0000000000001)), false, "a 15th-digit difference is real");
    assert.equal(layer.touches(o, FILE, valueRow(666)), true);
    assert.equal(layer.explains(o, FILE, valueRow(666)), false);
  });

  it("compares formula text the way the reader emits it", () => {
    const formulaRow = (formulaAfter: string) =>
      row({ sheet: "S", cell: "A1", kind: "formula", valueBefore: 1, valueAfter: 4, formulaBefore: "A1", formulaAfter });
    const o = hookOp(1, FILE, [hookCell("S", "A1", 4, "=sum( b1:b2 )")]);
    assert.equal(layer.explains(o, FILE, formulaRow("SUM(B1:B2)")), true);
    assert.equal(layer.explains(o, FILE, formulaRow("SUM(B1:B3)")), false);
  });

  it("a structure row it recorded is explained by touching; one it did not record is not touched", () => {
    const o = hookOp(1, FILE, [hookCell("S", "3:3", null)]);
    assert.equal(layer.explains(o, FILE, inserted("S", 3)), true);
    assert.equal(layer.touches(o, FILE, inserted("S", 5)), false);
    assert.equal(layer.touches(o, FILE, inserted("T", 3)), false);
  });
});

describe("xlsx layer snapshot: unsaved edits", () => {
  it("refuses with UNSAVED_CHANGES_OPEN and writes nothing", async () => {
    const unsaved = createXlsxLayer({ openState: async () => "unsaved" });
    await assert.rejects(unsaved.snapshot(import.meta.filename, "/nonexistent-dir/should-not-exist/x.xlsx"), (e: Error & { code?: string }) => {
      assert.equal(e.code, "UNSAVED_CHANGES_OPEN");
      assert.match(e.message, /save/i);
      return true;
    });
  });
});
