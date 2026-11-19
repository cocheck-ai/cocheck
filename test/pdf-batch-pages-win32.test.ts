// Batch drawing through the REAL powershell.exe, Windows only (skipped elsewhere). renderPdfPages draws
// two pages of an existing fixture PDF in one powershell.exe call (Windows.Data.Pdf, the pdf.mjs `pngs` mode) and each page must come back "ok" with a
// PNG file behind it. A page is "ok" only when the real script printed its own "PNG-OK <n>" line after the rename, so this cannot pass without the
// real PowerShell. Hard cap: 60 s for the test, 45 s for the reader call (pdf.mjs ends its tree on timeout).
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { renderPdfPages } from "../public-kit/helpers/pdf.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIXTURE = path.join(import.meta.dirname, "fixtures", "pdf-reader", "powerpoint-deck.pdf"); // five pages (its golden)

describe("batch drawing with the real powershell.exe (Windows only)", { skip: process.platform !== "win32" && "Windows only: needs the real powershell.exe" }, () => {
  it("renderPdfPages draws 2 pages in one call: two PNG files with the PNG signature, each page ok", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-pngs-"));
    const file = path.join(dir, "deck.pdf");
    copyFileSync(FIXTURE, file);
    const out = path.join(dir, "out");
    mkdirSync(out);
    const drawn = await renderPdfPages(file, [1, 2], out, 45_000);
    assert.deepEqual(drawn.map((d) => [d.page, d.status]), [[1, "ok"], [2, "ok"]]);
    for (const d of drawn) {
      const png = readFileSync(d.out);
      assert.ok(png.length > PNG_SIGNATURE.length, `${d.out} has content`);
      assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE, `${d.out} starts with the PNG signature`);
    }
    assert.notEqual(drawn[0]!.out, drawn[1]!.out);
  });
});
