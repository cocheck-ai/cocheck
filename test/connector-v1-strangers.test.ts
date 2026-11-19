// A valid cocheck.changes/1 document that carries no CoCheck private data draws every change on the served page (as a box on a drawn picture, or a row of the
// words list), the page takes no hint from a public field, and the document has no `system`, document `level` or box `side`.
// The page here is the real review.js in the vm harness (test/helpers/connector-v1-page.ts) fed the document as the /view route would send it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { ALL_PAIRS, drivePage, modelOf, type PageCapture } from "./helpers/connector-v1-page.ts";
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VT = (globalThis as any).CoCheckViewTable;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const drawnIds = (c: PageCapture): string[] => [...new Set([...c.cards.map((x) => x.id), ...c.wordsIds])];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
async function driveDoc(pairName: string, doc: unknown): Promise<PageCapture> {
  const pm = await modelOf(ALL_PAIRS.find((p) => p.name === pairName)!);
  return drivePage(pm, async () => clone(doc));
}

/** A grid document a stranger could write: two grid pictures with no private data, three changes anchored on cells. */
const strangerGrid = (): Json => ({
  spec: "cocheck.changes/1",
  pictures: [{ id: "b-sheet", side: "before", type: "grid", label: "Inputs" }, { id: "a-sheet", side: "after", type: "grid", label: "Inputs" }],
  changes: [
    { id: "c1", mark: "changed", label: "Inputs!B3", before: "10", after: "12", boxes: [{ picture: "b-sheet", cell: "B3" }, { picture: "a-sheet", cell: "B3" }] },
    { id: "c2", mark: "added", label: "Inputs!C4", after: "7", boxes: [{ picture: "a-sheet", cell: "C4" }] },
    { id: "c3", mark: "removed", label: "Inputs!D5", before: "x", boxes: [{ picture: "b-sheet", cell: "D5:E6" }] },
  ],
  caveats: [], engine: "stranger", file: "book.xlsx", kind: "grid", source: { by: "connector", name: "stranger", level: 3 },
});

describe("(1,5): a stranger's grid document with no private data draws every change on the page", () => {
  it("validates with no level, system or box side, and every change is a card or a words-list row, count asserted", async () => {
    const doc = strangerGrid();
    assert.deepEqual(checkChanges(doc, 3), []);
    const cap = await driveDoc("xlsx-value-edit", doc);
    assert.deepEqual(drawnIds(cap).sort(), ["c1", "c2", "c3"], JSON.stringify({ cards: cap.cards, words: cap.wordsList }));
    assert.equal(drawnIds(cap).length, 3);
    // the cell changes fall to the words list, "not marked": no grid pane drew them
    assert.equal(cap.cards.length, 0);
    assert.ok(cap.wordsList.every((l) => /not marked/i.test(l)), cap.wordsList.join("|"));
  });
  it("must not: a grid box is never counted as drawn where no grid pane draws it (no false clean)", async () => {
    const doc = strangerGrid();
    const scene = VT.sceneOf(doc);
    assert.equal(scene.items.length, 3);
    for (const it of scene.items) for (const b of it.boxes) assert.ok(!b.grid, `${it.id}: cell box on a picture with no grid`);
    const cap = await driveDoc("xlsx-value-edit", doc);
    assert.notEqual(drawnIds(cap).length, 0, "a clean step: zero cards and zero words rows");
  });
});


describe("(3): the page takes no hint from a public field", () => {
  const change = (id: string, extra: Json) => ({ id, mark: "changed", label: `Item ${id}`, before: "a", after: "b", ...extra });
  const hinted = (): Json => ({
    spec: "cocheck.changes/1",
    pictures: [{ id: "readme/notes", side: "after", type: "text", label: "Notes" }, { id: "readme", side: "after", type: "text" }, { id: "page", side: "before", type: "image", src: `pdfpage/${"a".repeat(64)}/1`, width: 100, height: 100 }],
    changes: [
      change("k1", { kind: "region" }), change("k2", { kind: "card" }), change("k3", { kind: "card-paragraph" }), change("k4", { kind: "notes" }), change("k5", { kind: "paragraph" }), change("k6", { kind: "cell" }),
      change("n1", { boxes: [{ picture: "readme/notes", lines: { from: 4, to: 4 } }] }),
    ],
    caveats: [], engine: "stranger", file: "f.txt", kind: "card", source: { by: "connector", name: "stranger", level: 3 },
  });
  it("kind region, card, card-paragraph, notes, paragraph, cell on a stranger's change: each still draws, with its head, and counts in the tally", async () => {
    const doc = hinted();
    const scene = VT.sceneOf(doc);
    assert.equal(scene.items.length, 7);
    assert.equal(scene.cards.length, 7, "no change is dropped from the cards");
    assert.equal(VT.noteCard(doc.changes[2]).place, "Item k3", "a card-paragraph kind does not drop the head");
    assert.match(VT.tallyLine(doc.changes), /^7 changed$/);
    const cap = await driveDoc("xlsx-value-edit", doc);
    assert.equal(drawnIds(cap).length, 7, JSON.stringify({ cards: cap.cards.map((c) => c.id), words: cap.wordsIds }));
  });
  it("a text picture whose id ends in /notes keeps its line number and its own pane", () => {
    const scene = VT.sceneOf(hinted());
    const m = scene.marks.find((x: Json) => x.change === "n1");
    assert.equal(m.pane, "readme/notes");
    assert.equal(m.line, 4);
    assert.ok(!m.notes);
  });
});

describe("(4): picture.system, the document level and box.side are cut", () => {
  it("a document without them is valid; one that still carries them is not rejected for them, and they are never read", () => {
    const doc = strangerGrid();
    assert.deepEqual(checkChanges(doc), []);
    const old = clone(doc); old.level = 3; old.pictures.forEach((p: Json) => { p.system = "text"; }); old.changes.forEach((c: Json) => c.boxes.forEach((b: Json) => { b.side = "after"; }));
    assert.deepEqual(checkChanges(old), [], "a stale field is ignored, not an error");
  });
  it("the level is the connector's, passed in: pictures need level 2, boxes level 3", () => {
    const doc = strangerGrid();
    assert.ok(checkChanges(doc, 1).some((p) => p.field === "pictures"));
    assert.ok(checkChanges(doc, 2).some((p) => p.field === "changes[0].boxes"));
    assert.deepEqual(checkChanges({ ...doc, pictures: undefined, changes: doc.changes.map(({ boxes: _b, ...c }: Json) => c) }, 1), []);
  });
  it("a box's side is its picture's side: a box on an unknown picture is still rejected, and the page draws the box on the picture's side", () => {
    const doc = strangerGrid();
    doc.changes[0].boxes[0].picture = "nope";
    assert.deepEqual(checkChanges(doc).map((p) => p.field), ["changes[0].boxes[0].picture"]);
    const scene = VT.sceneOf(strangerGrid());
    assert.deepEqual(scene.items[0].boxes.map((b: Json) => b.side), ["before", "after"]);
  });
});
