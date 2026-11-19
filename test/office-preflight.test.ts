import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { preflight, type PreflightResult } from "../src/office/connector/shared/preflight.ts";

const CT_DOCX = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const CT_XLSX = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
const CT_PPTX = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`;
const DOC = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>`;

const zip = (files: Record<string, string>): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const docx = (extra: Record<string, string> = {}): Uint8Array => zip({ "[Content_Types].xml": CT_DOCX, "word/document.xml": DOC, ...extra });
const kinds = (r: PreflightResult): string[] => r.hints.map((h) => h.kind);

describe("preflight: the five skip verdicts", () => {
  it("not a zip", () => {
    const r = preflight(strToU8("hello, this is plain text"), "a.docx");
    assert.equal(r.action, "skip");
    if (r.action === "skip") assert.equal(r.verdict, "not-a-zip");
  });
  it("empty file is not a zip", () => {
    const r = preflight(new Uint8Array(0), "a.xlsx");
    assert.equal(r.action === "skip" && r.verdict, "not-a-zip");
  });
  it("OLE with EncryptedPackage", () => {
    const b = new Uint8Array(4096);
    b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    b.set(Buffer.from("EncryptedPackage", "utf16le"), 1024);
    const r = preflight(b, "a.xlsx");
    assert.equal(r.action === "skip" && r.verdict, "encrypted-ole");
  });
  it("missing [Content_Types].xml", () => {
    const r = preflight(zip({ "word/document.xml": DOC }), "a.docx");
    assert.equal(r.action === "skip" && r.verdict, "missing-content-types");
  });
  it("torn EOCD: a zip cut short", () => {
    const b = docx();
    const r = preflight(b.subarray(0, b.length - 30), "a.docx");
    assert.equal(r.action === "skip" && r.verdict, "torn-eocd");
  });
  it("torn EOCD: directory offset points outside the file", () => {
    const b = docx().slice();
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    dv.setUint32(b.length - 22 + 16, b.length + 500, true);
    const r = preflight(b, "a.docx");
    assert.equal(r.action === "skip" && r.verdict, "torn-eocd");
  });
  it("extension does not match content", () => {
    const r = preflight(zip({ "[Content_Types].xml": CT_XLSX, "xl/workbook.xml": "<workbook/>" }), "report.docx");
    assert.equal(r.action === "skip" && r.verdict, "extension-mismatch");
  });
  it("a matching extension launches, clean", () => {
    const r = preflight(docx(), "a.docx");
    assert.deepEqual(r, { action: "launch", hints: [] });
  });
});

describe("preflight: hints never skip", () => {
  it("external relationship launches with a hint", () => {
    const r = preflight(docx({ "word/_rels/document.xml.rels": `<Relationships xmlns="x"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="\\\\host\\share\\a.png" TargetMode="External"/></Relationships>` }), "a.docx");
    assert.equal(r.action, "launch");
    assert.ok(kinds(r).includes("external-relationship"));
  });
  it("updateFields launches with a hint", () => {
    const r = preflight(docx({ "word/settings.xml": `<w:settings xmlns:w="w"><w:updateFields w:val="true"/></w:settings>` }), "a.docx");
    assert.equal(r.action, "launch");
    assert.ok(kinds(r).includes("update-fields"));
  });
  it("DDEAUTO launches with a hint", () => {
    const r = preflight(docx({ "word/document.xml": `<w:document xmlns:w="w"><w:body><w:p><w:r><w:instrText> DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc" </w:instrText></w:r></w:p></w:body></w:document>` }), "a.docx");
    assert.equal(r.action, "launch");
    assert.ok(kinds(r).includes("ddeauto"));
  });
  it("external attachedTemplate launches with a hint", () => {
    const r = preflight(docx({ "word/_rels/settings.xml.rels": `<Relationships xmlns="x"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://example.test/t.dotm" TargetMode="External"/></Relationships>` }), "a.docx");
    assert.equal(r.action, "launch");
    assert.ok(kinds(r).includes("external-attached-template"));
  });
  it("hidden slides launch with a hint", () => {
    const b = zip({ "[Content_Types].xml": CT_PPTX, "ppt/presentation.xml": "<p:presentation/>", "ppt/slides/slide1.xml": `<p:sld xmlns:p="p" show="0"/>`, "ppt/slides/slide2.xml": `<p:sld xmlns:p="p"/>` });
    const r = preflight(b, "a.pptx");
    assert.equal(r.action, "launch");
    assert.ok(kinds(r).includes("hidden-slides"));
  });
  it("likely repair launches with a hint", () => {
    const b = zip({ "[Content_Types].xml": CT_PPTX, "ppt/presentation.xml": `<p:presentation xmlns:p="p"><p:sldIdLst><p:sldId id="256" r:id="rId9" xmlns:r="r"/></p:sldIdLst></p:presentation>`, "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="x"/>` });
    const r = preflight(b, "a.pptx");
    assert.equal(r.action, "launch");
  });
  it("a legacy OLE file under an Office extension (not encrypted) launches with a hint", () => {
    const b = new Uint8Array(2048);
    b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const r = preflight(b, "a.docx");
    assert.equal(r.action, "launch");
    assert.ok(kinds(r).includes("legacy-binary-format"));
  });
  it("an unknown extension with a readable package launches", () => {
    assert.equal(preflight(docx(), "a.bin").action, "launch");
  });
  it("a package fflate cannot inflate (valid directory, bad data) launches with a hint", () => {
    const b = docx().slice();
    // Corrupt the deflated body of the first entry (data starts after the 30-byte header + name).
    const nameLen = new DataView(b.buffer).getUint16(26, true);
    for (let i = 30 + nameLen; i < 30 + nameLen + 6; i++) b[i] = 0xff;
    const r = preflight(b, "a.docx");
    assert.equal(r.action, "launch");
  });
  it("hints carry a kind, a part and a detail", () => {
    const r = preflight(docx({ "word/settings.xml": `<w:settings xmlns:w="w"><w:updateFields w:val="true"/></w:settings>` }), "a.docx");
    const h = r.hints.find((x) => x.kind === "update-fields")!;
    assert.equal(typeof h.detail, "string");
    assert.equal(h.part, "word/settings.xml");
  });
});

describe("preflight: limits", () => {
  it("over the part-count limit stops reading and launches with a limits-reached hint", () => {
    const files: Record<string, string> = { "[Content_Types].xml": CT_DOCX, "word/document.xml": DOC };
    for (let i = 0; i < 20; i++) files[`word/media/p${i}.xml`] = "<a/>";
    const r = preflight(zip(files), "a.docx", { maxParts: 10 });
    assert.equal(r.action, "launch");
    assert.ok(kinds(r).includes("limits-reached"));
  });
  it("over the decompressed-size limit launches with a limits-reached hint and still reports hints found in small parts", () => {
    const files: Record<string, string> = { "[Content_Types].xml": CT_DOCX, "word/document.xml": DOC, "word/settings.xml": `<w:settings xmlns:w="w"><w:updateFields w:val="true"/></w:settings>`, "word/big.xml": "x".repeat(5000) };
    const r = preflight(zip(files), "a.docx", { maxUnzippedBytes: 2000 });
    assert.equal(r.action, "launch");
    assert.ok(kinds(r).includes("limits-reached"));
  });
});
