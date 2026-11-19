import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { checkStructure } from "../src/office/connector/shared/structure-check.ts";
import { structureIssues } from "../src/office/connector/issues.ts";

const FIX = path.join(import.meta.dirname, "fixtures");
const load = (p: string): Uint8Array => new Uint8Array(readFileSync(path.join(FIX, p)));

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(xlsx|xlsm|docx|pptx)$/i.test(n)) out.push(p);
  }
  return out;
}

function mutate(bytes: Uint8Array, edit: (files: Record<string, string>) => void): Uint8Array {
  const z = unzipSync(bytes);
  const text: Record<string, string> = {};
  for (const [k, v] of Object.entries(z)) if (/\.(xml|rels)$/.test(k)) text[k] = strFromU8(v);
  edit(text);
  const out: Record<string, Uint8Array> = { ...z };
  for (const [k, v] of Object.entries(text)) out[k] = strToU8(v);
  for (const k of Object.keys(out)) if (!(k in text) && /\.(xml|rels)$/.test(k)) delete out[k];
  return zipSync(out);
}

describe("structure check", () => {
  it("the broken-chart deck: slide 5 chart has 23 empty values and an invalid dash", () => {
    const r = checkStructure(load("structure/broken-chart.pptx"), "deck.pptx")!;
    const repair = r.findings.filter((f) => f.severity === "likely-repair");
    assert.ok(repair.some((f) => f.rule === "chart-empty-value" && f.where === "slide 5" && /23 empty values/.test(f.detail)), JSON.stringify(repair));
    assert.ok(repair.some((f) => f.rule === "enum" && f.where === "slide 5" && /dash/.test(f.detail)));
    // Charts 2 and 3 of the same deck carry the same two schema slips and are not the reported failure: tolerated, not repair.
    assert.ok(r.findings.some((f) => f.rule === "chart-line-invert" && f.severity === "tolerated"));
    assert.ok(r.findings.some((f) => f.rule === "chart-no-grouping" && f.severity === "tolerated"));
    assert.ok(!repair.some((f) => f.where !== "slide 5"), "only slide 5 is a likely repair");
    // migration X1: the connector's issues are the two likely-repair findings, at slide 5; the tolerated ones give none
    assert.deepEqual(structureIssues(load("structure/broken-chart.pptx"), "deck.pptx").map((i) => i.where), ["slide 5", "slide 5"]);
  });

  it("every existing office fixture raises no likely-repair finding", () => {
    // The broken-chart deck versions carry the real broken chart this check exists to catch; they are known-bad, not clean. So are the corrupt_* workbooks.
    // An empty file is not an office package and is not meant to be one: excel-region/created-before.xlsx is the zero-byte "before" of a workbook an agent created.
    const files = walk(FIX).filter((p) => !p.replaceAll("\\", "/").includes("structure/") && !/broken-chart-deck-v\d\.pptx$/.test(p) && !/corrupt_[a-z_]+\.xlsx$/.test(p) && statSync(p).size > 0);
    assert.ok(files.length > 25);
    for (const f of files) {
      const r = checkStructure(new Uint8Array(readFileSync(f)), f);
      assert.ok(r, `${f} was not read as a package`);
      const bad = r.findings.filter((x) => x.severity === "likely-repair");
      assert.deepEqual(bad.map((x) => x.sentence), [], f);
    }
  });

  it("a clean fixture is a clean result, never an unchecked one, and gives no issue", () => {
    const r = checkStructure(load("memo-aptos.docx"), "memo-aptos.docx")!;
    assert.equal(r.findings.length, 0);
    assert.deepEqual(structureIssues(load("memo-aptos.docx"), "memo-aptos.docx"), []);
  });

  it("not an office package: no result, so no issue", () => {
    assert.equal(checkStructure(new Uint8Array([1, 2, 3]), "x.xlsx"), null);
    assert.equal(checkStructure(load("locked.pdf"), "x.pdf"), null);
  });

  it("xlsx: shared string and style index out of range, dangling rel, missing content type", () => {
    const base = load("lbo-excel-saved-f5-hardcoded.xlsx");
    const sheet = Object.keys(unzipSync(base)).find((k) => /xl\/worksheets\/sheet\d+\.xml$/.test(k))!;
    const bad = mutate(base, (t) => {
      t[sheet] = t[sheet]!.replace(/<sheetData>/, '<sheetData><row r="900"><c r="A900" t="s"><v>99999999</v></c><c r="B900" s="99999"><v>1</v></c></row>');
      t["xl/_rels/workbook.xml.rels"] = t["xl/_rels/workbook.xml.rels"]!.replace("</Relationships>", '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/nope.xml"/></Relationships>');
      t["[Content_Types].xml"] = t["[Content_Types].xml"]!.replace(/<Override PartName="\/xl\/styles.xml"[^>]*\/>/, "");
    });
    const rules = checkStructure(bad, "a.xlsx")!.findings.filter((f) => f.severity === "likely-repair").map((f) => f.rule);
    for (const want of ["xlsx-string-index", "xlsx-style-index", "dangling-rel", "content-type-missing"]) assert.ok(rules.includes(want), `${want} in ${rules}`);
    assert.ok(structureIssues(bad, "a.xlsx").length > 0);
  });

  it("docx: numId with no numbering definition", () => {
    const bad = mutate(load("memo-aptos.docx"), (t) => {
      t["word/document.xml"] = t["word/document.xml"]!.replace(/<w:body>/, '<w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="987"/></w:numPr></w:pPr></w:p>');
    });
    const f = checkStructure(bad, "m.docx")!.findings.filter((x) => x.rule === "docx-numid");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.severity, "likely-repair");
  });

  it("pptx: duplicate slide ids are a likely repair, duplicate shape ids may be tolerated", () => {
    const deck = load("deck-calibri.pptx");
    const bad = mutate(deck, (t) => {
      const slides = Object.keys(t).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort();
      t[slides[0]!] = t[slides[0]!]!.replace(/<p:cNvPr id="(\d+)"/, (m, id) => `<p:cNvPr id="${id}"`).replace(/(<p:cNvPr id="(\d+)"[^>]*>[\s\S]*?)(<\/p:sp>)/, `$1$3<p:sp><p:nvSpPr><p:cNvPr id="$2" name="dup"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>`);
      t["ppt/presentation.xml"] = t["ppt/presentation.xml"]!.replace(/(<p:sldId id="(\d+)"[^>]*\/>)/, `$1<p:sldId id="$2" r:id="rId9999"/>`);
    });
    const f = checkStructure(bad, "d.pptx")!.findings;
    assert.ok(f.some((x) => x.rule === "duplicate-id" && x.severity === "likely-repair" && /slide/.test(x.detail)));
    assert.ok(f.some((x) => x.rule === "duplicate-shape-id" && x.severity === "tolerated"));
  });

  it("p14:sldId in a section list is not a slide id (no false duplicate)", () => {
    const ok = mutate(load("deck-calibri.pptx"), (t) => {
      const ids = [...t["ppt/presentation.xml"]!.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => m[1]);
      const sect = `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="A" id="{11111111-1111-1111-1111-111111111111}"><p14:sldIdLst>${ids.map((i) => `<p14:sldId id="${i}"/>`).join("")}</p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>`;
      t["ppt/presentation.xml"] = t["ppt/presentation.xml"]!.replace(/(<p:extLst>[\s\S]*?<\/p:extLst>)?<\/p:presentation>/, `${sect}</p:presentation>`);
    });
    assert.match(strFromU8(unzipSync(ok)["ppt/presentation.xml"]!), /<p14:sectionLst/);
    assert.deepEqual(checkStructure(ok, "d.pptx")!.findings.filter((f) => f.rule === "duplicate-id"), []);
  });

  it("noise: internal # hyperlink targets, overrides without parts, math jc", () => {
    const deck = mutate(load("deck-calibri.pptx"), (t) => {
      t["ppt/_rels/presentation.xml.rels"] = t["ppt/_rels/presentation.xml.rels"]!.replace("</Relationships>", '<Relationship Id="rId77" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="#Dashboard!A1"/></Relationships>');
      t["[Content_Types].xml"] = t["[Content_Types].xml"]!.replace("</Types>", '<Override PartName="/ppt/slideMasters/slideMaster9.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/></Types>');
    });
    assert.deepEqual(checkStructure(deck, "d.pptx")!.findings, []);
    const doc = mutate(load("memo-aptos.docx"), (t) => {
      t["word/document.xml"] = t["word/document.xml"]!.replace(/<w:body>/, '<w:body><w:p><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMathParaPr><m:jc m:val="centerGroup"/></m:oMathParaPr></m:oMathPara></w:p>');
    });
    assert.deepEqual(checkStructure(doc, "m.docx")!.findings, []);
  });

  it("a part over the size cap skips its dependent rule instead of flagging every cell", () => {
    const base = load("lbo-excel-saved-f5-hardcoded.xlsx");
    assert.equal(checkStructure(base, "a.xlsx", { maxPartBytes: 6100 })!.findings.filter((f) => f.severity === "likely-repair").length, 0);
    assert.equal(checkStructure(base, "a.xlsx", { maxPartBytes: 1 }), null, "an unread skeleton is unchecked");
  });
});
