import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { changeNote, type ChangeFacts } from "../src/timeline/notes.ts";
import { fallbackRenderer } from "../src/timeline/render/fallback.ts";
import type { GenericPart } from "../src/timeline/page.ts";
import type { ChangeInfo } from "../src/timeline/render/types.ts";

// A note says what CoCheck actually knows. "can't read inside it" only when it has neither a reader nor a picture of both sides.
// Must not happen: a file CoCheck cannot read never claims a reading. (the workbook "cells did not change" note is the
// connector's now; the layer's cellsUnchanged mark stays pinned below.)

const WORKBOOK_XML = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const SHEET = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
const book = (extra: Record<string, string>): Uint8Array =>
  zipSync({ "xl/workbook.xml": strToU8(WORKBOOK_XML), "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS), "xl/worksheets/sheet1.xml": strToU8(SHEET), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])) }, { mtime: new Date(2020, 0, 1) });

const CANT = /can't read inside it/;
const facts = (over: Partial<ChangeFacts>): ChangeFacts => ({ actor: "Claude", file: "fred_macro/macro_composite.png", change: "modified", secret: false, expired: false, tier: "picture", bothPictures: true, rows: [], ...over });

describe("notes: pictures", () => {
  for (const ext of ["png", "jpg", "jpeg", "gif", "heic", "tiff", "bmp", "webp", "PNG"]) {
    it(`a ${ext} whose two pictures were compared is a picture change`, () => {
      const n = changeNote(facts({ file: `a/shot.${ext}` })).text;
      assert.equal(n, `Claude changed the picture a/shot.${ext}`);
      assert.doesNotMatch(n, CANT);
    });
  }
  it("a picture file with only one side pictured still cannot be read", () => {
    assert.match(changeNote(facts({ bothPictures: false })).text, CANT);
  });
  it("a picture file with no picture tier cannot be read", () => {
    assert.match(changeNote(facts({ tier: "fingerprint", bothPictures: false })).text, CANT);
  });
  it("a non-picture file with a picture of both sides does not claim it cannot be read, nor a reading", () => {
    const n = changeNote(facts({ file: "deck.key" })).text;
    assert.doesNotMatch(n, CANT);
    assert.doesNotMatch(n, /picture deck\.key/);
    assert.match(n, /picture of both versions, not a reading/);
  });
});

describe("the real shape of a workbook whose cells did not change", () => {
  it("the layer marks a changed workbook with no cell difference (a drawing added) as cellsUnchanged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    try {
      const a = path.join(dir, "a.xlsx"), b = path.join(dir, "b.xlsx");
      await writeFile(a, book({}));
      await writeFile(b, book({ "xl/drawings/drawing1.xml": "<xdr:wsDr xmlns:xdr=\"x\"/>" }));
      const rows = await createXlsxLayer({ openState: async () => "closed" }).diff(a, b);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind, "file changed");
      assert.equal(rows[0]!.detail.cellsUnchanged, true);
      // A sheet added is a difference the cells do not show, but the layer does not say the cells are unchanged by name only; it is not cellsUnchanged.
      const c = path.join(dir, "c.xlsx");
      await writeFile(c, zipSync({ "xl/workbook.xml": strToU8(WORKBOOK_XML.replace("</sheets>", `<sheet name="Two" sheetId="2" r:id="rId2"/></sheets>`)), "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS.replace("</Relationships>", `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`)), "xl/worksheets/sheet1.xml": strToU8(SHEET), "xl/worksheets/sheet2.xml": strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`) }, { mtime: new Date(2020, 0, 1) }));
      const rows2 = await createXlsxLayer({ openState: async () => "closed" }).diff(a, c);
      assert.equal(rows2.length, 1);
      assert.notEqual(rows2[0]!.detail.cellsUnchanged, true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("office and PDF files the renderer reads", () => {
  const doc = (over: Partial<ChangeFacts>) => facts({ file: "deck.pptx", rendererReads: true, ...over });
  it("says plainly it changed the file, with no claim of a picture or a reading", () => {
    for (const f of ["a.pptx", "a.docx", "a.pdf"]) assert.equal(changeNote(doc({ file: f })).text, `Claude changed ${f}`);
  });
  it("when no renderer can read it, the picture wording stays", () => {
    assert.match(changeNote(doc({ rendererReads: false })).text, /picture of both versions, not a reading/);
  });
  it("a file with no picture and no renderer still cannot be read", () => {
    assert.match(changeNote(doc({ rendererReads: false, tier: "fingerprint", bothPictures: false })).text, CANT);
  });
});

describe("the engine label", () => {
  const SHA_A = "a".repeat(64), SHA_B = "b".repeat(64);
  const generic = { tier: "picture", label: "x", picture: { before: SHA_A, after: SHA_B, width: 200, height: 100, regions: [] } } as GenericPart;
  it("an image's engine names the browser and no OS, and makes no claim about pages", async () => {
    const v = await fallbackRenderer.view(null, null, { id: "c1", file: "a/shot.png", kind: "modified", generic });
    assert.doesNotMatch(v.engine, /first page|macOS|Quick Look/);
    assert.match(v.engine, /your browser/);
  });
});

describe("caveats: the pink boxes", () => {
  const SHA_A = "a".repeat(64), SHA_B = "b".repeat(64);
  const info = (file: string, generic: GenericPart): ChangeInfo => ({ id: "c1", file, kind: "modified", generic });
  const generic = (regions: Array<{ x: number; y: number; w: number; h: number }>): GenericPart => ({ tier: "picture", label: "x", picture: { before: SHA_A, after: SHA_B, width: 200, height: 100, regions } });
  it("a picture file's caveat says the pixels were compared, not read, and does not talk of a first page", async () => {
    const v = await fallbackRenderer.view(null, null, info("a/shot.png", generic([{ x: 1, y: 1, w: 5, h: 5 }])));
    assert.ok(v.caveats.includes("The pink boxes mark where the pixels differ, found by comparing the two pictures, not by reading them."));
    assert.ok(!v.caveats.some((c) => /first page/.test(c)));
    assert.ok(v.boxes.every((b) => b.confidence === "pixel"));
  });
  it("no caveat names Quick Look or a first page, whatever the file", async () => {
    const v = await fallbackRenderer.view(null, null, info("deck.key", generic([{ x: 1, y: 1, w: 5, h: 5 }])));
    assert.ok(v.caveats.some((c) => /pink boxes mark where the pixels differ/.test(c)));
    assert.ok(!v.caveats.some((c) => /first page|Quick Look/.test(c)));
  });
  it("no region, no boxes, no pink-box sentence", async () => {
    const v = await fallbackRenderer.view(null, null, info("a/shot.png", generic([])));
    assert.ok(!v.caveats.some((c) => /pink boxes/.test(c)));
  });
});
