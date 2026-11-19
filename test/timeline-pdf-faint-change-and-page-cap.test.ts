import { after, before, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { makePdf, type Fill } from "./fixtures/make-pdf.ts";
import { IDENTICAL_TOL, NOT_VISIBLE, decodePng, diffPixels, pictureTier, type PictureInput } from "../src/timeline/picture.ts";
import { storeDirOf } from "../src/states.ts";
import type { ChangeInfo } from "../src/timeline/render/types.ts";
import { pdfHelperForTest } from "../scripts/lib/pdf-helper-cache.ts";

// "identical" means no pixel differs by more than 2 in any channel; a faint change is never a match.

const mac = process.platform === "darwin";
const info: ChangeInfo = { id: "c1", file: "doc.pdf", kind: "modified" };
before(async () => {
  if (!mac) return;
  const helper = pdfHelperForTest(); // built once per run by scripts/run-tests.ts, else the shared cache
  assert.ok(helper, "the PDF helper could not be built");
  process.env.COCHECK_PDF_HELPER = helper;
});
after(async () => {
  delete process.env.COCHECK_PDF_HELPER;
});

const body = (prefix: string): string[] => Array.from({ length: 6 }, (_, i) => `${prefix} line ${i + 1} of the report.`);
const t2 = (): string[][] => [body("Alpha"), body("Bravo")];
const fillOf = (gray: number): Fill => ({ x: 100, y: 100, w: 300, h: 300, gray });

describe("the rule", () => {
  it("is 2 per channel", () => assert.equal(IDENTICAL_TOL, 2));
});

describe("PDF pages: a faint change is never a match", { skip: !mac && "needs macOS" }, () => {
  it("a tint probe: a 300x300pt fill at gray 0.95 on page 1 is a pages view with a box on page 1, not a card", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const v = await viewPdfs(makePdf(t2()), makePdf(t2(), [[fillOf(0.95)], []]), info);
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    assert.ok(v.boxes.some((b) => b.pane === "after:page1" && b.confidence === "pixel"), JSON.stringify(v.boxes));
    assert.ok(v.boxes.some((b) => b.pane === "before:page1"));
    assert.ok(!v.caveats.some((c) => /pixel for pixel/.test(c)));
  });
  it("a fill at gray 0.99 (about 3 of 255) is still a change; at 0.995 (about 1) it is identical", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const faint = await viewPdfs(makePdf(t2()), makePdf(t2(), [[fillOf(0.985)], []]), info);
    assert.equal(faint.kind, "pages", JSON.stringify(faint.caveats));
    assert.ok(faint.boxes.length >= 1);
    const same = await viewPdfs(makePdf(t2()), makePdf(t2(), [[fillOf(0.996)], []]), info);
    assert.equal(same.kind, "pages", JSON.stringify(same.caveats));
    assert.match(same.banner!.text, /more than 2 of 255/);
    assert.ok(!same.caveats.some((c) => /pixel for pixel/.test(c)));
  });
  it("render twice, diff at the rule: the same PDF page draws the same (determinism evidence for the docs)", async () => {
    const { renderPdfPage } = await import("../src/timeline/render/pdf-helper.ts");
    const pdf = makePdf([body("Alpha"), body("Bravo")], [[{ x: 50, y: 60, w: 200, h: 100, gray: 0.5 }], []]);
    for (const n of [1, 2]) {
      const [a, b] = [decodePng((await renderPdfPage(pdf, n))!)!, decodePng((await renderPdfPage(pdf, n))!)!];
      assert.deepEqual([a.w, a.h], [b.w, b.h]);
      assert.equal(diffPixels(a, b, IDENTICAL_TOL).count, 0);
      assert.equal(diffPixels(a, b, 0).count, 0, "byte-identical pixels");
    }
  });
});

describe("comparePages boundary", () => {
  it("one pixel changed by 3 in one channel is P-changed with one box; by 2 it is identical", async () => {
    const { comparePages } = await import("../src/timeline/render/pixel-pages.ts");
    const make = (v: number): Buffer => rawPng(40, 40, (x, y) => (x === 7 && y === 9 ? [255 - v, 255, 255] : [255, 255, 255]));
    const run = async (v: number) => comparePages([{ before: 1, after: 1 }], async (side) => (side === "before" ? rawPng(40, 40, () => [255, 255, 255]) : make(v)));
    const three = await run(3);
    assert.equal(three.pages.length, 1);
    assert.deepEqual(three.pages[0]!.regions, [{ x: 7, y: 9, w: 1, h: 1 }]);
    assert.equal((await run(2)).pages.length, 0);
  });
});

