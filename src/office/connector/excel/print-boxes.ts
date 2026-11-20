// Boxes on Excel's print pages (level 3). Pure: a decoded picture, the printed headings with per-character bounds,
// and the file's own sheet in; boxes in the picture's pixels, or words, out. Platform-free.
//
// Must not happen: a box on the wrong cell that the reviewer trusts. A refusal costs only the words "not marked". Structural rule: a box edge exists only
// where a separator line is found in the page's own pixels AND is tied to printed heading labels on both sides of it (a row line to the row number above and the row
// number below it, a column line to the letters left and right of it). Any doubt refuses: the change gets no box on that picture, and the words say why.
//
// How it ties. Everything is read only in the two heading areas, the column band and the row gutter: Excel never fills them and never draws a chart or picture
// over them, so cell fills, merged cells, charts and images over the grid do not hide or fake a line there. Lines are found by contrast with the ground beside
// them, so a grey or anti-aliased line at any zoom reads the same as a black one.
// - the band: the lines just above and just below the printed column letters (whose bounds the page text gives);
// - column lines: lines down the whole band; the line just left of the first letter is the left edge of the first column and the right edge of the row gutter,
//   with at most the frame left of it; then exactly one line per letter, each letter inside its own interval, and a glyph found in the pixels of each interval;
// - row lines: lines across the whole gutter, between the frame and its right edge; a printed row number is tied to the pair of neighbouring lines that hold
//   its text rectangle, with no line through the text;
// - the labels must be consecutive and be exactly the file's rows and columns of the region (no hidden ones, no second page);
// - self-check before any box: the first row's top line is the band's bottom line, the gutter holds exactly one line per row edge, the gutter's edge runs down
//   the page, and the scale read from the page's own lines (the zoom field is never used) is one scale for rows and columns, at which every column and every
//   row whose height the file sets is the size the file gives it. A row the file leaves unsized is fitted by Excel to its content, so it may only be taller.
// A drawing (chart, picture, shape) is boxed on its frame, computed from its anchor in the file on that confirmed grid: corners tied to cells sit on the
// cells' tied lines plus their offsets; sizes and absolute positions are measured at the zoom the page printed at, which must agree with the lines' scale.
import type { Pixels } from "../../../../public-kit/helpers/png.mjs";
import { PRINT_ROW_K, printedWidthPt } from "./diff.ts";
import type { PlanBox } from "./diff.ts";
import type { PixRect } from "./look.ts";
import { heightPt, type AnchorCorner, type Drawing, type Rect, type Sheet } from "./workbook.ts";
import { previousPrintGrid } from "./print-grid-previous.ts";

export interface HeadingChar { c: string; x: number; y: number; w: number; h: number }
/** The printed headings of one picture, in the picture's own pixels. */
export interface PictureHeadings {
  rows: { n: number; y: number; h: number; chars?: HeadingChar[] }[];
  cols?: { text: string; x: number; y: number; w: number; h: number; chars?: HeadingChar[] };
}

export type PrintBox = { change: string } & ({ rect: PixRect; clipped?: true } | { why: string });

// Lines are found by contrast with the ground beside them, never by a fixed darkness: Excel prints heading lines black or grey, one pixel or two
// anti-aliased ones, depending on the zoom and where the line falls on the pixel grid.
const EDGE = 24; // a line's pixel is at least this much darker (0-255) than the lightest pixel beside it
const REACH = 4; // the ground beside a line is looked for up to this many pixels away, so lines up to three pixels wide read as lines
const INK = 64; // a heading letter's ink is at least this much darker than the band's ground
const COVER = 0.9; // a line spans this share of the gutter's width or the band's height
const SCALES_AGREE = 0.03; // the rows' scale and the columns' scale agree within this share
/** Pixels added outward on each side of a box, then clamped to the picture. */
export const PRINT_BOX_PAD_PX = 2;
const SAME = 0.75; // two lines of one tie are the same line within this many pixels

