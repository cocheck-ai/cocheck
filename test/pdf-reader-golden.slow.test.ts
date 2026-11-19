// The pdf.js reader's own outputs on Office's PDFs, pinned: a regression test of public-kit/helpers/pdf-text.mjs, the one PDF reader on every OS.
// The fixtures (test/fixtures/pdf-reader) are synthetic documents for an invented company, exported by real Microsoft Office on macOS: a one-page Word
// memo and a 4-page Word report with their .docx, three Excel print pages as the Excel connector prints them (an assumptions sheet, a series sheet
// and a daily-rows sheet, each with row and column headings) and a 5-page PowerPoint deck with a table and charts. Each <name>.golden.json holds the
// page sizes, text runs and chars, the finder's answer to the Word connector's queries, and on macOS each page's crop box (its pixels checked
// against the page drawn in the same run).
//
// A change to these outputs is a change to every box CoCheck draws: regenerate with UPDATE_GOLDEN=1 only after checking why.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ensurePdfHelper } from "../scripts/lib/pdf-helper-cache.ts";
import { fold, readWordParas } from "../src/office/connector/word-boxes.ts";
import { queriesFor, snapshot } from "./helpers/pdf-golden.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "pdf-reader");
const mac = process.platform === "darwin";
if (mac) process.env.COCHECK_PDF_HELPER ??= ensurePdfHelper() ?? undefined;
const pdfs = readdirSync(FIX).filter((f) => f.endsWith(".pdf")).sort();

describe("the pdf.js reader on Office's PDFs: pinned outputs", () => {
  it("the corpus is the one described: Word, Excel and PowerPoint, multi-page, with the Word sources", () => {
    assert.deepEqual(pdfs, ["excel-print-assumptions.pdf", "excel-print-rows116.pdf", "excel-print-series.pdf", "powerpoint-deck.pdf", "word-memo.pdf", "word-report-4pages.pdf"]);
  });

  for (const f of pdfs) {
    it(`${f}: pages, runs, chars${f.startsWith("word-") ? ", the finder" : ""}${mac ? " and crops" : ""} as pinned`, async () => {
      const docx = path.join(FIX, f.replace(/\.pdf$/, ".docx"));
      const queries = existsSync(docx) ? queriesFor(readWordParas(readFileSync(docx)).paras, fold) : undefined;
      const got = await snapshot(readFileSync(path.join(FIX, f)), { ...(queries ? { queries } : {}), crop: mac });
      const file = path.join(FIX, f.replace(/\.pdf$/, ".golden.json"));
      if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, `${JSON.stringify(got, null, 1)}\n`);
      const want = JSON.parse(readFileSync(file, "utf8")) as typeof got;
      assert.deepEqual(got.pages, want.pages, "pages, runs or chars changed");
      assert.deepEqual(got.find, want.find, "the finder's answer changed");
      if (mac) assert.deepEqual(got.crops, want.crops, "a crop changed");
    });
  }
});
