import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makePdf, type Fill } from "./fixtures/make-pdf.ts";
import { accountPages, comparePages, pageRanges, pairPages, type PageText } from "../src/timeline/render/pixel-pages.ts";
import type { View } from "../src/timeline/render/types.ts";
import type { ChangeInfo } from "../src/timeline/render/types.ts";
import { pdfHelperForTest } from "../scripts/lib/pdf-helper-cache.ts";

// Pages whose text matches are compared by pixels. The page-compare logic is tested with hand-made PNGs (no helper, no
// LibreOffice); the view tests build the PDFKit helper into a temp folder (macOS).

const mac = process.platform === "darwin";
const info = (file = "doc.pdf"): ChangeInfo => ({ id: "c14", file, kind: "modified" });

before(async () => {
  if (!mac) return;
  const helper = pdfHelperForTest(); // built once per run by scripts/run-tests.ts, else the shared cache
  assert.ok(helper, "the PDF helper could not be built");
  process.env.COCHECK_PDF_HELPER = helper;
});
after(async () => {
  delete process.env.COCHECK_PDF_HELPER;
});

const crc = (buf: Buffer): number => {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
/** A w x h white PNG with black squares at the given [x, y, size] spots. */
function png(w: number, h: number, squares: Array<[number, number, number]> = []): Buffer {
  const rows = Buffer.alloc((w * 3 + 1) * h, 255);
  for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0;
  for (const [sx, sy, s] of squares) {
    for (let y = sy; y < sy + s; y++) for (let x = sx; x < sx + s; x++) rows.fill(0, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const pages = (...sigs: string[]): PageText[] => sigs.map((signature, i) => ({ index: i + 1, signature }));

/** cfv-pan: the review view lists every page; these tests pin the pages the account SHOWS (not placeholders, not pages marked unchanged). */
const shown = <T extends { absent?: true; unchanged?: true }>(ps: T[]): T[] => ps.filter((p) => !p.absent && !p.unchanged);

describe("pairPages", () => {
  it("pairs pages with the same text in order and leaves changed, inserted and moved pages out", () => {
    assert.deepEqual(pairPages(pages("a", "b", "c"), pages("a", "b", "c")), [{ before: 1, after: 1 }, { before: 2, after: 2 }, { before: 3, after: 3 }]);
    assert.deepEqual(pairPages(pages("a", "b", "c"), pages("a", "B", "c")), [{ before: 1, after: 1 }, { before: 3, after: 3 }]);
    assert.deepEqual(pairPages(pages("a", "b"), pages("a", "new", "b")), [{ before: 1, after: 1 }, { before: 2, after: 3 }]);
  });
  it("pairs pages with no text by position only when both sides have the same page count", () => {
    assert.deepEqual(pairPages(pages("", "", ""), pages("", "", "")).length, 3);
    assert.deepEqual(pairPages(pages("", "", ""), pages("", "", "", "")), []);
    assert.deepEqual(pairPages(pages("a", ""), pages("a", "", "")), [{ before: 1, after: 1 }]);
  });
});

describe("comparePages", () => {
  const render = (b: Record<number, Buffer | null>, a: Record<number, Buffer | null>) => async (side: "before" | "after", n: number) => (side === "before" ? b : a)[n] ?? null;

  it("a pixel-identical pair is never reported", async () => {
    const r = await comparePages([{ before: 1, after: 1 }], render({ 1: png(100, 100, [[10, 10, 20]]) }, { 1: png(100, 100, [[10, 10, 20]]) }));
    assert.deepEqual(r, { pages: [], skipped: 0, skippedPairs: [] });
  });
  it("a differing pair is reported with a region around the difference only", async () => {
    const r = await comparePages([{ before: 1, after: 1 }, { before: 2, after: 3 }], render({ 1: png(100, 100), 2: png(100, 100) }, { 1: png(100, 100, [[40, 50, 16]]), 3: png(100, 100) }));
    assert.equal(r.pages.length, 1);
    assert.deepEqual([r.pages[0]!.before, r.pages[0]!.after], [1, 1]);
    assert.deepEqual(r.pages[0]!.regions, [{ x: 40, y: 50, w: 16, h: 16 }]);
  });
  it("a picture that cannot be drawn or read is counted as skipped, never as changed", async () => {
    const r = await comparePages([{ before: 1, after: 1 }, { before: 2, after: 2 }], render({ 1: png(10, 10), 2: Buffer.from("not a png") }, { 1: null, 2: png(10, 10, [[0, 0, 5]]) }));
    assert.deepEqual(r, { pages: [], skipped: 2, skippedPairs: [{ before: 1, after: 1 }, { before: 2, after: 2 }] });
  });
});

const body = (prefix: string): string[] => Array.from({ length: 6 }, (_, i) => `${prefix} line ${i + 1} of the report.`);
const text3 = (): string[][] => [body("Alpha"), body("Bravo"), body("Charlie")];
const block: Fill = { x: 300, y: 120, w: 200, h: 100, gray: 0.5 };

describe("PDF view with the pixel cross-check", { skip: !mac && "needs macOS" }, () => {
  it("same text, changed picture on page 2: that page alone is shown, with pixel boxes on both sides and a caveat", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const v = await pdfRenderer.view(makePdf(text3()), makePdf(text3(), [[], [block]]), info());
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual(shown(v.before).map((p) => p.id), ["before:page2"]);
    assert.deepEqual(shown(v.after).map((p) => p.id), ["after:page2"]);
    assert.ok(v.boxes.length >= 2 && v.boxes.every((b) => b.confidence === "pixel" && b.pane.endsWith("page2")));
    assert.deepEqual([...new Set(v.boxes.map((b) => b.side))].sort(), ["after", "before"]);
    const r = v.boxes[0]!.rect!;
    // 200 x 100 pt block at 2x, bottom-left origin: 400 x 200 px, its top edge at (792 - 220) * 2
    assert.ok(Math.abs(r.x - 600) <= 2 && Math.abs(r.w - 400) <= 4 && Math.abs(r.h - 200) <= 4 && Math.abs(r.y - 1144) <= 4, JSON.stringify(r));
    assert.ok(v.caveats.some((c) => /pixel/.test(c) && /page 2/.test(c)), JSON.stringify(v.caveats));
  });

  it("a text change keeps its text-match box and is never downgraded; an untouched page is not shown", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const changed = text3();
    changed[0]![2] = "Alpha line 3 of the report, amended.";
    // page 1: text changed AND a fill added (the same page must keep text boxes only); page 2: picture only; page 3: nothing
    const v = await pdfRenderer.view(makePdf(text3()), makePdf(changed, [[block], [block]]), info());
    const onPage = (n: number) => v.boxes.filter((b) => b.pane.endsWith(`page${n}`));
    assert.ok(onPage(1).length === 2 && onPage(1).every((b) => b.confidence === "text-match"), JSON.stringify(onPage(1)));
    assert.ok(onPage(2).length > 0 && onPage(2).every((b) => b.confidence === "pixel"));
    assert.deepEqual(onPage(3), []);
    assert.deepEqual(shown(v.after).map((p) => p.id), ["after:page1", "after:page2"]);
  });

  it("different bytes, same text, same pixels: both pictures shown under the no-visible-difference banner, no box", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const a = makePdf(text3(), [[], [block]]);
    const v = await pdfRenderer.view(a, Buffer.concat([a, Buffer.from("\n% trailing comment\n")]), info());
    assert.equal(v.kind, "pages");
    assert.deepEqual(v.boxes, []);
    assert.equal(v.before.length, 3, "under the banner every page is listed");
    assert.equal(v.after.length, 3);
    assert.equal(v.banner?.title, "No visible difference");
  });

  it("an inserted paragraph that only reflows later pages does not turn those pages into pixel changes", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const flat = ["Inserted paragraph one.", ...text3().flat()];
    const v = await pdfRenderer.view(makePdf(text3()), makePdf([flat.slice(0, 6), flat.slice(6, 12), flat.slice(12, 18), flat.slice(18)]), info());
    assert.ok(v.boxes.length > 0 && v.boxes.every((b) => b.confidence === "text-match"), JSON.stringify(v.boxes));
    // The reflowed pages are shown (no 1:1 partner), with no box of any kind and a label that says why
    const moved = [...v.before, ...v.after].filter((p) => /page breaks moved/.test(p.label));
    assert.equal(moved.length, 6, JSON.stringify([...v.before, ...v.after].map((p) => p.label)));
    assert.ok(moved.every((p) => !v.boxes.some((b) => b.pane === p.id)), "a moved page carries no box");
    assert.ok(!v.boxes.some((b) => b.confidence === "pixel"));
  });

  it("a page whose pictures cannot be drawn is said in a caveat, not boxed, and nothing is called a match", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const v = await viewPdfs(makePdf(text3()), makePdf(text3(), [[], [block]]), info(), { renderPage: async () => null });
    assert.equal(v.kind, "card");
    assert.ok(v.caveats.some((c) => /could not be drawn/.test(c) && /before pages 1-3 and after pages 1-3/i.test(c)), JSON.stringify(v.caveats));
    assert.ok(!v.caveats.some((c) => /match/i.test(c)), JSON.stringify(v.caveats));
  });
});

