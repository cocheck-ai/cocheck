import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;

function book(): Uint8Array {
  const enc = new TextEncoder();
  return zipSync(
    { "xl/workbook.xml": enc.encode(WORKBOOK_XML), "xl/_rels/workbook.xml.rels": enc.encode(WORKBOOK_RELS), "xl/worksheets/sheet1.xml": enc.encode(SHEET) },
    { mtime: new Date(2020, 0, 1) },
  );
}

describe("an unsaved workbook's snapshot refusal", () => {
  it("is the code plus the one sentence", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cocheck-unsaved-layer-"));
    const file = path.join(work, "book.xlsx");
    await writeFile(file, book());
    const layer = createXlsxLayer({ openState: async () => "unsaved" });
    await assert.rejects(layer.snapshot(file, path.join(work, "copy.xlsx")), (e: Error & { code?: string }) => {
      assert.equal(`${e.code}: ${e.message}`, `UNSAVED_CHANGES_OPEN: "book.xlsx" is open in Excel with unsaved changes. Save the workbook in Excel, then I'll retry.`);
      return true;
    });
    await rm(work, { recursive: true, force: true });
  });
});

// Moved from recalc-only-unsaved.test.ts when src/excel/recalc-only.ts was deleted: the layer's `recalcOnly` seam stays.
describe("the layer's recalcOnly seam on an unsaved workbook", () => {
  async function withFile(body: (file: string, dest: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-recalc-layer-"));
    try {
      const file = path.join(dir, "book.xlsx");
      await writeFile(file, "disk bytes");
      return await body(file, path.join(dir, "snap", "book.xlsx"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("copies the file without saving when only computed values moved", async () => {
    await withFile(async (file, dest) => {
      const layer = createXlsxLayer({ openState: async () => "unsaved", recalcOnly: async () => ({ kind: "recalc-only" }) });
      assert.equal(await layer.snapshot(file, dest), "copy");
      assert.equal(await readFile(dest, "utf8"), "disk bytes");
    });
  });

  it("refuses naming the first differing cell, and with the old reason when unverified", async () => {
    await withFile(async (file, dest) => {
      const differs = createXlsxLayer({ openState: async () => "unsaved", recalcOnly: async () => ({ kind: "differs", cell: "Sheet1!C7" }) });
      await assert.rejects(differs.snapshot(file, dest), (e: Error & { code?: string }) => {
        assert.equal(e.code, "UNSAVED_CHANGES_OPEN");
        assert.match(e.message, /Sheet1!C7.*[Ss]ave the workbook in Excel/);
        return true;
      });
      const unverified = createXlsxLayer({ openState: async () => "unsaved", recalcOnly: async () => ({ kind: "unverified" }) });
      await assert.rejects(unverified.snapshot(file, dest), (e: Error) => /^"book.xlsx" is open in Excel with unsaved changes\. Save the workbook in Excel, then I'll retry\.$/.test(e.message));
    });
  });

  it("a closed or saved workbook is copied without asking recalcOnly", async () => {
    await withFile(async (file, dest) => {
      for (const state of ["closed", "saved"] as const) {
        let asked = 0;
        const layer = createXlsxLayer({ openState: async () => state, recalcOnly: async () => { asked += 1; return { kind: "differs", cell: "A1" }; } });
        assert.equal(await layer.snapshot(file, dest), "copy");
        assert.equal(asked, 0);
      }
    });
  });
});
