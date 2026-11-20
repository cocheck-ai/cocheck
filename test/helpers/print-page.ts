// A synthetic Excel print page, drawn the way Excel's print pages are built (the probe's pictures: black frame and heading lines, grey body gridlines, one text run for the
// column letters and one per row number, each with per-character bounds). Test helper only; the sizes come from the sheet by the same print model the code under test reads.
import { encodePng } from "../../src/office/connector/excel/look.ts";
import { decodePng, type Pixels } from "../../src/connector/png-pixels.ts";
import { PRINT_ROW_K, printedWidthPt } from "../../src/office/connector/excel/diff.ts";
import type { HeadingChar, PictureHeadings } from "../../src/office/connector/excel/print-boxes.ts";
import { heightPt, type Drawing, type Rect, type Sheet } from "../../src/office/connector/excel/workbook.ts";

export const PAD = 24, BAND = 30, GUTTER = 50;
const colName = (n: number): string => { let s = ""; for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s; };

export function stubSheet(o: { heights?: Record<number, number>; widths?: Record<number, number>; hiddenRows?: number[]; hiddenCols?: number[]; merges?: Rect[]; anchors?: Rect[]; drawings?: Drawing[] } = {}): Sheet {
  return {
    heights: new Map(Object.entries(o.heights ?? {}).map(([k, v]) => [Number(k), v] as const)), defaultHeight: 15,
    widths: new Map(Object.entries(o.widths ?? {}).map(([k, v]) => [Number(k), v] as const)), defaultWidth: 8.43,
    hiddenRows: new Set(o.hiddenRows ?? []), hiddenCols: new Set(o.hiddenCols ?? []), merges: o.merges ?? [],
    drawings: [...(o.anchors ?? []).map((anchor) => ({ kind: "chart", name: "Chart", sha: "x", xml: "", anchor })), ...(o.drawings ?? [])],
  } as unknown as Sheet;
}

export interface DrawnPage {
  png: Buffer;
  pixels: Pixels;
  headings: PictureHeadings;
  /** The true line centres the picture was drawn with. */
  rows: Map<number, [number, number]>;
  cols: Map<number, [number, number]>;
}

/** A chart drawn over cells: a white plot with a grey border and dark gridlines across it, as Excel prints one. `px` places it by picture pixels instead of cells. */
export interface Cover { cells?: Rect; px?: { x0: number; y0: number; x1: number; y1: number } }

/**
 * `scale`: the page's zoom as a fraction (1 = 100%). `aa`: the separators print grey over two pixel rows, as they do under 100%. `edit` changes the printed numbers and letters.
 * `heading`: the grey of the frame and the heading lines (0, black, by default). `body`: the grey of the cell gridlines. `fill`: a fill grey for every cell, or per column.
 * `covers`: charts drawn over the cells. `noFrame`: no frame line left of the row numbers. `strayGutter`: extra lines drawn across the row gutter at these y.
 */