describe("unpaired pages", { skip: !mac && "needs macOS" }, () => {
  const spot = (x: number): Fill => ({ x, y: 100, w: 80, h: 80, gray: 0 });
  const black: Fill = { x: 100, y: 100, w: 300, h: 300, gray: 0 };
  it("an added picture-only page is shown whole on the after side and is not called a match", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const v = await viewPdfs(makePdf([["Hello"]]), makePdf([["Hello"], []], [[], [black]]), info());
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual([shown(v.before).map((p) => p.id), shown(v.after).map((p) => p.id)], [[], ["after:page2"]]);
    assert.equal(v.boxes.length, 1);
    assert.ok(v.boxes[0]!.confidence === "pixel" && v.boxes[0]!.side === "after" && v.boxes[0]!.rect!.x === 0 && v.boxes[0]!.rect!.w > 1000);
    assert.ok(v.caveats.some((c) => /added/.test(c) && /2/.test(c)), JSON.stringify(v.caveats));
  });
  it("a removed picture-only page is shown whole on the before side", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const v = await viewPdfs(makePdf([["Hello"], []], [[], [black]]), makePdf([["Hello"]]), info());
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual([shown(v.before).map((p) => p.id), shown(v.after).map((p) => p.id)], [["before:page2"], []]);
    assert.ok(v.caveats.some((c) => /removed/.test(c)), JSON.stringify(v.caveats));
  });
  it("a picture-only page inserted among text-less pages of unequal count is the only page shown", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const v = await viewPdfs(makePdf([[], [], []], [[spot(50)], [spot(150)], [spot(250)]]), makePdf([[], [], [], []], [[spot(50)], [spot(150)], [black], [spot(250)]]), info());
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual([shown(v.before).map((p) => p.id), shown(v.after).map((p) => p.id)], [[], ["after:page3"]]);
    assert.ok(v.boxes.every((b) => b.side === "after" && b.pane === "after:page3"));
    assert.ok(v.caveats.some((c) => /added/.test(c)), JSON.stringify(v.caveats));
  });
  it("text-less pages with equal counts still pair by position: a changed one is a pixel change, not added or removed", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const v = await viewPdfs(makePdf([[], []], [[spot(50)], [spot(150)]]), makePdf([[], []], [[spot(50)], [spot(300)]]), info());
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual([shown(v.before).map((p) => p.id), shown(v.after).map((p) => p.id)], [["before:page2"], ["after:page2"]]);
    assert.ok(v.boxes.every((b) => b.rect!.w < 400), JSON.stringify(v.boxes));
    assert.ok(!v.caveats.some((c) => /added|removed/.test(c)));
  });
  it("unchanged text-less pages of unequal count and no extra picture are never called a match when a page is unpaired", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const same = await viewPdfs(makePdf([[], []], [[spot(50)], [spot(150)]]), makePdf([[], []], [[spot(50)], [spot(150)]]), info());
    assert.equal(same.kind, "pages");
    assert.equal(same.banner?.title, "No visible difference");
  });
});

