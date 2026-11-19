import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { createFilesLayer } from "../src/office/connector/docx/layer.ts";
import { differingParts } from "../src/office/connector/shared/package-media.ts";

// When a docx's paragraph text is equal, the note names the parts that differ. The trimmed memo is a real memo's parts (test/fixtures/memo-v1.docx:
// document.xml, styles.xml, numbering, settings, theme, docProps, customXml) minus the thumbnail and stylesWithEffects. v1 -> v2 mirrors the recorded run's memo (a paragraph border in
// word/document.xml only); v2 -> v3 adds a word/styles.xml change. The states of that run are not available as fixtures.
const base = unzipSync(new Uint8Array(readFileSync("test/fixtures/memo-v1.docx")));
delete base["docProps/thumbnail.jpeg"];
delete base["word/stylesWithEffects.xml"];
const dec = (n: string): string => Buffer.from(base[n]!).toString("utf8");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const pack = (over: Record<string, string | null> = {}): Buffer => {
  const parts: Record<string, Uint8Array> = { ...base };
  for (const [n, v] of Object.entries(over)) { if (v === null) delete parts[n]; else parts[n] = enc(v); }
  return Buffer.from(zipSync(parts));
};
const doc = dec("word/document.xml");
const bordered = doc.replace(/<w:pPr>/, '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>');
const styled = dec("word/styles.xml").replace("</w:styles>", "<!-- marker --></w:styles>");

const V1 = pack(), V2 = pack({ "word/document.xml": bordered }), V3 = pack({ "word/document.xml": bordered.replace('w:sz="6"', 'w:sz="12"'), "word/styles.xml": styled });

async function note(a: Buffer, b: Buffer): Promise<string | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  try {
    await writeFile(path.join(dir, "a.docx"), a);
    await writeFile(path.join(dir, "b.docx"), b);
    const rows = await createFilesLayer().diff(path.join(dir, "a.docx"), path.join(dir, "b.docx"));
    assert.equal(rows.length, 1);
    return String(rows[0]!.detail.note);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("a docx note names the parts that differ", () => {
  it("fixture sanity: the borders are the only difference in v1 -> v2", () => {
    assert.notEqual(bordered, doc);
  });
  it("v1 -> v2 names paragraph formatting only; no other part is named (an unchanged part is never named)", async () => {
    const n = await note(V1, V2);
    assert.equal(n, "body text unchanged; paragraph formatting differs");
    assert.doesNotMatch(n!, /styles|headers|footers|numbering|settings|file details|pictures|theme|other parts/);
  });
  it("v2 -> v3 names styles and paragraph formatting", async () => {
    assert.equal(await note(V2, V3), "body text unchanged; styles and paragraph formatting differ");
    // styles alone, with the document part unchanged, names styles only
    assert.equal(await note(V1, pack({ "word/styles.xml": styled })), "body text unchanged; styles differ");
  });
  it("a differing part outside the map is never dropped: 'other parts' appears, once", async () => {
    const n = await note(V1, pack({ "customXml/item1.xml": "<x/>", "word/fontTable.xml": "<f/>" }));
    assert.equal(n, "body text unchanged; other parts differ");
    const both = await note(V1, pack({ "word/styles.xml": styled, "customXml/item1.xml": "<x/>", "word/fontTable.xml": "<f/>" }));
    assert.equal(both, "body text unchanged; styles and other parts differ");
  });
  it("a part present on one side only is named by its map entry", async () => {
    assert.equal(await note(V1, pack({ "word/header1.xml": "<h/>", "word/footer2.xml": "<f/>", "word/media/image1.png": "x" })), "body text unchanged; headers, footers and pictures differ");
    assert.equal(await note(V1, pack({ "word/numbering.xml": null, "word/settings.xml": "<s/>", "docProps/core.xml": "<c/>", "word/theme/theme1.xml": "<t/>" })), "body text unchanged; list numbering, document settings, file details and theme differ");
  });
  it("differingParts: over the size cap gives null (today's generic wording), not a guess", () => {
    assert.equal(differingParts(V1, V2, 100), null);
    assert.deepEqual(differingParts(V1, V2), ["paragraph formatting"]);
    assert.deepEqual(differingParts(V1, V1), []);
    assert.equal(differingParts(enc("not a zip"), enc("not a zip")), null);
  });
});
