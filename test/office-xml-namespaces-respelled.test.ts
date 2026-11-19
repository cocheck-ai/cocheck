import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { respell } from "./respell-ooxml.ts";
import { canonicalXml, startTags } from "../src/office/connector/shared/ooxml-names.ts";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";
import { planExcel } from "../src/office/connector/excel/diff.ts";
import { readWorkbook } from "../src/office/connector/excel/workbook.ts";
import { checkStructure } from "../src/office/connector/shared/structure-check.ts";

const FX = path.join(import.meta.dirname, "fixtures");
const fixture = (n: string): Uint8Array => new Uint8Array(readFileSync(path.join(FX, n)));
const parts = (b: Uint8Array): Record<string, Uint8Array> => unzipSync(new Uint8Array(b));
const pack = (z: Record<string, Uint8Array>): Buffer => Buffer.from(zipSync(z as Zippable));
const M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships", P = "http://schemas.openxmlformats.org/package/2006/relationships";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// Finding 1: the same part spelled two ways must give one canonical text, so a comparison of an original with a respelled copy (one side only) finds nothing.
describe("an original compared with a respelled copy of itself finds no change", () => {
  for (const [ext, f, bom] of [[".xlsx", "chart-edit-a.xlsx", false], [".xlsx", "xlsx-prefixed-codex-series.xlsx", false], [".docx", "memo-v1.docx", true], [".pptx", "broken-chart-deck-v1.pptx", false], [".pptx", "ppt-table-deck.pptx", false]] as const) {
    it(`media changes: ${f}`, () => {
      assert.deepEqual(mediaChanges(ext, fixture(f), respell(fixture(f), { bom })), []);
    });
  }
  for (const f of ["chart-edit-a.xlsx", "xlsx-prefixed-codex-series.xlsx"]) {
    it(`planExcel: ${f}`, () => {
      const plan = planExcel(fixture(f), respell(fixture(f)));
      assert.deepEqual(plan.changes.map((c) => c.id + (c as { summary?: string }).summary), []);
    });
  }
  for (const f of ["structure/broken-chart.pptx", "chart-edit-a.xlsx", "memo-v1.docx"]) {
    it(`structure check: ${f}`, () => assert.deepEqual(checkStructure(fixture(f), f), checkStructure(respell(fixture(f)), f)));
  }
  it("canonical text: a respelled part and the original are the same string", () => {
    const orig = '<?xml version="1.0"?><w:document xmlns:w="' + W + '" xmlns:r="' + R + '"><w:body><w:p r:id="a"/></w:body></w:document>';
    const spelled = `<?xml version="1.0"?><n0:document xmlns:n0='${W}' xmlns:n1='${R}'><n0:body><n0:p n1:id='a'/></n0:body></n0:document>`;
    assert.equal(canonicalXml(spelled, "ooxml", "d"), canonicalXml(orig, "ooxml", "d"));
  });
});

