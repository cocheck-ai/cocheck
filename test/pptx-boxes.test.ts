// PowerPoint's boxes on its PDF pages. Real decks built in memory (parts, rels, layout and master placeholders as PowerPoint writes them),
// real PNG pages drawn here (white page, black ink where a shape changed). No PowerPoint, no helper. 1 px = 10000 EMU: the slide is 9140000 x 6860000, the page 914 x 686.
// Guard (a box on the wrong shape or slide): the hidden-slide page map tests and the "page count is not the shown-slide count" test name it.
import assert from "node:assert/strict";
import { deflateSync, crc32 } from "node:zlib";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { levelFor } from "../src/office/connector/program.ts";
import { addPptxBoxes, hiddenWords, OVERFLOW_WORDS, type BoxChange } from "../src/office/connector/pptx-boxes.ts";
import { rowChange } from "../src/office/connector/program.ts";
import type { Picture } from "../src/office/connector/pictures.ts";
import { diffDecks } from "../src/office/connector/pptx/diff.ts";
import { readDeck, readDeckFrames } from "../src/office/connector/pptx/reader.ts";

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: Array<[string, string, string]>): Uint8Array => strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, t, g]) => `<Relationship Id="${id}" Type="${t}" Target="${g}"/>`).join("")}</Relationships>`);
const PX = 10000;
const xf = (x: number, y: number, w: number, h: number, extra = "") => `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const sp = (id: number, name: string, text: string, frame: string, ph = "") => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${frame}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const grp = (id: number, name: string, off: [number, number], ext: [number, number], ch: [number, number], chExt: [number, number], inner: string, attrs = "") =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm${attrs}><a:off x="${off[0]}" y="${off[1]}"/><a:ext cx="${ext[0]}" cy="${ext[1]}"/><a:chOff x="${ch[0]}" y="${ch[1]}"/><a:chExt cx="${chExt[0]}" cy="${chExt[1]}"/></a:xfrm></p:grpSpPr>${inner}</p:grpSp>`;
interface S { id: number; hidden?: boolean; shapes: string }
function deck(slides: S[]): Buffer {
  const f: Record<string, Uint8Array> = {};
  f["_rels/.rels"] = rels([["rId1", `${R}/officeDocument`, "ppt/presentation.xml"]]);
  f["ppt/presentation.xml"] = strToU8(`<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${s.id}" r:id="rId${i + 10}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9140000" cy="6860000"/></p:presentation>`);
  f["ppt/_rels/presentation.xml.rels"] = rels(slides.map((s, i) => [`rId${i + 10}`, `${R}/slide`, `slides/slide${s.id}.xml`]));
  // the layout gives the body placeholder (idx 1) its own frame and leaves the title to the master
  f["ppt/slideLayouts/slideLayout1.xml"] = strToU8(`<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree>${sp(2, "T", "", "", '<p:ph type="title"/>')}${sp(3, "B", "", xf(10 * PX, 300 * PX, 400 * PX, 200 * PX), '<p:ph idx="1"/>')}</p:spTree></p:cSld></p:sldLayout>`);
  f["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = rels([["rId1", `${R}/slideMaster`, "../slideMasters/slideMaster1.xml"]]);
  f["ppt/slideMasters/slideMaster1.xml"] = strToU8(`<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:spTree>${sp(2, "T", "", xf(50 * PX, 20 * PX, 800 * PX, 80 * PX), '<p:ph type="title"/>')}${sp(3, "B", "", xf(0, 0, 1, 1), '<p:ph type="body" idx="1"/>')}</p:spTree></p:cSld></p:sldMaster>`);
  f["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rels([["rId1", `${R}/theme`, "../theme/theme1.xml"]]);
  f["ppt/theme/theme1.xml"] = strToU8(`<?xml version="1.0"?><a:theme ${NS} name="T"/>`);
  for (const s of slides) {
    f[`ppt/slides/_rels/slide${s.id}.xml.rels`] = rels([["rId1", `${R}/slideLayout`, "../slideLayouts/slideLayout1.xml"]]);
    f[`ppt/slides/slide${s.id}.xml`] = strToU8(`<?xml version="1.0"?><p:sld ${NS}${s.hidden ? ' show="0"' : ""}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${s.shapes}</p:spTree></p:cSld></p:sld>`);
  }
  return Buffer.from(zipSync(f, { mtime: new Date(2020, 0, 1) }));
}

type Ink = [number, number, number, number];
/** A 914 x 686 RGB page, white, with black rectangles (pixels). */
function page(ink: Ink[] = [], w = 914, h = 686): Buffer {
  const px = Buffer.alloc(w * h * 3, 255);
  for (const [x, y, iw, ih] of ink) for (let j = y; j < y + ih; j++) for (let i = x; i < x + iw; i++) px.fill(0, (j * w + i) * 3, (j * w + i) * 3 + 3);
  const rows = Buffer.concat(Array.from({ length: h }, (_, j) => Buffer.concat([Buffer.from([0]), px.subarray(j * w * 3, (j + 1) * w * 3)])));
  const chunk = (t: string, d: Buffer): Buffer => { const b = Buffer.concat([Buffer.from(t, "latin1"), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b) >>> 0); return Buffer.concat([l, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
function pics(side: "before" | "after", pages: Ink[][], w = 914, h = 686): Picture[] {
  return pages.map((ink, i) => ({ id: `${side}:page${i + 1}`, side, type: "image" as const, src: `data:image/png;base64,${page(ink, w, h).toString("base64")}`, label: `${side} ${i + 1}`, width: w, height: h, page: i + 1, pageCount: pages.length, changed: true as const }));
}
/** Runs the connector's box step over two decks and the pages drawn for each. */
function run(before: Buffer, after: Buffer, bPages: Ink[][], aPages: Ink[][]) {
  const rows = diffDecks(readDeck(before), readDeck(after));
  const changes = rows.map((r, i) => rowChange(r, "", i)) as unknown as BoxChange[];
  const caveats: string[] = [];
  addPptxBoxes({ before, after, rows, changes, pictures: [...pics("before", bPages), ...pics("after", aPages)], caveats });
  return { rows, changes: changes as Array<BoxChange & { label: string }>, caveats };
}
const at = (c: BoxChange | undefined) => c?.boxes?.map((b) => [b.picture, b.rect.x, b.rect.y, b.rect.w, b.rect.h]);

describe("levelFor", () => {
  it("PowerPoint, Word and Excel all say 3", () => {
    assert.equal(levelFor(OFFICE_APPS.powerpoint), 3);
    assert.equal(levelFor(OFFICE_APPS.word), 3);
    assert.equal(levelFor(OFFICE_APPS.excel), 3);
  });
});

describe("frames", () => {
  it("S3.1 a placeholder with no frame of its own resolves through the layout (by idx) and then the master (by type)", () => {
    const d = deck([{ id: 256, shapes: sp(2, "Title 1", "Hi", "", '<p:ph type="title"/>') + sp(3, "Body 2", "Hi", "", '<p:ph idx="1"/>') + sp(4, "Loose 3", "x", "") }]);
    const { frames } = readDeckFrames(d);
    assert.deepEqual(frames[0], [{ x: 50 * PX, y: 20 * PX, w: 800 * PX, h: 80 * PX }, { x: 10 * PX, y: 300 * PX, w: 400 * PX, h: 200 * PX }, undefined]);
  });
  it("S3.1 group scaling: a child in a group scaled 2x lands at the group's offset plus twice its child offset", () => {
    const inner = sp(5, "Child", "Hi", xf(100000, 100000, 200000, 100000));
    const d = deck([{ id: 256, shapes: grp(4, "G", [1000000, 1000000], [2000000, 1000000], [0, 0], [1000000, 500000], inner) }]);
    const { deck: dk, frames } = readDeckFrames(d);
    assert.deepEqual(dk.slides[0]!.shapes.map((s) => s.name), ["G", "Child"]);
    assert.deepEqual(frames[0], [{ x: 1000000, y: 1000000, w: 2000000, h: 1000000 }, { x: 1200000, y: 1200000, w: 400000, h: 200000 }]);
  });
  it("S3.1 nested groups with a non-zero chOff compose", () => {
    const inner = grp(5, "In", [500000, 500000], [1000000, 1000000], [100, 100], [500, 500], sp(6, "Leaf", "x", xf(200, 200, 100, 100)));
    const d = deck([{ id: 256, shapes: grp(4, "Out", [1000000, 0], [2000000, 2000000], [0, 0], [1000000, 1000000], inner) }]);
    // Leaf: in In's space (200,200,100,100) -> In: 500000 + (200-100)*2000 = 700000, size 200000; then Out scales 2x with off 1000000: x = 1000000 + 700000*2
    assert.deepEqual(readDeckFrames(d).frames[0]![2], { x: 2400000, y: 1400000, w: 400000, h: 400000 });
  });
  it("S3.2 a rotated shape gets the bounding box of its rotated rectangle, about its centre", () => {
    const d = deck([{ id: 256, shapes: sp(2, "Spin", "x", xf(2000000, 1000000, 2000000, 1000000, ' rot="2700000"')) + sp(3, "Quarter", "x", xf(2000000, 1000000, 2000000, 1000000, ' rot="5400000"')) }]);
    const [a, b] = readDeckFrames(d).frames[0]!;
    const side = (2000000 + 1000000) / Math.SQRT2;
    assert.ok(Math.abs(a!.w - side) < 2 && Math.abs(a!.h - side) < 2, JSON.stringify(a));
    assert.ok(Math.abs(a!.x + a!.w / 2 - 3000000) < 2 && Math.abs(a!.y + a!.h / 2 - 1500000) < 2);
    assert.ok(Math.abs(b!.w - 1000000) < 2 && Math.abs(b!.h - 2000000) < 2, JSON.stringify(b));
  });
});

describe("boxes on pages", () => {
  const base = (text: string, frame = xf(100 * PX, 100 * PX, 300 * PX, 100 * PX)) => sp(2, "Text 2", text, frame);
  it("S3.1/S3.8 a text change in a scaled group is boxed at the scaled frame, on the page's pixels", () => {
    const g = (t: string) => grp(4, "G", [1000000, 1000000], [2000000, 1000000], [0, 0], [1000000, 500000], sp(5, "Child", t, xf(100000, 100000, 200000, 100000)));
    const r = run(deck([{ id: 256, shapes: g("old") }]), deck([{ id: 256, shapes: g("new") }]), [[[120, 120, 20, 10]]], [[[122, 122, 20, 10]]]);
    const c = r.changes.find((x) => /Child/.test(x.label));
    assert.deepEqual(at(c), [["before:page1", 120, 120, 40, 20], ["after:page1", 120, 120, 40, 20]]);
  });
  it("S3.1 a placeholder's box comes from the master", () => {
    const t = (x: string) => sp(2, "Title 1", x, "", '<p:ph type="title"/>');
    const r = run(deck([{ id: 256, shapes: t("a") }]), deck([{ id: 256, shapes: t("b") }]), [[[60, 30, 30, 10]]], [[[60, 30, 50, 10]]]);
    assert.deepEqual(at(r.changes[0]), [["before:page1", 50, 20, 800, 80], ["after:page1", 50, 20, 800, 80]]);
  });
  it("S3.2 a rotated shape's box is its bounding box", () => {
    const f = xf(200 * PX, 100 * PX, 200 * PX, 100 * PX, ' rot="2700000"');
    const r = run(deck([{ id: 256, shapes: base("a", f) }]), deck([{ id: 256, shapes: base("b", f) }]), [[]], [[[290, 130, 20, 20]]]);
    const side = Math.ceil((300 * PX) / Math.SQRT2 / PX);
    const b = r.changes[0]!.boxes!.find((x) => x.picture === "after:page1")!.rect;
    assert.ok(Math.abs(b.w - side) <= 2 && Math.abs(b.h - side) <= 2 && Math.abs(b.x + b.w / 2 - 300) <= 1 && Math.abs(b.y + b.h / 2 - 150) <= 1, JSON.stringify(b));
  });
  it("S3.3 text that runs past its frame: the box is the frame, with the words", () => {
    // frame 100..400 x 100..200; the after ink runs down to y 260
    const r = run(deck([{ id: 256, shapes: base("a") }]), deck([{ id: 256, shapes: base("a b c d e f") }]), [[[110, 110, 100, 10]]], [[[110, 110, 100, 90], [110, 200, 100, 60]]]);
    assert.deepEqual(at(r.changes[0]), [["before:page1", 100, 100, 300, 100], ["after:page1", 100, 100, 300, 100]]);
    assert.deepEqual(r.changes[0]!.lines, [OVERFLOW_WORDS]);
  });
  it("S3.3 text inside its frame gets no overflow word", () => {
    const r = run(deck([{ id: 256, shapes: base("a") }]), deck([{ id: 256, shapes: base("b") }]), [[[110, 110, 100, 10]]], [[[110, 110, 100, 30]]]);
    assert.equal(at(r.changes[0])?.length, 2);
    assert.equal(r.changes[0]!.lines, undefined);
  });
  it("S3.4 hidden slides are skipped in the page map: a change on slide 3 lands on page 2, never page 3", () => {
    const sl = (id: number, t: string, hidden = false): S => ({ id, hidden, shapes: sp(2, "Text 2", t, xf(100 * PX, 100 * PX, 300 * PX, 100 * PX)) });
    const before = deck([sl(256, "h", true), sl(257, "one"), sl(258, "two")]);
    const after = deck([sl(256, "h", true), sl(257, "one"), sl(258, "TWO")]);
    const r = run(before, after, [[], [[110, 110, 50, 10]]], [[], [[110, 110, 50, 30]]]);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(r.changes[0]!.boxes!.map((b) => b.picture), ["before:page2", "after:page2"]);
  });
  it("S3.4 a change on a hidden slide has no box and says the slide is hidden", () => {
    const sl = (t: string): S => ({ id: 256, hidden: true, shapes: sp(2, "Text 2", t, xf(100 * PX, 100 * PX, 300 * PX, 100 * PX)) });
    const keep: S = { id: 257, shapes: sp(2, "Text 2", "k", xf(100 * PX, 100 * PX, 300 * PX, 100 * PX)) };
    const r = run(deck([sl("a"), keep]), deck([sl("b"), keep]), [[[1, 1, 5, 5]]], [[[1, 1, 5, 9]]]);
    assert.equal(r.changes[0]!.boxes, undefined);
    assert.deepEqual(r.changes[0]!.unplaced, { before: hiddenWords(1), after: hiddenWords(1) });
    assert.equal(hiddenWords(1), "slide 1 is hidden; PowerPoint does not print it");
  });
  it("S3.4 a page count that is not the shown-slide count draws no box on that side, and says so", () => {
    const sl = (id: number, t: string, hidden = false): S => ({ id, hidden, shapes: sp(2, "Text 2", t, xf(100 * PX, 100 * PX, 300 * PX, 100 * PX)) });
    const before = deck([sl(256, "h", true), sl(257, "one")]);
    const after = deck([sl(256, "h", true), sl(257, "ONE")]);
    // PowerPoint printed the hidden slide too (2 pages for 1 shown slide): the page map cannot be trusted
    const r = run(before, after, [[], [[110, 110, 50, 10]]], [[], [[110, 110, 50, 30]]]);
    assert.equal(r.changes[0]!.boxes, undefined);
    assert.ok(r.caveats.some((c) => /2 pages for 1 shown slides/.test(c)), JSON.stringify(r.caveats));
  });
  it("S3.5 a moved shape gets its before box from the before file", () => {
    const r = run(deck([{ id: 256, shapes: base("a", xf(50 * PX, 50 * PX, 200 * PX, 60 * PX)) }]), deck([{ id: 256, shapes: base("b", xf(400 * PX, 300 * PX, 200 * PX, 60 * PX)) }]), [[[60, 60, 40, 10]]], [[[410, 310, 80, 10]]]);
    assert.deepEqual(at(r.changes[0]), [["before:page1", 50, 50, 200, 60], ["after:page1", 400, 300, 200, 60]]);
  });
  it("S3.6 a removed slide gets a whole-page box on the before page, nothing on the after side; an added slide the reverse", () => {
    const a = (id: number, t: string): S => ({ id, shapes: sp(2, "Text 2", t, xf(100 * PX, 100 * PX, 300 * PX, 100 * PX)) });
    const removed = run(deck([a(256, "keep"), a(257, "gone")]), deck([a(256, "keep")]), [[], [[5, 5, 5, 5]]], [[]]);
    assert.deepEqual(at(removed.changes.find((c) => c.mark === "removed")), [["before:page2", 0, 0, 914, 686]]);
    const added = run(deck([a(256, "keep")]), deck([a(256, "keep"), a(257, "new")]), [[]], [[], [[5, 5, 5, 5]]]);
    assert.deepEqual(at(added.changes.find((c) => c.mark === "added")), [["after:page2", 0, 0, 914, 686]]);
  });
  it("S3.7 no ink difference inside the box means no box", () => {
    // the text changed in the XML (say a font colour the page does not show) but the two pages are the same pixels
    const r = run(deck([{ id: 256, shapes: base("a") }]), deck([{ id: 256, shapes: base("b") }]), [[[110, 110, 100, 10]]], [[[110, 110, 100, 10]]]);
    assert.equal(r.changes[0]!.boxes, undefined);
  });
  it("S3.7 pages that cannot be read give no box (doubt)", () => {
    const before = deck([{ id: 256, shapes: base("a") }]), after = deck([{ id: 256, shapes: base("b") }]);
    const rows = diffDecks(readDeck(before), readDeck(after));
    const changes = rows.map((r, i) => rowChange(r, "", i)) as unknown as BoxChange[];
    const p = [...pics("before", [[]]), ...pics("after", [[[110, 110, 9, 9]]])].map((x) => ({ ...x, src: "data:image/png;base64,AAAA" }));
    addPptxBoxes({ before, after, rows, changes, pictures: p, caveats: [] });
    assert.equal(changes[0]!.boxes, undefined);
  });
});
