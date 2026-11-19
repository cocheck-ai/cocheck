// The PNG reader CoCheck itself uses (public-kit/spec/v1.md, "Helpers"): 8-bit, not interlaced, grey, grey+alpha, RGB, RGBA or palette, decoded to
// RGBA so two pictures can be compared region for region. Anything else (16-bit, interlaced, not a PNG) is `undefined`, so a check built on it can
// say it could not run, never that the pictures match. Plain JavaScript on node:zlib only; types in png.d.mts.
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Largest picture read (decoded RGBA bytes), so a hostile header cannot ask for gigabytes. */
export const MAX_PIXEL_BYTES = 64 * 1024 * 1024;

/** The PNG in `bytes` as RGBA pixels, or `undefined` for anything this reader does not take (see the file comment). */
export function decodePng(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return undefined;
  let width = 0, height = 0, depth = 0, color = -1, interlace = 0;
  let palette;
  const idat = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const len = bytes.readUInt32BE(at), type = bytes.toString("latin1", at + 4, at + 8), body = bytes.subarray(at + 8, at + 8 + len);
    if (body.length !== len) return undefined;
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]; }
    else if (type === "PLTE") palette = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const ch = CHANNELS[color];
  if (ch === undefined || depth !== 8 || interlace !== 0 || width < 1 || height < 1 || width * height * 4 > MAX_PIXEL_BYTES || (color === 3 && palette === undefined)) return undefined;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return undefined; }
  const stride = width * ch;
  if (raw.length !== (stride + 1) * height) return undefined;
  const px = Buffer.alloc(stride * height);
  // one tight loop per row filter (same arithmetic as the PNG spec's reconstruction, byte for byte)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    if (f === 0) { raw.copy(px, row, src, src + stride); continue; }
    if (f === 1) { for (let x = 0; x < stride; x++) px[row + x] = (raw[src + x] + (x >= ch ? px[row + x - ch] : 0)) & 255; continue; }
    if (f === 2) { if (y === 0) raw.copy(px, row, src, src + stride); else for (let x = 0; x < stride; x++) px[row + x] = (raw[src + x] + px[up + x]) & 255; continue; }
    if (f === 3) { for (let x = 0; x < stride; x++) px[row + x] = (raw[src + x] + (((x >= ch ? px[row + x - ch] : 0) + (y > 0 ? px[up + x] : 0)) >> 1)) & 255; continue; }
    if (f !== 4) return undefined;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch] : 0, b = y > 0 ? px[up + x] : 0, c = x >= ch && y > 0 ? px[up + x - ch] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      px[row + x] = (raw[src + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
  }
  if (color === 6) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch, d = i * 4;
    if (color === 6) { px.copy(rgba, d, s, s + 4); continue; }
    if (color === 2) { px.copy(rgba, d, s, s + 3); rgba[d + 3] = 255; continue; }
    if (color === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255; continue; }
    if (color === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + 1]; continue; }
    const k = px[s] * 3;
    if (k + 2 >= palette.length) return undefined;
    rgba[d] = palette[k]; rgba[d + 1] = palette[k + 1]; rgba[d + 2] = palette[k + 2]; rgba[d + 3] = 255;
  }
  return { width, height, rgba };
}

/** True when the rectangle holds the same pixels in both pictures. The pictures must be the same size and the rectangle inside them; otherwise `undefined` (cannot say). */
export function sameRegion(a, b, r) {
  if (a.width !== b.width || a.height !== b.height) return undefined;
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y)), x1 = Math.min(a.width, Math.ceil(r.x + r.w)), y1 = Math.min(a.height, Math.ceil(r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return undefined;
  for (let y = y0; y < y1; y++) {
    const from = (y * a.width + x0) * 4, to = (y * a.width + x1) * 4;
    if (!a.rgba.subarray(from, to).equals(b.rgba.subarray(from, to))) return false;
  }
  return true;
}

const clip = (p, r) => ({ x0: Math.max(0, Math.floor(r.x)), y0: Math.max(0, Math.floor(r.y)), x1: Math.min(p.width, Math.ceil(r.x + r.w)), y1: Math.min(p.height, Math.ceil(r.y + r.h)) });

/** True when rectangle `ra` of `a` and rectangle `rb` of `b` hold the same pixels (the pictures may differ in size and the rectangles in place). Rectangles of different size are not the same (false); a rectangle that is empty after clipping gives `undefined` (cannot say). */
export function sameRegionAt(a, ra, b, rb) {
  const A = clip(a, ra), B = clip(b, rb);
  const w = A.x1 - A.x0, h = A.y1 - A.y0;
  if (w <= 0 || h <= 0 || B.x1 - B.x0 <= 0 || B.y1 - B.y0 <= 0) return undefined;
  if (B.x1 - B.x0 !== w || B.y1 - B.y0 !== h) return false;
  for (let y = 0; y < h; y++) {
    const fa = ((A.y0 + y) * a.width + A.x0) * 4, fb = ((B.y0 + y) * b.width + B.x0) * 4;
    if (!a.rgba.subarray(fa, fa + w * 4).equals(b.rgba.subarray(fb, fb + w * 4))) return false;
  }
  return true;
}
