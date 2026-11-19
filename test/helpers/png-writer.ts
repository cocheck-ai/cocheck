// Writes small 8-bit RGB PNG files for the pixel check's tests (real PNGs: signature, IHDR, IDAT, IEND, CRCs).
import { crc32, deflateSync } from "node:zlib";

const chunk = (type: string, body: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};

/** A width x height picture; `paint(x, y)` gives each pixel's [r, g, b]. */
export function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = paint(x, y);
    raw[y * (width * 3 + 1) + 1 + x * 3] = r; raw[y * (width * 3 + 1) + 2 + x * 3] = g; raw[y * (width * 3 + 1) + 3 + x * 3] = b;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
