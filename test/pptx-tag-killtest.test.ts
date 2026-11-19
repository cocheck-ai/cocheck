import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { diffDecks } from "../src/office/connector/pptx/diff.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";
import { readTags, tagShape } from "../scripts/lib/pptx-tags.ts";
import { load, validate } from "../scripts/lib/pptx-validate.ts";

const FIXTURES = ["ppt-table-deck.pptx", "deck-resave.pptx", "deck-resave-resaved.pptx"];
const read = (f: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures", f)));
const firstShape = (bytes: Uint8Array) => readDeck(bytes).slides[0]!.shapes.find((s) => s.name !== "")!.name;
const LINK = JSON.stringify({ cell: "Model!B7", note: 'say "hi" & <b>bye</b> \'x\'\ttab\nline é 日本語 😀' });

describe("pptx link tag kill test", () => {
  for (const f of FIXTURES) {
    const deck = read(f);
    const shape = firstShape(deck);

    it(`${f}: tagged deck passes the package validator and changes only the expected parts`, () => {
      const out = tagShape(deck, 1, shape, LINK);
      assert.deepEqual(validate(load(out)), []);
      const before = unzipSync(deck);
      const after = unzipSync(out);
      const changed = Object.keys(after).filter((n) => !(n in before) || strFromU8(after[n]!) !== strFromU8(before[n]!));
      const slidePart = changed.find((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))!;
      assert.deepEqual(changed.sort(), ["[Content_Types].xml", "ppt/tags/tag1.xml", slidePart, slidePart.replace("slides/", "slides/_rels/") + ".rels"].sort());
      assert.deepEqual(Object.keys(before).filter((n) => !(n in after)), []);
      // Removing exactly the inserted text restores the original, so nothing else moved.
      assert.equal(strFromU8(after[slidePart]!).replace(/<p:custDataLst>.*?<\/p:custDataLst>/, "").replace(/<p:nvPr><\/p:nvPr>/, "<p:nvPr/>"), strFromU8(before[slidePart]!));
      assert.equal(strFromU8(after["[Content_Types].xml"]!).replace(/<Override PartName="\/ppt\/tags\/tag1.xml"[^>]*\/>/, ""), strFromU8(before["[Content_Types].xml"]!));
    });

    it(`${f}: read returns the tag with slide and shape name`, () => {
      assert.deepEqual(readTags(tagShape(deck, 1, shape, LINK)), [{ slide: 1, shape, name: "COCHECK.LINKS", value: LINK }]);
      assert.deepEqual(readTags(deck), []);
    });

    it(`${f}: tags are invisible to readDeck and diffDecks`, () => {
      const tagged = tagShape(deck, 1, shape, LINK);
      assert.deepEqual(diffDecks(readDeck(deck), readDeck(tagged)), []);
      assert.deepEqual(diffDecks(readDeck(tagged), readDeck(deck)), []);
      assert.deepEqual(readDeck(tagged), readDeck(deck));
    });
  }

  it("tagging a shape that already has a custDataLst appends rather than replaces", () => {
    const deck = read("ppt-table-deck.pptx");
    const shape = firstShape(deck);
    const once = tagShape(deck, 1, shape, '{"a":1}');
    const twice = tagShape(once, 1, shape, '{"b":2}');
    assert.deepEqual(validate(load(twice)), []);
    const files = load(twice);
    const slide = Object.entries(files).find(([n]) => /^ppt\/slides\/slide\d+\.xml$/.test(n) && files[n]!.includes("custDataLst"))![1];
    assert.equal(slide.match(/<p:custDataLst>/g)!.length, 1);
    assert.equal(slide.match(/<p:tags /g)!.length, 2);
    assert.deepEqual(readTags(twice).map((t) => t.value), ['{"a":1}', '{"b":2}']);
  });

  it("tags a non-first slide and refuses a missing, ambiguous or non-JSON request", () => {
    const deck = read("ppt-table-deck.pptx");
    const s2 = readDeck(deck).slides[1]!.shapes.find((s) => s.name !== "")!.name;
    assert.equal(readTags(tagShape(deck, 2, s2, "{}"))[0]!.slide, 2);
    assert.throws(() => tagShape(deck, 1, "No such shape", "{}"), /no shape named/);
    assert.throws(() => tagShape(deck, 99, s2, "{}"), /does not exist/);
    assert.throws(() => tagShape(deck, 1, s2, "{not json"), SyntaxError);
  });

  it("tags a shape whose p:nvPr is self-closed (no placeholder)", () => {
    const deck = read("ppt-table-deck.pptx");
    const out = tagShape(deck, 1, "TextBox 2", LINK);
    assert.deepEqual(validate(load(out)), []);
    assert.equal(readTags(out)[0]!.shape, "TextBox 2");
    assert.deepEqual(diffDecks(readDeck(deck), readDeck(out)), []);
  });
});
