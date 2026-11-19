import assert from "node:assert/strict";
import test from "node:test";
import { builtinEntries, createRegistry } from "../src/connector/registry.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import type { DiffRow } from "../src/office/connector/xlsx/types.ts";
import type { ChangeInfo } from "../src/timeline/render/types.ts";

// Every gate on: the old code would have drawn Word and slides through LibreOffice and workbooks as a grid.
const reg = createRegistry({ builtins: builtinEntries({ pdf: () => true }) });
const pic = { tier: "picture", picture: { before: "b", after: "a", width: 10, height: 10, regions: [{ x: 1, y: 1, w: 2, h: 2 }] } } as unknown as ChangeInfo["generic"];

// The pictures-off card (office-off.ts) went with core has no Office renderer, and its picture tier, /preview/ and picture-crop routes draw
// no state a connector reads (test/core-forgets-office-render.test.ts). What stays here: the other direction, and the layer's wording.
test("an Office ending has no renderer of its own in core (the fallback card)", async () => {
  for (const name of ["a.xlsx", "A.XLSM", "c.docx", "d.pptx", "e.ppsx"]) assert.equal(reg.rendererFor(name).name, "stored-image", name);
});

test("a non-Office file keeps its view (text, csv, image, pdf)", async () => {
  const text = await reg.rendererFor("notes.txt", { tier: "text" } as never).view(Buffer.from("a\n"), Buffer.from("b\n"), { id: "c", file: "notes.txt", kind: "modified" });
  assert.notEqual(text.kind, "card");
  const csv = await reg.rendererFor("t.csv", { tier: "text" } as never).view(Buffer.from("a\n"), Buffer.from("b\n"), { id: "c", file: "t.csv", kind: "modified" });
  assert.notEqual(csv.kind, "card");
  assert.equal(reg.rendererFor("x.pdf").name, "pdfkit");
  const img = await reg.rendererFor("p.png", pic).view(null, null, { id: "c", file: "p.png", kind: "modified", generic: pic });
  assert.equal(img.kind, "pages");
  assert.equal(img.before.length, 1);
  const other = await reg.rendererFor("thing.pages", pic).view(null, null, { id: "c", file: "thing.pages", kind: "modified", generic: pic });
  assert.equal(other.kind, "pages");
  assert.equal(reg.rendererFor("x.xlsb").name, "stored-image");
});

test("a formula with no stored value reads 'no stored value' on its card, and a stored one keeps its number", () => {
  const layer = createXlsxLayer({ openState: async () => "closed" });
  const say = (d: DiffRow) => layer.describe({ location: `${d.sheet}!${d.cell}`, kind: d.kind, before: null, after: null, derivable: false, detail: { ...d } });
  const base = { sheet: "S", cell: "A1", kind: "formula" as const, formulaBefore: "B1", formulaAfter: "B2" };
  assert.equal(say({ ...base, valueBefore: null, valueAfter: null }), "S!A1: was formula =B1 (no stored value), now formula =B2 (no stored value)");
  assert.equal(say({ ...base, valueBefore: 1, valueAfter: null }), "S!A1: was formula =B1 (1), now formula =B2 (no stored value)");
  assert.equal(say({ ...base, valueBefore: 1, valueAfter: 2 }), "S!A1: was formula =B1 (1), now formula =B2 (2)");
});
