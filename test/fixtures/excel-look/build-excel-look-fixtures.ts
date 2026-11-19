// Builds the synthetic captures and geometry JSON in this folder: node test/fixtures/excel-look/build-excel-look-fixtures.ts
// Synthetic means drawn by this script from the same shapes the real capture t-after-2x.png has (2 px lines at 2x, a 21 pt heading band, a gutter,
// a bar about 3 pt thick for a hidden row or column). The real capture is the golden; these cover what no real capture exists for (light mode, hidden markers).
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCALE = 2;

type Geo = { scrollRow: number; scrollCol: number; rows: { row: number; top: number; height: number }[]; cols: { col: number; left: number; width: number }[]; charts: never[] };
const geoOf = (scrollRow: number, scrollCol: number, heights: number[], widths: number[], top0 = 30, left0 = 215): Geo => {
  let t = top0, l = left0;
  const rows = heights.map((height, i) => { const r = { row: scrollRow + i, top: t, height }; t += height; return r; });
  const cols = widths.map((width, i) => { const c = { col: scrollCol + i, left: l, width }; l += width; return c; });
  return { scrollRow, scrollCol, rows, cols, charts: [] };
};

function png(w: number, h: number, lum: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3, v = lum[y * w + x]!; raw[o] = raw[o + 1] = raw[o + 2] = v; }
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)) >>> 0, 8 + data.length); return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function render(geo: Geo, dark: boolean, ox: number, oy: number) {
  const cum = (xs: number[]) => { const o = [0]; for (const v of xs) o.push(o[o.length - 1]! + v); return o; };
  const xs = cum(geo.cols.map((c) => c.width)), ys = cum(geo.rows.map((r) => r.height));
  const W = ox + xs[xs.length - 1]! * SCALE + 60, H = oy + ys[ys.length - 1]! * SCALE + 60;
  const chrome = dark ? 22 : 235, sep = dark ? 70 : 185, edge = dark ? 188 : 110, body = 255, grid = dark ? 212 : 205, bar = dark ? 95 : 160, ink = dark ? 200 : 60;
  const lum = new Uint8Array(W * H).fill(chrome);
  const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => { for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) lum[y * W + x] = v; };
  const bandTop = oy - 42, gutLeft = ox - 44, right = ox + xs[xs.length - 1]! * SCALE, bottom = oy + ys[ys.length - 1]! * SCALE;
  fill(ox, oy, right + 2, bottom + 2, body);
  const hiddenX = geo.cols.map((c) => c.width === 0), hiddenY = geo.rows.map((r) => r.height === 0);
  xs.forEach((off, k) => {
    const x = ox + Math.round(off * SCALE), hid = k < hiddenX.length && hiddenX[k];
    fill(x, oy, x + 2, bottom + 2, grid);                                  // body gridline
    if (hid) fill(x - 2, bandTop, x + 4, oy, bar); else fill(x, bandTop, x + 2, oy, sep); // heading separator or hidden marker
  });
  ys.forEach((off, k) => {
    const y = oy + Math.round(off * SCALE), hid = k < hiddenY.length && hiddenY[k];
    fill(ox, y, right + 2, y + 2, grid);
    if (hid) fill(gutLeft, y - 2, ox, y + 4, bar); else fill(gutLeft, y, ox, y + 2, sep);
  });
  fill(ox, bandTop, ox + 2, bottom + 2, edge); fill(gutLeft, oy, right + 2, oy + 2, edge); // the heading-edge lines are the origin
  for (let k = 0; k + 1 < xs.length; k++) if (xs[k + 1]! - xs[k]! > 20) fill(ox + Math.round(xs[k]! * SCALE) + 40, bandTop + 14, ox + Math.round(xs[k]! * SCALE) + 48, oy - 12, ink); // header letters
  for (let k = 0; k + 1 < ys.length; k++) if (ys[k + 1]! - ys[k]! > 8) fill(gutLeft + 14, oy + Math.round(ys[k]! * SCALE) + 8, gutLeft + 26, oy + Math.round(ys[k]! * SCALE) + 16, ink); // row numbers
  return { w: W, h: H, lum, origin: { x: ox, y: oy } };
}

const W_UNEVEN = [53, 53, 150, 53, 53, 53, 53, 53, 53, 53, 53, 53];
const H_UNEVEN = [30, 15, 15, 15, 22, 15, 15, 15, 15, 15, 15, 15, 15, 15];
const W_HIDDEN = [53, 0, 53, 150, 53, 53, 53, 53, 53, 53, 53, 53];
const H_HIDDEN = [30, 15, 15, 15, 0, 15, 15, 22, 15, 15, 15, 15, 15, 15];
const W_UNIFORM = Array(12).fill(53), H_UNIFORM = Array(14).fill(15);

const out = (name: string, geo: Geo, dark: boolean, ox = 60, oy = 90) => {
  const r = render(geo, dark, ox, oy);
  writeFileSync(path.join(here, `${name}.png`), png(r.w, r.h, r.lum));
  writeFileSync(path.join(here, `${name}.geometry.json`), JSON.stringify({ scale: SCALE, origin: r.origin, geometry: geo }, null, 1) + "\n");
};
out("synthetic-dark", geoOf(3, 4, H_UNEVEN, W_UNEVEN), true);
out("synthetic-light", geoOf(3, 4, H_UNEVEN, W_UNEVEN), false);
out("synthetic-hidden-dark", geoOf(3, 4, H_HIDDEN, W_HIDDEN), true);
out("synthetic-hidden-light", geoOf(3, 4, H_HIDDEN, W_HIDDEN), false);
out("synthetic-uniform", geoOf(3, 4, H_UNIFORM, W_UNIFORM), false);
writeFileSync(path.join(here, "blank.png"), png(1600, 1000, new Uint8Array(1600 * 1000).fill(255)));

// The golden capture's geometry as Excel reported it (the G3 probe's reading of win.png: scroll cell D3, column E and row 7 hidden, row 3 30 pt, row 12 22 pt).
const goldenH = [30, 15, 15, 15, 0, 15, 15, 15, 15, 22, ...Array(24).fill(15)];
const goldenW = [53, 0, 53, 150, ...Array(17).fill(53)];
const golden = geoOf(3, 4, goldenH, goldenW);
writeFileSync(path.join(here, "t-after-2x.geometry.json"), JSON.stringify({ scale: SCALE, origin: { x: 44, y: 452 }, geometry: golden }, null, 1) + "\n");
// One-row shift: the geometry of the same view as if Excel had scrolled one row further (row 3 falls off the comb, the rest move up).
writeFileSync(path.join(here, "t-after-2x.shifted-one-row.geometry.json"), JSON.stringify({ scale: SCALE, geometry: geoOf(4, 4, goldenH.slice(1), goldenW, 30 + 30) }, null, 1) + "\n");