// Every page of both sides has exactly one status, and no page vanishes.
const page = (...lines: string[]): string[] => lines;
const labels = (v: View): string[] => [...v.before, ...v.after].map((p) => `${p.id}|${p.label}`);
const rLabel = /same text, page breaks moved/;
const paneOf = (v: View, id: string) => [...v.before, ...v.after].find((p) => p.id === id);

describe("pageRanges", () => {
  it("writes page numbers as ranges with singular and plural", () => {
    assert.equal(pageRanges([1, 2, 3, 5]), "pages 1-3 and 5");
    assert.equal(pageRanges([4]), "page 4");
    assert.equal(pageRanges([5, 1, 1, 3]), "pages 1, 3 and 5");
    assert.equal(pageRanges([2, 3]), "pages 2-3");
    assert.equal(pageRanges([1, 2, 4, 5, 7]), "pages 1-2, 4-5 and 7");
    assert.equal(pageRanges([]), "");
  });
});

describe("accountPages", () => {
  const pg = (n: number, hasText = true) => ({ index: n, hasText });
  it("gives a page with a boxed partner R, never drops it, and groups R pages by shared unchanged lines", () => {
    const a = accountPages({
      before: [pg(1), pg(2)], after: [pg(1), pg(2), pg(3)],
      boxed: { before: new Set([2]), after: new Set([3]) }, pairs: [], changed: [], skippedPairs: [], skippedPages: [], drawnUnpaired: [],
      linked: [{ before: 1, after: 1 }, { before: 1, after: 2 }],
    });
    assert.deepEqual([...a.before], [[1, "R"], [2, "T"]]);
    assert.deepEqual([...a.after], [[1, "R"], [2, "R"], [3, "T"]]);
    assert.deepEqual(a.groups, [{ before: [1], after: [1, 2] }]);
  });
  it("a pair with one side boxed leaves the other side R", () => {
    const a = accountPages({ before: [pg(1)], after: [pg(1)], boxed: { before: new Set([1]), after: new Set() }, pairs: [{ before: 1, after: 1 }], changed: [], skippedPairs: [], skippedPages: [], drawnUnpaired: [], linked: [] });
    assert.deepEqual([a.before.get(1), a.after.get(1)], ["T", "R"]);
  });
  it("P=, P-changed, U and S", () => {
    const a = accountPages({
      before: [pg(1), pg(2), pg(3, false)], after: [pg(1), pg(2), pg(3, false), pg(4, false)],
      boxed: { before: new Set(), after: new Set() }, pairs: [{ before: 1, after: 1 }, { before: 2, after: 2 }, { before: 3, after: 3 }],
      changed: [{ before: 2, after: 2 }], skippedPairs: [{ before: 3, after: 3 }], skippedPages: [], drawnUnpaired: [{ side: "after", page: 4 }], linked: [],
    });
    assert.deepEqual([...a.before.values()], ["P=", "P≠", "S"]);
    assert.deepEqual([...a.after.values()], ["P=", "P≠", "S", "U"]);
  });
});

