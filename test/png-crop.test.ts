import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cropPng, decodePng, pngInfo } from "../src/timeline/render/png-crop.ts";
import { CHANNELS, chunkOf, encodePng, picture } from "./fixtures/png-encode.ts";

// Clause 1: the crop decodes to exactly the source pixels of the rectangle, for color types 0, 2, 3, 4 and 6 at 8 bits; an interlaced or
// 16-bit input is refused with a reason. The native renderers (PDFKit's NSBitmapImageRep and `qlmanage -t`) were inspected: both
// write 8-bit, non-interlaced color type 6 (IHDR bytes 0806 0000 00), so type 6 is the live one; the others are covered for any other source.

const expectedRect = (raw: Buffer, width: number, ch: number, x: number, y: number, w: number, h: number): Buffer =>
  Buffer.concat(Array.from({ length: h }, (_, r) => raw.subarray(((y + r) * width + x) * ch, ((y + r) * width + x + w) * ch)));

describe("png-crop: the pixels of the rectangle, exactly", () => {
  for (const type of [0, 2, 3, 4, 6]) {
    it(`color type ${type}: every rectangle decodes to the source pixels, whatever the source row filters`, () => {
      const spec = picture(type, 23, 17);
      const ch = CHANNELS[type]!;
      for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4], [4, 3, 2, 1, 0]]) {
        const src = encodePng({ ...spec, filters });
        for (const [x, y, w, h] of [[0, 0, 23, 17], [5, 3, 9, 8], [0, 0, 1, 1], [22, 16, 1, 1], [11, 0, 12, 17], [0, 9, 23, 8]] as const) {
          const cut = cropPng(src, x, y, w, h);
          assert.ok("png" in cut, JSON.stringify(cut));
          const d = decodePng(cut.png);
          assert.ok("raw" in d, JSON.stringify(d));
          assert.deepEqual([d.width, d.height, d.colorType], [w, h, type]);
          assert.ok(d.raw.equals(expectedRect(spec.raw, 23, ch, x, y, w, h)), `type ${type} filters ${filters} rect ${x},${y},${w},${h}`);
        }
      }
    });
  }

  it("a palette picture keeps its palette and transparency, so the same index shows the same color", () => {
    const spec = picture(3, 12, 10);
    const cut = cropPng(encodePng(spec), 2, 2, 5, 5);
    assert.ok("png" in cut);
    const text = cut.png.toString("latin1");
    assert.ok(text.includes("PLTE") && text.includes("tRNS"));
    assert.ok(cut.png.includes(spec.palette!) && cut.png.includes(spec.trns!));
  });

  it("pngInfo reads size and color type", () => {
    assert.deepEqual(pngInfo(encodePng(picture(6, 8, 5))), { width: 8, height: 5, colorType: 6 });
  });
});

describe("png-crop: refusals give a reason, never a guessed picture", () => {
  const spec = picture(6, 16, 16);
  it("interlaced", () => {
    const r = cropPng(encodePng({ ...spec, interlace: 1 }), 0, 0, 8, 8);
    assert.ok("refused" in r);
    assert.match(r.refused, /interlaced/);
  });
  it("16-bit and other depths", () => {
    for (const bitDepth of [16, 4, 1]) {
      const r = cropPng(encodePng({ ...spec, bitDepth }), 0, 0, 8, 8);
      assert.ok("refused" in r, `depth ${bitDepth}`);
      assert.match(r.refused, new RegExp(`${bitDepth}-bit`));
    }
  });
  it("an unknown color type", () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(4, 0);
    ihdr.writeUInt32BE(4, 4);
    ihdr[8] = 8;
    ihdr[9] = 5;
    const png = Buffer.concat([encodePng(spec).subarray(0, 8), chunkOf("IHDR", ihdr), chunkOf("IDAT", Buffer.alloc(8)), chunkOf("IEND", Buffer.alloc(0))]);
    const r = cropPng(png, 0, 0, 2, 2);
    assert.ok("refused" in r);
    assert.match(r.refused, /color type 5/);
  });
  it("not a PNG, a damaged checksum, a cut-short file, damaged picture data", () => {
    assert.ok("refused" in cropPng(Buffer.from("GIF89a....................................."), 0, 0, 8, 8));
    const good = encodePng(spec);
    const flipped = Buffer.from(good);
    flipped[good.length - 20] ^= 0xff;
    assert.ok("refused" in cropPng(flipped, 0, 0, 8, 8));
    assert.ok("refused" in cropPng(good.subarray(0, good.length - 30), 0, 0, 8, 8));
    const ihdr = Buffer.from(good.subarray(16, 29));
    const bad = Buffer.concat([good.subarray(0, 8), chunkOf("IHDR", ihdr), chunkOf("IDAT", Buffer.from([1, 2, 3, 4])), chunkOf("IEND", Buffer.alloc(0))]);
    const r = cropPng(bad, 0, 0, 8, 8);
    assert.ok("refused" in r);
    assert.match(r.refused, /damaged/);
  });
  it("a rectangle outside the picture or not whole pixels", () => {
    const src = encodePng(spec);
    for (const [x, y, w, h] of [[-1, 0, 4, 4], [0, 0, 17, 4], [10, 10, 7, 7], [0, 0, 0, 4], [0.5, 0, 4, 4], [0, 0, NaN, 4]] as Array<[number, number, number, number]>) assert.ok("refused" in cropPng(src, x, y, w, h), `${x},${y},${w},${h}`);
  });
});
