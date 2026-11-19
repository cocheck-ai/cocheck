import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { preflight } from "../src/office/connector/shared/preflight.ts";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { answerDiff } from "../src/office/connector/program.ts";
import { reachCaveats, reachOf } from "../src/office/connector/reach.ts";
import { fakePager, FIXTURES } from "./helpers/office-fake.ts";

const ct = (main: string, type: string): string => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`;
const zip = (files: Record<string, string>): Buffer => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (rs: string): string => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rs}</Relationships>`;

const xlsx = zip({
  "[Content_Types].xml": ct("xl/workbook.xml", "spreadsheetml.sheet"),
  "xl/workbook.xml": "<workbook/>",
  "xl/externalLinks/_rels/externalLink1.xml.rels": rels(`<Relationship Id="rId1" Type="${REL}/externalLinkPath" Target="file:///C:/Budget/other.xlsx" TargetMode="External"/>`),
});
const docx = zip({
  "[Content_Types].xml": ct("word/document.xml", "wordprocessingml.document"),
  "word/document.xml": `<w:document xmlns:w="x"><w:body><w:p><w:r><w:instrText xml:space="preserve"> INCLUDETEXT "\\\\\\\\fileserver\\\\share\\\\clause.docx" </w:instrText></w:r></w:p></w:body></w:document>`,
  "word/_rels/document.xml.rels": rels(`<Relationship Id="rId9" Type="${REL}/image" Target="http://tracker.example/pic.png" TargetMode="External"/>`),
});
const pptx = zip({
  "[Content_Types].xml": ct("ppt/presentation.xml", "presentationml.presentation"),
  "ppt/presentation.xml": "<p:presentation/>",
  "ppt/slides/_rels/slide1.xml.rels": rels(`<Relationship Id="rId2" Type="${REL}/image" Target="https://cdn.example/logo.png" TargetMode="External"/><Relationship Id="rId3" Type="${REL}/oleObject" Target="\\\\host\\share\\deck.xlsx"/>`),
});
const targets = (b: Buffer, f: string): string[] => preflight(b, f).hints.flatMap((h) => (h.targets ?? []).map((t) => t.target));

describe("preflight lists external targets", () => {
  it("xlsx link workbook", () => assert.deepEqual(targets(xlsx, "a.xlsx"), ["file:///C:/Budget/other.xlsx"]));
  it("docx INCLUDETEXT (UNC) and remote image", () => assert.deepEqual(targets(docx, "a.docx").sort(), ["\\\\fileserver\\share\\clause.docx", "http://tracker.example/pic.png"].sort()));
  it("pptx remote image and UNC ole link without TargetMode", () => assert.deepEqual(targets(pptx, "a.pptx").sort(), ["\\\\host\\share\\deck.xlsx", "https://cdn.example/logo.png"].sort()));
  it("a hint never becomes a verdict: file with targets still launches", () => assert.equal(preflight(docx, "a.docx").action, "launch"));
});

// the pictures-off card that said this went with core's Office code; the connector's answer says it now (program.ts, reach.ts).
describe("the connector's answer says what the file would reach (nothing is fetched)", () => {
  it("one caveat per target, per app", () => {
    assert.deepEqual(reachOf(xlsx, "a.xlsx"), ["This file would reach file:///C:/Budget/other.xlsx"]);
    assert.ok(reachOf(docx, "a.docx").includes("This file would reach http://tracker.example/pic.png"));
    assert.ok(reachOf(pptx, "a.pptx").includes("This file would reach https://cdn.example/logo.png"));
  });
  it("no external content, or no bytes: nothing", () => {
    assert.deepEqual(reachOf(null, "a.docx"), []);
    assert.deepEqual(reachOf(Buffer.from("x"), "a.docx"), []);
  });
  it("the built-in Excel connector's answer carries the caveat of the after state (no Office: the change list)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    const v1 = path.join(FIXTURES, "v1.xlsx");
    const parts = unzipSync(readFileSync(v1));
    parts["xl/externalLinks/_rels/externalLink1.xml.rels"] = strToU8(rels(`<Relationship Id="rId1" Type="${REL}/externalLinkPath" Target="file:///C:/Budget/other.xlsx" TargetMode="External"/>`));
    const after = path.join(dir, "after.xlsx");
    writeFileSync(after, zipSync(parts));
    const doc = await answerDiff(OFFICE_APPS.excel, v1, after, { driver: undefined, pager: fakePager, lockPath: path.join(dir, "lock") });
    assert.ok(doc.caveats.includes("This file would reach file:///C:/Budget/other.xlsx"), JSON.stringify(doc.caveats));
    const plain = await answerDiff(OFFICE_APPS.excel, v1, v1, { driver: undefined, pager: fakePager, lockPath: path.join(dir, "lock") });
    assert.ok(!plain.caveats.some((c) => c.startsWith("This file would reach")), JSON.stringify(plain.caveats));
  });
  it("capped at three with 'and N more'", () => {
    const hint = { kind: "external-relationship" as const, part: "p", detail: "d", targets: ["a", "b", "c", "d", "e", "a"].map((target) => ({ type: "image", target })) };
    assert.deepEqual(reachCaveats({ action: "launch", hints: [hint] }), ["This file would reach a", "This file would reach b", "This file would reach c", "and 2 more"]);
  });
});
