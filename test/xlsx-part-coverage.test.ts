import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { NOISE_CLASSES, PART_UNIVERSE, classifyPart, sharedStringsReordered } from "../src/office/connector/xlsx/parts.ts";

const layer = createXlsxLayer({ openState: async () => "closed" });
const FIX = new URL("./fixtures/xlsx-parts/", import.meta.url);
const load = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(new URL(n, FIX)));
const MTIME = new Date(2020, 0, 1);

async function rows(a: Uint8Array, b: Uint8Array) {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  await writeFile(path.join(dir, "a.xlsx"), a);
  await writeFile(path.join(dir, "b.xlsx"), b);
  return layer.diff(path.join(dir, "a.xlsx"), path.join(dir, "b.xlsx"));
}
const contentRows = (r: Awaited<ReturnType<typeof rows>>) => r.filter((x) => !x.wholeFile);

function mutate(base: Uint8Array, edit: (parts: Record<string, Uint8Array>) => void): Uint8Array {
  const parts = unzipSync(base);
  edit(parts);
  return zipSync(parts, { mtime: MTIME });
}
const patch = (parts: Record<string, Uint8Array>, name: string, f: (s: string) => string): void => {
  const before = strFromU8(parts[name]!);
  const after = f(before);
  assert.notEqual(after, before, `${name} edit applied`);
  parts[name] = strToU8(after);
};

// Every part name seen in the 42 corpus pairs of an Excel stress run (digits folded to 1).
const CORPUS_PARTS = [
  "xl/worksheets/sheet1.xml", "xl/worksheets/_rels/sheet1.xml.rels", "xl/workbook.xml", "xl/theme/theme1.xml", "xl/styles.xml",
  "xl/_rels/workbook.xml.rels", "docProps/core.xml", "docProps/app.xml", "[Content_Types].xml", "_rels/.rels", "xl/tables/table1.xml",
  "xl/drawings/drawing1.xml", "xl/drawings/_rels/drawing1.xml.rels", "xl/charts/chart1.xml", "xl/sharedStrings.xml", "docProps/custom.xml",
  "xl/comments1.xml", "xl/drawings/vmlDrawing1.vml", "xl/charts/style1.xml", "xl/charts/colors1.xml", "xl/charts/_rels/chart1.xml.rels",
  "xl/drawings/commentsDrawing1.vml", "xl/comments/comment1.xml", "xl/pivotCache/pivotCacheRecords1.xml", "xl/externalLinks/_rels/externalLink1.xml.rels",
  "xl/calcChain.xml", "xl/drawings/vmlDrawing2.vml",
];
// Plus the SpreadsheetML part types the corpus does not contain.
const SPEC_PARTS = [
  "xl/chartsheets/sheet1.xml", "xl/pivotTables/pivotTable1.xml", "xl/pivotCache/pivotCacheDefinition1.xml", "xl/externalLinks/externalLink1.xml", "xl/connections.xml",
  "xl/queryTables/queryTable1.xml", "xl/metadata.xml", "xl/richData/rdrichvalue.xml", "xl/vbaProject.bin", "xl/printerSettings/printerSettings1.bin", "xl/media/image1.png",
  "xl/embeddings/oleObject1.bin", "xl/slicers/slicer1.xml", "xl/slicerCaches/slicerCache1.xml", "xl/timelines/timeline1.xml", "xl/threadedComments/threadedComment1.xml",
  "xl/persons/person.xml", "xl/ctrlProps/ctrlProp1.xml", "xl/activeX/activeX1.xml", "xl/model/item.data", "customXml/item1.xml", "docProps/thumbnail.jpeg",
];

describe("part universe", () => {
  it("every corpus part and every spec part type is named by a rule, not left to the default", () => {
    const last = PART_UNIVERSE.length - 1;
    for (const name of [...CORPUS_PARTS, ...SPEC_PARTS]) {
      const hit = PART_UNIVERSE.findIndex((r) => r.pattern.test(name));
      assert.ok(hit >= 0 && hit < last, `${name} is only caught by the unknown-part default`);
    }
  });

  it("an unknown part defaults to changed, not interpreted", () => {
    assert.equal(classifyPart("xl/somethingNew/x.xml"), "opaque");
    assert.equal(classifyPart("xl/calcChain2.xml"), "opaque");
  });

  it("the noise list is exactly calcChain, app.xml, core.xml and the thumbnail", () => {
    const noise = [...CORPUS_PARTS, ...SPEC_PARTS].filter((n) => classifyPart(n) === "noise").sort();
    assert.deepEqual(noise, ["docProps/app.xml", "docProps/core.xml", "docProps/thumbnail.jpeg", "xl/calcChain.xml"]);
  });
});

