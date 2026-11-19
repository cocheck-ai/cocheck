// The platform-agnostic PDF reader (public-kit/helpers/pdf-text.mjs), the one reader on every OS: the Office connectors read page text, find Word's
// paragraphs and crop Excel's pages with it, and the OS only draws pages (pdf.mjs). Guard: a connector that silently gets null (no
// boxes, no crop) where the reader exists, or a crop that is not the drawn page's own pixels. Its outputs on Office's PDFs are pinned in
// test/pdf-reader-golden.slow.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { decodePng } from "../public-kit/helpers/png.mjs";
import { cropPdfPage, encodePng, findPdfParagraphs, inkBox, pdfTextAvailable, readDrawnPdfText, readPdfText } from "../public-kit/helpers/pdf-text.mjs";
import { findInPages, glyphSpans, layoutPage, pageRuns, type PdfJsItem } from "../public-kit/helpers/pdf-text-layout.mjs";
import { helperPager } from "../src/office/connector/pictures.ts";
import { helperCropper, helperPageReader, headingsOf } from "../src/office/connector/excel/answer.ts";
import { fold, readWordParas } from "../src/office/connector/word-boxes.ts";
import { queriesFor } from "./helpers/pdf-golden.ts";
import { ensurePdfHelper } from "../scripts/lib/pdf-helper-cache.ts";

const ROOT = path.join(import.meta.dirname, "..");
const FIX = path.join(ROOT, "test", "fixtures", "pdf-reader");
const fixture = (name: string): Buffer => readFileSync(path.join(FIX, name));

// the macOS page drawer (pages are checked against the sizes it draws): the runner's cached build, or this file's own when it runs alone
if (process.platform === "darwin") process.env.COCHECK_PDF_HELPER ??= ensurePdfHelper() ?? undefined;
const pdfjsOnly = <T>(body: () => Promise<T>): Promise<T> => body();

describe("pdf-reader: one reader on every OS", () => {
  it("pdf.js is installed with this checkout, so the reader is available on any OS", () => {
    assert.equal(pdfTextAvailable(), true);
  });
  it("no Office manifest passes a reader switch any more: there is one reader", () => {
    for (const id of ["microsoft-excel", "microsoft-word", "microsoft-powerpoint"]) {
      const m = JSON.parse(readFileSync(path.join(ROOT, "connectors", id, "cocheck-connector.json"), "utf8")) as { permissions?: { env?: string[] } };
      assert.ok(!(m.permissions?.env ?? []).some((v) => /PDF_READER/.test(v)), id);
    }
  });
});

describe("pdf-reader: the connectors' own entry points answer through the pdf.js reader", () => {
  it("Word: page texts and the paragraph finder (helperPager) answer, not null", async () => {
    const pdf = fixture("word-memo.pdf");
    const texts = await pdfjsOnly(() => helperPager.pages(pdf));
    assert.ok(texts !== null && texts.length === 1, "no page text");
    assert.match(texts[0]!, /Assembly line two/);
    const queries = queriesFor(readWordParas(fixture("word-memo.docx")).paras, fold);
    const found = await pdfjsOnly(() => helperPager.find!(pdf, queries));
    assert.ok(found !== null, "the finder answered null");
    assert.equal(found.results.length, queries.length);
    assert.ok(found.results.every((r) => r.found), JSON.stringify(found.results.filter((r) => !r.found).map((r) => r.id)));
  });

  it("Excel: the page reader gives the printed row numbers (multi-digit, with per-digit chars) and the column letters as one run", async () => {
    const pages = await pdfjsOnly(() => helperPageReader(fixture("excel-print-rows116.pdf")));
    assert.ok(pages !== null && pages.length === 2, "no pages");
    const h = headingsOf(pages[0]!);
    assert.deepEqual(h.rows.map((r) => r.n), [116, 117, 118, 119, 120, 121, 122, 123, 124, 125]);
    assert.ok(h.rows.every((r) => r.chars?.length === 3), "a row number has no per-digit chars");
    assert.equal(h.cols?.text, "A B C D E");
    assert.deepEqual(h.cols?.chars?.map((c) => c.c), ["A", "B", "C", "D", "E"]);
  });
});