// Finding 2: retab reads only as far as sheetData.
function threeSheets(opts: { sheetXml?: (i: number) => string; wbExtra?: string; root?: string } = {}): Buffer {
  const names = ["Alpha", "Beta", "Gamma"];
  const wb = `<?xml version="1.0"?><workbook xmlns="${M}" xmlns:r="${R}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const rels = `<Relationships xmlns="${P}">${names.map((_n, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`;
  const sh = opts.sheetXml ?? ((i: number) => `<worksheet xmlns="${M}"><sheetViews><sheetView ${i === 0 ? 'tabSelected="1" ' : ""}workbookViewId="0"/></sheetViews><sheetData/></worksheet>`);
  return pack({ "xl/workbook.xml": strToU8(wb), "xl/_rels/workbook.xml.rels": strToU8(rels), "xl/worksheets/sheet1.xml": strToU8(sh(0)), "xl/worksheets/sheet2.xml": strToU8(sh(1)), "xl/worksheets/sheet3.xml": strToU8(sh(2)) });
}
// Finding 3: a namespace declaration is an attribute, not text inside an attribute's value.
describe("an xmlns look-alike inside an attribute value declares nothing", () => {
  const names = ["Alpha", "x xmlns='u'", "Gamma"];
  const wb = `<workbook xmlns="${M}" xmlns:r="${R}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const book = (): Buffer => { const z = parts(threeSheets()); z["xl/workbook.xml"] = strToU8(wb); return pack(z); };
  it("canonical text keeps the element in its namespace", () => {
    assert.equal(canonicalXml(`<a:x xmlns:a="${W}" v="x xmlns:a='u'"><a:y/></a:x>`, "ooxml", "d").includes("<w:y"), true);
  });
});

// Finding 4: a workbook with a vendor default namespace and a prefixed main namespace still lists its sheets.
describe("package media reads a workbook whose main namespace is prefixed beside a vendor default namespace", () => {
  it("finds the chart", () => {
    const z = parts(fixture("chart-edit-a.xlsx"));
    const wb = strFromU8(z["xl/workbook.xml"]!);
    const sheets = (wb.match(/<sheet\b[^>]*\/>/g) ?? []).map((t) => t.replace("<sheet", "<x:sheet"));
    assert.ok(sheets.length > 0);
    z["xl/workbook.xml"] = strToU8(`<?xml version="1.0"?><x:workbook xmlns:x="${M}" xmlns="urn:vendor" xmlns:r="${R}"><x:sheets>${sheets.join("")}</x:sheets></x:workbook>`);
    const found = mediaChanges(".xlsx", null, pack(z));
    assert.ok(found.some((c) => c.kind === "chart added"), JSON.stringify(found));
  });
});

// Finding 5: a prefix an unmodelled namespace borrows from a modelled one stays out of the modelled names.
describe("a name in an unmodelled namespace never reads as a modelled one", () => {
  it("w: bound to another URI is foreign", () => {
    const out = canonicalXml(`<n:document xmlns:n="${W}" xmlns:w="urn:evil"><w:body/><n:body/></n:document>`, "ooxml", "d");
    assert.equal(out.includes("<foreign:body/>"), true, out);
    assert.equal(out.includes("<w:body/>"), true, out); // the real one, from n:body
    assert.equal(out.match(/<w:body\/>/g)!.length, 1);
  });
});

// Finding 6: the odd-spelling check looks at tags, not at the XML declaration.
describe("a single-quoted XML declaration does not send a part down the full rewrite", () => {
  it("an otherwise literal part is returned without being resolved", () => {
    // an undeclared prefix throws in the full rewrite; the literal path never looks
    const text = `<?xml version='1.0' encoding='UTF-8'?><root><a:b/></root>`;
    assert.equal(canonicalXml(text, "ooxml", "d"), text);
  });
});

// Finding 9: a worksheet's comments part is read by namespace.
describe("worksheet comments", () => {
  const withComments = (): Uint8Array => {
    const z = parts(fixture("chart-edit-a.xlsx"));
    const relsName = "xl/worksheets/_rels/sheet1.xml.rels";
    const rel = `<Relationship Id="rIdC" Type="${R}/comments" Target="../comments1.xml"/>`;
    z[relsName] = strToU8(z[relsName] ? strFromU8(z[relsName]!).replace("</Relationships>", rel + "</Relationships>") : `<Relationships xmlns="${P}">${rel}</Relationships>`);
    z["xl/comments1.xml"] = strToU8(`<comments xmlns="${M}"><authors><author>A</author></authors><commentList><comment ref="B2" authorId="0"><text><r><t>hello</t></r></text></comment></commentList></comments>`);
    return pack(z);
  };
  it("a prefixed, single-quoted comments part reads as the plain one", () => {
    const plain = readWorkbook(withComments()).sheets[0]!.comments;
    assert.equal(plain.size, 1);
    const z = parts(withComments());
    z["xl/comments1.xml"] = strToU8(`<n0:comments xmlns:n0='${M}'><n0:authors><n0:author>A</n0:author></n0:authors><n0:commentList><n0:comment ref='B2' authorId='0'><n0:text><n0:r><n0:t>hello</n0:t></n0:r></n0:text></n0:comment><z:comment xmlns:z='urn:other' ref='Z9'><z:text><z:t>not a comment</z:t></z:text></z:comment></n0:commentList></n0:comments>`);
    assert.deepEqual([...readWorkbook(pack(z)).sheets[0]!.comments], [...plain]);
  });
});

// A: bookViews and sheetViews are optional; when absent they are added where the schema's element order puts them.
// B: charts with the same name are told apart by the cell their anchor starts in.