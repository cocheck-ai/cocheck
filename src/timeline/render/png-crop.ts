import { deflateSync, inflateSync } from "node:zlib";

/**
 * A small PNG reader and writer for one job: cut a pixel rectangle out of a picture CoCheck itself rendered (PDFKit pages, Quick Look
 * previews: both are 8-bit RGBA, non-interlaced). It reads 8-bit, non-interlaced PNGs of color types 0 (gray), 2 (RGB), 3 (palette), 4 (gray and
 * alpha) and 6 (RGBA). Anything else is refused with a reason, never a guessed picture. The output keeps the source's color type, palette and
 * transparency, and every output pixel is the source pixel at its place: nothing is scaled, blended or re-quantised.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Pixels past which a picture is refused: the decoded rows are held in memory. */
export const MAX_PIXELS = 50_000_000;
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(...parts: Buffer[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, tail]);
}

export interface PngInfo {
  width: number;
  height: number;
  colorType: number;
}

interface Parsed extends PngInfo {
  /** Chunks the output keeps beside IHDR and IDAT, in file order (PLTE, tRNS). */
  keep: Array<{ type: string; data: Buffer }>;
  idat: Buffer;
}

function parse(png: Buffer): Parsed | { refused: string } {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return { refused: "not a PNG picture" };
  let off = 8;
  let ihdr: Buffer | undefined;
  const idat: Buffer[] = [];
  const keep: Parsed["keep"] = [];
  let ended = false;
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    if (off + 12 + len > png.length) return { refused: "the PNG is cut short" };
    const data = png.subarray(off + 8, off + 8 + len);
    if (png.readUInt32BE(off + 8 + len) !== crc32(png.subarray(off + 4, off + 8), data)) return { refused: "the PNG failed its checksum" };
    off += 12 + len;
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "PLTE" || type === "tRNS") keep.push({ type, data });
    else if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (ihdr === undefined || ihdr.length !== 13 || idat.length === 0 || !ended) return { refused: "the PNG is incomplete" };
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8]!;
  const colorType = ihdr[9]!;
  if (ihdr[12] !== 0) return { refused: "an interlaced PNG is not cropped" };
  if (CHANNELS[colorType] === undefined) return { refused: `PNG color type ${colorType} is not cropped` };
  if (bitDepth !== 8) return { refused: `a ${bitDepth}-bit PNG is not cropped (8-bit only)` };
  if (ihdr[10] !== 0 || ihdr[11] !== 0) return { refused: "the PNG uses an unknown compression or filter method" };
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) return { refused: "the PNG is too large to crop" };
  if (colorType === 3 && !keep.some((k) => k.type === "PLTE")) return { refused: "the PNG has no palette" };
  return { width, height, colorType, keep, idat: Buffer.concat(idat) };
}

/** Size and color type of a croppable PNG, or why it is refused. */
export function pngInfo(png: Buffer): PngInfo | { refused: string } {
  const p = parse(png);
  return "refused" in p ? p : { width: p.width, height: p.height, colorType: p.colorType };
}

/** Undoes the PNG row filters in place: returns the raw rows, `stride` bytes each. */
function unfilter(data: Buffer, width: number, height: number, bpp: number): Buffer | null {
  const stride = width * bpp;
  if (data.length !== height * (stride + 1)) return null;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const raw = data[src + i]!;
      const a = i >= bpp ? out[dst + i - bpp]! : 0;
      const b = y > 0 ? out[dst - stride + i]! : 0;
      const c = y > 0 && i >= bpp ? out[dst - stride + i - bpp]! : 0;
      let v: number;
      switch (type) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

/**
 * The PNG cut to the pixel rectangle (x, y, w, h): integers, inside the picture, at least 1 by 1. The result is a PNG of the same color
 * type whose pixels are exactly the source's pixels of that rectangle.
 */
export function cropPng(png: Buffer, x: number, y: number, w: number, h: number): { png: Buffer } | { refused: string } {
  const p = parse(png);
  if ("refused" in p) return p;
  if (![x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > p.width || y + h > p.height) return { refused: "the rectangle is not inside the picture" };
  const bpp = CHANNELS[p.colorType]!;
  let raw: Buffer | null;
  try {
    raw = unfilter(inflateSync(p.idat, { maxOutputLength: p.height * (p.width * bpp + 1) + 1 }), p.width, p.height, bpp);
  } catch {
    raw = null;
  }
  if (raw === null) return { refused: "the PNG's picture data is damaged" };
  const stride = p.width * bpp;
  const rows = Buffer.alloc(h * (w * bpp + 1));
  for (let r = 0; r < h; r++) raw.copy(rows, r * (w * bpp + 1) + 1, (y + r) * stride + x * bpp, (y + r) * stride + (x + w) * bpp);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = p.colorType;
  return { png: Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), ...p.keep.map((k) => chunk(k.type, k.data)), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]) };
}

