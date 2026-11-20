// A shape written with an empty name (some deck-building tools write name="") is placed by what it is: its placeholder type (Title,
// Content...), else its kind (Text box, Shape, Connector, Table, Group). Duplicates keep the usual numbering.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { diffDecks, place } from "../src/office/connector/pptx/diff.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";

const read = (f: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures", f)));
const SLIDE = "ppt/slides/slide1.xml";

/** `f` applied to every slide part. */
function edit(bytes: Uint8Array, f: (xml: string) => string): Uint8Array {
  const parts = unzipSync(bytes);
  for (const n of Object.keys(parts).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))) parts[n] = strToU8(f(strFromU8(parts[n]!)));
  return zipSync(parts);
}
const unnamed = (xml: string) => xml.replace(/(<p:cNvPr\b[^>]*?\bname=")[^"]*"/g, '$1"');
/** The slide's Rectangle wrapped in an unnamed group. */
const grouped = (xml: string) =>
  xml.replace(/<p:sp>(?:(?!<p:sp>)[\s\S])*?name="Rectangle 7"[\s\S]*?<\/p:sp>/, (sp) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="50" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp}</p:grpSp>`);
const paths = (bytes: Uint8Array, slide = 0) => place(readDeck(bytes).slides[slide]!.shapes).map((p) => p.path);

describe("unnamed PowerPoint shapes are placed by what they are", () => {
  it("placeholders by their type, other shapes by their kind, duplicates numbered", () => {
    const deck = edit(read("deck-calibri.pptx"), (x) => unnamed(grouped(x)));
    assert.ok(strFromU8(unzipSync(deck)[SLIDE]!).includes('<p:grpSp><p:nvGrpSpPr><p:cNvPr id="50" name=""/>'), "the group was planted");
    assert.deepEqual(paths(deck), ["Content", "Content (2)", "Text box", "Text box (2)", "Connector", "Connector (2)", "Title", "Group", "Group / Shape"]);
  });
  it("a table frame reads Table", () => {
    const deck = edit(read("ppt-table-deck.pptx"), unnamed);
    const all = readDeck(deck).slides.flatMap((_, i) => paths(deck, i));
    assert.ok(all.includes("Table"), JSON.stringify(all));
    assert.ok(all.every((p) => p.trim() !== "" && !p.startsWith(" ") && !p.includes("/  ")), JSON.stringify(all));
  });
  it("a change in an unnamed title is located at Slide 1 / Title", () => {
    const was = edit(read("deck-calibri.pptx"), unnamed);
    const now = edit(was, (x) => x.replace(/(<p:ph type="title"\/>[\s\S]*?<a:t>)([^<]*)/, "$1Renamed headline"));
    const rows = diffDecks(readDeck(was), readDeck(now));
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.location.startsWith("Slide 1 / Title")), JSON.stringify(rows.map((r) => r.location)));
  });
  it("a named shape keeps its own name", () => {
    assert.deepEqual(paths(read("deck-calibri.pptx")).slice(-2), ["Title 1", "Rectangle 7"]);
  });
});
