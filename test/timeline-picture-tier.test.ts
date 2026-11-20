import { afterEach, describe, it } from "node:test";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { NOT_VISIBLE, PICTURE_LABEL, decodePng, pictureTier, type PictureInput } from "../src/timeline/picture.ts";
import { storeDirOf } from "../src/states.ts";

// The picture tier. Image states are shown by the browser from the stored bytes; nothing is rendered. Synthetic PNGs are
// stored directly: `world` maps a tiny text description of a picture to PNG bytes before storing it.

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), body])));
  return Buffer.concat([head, Buffer.from(type), body, tail]);
};
/** An RGB PNG, white, with black rectangles. Filter type cycles per row so the decoder's four filters are all exercised. */
function png(w: number, h: number, rects: Array<[number, number, number, number]> = [], colorType: 2 | 6 = 6): Buffer {
  const ch = colorType === 6 ? 4 : 3;
  const px = Buffer.alloc(w * h * ch, 255);
  for (const [rx, ry, rw, rh] of rects) for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) for (let c = 0; c < 3; c++) px[(y * w + x) * ch + c] = 0;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const filter = y % 5;
    const cur = px.subarray(y * w * ch, (y + 1) * w * ch), prev = y ? px.subarray((y - 1) * w * ch, y * w * ch) : Buffer.alloc(w * ch);
    const out = Buffer.alloc(w * ch);
    for (let i = 0; i < out.length; i++) {
      const a = i >= ch ? cur[i - ch]! : 0, b = prev[i]!, c = i >= ch ? prev[i - ch]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      out[i] = (cur[i]! - pred) & 255;
    }
    rows.push(Buffer.concat([Buffer.from([filter]), out]));
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** A state is described by JSON `{w, h, rects, t}` and stored as that PNG. "FAIL" and "GARBAGE" are stored as they are (no PNG). */
const bytesOf = (text: string): Buffer | string => {
  if (text === "FAIL" || text === "GARBAGE") return text;
  const d = JSON.parse(text) as { w: number; h: number; rects?: Array<[number, number, number, number]>; t?: 2 | 6 };
  return png(d.w, d.h, d.rects ?? [], d.t ?? 6);
};

async function world(states: Record<string, string>) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-pic-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const dir = storeDirOf(home, 1);
  await mkdir(dir, { recursive: true });
  const stored = new Map<string, number>();
  const shas: Record<string, string> = {};
  for (const [name, text] of Object.entries(states)) {
    shas[name] = sha(text);
    const bytes = bytesOf(text);
    await writeSealed(path.join(dir, shas[name]), bytes);
    stored.set(shas[name], bytes.length);
  }
  const input = (before: string | null, after: string | null, extra: Partial<PictureInput> = {}): PictureInput => ({
    home, taskId: 1, filePath: "/w/report.png", before: before && shas[before]!, after: after && shas[after]!, stored,
    sizes: { before: 1, after: 1 }, ...extra,
  });
  return { home, shas, stored, input };
}
const page = (rects: Array<[number, number, number, number]> = [], w = 200, h = 120, t: 2 | 6 = 6): string => JSON.stringify({ w, h, rects, t });

describe("PNG decoder", () => {
  it("reads RGB and RGBA pictures across all five row filters", () => {
    for (const type of [2, 6] as const) {
      const p = decodePng(png(37, 23, [[5, 3, 10, 6]], type))!;
      assert.deepEqual([p.w, p.h], [37, 23]);
      assert.deepEqual([...p.data.subarray((3 * 37 + 5) * 4, (3 * 37 + 5) * 4 + 4)], [0, 0, 0, 255]);
      assert.deepEqual([...p.data.subarray(0, 4)], [255, 255, 255, 255]);
    }
  });
  it("returns null for bytes that are not a PNG", () => assert.equal(decodePng(Buffer.from("not a png at all, not at all, nope")), null));
});

