import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";

// Fixed so two builds of the same workbook are byte-identical; fflate stamps the current time (2 s granularity) otherwise.
const ZIP_MTIME = new Date(2020, 0, 1);

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/** Builds a minimal-but-valid xlsx package from the parts a caller supplies. */
function buildXlsx(parts: { sheet: string; sharedStrings?: string; styles?: string }): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": new TextEncoder().encode(WORKBOOK_XML),
    "xl/_rels/workbook.xml.rels": new TextEncoder().encode(WORKBOOK_RELS),
    "xl/worksheets/sheet1.xml": new TextEncoder().encode(parts.sheet),
  };
  if (parts.sharedStrings) {
    files["xl/sharedStrings.xml"] = new TextEncoder().encode(parts.sharedStrings);
  }
  if (parts.styles) {
    files["xl/styles.xml"] = new TextEncoder().encode(parts.styles);
  }
  return zipSync(files, { mtime: ZIP_MTIME });
}

describe("shared formula expansion", () => {
  it("expands a shared-formula group's follower cells to per-cell formula text, shifted from the master", () => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="2"><c r="A2"><f t="shared" ref="A2:A4" si="0">B2*2</f><v>10</v></c></row>
<row r="3"><c r="A3"><f t="shared" si="0"/><v>12</v></c></row>
<row r="4"><c r="A4"><f t="shared" si="0"/><v>14</v></c></row>
</sheetData>
</worksheet>`;
    const snapshot = readWorkbookSnapshot(buildXlsx({ sheet }));
    const cells = snapshot.sheets[0]!.cells;
    assert.equal(cells.get("A2")!.formula, "B2*2");
    assert.equal(cells.get("A3")!.formula, "B3*2");
    assert.equal(cells.get("A4")!.formula, "B4*2");
  });

  it("shifts absolute references within a shared formula not at all, and relative refs by the follower's offset", () => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="B1"><f t="shared" ref="B1:B2" si="0">$A$1+A1</f><v>1</v></c></row>
<row r="2"><c r="B2"><f t="shared" si="0"/><v>2</v></c></row>
</sheetData>
</worksheet>`;
    const snapshot = readWorkbookSnapshot(buildXlsx({ sheet }));
    const cells = snapshot.sheets[0]!.cells;
    assert.equal(cells.get("B2")!.formula, "$A$1+A2");
  });

  it("throws a clear error if a follower cell references a shared-formula group whose master was never seen", () => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1"><f t="shared" si="9"/><v>1</v></c></row>
</sheetData>
</worksheet>`;
    assert.throws(() => readWorkbookSnapshot(buildXlsx({ sheet })), /shared formula si=9/);
  });
});

describe("rich-text shared strings", () => {
  it("concatenates multiple <r> runs into a single string, alongside plain <t> entries", () => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
</sheetData>
</worksheet>`;
    const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
<si><r><t>Hello </t></r><r><t>World</t></r></si>
<si><t>Plain</t></si>
</sst>`;
    const snapshot = readWorkbookSnapshot(buildXlsx({ sheet, sharedStrings }));
    const cells = snapshot.sheets[0]!.cells;
    assert.equal(cells.get("A1")!.value, "Hello World");
    assert.equal(cells.get("B1")!.value, "Plain");
  });
});

describe("number formats", () => {
  it("resolves a custom numFmt through cellXfs, and falls back to General with no style table", () => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" s="1"><v>42</v></c><c r="B1"><v>7</v></c></row>
</sheetData>
</worksheet>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs>
</styleSheet>`;
    const snapshot = readWorkbookSnapshot(buildXlsx({ sheet, styles }));
    const cells = snapshot.sheets[0]!.cells;
    assert.equal(cells.get("A1")!.numFmt, "0.0%");
    assert.equal(cells.get("B1")!.numFmt, "General");
  });
});

describe("inline strings", () => {
  it("reads <is> inline-string cells without needing sharedStrings.xml", () => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Inline text</t></is></c></row>
</sheetData>
</worksheet>`;
    const snapshot = readWorkbookSnapshot(buildXlsx({ sheet }));
    assert.equal(snapshot.sheets[0]!.cells.get("A1")!.value, "Inline text");
  });
});

describe("value text with attributes", () => {
  it("reads <v xml:space> text on every value path and leaves other types alone", () => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1">
<c r="A1" t="str"><f>IF(B1=0," ","x")</f><v xml:space="preserve"> </v></c>
<c r="B1" t="str"><f>"a"</f><v>abc</v></c>
<c r="C1"><v>3.5</v></c>
<c r="D1" t="b"><v>1</v></c>
<c r="E1" t="s"><v>0</v></c>
<c r="F1" t="e"><v>#DIV/0!</v></c>
<c r="G1" t="b"><v xml:space="preserve">1</v></c>
<c r="H1"><v xml:space="preserve">7</v></c>
<c r="I1" t="s"><v xml:space="preserve">0</v></c>
<c r="J1" t="e"><v xml:space="preserve">#DIV/0!</v></c>
</row>
</sheetData>
</worksheet>`;
    const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>hello</t></si></sst>`;
    const snap = readWorkbookSnapshot(buildXlsx({ sheet, sharedStrings }));
    const cells = snap.sheets[0]!.cells;
    const v = (a: string) => (cells instanceof Map ? cells.get(a) : (cells as any)[a])?.value;
    assert.equal(v("A1"), " ");
    assert.equal(v("B1"), "abc");
    assert.equal(v("C1"), 3.5);
    assert.equal(v("D1"), true);
    assert.equal(v("E1"), "hello");
    assert.equal(v("G1"), true);
    assert.equal(v("H1"), 7);
    assert.equal(v("I1"), "hello");
    assert.equal(v("F1"), v("J1"));
  });
});
