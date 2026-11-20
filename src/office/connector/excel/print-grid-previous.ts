// The grid finder Excel print boxes used before the contrast and heading-structure finder in print-boxes.ts, kept unchanged under its own name.
//
// Safety net: the newer finder has not yet been checked against real Windows Excel print pictures. When it refuses a page, placePrintBoxes
// asks this finder, and uses its grid for cell boxes if it fits under its own checks below, so cell boxes never do worse than before the newer
// finder. Drawing frames (charts, pictures, shapes) are never boxed from this grid. Remove this file, and the fallback in placePrintBoxes, once
// the newer finder is verified on Windows print pictures.
//
// How it ties (measured against real Excel print pages: 12 of 12 boxes at 0 px error):
// - the frame: the first two full-width dark lines (top of the column band, bottom of it) and the first two full-height dark lines (left of the row gutter, right of it);
// - row lines: lines across the gutter; a printed row number is tied to the pair of lines that hold its text rectangle, with no line through the text;
// - column lines: lines down the column band; the printed letters (one text run, each letter with its own bounds) are tied to the intervals right of the gutter,
//   one letter per interval, and a glyph is also found in the pixels of each interval;
// - the labels must be consecutive and be exactly the file's rows and columns of the region (no hidden ones, no second page);
// - the scale is read from the page's own lines (the zoom field is never used): every tied row and column must be the size the file gives it at that one scale.
import type { Pixels } from "../../../../public-kit/helpers/png.mjs";
import { PRINT_ROW_K, printedWidthPt } from "./diff.ts";
import type { PictureHeadings } from "./print-boxes.ts";
import { heightPt, type Rect, type Sheet } from "./workbook.ts";

const DARK = 128; // frame lines, text and the heading lines are darker than this
const LIGHT = 235; // a heading separator at a zoom under 100 prints grey, split over two pixel rows
const COVER = 0.9; // a separator spans this share of the gutter's width or the band's height
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

export interface PreviousPrintGrid {
  /** Row n: its top and bottom line centres, in picture pixels (y). */
  rowLines: Map<number, [number, number]>;
  /** Column n: its left and right line centres (x). */
  colLines: Map<number, [number, number]>;
}

/**
 * The lines of a print picture tied to its printed labels, or why not. `region` is the rows and columns the picture must show: the labels must be exactly those.
 * `sheet` gives the file's sizes for the scale check; without it nothing is confirmed.
 */
