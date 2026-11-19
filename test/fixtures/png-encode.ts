import { deflateSync } from "node:zlib";

/** A PNG encoder for tests: raw pixel rows in, a PNG out, each row stored with a chosen filter so every decoder path is exercised. Written from the PNG spec, not from src. */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc = (b: Buffer): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
export const chunkOf = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, tail]);
};

export const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface PngSpec {
  width: number;
  height: number;
  colorType: number;
  /** `height` rows of `width * channels` bytes, no filter bytes. */
  raw: Buffer;
  bitDepth?: number;
  interlace?: number;
  palette?: Buffer;
  trns?: Buffer;
  /** Filter type per row (0 to 4), cycled; default cycles through all five. */
  filters?: number[];
}

export function encodePng(s: PngSpec): Buffer {
  const bpp = CHANNELS[s.colorType]!;
  const stride = s.width * bpp;
  const filters = s.filters ?? [0, 1, 2, 3, 4];
  const out = Buffer.alloc(s.height * (stride + 1));
  for (let y = 0; y < s.height; y++) {
    const f = filters[y % filters.length]!;
    out[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = s.raw[y * stride + i]!;
      const a = i >= bpp ? s.raw[y * stride + i - bpp]! : 0;
      const b = y > 0 ? s.raw[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= bpp ? s.raw[(y - 1) * stride + i - bpp]! : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = Math.floor((a + b) / 2);
      else if (f === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s.width, 0);
  ihdr.writeUInt32BE(s.height, 4);
  ihdr[8] = s.bitDepth ?? 8;
  ihdr[9] = s.colorType;
  ihdr[12] = s.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkOf("IHDR", ihdr),
    ...(s.palette === undefined ? [] : [chunkOf("PLTE", s.palette)]),
    ...(s.trns === undefined ? [] : [chunkOf("tRNS", s.trns)]),
    chunkOf("IDAT", deflateSync(out)),
    chunkOf("IEND", Buffer.alloc(0)),
  ]);
}

/** A deterministic picture of a color type: every pixel differs, so a shifted or wrong crop cannot match. */
export function picture(colorType: number, width: number, height: number, seed = 7): PngSpec {
  const ch = CHANNELS[colorType]!;
  const raw = Buffer.alloc(width * height * ch);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < ch; c++) raw[(y * width + x) * ch + c] = colorType === 3 ? (x * 3 + y * 5 + seed) % 16 : (x * 31 + y * 17 + c * 59 + seed * 13) & 0xff;
  const palette = colorType === 3 ? Buffer.from(Array.from({ length: 16 * 3 }, (_, i) => (i * 37 + 11) & 0xff)) : undefined;
  return { width, height, colorType, raw, ...(palette === undefined ? {} : { palette, trns: Buffer.from([255, 128, 0]) }) };
}