const fail = (why: string): { why: string } => ({ why });
const runs = (flags: boolean[]): [number, number][] => {
  const out: [number, number][] = [];
  let s = -1;
  for (let i = 0; i <= flags.length; i++) {
    const v = i < flags.length && flags[i]!;
    if (v && s < 0) s = i;
    if (!v && s >= 0) { out.push([s, i - s]); s = -1; }
  }
  return out;
};
const colNum = (s: string): number => [...s].reduce((v, ch) => v * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number): string => { let s = ""; for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s; };
const median = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const meet = (a: Rect, b: Rect): Rect | undefined => {
  const x = { r1: Math.max(a.r1, b.r1), r2: Math.min(a.r2, b.r2), c1: Math.max(a.c1, b.c1), c2: Math.min(a.c2, b.c2) };
  return x.r1 <= x.r2 && x.c1 <= x.c2 ? x : undefined;
};
const touches = (a: Rect, b: Rect): boolean => meet(a, b) !== undefined;

export interface PrintGrid {
  /** Row n: its top and bottom line centres, in picture pixels (y). */
  rowLines: Map<number, [number, number]>;
  /** Column n: its left and right line centres (x). */
  colLines: Map<number, [number, number]>;
  /** The page's scale read from its rows and from its columns (1 = 100%), each confirmed against the file. */
  scale: { rows: number; cols: number };
}

/**
 * The lines of a print picture tied to its printed labels, or why not. `region` is the rows and columns the picture must show: the labels must be exactly those.
 * `sheet` gives the file's sizes for the scale check; without it nothing is confirmed.
 */