describe("noise folding", () => {
  it("the no-op LBO pair (openpyxl round trip) gives no content cards", async () => {
    const r = await rows(await load("lbo-noop-before.xlsx"), await load("lbo-noop-after.xlsx"));
    assert.equal(contentRows(r).length, 0, `${contentRows(r).length} content cards`);
  });

  it("a real one-cell edit on the LBO workbook still produces its card", async () => {
    const r = await rows(await load("lbo-noop-before.xlsx"), await load("lbo-edit-after.xlsx"));
    assert.equal(contentRows(r).length, 1);
    assert.equal(r[0]!.location, "Assumptions!C7");
    assert.deepEqual([r[0]!.detail.valueBefore, r[0]!.detail.valueAfter], [10, 11]);
  });

  it("a formula whose result was dropped is quiet, but a formula edited at the same time still reads", async () => {
    const before = await load("lbo-noop-before.xlsx");
    const after = mutate(await load("lbo-noop-after.xlsx"), (p) => {
      const name = Object.keys(p).find((n) => /worksheets\/sheet1\.xml$/.test(n))!;
      patch(p, name, (s) => s.replace("<f>C17+1</f>", "<f>C17+2</f>"));
    });
    const r = await rows(before, after);
    assert.deepEqual(contentRows(r).filter((x) => x.kind === "formula").map((x) => x.location), ["Assumptions!D17"]);
  });

  it("calcChain added, removed or changed is noise", async () => {
    const base = await load("lbo-noop-before.xlsx");
    const without = mutate(base, (p) => { delete p["xl/calcChain.xml"]; });
    assert.deepEqual(await rows(base, without), []);
  });

  it("a shared-string reorder with the same cell values is noise", async () => {
    const SST = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>A</t></si><si><t>B</t></si></sst>`;
    const swapped = SST.replace("<si><t>A</t></si><si><t>B</t></si>", "<si><t>B</t></si><si><t>A</t></si>");
    assert.equal(sharedStringsReordered(strToU8(SST), strToU8(swapped)), true);
  });

  it("a shared-string reorder that changes a displayed cell value is NOT noise", async () => {
    const book = (sst: string) => zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`),
      "xl/sharedStrings.xml": strToU8(sst),
    }, { mtime: MTIME });
    const a = book(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Revenue</t></si><si><t>Cost</t></si></sst>`);
    const b = book(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Cost</t></si><si><t>Revenue</t></si></sst>`);
    const r = await rows(a, b);
    assert.equal(contentRows(r).length, 1, "A1 now reads Cost: its card must exist");
    assert.deepEqual([r[0]!.detail.valueBefore, r[0]!.detail.valueAfter], ["Revenue", "Cost"]);
    // An edited item is not a reorder either.
    assert.equal(sharedStringsReordered(strToU8(`<sst><si><t>A</t></si></sst>`), strToU8(`<sst><si><t>A2</t></si></sst>`)), false);
  });
});