export function previousPrintGrid(px: Pixels, hd: PictureHeadings, region: Rect, sheet: Sheet | undefined): PreviousPrintGrid | { why: string } {
  const { width: w, height: h } = px;
  const lum = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (px.rgba[i * 4]! * 77 + px.rgba[i * 4 + 1]! * 150 + px.rgba[i * 4 + 2]! * 29) >> 8;
  const at = (x: number, y: number): number => lum[y * w + x]!;
  // the frame
  const rowDark = (y: number): number => { let n = 0; for (let x = 0; x < w; x++) if (at(x, y) < DARK) n++; return n; };
  const colDark = (x: number): number => { let n = 0; for (let y = 0; y < h; y++) if (at(x, y) < DARK) n++; return n; };
  const H = runs(Array.from({ length: h }, (_, y) => rowDark(y) > 0.5 * w));
  const V = runs(Array.from({ length: w }, (_, x) => colDark(x) > 0.5 * h));
  if (H.length < 2 || V.length < 2) return fail("the heading frame was not found in the picture");
  const top = H[0]!, bandLine = H[1]!, left = V[0]!, gutLine = V[1]!;
  const bandB = bandLine[0] + bandLine[1] - 1, gutR = gutLine[0] + gutLine[1] - 1;
  const gx0 = left[0] + left[1] + 1, gx1 = gutLine[0] - 1; // the gutter's inside, columns
  const by0 = top[0] + top[1] + 1, by1 = bandLine[0] - 1; // the band's inside, rows
  if (gx1 - gx0 < 3 || by1 - by0 < 3) return fail("the heading band or the row gutter is too small to read");
  // weighted centre of each (possibly two pixel) separator run
  const centre = (rs: [number, number][], axis: "h" | "v"): number[] => rs.map(([s, n]) => {
    let wsum = 0, tot = 0;
    for (let i = s; i < s + n; i++) {
      let v = 0;
      if (axis === "h") for (let x = gx0; x < gx1; x++) v += 255 - at(x, i);
      else for (let y = by0; y < by1; y++) v += 255 - at(i, y);
      wsum += (i - s) * v; tot += v;
    }
    return s + (tot === 0 ? (n - 1) / 2 : wsum / tot);
  });
  const rowLineRuns = runs(Array.from({ length: h }, (_, y) => { let n = 0; for (let x = gx0; x < gx1; x++) if (at(x, y) < LIGHT) n++; return n >= COVER * (gx1 - gx0); }));
  const colLineRuns = runs(Array.from({ length: w }, (_, x) => { let n = 0; for (let y = by0; y < by1; y++) if (at(x, y) < LIGHT) n++; return n >= COVER * (by1 - by0); }));
  const gl = centre(rowLineRuns, "h"), bl = centre(colLineRuns, "v");

  // hidden rows and columns, and the size of every row and column, come from the file
  if (sheet === undefined) return fail("the sheet's sizes could not be read from the file");
  const wantRows: number[] = [], wantCols: number[] = [];
  for (let r = region.r1; r <= region.r2; r++) wantRows.push(r);
  for (let c = region.c1; c <= region.c2; c++) wantCols.push(c);
  const hiddenRow = wantRows.find((r) => sheet.hiddenRows.has(r) || heightPt(sheet, r) === 0);
  if (hiddenRow !== undefined) return fail(`row ${hiddenRow} is hidden, so the printed row numbers skip it`);
  const hiddenCol = wantCols.find((c) => sheet.hiddenCols.has(c) || printedWidthPt(sheet, c) === 0);
  if (hiddenCol !== undefined) return fail(`column ${colName(hiddenCol)} is hidden, so the printed letters skip it`);

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
  if (Math.abs(rowLines.get(region.r1)![0] - (bandB - 0.5)) > 2) return fail("the first row's top line is not the bottom line of the column headings");

  // columns: the printed letters, each with its own bounds, tied to the intervals between the band's lines
  const cols = hd.cols;
  if (cols === undefined) return fail("no column letters are printed on this picture");
  const letters = cols.text.split(" ");
  if (cols.chars === undefined || cols.chars.length !== letters.reduce((n, t) => n + t.length, 0)) return fail("the column letters have no per-letter bounds to check");
  if (bl.length !== letters.length + 2) return fail(`the column band holds ${bl.length} lines but ${letters.length} letters need ${letters.length + 2}`);
  const names = letters.map(colNum);
  if (!names.every((n, i) => i === 0 || n === names[i - 1]! + 1)) return fail("the printed column letters are not consecutive");
  if (names.length !== wantCols.length || names[0] !== region.c1) return fail(`the page labels columns ${letters[0]} to ${letters[letters.length - 1]} but the file's region is columns ${colName(region.c1)} to ${colName(region.c2)}`);
  const iv = letters.map((_, i): [number, number] => [bl[i + 1]!, bl[i + 2]!]);
  let k = 0;
  const bounds = letters.map((t) => { const cs = cols.chars!.slice(k, k + t.length); k += t.length; return { x0: Math.min(...cs.map((c) => c.x)), x1: Math.max(...cs.map((c) => c.x + c.w)) }; });
  for (let i = 0; i < letters.length; i++) if (!(iv[i]![0] < bounds[i]!.x0 && bounds[i]!.x1 < iv[i]![1])) return fail(`the letter ${letters[i]} is not inside its own column lines`);
  // the pixels agree: ink of a glyph inside every interval, none outside them
  const onLine = new Set<number>();
  for (const [s, n] of colLineRuns) for (let x = s - 1; x <= s + n; x++) onLine.add(x);
  const ink = Array.from({ length: w }, (_, x) => { if (onLine.has(x)) return false; for (let y = by0; y < by1; y++) if (at(x, y) < DARK) return true; return false; });
  const clusters = runs(ink).map(([s, n]) => [s, s + n - 1] as const).filter(([s]) => s > gutR);
  for (const [c0, c1] of clusters) if (!iv.some(([a, b]) => a < c0 && c1 < b)) return fail("a glyph in the column headings lies outside every column");
  for (let i = 0; i < iv.length; i++) if (!clusters.some(([c0, c1]) => iv[i]![0] < c0 && c1 < iv[i]![1] && c0 >= bounds[i]!.x0 - 2 && c1 <= bounds[i]!.x1 + 2)) return fail(`no glyph is drawn for the letter ${letters[i]} where its bounds say`);
  const colLines = new Map<number, [number, number]>();
  names.forEach((n, i) => colLines.set(n, iv[i]!));

  // the scale, from the page's own lines: rows and columns each give one; every tied row and column must be the size the file gives it at that scale
  const checkScale = (lines: Map<number, [number, number]>, nominal: (n: number) => number, what: string): string | undefined => {
    const readable = [...lines].filter(([n]) => nominal(n) >= 20);
    if (!readable.length) return `no ${what} is large enough to read the page's scale from`;
    const s = median(readable.map(([n, [a, b]]) => (b - a) / nominal(n)));
    for (const [n, [a, b]] of lines) {
      const want = nominal(n) * s;
      if (Math.abs(b - a - want) > Math.max(2.5, 0.06 * want)) return `${what} ${what === "column" ? colName(n) : n} is ${(b - a).toFixed(1)} px but the file and the page's scale say ${want.toFixed(1)} px`;
    }
    return undefined;
  };
  const rowBad = checkScale(rowLines, (n) => 2 * heightPt(sheet, n) * PRINT_ROW_K, "row");
  if (rowBad) return fail(rowBad);
  const colBad = checkScale(colLines, (n) => 2 * printedWidthPt(sheet, n), "column");
  if (colBad) return fail(colBad);
  return { rowLines, colLines };
}
