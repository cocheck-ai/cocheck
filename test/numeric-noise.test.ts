import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { formatValue } from "./helpers/xlsx-shown.ts";
import { numbersEqual } from "../src/office/connector/xlsx/numbers.ts";
import type { CellSnapshot, WorkbookSnapshot } from "../src/office/connector/xlsx/types.ts";

function book(value: number | null, formula: string | null = null): WorkbookSnapshot {
  const cell: CellSnapshot = { address: "A1", value, formula, numFmt: "General" };
  return { sheets: [{ name: "Sheet1", cells: new Map([["A1", cell]]) }] };
}
const rowsFor = (a: number, b: number, formula: string | null = null) => diffWorkbooks(book(a, formula), book(b, formula));

describe("floating-point noise is not a change", () => {
  it("0 -> 1.3034e-13 on a check cell makes no row", () => {
    assert.equal(rowsFor(0, 1.3034e-13, "A2-A3").length, 0);
    assert.equal(rowsFor(1.3034e-13, 0).length, 0);
  });

  it("0.22000000000000003 -> 0.22 makes no row, with or without a formula", () => {
    assert.equal(rowsFor(0.22000000000000003, 0.22).length, 0);
    assert.equal(rowsFor(0.22000000000000003, 0.22, "B1*2").length, 0);
  });

  it("0.1 + 0.2 equals 0.3", () => {
    assert.equal(rowsFor(0.1 + 0.2, 0.3).length, 0);
    assert.equal(numbersEqual(0.1 + 0.2, 0.3), true);
  });

  it("a relative change of 1e-9 still makes a row", () => {
    assert.equal(rowsFor(1, 1 + 1e-9).length, 1);
    assert.equal(rowsFor(1e-5, 1e-5 * (1 + 1e-9)).length, 1);
    assert.equal(rowsFor(1234567.891, 1234567.891 * (1 + 1e-9), "B1*2").length, 1);
  });

  it("0 -> 1e-6 still makes a row, in both directions", () => {
    assert.equal(rowsFor(0, 1e-6).length, 1);
    assert.equal(rowsFor(1e-6, 0).length, 1);
  });

  it("the row description shows at most 15 significant digits", () => {
    const layer = createXlsxLayer({ openState: async () => "closed" });
    const [d] = rowsFor(22.000000000000004, 5, "B1*2");
    const text = layer.describe({ location: "Sheet1!A1", kind: d!.kind, before: null, after: null, derivable: false, detail: { ...d! } });
    assert.ok(!/\d{16}/.test(text.replace(".", "")), text);
  });
});

describe("review page values show at most 15 significant digits", () => {
  it("formatValue drops digits past the 15th", () => {
    assert.equal(formatValue(0.22000000000000003), "0.22");
    assert.equal(formatValue(1234567890123.4567), "1.23457E+12 (stored 1234567890123.46)");
    assert.equal(formatValue(1234567890123.4567, "#,##0.00"), "1,234,567,890,123.46");
    assert.equal(formatValue({ value: 0.1 + 0.2, formula: "A1+A2" }), "0.3 (formula =A1+A2)");
  });
});
