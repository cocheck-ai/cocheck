// Windows gets text lines from Mozilla pdf.js: since the unified reader, the same pdf.js reader as every OS (public-kit/helpers/pdf-text.mjs).
// Runs on any OS: the platform is a faked win32 (createWin32 with fake powershell; no real Windows API runs), the pdf.js reader is the real one, and
// the PDFs are LibreOffice conversions of test fixtures (test/fixtures/pdfjs). Where pdf.js fails, hangs or lies, the test passes its own reader.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createWin32, platformFor, type Win32Deps } from "../src/platform/index.ts";
import * as helper from "../src/timeline/render/pdf-helper.ts";
import * as pdf from "../src/timeline/render/pdf.ts";
import type { View } from "../src/timeline/render/types.ts";
import { encodePng } from "./fixtures/png-encode.ts";

const FX = path.join(import.meta.dirname, "fixtures");
const read = (f: string): Buffer => readFileSync(path.join(FX, f));
const SYS = "C:\\Windows";
const POWERSHELL = `${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

const W6 = { before: read("pdfjs/w6-before.pdf"), after: read("pdfjs/w6-after.pdf") };
const PG = { before: read("pdfjs/pg-before.pdf"), after: read("pdfjs/pg-after.pdf") };
const DECK = { before: read("pdfjs/deck-076.pdf"), after: read("pdfjs/deck-076-edit.pdf") };

/** Page sizes the Windows reader reports for each fixture (Letter portrait and 16:9 slides at two pixels per point; PDFKit and pdf.js agree). */
const SIZES = new Map<Buffer, Array<[number, number]>>([
  [W6.before, [[1224, 1584]]],
  [W6.after, [[1224, 1584]]],
  [DECK.before, [[1920, 1080], [1920, 1080]]],
  [DECK.after, [[1920, 1080], [1920, 1080]]],
  [PG.before, Array.from({ length: 6 }, (): [number, number] => [1440, 810])],
  [PG.after, Array.from({ length: 6 }, (): [number, number] => [1440, 810])],
]);

/**
 * A faked win32: powershell answers "pages" with the sizes of whichever fixture the temp copy holds (or `pagesFor`), and "png" with a white page of
 * that size. Nothing else is spawned through it (the pdf.js child is a plain Node process the helper starts itself).
 */
function fakeWin32(o: { pagesFor?: (bytes: Buffer) => Array<[number, number]> | "fail" } = {}) {
  const spawned: string[] = [];
  const deps: Partial<Win32Deps> = {
    env: { SystemRoot: SYS },
    exists: (f) => f === POWERSHELL || existsSync(f),
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    spawn: ((command: string) => {
      spawned.push(command);
      const child: any = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), {
        end: (input: string) => setImmediate(() => {
          const lines = input.split("\n");
          const file = Buffer.from(lines[1]!, "base64").toString("utf8");
          const bytes = readFileSync(file);
          const known = [...SIZES.keys()].find((k) => k.equals(bytes));
          const sizes = o.pagesFor ? o.pagesFor(bytes) : known ? SIZES.get(known)! : "fail";
          if (sizes === "fail") { child.emit("close", 1); return; }
          if (lines[0] === "pages") {
            child.stdout.emit("data", Buffer.from(sizes.map(([w, h], i) => `${i + 1} ${w} ${h}\r\n`).join("")));
          } else {
            const n = Number(lines[2]);
            const [w, h] = sizes[n - 1]!;
            writeFileSync(Buffer.from(lines[3]!, "base64").toString("utf8"), encodePng({ width: w, height: h, colorType: 0, raw: Buffer.alloc(w * h, 255), filters: [0] }));
          }
          child.emit("close", 0);
        }),
      });
      return child;
    }) as any,
  };
  return { plat: createWin32(deps), spawned };
}

const info = (file: string) => ({ id: "c1", file, kind: "modified" as const });
type Reader = NonNullable<pdf.PdfViewOptions["readText"]>;
const FAILS: Reader = async () => ({ pages: null, error: "failed" });
/** A reader that never answers on its own: the kit's real time limit is what stops it (a read past timeoutMs answers "timeout"). */
const HANGS: Reader = (_b, o) => new Promise((r) => setTimeout(() => r({ pages: null, error: "timeout" }), Math.min(o.timeoutMs, 400)));
const LIES: Reader = async () => ({ pages: [{ index: 1, width: 1224, height: 1584, runs: [{ text: "x", x: Number.NaN, y: 0, w: 1, h: 1 }] }], error: null });

describe("(2) faked win32: text runs through pdf.js", () => {
  it("the win32 reader gives text runs through pdf.js", async () => {
    const { plat } = fakeWin32();
    assert.equal(helper.pdfTextRuns(plat), true, "win32 says it has text runs when pdf.js is installed");
    const out = await helper.readPdfOutcome(W6.before, plat);
    assert.ok(out.pages !== null && out.pages.length === 1);
    assert.ok(out.pages[0]!.runs.some((r) => r.text === "Actions"), "the heading is a run");
    assert.deepEqual([out.pages[0]!.width, out.pages[0]!.height], SIZES.get(W6.before)![0]);
  });
});

describe("(3) any pdf.js trouble is today's picture-only view, never a box", () => {
  const pictureOnly = async (plat: ReturnType<typeof createWin32>, p = W6, readText?: Reader): Promise<View> => {
    const v = await pdf.viewPdfs(p.before, p.after, info("r.pdf"), { platform: plat, ...(readText ? { readText } : {}) });
    assert.equal(v.kind, "pages");
    assert.ok(v.caveats.includes(pdf.NO_BOXES), "says boxes are not drawn");
    assert.deepEqual(v.boxes, []);
    assert.equal(v.changes, undefined);
    assert.ok(v.before.length > 0 && v.after.length > 0, "the pictures still stand");
    return v;
  };

  it("pdf.js fails: no runs, picture-only view", async () => {
    const { plat } = fakeWin32();
    const t = await helper.readPdfText(W6.before, plat, FAILS);
    assert.equal(t.textRuns, false);
    assert.ok(t.pages !== null && t.pages.every((p) => p.runs.length === 0), "pictures keep their sizes, no runs");
    await pictureOnly(plat, W6, FAILS);
  });

  it("pdf.js hangs: stopped at its time limit (the real reader's, shortened), picture-only view, in bounded time", async () => {
    const { plat } = fakeWin32();
    const t0 = Date.now();
    assert.equal((await helper.readPdfText(W6.before, plat, HANGS)).textRuns, false);
    await pictureOnly(plat, W6, HANGS);
    assert.ok(Date.now() - t0 < 15_000, "the time limit held");
  });

  it("malformed output (a run with a non-number rectangle) is not drawn", async () => {
    const { plat } = fakeWin32({ pagesFor: () => [[1224, 1584]] });
    const v = await pdf.viewPdfs(W6.before, W6.after, info("r.pdf"), { platform: plat, readText: LIES });
    assert.doesNotMatch(JSON.stringify(v.boxes), /null|NaN/, "no box from a NaN rectangle");
  });

  it("a damaged PDF the Windows reader still sizes: pdf.js cannot read it, picture-only view", async () => {
    const broken = Buffer.concat([W6.before.subarray(0, 600), Buffer.from("garbage")]);
    const brokenA = Buffer.concat([W6.after.subarray(0, 600), Buffer.from("garbage")]);
    const { plat } = fakeWin32({ pagesFor: () => [[1224, 1584]] });
    assert.equal((await helper.readPdfText(broken, plat)).textRuns, false);
    await pictureOnly(plat, { ...W6, before: broken, after: brokenA });
  });

  it("pdf.js and the Windows reader disagree on the pages (size or count): its rectangles are not trusted", async () => {
    const skew = fakeWin32({ pagesFor: (b) => (SIZES.get([...SIZES.keys()].find((k) => k.equals(b))!) ?? []).map(([w, h]) => [w + 40, h]) });
    assert.equal((await helper.readPdfText(W6.before, skew.plat)).textRuns, false);
    await pictureOnly(skew.plat);
    const extra = fakeWin32({ pagesFor: () => [[1224, 1584], [1224, 1584]] });
    assert.equal((await helper.readPdfText(W6.before, extra.plat)).textRuns, false);
  });
});