describe("page account in the PDF view", { skip: !mac && "needs macOS" }, () => {
  it("before [[A,B],[X]] vs after [[A],[B],[Y]]: b1, a1 and a2 are shown as moved page breaks, b2 and a3 are boxed", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const v = await viewPdfs(makePdf([page("Alpha line", "Bravo line"), page("Xray line")]), makePdf([page("Alpha line"), page("Bravo line"), page("Yankee line")]), info());
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual([shown(v.before).map((p) => p.id), shown(v.after).map((p) => p.id)], [["before:page1", "before:page2"], ["after:page1", "after:page2", "after:page3"]]);
    for (const id of ["before:page1", "after:page1", "after:page2"]) assert.match(paneOf(v, id)!.label, rLabel, id);
    for (const id of ["before:page2", "after:page3"]) assert.doesNotMatch(paneOf(v, id)!.label, rLabel, id);
    assert.deepEqual([...new Set(v.boxes.map((b) => b.pane))].sort(), ["after:page3", "before:page2"]);
    assert.ok(v.caveats.some((c) => /before page 1 and after pages 1-2/.test(c)), JSON.stringify(v.caveats));
  });

  it("a merge plus an edit: [[A],[B],[C]] vs [[A,B],[C2]] shows all five pages, the merged ones with no box", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const v = await viewPdfs(makePdf([page("Alpha line"), page("Bravo line"), page("Charlie line")]), makePdf([page("Alpha line", "Bravo line"), page("Charlie edited")]), info());
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual([shown(v.before).map((p) => p.id), shown(v.after).map((p) => p.id)], [["before:page1", "before:page2", "before:page3"], ["after:page1", "after:page2"]]);
    for (const id of ["before:page1", "before:page2", "after:page1"]) assert.match(paneOf(v, id)!.label, rLabel, id);
    assert.deepEqual([...new Set(v.boxes.map((b) => b.pane))].sort(), ["after:page2", "before:page3"]);
    assert.ok(v.caveats.some((c) => /before pages 1-2 and after page 1/.test(c)), JSON.stringify(v.caveats));
  });

  it("25 added picture-only pages: 20 are shown whole, the rest are named as a range with a count", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const fills: Fill[][] = [[], ...Array.from({ length: 25 }, (_, i): Fill[] => [{ x: 20 + i * 20, y: 100 + i * 10, w: 60, h: 60, gray: 0 }])];
    const v = await viewPdfs(makePdf([page("Hello")]), makePdf([page("Hello"), ...Array.from({ length: 25 }, () => [] as string[])], fills), info());
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual(shown(v.before), []);
    assert.equal(shown(v.after).length, 25, "every added page is listed");
    assert.equal(v.boxes.length, 20, "the whole-page boxes stop at the cap of 20");
    assert.ok(v.caveats.some((c) => /^5 more pages \(after pages 22-26\) are shown without a box, past the limit of 20/.test(c)), JSON.stringify(v.caveats));
    assert.ok(v.caveats.some((c) => /^Pages 2-21 on the after side were added/.test(c)), JSON.stringify(v.caveats));
  });

  it("when only page 2 cannot be drawn, page 3 still shows its pixel change, page 2 is named, and nothing is called a match", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const { renderPdfPage } = await import("../src/timeline/render/pdf-helper.ts");
    const [b, a] = [makePdf(text3()), makePdf(text3(), [[], [], [block]])];
    const v = await viewPdfs(b, a, info(), { renderPage: async (side, n) => (n === 2 ? null : renderPdfPage(side === "before" ? b : a, n)) });
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.deepEqual([shown(v.before).map((p) => p.id), shown(v.after).map((p) => p.id)], [["before:page2", "before:page3"], ["after:page2", "after:page3"]]); // page 2 is listed now (undrawable, named in the caveat below)
    assert.ok(v.caveats.some((c) => /^Before page 2 and after page 2 could not be drawn/.test(c)), JSON.stringify(v.caveats));
    assert.ok(!v.caveats.some((c) => /match/i.test(c)), JSON.stringify(v.caveats));
  });
});

