import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Box } from "../src/timeline/render/types.ts";

// The pure describer (assets/view-table.js, loaded the way the browser loads it), tested on hand-built Views.

await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
interface Described {
  kind: string; id: string; label: string; moreRows?: number; sha?: string;
  columns?: Array<{ name: string; hidden: boolean }>;
  rows?: Array<{ gap?: true; row?: number; hidden?: boolean; cells?: Array<{ ref: string; col: string; text: string; fill: string | null; bold: boolean; box: number | null }> }>;
  rects?: Array<{ box: number; left: number; top: number; width: number; height: number }>;
}
const VT = (globalThis as unknown as { CoCheckViewTable: { boxesOf(v: unknown, k: string): Box[]; describePane(p: unknown, b: Box[], s: string): Described } }).CoCheckViewTable;

/** The marks a view carries for the page (the page reads them from the v1 document's change boxes), without the ones of confidence none. */
const boxesOf = (v: { boxes?: Box[] }, key?: string): Box[] => (v.boxes ?? []).filter((b) => b.confidence !== "none" && (key === undefined || b.change === key));
describe("describePane on hand-built Views", () => {
  // The grid describer and its tests are deleted; the box filter it shared with the picture and text panes is pinned on a picture pane
  it("a box on another side, another pane or with confidence none marks nothing", () => {
    const base = { change: "c1", rect: { x: 1, y: 1, w: 10, h: 10 } };
    const boxes = boxesOf({ boxes: [{ ...base, side: "before", pane: "p", confidence: "exact" }, { ...base, side: "after", pane: "other", confidence: "exact" }, { ...base, side: "after", pane: "p", confidence: "none" }, { ...base, change: "c2", side: "after", pane: "p", confidence: "exact" }] }, "c1");
    assert.equal(boxes.length, 2);
    const pic = { id: "p", label: "page", picture: { sha: "a".repeat(64), width: 200, height: 100 } };
    assert.deepEqual(VT.describePane(pic, boxes, "after").rects, []);
    // the same filter keeps a box on this side and pane, so the empty list above is the filter, not a pane that marks nothing
    assert.equal(VT.describePane(pic, boxesOf({ boxes: [{ ...base, side: "after", pane: "p", confidence: "exact" }] }), "after").rects!.length, 1);
  });

  it("scales a picture box to percent of the picture and refuses a bad sha or size", () => {
    const sh = "a".repeat(64);
    const boxes = boxesOf({ boxes: [{ change: "c1", side: "after", pane: "pic", rect: { x: 50, y: 25, w: 100, h: 50 }, confidence: "pixel" }] }, "c1");
    const d = VT.describePane({ id: "pic", label: "page", picture: { sha: sh, width: 200, height: 100 } }, boxes, "after");
    assert.deepEqual([d.kind, d.sha, d.rects], ["picture", sh, [{ box: 0, left: 25, top: 25, width: 50, height: 50 }]]);
    assert.equal(VT.describePane({ id: "pic", label: "x", picture: { sha: "../etc", width: 2, height: 2 } }, boxes, "after").kind, "card");
    assert.equal(VT.describePane({ id: "pic", label: "x", picture: { sha: sh, width: 0, height: 2 } }, boxes, "after").kind, "card");
    assert.equal(VT.describePane({ id: "e", label: "x" }, [], "after").kind, "card");
  });
});
