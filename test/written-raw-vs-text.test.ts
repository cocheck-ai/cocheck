import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { canonicalFormula, holds, needsTextForm, textForm } from "../src/office/connector/xlsx/written.ts";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";

// Fixed so two builds of the same workbook are byte-identical; fflate stamps the current time (2 s granularity) otherwise.
const ZIP_MTIME = new Date(2020, 0, 1);

describe("a written string goes raw only if Excel's display of what it stores spells it exactly", () => {
  it("raw vs text table", () => {
    // Seen live: "true" stored as the boolean TRUE, "#N/A" as an error (WRITE_NOT_APPLIED).
    for (const s of ["true", "False", "#N/A", "TRUE ", "- buy milk", "hello", "#DIV/0!", "00123", "1e3", "'x"]) {
      assert.equal(needsTextForm(s), true, s);
      assert.equal(textForm(s), `'${s}`, s);
    }
    for (const s of ["TRUE", "FALSE", "10", "0.5", "-2", "", "=A1+1"]) {
      assert.equal(needsTextForm(s), false, s);
      assert.equal(textForm(s), s, s);
    }
  });

  it("text sent as text is held only as text", () => {
    assert.equal(holds("true", true, null), false);
    assert.equal(holds("true", "true", null), true);
    assert.equal(holds("False", false, null), false);
    assert.equal(holds("TRUE", true, null), true);
    assert.equal(holds("0.5", 0.5, null), true);
  });
});

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

describe("observed cells keep four types", () => {
  it("an error cell never holds written text, and stays distinct from text in the snapshot", () => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="e"><v>#N/A</v></c><c r="B1" t="str"><v>#N/A</v></c><c r="C1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>
</sheetData></worksheet>`;
    const enc = new TextEncoder();
    const book = zipSync({
      "xl/workbook.xml": enc.encode(WORKBOOK_XML),
      "xl/_rels/workbook.xml.rels": enc.encode(WORKBOOK_RELS),
      "xl/worksheets/sheet1.xml": enc.encode(sheet),
    }, { mtime: ZIP_MTIME });
    const cells = readWorkbookSnapshot(book).sheets[0]!.cells;
    assert.equal(holds("#N/A", cells.get("A1")!.value, null), false);
    assert.equal(holds("#N/A", cells.get("B1")!.value, null), true);
    assert.notEqual(cells.get("A1")!.value, cells.get("B1")!.value);
    assert.equal(holds("=1/0", cells.get("C1")!.value, cells.get("C1")!.formula), true);
  });
});

describe("structured-ref shorthand and spill refs compare equal to their file spellings", () => {
  // File spellings are the expected ones.
  it("[@Col] is Table[[#This Row],[Col]]", () => {
    assert.equal(holds("=[@Amount]*2", 0, "Sales[[#This Row],[Amount]]*2"), true);
    assert.equal(holds("=[@[Unit Price]]+1", 0, "T1[[#This Row],[Unit Price]]+1"), true);
    assert.equal(canonicalFormula("=Sales[@Amount]"), canonicalFormula("Sales[[#This Row],[Amount]]"));
    assert.equal(holds("=[@Amount]", 0, "Sales[[#This Row],[Cost]]"), false);
    assert.equal(holds("=[@Amount]", 0, "Sales[Amount]"), false);
  });

  it("A1# is _xlfn.ANCHORARRAY(A1)", () => {
    assert.equal(canonicalFormula("=SUM(A1#)"), canonicalFormula("SUM(_xlfn.ANCHORARRAY(A1))"));
    assert.equal(canonicalFormula("=$B$2#"), canonicalFormula("_xlfn.ANCHORARRAY($B$2)"));
    assert.equal(canonicalFormula("=Inputs!A1#"), canonicalFormula("_xlfn.ANCHORARRAY(Inputs!A1)"));
    assert.notEqual(canonicalFormula("=A1#"), canonicalFormula("_xlfn.ANCHORARRAY(A2)"));
    assert.equal(canonicalFormula("=IFERROR(A1,#N/A)"), canonicalFormula("IFERROR(A1,#N/A)"));
  });
});
