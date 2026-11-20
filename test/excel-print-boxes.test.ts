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
import { placePrintBoxes, printGrid, PRINT_BOX_PAD_PX, type PictureHeadings, type PrintBox } from "../src/office/connector/excel/print-boxes.ts";
import { rangeRect, readWorkbook, type Drawing, type Rect } from "../src/office/connector/excel/workbook.ts";
import { previousPrintGrid } from "../src/office/connector/excel/print-grid-previous.ts";
import type { PdfPage } from "../src/timeline/render/pdf-helper.ts";
import { levelFor, type ProgramDeps } from "../src/office/connector/program.ts";
import { fakePager, FIXTURES } from "./helpers/office-fake.ts";
import { printRig } from "./helpers/print-rig.ts";
import { drawPage, stubSheet, type DrawnPage } from "./helpers/print-page.ts";
import { decodePng } from "../src/connector/png-pixels.ts";

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
  it("a row whose height the file sets, drawn at another size, is refused", () => {
    // the file says row 6 is 30 pt but the page drew it at 15 pt: lines and labels agree with each other, not with the file
    const page = drawPage(stubSheet({ widths: SHEET.widths }), REGION);
    refuses(place(page, [box("a", 5, 3), box("b", 8, 3)], { sheet: stubSheet(SHEET) }), /row 6 is 28\.0 px but the file and the page's scale say 56\.0 px/);
  });
  it("a row whose height the file leaves unset may print taller (Excel fits it to a larger font), never shorter", () => {
    // taller: a title row in a 16 pt bold font, which the file gives no height
    const tall = drawPage(stubSheet(SHEET), REGION);
    const rc = rectOf(place(tall, [box("a", 6, 3)], { sheet: stubSheet({ widths: SHEET.widths }) })[0]!);
    assert.equal(rc.y + rc.h, tall.rows.get(6)![1] + PRINT_BOX_PAD_PX + 1);
    // shorter: no font makes Excel print an unsized row at a third of the default
    const short = drawPage(stubSheet({ heights: { 6: 5 }, widths: SHEET.widths }), REGION);
    refuses(place(short, [box("a", 5, 3)], { sheet: stubSheet({ widths: SHEET.widths }) }), /row 6|shorter than its number|row 6 cannot be tied/);
  });
  it("rows and columns that each fit the file but at two different scales: this finder refuses (one zoom prints both)", () => {
    // every row drawn at 15 pt while the file sets every row at 18 pt: the rows alone read as a page at 83%, the columns at 100%
    const all18 = Object.fromEntries([4, 5, 6, 7, 8, 9].map((r) => [r, 18]));
    const page = drawPage(stubSheet({ widths: SHEET.widths, heights: Object.fromEntries([4, 5, 6, 7, 8, 9].map((r) => [r, 15])) }), REGION);
    const g = printGrid(page.pixels, page.headings, REGION, stubSheet({ widths: SHEET.widths, heights: all18 }));
    assert.ok("why" in g && /the rows give the page a scale of 0\.833 and the columns 1\.000/.test(g.why), JSON.stringify("why" in g ? g.why : "fitted"));
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
});

describe("the grid is found by contrast and by the heading structure, not by a fixed darkness", () => {
  // every cell of the region lands on its own true lines, within `tol` pixels (a two-pixel grey line's centre is its half pixel)
  const allCells = (page: DrawnPage, o: { sheet?: ReturnType<typeof stubSheet>; tol?: number } = {}): void => {
    const tol = o.tol ?? 0;
    for (let r = REGION.r1; r <= REGION.r2; r++) for (let c = REGION.c1; c <= REGION.c2; c++) {
      const rc = rectOf(place(page, [box("x", r, c)], o.sheet ? { sheet: o.sheet } : {})[0]!);
      assert.ok(Math.abs(rc.x - (page.cols.get(c)![0] - PRINT_BOX_PAD_PX)) <= tol + 0.5, `col ${c}: ${JSON.stringify(rc)}`);
      assert.ok(Math.abs(rc.y - (page.rows.get(r)![0] - PRINT_BOX_PAD_PX)) <= tol + 0.5, `row ${r}: ${JSON.stringify(rc)}`);
      assert.ok(Math.abs(rc.x + rc.w - (page.cols.get(c)![1] + PRINT_BOX_PAD_PX + 1)) <= tol + 1, `col ${c} right: ${JSON.stringify(rc)}`);
      assert.ok(Math.abs(rc.y + rc.h - (page.rows.get(r)![1] + PRINT_BOX_PAD_PX + 1)) <= tol + 1, `row ${r} bottom: ${JSON.stringify(rc)}`);
    }
  };
  it("grey frame and heading lines (lighter than half grey) are found", () => {
    allCells(drawPage(stubSheet(SHEET), REGION, { heading: 170 }));
  });
  it("a light heading grey on a light-tinted theme (every cell filled) is found", () => {
    allCells(drawPage(stubSheet(SHEET), REGION, { heading: 200, body: 190, fill: 228 }));
  });
  it("dark-filled cells in the first column do not hide the gutter's edge", () => {
    allCells(drawPage(stubSheet(SHEET), REGION, { heading: 150, fill: { 2: 40 } }));
  });
  it("a chart over most of the rows and columns, with dark gridlines across it, does not move a line", () => {
    const sheet = stubSheet(SHEET);
    const page = drawPage(sheet, REGION, { heading: 170, covers: [{ cells: { r1: 5, r2: 9, c1: 2, c2: 6 } }] });
    // rows 5 to 9 of 4 to 9 (over 70% of the rows), every column, starting on the gutter's edge
    allCells(page);
  });
  it("a chart drawn from the gutter's edge across the whole body, past the last row, does not move a line", () => {
    const sheet = stubSheet(SHEET);
    const base = drawPage(sheet, REGION);
    const x0 = base.cols.get(2)![0] + 1, y0 = base.rows.get(5)![0] + 2;
    allCells(drawPage(sheet, REGION, { heading: 120, covers: [{ px: { x0, y0, x1: base.pixels.width - 1, y1: base.pixels.height - 1 } }] }));
  });
  for (const scale of [0.75, 1.5]) {
    it(`a page at zoom ${scale * 100} with grey anti-aliased lines is boxed on its lines`, () => {
      allCells(drawPage(stubSheet(SHEET), REGION, { scale, aa: true, heading: 120 }), { tol: 1 });
      allCells(drawPage(stubSheet(SHEET), REGION, { scale }));
    });
  }
  it("a page with no frame line left of the row numbers is boxed (the gutter's edge is the anchor, not the frame)", () => {
    allCells(drawPage(stubSheet(SHEET), REGION, { noFrame: true, heading: 140 }));
  });
  it("fails closed: no line between the row numbers and the first column", () => {
    refuses(place(drawPage(stubSheet(SHEET), REGION, { noGutterLine: true }), [box("a", 5, 3)]), /left of the first column letter|column band holds|not inside the row gutter|run down the page/);
  });
  it("fails closed: a stray line across the gutter through a row number", () => {
    const page = drawPage(stubSheet(SHEET), REGION);
    const y = Math.round((page.rows.get(6)![0] + page.rows.get(6)![1]) / 2);
    refuses(place(drawPage(stubSheet(SHEET), REGION, { strayGutter: [y] }), [box("a", 5, 3)]), /row 6.*line runs through/);
  });
  it("fails closed: a heading grey too faint to tell from the paper", () => {
    refuses(place(drawPage(stubSheet(SHEET), REGION, { heading: 245, body: 245 }), [box("a", 5, 3)]), /not found|column band|row gutter|not between two lines/);
  });
});

// A real Excel print page (Excel for Mac, headings on, zoom 66): Chart!A1:P50 of a workbook of public FRED series, with three charts over rows 4 to 50. Its line
// between the row numbers and column A prints grey (one anti-aliased pixel), the case that once tied rows 4 and 5 to the same two lines and left every change
// unplaced. The pictures are the stored ones; the page text (headings with per-character bounds) is from printing the same files again on the same Excel,
// whose picture matched the stored one to within 11 grey levels per pixel.
const FXP = path.join(import.meta.dirname, "fixtures", "excel-print");
const realPage = (side: "before" | "after"): { pixels: NonNullable<ReturnType<typeof decodePng>>; headings: PictureHeadings; sheet: ReturnType<typeof readWorkbook>["sheets"][number] } => {
  const { page, cut } = JSON.parse(readFileSync(path.join(FXP, `fred-charts-${side}.page.json`), "utf8")) as { page: PdfPage; cut: { x: number; y: number } };
  const h = headingsOf(page);
  const mv = (cs?: { c: string; x: number; y: number; w: number; h: number }[]) => (cs ? { chars: cs.map((c) => ({ ...c, x: c.x - cut.x, y: c.y - cut.y })) } : {});
  const headings: PictureHeadings = { rows: h.rows.map((r) => ({ n: r.n, y: r.y - cut.y, h: r.h, ...mv(r.chars) })), ...(h.cols ? { cols: { ...h.cols, x: h.cols.x - cut.x, y: h.cols.y - cut.y, ...mv(h.cols.chars) } } : {}) };
  const sheet = readWorkbook(readFileSync(path.join(FXP, `fred-charts-${side}.xlsx`))).sheets.find((s) => s.name === "Chart")!;
  return { pixels: decodePng(readFileSync(path.join(FXP, `fred-charts-${side}.png`)))!, headings, sheet };
};
const A1P50: Rect = { r1: 1, r2: 50, c1: 1, c2: 16 };
describe("a real Excel print page with charts over the grid and a grey gutter line", () => {
  for (const side of ["before", "after"] as const) {
    it(`${side}: every row 1-50 and column A-P is tied, on the lines the pixels show`, () => {
      const { pixels, headings, sheet } = realPage(side);
      const g = printGrid(pixels, headings, A1P50, sheet);
      if ("why" in g) return assert.fail(g.why);
      assert.equal(g.rowLines.size, 50);
      assert.equal(g.colLines.size, 16);
      // hand-read from the picture: the grey gutter line at x 55, black two-pixel lines at x 1034-1035 (O), 1104-1105 (P), 1174-1175 (the right frame);
      // the band's bottom line at y 43, row 1's bottom at y 64-65 (a 16 pt title row the file leaves unsized), row 2's at y 83, the bottom frame at y 970
      const near = (v: number, want: number, what: string): void => assert.ok(Math.abs(v - want) <= 1, `${what}: ${v} not near ${want}`);
      near(g.colLines.get(1)![0], 55, "A left"); near(g.colLines.get(15)![0], 1034.5, "O left"); near(g.colLines.get(16)![0], 1104.5, "P left"); near(g.colLines.get(16)![1], 1174.5, "P right");
      near(g.rowLines.get(1)![0], 43, "1 top"); near(g.rowLines.get(1)![1], 64.5, "1 bottom"); near(g.rowLines.get(2)![1], 83, "2 bottom"); near(g.rowLines.get(50)![1], 970, "50 bottom");
      // every printed row number sits between its own two lines
      for (const r of headings.rows) { const [a, b]: [number, number] = g.rowLines.get(r.n)!; assert.ok(a <= r.y + 2 && r.y + r.h - 2 <= b, `row ${r.n}`); }
    });
    it(`${side}: cells beside the charts are boxed on their lines; a cell change under a chart is refused`, () => {
      const { pixels, headings, sheet } = realPage(side);
      const [c2, p35, b10] = placePrintBoxes({ pixels, headings, region: A1P50, sheet, pages: 1, boxes: [box("c2", 2, 3), box("p35", 35, 16), box("b10", 10, 2)], pxPerPt: 1.32 });
      const rc = rectOf(c2!);
      assert.deepEqual([rc.x, rc.y], [193, 62]);
      assert.ok(Math.abs(rc.x + rc.w - (265 + PRINT_BOX_PAD_PX + 1)) <= 1 && Math.abs(rc.y + rc.h - (83 + PRINT_BOX_PAD_PX + 1)) <= 1, JSON.stringify(rc));
      rectOf(p35!);
      assert.match(whyOf(b10!), /under a chart or picture/);
    });
    it(`${side}: each of the three charts' changes is boxed on its own frame (the last one cut at the printed range)`, () => {
      const { pixels, headings, sheet } = realPage(side);
      // the step's own boxes, as the plan gives them: each chart change carries the chart's object name and its anchor range
      const boxes = [1, 2, 3].map((i): PlanBox => ({ change: `c${i}`, cells: sheet.drawings[i - 1]!.anchor!, drawing: `Chart ${i}` }));
      const got = placePrintBoxes({ pixels, headings, region: A1P50, sheet, pages: 1, boxes, pxPerPt: 2 * 66 / 100 });
      // the frames hand-read from the picture (each chart's grey border): left x 55, right x 1027.3; tops y 100.7, 396.3, 692; bottoms y 381.3, 677,
      // and the third runs past row 50, so it is cut at the bottom frame (y 970)
      const frames = [{ t: 100.7, b: 381.3 }, { t: 396.3, b: 677 }, { t: 692, b: 970 }];
      got.forEach((r, i) => {
        const rc = rectOf(r);
        const f = { l: 55, r: 1027.3, ...frames[i]! };
        const edges = [rc.x, rc.y, rc.x + rc.w - 1, rc.y + rc.h - 1], want = [f.l, f.t, f.r, f.b];
        // the box holds the whole border and sits no more than 5 px outside it on any side
        assert.ok(edges[0]! <= f.l && edges[1]! <= f.t && edges[2]! >= f.r && edges[3]! >= f.b, `chart ${i + 1}: ${JSON.stringify(rc)}`);
        for (let e = 0; e < 4; e++) assert.ok(Math.abs(edges[e]! - want[e]!) <= 5, `chart ${i + 1} edge ${e}: ${edges[e]} vs ${want[e]}`);
        assert.equal("clipped" in r && r.clipped, i === 2 ? true : false, `chart ${i + 1} clipped`);
      });
      // no box reaches the next chart's border
      assert.ok(rectOf(got[0]!).y + rectOf(got[0]!).h <= 396 && rectOf(got[1]!).y + rectOf(got[1]!).h <= 692);
    });
  }
  it("a chart is not boxed when the zoom the page was printed at disagrees with its lines, or is unknown", () => {
    const { pixels, headings, sheet } = realPage("after");
    const b: PlanBox = { change: "c1", cells: sheet.drawings[0]!.anchor!, drawing: "Chart 1" };
    assert.match(whyOf(placePrintBoxes({ pixels, headings, region: A1P50, sheet, pages: 1, boxes: [b], pxPerPt: 2 })[0]!), /lines show 1\.3\d\d px a point but its zoom gives 2\.000/);
    assert.match(whyOf(placePrintBoxes({ pixels, headings, region: A1P50, sheet, pages: 1, boxes: [b] })[0]!), /zoom the page was printed at is not known/);
  });
});

describe("drawings are boxed on their frames, from their anchors", () => {
  const EMU = 12700; // a point
  const corner = (col: number, row: number, colOffPt = 0, rowOffPt = 0) => ({ col, row, colOff: colOffPt * EMU, rowOff: rowOffPt * EMU });
  const chart = (name: string, place: Drawing["place"], anchor: Rect): Drawing => ({ kind: "chart", name, objectName: name, sha: name, anchor, ...(place ? { place } : {}) });
  // the frame at the page's scale (1 = 100%, 2 px a point): drawn on the page, and the box it must get
  const run = (d: Drawing, o: { region?: Rect; scale?: number; frame: (p: DrawnPage) => { x0: number; y0: number; x1: number; y1: number } }) => {
    const region = o.region ?? REGION, scale = o.scale ?? 1;
    const sheet = stubSheet({ ...SHEET, drawings: [d] });
    const plain = drawPage(sheet, region, { scale });
    const f = o.frame(plain);
    const page = drawPage(sheet, region, { scale, covers: [{ px: { x0: Math.round(f.x0), y0: Math.round(f.y0), x1: Math.round(f.x1), y1: Math.round(f.y1) } }] });
    const r = placePrintBoxes({ pixels: page.pixels, headings: page.headings, region, sheet, pages: 1, boxes: [{ change: "d", cells: d.anchor!, drawing: d.objectName! }], pxPerPt: 2 * scale })[0]!;
    return { r, f, page };
  };
  const exact = (r: PrintBox, f: { x0: number; y0: number; x1: number; y1: number }, clipped = false): void => {
    const rc = rectOf(r);
    assert.deepEqual(rc, { x: Math.floor(f.x0 - PRINT_BOX_PAD_PX), y: Math.floor(f.y0 - PRINT_BOX_PAD_PX), w: Math.ceil(f.x1 + PRINT_BOX_PAD_PX + 1) - Math.floor(f.x0 - PRINT_BOX_PAD_PX), h: Math.ceil(f.y1 + PRINT_BOX_PAD_PX + 1) - Math.floor(f.y0 - PRINT_BOX_PAD_PX) });
    assert.equal("clipped" in r && r.clipped === true, clipped);
  };
  it("a two-cell anchor: each corner on its cell's lines plus its offset", () => {
    // from C5 + (10 pt, 3 pt) to E8 + (5 pt, 0)
    const d = chart("Chart 1", { kind: "twoCell", from: corner(2, 4, 10, 3), to: corner(4, 7, 5, 0) }, { r1: 5, c1: 3, r2: 8, c2: 5 });
    const { r, f } = run(d, { frame: (p) => ({ x0: p.cols.get(3)![0] + 20, y0: p.rows.get(5)![0] + 6, x1: p.cols.get(5)![0] + 10, y1: p.rows.get(8)![0] }) });
    exact(r, f);
  });
  it("a one-cell anchor: its corner on the cell's lines, its size in EMU at the page's zoom (here 75%)", () => {
    const d = chart("Chart 1", { kind: "oneCell", from: corner(2, 4), ext: { cx: 100 * EMU, cy: 40 * EMU } }, { r1: 5, c1: 3, r2: 7, c2: 4 });
    const { r, f } = run(d, { scale: 0.75, frame: (p) => ({ x0: p.cols.get(3)![0], y0: p.rows.get(5)![0], x1: p.cols.get(3)![0] + 150, y1: p.rows.get(5)![0] + 60 }) });
    exact(r, f);
  });
  it("an absolute anchor: measured from A1's corner when the picture prints from A1, refused otherwise", () => {
    const A1: Rect = { r1: 1, r2: 6, c1: 1, c2: 5 };
    const d = chart("Pic", { kind: "absolute", pos: { x: 50 * EMU, y: 20 * EMU }, ext: { cx: 60 * EMU, cy: 30 * EMU } }, { r1: 2, c1: 2, r2: 4, c2: 3 });
    const { r, f } = run(d, { region: A1, frame: (p) => ({ x0: p.cols.get(1)![0] + 100, y0: p.rows.get(1)![0] + 40, x1: p.cols.get(1)![0] + 220, y1: p.rows.get(1)![0] + 100 }) });
    exact(r, f);
    const { r: r2 } = run(d, { frame: (p) => ({ x0: p.cols.get(2)![0] + 10, y0: p.rows.get(4)![0] + 10, x1: p.cols.get(3)![0], y1: p.rows.get(5)![1] }) });
    assert.match(whyOf(r2), /measured from cell A1/);
  });
  it("pictures and shapes take the same path", () => {
    const pic: Drawing = { kind: "image", name: "Picture 2", sha: "p", anchor: { r1: 5, c1: 3, r2: 6, c2: 4 }, place: { kind: "twoCell", from: corner(2, 4), to: corner(3, 5) } };
    const { r, f } = run({ ...pic, objectName: "Picture 2" }, { frame: (p) => ({ x0: p.cols.get(3)![0], y0: p.rows.get(5)![0], x1: p.cols.get(4)![0], y1: p.rows.get(6)![0] }) });
    exact(r, f);
  });
  it("a frame that runs past the printed range is cut at its edge and marked clipped; one that starts before it is cut there too", () => {
    const past = chart("Chart 1", { kind: "twoCell", from: corner(3, 6, 4, 2), to: corner(9, 13) }, { r1: 7, c1: 4, r2: 14, c2: 10 });
    const a = run(past, { frame: (p) => ({ x0: p.cols.get(4)![0] + 8, y0: p.rows.get(7)![0] + 4, x1: p.cols.get(6)![1], y1: p.rows.get(9)![1] }) });
    exact(a.r, a.f, true);
    const before = chart("Chart 1", { kind: "twoCell", from: corner(0, 0), to: corner(3, 5, 6, 0) }, { r1: 1, c1: 1, r2: 6, c2: 4 });
    const b = run(before, { frame: (p) => ({ x0: p.cols.get(2)![0], y0: p.rows.get(4)![0], x1: p.cols.get(4)![0] + 12, y1: p.rows.get(6)![0] }) });
    exact(b.r, b.f, true);
  });
  it("fails closed: a one-cell frame that starts outside the picture, a frame with no readable anchor, two drawings of one name", () => {
    const d = chart("Chart 1", { kind: "oneCell", from: corner(0, 0), ext: { cx: 400 * EMU, cy: 200 * EMU } }, { r1: 1, c1: 1, r2: 8, c2: 5 });
    assert.match(whyOf(run(d, { frame: (p) => ({ x0: p.cols.get(2)![0], y0: p.rows.get(4)![0], x1: p.cols.get(4)![0], y1: p.rows.get(6)![0] }) }).r), /starts outside the printed cells/);
    const none = chart("Chart 1", undefined, { r1: 5, c1: 3, r2: 6, c2: 4 });
    assert.match(whyOf(run(none, { frame: (p) => ({ x0: p.cols.get(3)![0], y0: p.rows.get(5)![0], x1: p.cols.get(4)![0], y1: p.rows.get(6)![0] }) }).r), /anchor in the file could not be read/);
    const one = chart("Chart 1", { kind: "twoCell", from: corner(2, 4), to: corner(3, 5) }, { r1: 5, c1: 3, r2: 6, c2: 4 });
    const sheet = stubSheet({ ...SHEET, drawings: [one, { ...one, sha: "y" }] });
    const page = drawPage(sheet, REGION);
    assert.match(whyOf(placePrintBoxes({ pixels: page.pixels, headings: page.headings, region: REGION, sheet, pages: 1, boxes: [{ change: "d", cells: one.anchor!, drawing: "Chart 1" }], pxPerPt: 2 })[0]!), /two drawings on the sheet have its name/);
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

// Safety net, to be removed with print-grid-previous.ts once the contrast finder is verified on real Windows print pictures: when the contrast finder
// refuses a page, the earlier finder is asked; its grid places cell boxes if it fits under its own checks. Drawings are never boxed from it.
describe("when this finder refuses a page, the earlier finder is the fallback for cell boxes", () => {
  const all18 = Object.fromEntries([4, 5, 6, 7, 8, 9].map((r) => [r, 18]));
  const page = () => drawPage(stubSheet({ widths: SHEET.widths, heights: Object.fromEntries([4, 5, 6, 7, 8, 9].map((r) => [r, 15])) }), REGION);
  const sheet = () => stubSheet({ widths: SHEET.widths, heights: all18 });
  it("the contrast finder refuses and the earlier one fits: the cell is boxed where the earlier finder places it", () => {
    const p = page();
    assert.ok("why" in printGrid(p.pixels, p.headings, REGION, sheet()));
    const prev = previousPrintGrid(p.pixels, p.headings, REGION, sheet());
    assert.ok(!("why" in prev), JSON.stringify(prev));
    const rc = rectOf(place(p, [box("a", 5, 3)], { sheet: sheet() })[0]!);
    const R = prev.rowLines.get(5)!, C = prev.colLines.get(3)!;
    assert.deepEqual(rc, { x: Math.floor(C[0] - PRINT_BOX_PAD_PX), y: Math.floor(R[0] - PRINT_BOX_PAD_PX), w: Math.ceil(C[1] + PRINT_BOX_PAD_PX + 1) - Math.floor(C[0] - PRINT_BOX_PAD_PX), h: Math.ceil(R[1] + PRINT_BOX_PAD_PX + 1) - Math.floor(R[0] - PRINT_BOX_PAD_PX) });
    // and that is the page's own cell: within a pixel of the lines it was drawn on
    assert.ok(Math.abs(rc.x - (p.cols.get(3)![0] - PRINT_BOX_PAD_PX)) <= 1 && Math.abs(rc.y - (p.rows.get(5)![0] - PRINT_BOX_PAD_PX)) <= 1, JSON.stringify(rc));
  });
  it("on the earlier finder's grid a drawing is not boxed: its words are the contrast finder's refusal", () => {
    const d: Drawing = { kind: "chart", name: "Chart 1", objectName: "Chart 1", sha: "c", anchor: { r1: 8, c1: 5, r2: 9, c2: 6 } };
    const s = stubSheet({ widths: SHEET.widths, heights: all18, drawings: [d] });
    const p = drawPage(stubSheet({ widths: SHEET.widths, heights: Object.fromEntries([4, 5, 6, 7, 8, 9].map((r) => [r, 15])), drawings: [d] }), REGION);
    const [chartBox, cellBox] = placePrintBoxes({ pixels: p.pixels, headings: p.headings, region: REGION, sheet: s, pages: 1, boxes: [{ change: "d", cells: d.anchor!, drawing: "Chart 1" }, box("a", 5, 3)], pxPerPt: 2 });
    assert.match(whyOf(chartBox!), /not marked: the rows give the page a scale/);
    rectOf(cellBox!);
  });
  it("both refuse: every change on the picture is unplaced, with the contrast finder's words", () => {
    const s = stubSheet({ ...SHEET, hiddenRows: [7] });
    const p = drawPage(s, REGION, { skipRows: [7] });
    assert.ok("why" in printGrid(p.pixels, p.headings, REGION, s));
    assert.ok("why" in previousPrintGrid(p.pixels, p.headings, REGION, s));
    refuses(place(p, [box("a", 5, 3), box("b", 8, 3)], { sheet: s }), /row 7 is hidden/);
    // a page whose labels stop short of the region: both refuse it too
    const short = drawPage(stubSheet(SHEET), { ...REGION, r2: 7 });
    assert.ok("why" in previousPrintGrid(short.pixels, short.headings, REGION, stubSheet(SHEET)));
    refuses(place(short, [box("a", 5, 3)]), /labels rows 4 to 7 but the file's region is rows 4 to 9/);
  });
});
