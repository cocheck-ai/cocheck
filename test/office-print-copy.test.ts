// rule 39: the whole-package check of each rewrite. Any mutation outside the allow-list never passes; the untouched rewrite does.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8 } from "fflate";
import { excelPrintCopy, onlyPrintSetupDiffers } from "../src/office/connector/excel/print-setup.ts";
import { onlyCommentsDiffer, wordPrintCopy } from "../src/office/connector/word-print-copy.ts";
import { parts, put, read, text, xlsxWithPrintSetup } from "./helpers/print-copy-fixtures.ts";

type P = Record<string, Uint8Array>;
const without = (p: P, n: string): P => Object.fromEntries(Object.entries(p).filter(([k]) => k !== n));

describe("Excel whole-package check", () => {
  const orig = parts(xlsxWithPrintSetup());
  const next = parts(excelPrintCopy(xlsxWithPrintSetup())!);
  const SHEETS = ["xl/worksheets/sheet1.xml"];
  const sheet = text(next, "xl/worksheets/sheet1.xml");
  it("the rewrite passes", () => assert.equal(onlyPrintSetupDiffers(orig, next, SHEETS), true));
  const mutations: Record<string, P> = {
    "a cell value": put(next, "xl/worksheets/sheet1.xml", sheet.replace("<v>2</v>", "<v>3</v>")),
    "another pageSetup attribute (orientation)": put(next, "xl/worksheets/sheet1.xml", sheet.replace('orientation="landscape"', 'orientation="portrait"')),
    "the removed attribute put back": put(next, "xl/worksheets/sheet1.xml", sheet.replace('<pageSetup orientation', '<pageSetup paperSize="1" orientation')),
    "a custom view's pageSetup changed": put(next, "xl/worksheets/sheet1.xml", sheet.replace('paperSize="8"', 'paperSize="9"')),
    "a custom view's pageSetup attribute removed": put(next, "xl/worksheets/sheet1.xml", sheet.replace(' errors="dash"', "")),
    "docProps": put(next, "docProps/core.xml", text(next, "docProps/core.xml") + " "),
    "a .rels target": put(next, "_rels/.rels", text(next, "_rels/.rels").replace("xl/workbook.xml", "xl/other.xml")),
    "the workbook part": put(next, "xl/workbook.xml", text(next, "xl/workbook.xml").replace("Sheet", "Shet")),
    "a media binary": { ...next, "xl/media/logo.png": next["xl/media/logo.png"]!.map((v, i) => (i === 100 ? v ^ 1 : v)) },
    "a part added": { ...next, "xl/extra.bin": strToU8("x") },
    "a part removed": without(next, "xl/media/logo.png"),
  };
  for (const [name, m] of Object.entries(mutations)) it(`${name} never passes`, () => assert.equal(onlyPrintSetupDiffers(orig, m, SHEETS), false));
  it("nothing to remove gives null (the plain copy)", () => assert.equal(excelPrintCopy(read("v1.xlsx")), null));
});

describe("Word whole-package check", () => {
  const orig = parts(read("word-comments-before.docx"));
  const next = parts(wordPrintCopy(read("word-comments-before.docx"))!);
  const removed = new Set(["word/comments.xml", "word/commentsExtended.xml"]);
  const doc = text(next, "word/document.xml");
  it("the rewrite passes", () => assert.equal(onlyCommentsDiffer(orig, next, removed), true));
  const mutations: Record<string, P> = {
    "a paragraph's text": put(next, "word/document.xml", doc.replace(/(<w:t[^>]*>)([^<]{3})/, "$1X$2")),
    "a tracked insertion dropped": put(next, "word/document.xml", doc.replace(/<w:ins [^>]*>[\s\S]*?<\/w:ins>/, "")),
    "a tracked deletion unwrapped": put(next, "word/document.xml", doc.replace(/<w:del [^>]*>/, "<w:r>").replace("</w:del>", "</w:r>")),
    "a comment anchor left in": put(next, "word/document.xml", doc.replace("<w:body>", '<w:body><w:commentRangeStart w:id="0"/>')),
    "header text": put(next, "word/header1.xml", text(next, "word/header1.xml").replace("<w:t", "<w:t xml:space='preserve'")),
    "a footnote": put(next, "word/footnotes.xml", text(next, "word/footnotes.xml") + " "),
    "an image relationship retargeted": put(next, "word/_rels/document.xml.rels", text(next, "word/_rels/document.xml.rels").replace("media/image1.png", "media/image2.png")),
    "a content type": put(next, "[Content_Types].xml", text(next, "[Content_Types].xml").replace('Extension="png"', 'Extension="jpg"')),
    "docProps": put(next, "docProps/app.xml", text(next, "docProps/app.xml") + " "),
    "a media binary": { ...next, "word/media/image1.png": next["word/media/image1.png"]!.map((v, i) => (i === 50 ? v ^ 1 : v)) },
    "the thumbnail": { ...next, "docProps/thumbnail.jpeg": next["docProps/thumbnail.jpeg"]!.map((v, i) => (i === 50 ? v ^ 1 : v)) },
    "styles": put(next, "word/styles.xml", text(next, "word/styles.xml") + " "),
    "a part added": { ...next, "word/extra.xml": strToU8("<a/>") },
    "a non-comment part removed": without(next, "word/numbering.xml"),
    "a comment part kept": { ...next, "word/comments.xml": orig["word/comments.xml"]! },
  };
  for (const [name, m] of Object.entries(mutations)) it(`${name} never passes`, () => assert.equal(onlyCommentsDiffer(orig, m, removed), false));
  it("a UTF-16 XML part, or a file with no comments, gives null (the plain copy)", () => {
    assert.equal(wordPrintCopy(read("v1.docx")), null);
    assert.equal(wordPrintCopy(Buffer.from("nope")), null);
  });
});
