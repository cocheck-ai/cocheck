import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";
import { viewFromPages } from "../src/timeline/render/pdf.ts";
import type { PdfPage } from "../src/timeline/render/pdf-helper.ts";
import type { ChangeInfo } from "../src/timeline/render/types.ts";

// Pictures are always shown. The recorded deck versions are the fixtures: v1 -> v2 replaced only the theme, v2 -> v3 changed only
// a chart's line-marker outline dash.

const V = (n: number): Promise<Buffer> => readFile(`test/fixtures/broken-chart-deck-v${n}.pptx`);

describe("what changed, in words", () => {
  it("a theme-only change is one deck row naming the theme, not 'layout, master or theme' on every slide", async () => {
    const rows = mediaChanges(".pptx", await V(1), await V(2));
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]!.kind, "theme changed");
    assert.equal(rows[0]!.location, "Deck");
    assert.match(rows[0]!.detail!, /Health Check Dark/);
    assert.match(rows[0]!.detail!, /palette colours replaced/);
    assert.match(rows[0]!.detail!, /slides 1-9/);
    // the sentence says whether it can be seen, and does not call it invisible while the layout or master names theme colours
    assert.match(rows[0]!.detail!, /layout or master does, so text or backgrounds drawn from it may look different$/);
    assert.ok(!rows.some((r) => /layout, master or theme/.test(r.detail ?? "")));
  });

  it("a marker dash change says which property and that the line is unchanged", async () => {
    const rows = mediaChanges(".pptx", await V(2), await V(3));
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]!.kind, "slide changed");
    assert.match(rows[0]!.detail!, /line-marker outline dash: solid → dash \(the line itself is unchanged\)/);
  });

  it("identical bytes have no change", async () => {
    assert.deepEqual(mediaChanges(".pptx", await V(2), await V(2)), []);
  });
});

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer): Buffer => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1"); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]); };
/** A white 20 x 20 PNG: every page draws the same. */
const blank = (): Buffer => { const rows = Buffer.alloc((20 * 3 + 1) * 20, 255); for (let y = 0; y < 20; y++) rows[y * 61] = 0; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(20, 0); ihdr.writeUInt32BE(20, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]); };
const page = (index: number): PdfPage => ({ index, width: 100, height: 100, runs: [{ text: `Line ${index}`, x: 0, y: 0, w: 50, h: 10 }] } as PdfPage);
const info: ChangeInfo = { id: "c1", file: "deck.pptx", kind: "modified", changeSentence: "Deck: the deck's theme changed (palette colours replaced)." };

describe("no visible difference", () => {
  it("pages that match are still shown, under a banner with the sentence", async () => {
    const pages = [page(1), page(2), page(3)];
    const v = await viewFromPages(pages, pages, Buffer.from("a"), Buffer.from("b"), info, { renderPage: async () => blank() });
    assert.equal(v.kind, "pages");
    assert.deepEqual(v.before.map((p) => p.id), ["before:page1", "before:page2", "before:page3"]);
    assert.deepEqual(v.after.map((p) => p.id), ["after:page1", "after:page2", "after:page3"]);
    assert.equal(v.banner?.title, "No visible difference");
    assert.match(v.banner!.text, /theme changed/);
    assert.deepEqual(v.boxes, []);
  });

  it("with no known change the banner says only saved-file details differ", async () => {
    const pages = [page(1)];
    const v = await viewFromPages(pages, pages, Buffer.from("a"), Buffer.from("b"), { ...info, changeSentence: undefined }, { renderPage: async () => blank() });
    assert.match(v.banner!.text, /timestamps/);
  });
});


