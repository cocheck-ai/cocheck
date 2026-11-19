// Every renderer's View becomes one cocheck.changes/1 level-3 document at the serve boundary, and the page reads only that document.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { served } from "./helpers/v1-served.ts";

describe("(2,6): the page reads only the v1 document; a planted secret never reaches changes[]", () => {
  const dir = path.join(import.meta.dirname, "..", "src", "timeline", "rail", "assets");
  it("no reader of View.boxes or View.changes under the page assets; fallbackChanges and commentFor do not exist", () => {
    for (const f of ["review.js", "view-table.js", "files-view.js"]) {
      const src = readFileSync(path.join(dir, f), "utf8");
      assert.ok(!/\bview\.(boxes|changes)\b|\.fallbackChanges|commentFor|VT\.cardBox|rc\.rowNotes|rc\.cards|rc\.extraCards/.test(src), f);
      assert.ok(!/function (fallbackChanges|commentFor|cardBoxes)/.test(src), f);
    }
  });
  it("sentinel: a secret and a home path in grid cells and speaker notes stay in pictures[].private; card words come only from the model's cards", () => {
    const SECRET = "ghp_PLANTEDSECRET0123456789abcdefghijkl", HOME = "/Users/someone/private-folder/key.txt";
    const view = { engine: "x", kind: "grid", before: [], after: [{ id: "after:S", label: "S", grid: { sheet: "S", state: "visible", columns: [{ name: "A", width: null, hidden: false }], rows: [{ row: 1, hidden: false, cells: { A: { ref: "A1", text: SECRET + HOME } } }], merges: [], moreRows: 0 } }, { id: "after:page1", label: "p", picture: { sha: "a".repeat(64), width: 10, height: 10, page: 1 }, notes: SECRET }], changes: [{ id: "k1", loc: "S!A1", kind: "cell", parent: null, boxes: [{ side: "after", pane: "after:S", cell: "A1" }] }], caveats: [] };
    const doc = served(view, { rowNotes: [{ location: "S!A1", text: "Claude changed S!A1" }] });
    assert.deepEqual(checkChanges(doc), []);
    const outside = JSON.stringify({ ...doc, pictures: doc.pictures.map((p) => ({ ...p, private: undefined })) });
    assert.ok(!outside.includes(SECRET) && !outside.includes(HOME), "nothing outside private");
    assert.ok(JSON.stringify(doc.pictures).includes(SECRET), "private still holds the page's own data");
    assert.equal(doc.changes[0]!.text, "Claude changed S!A1");
  });
});
