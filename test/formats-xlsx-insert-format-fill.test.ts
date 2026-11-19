import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import type { LayerDiffRow, LayerOp } from "../src/formats/layer.ts";
import type { DiffRow } from "../src/office/connector/xlsx/types.ts";

const FILE = "/tmp/book.xlsx";
const layer = createXlsxLayer({ openState: async () => "closed" });
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function row(d: DiffRow): LayerDiffRow {
  return { location: `${d.sheet}!${d.cell}`, kind: d.kind, before: null, after: null, derivable: false, detail: { ...d } };
}
/** How submit classifies a row given the task's ops (the latest touching op decides). */
function classify(ops: LayerOp[], r: LayerDiffRow): "explained" | "derived" | "unlogged" {
  const touching = ops.filter((o) => layer.touches(o, FILE, r));
  const latest = touching.at(-1);
  if (latest && layer.explains(latest, FILE, r)) return "explained";
  return latest || !r.derivable ? "unlogged" : "derived";
}

describe("a column insert then a hand retarget (live run), no op logged", () => {
  it("leaves the retargeted formula unlogged, and says what the shift would have made it", async () => {
    const diff = await layer.diff(fixture("cocheck-insert-then-retarget-before.xlsx"), fixture("cocheck-insert-then-retarget-after.xlsx"));
    const by = { explained: [] as string[], derived: [] as string[], unlogged: [] as string[] };
    for (const r of diff) by[classify([], r)].push(r.location);
    assert.deepEqual(by.explained, []);
    assert.ok(by.unlogged.includes("IS!D10"));
    assert.ok(by.derived.length > 0);
    const is10 = diff.find((r) => r.location === "IS!D10")!;
    assert.equal(
      layer.describe(is10),
      "IS!D10: formula would have become =-Inputs!C16*Inputs!E13 with the row/column shift; now =-Inputs!C16*Inputs!D13 (was -60000, now 0)",
    );
  });

  it("a formula edited with no shift reads as before", () => {
    const d: DiffRow = { sheet: "S", cell: "A1", kind: "formula", valueBefore: 1, valueAfter: 2, formulaBefore: "B1", formulaAfter: "B2" };
    assert.equal(layer.describe(row(d)), "S!A1: was formula =B1 (1), now formula =B2 (2)");
  });
});