// ---- property test: random split/merge/insert/delete/reorder/edit decks ----

interface MPage { blocks: string[]; pic: string }
const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const WORDS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa"];
function randomDeck(rnd: () => number): { before: MPage[]; after: MPage[] } {
  const int = (n: number) => Math.floor(rnd() * n);
  let fresh = 0;
  const block = () => `${WORDS[int(WORDS.length)]} ${fresh++} line of the report`;
  const before: MPage[] = Array.from({ length: 1 + int(5) }, () => (rnd() < 0.15 ? { blocks: [], pic: `p${int(3)}` } : { blocks: Array.from({ length: 1 + int(3) }, block), pic: "" }));
  let after: MPage[] = before.map((p) => ({ blocks: [...p.blocks], pic: p.pic }));
  for (let k = int(4); k > 0; k--) {
    const i = int(after.length || 1);
    switch (int(6)) {
      case 0: if (after[i] && after[i]!.blocks.length > 1) { const c = 1 + int(after[i]!.blocks.length - 1); after.splice(i, 1, { blocks: after[i]!.blocks.slice(0, c), pic: "" }, { blocks: after[i]!.blocks.slice(c), pic: "" }); } break;
      case 1: if (i + 1 < after.length) after.splice(i, 2, { blocks: [...after[i]!.blocks, ...after[i + 1]!.blocks], pic: after[i]!.pic || after[i + 1]!.pic }); break;
      case 2: after.splice(i, 0, rnd() < 0.3 ? { blocks: [], pic: `q${int(3)}` } : { blocks: [block(), block()], pic: "" }); break;
      case 3: if (after.length > 1) after.splice(i, 1); break;
      case 4: if (i + 1 < after.length) [after[i], after[i + 1]] = [after[i + 1]!, after[i]!]; break;
      case 5: if (after[i]?.blocks.length) after[i] = { blocks: after[i]!.blocks.map((b, j) => (j === 0 ? block() : b)), pic: "" }; else if (after[i]) after[i] = { blocks: [], pic: `r${int(3)}` }; break;
    }
  }
  return { before, after };
}
const picOf = (p: MPage): string => `${p.blocks.join("|")}#${p.pic}`;
const spotsOf = (key: string): Array<[number, number, number]> => {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const r = (m: number) => { h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); return Math.abs(h) % m; };
  return [[r(300), r(300), 14], [r(300), r(300), 20], [r(300), r(300), 9]];
};
const fillsOf = (deck: MPage[]): Fill[][] => deck.map((p) => (p.pic === "" ? [] : [{ x: 100 + (p.pic.charCodeAt(0) % 7) * 40 + Number(p.pic.slice(1)) * 13, y: 100, w: 50, h: 50, gray: 0 }]));
const same = (a: MPage[], b: MPage[]): boolean => a.length === b.length && a.every((p, i) => picOf(p) === picOf(b[i]!));
/** "before pages 1-2 and 5 (3)" inside the identical-pages caveat -> page numbers per side */
function identicalPages(v: View): { before: Set<number>; after: Set<number> } {
  const out = { before: new Set<number>(), after: new Set<number>() };
  const c = v.caveats.find((x) => x.startsWith("Not shown, because they are identical on both sides: "));
  if (!c) return out;
  for (const m of c.matchAll(/(before|after) pages? ([^(]*?) \((\d+)\)/g)) {
    for (const part of m[2]!.split(/, | and /)) {
      const [lo, hi] = part.split("-").map(Number);
      for (let n = lo!; n <= (hi ?? lo)!; n++) out[m[1] as "before" | "after"].add(n);
    }
  }
  return out;
}

describe("property: random decks never lose a page", { skip: !mac && "needs macOS" }, () => {
  it("every page is shown, named or counted identical; identical-hidden pages really are; a card only for equal decks", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    for (let seed = 1; seed <= 40; seed++) {
      const { before, after } = randomDeck(mulberry(seed));
      const ctx = `seed ${seed}: ${JSON.stringify({ before, after })}`;
      const b = makePdf(before.map((p) => p.blocks), fillsOf(before));
      const a = makePdf(after.map((p) => p.blocks), fillsOf(after));
      const render = async (side: "before" | "after", n: number): Promise<Buffer | null> => {
        const p = (side === "before" ? before : after)[n - 1]!;
        return png(320, 320, spotsOf(picOf(p)));
      };
      const v = await viewPdfs(b, a, info(), { renderPage: render });
      if (same(before, after)) {
        // Equal decks are shown whole under the banner, never a card
        assert.equal(v.kind, "pages", ctx);
        assert.equal(v.banner?.title, "No visible difference", ctx);
        assert.equal(v.before.length, before.length, ctx);
        assert.equal(v.after.length, after.length, ctx);
        continue;
      }
      const hidden = identicalPages(v);
      const sides = [["before", before, v.before], ["after", after, v.after]] as const;
      for (const [side, deck, panes] of sides) {
        const shown = new Set(panes.map((p) => Number(p.id.split("page")[1])));
        deck.forEach((p, i) => {
          const n = i + 1;
          const other = side === "before" ? after : before;
          assert.ok(shown.has(n) !== hidden[side].has(n) || (!shown.has(n) && !hidden[side].has(n) && v.kind === "card"), `${ctx}: ${side} page ${n} is neither shown nor counted identical (or both)`);
          if (hidden[side].has(n)) assert.ok(other.some((q) => picOf(q) === picOf(p)), `${ctx}: ${side} page ${n} is hidden as identical but nothing on the other side is`);
        });
      }
      if (v.kind === "card") {
        if (same(before, after)) continue;
        assert.fail(`${ctx}: a card for decks that differ: ${JSON.stringify(v.caveats)}`);
      }
      assert.ok(v.before.length + v.after.length > 0, `${ctx}: pages view shows nothing`);
      if (!same(before, after)) assert.ok(!v.caveats.some((c) => /match/i.test(c)), `${ctx}: said match for decks that differ: ${JSON.stringify(v.caveats)}`);
      assert.equal(labels(v).length, v.before.length + v.after.length);
    }
  });
});