describe("pdf-reader: Excel's crop through the pdf.js reader", { skip: process.platform !== "darwin" && "the page is drawn by the macOS helper here" }, () => {
  it("helperCropper cuts the page drawn by this OS's backend with the reader's own encoder", async () => {
    // the page is drawn by the macOS helper: the runner's cached build, or this file's own when it runs alone
    process.env.COCHECK_PDF_HELPER ??= ensurePdfHelper() ?? undefined;
    {
      const cut = await helperCropper(fixture("excel-print-series.pdf"), 1);
      assert.ok(cut !== null && !("empty" in cut), "no crop");
      const px = decodePng(cut.png)!;
      assert.equal(px.width, cut.w);
      assert.equal(px.height, cut.h);
      // the reader's encoder is fixed (filter 0, level 6): the bytes are exactly what it makes from these pixels, which the Swift helper's are not
      assert.ok(cut.png.equals(encodePng(px.width, px.height, px.rgba)), "the crop did not come from the pdf.js reader");
    }
  });
});

describe("pdf-text.mjs: the crop rule and the encoder", () => {
  const pixels = (w: number, h: number, ink: Array<[number, number]>): { width: number; height: number; rgba: Buffer } => {
    const rgba = Buffer.alloc(w * h * 4, 255);
    for (const [x, y] of ink) rgba.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    return { width: w, height: h, rgba };
  };
  it("the box holds every pixel under 245 in any channel, grown by the pad and clamped to the picture; a blank picture has none", () => {
    assert.deepEqual(inkBox(pixels(20, 10, [[5, 3], [8, 6]]), 2), { x: 3, y: 1, w: 8, h: 8 });
    assert.deepEqual(inkBox(pixels(20, 10, [[0, 0], [19, 9]]), 4), { x: 0, y: 0, w: 20, h: 10 });
    const faint = pixels(4, 4, []);
    faint.rgba[(1 * 4 + 1) * 4 + 2] = 245; // 245 is not ink
    assert.equal(inkBox(faint, 0), null);
    faint.rgba[(1 * 4 + 1) * 4 + 2] = 244;
    assert.deepEqual(inkBox(faint, 0), { x: 1, y: 1, w: 1, h: 1 });
    // a page left transparent (a backend that does not draw on white) is blank where nothing is drawn
    const clear = { width: 6, height: 4, rgba: Buffer.alloc(6 * 4 * 4, 0) };
    assert.equal(inkBox(clear, 0), null);
    clear.rgba[(2 * 6 + 3) * 4 + 3] = 255; // one opaque black pixel
    assert.deepEqual(inkBox(clear, 1), { x: 2, y: 1, w: 3, h: 3 });
  });

  it("cropPdfPage cuts the drawn page to that box (pad in points at 2 px a point), says empty for a blank page and null when nothing is drawn", async () => {
    const page = pixels(40, 30, [[10, 12], [20, 14]]);
    const render = async () => encodePng(page.width, page.height, page.rgba);
    const cut = await cropPdfPage(Buffer.from("%PDF"), 1, 1, { render });
    assert.ok(cut !== null && !("empty" in cut));
    assert.deepEqual({ x: cut.x, y: cut.y, w: cut.w, h: cut.h, pageWidth: cut.pageWidth, pageHeight: cut.pageHeight }, { x: 8, y: 10, w: 15, h: 7, pageWidth: 40, pageHeight: 30 });
    const px = decodePng(cut.png)!;
    assert.deepEqual([px.width, px.height], [15, 7]);
    assert.equal(px.rgba[(2 * 15 + 2) * 4], 0, "the ink pixel moved");
    assert.deepEqual(await cropPdfPage(Buffer.from("%PDF"), 1, 1, { render: async () => encodePng(5, 5, Buffer.alloc(100, 255)) }), { empty: true });
    assert.equal(await cropPdfPage(Buffer.from("%PDF"), 1, 1, { render: async () => null }), null);
    assert.equal(await cropPdfPage(Buffer.from("%PDF"), 0, 1, { render }), null);
  });

  it("the warm child: a call past its time limit answers timeout and the next call works on a fresh child; a parent with an idle child exits", async () => {
    const pdf = fixture("word-report-4pages.pdf");
    assert.deepEqual(await readPdfText(pdf, { timeoutMs: 1 }), { pages: null, error: "timeout" });
    const again = await readPdfText(pdf);
    assert.equal(again.error, null);
    assert.equal(again.pages?.length, 4);
    // a separate Node that reads once and returns: it must end by itself while its child is idle (the child never holds the parent open)
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const k = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "public-kit", "helpers", "pdf-text.mjs")).href)}); const fs = await import("node:fs"); const r = await k.readPdfText(fs.readFileSync(${JSON.stringify(path.join(FIX, "word-memo.pdf"))})); console.log(r.pages.length);`], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.stdout.trim(), "1", r.stderr);
    assert.ok(Date.now() - t0 < 15_000, "the parent waited for its idle child");
  });

  it("concurrent callers: one call's time limit never fails another; a call's limit counts from when the child starts it, not from when it waited", async () => {
    const memo = fixture("word-memo.pdf"), report = fixture("word-report-4pages.pdf");
    const [ok, short] = await Promise.all([readPdfText(memo), readPdfText(fixture("powerpoint-deck.pdf"), { timeoutMs: 1 })]);
    assert.equal(ok.error, null, "a normal read beside a timed-out one came back failed");
    assert.equal(ok.pages?.length, 1);
    assert.equal(short.error, "timeout");
    // a read queued behind slow work keeps its own limit: twenty reads at once, each with a limit only one of them needs
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => readPdfText(i % 2 ? memo : report, { timeoutMs: 2_000 })));
    assert.ok(many.every((r) => r.error === null), JSON.stringify(many.map((r) => r.error)));
  });

  it("a child that dies mid-request (not by a time limit) is replaced and the request retried once, so the caller still gets its pages", { skip: process.platform === "win32" && "the child is found with ps" }, () => {
    // a separate Node: start a read on a cold child, kill that child from outside while it works, and print what the read answered
    const kit = JSON.stringify(pathToFileURL(path.join(ROOT, "public-kit", "helpers", "pdf-text.mjs")).href);
    const pdf = JSON.stringify(path.join(FIX, "word-report-4pages.pdf"));
    const code = `
      const { execFileSync } = await import("node:child_process");
      const k = await import(${kit}); const fs = await import("node:fs");
      const p = k.readPdfText(fs.readFileSync(${pdf}));
      let killed = 0;
      for (let i = 0; i < 200 && killed === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
        for (const l of execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\\n")) {
          const m = /^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$/.exec(l);
          if (m && Number(m[2]) === process.pid && m[3].includes("--cocheck-pdf-text-child")) { process.kill(Number(m[1]), "SIGKILL"); killed++; }
        }
      }
      const r = await p;
      console.log(JSON.stringify({ killed, error: r.error, pages: r.pages?.length ?? null }));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 60_000 });
    const out = JSON.parse(r.stdout.trim() || "{}") as { killed?: number; error?: string | null; pages?: number | null };
    assert.equal(out.killed, 1, r.stderr);
    assert.deepEqual({ error: out.error, pages: out.pages }, { error: null, pages: 4 });
  });

  it("readDrawnPdfText keeps pdf.js's runs only on the pages the OS draws: the same count and sizes within 2 px; otherwise the drawer's pages with no runs", async () => {
    const pdf = fixture("word-memo.pdf");
    const backend = (sizes: Array<[number, number]> | "failed") => ({
      available: () => true, textRuns: false, pdfjs: true, engine: "test drawer",
      pages: async () => (sizes === "failed" ? ("failed" as const) : { pages: sizes.map(([width, height], i) => ({ index: i + 1, width, height })) }),
      png: async () => "failed" as const,
    });
    const same = await readDrawnPdfText(pdf, { backend: backend([[1225, 1583]]) });
    assert.equal(same.textRuns, true);
    assert.ok(same.pages![0]!.runs.length > 0);
    for (const sizes of [[[1230, 1584]], [[1224, 1584], [1224, 1584]]] as Array<Array<[number, number]>>) {
      const off = await readDrawnPdfText(pdf, { backend: backend(sizes) });
      assert.equal(off.textRuns, false, JSON.stringify(sizes));
      assert.deepEqual(off.pages!.map((p) => [p.width, p.height, p.runs.length]), sizes.map(([w, h]) => [w, h, 0]));
    }
    assert.deepEqual(await readDrawnPdfText(pdf, { backend: backend("failed") }), { pages: null, error: "failed", textRuns: false });
  });

  it("readPdfText and findPdfParagraphs answer null-shaped for bytes that are not a PDF, never throw", async () => {
    assert.deepEqual(await readPdfText(Buffer.from("not a pdf")), { pages: null, error: "failed" });
    assert.equal(await findPdfParagraphs(Buffer.from("not a pdf"), [{ id: "0", text: "x" }]), null);
  });
});

