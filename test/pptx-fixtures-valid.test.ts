import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { killTestDecks } from "../scripts/lib/pptx-fixtures.ts";
import { load, validate } from "../scripts/lib/pptx-validate.ts";

// Package-level invariants PowerPoint enforces before it will open a deck without a repair prompt.
// The two real decks (made by PowerPoint for Mac 16.113) are the oracle: they must pass too, so a
// rule here that a real deck breaks is a wrong rule. Skipped when the real decks are not on disk.

const REAL_DIR = path.join(homedir(), "code", "cocheck-blind", "routing");
const REAL = ["deck-resave.pptx", "deck-resave-resaved.pptx", "kt-ppt-table2-deck.pptx"].map((f) => path.join(REAL_DIR, f));
// The committed copy of kt-ppt-table2-deck.pptx: the table deck every table test uses.
const TABLE_DECK = path.join(import.meta.dirname, "fixtures", "ppt-table-deck.pptx");

describe("pptx fixture decks are valid OPC/PresentationML", () => {
  const decks = killTestDecks();
  for (const [stem, bytes] of Object.entries(decks)) {
    it(`${stem} passes every invariant`, () => assert.deepEqual(validate(load(bytes)), []));
  }

  it("covers the structures the kill test needs", () => {
    const f = (s: string) => load(decks[s]!);
    assert.ok(Object.keys(f("notes-deck")).some((n) => n.startsWith("ppt/notesMasters/")));
    assert.ok(Object.keys(f("chart-deck")).some((n) => n.startsWith("ppt/charts/")));
    assert.ok(/<p:grpSp>/.test(f("grouped-deck")["ppt/slides/slide1.xml"]!));
    assert.equal(Object.keys(f("long-deck")).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 32);
  });

  it("the committed PowerPoint table deck passes and carries a table on slide 2", () => {
    const files = load(new Uint8Array(readFileSync(TABLE_DECK)));
    assert.deepEqual(validate(files), []);
    assert.ok(/<a:tbl>/.test(files["ppt/slides/slide2.xml"]!));
  });

  for (const file of REAL) {
    it(`real PowerPoint deck ${path.basename(file)} passes (validator oracle)`, { skip: !existsSync(file) && "fixture file missing" }, () => assert.deepEqual(validate(load(new Uint8Array(readFileSync(file)))), []));
  }

  it("the validator rejects a deck with a missing content type", () => {
    const files = load(new Uint8Array(readFileSync(TABLE_DECK)));
    files["[Content_Types].xml"] = files["[Content_Types].xml"]!.replace(/<Override PartName="\/ppt\/slides\/slide1.xml"[^>]*>/, "");
    assert.ok(validate(files).some((m) => m.includes("slide1.xml")));
  });

  it("the validator rejects notes without a notesMasterIdLst", () => {
    const files = load(decks["notes-deck"]!);
    files["ppt/presentation.xml"] = files["ppt/presentation.xml"]!.replace(/<p:notesMasterIdLst>.*?<\/p:notesMasterIdLst>/, "");
    assert.ok(validate(files).some((m) => m.includes("notesMasterIdLst")));
  });
});
