import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { holds } from "../src/office/connector/xlsx/written.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import type { LayerDiffRow } from "../src/formats/layer.ts";
import { hookCell, hookOp } from "./helpers/hook-cell-op.ts";

describe("written equality: the xlsx layer on an Excel-saved file", () => {
  const layer = createXlsxLayer({ openState: async () => "closed" });
  const fixture = fileURLToPath(new URL("./fixtures/shifted-crosssheet-after.xlsx", import.meta.url));
  const at = (cell: string): LayerDiffRow => ({
    location: `IS!${cell}`,
    kind: "formula",
    before: null,
    after: null,
    derivable: false,
    detail: { sheet: "IS", cell, kind: "formula" },
  });
  const setValue = (formula: string) => hookOp(1, fixture, [hookCell("IS", "C3", null, formula)]);

  it("IS!C3, saved by Excel for Mac as Inputs!C3, holds a written ='Inputs'!C3 but not ='Inputs'!C4", async () => {
    const row = await layer.restate(fixture, at("C3"));
    assert.equal((row.detail as { formulaAfter: string }).formulaAfter, "Inputs!C3");
    assert.equal(layer.explains(setValue("='Inputs'!C3"), fixture, row), true);
    assert.equal(layer.explains(setValue("='Inputs'!C4"), fixture, row), false);
  });

  it("whitespace inside a quoted sheet name is significant", () => {
    const row: LayerDiffRow = { ...at("C3"), detail: { sheet: "IS", cell: "C3", kind: "formula", formulaAfter: "'Q1Plan'!A1" } };
    assert.equal(layer.explains(setValue("='Q1 Plan'!A1"), fixture, row), false);
  });
});

describe("written equality: the write read-back", () => {
  it("accepts the four formulas as Excel reads them back after respelling them on entry", () => {
    const readBack: Record<string, string> = {
      "=XLOOKUP(A7,A3:A21,C3:C21)": "=XLOOKUP(A7,A3:A21,C3:C21)",
      "=C7*.5": "=C7*0.5",
      "='Inputs'!C7": "=Inputs!C7",
      "=SUM(C9:C7)": "=SUM(C7:C9)",
    };
    for (const [sent, echoed] of Object.entries(readBack)) {
      assert.equal(holds(sent, 0, echoed), true, `${sent} read back as ${echoed}`);
    }
  });

  it("refuses a read-back of text where a number or boolean was written",  () => {
    for (const [sent, echoed] of [[7, '"7"'], [true, '"TRUE"'], [4006381333931, "4.006381333932E+12"]] as const) {
      assert.equal(holds(sent, echoed.replace(/^"|"$/g, ""), null), false, `${sent} read back as ${echoed}`);
    }
  });
});