export function printGrid(px: Pixels, hd: PictureHeadings, region: Rect, sheet: Sheet | undefined): PrintGrid | { why: string } {
  // hidden rows and columns, and the size of every row and column, come from the file
  if (sheet === undefined) return fail("the sheet's sizes could not be read from the file");
  const wantRows: number[] = [], wantCols: number[] = [];
  for (let r = region.r1; r <= region.r2; r++) wantRows.push(r);
  for (let c = region.c1; c <= region.c2; c++) wantCols.push(c);
  const hiddenRow = wantRows.find((r) => sheet.hiddenRows.has(r) || heightPt(sheet, r) === 0);
  if (hiddenRow !== undefined) return fail(`row ${hiddenRow} is hidden, so the printed row numbers skip it`);
  const hiddenCol = wantCols.find((c) => sheet.hiddenCols.has(c) || printedWidthPt(sheet, c) === 0);
  if (hiddenCol !== undefined) return fail(`column ${colName(hiddenCol)} is hidden, so the printed letters skip it`);

  const { width: w, height: h } = px;
  const lum = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (px.rgba[i * 4]! * 77 + px.rgba[i * 4 + 1]! * 150 + px.rgba[i * 4 + 2]! * 29) >> 8;
  const at = (x: number, y: number): number => lum[y * w + x]!;
  // How much darker (x, y) is than the lightest pixel of the small block beside it in direction (dx, dy): REACH pixels out, two pixels to either side across.
  // The block's lightest pixel is the local background, so a grey line on white, a black line on white and a line on a tinted ground all read the same.
  const lift = (x: number, y: number, dx: number, dy: number): number => {
    let m = -1;
    for (let i = 1; i <= REACH; i++) for (let j = -2; j <= 2; j++) {
      const xx = x + dx * i + (dx === 0 ? j : 0), yy = y + dy * i + (dy === 0 ? j : 0);
      if (xx >= 0 && xx < w && yy >= 0 && yy < h) m = Math.max(m, at(xx, yy));
    }
    return m - at(x, y);
  };
  type Side = "both" | -1 | 1;
  // a pixel of a horizontal line: darker than the ground above and below it (or on the one side named)
  const hPix = (x: number, y: number, s: Side): boolean => (s === "both" ? Math.min(lift(x, y, 0, -1), lift(x, y, 0, 1)) : lift(x, y, 0, s)) >= EDGE;
  const vPix = (x: number, y: number, s: Side): boolean => (s === "both" ? Math.min(lift(x, y, -1, 0), lift(x, y, 1, 0)) : lift(x, y, s, 0)) >= EDGE;
  const clampX = (x: number): number => Math.max(0, Math.min(w - 1, Math.round(x)));
  const clampY = (y: number): number => Math.max(0, Math.min(h - 1, Math.round(y)));
  // lines that cross the span [a0, a1] on at least COVER of its pixels, between b0 and b1 along the other axis; each with its weighted centre
  const lines = (axis: "h" | "v", a0: number, a1: number, b0: number, b1: number, s: Side): { centre: number; s: number; n: number }[] => {
    a0 = axis === "h" ? clampX(a0) : clampY(a0); a1 = axis === "h" ? clampX(a1) : clampY(a1);
    b0 = axis === "h" ? clampY(b0) : clampX(b0); b1 = axis === "h" ? clampY(b1) : clampX(b1);
    const span = a1 - a0 + 1;
    if (span < 3 || b1 < b0) return [];
    const px1 = (a: number, b: number): number => (axis === "h" ? at(a, b) : at(b, a));
    const hit = (a: number, b: number): boolean => (axis === "h" ? hPix(a, b, s) : vPix(b, a, s));
    const flags: boolean[] = [];
    for (let b = b0; b <= b1; b++) { let n = 0; for (let a = a0; a <= a1; a++) if (hit(a, b)) n++; flags.push(n >= COVER * span); }
    // the weighted centre of each run, its pixels and the one next to it on each ground side (the faint half of an anti-aliased line), weighed against the
    // ground two pixels out on the ground side(s), which a line never reaches
    const sides = s === "both" ? [-1, 1] : [s];
    return runs(flags).map(([r, n]) => {
      const s0 = b0 + r, e0 = s0 + n - 1;
      const out = sides.flatMap((d) => { const b = d < 0 ? s0 - 2 : e0 + 2; if (b < 0 || b >= (axis === "h" ? h : w)) return []; const v: number[] = []; for (let a = a0; a <= a1; a++) v.push(px1(a, b)); return [median(v)]; });
      const g = out.length ? Math.max(...out) : 255;
      let wsum = 0, tot = 0;
      for (let b = sides.includes(-1) ? Math.max(0, s0 - 1) : s0; b <= (sides.includes(1) ? Math.min((axis === "h" ? h : w) - 1, e0 + 1) : e0); b++) {
        let v = 0;
        for (let a = a0; a <= a1; a++) v += Math.max(0, g - px1(a, b));
        wsum += b * v; tot += v;
      }
      return { centre: tot === 0 ? s0 + (n - 1) / 2 : wsum / tot, s: s0, n };
    });
  };

  // the column band: the lines just above and below the printed letters, each read against the band side of it (the cells below may be filled)
  const cols = hd.cols;
  if (cols === undefined) return fail("no column letters are printed on this picture");
  const letters = cols.text.split(" ");
  if (cols.chars === undefined || cols.chars.length !== letters.reduce((n, t) => n + t.length, 0)) return fail("the column letters have no per-letter bounds to check");
  const lx0 = Math.min(...cols.chars.map((c) => c.x)), lx1 = Math.max(...cols.chars.map((c) => c.x + c.w));
  const lyc = Math.min(h - 1, Math.max(0, cols.y + cols.h / 2));
  const near = 2 * cols.h + 2 * REACH; // the band's lines sit just above and below the letters
  const bandTop = lines("h", lx0, lx1, lyc - near, lyc, 1).at(-1);
  const bandBot = lines("h", lx0, lx1, lyc, lyc + near, -1)[0];
  if (bandTop === undefined || bandBot === undefined) return fail("the lines above and below the column letters were not found in the picture");
  const by0 = bandTop.s + bandTop.n + 1, by1 = bandBot.s - 2; // the band's inside, rows
  if (by1 - by0 < 3) return fail("the column band is too small to read");
  // column lines: lines down the whole band, read against both sides (the band is never filled)
  const bandLines = lines("v", by0, by1, 0, w - 1, "both");
  const bl = bandLines.map((l) => l.centre);
  // the letters, each with its own bounds
  let k = 0;
  const bounds = letters.map((t) => { const cs = cols.chars!.slice(k, k + t.length); k += t.length; return { x0: Math.min(...cs.map((c) => c.x)), x1: Math.max(...cs.map((c) => c.x + c.w)) }; });
  // the gutter's right edge is the band line just left of the first letter: the left line of the first column. At most one line (the frame) lies left of it.
  const gi = bl.findLastIndex((x) => x < bounds[0]!.x0);
  if (gi < 0) return fail("no line was found left of the first column letter");
  if (gi > 1) return fail(`the column band holds ${gi + 1} lines left of the first letter, where the frame and the row gutter's edge make at most 2`);
  const right = bl.slice(gi);
  if (right.length !== letters.length + 1) return fail(`the column band holds ${right.length} lines from the row gutter on, but ${letters.length} letters need ${letters.length + 1}`);
  const gutX = bl[gi]!, frameX = gi > 0 ? bl[0] : undefined;
  const gutR = bandLines[gi]!.s + bandLines[gi]!.n - 1;

  // the row gutter: every printed row number lies between the frame and the gutter's edge
  const rowChars = hd.rows.flatMap((r) => r.chars ?? []);
  const rx0 = rowChars.length ? Math.min(...rowChars.map((c) => c.x)) : gutX - 4;
  const rx1 = rowChars.length ? Math.max(...rowChars.map((c) => c.x + c.w)) : gutX - 4;
  if (rx1 > gutX - 1 || (frameX !== undefined && rx0 < frameX + 1)) return fail("the printed row numbers are not inside the row gutter");
  const gx0 = frameX !== undefined ? frameX + 2 : Math.min(rx0, gutX - 6), gx1 = gutX - 2; // the gutter's inside, columns
  if (gx1 - gx0 < 3) return fail("the row gutter is too small to read");
  // row lines: lines across the whole gutter, read against both sides (the gutter is never filled, and nothing is drawn over it)
  const gl = lines("h", gx0, gx1, 0, h - 1, "both").map((l) => l.centre);

  // rows: each printed number is tied to the adjacent pair of gutter lines that hold its text, with no line through it
  const rowLines = new Map<number, [number, number]>();
  const refuseRow = new Map<number, string>();
  const used = new Map<string, number>();
  const seen = new Set<number>();
  for (const lab of hd.rows) {
    if (seen.has(lab.n)) return fail(`row number ${lab.n} is printed twice on this picture`);
    seen.add(lab.n);
    const digits = String(lab.n).length;
    // one number per run: the digits of a real number stand side by side on one line; a run whose digits are stacked or overlap is rows fused by their shortness
    if (lab.chars === undefined ? digits > 1 : lab.chars.length !== digits) { refuseRow.set(lab.n, "its number has no per-digit bounds to check (fused rows?)"); continue; }
    if (lab.chars !== undefined && lab.chars.length > 1) {
      const cs = lab.chars;
      const flat = cs.every((c) => Math.abs(c.y - cs[0]!.y) <= 1.5 && Math.abs(c.h - cs[0]!.h) <= 3);
      const ordered = cs.every((c, i) => i === 0 || c.x >= cs[i - 1]!.x + cs[i - 1]!.w * 0.5);
      if (!flat || !ordered) { refuseRow.set(lab.n, "its digits are not side by side on one line (short rows whose numbers run together)"); continue; }
    }
    const y0 = lab.y, y1 = lab.y + lab.h;
    if (gl.some((g) => g > y0 + 1 && g < y1 - 1)) { refuseRow.set(lab.n, "a line runs through its number (the row is shorter than its number)"); continue; }
    const above = gl.filter((g) => g <= y0 + 2), below = gl.filter((g) => g >= y1 - 2);
    if (!above.length || !below.length) { refuseRow.set(lab.n, "its number is not between two lines"); continue; }
    const a = Math.max(...above), b = Math.min(...below);
    if (gl.indexOf(b) !== gl.indexOf(a) + 1) { refuseRow.set(lab.n, "its two lines are not neighbours"); continue; }
    const key = `${a}|${b}`;
    if (used.has(key)) return fail(`rows ${used.get(key)} and ${lab.n} are tied to the same two lines`);
    used.set(key, lab.n);
    rowLines.set(lab.n, [a, b]);
  }
  const tiedRows = [...rowLines.keys()].sort((p, q) => p - q);
  const missRow = wantRows.find((r) => !rowLines.has(r));
  if (missRow !== undefined || tiedRows.length !== wantRows.length) {
    if (missRow !== undefined && refuseRow.has(missRow)) return fail(`the number of row ${missRow} cannot be tied to its lines: ${refuseRow.get(missRow)}`);
    return fail(`the page labels rows ${tiedRows.length ? `${tiedRows[0]} to ${tiedRows[tiedRows.length - 1]}` : "none"} but the file's region is rows ${region.r1} to ${region.r2}${missRow !== undefined ? ` (row ${missRow} is not printed on this picture)` : ""}`);
  }
  // consecutive rows share the line between them: each line is tied to the number above it and the number below it
  for (let r = region.r1; r < region.r2; r++) if (Math.abs(rowLines.get(r)![1] - rowLines.get(r + 1)![0]) > SAME) return fail(`the lines of rows ${r} and ${r + 1} do not meet`);
  if (Math.abs(rowLines.get(region.r1)![0] - bandBot.centre) > 1.5) return fail("the first row's top line is not the bottom line of the column headings");
  // the gutter holds exactly one line per row edge from the band down to the last row: a line more or less means a line was missed or a stray one was taken
  const lastBot = rowLines.get(region.r2)![1];
  const inRows = gl.filter((g) => g >= bandBot.centre - 1.5 && g <= lastBot + 1.5).length;
  if (inRows !== wantRows.length + 1) return fail(`the row gutter holds ${inRows} lines for ${wantRows.length} rows, which need ${wantRows.length + 1}`);
  // the gutter's edge runs down the page from the band to the last row: read against the gutter side only (column A's cells, or a chart over them, may be dark)
  {
    const ya = clampY(bandBot.centre + 2), yb = clampY(lastBot - 2);
    let n = 0;
    for (let y = ya; y <= yb; y++) { let on = false; for (let x = clampX(gutX) - 1; x <= clampX(gutX) + 1 && !on; x++) on = vPix(x, y, -1); if (on) n++; }
    if (yb > ya && n < COVER * (yb - ya + 1)) return fail("the line between the row numbers and the first column does not run down the page");
  }

  // columns: the printed letters, each tied to its interval between the band's lines
  const names = letters.map(colNum);
  if (!names.every((n, i) => i === 0 || n === names[i - 1]! + 1)) return fail("the printed column letters are not consecutive");
  if (names.length !== wantCols.length || names[0] !== region.c1) return fail(`the page labels columns ${letters[0]} to ${letters[letters.length - 1]} but the file's region is columns ${colName(region.c1)} to ${colName(region.c2)}`);
  const iv = letters.map((_, i): [number, number] => [right[i]!, right[i + 1]!]);
  for (let i = 0; i < letters.length; i++) if (!(iv[i]![0] < bounds[i]!.x0 && bounds[i]!.x1 < iv[i]![1])) return fail(`the letter ${letters[i]} is not inside its own column lines`);
  // the pixels agree: ink of a glyph inside every interval, none outside them. Ink is read against the band's own ground, not a fixed darkness.
  const onLine = new Set<number>();
  for (const l of bandLines) for (let x = l.s - 1; x <= l.s + l.n; x++) onLine.add(x);
  const bandGround: number[] = [];
  for (let y = by0; y <= by1; y++) for (let x = clampX(gutX); x < w; x += 3) bandGround.push(at(x, y));
  const inkBelow = median(bandGround) - INK;
  const ink = Array.from({ length: w }, (_, x) => { if (onLine.has(x)) return false; for (let y = by0; y <= by1; y++) if (at(x, y) < inkBelow) return true; return false; });
  const clusters = runs(ink).map(([s0, n]) => [s0, s0 + n - 1] as const).filter(([s0]) => s0 > gutR);
  for (const [c0, c1] of clusters) if (!iv.some(([a, b]) => a < c0 && c1 < b)) return fail("a glyph in the column headings lies outside every column");
  for (let i = 0; i < iv.length; i++) if (!clusters.some(([c0, c1]) => iv[i]![0] < c0 && c1 < iv[i]![1] && c0 >= bounds[i]!.x0 - 2 && c1 <= bounds[i]!.x1 + 2)) return fail(`no glyph is drawn for the letter ${letters[i]} where its bounds say`);
  const colLines = new Map<number, [number, number]>();
  names.forEach((n, i) => colLines.set(n, iv[i]!));

  // the scale, from the page's own lines: rows and columns each give one, and one zoom prints both, so the two must agree. Every tied column, and every row whose
  // height the file sets, must be the size the file gives it at that scale. A row whose height the file leaves unset is fitted by Excel to its content (a larger
  // font, wrapped text), so it may print taller than the default, never shorter.
  const checkScale = (tied: Map<number, [number, number]>, nominal: (n: number) => number, what: string, mayGrow: (n: number) => boolean): { bad: string } | { scale: number } => {
    const readable = [...tied].filter(([n]) => nominal(n) >= 20);
    if (!readable.length) return { bad: `no ${what} is large enough to read the page's scale from` };
    const s = median(readable.map(([n, [a, b]]) => (b - a) / nominal(n)));
    for (const [n, [a, b]] of tied) {
      const want = nominal(n) * s, tol = Math.max(2.5, 0.06 * want);
      if (b - a > want && mayGrow(n)) continue;
      if (Math.abs(b - a - want) > tol) return { bad: `${what} ${what === "column" ? colName(n) : n} is ${(b - a).toFixed(1)} px but the file and the page's scale say ${want.toFixed(1)} px` };
    }
    return { scale: s };
  };
  const rowScale = checkScale(rowLines, (n) => 2 * heightPt(sheet, n) * PRINT_ROW_K, "row", (n) => !sheet.heights.has(n));
  if ("bad" in rowScale) return fail(rowScale.bad);
  const colScale = checkScale(colLines, (n) => 2 * printedWidthPt(sheet, n), "column", () => false);
  if ("bad" in colScale) return fail(colScale.bad);
  if (Math.abs(rowScale.scale - colScale.scale) > SCALES_AGREE * colScale.scale) return fail(`the rows give the page a scale of ${rowScale.scale.toFixed(3)} and the columns ${colScale.scale.toFixed(3)}, but one zoom prints both`);
  return { rowLines, colLines, scale: { rows: rowScale.scale, cols: colScale.scale } };
}