describe("pdf-text-layout.mjs: glyph positions from the operator list", () => {
  const OPS = { save: 1, restore: 2, transform: 3, beginText: 4, setTextMatrix: 5, setFont: 6, setCharSpacing: 7, setWordSpacing: 8, setHScale: 9, setTextRise: 10, setLeading: 11, showText: 12, paintFormXObjectBegin: 13, paintFormXObjectEnd: 14, moveText: 15, nextLine: 16 };
  const glyph = (u: string, width = 500) => ({ unicode: u, width, isSpace: u === " " });
  const item = (str: string, x: number, y: number, size: number, width: number): PdfJsItem => ({ str, transform: [size, 0, 0, size, x, y], width, height: size, hasEOL: false, fontName: "f" });
  const ops = (list: Array<[keyof typeof OPS, unknown[]]>) => ({ fnArray: list.map(([k]) => OPS[k]), argsArray: list.map(([, a]) => a) });

  it("Q restores the whole text state q saved (character spacing, word spacing, scale, rise, leading, font size), not only the matrix", () => {
    const o = ops([
      ["setFont", ["f", 10]], ["save", []], ["setFont", ["f", 30]], ["setCharSpacing", [5]], ["setWordSpacing", [9]], ["setHScale", [50]], ["setTextRise", [4]], ["restore", []],
      ["beginText", []], ["setTextMatrix", [[1, 0, 0, 1, 100, 700]]], ["showText", [[glyph("a"), glyph(" "), glyph("b")]]],
    ]);
    const spans = glyphSpans(o, OPS, [item("a b", 100, 700, 10, 15)])!;
    // each glyph advances 500/1000 x 10 = 5 units: the size, spacing and scale set inside q...Q are gone
    assert.deepEqual(spans[0], [[0, 5], [5, 10], [10, 15]]);
  });

  it("text inside a form XObject sits where the form's matrix puts it, and the state after the form is the state before it (justified words keep their places)", () => {
    const o = ops([
      ["setFont", ["f", 10]], ["paintFormXObjectBegin", [[1, 0, 0, 1, 50, 0], [0, 0, 600, 800]]], ["setWordSpacing", [7]],
      ["beginText", []], ["setTextMatrix", [[1, 0, 0, 1, 100, 700]]], ["showText", [[glyph("a"), glyph(" "), glyph("b")]]], ["paintFormXObjectEnd", []],
      ["beginText", []], ["setTextMatrix", [[1, 0, 0, 1, 100, 600]]], ["showText", [[glyph("c"), glyph(" "), glyph("d")]]],
    ]);
    // the form moves its text 50 units right; its word spacing (7) widens its space only, and does not leak out of the form
    const spans = glyphSpans(o, OPS, [item("a b", 150, 700, 10, 22), item("c d", 100, 600, 10, 15)])!;
    assert.deepEqual(spans[0], [[0, 5], [5, 17], [17, 22]]);
    assert.deepEqual(spans[1], [[0, 5], [5, 10], [10, 15]]);
  });

  it("an item whose letters the glyphs do not spell gets null (the layout falls back to the font's advances for it alone)", () => {
    const o = ops([["setFont", ["f", 10]], ["beginText", []], ["setTextMatrix", [[1, 0, 0, 1, 0, 0]]], ["showText", [[glyph("x"), glyph("y")]]]]);
    assert.deepEqual(glyphSpans(o, OPS, [item("q", 0, 0, 10, 5), item("xy", 0, 0, 10, 10)]), [null, [[0, 5], [5, 10]]]);
  });
});

