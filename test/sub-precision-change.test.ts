import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { beforeAfterText, formatValue } from "./helpers/xlsx-shown.ts";
import type { CellSnapshot, WorkbookSnapshot } from "../src/office/connector/xlsx/types.ts";

function cell(address: string, value: number | null): CellSnapshot {
  return { address, value, formula: null, numFmt: "General" };
}
function book(cells: CellSnapshot[]): WorkbookSnapshot {
  return { sheets: [{ name: "Sheet1", cells: new Map(cells.map((c) => [c.address, c])) }] };
}

describe("a change below the display precision is readable", () => {
  for (const [from, to] of [[1, 1 + 1e-9], [0, 1e-6], [1e-6, 0], [0, -1e-6], [-1e-6, 0], [1, 1 - 1e-9]] as const) {
    it(`${from} -> ${to} reads differently on the review page`, () => {
      const t = beforeAfterText(from, to, "General", "General");
      assert.notEqual(t.before, t.after);
      for (const side of [t.before, t.after]) assert.ok(!/^-0%?$/.test(side), `${t.before} -> ${t.after}`);
    });
    it(`${from} -> ${to} reads differently in the CLI`, () => {
      const layer = createXlsxLayer({ openState: async () => "closed" });
      const [d] = diffWorkbooks(book([cell("A1", from)]), book([cell("A1", to)]));
      const text = layer.describe({ location: "Sheet1!A1", kind: d!.kind, before: null, after: null, derivable: false, detail: { ...d! } });
      const [b, a] = text.split(": ")[1]!.split(" -> ");
      assert.notEqual(b, a, text);
    });
  }

  it("rows that already differ show what Excel shows (General has no thousands separator)", () => {
    assert.deepEqual(beforeAfterText(1234.5, 2000, "General", "General"), { before: "1234.5", after: "2000" });
    assert.equal(formatValue(1 + 1e-9), "1.000000001");
  });

  it("shows the minus Excel shows, and says when the text drops the value", () => {
    assert.equal(formatValue(-1e-6), "-1E-06");
    assert.equal(formatValue(-1e-6, "0%"), "0% (stored -0.000001)");
    assert.equal(formatValue(-1234.5), "-1234.5");
  });

  it("covers percent formats and formula values", () => {
    const p = beforeAfterText(0.5, 0.5 + 1e-10, "0%", "0%");
    assert.notEqual(p.before, p.after);
    const f = beforeAfterText({ value: 1, formula: "A1" }, { value: 1 + 1e-9, formula: "A1" }, "General", "General");
    assert.notEqual(f.before, f.after);
  });

  // The case of beforeAfterText's own fallback. A hidden format (;;;) shows both sides as nothing and flags neither as
  // lossy, so only the exact pass makes the change readable; an unchanged hidden cell stays blank.
  it("falls back to the stored values when the formats show two different values the same", () => {
    assert.deepEqual(beforeAfterText(5, 1200, ";;;", ";;;"), { before: " (stored 5)", after: " (stored 1200)" });
    assert.deepEqual(beforeAfterText(5, 5, ";;;", ";;;"), { before: "", after: "" });
  });
});

describe("sub-1e-12 noise does not shift row alignment", () => {
  it("a row insert inside a block of value-only rows that differ from 0 by noise aligns the rest (one structure row plus the new cell)", () => {
    const n = 8;
    const noise = (i: number) => (i % 2 === 0 ? 0 : 1.3034e-13);
    const before = book(Array.from({ length: n }, (_, i) => cell(`A${i + 1}`, noise(i))));
    // insert a distinct row at row 5; the old rows 5..8 move down, now carrying opposite noise
    const cells: CellSnapshot[] = [];
    for (let i = 0; i < n + 1; i++) {
      if (i === 4) cells.push(cell(`A${i + 1}`, 42));
      else cells.push(cell(`A${i + 1}`, noise((i < 4 ? i : i - 1) + 1)));
    }
    const rows = diffWorkbooks(before, book(cells));
    assert.deepEqual(rows.map((r) => r.cell), ["5:5", "A5"], JSON.stringify(rows.map((r) => [r.cell, r.kind])));
  });
});