export function drawPage(sheet: Sheet, region: Rect, o: { scale?: number; aa?: boolean; skipRows?: number[]; edit?: (h: PictureHeadings) => void; seed?: string; heading?: number; body?: number; fill?: number | Record<number, number>; covers?: Cover[]; noFrame?: boolean; noGutterLine?: boolean; strayGutter?: number[] } = {}): DrawnPage {
  const s = o.scale ?? 1, aa = o.aa ?? false, hd = o.heading ?? 0, bd = o.body ?? 86;
  const rowsN: number[] = [], colsN: number[] = [];
  for (let r = region.r1; r <= region.r2; r++) if (!(o.skipRows ?? []).includes(r)) rowsN.push(r);
  for (let c = region.c1; c <= region.c2; c++) colsN.push(c);
  const rowPx = (r: number): number => Math.round(2 * heightPt(sheet, r) * PRINT_ROW_K * s);
  const colPx = (c: number): number => Math.round(2 * printedWidthPt(sheet, c) * s);
  const yBand = PAD + BAND, xGut = PAD + GUTTER;
  const ys: number[] = [yBand]; for (const r of rowsN) ys.push(ys[ys.length - 1]! + rowPx(r));
  const xs: number[] = [xGut]; for (const c of colsN) xs.push(xs[xs.length - 1]! + colPx(c));
  const W = xs[xs.length - 1]! + PAD + 2, H = ys[ys.length - 1]! + PAD + 2;
  const rgba = Buffer.alloc(W * H * 4, 255);
  const put = (x: number, y: number, v: number): void => { const i = (y * W + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255; };
  const yBottom = ys[ys.length - 1]!, xRight = xs[xs.length - 1]!;
  const hline = (y: number, x0: number, x1: number, v: number): void => { for (let x = x0; x <= x1; x++) put(x, y, v); };
  const vline = (x: number, y0: number, y1: number, v: number): void => { for (let y = y0; y <= y1; y++) put(x, y, v); };
  // cell fills, under every line
  if (o.fill !== undefined) colsN.forEach((c, j) => {
    const v = typeof o.fill === "number" ? o.fill : o.fill?.[c];
    if (v !== undefined) for (let y = yBand + 1; y <= yBottom; y++) for (let x = xs[j]! + 1; x < xs[j + 1]!; x++) put(x, y, v);
  });
  // frame and heading lines: black unless `heading` says a grey
  hline(PAD, PAD, xRight + 1, hd); hline(yBand, PAD, xRight + 1, hd); if (!o.noFrame) vline(PAD, PAD, yBottom + 1, hd); if (!o.noGutterLine) vline(xGut, PAD, yBottom + 1, hd);
  // row separators: the heading grey across the gutter, the body grey across the cells; two grey pixel rows when anti-aliased
  const centreOf = (p: number): number => p + (aa ? 0.5 : 0);
  const aaOf = (v: number): number => (aa ? Math.max(v, 200) : v);
  ys.slice(1).forEach((y) => { for (let d = 0; d < (aa ? 2 : 1); d++) { hline(y + d, PAD, xGut, aaOf(hd)); hline(y + d, xGut + 1, xRight + 1, aaOf(bd)); } });
  xs.slice(1).forEach((x) => { for (let d = 0; d < (aa ? 2 : 1); d++) { vline(x + d, PAD, yBand, aaOf(hd)); vline(x + d, yBand + 1, yBottom + 1, aaOf(bd)); } });
  for (const y of o.strayGutter ?? []) hline(y, PAD + 1, xGut - 1, hd);
  const rows = new Map<number, [number, number]>(), cols = new Map<number, [number, number]>();
  rowsN.forEach((r, i) => rows.set(r, [centreOf(ys[i]!), centreOf(ys[i + 1]!)]));
  colsN.forEach((c, i) => cols.set(c, [centreOf(xs[i]!), centreOf(xs[i + 1]!)]));
  // cell content: a light fill per cell keyed by the seed, so two files with different content draw different pictures (lighter than any heading line)
  if (o.seed !== undefined) {
    let h0 = 0; for (const ch of o.seed) h0 = (h0 * 31 + ch.charCodeAt(0)) >>> 0;
    rowsN.forEach((r, i) => colsN.forEach((c, j) => {
      const v = 200 + (((h0 ^ (r * 7919) ^ (c * 104729)) >>> 0) % 30);
      for (let y = ys[i]! + 4; y < ys[i + 1]! - 3; y++) for (let x = xs[j]! + 4; x < xs[j + 1]! - 3; x++) put(x, y, v);
    }));
  }
  // charts over the cells: a white plot, a grey border, dark gridlines across most of its width and a dark vertical axis down its height
  for (const cv of o.covers ?? []) {
    const r = cv.px ?? (() => { const c = cv.cells!; const i0 = rowsN.indexOf(c.r1), i1 = rowsN.indexOf(c.r2), j0 = colsN.indexOf(c.c1), j1 = colsN.indexOf(c.c2); return { x0: xs[j0]! + 3, y0: ys[i0]! + 3, x1: xs[j1 + 1]! - 3, y1: ys[i1 + 1]! - 3 }; })();
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) put(x, y, 255);
    hline(r.y0, r.x0, r.x1, 160); hline(r.y1, r.x0, r.x1, 160); vline(r.x0, r.y0, r.y1, 160); vline(r.x1, r.y0, r.y1, 160);
    for (let y = r.y0 + 12; y < r.y1 - 6; y += 11) hline(y, r.x0 + 30, r.x1 - 10, 40);
    vline(r.x0 + 30, r.y0 + 6, r.y1 - 6, 20);
  }
  // glyphs of the column letters: ink blocks in each interval of the band
  const letters = colsN.map(colName);
  const chars: HeadingChar[] = letters.map((c, i) => { const cx = Math.round((xs[i]! + xs[i + 1]!) / 2); return { c, x: cx - 4, y: PAD + 8, w: 8, h: 12 }; });
  for (const c of chars) for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) put(x, y, 0);
  const rowLabels: PictureHeadings["rows"] = rowsN.map((r, i) => {
    const text = String(r), top = ys[i]!, hh = Math.max(2, rowPx(r) - 8);
    return { n: r, y: top + 4, h: hh, chars: [...text].map((ch, k) => ({ c: ch, x: PAD + 8 + k * 9, y: top + 4, w: 8, h: hh })) };
  });
  const headings: PictureHeadings = { rows: rowLabels, cols: { text: letters.join(" "), x: chars[0]!.x, y: PAD + 8, w: chars[chars.length - 1]!.x + 8 - chars[0]!.x, h: 12, chars } };
  o.edit?.(headings);
  const png = encodePng(W, H, rgba);
  return { png, pixels: decodePng(png)!, headings, rows, cols };
}
