// boxes on Excel's print pages. Guards against: a box on the wrong cell that the reviewer trusts (a refusal costs only the
// words "not marked"). Every refusal below has its own test; the pages are drawn by test/helpers/print-page.ts the way Excel's print pages are built (probe pictures).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { answerExcel, headingsOf, type Cropper, type PageReader } from "../src/office/connector/excel/answer.ts";
import type { PlanBox } from "../src/office/connector/excel/diff.ts";
import { placePrintBoxes, PRINT_BOX_PAD_PX, type PrintBox } from "../src/office/connector/excel/print-boxes.ts";
import { rangeRect, readWorkbook, type Rect } from "../src/office/connector/excel/workbook.ts";
import type { PdfPage } from "../src/timeline/render/pdf-helper.ts";
import { levelFor, type ProgramDeps } from "../src/office/connector/program.ts";
import { fakePager, FIXTURES } from "./helpers/office-fake.ts";
import { printRig } from "./helpers/print-rig.ts";
import { drawPage, stubSheet, type DrawnPage } from "./helpers/print-page.ts";

const REGION: Rect = { r1: 4, r2: 9, c1: 2, c2: 6 };
const SHEET = { heights: { 6: 30 }, widths: { 2: 13, 4: 20, 6: 13 } };
const box = (id: string, r1: number, c1: number, r2 = r1, c2 = c1): PlanBox => ({ change: id, cells: { r1, c1, r2, c2 } });
const place = (page: DrawnPage, boxes: PlanBox[], o: { sheet?: ReturnType<typeof stubSheet>; pages?: number; region?: Rect } = {}): PrintBox[] =>
  placePrintBoxes({ pixels: page.pixels, headings: page.headings, region: o.region ?? REGION, sheet: o.sheet ?? stubSheet(SHEET), pages: o.pages ?? 1, boxes });
const rectOf = (r: PrintBox): { x: number; y: number; w: number; h: number } => { assert.ok("rect" in r, JSON.stringify(r)); return r.rect; };
const whyOf = (r: PrintBox): string => { assert.ok("why" in r, `expected a refusal, got ${JSON.stringify(r)}`); return r.why; };
const refuses = (rs: PrintBox[], re: RegExp): void => { for (const r of rs) { if (process.env.SHOW_WHY) console.log("WHY", whyOf(r)); assert.match(whyOf(r), re); } };

describe("a box on a print page sits on the page's own cell lines", () => {
  it("D6:E7 is boxed from its tied lines, padded outward, to the pixel", () => {
    const page = drawPage(stubSheet(SHEET), REGION);
    const [r] = place(page, [box("c1", 6, 4, 7, 5)]);
    const rc = rectOf(r!);
    const top = page.rows.get(6)![0], bot = page.rows.get(7)![1], left = page.cols.get(4)![0], right = page.cols.get(5)![1];
    assert.equal(rc.x, left - PRINT_BOX_PAD_PX);
    assert.equal(rc.y, top - PRINT_BOX_PAD_PX);
    assert.equal(rc.x + rc.w, right + PRINT_BOX_PAD_PX + 1);
    assert.equal(rc.y + rc.h, bot + PRINT_BOX_PAD_PX + 1);
  });
  it("every cell of the region lands on its own lines (no neighbour)", () => {
    const page = drawPage(stubSheet(SHEET), REGION);
    for (let r = REGION.r1; r <= REGION.r2; r++) for (let c = REGION.c1; c <= REGION.c2; c++) {
      const rc = rectOf(place(page, [box("x", r, c)])[0]!);
      assert.equal(rc.x, page.cols.get(c)![0] - PRINT_BOX_PAD_PX, `col ${c}`);
      assert.equal(rc.y, page.rows.get(r)![0] - PRINT_BOX_PAD_PX, `row ${r}`);
    }
  });
  it("a change that runs past the region is boxed on the part inside it, marked clipped", () => {
    const page = drawPage(stubSheet(SHEET), REGION);
    const r = place(page, [box("c", 8, 5, 12, 5)])[0]!;
    assert.ok("rect" in r && r.clipped === true);
  });
});

