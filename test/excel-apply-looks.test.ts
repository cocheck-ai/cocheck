// applyLooks writes v1 boxes and words only for the changes the sides it is given speak of.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyLooks } from "../src/office/connector/excel/look.ts";
import type { OfficeDoc } from "../src/office/connector/program.ts";

describe("applyLooks touches only the changes the sides speak of", () => {
  it("a change that is in none of the sides keeps the boxes and words it already has", () => {
    const doc = { spec: "cocheck.changes/1", caveats: [], changes: [{ id: "c1", mark: "changed", label: "c1", kind: "cell", unplaced: { after: "print words" }, boxes: [{ picture: "x", rect: { x: 0, y: 0, w: 1, h: 1 } }] }] } as unknown as OfficeDoc;
    const plan = { changes: [{ id: "c1", mark: "changed", label: "c1", kind: "cell" }], caveats: [], before: [], after: [], groups: [] } as never;
    applyLooks(doc, [{ pictures: [], boxes: [], unplaced: [] }], plan);
    const c = doc.changes[0] as unknown as { unplaced?: unknown; boxes?: unknown };
    assert.deepEqual(c.unplaced, { after: "print words" });
    assert.ok(c.boxes !== undefined);
  });
});
