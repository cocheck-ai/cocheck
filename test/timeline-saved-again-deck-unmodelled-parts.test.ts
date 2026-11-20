import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { unzipSync, zipSync } from "fflate";
import { declaredSize, partsIdentical, pptxOnlySavedDetailsDiffer } from "../src/office/connector/shared/package-media.ts";

// A deck whose only change is in a part the pptx reader does not model is not "saved again"; the first saved-again deck pair (core.xml, section ids, embedded workbook core.xml) still is.
const V2 = "test/fixtures/long-html-deck-v2.pptx", V3 = "test/fixtures/long-html-deck-v3.pptx";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
// core's saved-again note and look-here exception are gone (the connector words it); the allow-list check stays pinned.

/** v2 with one part's text replaced (or appended to when the part is absent). */
async function edited(part: string, edit: (s: string) => string): Promise<Uint8Array> {
  const parts: Record<string, Uint8Array> = unzipSync(await readFile(V2));
  parts[part] = enc(edit(parts[part] ? Buffer.from(parts[part]!).toString("utf8") : ""));
  return zipSync(parts);
}

describe("pptx saved again only for allow-listed parts", () => {
  // Only the per-save properties are set aside (docprops-noise.ts, plus the creation time in the re-save check). The first saved-again pair
  // is a regenerated deck whose dcterms:created moved and whose body is byte-identical: a re-save. A save that moves only the per-save fields is on it too.
  it("the v2 -> v3 pair (created time moved, a regeneration with the same body) is on the allow-list; so are per-save fields and section ids alone", async () => {
    assert.equal(pptxOnlySavedDetailsDiffer(await readFile(V2), await readFile(V3)), true);
    const saved = await edited("docProps/core.xml", (s) => s.replace(/(<dcterms:modified[^>]*>)[^<]*</, "$12027-01-01T00:00:00Z<").replace(/(<cp:revision>)\d+</, "$12<"));
    assert.equal(pptxOnlySavedDetailsDiffer(await readFile(V2), saved), true);
    const titled = await edited("docProps/core.xml", (s) => s.replace(/<dc:title>[^<]*</, "<dc:title>Renamed<"));
    assert.equal(pptxOnlySavedDetailsDiffer(await readFile(V2), titled), false, "a title change is content");
  });
  for (const part of ["ppt/presProps.xml", "ppt/tableStyles.xml", "ppt/viewProps.xml"]) {
    it(`only ${part} changed: off the allow-list`, async () => {
      const changed = await edited(part, (s) => `${s}<!-- showPr loop -->`);
      assert.equal(pptxOnlySavedDetailsDiffer(await readFile(V2), changed), false);
    });
  }
  it("a presentation.xml change beyond the section ids is off the allow-list", async () => {
    const changed = await edited("ppt/presentation.xml", (s) => s.replace(/<p:sldSz[^>]*>/, '<p:sldSz cx="1" cy="1"/>'));
    assert.equal(pptxOnlySavedDetailsDiffer(await readFile(V2), changed), false);
  });
  it("a changed embedded workbook sheet is off the allow-list", async () => {
    const parts: Record<string, Uint8Array> = unzipSync(await readFile(V2));
    const name = Object.keys(parts).find((n) => n.endsWith(".xlsx"))!;
    const inner: Record<string, Uint8Array> = unzipSync(parts[name]!);
    inner["xl/workbook.xml"] = enc(`${Buffer.from(inner["xl/workbook.xml"]!).toString("utf8")}<!-- x -->`);
    parts[name] = zipSync(inner);
    assert.equal(pptxOnlySavedDetailsDiffer(await readFile(V2), zipSync(parts)), false);
  });
});

describe("the identical-parts pre-scan", () => {
  it("declaredSize reads the zip directory without inflating", () => {
    const zip = zipSync({ a: new Uint8Array(1000), b: new Uint8Array(500) });
    assert.equal(declaredSize(zip), 1500);
  });
  it("a package declaring more than 64 MB is false before any part is inflated", () => {
    const big = zipSync({ small: enc("1"), huge: new Uint8Array(65 * 1024 * 1024) });
    assert.ok(declaredSize(big) > 64 * 1024 * 1024);
    assert.equal(partsIdentical(big, big), false);
    assert.equal(pptxOnlySavedDetailsDiffer(big, big), false);
    assert.equal(partsIdentical(zipSync({ a: enc("1") }), zipSync({ a: enc("1") })), true);
  });
});
