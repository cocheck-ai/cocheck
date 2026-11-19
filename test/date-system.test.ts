import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { beforeAfterText, formatValue } from "./helpers/xlsx-shown.ts";

// the dates are numFmtId 14, which follows the Mac's region; the test pins it.
process.env.COCHECK_LOCALE = "en-US";

const ZIP_MTIME = new Date(2020, 0, 1);
const enc = (s: string) => new TextEncoder().encode(s);

/** A minimal xlsx whose A1 holds `serial` under a date number format; `date1904` is the workbook flag attribute text. */
function dateBook(serial: number, date1904: string | null): Uint8Array {
  return zipSync(
    {
      "xl/workbook.xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${date1904 === null ? "" : `<workbookPr date1904="${date1904}"/>`}
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
      "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
      "xl/styles.xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`),
      "xl/worksheets/sheet1.xml": enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>${serial}</v></c></row></sheetData></worksheet>`),
    },
    { mtime: ZIP_MTIME },
  );
}

async function reviewText(before: Uint8Array, after: Uint8Array): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "datesys-"));
  try {
    const a = path.join(dir, "a.xlsx");
    const b = path.join(dir, "b.xlsx");
    await writeFile(a, before);
    await writeFile(b, after);
    const rows = await createXlsxLayer({ openState: async () => "closed" }).diff(a, b);
    assert.equal(rows.length, 1);
    const d = rows[0]!.detail as Record<string, unknown>;
    const t = beforeAfterText(rows[0]!.before, rows[0]!.after, d.numFmtBefore, d.numFmtAfter, d.dateSystem as 1900 | 1904 | undefined);
    return [t.before, t.after];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("workbook date system", () => {
  it("the reader reports 1904 for date1904=1 or true, and 1900 when absent or false", () => {
    assert.equal(readWorkbookSnapshot(dateBook(43951, "1")).dateSystem, 1904);
    assert.equal(readWorkbookSnapshot(dateBook(43951, "true")).dateSystem, 1904);
    assert.equal(readWorkbookSnapshot(dateBook(45413, null)).dateSystem, 1900);
    assert.equal(readWorkbookSnapshot(dateBook(45413, "0")).dateSystem, 1900);
  });

  it("formatValue renders the same serial per system", () => {
    assert.equal(formatValue(43951, "m/d/yyyy", false, 1904), "5/1/2024");
    assert.equal(formatValue(45413, "m/d/yyyy", false, 1900), "5/1/2024");
    assert.equal(formatValue(45413, "m/d/yyyy"), "5/1/2024");
    assert.equal(formatValue(43951, "General", false, 1904), "43951");
  });

  it("review rows from a 1904 workbook show the right ISO date, and a 1900 one stays right", async () => {
    assert.deepEqual(await reviewText(dateBook(43951, "1"), dateBook(43952, "1")), ["5/1/2024", "5/2/2024"]);
    assert.deepEqual(await reviewText(dateBook(45413, null), dateBook(45414, null)), ["5/1/2024", "5/2/2024"]);
  });
});