const EMU_PER_PT = 12700;
const ZOOM_AGREES = 0.02; // the zoom the page was printed at and the scale its own lines show agree within this share

/**
 * A drawing's frame on the page, from its anchor in the file and the fitted grid, or why not. A corner tied to a cell sits on that cell's fitted lines plus its
 * offset; a size or an absolute position is measured at `pxPerPt`, the page's pixels per point at the zoom it was printed at, which must agree with the scale
 * the page's own lines show. A frame that runs past the printed cells is cut at their edge and marked `clipped`.
 */
export function drawingFrame(d: Drawing, grid: PrintGrid, region: Rect, pxPerPt: number | undefined): { x0: number; y0: number; x1: number; y1: number; clipped: boolean } | { why: string } {
  const pl = d.place;
  if (pl === undefined) return fail("its anchor in the file could not be read");
  if (pxPerPt === undefined || !(pxPerPt > 0)) return fail("the zoom the page was printed at is not known, so the drawing cannot be measured on it");
  // the lines' scale is relative to the file's sizes at 2 px a point (the print model the grid is checked with)
  const seen = grid.scale.rows + grid.scale.cols; // 2 px a point times the mean of the two scales
  if (Math.abs(seen - pxPerPt) > ZOOM_AGREES * pxPerPt) return fail(`the page's lines show ${seen.toFixed(3)} px a point but its zoom gives ${pxPerPt.toFixed(3)}, so the drawing cannot be measured on it`);
  const k = pxPerPt / EMU_PER_PT;
  const X0 = grid.colLines.get(region.c1)![0], X1 = grid.colLines.get(region.c2)![1], Y0 = grid.rowLines.get(region.r1)![0], Y1 = grid.rowLines.get(region.r2)![1];
  // a corner on the page: -Infinity / Infinity when its cell is before / after the printed range, a pixel otherwise
  const along = (lines: Map<number, [number, number]>, lo: number, hi: number, cell0: number, off: number): number | { why: string } => {
    const n = cell0 + 1;
    if (n < lo) return -Infinity;
    if (n > hi) return Infinity;
    const [a, b] = lines.get(n)!;
    if (off * k > b - a + 2) return fail("its anchor's offset runs past the cell it is anchored to");
    return a + Math.min(off * k, b - a);
  };
  const corner = (c: AnchorCorner): { x: number; y: number } | { why: string } => {
    const x = along(grid.colLines, region.c1, region.c2, c.col, c.colOff), y = along(grid.rowLines, region.r1, region.r2, c.row, c.rowOff);
    if (typeof x !== "number") return x;
    if (typeof y !== "number") return y;
    return { x, y };
  };
  let left: number, top: number, right: number, bottom: number;
  if (pl.kind === "twoCell") {
    const f = corner(pl.from), t = corner(pl.to);
    if ("why" in f) return f;
    if ("why" in t) return t;
    [left, top, right, bottom] = [f.x, f.y, t.x, t.y];
  } else if (pl.kind === "oneCell") {
    const f = corner(pl.from);
    if ("why" in f) return f;
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) return fail("its frame starts outside the printed cells, and its size is measured from its start");
    [left, top] = [f.x, f.y];
    [right, bottom] = [left + pl.ext.cx * k, top + pl.ext.cy * k];
  } else {
    // an absolute position is measured from the sheet's top-left corner, which the page shows only when it prints from A1
    if (region.r1 !== 1 || region.c1 !== 1) return fail("its position is measured from cell A1, which this picture does not show");
    [left, top] = [X0 + pl.pos.x * k, Y0 + pl.pos.y * k];
    [right, bottom] = [left + pl.ext.cx * k, top + pl.ext.cy * k];
  }
  if (!(right > left && bottom > top)) return fail("its frame has no size");
  const x0 = Math.max(left, X0), x1 = Math.min(right, X1), y0 = Math.max(top, Y0), y1 = Math.min(bottom, Y1);
  if (x1 - x0 < 2 || y1 - y0 < 2) return fail("its frame lies outside the printed cells");
  return { x0, y0, x1, y1, clipped: x0 > left + 0.5 || x1 < right - 0.5 || y0 > top + 0.5 || y1 < bottom - 0.5 };
}

