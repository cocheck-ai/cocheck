// planExcel's zoom sum uses what Excel prints (round(w*8)*0.75 pt per column, rows at 14/15), not the file's widths (trunc(w*7+5)*0.75),
// which are about 15% too generous: a wide region planned a zoom Excel then printed across two pages with the changed cells cut off.
// Guards against: a zoom too big for the printed region. Fixture: 15 columns of width 13 (the GDP pair's A1:O47 shape), edits in H and O.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { planExcel } from "../src/office/connector/excel/diff.ts";

function mini(rows: (string | number | null)[][], width: number, name = "S"): Uint8Array {
  const cols = `<cols><col min="1" max="30" width="${width}" customWidth="1"/></cols>`;
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const col = (c: number): string => { let s = ""; for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const data = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => v === null ? "" : typeof v === "number" ? `<c r="${col(j + 1)}${i + 1}"><v>${v}</v></c>` : v.startsWith("=") ? `<c r="${col(j + 1)}${i + 1}"><f>${esc(v.slice(1))}</f></c>` : `<c r="${col(j + 1)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join("")}</row>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${data}</sheetData></worksheet>`),
  });
}

const rows = (edit: boolean): (string | number | null)[][] => Array.from({ length: 47 }, (_, i) => Array.from({ length: 15 }, (_, j) => (edit && i === 4 && (j === 7 || j === 14) ? "changed" : `v${i}-${j}`)));

describe("planExcel zoom sum over printed widths", () => {
  it("a 15-column region of width-13 columns plans a zoom at which its printed size fits one Letter page", () => {
    const p = planExcel(mini(rows(false), 13), mini(rows(true), 13));
    const sp = p.after[0]!;
    assert.ok(sp.areas.length > 0);
    const PAGE = { w: 576, h: 756 };
    const pw = sp.landscape ? PAGE.h : PAGE.w, ph = sp.landscape ? PAGE.w : PAGE.h;
    for (const a of sp.areas) {
      const cols = a.rect.c2 - a.rect.c1 + 1, nrows = a.rect.r2 - a.rect.r1 + 1;
      const w = 30 + cols * Math.round(13 * 8) * 0.75, h = 16 + nrows * 15 * (14 / 15);
      assert.ok((w * sp.zoom) / 100 <= pw + 0.5, `width ${w} at zoom ${sp.zoom} on ${pw}: ${JSON.stringify(a.rect)}`);
      assert.ok((h * sp.zoom) / 100 <= ph + 0.5, `height ${h} at zoom ${sp.zoom} on ${ph}`);
    }
    assert.ok(sp.zoom < 100, `zoom ${sp.zoom}`);
  });
});
