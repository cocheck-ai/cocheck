// A shape that only moved or changed size (a chart shrunk, table columns widened) is one change, boxed on both sides.
// Before this, the deck diff never compared position or size: the pages were marked changed and the change list was empty.
// Real decks built in memory, real PNG pages drawn here. 1 px = 10000 EMU: the slide is 9140000 x 6860000, the page 914 x 686.
import assert from "node:assert/strict";
import { deflateSync, crc32 } from "node:zlib";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { addPptxBoxes, type BoxChange } from "../src/office/connector/pptx-boxes.ts";
import { rowChange } from "../src/office/connector/program.ts";
import type { Picture } from "../src/office/connector/pictures.ts";
import { diffDecks } from "../src/office/connector/pptx/diff.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: Array<[string, string, string]>): Uint8Array => strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, t, g]) => `<Relationship Id="${id}" Type="${t}" Target="${g}"/>`).join("")}</Relationships>`);
const PX = 10000;
const xf = (x: number, y: number, w: number, h: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const sp = (id: number, name: string, text: string, frame: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${frame}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const table = (id: number, name: string, x: number, y: number, w: number, h: number, cols: number[]) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid>${cols.map((c) => `<a:gridCol w="${c}"/>`).join("")}</a:tblGrid><a:tr h="${h}">${cols.map((_, i) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>c${i}</a:t></a:r></a:p></a:txBody></a:tc>`).join("")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const grp = (id: number, name: string, x: number, y: number, inner: string) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="1000000"/></a:xfrm></p:grpSpPr>${inner}</p:grpSp>`;
function deck(shapes: string): Buffer {
  const f: Record<string, Uint8Array> = {};
  f["_rels/.rels"] = rels([["rId1", `${R}/officeDocument`, "ppt/presentation.xml"]]);
  f["ppt/presentation.xml"] = strToU8(`<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId10"/></p:sldIdLst><p:sldSz cx="9140000" cy="6860000"/></p:presentation>`);
  f["ppt/_rels/presentation.xml.rels"] = rels([["rId10", `${R}/slide`, "slides/slide1.xml"]]);
  f["ppt/slides/slide1.xml"] = strToU8(`<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`);
  return Buffer.from(zipSync(f, { mtime: new Date(2020, 0, 1) }));
}
type Ink = [number, number, number, number];
function page(ink: Ink[], w = 914, h = 686): Buffer {
  const px = Buffer.alloc(w * h * 3, 255);
  for (const [x, y, iw, ih] of ink) for (let j = y; j < y + ih; j++) for (let i = x; i < x + iw; i++) px.fill(0, (j * w + i) * 3, (j * w + i) * 3 + 3);
  const rows = Buffer.concat(Array.from({ length: h }, (_, j) => Buffer.concat([Buffer.from([0]), px.subarray(j * w * 3, (j + 1) * w * 3)])));
  const chunk = (t: string, d: Buffer): Buffer => { const b = Buffer.concat([Buffer.from(t, "latin1"), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b) >>> 0); return Buffer.concat([l, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const pic = (side: "before" | "after", ink: Ink[]): Picture => ({ id: `${side}:page1`, side, type: "image" as const, src: `data:image/png;base64,${page(ink).toString("base64")}`, label: side, width: 914, height: 686, page: 1, pageCount: 1, changed: true as const });
const layer = createPptxLayer();
function run(before: Buffer, after: Buffer, bInk: Ink[], aInk: Ink[]) {
  const rows = diffDecks(readDeck(before), readDeck(after));
  const changes = rows.map((r, i) => rowChange(r, layer.describe(r), i)) as unknown as Array<BoxChange & { label: string; text: string }>;
  addPptxBoxes({ before, after, rows, changes, pictures: [pic("before", bInk), pic("after", aInk)], caveats: [] });
  return changes;
}
const at = (c: BoxChange | undefined) => c?.boxes?.map((b) => [b.picture, b.rect.x, b.rect.y, b.rect.w, b.rect.h]);

describe("a shape that moved or changed size", () => {
  it("a text box made shorter is one change, 'resized', boxed on both sides", () => {
    const c = run(deck(sp(2, "Card", "x", xf(100 * PX, 100 * PX, 200 * PX, 300 * PX))), deck(sp(2, "Card", "x", xf(100 * PX, 100 * PX, 200 * PX, 270 * PX))), [[100, 100, 200, 300]], [[100, 100, 200, 270]]);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.label, "Slide 1 / Card");
    assert.equal(c[0]!.mark, "changed");
    assert.equal(c[0]!.text, "Shape resized");
    assert.deepEqual(at(c[0]), [["before:page1", 100, 100, 200, 300], ["after:page1", 100, 100, 200, 270]]);
  });
  it("a shape moved without changing size is 'moved', boxed where it was and where it is", () => {
    const c = run(deck(sp(2, "Note", "x", xf(100 * PX, 100 * PX, 100 * PX, 50 * PX))), deck(sp(2, "Note", "x", xf(100 * PX, 200 * PX, 100 * PX, 50 * PX))), [[100, 100, 100, 50]], [[100, 200, 100, 50]]);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.text, "Shape moved");
    assert.deepEqual(at(c[0]), [["before:page1", 100, 100, 100, 50], ["after:page1", 100, 200, 100, 50]]);
  });
  it("EMU rounding noise is not a change", () => {
    const rows = diffDecks(readDeck(deck(sp(2, "Card", "x", xf(1000000, 1000000, 2000000, 3000000)))), readDeck(deck(sp(2, "Card", "x", xf(1000003, 999998, 2000004, 3000001)))));
    assert.deepEqual(rows, []);
  });
  it("table columns widened inside the same frame: 'Table resized'", () => {
    const c = run(deck(table(3, "Grid", 100 * PX, 100 * PX, 300 * PX, 50 * PX, [100 * PX, 100 * PX, 100 * PX])), deck(table(3, "Grid", 100 * PX, 100 * PX, 300 * PX, 50 * PX, [150 * PX, 75 * PX, 75 * PX])), [[200, 100, 2, 50], [300, 100, 2, 50]], [[250, 100, 2, 50], [325, 100, 2, 50]]);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.text, "Table resized");
    assert.equal(at(c[0])?.length, 2);
  });
  it("a table moved and widened (step 293's table) is one change, 'Table moved and resized'", () => {
    const c = run(deck(table(3, "Grid", 600 * PX, 100 * PX, 220 * PX, 90 * PX, [80 * PX, 70 * PX, 70 * PX])), deck(table(3, "Grid", 550 * PX, 100 * PX, 270 * PX, 90 * PX, [90 * PX, 90 * PX, 90 * PX])), [[600, 100, 220, 90]], [[550, 100, 270, 90]]);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.text, "Table moved and resized");
    assert.deepEqual(at(c[0]), [["before:page1", 600, 100, 220, 90], ["after:page1", 550, 100, 270, 90]]);
  });
  it("a moved group is one change; its members, which did not move inside it, are not", () => {
    const inner = sp(5, "Member", "x", xf(0, 0, 1000000, 500000));
    const rows = diffDecks(readDeck(deck(grp(4, "G", 1000000, 1000000, inner))), readDeck(deck(grp(4, "G", 2000000, 1000000, inner))));
    assert.deepEqual(rows.map((r) => [r.location, r.kind]), [["Slide 1 / G", "shape moved"]]);
  });
  it("a text edit with no move or resize gives no geometry change", () => {
    const rows = diffDecks(readDeck(deck(sp(2, "Card", "old", xf(PX, PX, PX, PX)))), readDeck(deck(sp(2, "Card", "new", xf(PX, PX, PX, PX)))));
    assert.deepEqual(rows.map((r) => r.kind), ["text changed"]);
  });
});
