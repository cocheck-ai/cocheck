import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { MAX_PAGES_PER_SIDE, viewFromPages } from "../src/timeline/render/pdf.ts";
import type { PdfPage } from "../src/timeline/render/pdf-helper.ts";
import type { ChangeInfo } from "../src/timeline/render/types.ts";

// change-first panning (cfv-pan): the review view of a Word or PowerPoint file lists every page of each side, in order, line k of Before beside its
// partner on After; a page with no partner gets a placeholder opposite. Boxes stay exactly what they were. Fixtures: the same fake pages the whole-deck tests use.

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer): Buffer => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1"); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]); };
/** A white 20 x 20 PNG: every page draws the same. */
const blank = (): Buffer => { const rows = Buffer.alloc((20 * 3 + 1) * 20, 255); for (let y = 0; y < 20; y++) rows[y * 61] = 0; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(20, 0); ihdr.writeUInt32BE(20, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]); };
const page = (index: number, text = `Line ${index}`): PdfPage => ({ index, width: 100, height: 140, runs: [{ text, x: 0, y: 0, w: 50, h: 10 }] } as PdfPage);
const pagesOf = (n: number, over: Record<number, string> = {}): PdfPage[] => Array.from({ length: n }, (_, i) => page(i + 1, over[i + 1]));
const info: ChangeInfo = { id: "c1", file: "report.docx", kind: "modified" };
const run = (b: PdfPage[], a: PdfPage[]) => viewFromPages(b, a, Buffer.from("a"), Buffer.from("b"), info, { renderPage: async () => blank() });
const real = (v: { id: string; absent?: true }[]) => v.filter((p) => !p.absent).map((p) => p.id);

describe("review view lists every page (cfv-pan)", () => {
  it("a one-page edit still lists all pages on both sides in order, the edited page boxed and the others marked unchanged", async () => {
    const v = await run(pagesOf(5), pagesOf(5, { 3: "Line 3 was edited" }));
    assert.equal(v.kind, "pages");
    assert.deepEqual(v.before.map((p) => p.id), [1, 2, 3, 4, 5].map((n) => `before:page${n}`));
    assert.deepEqual(v.after.map((p) => p.id), [1, 2, 3, 4, 5].map((n) => `after:page${n}`));
    assert.deepEqual(v.after.filter((p) => p.unchanged).map((p) => p.picture!.page), [1, 2, 4, 5]);
    assert.ok(v.boxes.length > 0 && v.boxes.every((b) => b.pane.endsWith("page3")), JSON.stringify(v.boxes));
    assert.ok(!v.caveats.some((c) => /Not shown, because they are identical/.test(c)), "the P= hiding caveat is gone: " + JSON.stringify(v.caveats));
  });

  it("a page only the after side has gets a placeholder on the before side at the same row, named by its page number", async () => {
    const v = await run(pagesOf(3), [...pagesOf(3), page(4, "A brand new closing page")]);
    assert.equal(v.before.length, v.after.length);
    const k = v.after.findIndex((p) => p.id === "after:page4");
    assert.equal(k, 3);
    assert.equal(v.before[k]!.absent, true);
    assert.equal(v.before[k]!.label, "No page 4 on this side");
    assert.equal(v.before[k]!.picture, undefined);
    assert.deepEqual(real(v.before), ["before:page1", "before:page2", "before:page3"]);
  });

  it("a page removed from the middle leaves a placeholder on the after side between its neighbours", async () => {
    const before = pagesOf(4);
    const after = [page(1), page(2), page(3, "Line 4")];
    const v = await run(before, after);
    assert.equal(v.before.length, v.after.length);
    const row = v.before.findIndex((p) => p.id === "before:page3");
    assert.ok(row >= 0);
    assert.equal(v.after[row]!.absent, true);
    assert.equal(v.after[row]!.label, "No page 3 on this side");
    assert.deepEqual(v.before.map((p) => p.id), ["before:page1", "before:page2", "before:page3", "before:page4"]);
    assert.deepEqual(real(v.after), ["after:page1", "after:page2", "after:page3"]);
    assert.ok(v.after.findIndex((p) => p.id === "after:page3") === 3, "after page 3 (the old page 4) sits beside before page 4");
  });

  it("a document past the limit keeps the limit per side, keeps the page with a box, and a caveat names what was cut", async () => {
    const n = MAX_PAGES_PER_SIDE + 50;
    const v = await run(pagesOf(n), pagesOf(n, { [n - 5]: "Edited far past the limit" }));
    assert.equal(v.before.length, MAX_PAGES_PER_SIDE);
    assert.equal(v.after.length, MAX_PAGES_PER_SIDE);
    assert.ok(real(v.after).includes(`after:page${n - 5}`), "the page with the change is kept");
    assert.ok(v.boxes.every((b) => b.pane.endsWith(`page${n - 5}`)));
    const c = v.caveats.find((x) => /at most 300 pages per side/.test(x));
    assert.ok(c !== undefined, JSON.stringify(v.caveats));
    assert.match(c!, /before pages 300-344 and 346-350/);
    assert.deepEqual(real(v.after).map((id) => Number(id.replace("after:page", ""))), [...real(v.after)].map((id) => Number(id.replace("after:page", ""))).sort((x, y) => x - y), "kept pages stay in order");
  });

  it("a side that is missing keeps its pages unpaired and gets no placeholders", async () => {
    const v = await viewFromPages([], pagesOf(3), null, Buffer.from("b"), { id: "c1", file: "new.docx", kind: "created" }, { renderPage: async () => blank() });
    assert.deepEqual(v.before, []);
    assert.equal(v.after.length, 3);
    assert.ok(v.after.every((p) => !p.absent));
  });

  it("identical pages: the banner stays and every page is listed", async () => {
    const v = await run(pagesOf(3), pagesOf(3));
    assert.equal(v.banner?.title, "No visible difference");
    assert.equal(v.after.length, 3);
  });
});