describe("one-edit-per-feature mutation corpus: no feature edit is dropped", () => {
  const edits: Array<[string, string, (p: Record<string, Uint8Array>) => void]> = [
    ["defined name", "xl/workbook.xml", (p) => patch(p, "xl/workbook.xml", (s) => s.replace("</workbook>", '<definedNames><definedName name="Growth">Assumptions!$C$7</definedName></definedNames></workbook>'))],
    ["sheet renamed", "xl/workbook.xml", (p) => patch(p, "xl/workbook.xml", (s) => s.replace(/(<sheet\b[^>]*name=")([^"]*)"/, '$1$2 v2"'))],
    ["conditional format", "xl/worksheets/sheet1.xml", (p) => patch(p, "xl/worksheets/sheet1.xml", (s) => s.replace("</worksheet>", '<conditionalFormatting sqref="C7"><cfRule type="cellIs" operator="greaterThan" priority="1"><formula>100</formula></cfRule></conditionalFormatting></worksheet>'))],
    ["data validation", "xl/worksheets/sheet1.xml", (p) => patch(p, "xl/worksheets/sheet1.xml", (s) => s.replace("</worksheet>", '<dataValidations count="1"><dataValidation type="list" sqref="C7"><formula1>"a,b"</formula1></dataValidation></dataValidations></worksheet>'))],
    ["merge", "xl/worksheets/sheet1.xml", (p) => patch(p, "xl/worksheets/sheet1.xml", (s) => s.replace("</worksheet>", '<mergeCells count="1"><mergeCell ref="K1:L1"/></mergeCells></worksheet>'))],
    ["number format", "xl/styles.xml", (p) => patch(p, "xl/styles.xml", (s) => s.replace("<cellXfs", "<!-- x --><cellXfs"))],
    ["comment added", "xl/comments1.xml", (p) => { p["xl/comments1.xml"] = strToU8("<comments/>"); }],
    ["table added", "xl/tables/table1.xml", (p) => { p["xl/tables/table1.xml"] = strToU8("<table/>"); }],
    ["custom properties", "docProps/custom.xml", (p) => { p["docProps/custom.xml"] = strToU8("<Properties/>"); }],
    ["external link", "xl/externalLinks/externalLink1.xml", (p) => { p["xl/externalLinks/externalLink1.xml"] = strToU8("<externalLink/>"); }],
    ["pivot cache", "xl/pivotCache/pivotCacheRecords1.xml", (p) => { p["xl/pivotCache/pivotCacheRecords1.xml"] = strToU8("<pivotCacheRecords/>"); }],
    ["unknown part", "xl/somethingNew/x.xml", (p) => { p["xl/somethingNew/x.xml"] = strToU8("<x/>"); }],
  ];
  for (const [feature, part, edit] of edits) {
    it(`${feature}: the layer reports it, never silence`, async () => {
      const base = await load("lbo-noop-after.xlsx");
      const edited = mutate(base, (p) => {
        if (part.startsWith("xl/worksheets/")) {
          const real = Object.keys(p).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))!;
          const hold = p[real]!;
          delete p[real];
          p["xl/worksheets/sheet1.xml"] = hold;
        }
        edit(p);
      });
      const r = await rows(base, edited);
      assert.ok(r.length > 0, `${feature}: the layer reported nothing`);
    });
  }
});

describe("the five noise rules", () => {
  const sheet = (cell: string) => zipSync({
    "xl/workbook.xml": strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>5</v></c>${cell}</row></sheetData></worksheet>`),
  }, { mtime: MTIME });
  const withValue = (f: string, v: string) => sheet(`<c r="B1"><f>${f}</f>${v}</c>`);

  it("the allow-list is exactly five classes: a sixth must be added here on purpose", () => {
    assert.deepEqual([...NOISE_CLASSES], ["calcChain", "docPropsDatesAndApp", "sharedStringsReorder", "thumbnail", "resultNotStored"]);
    const parts = [...CORPUS_PARTS, ...SPEC_PARTS].filter((n) => classifyPart(n) === "noise").sort();
    assert.deepEqual(parts, ["docProps/app.xml", "docProps/core.xml", "docProps/thumbnail.jpeg", "xl/calcChain.xml"]);
  });

  it("rule 5: a formula result stored on one side only gets no value card", async () => {
    const stored = withValue("A1*2", "<v>10</v>"), dropped = withValue("A1*2", "");
    assert.equal(contentRows(await rows(stored, dropped)).length, 0);
    assert.equal(contentRows(await rows(dropped, stored)).length, 0);
  });

  it("a stored value changed to a different stored value is carded", async () => {
    const r = contentRows(await rows(withValue("A1*2", "<v>10</v>"), withValue("A1*2", "<v>12</v>")));
    assert.equal(r.length, 1);
    assert.deepEqual([r[0]!.detail.valueBefore, r[0]!.detail.valueAfter], [10, 12]);
  });

  it("a stored value changed to an empty string is carded", async () => {
    const r = contentRows(await rows(withValue("A1*2", "<v>10</v>"), sheet(`<c r="B1" t="str"><f>A1*2</f><v></v></c>`)));
    assert.equal(r.length, 1);
  });

  it("a changed formula is carded even when the result was dropped", async () => {
    const r = contentRows(await rows(withValue("A1*2", "<v>10</v>"), withValue("A1*3", "")));
    assert.deepEqual(r.map((x) => x.kind), ["formula"]);
  });
});
