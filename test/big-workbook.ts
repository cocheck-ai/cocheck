import { strToU8, zipSync } from "fflate";

/**
 * Test helper: a minimal, valid xlsx with one sheet of `cells` numeric constants (synthetic), laid out 100 columns wide.
 * `bump` is added to every value, so two builds with different bumps differ in every cell.
 */
export function buildBigWorkbook(cells: number, bump = 0): Uint8Array {
  return sheetWorkbook(bigSheetData(cells, bump));
}

/**
 * a four-cell workbook with two formulas, for checking recalculation and staleness: A1 and C1 are constants, B1 is
 * `A1*2` and D1 is `C1+1`, each with the cached value given (so a test can leave one stale).
 */
export function buildFormulaWorkbook(v: { a: number; b: number; c: number; d: number }): Uint8Array {
  return sheetWorkbook(
    `<row r="1"><c r="A1"><v>${v.a}</v></c><c r="B1"><f>A1*2</f><v>${v.b}</v></c><c r="C1"><v>${v.c}</v></c><c r="D1"><f>C1+1</f><v>${v.d}</v></c></row>`,
  );
}

/**
 * `rows` rows of a constant in column A and `A*2` in column B (cached value filled in), so a change of `bump` moves
 * 2 x `rows` cells and leaves `rows` formula outputs in one column: one huge block for the what-moved summary.
 */
export function buildBigFormulaWorkbook(rows: number, bump = 0): Uint8Array {
  const parts: string[] = [];
  for (let r = 1; r <= rows; r++) parts.push(`<row r="${r}"><c r="A${r}"><v>${r + bump}</v></c><c r="B${r}"><f>A${r}*2</f><v>${(r + bump) * 2}</v></c></row>`);
  return sheetWorkbook(parts.join(""));
}

function bigSheetData(cells: number, bump: number): string {
  const col = (i: number): string => {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const WIDTH = 100;
  const parts: string[] = [];
  for (let r = 0; r * WIDTH < cells; r++) {
    const cs: string[] = [];
    for (let c = 0; c < WIDTH && r * WIDTH + c < cells; c++) cs.push(`<c r="${col(c)}${r + 1}"><v>${r * WIDTH + c + bump}</v></c>`);
    parts.push(`<row r="${r + 1}">${cs.join("")}</row>`);
  }
  return parts.join("");
}

function sheetWorkbook(sheetData: string): Uint8Array {
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${sheetData}</sheetData></worksheet>`),
  };
  return zipSync(files, { mtime: new Date(2020, 0, 1) });
}
