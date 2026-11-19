import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import { alignSequences } from "../src/formats/files/align.ts";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";
import { tagShape } from "../scripts/lib/pptx-tags.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";

// Review fixes: shared formulas that point at another sheet, the over-cap line alignment and a tag-only pptx link write.

const ZIP_MTIME = new Date(2020, 0, 1);
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list: Array<[string, string, string]>): string => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function twoSheetBook(sheet1Rows: string): Uint8Array {
  const dataRows = [1, 2, 3].map((r) => `<row r="${r}"><c r="B${r}"><v>${r}</v></c></row>`).join("");
  return zipSync({
    "xl/workbook.xml": strToU8(`<workbook xmlns="${SHEET_NS}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/><sheet name="Data" sheetId="2" r:id="rId2"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(rels([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "worksheets/sheet2.xml"]])),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${SHEET_NS}"><sheetData>${sheet1Rows}</sheetData></worksheet>`),
    "xl/worksheets/sheet2.xml": strToU8(`<worksheet xmlns="${SHEET_NS}"><sheetData>${dataRows}</sheetData></worksheet>`),
  }, { mtime: ZIP_MTIME });
}
const cellF = (addr: string, f: string, v: number): string => `<c r="${addr}"><f>${f}</f><v>${v}</v></c>`;
const shared = twoSheetBook(
  `<row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">Data!B1*2</f><v>2</v></c></row><row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c></row><row r="3"><c r="A3"><f t="shared" si="0"/><v>6</v></c></row>`,
);
const explicit = (a2: string): Uint8Array => twoSheetBook(
  `<row r="1">${cellF("A1", "Data!B1*2", 2)}</row><row r="2">${cellF("A2", a2, 4)}</row><row r="3">${cellF("A3", "Data!B3*2", 6)}</row>`,
);

describe("shared formulas that point at another sheet", () => {
  it("expand with every ref shifted, so a follower reads the next row", () => {
    const cells = readWorkbookSnapshot(shared).sheets[0]!.cells;
    assert.equal(cells.get("A2")!.formula, "Data!B2*2");
    assert.equal(cells.get("A3")!.formula, "Data!B3*2");
  });

  it("an untouched follower is not a change, and a real edit on a follower is a formula change", () => {
    const before = readWorkbookSnapshot(shared);
    assert.deepEqual(diffWorkbooks(before, readWorkbookSnapshot(explicit("Data!B2*2"))), []);
    const edited = diffWorkbooks(before, readWorkbookSnapshot(explicit("Data!B1*2")));
    assert.equal(edited.length, 1);
    assert.equal((edited[0] as { cell?: string }).cell, "A2");
    assert.equal((edited[0] as { kind?: string }).kind, "formula");
  });
});

describe("alignSequences over its cell cap", () => {
  const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
  it("two in-place edits in a 3000-line text are two changed pairs, never an equal pair", () => {
    const a = lines(3000);
    const b = [...a];
    b[10] = "edited eleven";
    b[2500] = "edited twenty-five hundred one";
    const pairs = alignSequences(a, b);
    assert.deepEqual(pairs, [{ before: 10, after: 10 }, { before: 2500, after: 2500 }]);
    for (const p of pairs) assert.notEqual(a[p.before!], b[p.after!]);
  });

  it("a real change in the middle of a long text is still reported, including a length change", () => {
    const a = lines(3000);
    const b = [...a];
    b[10] = "edited";
    b[2500] = "edited too";
    b.splice(2600, 1);
    const pairs = alignSequences(a, b);
    assert.ok(pairs.some((p) => p.before === 10 && p.after === 10));
    assert.ok(pairs.some((p) => p.before === 2500 && p.after === 2500));
    assert.ok(pairs.some((p) => p.after === null), "the removed line shows as a removal");
  });
});

describe("a tag-only pptx link write", () => {
  const deck = new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures", "ppt-table-deck.pptx")));
  const shape = readDeck(deck).slides[0]!.shapes.find((s) => s.name !== "")!.name;
  const slideRows = (rows: ReturnType<typeof mediaChanges>) => rows.filter((r) => r.kind === "slide changed");

  it("adds no slide changed row, and a second tag on a tagged shape adds none either", () => {
    const once = tagShape(deck, 1, shape, '{"cell":"Model!B7"}');
    assert.deepEqual(slideRows(mediaChanges(".pptx", deck, once)), []);
    const twice = tagShape(once, 1, shape, '{"cell":"Model!B8"}');
    assert.deepEqual(slideRows(mediaChanges(".pptx", once, twice)), []);
  });

  it("a real text change on a tagged slide still reads as slide changed", () => {
    const tagged = tagShape(deck, 1, shape, '{"cell":"Model!B7"}');
    const files = unzipSync(tagged);
    const slide = Object.keys(files).find((n) => /^ppt\/slides\/slide1\.xml$/.test(n))!;
    const xml = strFromU8(files[slide]!);
    const edited = xml.replace(/<a:t>([^<]+)<\/a:t>/, "<a:t>$1 changed</a:t>");
    assert.notEqual(edited, xml);
    const after = zipSync({ ...files, [slide]: strToU8(edited) }, { mtime: ZIP_MTIME });
    assert.equal(slideRows(mediaChanges(".pptx", tagged, after)).length, 1);
    assert.equal(slideRows(mediaChanges(".pptx", deck, after)).length, 1);
  });
});

