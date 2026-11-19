// the rewrite's size cap (checked from the central directory, before any part is inflated) and the Word caveat (set only when something was hidden).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { printCopy } from "../src/office/connector/print-copy.ts";
import { excelPrintCopy } from "../src/office/connector/excel/print-setup.ts";
import { wordPrintCopy } from "../src/office/connector/word-print-copy.ts";
import { PRINT_COPY_CAP_BYTES } from "../src/office/connector/print-copy-cap.ts";
import { parts, put, read, text, xlsxWithPrintSetup, zip } from "./helpers/print-copy-fixtures.ts";

const spy = (): { seen: [string, number][]; inflated: (n: string, s: number) => void } => { const seen: [string, number][] = []; return { seen, inflated: (n, s) => { seen.push([n, s]); } }; };

describe("the cap is a named constant of 64 MB", () => {
  it("value", () => assert.equal(PRINT_COPY_CAP_BYTES, 64 * 1024 * 1024));
});

describe("Excel over the cap gets the plain copy and no part is inflated", () => {
  const big = (): Buffer => { const p = parts(xlsxWithPrintSetup()); const sheet = text(p, "xl/worksheets/sheet1.xml"); return zip(put(p, "xl/worksheets/sheet1.xml", sheet.replace("</worksheet>", `<!--${"a".repeat(200_000)}-->` + "</worksheet>"))); };
  it("uncompressed XML over the cap: null, and the inflate spy sees nothing", () => {
    const s = spy();
    const b = big();
    assert.ok(b.length < 20_000, "the zip itself is small: only the uncompressed size is over");
    assert.equal(excelPrintCopy(b, { cap: 100_000, inflated: s.inflated }), null);
    assert.deepEqual(s.seen, []);
    assert.equal(printCopy("excel", b, { cap: 100_000, inflated: s.inflated }), null);
    assert.deepEqual(s.seen, []);
  });
  it("zip over the cap: null, nothing inflated", () => {
    const s = spy();
    const b = xlsxWithPrintSetup();
    assert.equal(excelPrintCopy(b, { cap: b.length - 1, inflated: s.inflated }), null);
    assert.deepEqual(s.seen, []);
  });
  it("the same ordinary workbook under the cap stays on the rewrite", () => {
    const s = spy();
    const out = excelPrintCopy(big(), { inflated: s.inflated });
    assert.ok(out !== null);
    assert.ok(s.seen.length > 0);
    assert.match(text(parts(out), "xl/worksheets/sheet1.xml"), /<pageSetup orientation="landscape" horizontalDpi="300"\/>/);
  });
});

describe("Word over the cap gets the plain copy and no part is inflated", () => {
  it("uncompressed XML over the cap: null, nothing inflated; under the cap it rewrites", () => {
    const s = spy();
    const b = read("word-comments-before.docx");
    assert.equal(wordPrintCopy(b, { cap: 1000, inflated: s.inflated }), null);
    assert.deepEqual(s.seen, []);
    assert.equal(wordPrintCopy(b, { cap: b.length - 1, inflated: s.inflated }), null);
    assert.deepEqual(s.seen, []);
    assert.ok(printCopy("word", b)?.commentsHidden === true);
  });
});

describe("the Word caveat is set only when something was removed", () => {
  const emptied = (): Buffer => {
    const p = parts(read("word-comments-before.docx"));
    const doc = text(p, "word/document.xml").replace(/<w:comment(?:RangeStart|RangeEnd|Reference)\b[^>]*\/>/g, "");
    const comments = text(p, "word/comments.xml");
    const root = /<w:comments\b[^>]*>/.exec(comments)![0];
    return zip(put(put(p, "word/document.xml", doc), "word/comments.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${root.replace(/>$/, "/>")}`));
  };
  it("<w:comments/> with no anchors: stripped, and no caveat", () => {
    const pc = printCopy("word", emptied());
    assert.ok(pc !== null);
    assert.ok(!Object.keys(parts(pc.bytes)).some((n) => /comments/i.test(n)));
    assert.equal("commentsHidden" in pc, false);
  });
  it("a comment in the part sets the caveat", () => assert.equal(printCopy("word", read("word-comments-before.docx"))?.commentsHidden, true));
  it("an anchor with an empty comments part sets the caveat", () => {
    const p = parts(emptied());
    const doc = text(p, "word/document.xml").replace("<w:body>", '<w:body><w:commentRangeStart w:id="0"/><w:commentRangeEnd w:id="0"/>');
    assert.equal(printCopy("word", zip(put(p, "word/document.xml", doc)))?.commentsHidden, true);
  });
});