describe("pdf-text-layout.mjs: the finder's list labels", () => {
  const vp = { width: 1224, height: 1584, transform: [2, 0, 0, -2, 0, 1584] };
  const styles = { f: { ascent: 0.9, descent: -0.2 } };
  const it_ = (str: string, x: number, y: number, eol: boolean): PdfJsItem => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10, hasEOL: eol, fontName: "f" });
  const INTRO = "Intro paragraph that comes first on the page";
  const NEXT = "Center Staff Inventions shall be reported promptly";
  /** Line 2 holds `label` then the paragraph: as its own item 40 units to the left (a list label), or flowing in the paragraph's item. */
  const found = (label: string, apart: boolean): boolean => {
    const items = [it_(INTRO, 72, 700, true), ...(apart ? [it_(label, 72, 680, false), it_(NEXT, 112, 680, true)] : [it_(`${label} ${NEXT}`, 72, 680, true)])];
    const page = layoutPage({ viewport: vp, styles, items });
    return findInPages([page], [{ id: "0", text: INTRO }, { id: "1", text: NEXT }]).results[1]!.found;
  };
  it("a multi-level number, a number-letter, a closing parenthesis and a roman numeral are labels when they stand apart from the paragraph", () => {
    for (const label of ["5.4", "5.a", "1.1)", "XIII."]) assert.equal(found(label, true), true, label);
  });
  it("a decimal flowing into the paragraph's words is text, not a label: the paragraph that does not start with it is not placed there", () => {
    assert.equal(found("1.5", false), false);
    assert.equal(found("3.14", false), false);
  });
  it("the helper's own short markers still count inline (\"3.\", \"a)\")", () => {
    for (const label of ["3.", "a)"]) assert.equal(found(label, false), true, label);
  });
});