describe("picture tier", () => {
  it("an ending a built-in connector claims is a fingerprint with no picture; an image ending keeps its picture", async (t) => {
    // the claims are the shipped built-ins' manifests (the test bootstrap registers none by default)
    setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
    t.after(() => setBuiltinConnectorsForTest(undefined));
    const w = await world({ a: page(), b: page([[50, 40, 30, 20]]) });
    for (const ext of [".xlsx", ".XLSM", ".docx", ".pptx", ".PPTM", ".ppsx", ".ppsm"]) {
      const g = (await pictureTier(w.input("a", "b", { filePath: `/w/book${ext}` })))!;
      assert.equal(g.tier, "fingerprint", ext);
      assert.equal(g.picture, undefined, ext);
    }
    for (const f of ["/w/report.png", "/w/p.JPG", "/w/p.jpeg", "/w/p.gif", "/w/p.webp", "/w/p.svg"]) {
      assert.equal((await pictureTier(w.input("a", "b", { filePath: f })))!.tier, "picture", f);
    }
    for (const f of ["/w/deck.pdf", "/w/thing.pages", "/w/x.xlsb", "/w/noext"]) {
      assert.equal((await pictureTier(w.input("a", "b", { filePath: f })))!.tier, "fingerprint", f);
    }
  });

  it("a PNG with a changed region: names both hashes, the pixel size and the changed box, with the honest label", async () => {
    const w = await world({ a: page(), b: page([[50, 40, 30, 20]]) });
    const g = (await pictureTier(w.input("a", "b")))!;
    assert.equal(g.tier, "picture");
    assert.equal(g.label, PICTURE_LABEL);
    assert.deepEqual(g.picture, { before: w.shas.a, after: w.shas.b, width: 200, height: 120, regions: [{ x: 50, y: 40, w: 30, h: 20 }] });
    assert.equal(g.secret, undefined);
  });

  it("two separate changes stay two boxes", async () => {
    const w = await world({ a: page(), b: page([[10, 10, 20, 20], [150, 90, 30, 20]]) });
    const g = (await pictureTier(w.input("a", "b")))!;
    assert.deepEqual(g.picture!.regions, [{ x: 10, y: 10, w: 20, h: 20 }, { x: 150, y: 90, w: 30, h: 20 }]);
  });

  it("two PNGs with the same pixels but different bytes: the note and the label say it isn't visible", async () => {
    const w = await world({ a: page([[20, 20, 50, 10]], 200, 120, 6), b: page([[20, 20, 50, 10]], 200, 120, 2) });
    const g = (await pictureTier(w.input("a", "b")))!;
    assert.notEqual(w.shas.a, w.shas.b);
    assert.equal(g.tier, "picture");
    assert.deepEqual(g.picture!.regions, []);
    assert.equal(g.picture!.note, NOT_VISIBLE);
    assert.equal(g.label, `${PICTURE_LABEL}. ${NOT_VISIBLE}.`);
  });

  it("a file type that is not an image is a fingerprint with the reason in words, naming no OS", async () => {
    const w = await world({ a: "FAIL", b: page() });
    const g = (await pictureTier(w.input("a", "b", { filePath: "/w/data.bin", sizes: { before: 4, after: 9 } })))!;
    assert.equal(g.tier, "fingerprint");
    assert.equal(g.picture, undefined);
    assert.equal(g.fingerprint!.kind, "bin");
    assert.deepEqual(g.fingerprint!.before, { sha: w.shas.a, size: 4 });
    assert.deepEqual(g.fingerprint!.after, { sha: w.shas.b, size: w.stored.get(w.shas.b!) });
    assert.match(g.fingerprint!.note, /only png, jpg, gif, webp and svg/);
    assert.doesNotMatch(`${g.label} ${g.fingerprint!.note}`, /macOS|Quick Look/);
    assert.match(g.label, /^No preview of this change: /);
  });

  it("an image the pixel diff cannot read is still a picture, with no boxes", async () => {
    const w = await world({ a: page(), b: "GARBAGE" });
    const g = (await pictureTier(w.input("a", "b")))!;
    assert.equal(g.tier, "picture");
    assert.deepEqual(g.picture!.regions, []);
    assert.equal(g.picture!.note, undefined);
  });

  it("a state missing from the store falls to a fingerprint saying so", async () => {
    const w = await world({ a: page(), b: page([[1, 1, 5, 5]]) });
    w.stored.delete(w.shas.a!);
    const gone = (await pictureTier(w.input("a", "b")))!;
    assert.deepEqual([gone.tier, /no longer in the store/.test(gone.fingerprint!.note)], ["fingerprint", true]);
  });

  // A one-sided picture draws plain, like a created text or PDF file: the whole file is new (or gone), so there is nothing to box; its own side gives the size.
  it("a created file has no before; it draws plain, with no regions and its own size", async () => {
    const w = await world({ b: page([[30, 30, 40, 10]]) });
    const g = (await pictureTier(w.input(null, "b")))!;
    assert.deepEqual(g.picture, { before: null, after: w.shas.b, width: 200, height: 120, regions: [] });
    assert.equal(g.label, PICTURE_LABEL);
  });

  it("a deleted file has no after; it draws plain, with no regions and its own size", async () => {
    const w = await world({ a: page([[30, 30, 40, 10]]) });
    const g = (await pictureTier(w.input("a", null)))!;
    assert.deepEqual(g.picture, { before: w.shas.a, after: null, width: 200, height: 120, regions: [] });
    assert.equal(g.label, PICTURE_LABEL);
  });

  it("a created fingerprint has a null before, a deleted one a null after", async () => {
    const w = await world({ a: "FAIL" });
    assert.equal((await pictureTier(w.input(null, "a", { filePath: "/w/data.bin" })))!.fingerprint!.before, null);
    assert.equal((await pictureTier(w.input("a", null, { filePath: "/w/data.bin" })))!.fingerprint!.after, null);
  });

  it("a secret file is never pictured, whatever the bytes", async () => {
    const w = await world({ a: page(), b: page([[50, 40, 30, 20]]) });
    const g = (await pictureTier(w.input("a", "b", { filePath: "/w/.env", isSecret: (f) => f.endsWith(".env") })))!;
    assert.equal(g.tier, "fingerprint");
    assert.equal(g.secret, true);
    assert.equal(g.picture, undefined);
    assert.equal(g.label, "A secret file was changed: .env");
  });

  it("identical pictures never come back without the note, for any file name or shape", async () => {
    const w = await world({ a: page([[5, 5, 9, 9]], 200, 120, 6), b: page([[5, 5, 9, 9]], 200, 120, 2), c: page([], 64, 64, 6), d: page([], 64, 64, 2) });
    for (const [x, y, f] of [["a", "b", "/w/x.png"], ["c", "d", "/w/blank.PNG"]] as const) {
      const g = (await pictureTier(w.input(x, y, { filePath: f })))!;
      assert.equal(g.picture!.regions.length, 0, f);
      assert.equal(g.picture!.note, NOT_VISIBLE, f);
      assert.ok(g.label.includes(NOT_VISIBLE), f);
    }
  });

  it("a text file is left to the text tier", async () => {
    const w = await world({ a: page(), b: page([[1, 1, 3, 3]]) });
    assert.equal(await pictureTier(w.input("a", "b", { isText: () => true })), null);
  });

  it("a large picture with a large changed area stays fast", async () => {
    const w = await world({ a: page([], 1024, 1024), b: page([[0, 0, 1024, 1024], ], 1024, 1024) });
    const t0 = performance.now();
    const g = (await pictureTier(w.input("a", "b")))!;
    const ms = performance.now() - t0;
    assert.deepEqual(g.picture!.regions, [{ x: 0, y: 0, w: 1024, h: 1024 }]);
    assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
    console.log(`picture tier on 1024x1024 fully changed: ${ms.toFixed(0)} ms (includes read, decode, diff)`);
  });

  it("many scattered changes collapse to a bounded number of regions", async () => {
    const rects: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 40; i++) rects.push([(i % 8) * 60 + 5, Math.floor(i / 8) * 60 + 5, 4, 4]);
    const w = await world({ a: page([], 500, 320), b: page(rects, 500, 320) });
    const g = (await pictureTier(w.input("a", "b")))!;
    assert.ok(g.picture!.regions.length <= 20);
    assert.ok(g.picture!.regions.length >= 1);
  });
});