/**
 * One picture's boxes. `region`: the rows and columns the picture shows. `pages`: how many pages the region printed on (a region on a second page is refused).
 * `pxPerPt`: the page's pixels per point at the zoom it was printed at, for drawings (a chart, picture or shape is boxed on its frame).
 * Every box in `boxes` gets a rect or words; a change that runs past the region is boxed on the part inside it, with `clipped`.
 */
export function placePrintBoxes(a: { pixels: Pixels; headings: PictureHeadings; region: Rect; sheet: Sheet | undefined; pages: number; boxes: PlanBox[]; pxPerPt?: number }): PrintBox[] {
  const all = (why: string): PrintBox[] => a.boxes.map((b) => ({ change: b.change, why: `not marked: ${why}` }));
  if (a.pages > 1) return all(`the region printed on ${a.pages} pages and only its first page is shown`);
  const fitted = printGrid(a.pixels, a.headings, a.region, a.sheet);
  // Safety net until this finder is verified on real Windows print pictures, to be removed then (with print-grid-previous.ts): when it
  // refuses the page, the finder used before it is asked, and its grid, if it fits under its own checks, places the cell boxes. Drawing
  // frames are boxed only from this finder's grid (the earlier one never boxed them). Only when both refuse is every change unplaced.
  const grid = "why" in fitted ? previousPrintGrid(a.pixels, a.headings, a.region, a.sheet) : fitted;
  if ("why" in grid) return all("why" in fitted ? fitted.why : grid.why);
  const sheet = a.sheet!;
  return a.boxes.map((b): PrintBox => {
    const no = (why: string): PrintBox => ({ change: b.change, why: `not marked: ${why}` });
    // a drawing (chart, picture, shape) is boxed on its own frame, from its anchor and the fitted grid
    if (b.drawing !== undefined) {
      if ("why" in fitted) return no(fitted.why);
      const same = sheet.drawings.filter((d) => (d.objectName ?? d.name) === b.drawing);
      if (same.length !== 1) return no(same.length === 0 ? "the drawing was not found on the sheet" : "two drawings on the sheet have its name");
      const f = drawingFrame(same[0]!, fitted, a.region, a.pxPerPt);
      if ("why" in f) return no(`the ${same[0]!.kind === "image" ? "picture" : same[0]!.kind}: ${f.why}`);
      const x0 = Math.max(0, Math.floor(f.x0 - PRINT_BOX_PAD_PX)), y0 = Math.max(0, Math.floor(f.y0 - PRINT_BOX_PAD_PX));
      const x1 = Math.min(a.pixels.width, Math.ceil(f.x1 + PRINT_BOX_PAD_PX + 1)), y1 = Math.min(a.pixels.height, Math.ceil(f.y1 + PRINT_BOX_PAD_PX + 1));
      return { change: b.change, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, ...(f.clipped ? { clipped: true as const } : {}) };
    }
    let cells = meet(b.cells, a.region);
    if (!cells) return no("outside the cells of this picture");
    const clipped = cells.r1 !== b.cells.r1 || cells.r2 !== b.cells.r2 || cells.c1 !== b.cells.c1 || cells.c2 !== b.cells.c2;
    // merged cells: a changed cell is the merge's anchor. The whole merge when its outer edges are all tied on this picture, the anchor cell otherwise.
    const one = cells.r1 === cells.r2 && cells.c1 === cells.c2;
    if (one) {
      const m = sheet.merges.find((x) => cells!.r1 >= x.r1 && cells!.r1 <= x.r2 && cells!.c1 >= x.c1 && cells!.c1 <= x.c2 && (x.r1 !== x.r2 || x.c1 !== x.c2));
      if (m) {
        if (m.r1 !== cells.r1 || m.c1 !== cells.c1) return no("inside a merged cell, away from its anchor");
        const whole = meet(m, a.region);
        if (whole && whole.r1 === m.r1 && whole.r2 === m.r2 && whole.c1 === m.c1 && whole.c2 === m.c2) cells = m;
      }
    }
    // anything drawn over cells hides them: a chart, picture or shape anchored over the change
    if (sheet.drawings.some((d) => d.anchor !== undefined && touches(d.anchor, cells!))) return no("the cells are under a chart or picture");
    const R1 = grid.rowLines.get(cells.r1), R2 = grid.rowLines.get(cells.r2), C1 = grid.colLines.get(cells.c1), C2 = grid.colLines.get(cells.c2);
    if (!R1 || !R2 || !C1 || !C2) return no("an edge of the cells has no confirmed line tied to the printed labels");
    const x0 = Math.max(0, Math.floor(C1[0] - PRINT_BOX_PAD_PX)), y0 = Math.max(0, Math.floor(R1[0] - PRINT_BOX_PAD_PX));
    const x1 = Math.min(a.pixels.width, Math.ceil(C2[1] + PRINT_BOX_PAD_PX + 1)), y1 = Math.min(a.pixels.height, Math.ceil(R2[1] + PRINT_BOX_PAD_PX + 1));
    if (x1 <= x0 || y1 <= y0) return no("outside the picture");
    return { change: b.change, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, ...(clipped ? { clipped: true as const } : {}) };
  });
}