describe("zoomed pages: the scale is read from the page's own lines", () => {
  it("a page printed at 50% with grey two-pixel separators is boxed correctly although its zoom field says 100", () => {
    const page = drawPage(stubSheet(SHEET), REGION, { scale: 0.5, aa: true });
    const [r] = place(page, [box("z", 6, 4, 7, 5)]);
    const rc = rectOf(r!);
    const left = page.cols.get(4)![0], right = page.cols.get(5)![1], top = page.rows.get(6)![0], bot = page.rows.get(7)![1];
    // the weighted centre of a two-row line is its half pixel: within one pixel of the true edge, plus the pad
    assert.ok(Math.abs(rc.x - (left - PRINT_BOX_PAD_PX)) <= 1 && Math.abs(rc.x + rc.w - (right + PRINT_BOX_PAD_PX + 1)) <= 1.5, JSON.stringify(rc));
    assert.ok(Math.abs(rc.y - (top - PRINT_BOX_PAD_PX)) <= 1 && Math.abs(rc.y + rc.h - (bot + PRINT_BOX_PAD_PX + 1)) <= 1.5, JSON.stringify(rc));
  });
  it("a row the page draws at a size the file and the page's scale do not give is refused", () => {
    const page = drawPage(stubSheet({ ...SHEET, heights: { 6: 30 } }), REGION);
    // the file says row 6 is 15 pt but the page drew it at 30 pt: lines and labels agree with each other, not with the file
    refuses(place(page, [box("a", 5, 3), box("b", 8, 3)], { sheet: stubSheet({ widths: SHEET.widths }) }), /row 6|row \d/);
  });
});