describe("pdf-text-layout.mjs: runs as the helper groups them", () => {
  const vp = { width: 1000, height: 200, transform: [2, 0, 0, -2, 0, 200] };
  const styles = { f: { ascent: 0.9, descent: -0.2 } };
  const item = (str: string, x: number, width: number, eol = false): PdfJsItem => ({ str, transform: [10, 0, 0, 10, x, 80], width, height: 10, hasEOL: eol, fontName: "f" });
  it("a gap wider than one font size ends a run; a narrower one does not", () => {
    const runs = pageRuns(layoutPage({ viewport: vp, styles, items: [item("Revenue", 10, 40), item(" ", 50, 8), item("12", 58, 10), item(" ", 68, 30), item("15", 98, 10, true)] }));
    assert.deepEqual(runs.map((r) => r.text), ["Revenue 12", "15"]);
  });
  it("a line of column letters is one run whatever the gaps, with one char per letter at its own place", () => {
    const runs = pageRuns(layoutPage({ viewport: vp, styles, items: [item("A", 10, 6), item(" ", 16, 2), item("B", 90, 6), item(" ", 96, 2), item("AA", 170, 12, true)] }));
    assert.deepEqual(runs.map((r) => r.text), ["A B AA"]);
    assert.deepEqual(runs[0]!.chars!.map((c) => c.c), ["A", "B", "A", "A"]);
    assert.equal(Math.round(runs[0]!.chars![1]!.x), 180);
  });
  it("characters take their font's own advances when the widths are known (character spacing shared equally)", () => {
    const run = pageRuns(layoutPage({ viewport: vp, styles, widths: { f: { "1": 500, "7": 600 } }, items: [item("117", 10, 17, true)] }))[0]!;
    // advances 5, 5, 6 (per 1000 em at size 10) plus 1/3 each of the item's 1 unit of spacing, in pixels at 2x
    assert.deepEqual(run.chars!.map((c) => Number(c.w.toFixed(3))), [10.667, 10.667, 12.667]);
  });
});