describe("page cap order and R caveat", { skip: !mac && "needs macOS" }, () => {
  it("more than 20 R pages plus 2 U pages: both U pages are shown, R pages fill the rest and the others are named", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const lines = Array.from({ length: 42 }, (_, i) => `Unique sentence number ${i + 1} stays here.`);
    const split = (per: number): string[][] => Array.from({ length: Math.ceil(lines.length / per) }, (_, i) => lines.slice(i * per, (i + 1) * per));
    const blk = (i: number): Fill => ({ x: 30 + i * 100, y: 100, w: 50, h: 50 + i * 40, gray: 0 });
    const afterPages = split(3);
    const v = await viewPdfs(makePdf(split(2)), makePdf([...afterPages, [], []], [...afterPages.map(() => [] as Fill[]), [blk(0)], [blk(1)]]), info);
    assert.equal(v.kind, "pages", JSON.stringify(v.caveats));
    const n = afterPages.length;
    const shown = v.after.map((p) => p.id);
    assert.ok(shown.includes(`after:page${n + 1}`) && shown.includes(`after:page${n + 2}`), JSON.stringify(shown));
    assert.equal(v.boxes.filter((b) => b.confidence === "pixel").length, 2);
    // change-first views list every page; the cap of 20 now limits the whole-page U boxes, and what is past it is said
    assert.equal(v.before.filter((p) => !p.absent).length, 21);
    assert.equal(v.after.filter((p) => !p.absent).length, n + 2);
    assert.ok(v.caveats.some((c) => /more pages? \(.*\) (is|are) shown without a box, past the limit of 20/.test(c)), JSON.stringify(v.caveats));
  });
  it("the R caveat says plainly that their pictures were not compared", async () => {
    const { viewPdfs } = await import("../src/timeline/render/pdf.ts");
    const flat = [...body("Alpha"), ...body("Bravo"), ...body("Charlie")];
    const v = await viewPdfs(makePdf([flat.slice(0, 9), flat.slice(9)]), makePdf([flat.slice(0, 6), flat.slice(6, 12), flat.slice(12)]), info);
    const c = v.caveats.find((x) => /Page breaks moved/.test(x));
    assert.ok(c !== undefined, JSON.stringify(v.caveats));
    assert.match(c!, /their pictures were not compared/);
    assert.match(c!, /a change to a picture, chart or fill on one of these pages could be there and would not show here/);
  });
});

describe("image file diff", () => {
  it("a faint fill is not labelled identical / not visible; a change of 2 is", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-q223r4-pic-"));
    try {
      const dir = storeDirOf(home, 1);
      await mkdir(dir, { recursive: true });
      const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
      const stored = new Map<string, number>();
      const states = { a: 255, b: 240, c: 253, d: 252 };
      const shas: Record<string, string> = {};
      // The stored bytes are the PNG itself: the diff reads them directly, nothing is rendered.
      for (const [k, v] of Object.entries(states)) {
        const png = rawPng(60, 60, (x, y) => (x >= 10 && x < 50 && y >= 10 && y < 50 ? [v, v, v] : [255, 255, 255]));
        shas[k] = sha(String(v)); await writeSealed(path.join(dir, shas[k]!), png); stored.set(shas[k]!, png.length);
      }
      const input = (b: string, a: string): PictureInput => ({ home, taskId: 1, filePath: "/w/report.png", before: shas[b]!, after: shas[a]!, stored, sizes: { before: 1, after: 1 } });
      const faint = (await pictureTier(input("a", "b")))!;
      assert.ok(!faint.label.includes(NOT_VISIBLE), faint.label);
      assert.equal(faint.picture!.note, undefined);
      assert.ok(faint.picture!.regions.length >= 1);
      const edge = (await pictureTier(input("a", "d")))!; // 3 off
      assert.ok(edge.picture!.regions.length >= 1);
      const two = (await pictureTier(input("a", "c")))!; // 2 off
      assert.equal(two.picture!.note, NOT_VISIBLE);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([head, Buffer.from(type), data, tail]);
};
/** An RGB PNG whose pixel at (x, y) is colour(x, y). */
function rawPng(w: number, h: number, colour: (x: number, y: number) => [number, number, number]): Buffer {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(colour(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