/** Decodes a croppable PNG to its raw pixel bytes (`width * channels` per row), for tests and checks. */
export function decodePng(png: Buffer): ({ raw: Buffer } & PngInfo) | { refused: string } {
  const p = parse(png);
  if ("refused" in p) return p;
  const bpp = CHANNELS[p.colorType]!;
  try {
    const raw = unfilter(inflateSync(p.idat), p.width, p.height, bpp);
    return raw === null ? { refused: "the PNG's picture data is damaged" } : { raw, width: p.width, height: p.height, colorType: p.colorType };
  } catch {
    return { refused: "the PNG's picture data is damaged" };
  }
}

/** Brightness kept by a pixel outside a lasso path: dimmed, never removed. */
const DIM = 0.4;
const OUTLINE = [255, 0, 0, 255] as const;

/** The picture as 8-bit RGBA rows (`width * 4` per row), whatever its color type; null when the picture data is damaged. */
function toRgba(p: Parsed): Buffer | null {
  const bpp = CHANNELS[p.colorType]!;
  let raw: Buffer | null;
  try {
    raw = unfilter(inflateSync(p.idat, { maxOutputLength: p.height * (p.width * bpp + 1) + 1 }), p.width, p.height, bpp);
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (p.colorType === 6) return raw;
  const palette = p.keep.find((k) => k.type === "PLTE")?.data;
  const alpha = p.keep.find((k) => k.type === "tRNS")?.data;
  const out = Buffer.alloc(p.width * p.height * 4);
  for (let i = 0; i < p.width * p.height; i++) {
    const s = i * bpp;
    let px: [number, number, number, number];
    switch (p.colorType) {
      case 0: px = [raw[s]!, raw[s]!, raw[s]!, 255]; break;
      case 2: px = [raw[s]!, raw[s + 1]!, raw[s + 2]!, 255]; break;
      case 3: px = [palette?.[raw[s]! * 3] ?? 0, palette?.[raw[s]! * 3 + 1] ?? 0, palette?.[raw[s]! * 3 + 2] ?? 0, alpha?.[raw[s]!] ?? 255]; break;
      default: px = [raw[s]!, raw[s]!, raw[s]!, raw[s + 1]!];
    }
    out.set(px, i * 4);
  }
  return out;
}

/**
 * The rectangle (x, y, w, h) of the picture with a closed path on it: `points` are in the picture's own pixel coordinates, closed implicitly. A
 * pixel is inside when its centre (column + 0.5, row + 0.5) is inside the path by the even-odd rule. Every pixel outside is dimmed to 40% of its
 * color (alpha kept), every pixel inside keeps its source value, and the path is drawn as a 2-pixel red outline (every pixel whose centre is
 * within 1 pixel of an edge). The output is 8-bit RGBA whatever the source's color type.
 */
export function cropPngPath(png: Buffer, x: number, y: number, w: number, h: number, points: Array<[number, number]>): { png: Buffer } | { refused: string } {
  const p = parse(png);
  if ("refused" in p) return p;
  if (![x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > p.width || y + h > p.height || points.length < 3) return { refused: "the rectangle is not inside the picture" };
  const rgba = toRgba(p);
  if (rgba === null) return { refused: "the PNG's picture data is damaged" };
  const rows = Buffer.alloc(h * (w * 4 + 1));
  const edges = points.map((a, i) => [a, points[(i + 1) % points.length]!] as const).map(([a, b]) => [a[0] - x, a[1] - y, b[0] - x, b[1] - y] as const);
  for (let r = 0; r < h; r++) {
    const o = r * (w * 4 + 1);
    rgba.copy(rows, o + 1, ((y + r) * p.width + x) * 4, ((y + r) * p.width + x + w) * 4);
    // even-odd along this row: the pixels whose centre lies between an odd and the next crossing are inside
    const yc = r + 0.5;
    const xs: number[] = [];
    for (const [x1, y1, x2, y2] of edges) if (y1 <= yc !== y2 <= yc) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    xs.sort((a, b) => a - b);
    const inside = new Uint8Array(w);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const to = Math.min(w - 1, Math.ceil(xs[k + 1]! - 0.5) - 1);
      for (let i = from; i <= to; i++) inside[i] = 1;
    }
    for (let i = 0; i < w; i++) {
      if (inside[i] === 1) continue;
      for (let c = 0; c < 3; c++) rows[o + 1 + i * 4 + c] = Math.round(rows[o + 1 + i * 4 + c]! * DIM);
    }
  }
  for (const [x1, y1, x2, y2] of edges) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const c0 = Math.max(0, Math.floor(Math.min(x1, x2) - 1));
    const c1 = Math.min(w - 1, Math.ceil(Math.max(x1, x2) + 1));
    const r0 = Math.max(0, Math.floor(Math.min(y1, y2) - 1));
    const r1 = Math.min(h - 1, Math.ceil(Math.max(y1, y2) + 1));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c + 0.5 - x1) * dx + (r + 0.5 - y1) * dy) / len2));
        if (Math.hypot(c + 0.5 - (x1 + t * dx), r + 0.5 - (y1 + t * dy)) <= 1) rows.set(OUTLINE, r * (w * 4 + 1) + 1 + c * 4);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return { png: Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]) };
}