describe("a planted shifted label is refused", () => {
  it("one number drawn across a line is not tied", () => {
    const page = drawPage(stubSheet(SHEET), REGION, { edit: (h) => { const l = h.rows.find((r) => r.n === 7)!; l.y += 18; for (const c of l.chars!) c.y += 18; } });
    refuses(place(page, [box("a", 5, 3), box("b", 7, 3)]), /row 7|line runs through/);
  });
  it("every number shifted down one row (labels still consecutive) leaves the first row without its number", () => {
    const even = stubSheet({ widths: SHEET.widths });
    const page = drawPage(even, REGION, { edit: (h) => { for (const r of h.rows) { r.y += 28; for (const c of r.chars!) c.y += 28; } } });
    refuses(place(page, [box("a", 5, 3), box("b", 9, 3)], { sheet: even }), /row 4|row 9|labels rows/);
  });
  it("labels that start a row late (the page was cut one row off) are refused whole", () => {
    const page = drawPage(stubSheet(SHEET), { ...REGION, r1: 5, r2: 10 }, {});
    refuses(place(page, [box("a", 6, 3), box("b", 9, 4)]), /labels rows 5 to 10 but the file's region is rows 4 to 9/);
  });
  it("a column letter run shifted one letter is refused", () => {
    const page = drawPage(stubSheet(SHEET), REGION, { edit: (h) => { h.cols!.text = "C D E F G"; } });
    refuses(place(page, [box("a", 5, 3)]), /columns C to G but the file's region is columns B to F|inside its own column lines|no glyph/);
  });
});

describe("short or fused row numbers are refused", () => {
  // rows 1-2 are 3 pt tall: their numbers cannot sit between their lines
  const shortSheet = (): ReturnType<typeof stubSheet> => stubSheet({ heights: { 1: 3, 2: 3 }, widths: SHEET.widths });
  const R12: Rect = { r1: 1, r2: 12, c1: 2, c2: 4 };
  it("a number that does not fit its short row is refused, and so is every box on the picture", () => {
    const page = drawPage(shortSheet(), R12, { edit: (h) => { for (const l of h.rows) if (l.n <= 2) { l.y -= 6; l.h = 14; for (const c of l.chars!) { c.y -= 6; c.h = 14; } } } });
    refuses(place(page, [box("a", 5, 3), box("b", 1, 3)], { sheet: shortSheet(), region: R12 }), /row 1|row 2|shorter than its number/);
  });
  it("two short rows whose numbers fuse into the real row number 12 are refused (digits stacked, not side by side)", () => {
    // the page prints "1" and "2" on top of each other in the two short rows; PDFKit reads them as one run "12" that a page reader hands to row 12's place
    const tall = stubSheet({ widths: SHEET.widths });
    const page = drawPage(tall, R12, {
      edit: (h) => {
        const twelve = h.rows.find((r) => r.n === 12)!;
        twelve.chars = [{ c: "1", x: 32, y: twelve.y, w: 8, h: twelve.h }, { c: "2", x: 32, y: twelve.y + 3, w: 8, h: twelve.h }];
      },
    });
    refuses(place(page, [box("a", 12, 3), box("b", 9, 3)], { sheet: tall, region: R12 }), /row 12.*not side by side/);
  });
  it("short rows 1 and 2 whose numbers are fused into one run in the place of row 12 are refused whole", () => {
    const page = drawPage(shortSheet(), R12, {
      edit: (h) => {
        const twelve = h.rows.find((r) => r.n === 12)!;
        h.rows = h.rows.filter((r) => r.n > 2 && r.n !== 12);
        h.rows.push({ n: 12, y: twelve.y, h: twelve.h, chars: [{ c: "1", x: 32, y: twelve.y, w: 8, h: twelve.h }, { c: "2", x: 32, y: twelve.y + 3, w: 8, h: twelve.h }] });
      },
    });
    refuses(place(page, [box("a", 12, 3), box("b", 9, 3)], { sheet: shortSheet(), region: R12 }), /row 1|row 12|labels rows/);
  });
  it("without the fusing, the same page with real numbers in a tall enough row 12 is boxed (the refusal is the digits, not the page)", () => {
    const tall = stubSheet({ widths: SHEET.widths });
    const page = drawPage(tall, R12);
    assert.ok("rect" in place(page, [box("a", 12, 3)], { sheet: tall, region: R12 })[0]!);
  });
  it("a multi-digit number with no per-digit bounds is not trusted", () => {
    const page = drawPage(stubSheet(SHEET), { ...REGION, r1: 8, r2: 12 }, { edit: (h) => { for (const l of h.rows) delete l.chars; } });
    refuses(place(page, [box("a", 10, 3)], { region: { ...REGION, r1: 8, r2: 12 } }), /per-digit bounds/);
  });
});

describe("hidden rows or columns, a second page and charts are refused", () => {
  it("a hidden row in the region refuses the picture", () => {
    const sheet = stubSheet({ ...SHEET, hiddenRows: [7] });
    const page = drawPage(sheet, REGION, { skipRows: [7] });
    refuses(place(page, [box("a", 5, 3), box("b", 8, 3)], { sheet }), /row 7 is hidden/);
  });
  it("a hidden column in the region refuses the picture", () => {
    const sheet = stubSheet({ ...SHEET, hiddenCols: [3] });
    const page = drawPage(sheet, { ...REGION, c2: 5 }, {});
    refuses(place(page, [box("a", 5, 4)], { sheet }), /column C is hidden/);
  });
  it("a region that printed on a second page is refused, though the first page's labels are fine", () => {
    const page = drawPage(stubSheet(SHEET), REGION);
    refuses(place(page, [box("a", 5, 3)], { pages: 2 }), /printed on 2 pages/);
  });
  it("a first page that holds only part of the region is refused by its labels", () => {
    const page = drawPage(stubSheet(SHEET), { ...REGION, r2: 7 });
    refuses(place(page, [box("a", 5, 3)]), /labels rows 4 to 7 but the file's region is rows 4 to 9/);
  });
  it("cells under a chart are refused; a cell beside it is still boxed", () => {
    const sheet = stubSheet({ ...SHEET, anchors: [{ r1: 6, r2: 8, c1: 4, c2: 5 }] });
    const page = drawPage(sheet, REGION);
    const [under, beside] = place(page, [box("u", 7, 4), box("s", 5, 3)], { sheet });
    assert.match(whyOf(under!), /under a chart or picture/);
    rectOf(beside!);
  });
  it("a chart's own change is not boxed on a print page", () => {
    const page = drawPage(stubSheet(SHEET), REGION);
    const [r] = place(page, [{ change: "ch", cells: { r1: 5, r2: 7, c1: 3, c2: 4 }, drawing: "Chart 1" }]);
    assert.match(whyOf(r!), /chart/);
  });
});

describe("merged cells", () => {
  it("the whole merge when all its outer lines are tied on the picture", () => {
    const sheet = stubSheet({ ...SHEET, merges: [{ r1: 5, c1: 3, r2: 6, c2: 4 }] });
    const page = drawPage(sheet, REGION);
    const rc = rectOf(place(page, [box("m", 5, 3)], { sheet })[0]!);
    assert.equal(rc.x, page.cols.get(3)![0] - PRINT_BOX_PAD_PX);
    assert.equal(rc.x + rc.w, page.cols.get(4)![1] + PRINT_BOX_PAD_PX + 1);
    assert.equal(rc.y + rc.h, page.rows.get(6)![1] + PRINT_BOX_PAD_PX + 1);
  });
  it("the anchor cell only when the merge runs past the picture", () => {
    const sheet = stubSheet({ ...SHEET, merges: [{ r1: 8, c1: 3, r2: 11, c2: 4 }] });
    const page = drawPage(sheet, REGION);
    const rc = rectOf(place(page, [box("m", 8, 3)], { sheet })[0]!);
    assert.equal(rc.x + rc.w, page.cols.get(3)![1] + PRINT_BOX_PAD_PX + 1);
    assert.equal(rc.y + rc.h, page.rows.get(8)![1] + PRINT_BOX_PAD_PX + 1);
  });
  it("a cell hidden inside a merge is not boxed", () => {
    const sheet = stubSheet({ ...SHEET, merges: [{ r1: 5, c1: 3, r2: 6, c2: 4 }] });
    const page = drawPage(sheet, REGION);
    assert.match(whyOf(place(page, [box("m", 6, 4)], { sheet })[0]!), /merged cell/);
  });
});

describe("headingsOf carries the per-character bounds the helper gives", () => {
  it("chars pass through on the digit runs and the column letter run", () => {
    const ch = (c: string, x: number) => ({ c, x, y: 40, w: 8, h: 12 });
    const page: PdfPage = { index: 1, width: 100, height: 100, runs: [
      { text: "B C", x: 100, y: 40, w: 40, h: 12, chars: [ch("B", 100), ch("C", 130)] },
      { text: "12", x: 20, y: 80, w: 18, h: 12, chars: [ch("1", 20), ch("2", 29)] },
      { text: "13", x: 20, y: 100, w: 18, h: 12 },
    ] };
    const h = headingsOf(page);
    assert.equal(h.cols?.chars?.length, 2);
    assert.equal(h.rows[0]?.chars?.length, 2);
    assert.equal(h.rows[1]?.chars, undefined);
  });
});

// ---- the answer: the print route carries boxes, and says "not marked" only where a change is unplaced ----
const FX = path.join(import.meta.dirname, "fixtures", "excel-look");
describe("the print answer carries boxes (level 3)", () => {
  it("levelFor says 3 for Excel, Word and PowerPoint", () => {
    assert.equal(levelFor(OFFICE_APPS.excel), 3);
    assert.equal(levelFor(OFFICE_APPS.word), 3);
    assert.equal(levelFor(OFFICE_APPS.powerpoint), 3);
  });
  const OX = 12, OY = 12;
  const wb = readWorkbook(readFileSync(path.join(FX, "answer-gdp-after.xlsx")));
  const sheet = wb.sheets.find((s) => s.kind === "worksheet")!;
  const areas = (pdf: Buffer): Rect[] => {
    const m = /^%PDF-fake \S+ \S+ (\S+) (\S+)$/.exec(pdf.toString("latin1"));
    return m ? m[2]!.split(",").map((r) => rangeRect(r.replace(/\$/g, ""))!) : [];
  };
  const pageOf = (pdf: Buffer, n: number): DrawnPage => drawPage(sheet, areas(pdf)[n - 1]!);
  const crop: Cropper = async (pdf, n) => { const p = pageOf(pdf, n); return { png: p.png, x: OX, y: OY, w: p.pixels.width, h: p.pixels.height, pageWidth: 1224, pageHeight: 1584 }; };
  const pages: PageReader = async (pdf) => areas(pdf).map((_, i): PdfPage => {
    const p = pageOf(pdf, i + 1), hd = p.headings;
    const mv = (cs?: { c: string; x: number; y: number; w: number; h: number }[]) => (cs ? { chars: cs.map((c) => ({ ...c, x: c.x + OX, y: c.y + OY })) } : {});
    return { index: i + 1, width: 1224, height: 1584, runs: [{ text: hd.cols!.text, x: hd.cols!.x + OX, y: hd.cols!.y + OY, w: hd.cols!.w, h: hd.cols!.h, ...mv(hd.cols!.chars) }, ...hd.rows.map((r) => ({ text: String(r.n), x: 32 + OX, y: r.y + OY, w: 9 * String(r.n).length, h: r.h, ...mv(r.chars) }))] };
  });
  const run = async (): Promise<{ doc: Awaited<ReturnType<typeof answerExcel>> }> => {
    const rig = printRig();
    const deps: ProgramDeps = { driver: rig.driver, pager: fakePager, crop, pages, lockPath: rig.lockPath, pollMs: 5, goneWaitMs: 300, lockWaitMs: 200 };
    return { doc: await answerExcel(OFFICE_APPS.excel, path.join(FX, "answer-gdp-before.xlsx"), path.join(FX, "answer-gdp-after.xlsx"), deps) };
  };
  it("a changed cell of the pair carries a box on the after picture, and the document passes level 3", async () => {
    const { doc } = await run();
    const withBoxes = doc.changes.filter((c) => Array.isArray((c as { boxes?: unknown[] }).boxes) && (c as unknown as { boxes: unknown[] }).boxes.length > 0);
    assert.ok(withBoxes.length > 0, JSON.stringify({ changes: doc.changes, caveats: doc.caveats }));
    assert.deepEqual(checkChanges(doc, 3), []);
    // F7 changed value: a box on each side, inside its own picture, on the cell's own lines
    const f7 = doc.changes.find((c) => c.label === "GDP!F7") as unknown as { boxes: { picture: string; rect: { x: number; y: number; w: number; h: number } }[] };
    assert.equal(f7.boxes.length, 2, JSON.stringify(f7));
    for (const b of f7.boxes) {
      const pic = (doc.pictures as unknown as { id: string; width: number; height: number }[]).find((p) => p.id === b.picture)!;
      assert.ok(b.rect.x >= 0 && b.rect.y >= 0 && b.rect.x + b.rect.w <= pic.width && b.rect.y + b.rect.h <= pic.height);
    }
  });
  it("a picture whose every change is boxed has no 'not marked' caveat; a picture with an unplaced change keeps it", async () => {
    const { doc } = await run();
    const pics = (doc.pictures ?? []) as unknown as { id: string; label: string }[];
    const boxed = new Set(doc.changes.flatMap((c) => ((c as { boxes?: { picture: string }[] }).boxes ?? []).map((b) => b.picture)));
    assert.ok(pics.length > 0 && boxed.size > 0, `no picture carries a box: ${JSON.stringify(doc.caveats)}`);
    for (const p of pics) {
      const said = doc.caveats.includes(`${p.label}: changes are not marked on this picture.`);
      const unplaced = doc.changes.some((c) => (c as { unplaced?: unknown }).unplaced !== undefined);
      if (!boxed.has(p.id)) assert.ok(said, `${p.label} has no box and must say so`);
      else if (!unplaced) assert.ok(!said, `${p.label} is fully boxed and must not say it is unmarked: ${JSON.stringify(doc.caveats)}`);
    }
  });
});
