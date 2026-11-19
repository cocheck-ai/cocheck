import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Box } from "../src/timeline/render/types.ts";

// the pure half of the review page (assets/view-table.js, loaded the way the browser loads it): collapsing a big change into
// at most five ranges, the note layout and leader lines, the engine sentence, the PDF page and the numbered-lines pane.

await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
interface Group { pane: string; label: string; count: number; members: number[]; first: number }
interface Plan { collapsed: boolean; groups: Group[]; more: { groups: number; changes: number } }
const VT = (globalThis as unknown as {
  CoCheckViewTable: {
    collapseBoxes(b: Box[], has: (i: number) => boolean, max: number): Plan;
    stackNotes(items: Array<{ cy: number; hidden?: boolean }>, h: number[], top: number, gap: number): { slots: Array<{ top: number; ny: number }>; end: number };
    leaderPoints(x1: number, y1: number, nl: number, ny: number): number[][];
    describePane(p: unknown, b: Box[], s: string): Record<string, unknown> & { lines?: Array<Record<string, unknown>> };
  };
}).CoCheckViewTable;

const colName = (c: number): string => String.fromCharCode(64 + c);
const box = (cell: string, pane = "S", side: "before" | "after" = "after"): Box => ({ side, pane, cell, change: "k", confidence: "exact" });
const yes = (): boolean => true;

describe("engine line", () => {
  it("the view-table module prints no renderer label", () => {
    assert.equal((VT as unknown as Record<string, unknown>).engineLine, undefined);
  });
});

describe("collapsing boxes", () => {




});

// segment intersection, strictly interior crossings only (shared endpoints and collinear touching are not crossings)
type Pt = [number, number];
const cross = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
  const o = (p: Pt, q: Pt, r: Pt): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};

describe("note layout", () => {
  it("stacks notes in anchor order without overlap", () => {
    const items = [{ cy: 300 }, { cy: 100 }, { cy: 110 }, { cy: 120 }, { cy: 500 }];
    const heights = [80, 120, 60, 90, 70];
    const st = VT.stackNotes(items, heights, 0, 8);
    const order = [1, 2, 3, 0, 4];
    for (let k = 1; k < order.length; k++) assert.ok(st.slots[order[k]!]!.top >= st.slots[order[k - 1]!]!.top + heights[order[k - 1]!]! + 8);
    assert.ok(st.end >= st.slots[4]!.top + 70);
  });

  it("notes with a visible anchor stack first, notes with none follow in list order, whatever their cy", () => {
    const items = [{ cy: 0, hidden: true }, { cy: 300 }, { cy: 0, hidden: true }, { cy: 100 }];
    const st = VT.stackNotes(items, [50, 50, 50, 50], 0, 8);
    assert.deepEqual(st.slots.map((s) => s.top), [336, 278, 394, 78]);
    assert.equal(st.end, 452);
  });

  it("no leader crosses another, for scattered anchors and notes of any height", () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rnd() * 4);
      const items = Array.from({ length: n }, () => ({ cy: 40 + rnd() * 900 }));
      const heights = items.map(() => 40 + rnd() * 200);
      const xs = items.map(() => 200 + rnd() * 300);
      const st = VT.stackNotes(items, heights, 30, 8);
      const lines = items.map((it, k) => VT.leaderPoints(xs[k]!, it.cy, 700, st.slots[k]!.ny) as Pt[]);
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        assert.equal(cross(lines[a]![i]!, lines[a]![i + 1]!, lines[b]![j]!, lines[b]![j + 1]!), false, `trial ${trial}: leader ${a} crosses ${b}`);
      }
    }
  });
});

describe("panes", () => {
  it("a picture pane with a page loads that page; without one it does not", () => {
    const sha = "a".repeat(64);
    const withPage = VT.describePane({ id: "p", label: "Page 2", picture: { sha, width: 600, height: 800, page: 2 } }, [], "after");
    assert.equal(withPage.kind, "picture");
    assert.equal(withPage.page, 2);
    const plain = VT.describePane({ id: "p", label: "x", picture: { sha, width: 600, height: 800 } }, [], "after");
    assert.equal(plain.page, null);
    assert.equal(VT.describePane({ id: "p", label: "x", picture: { sha, width: 6, height: 8, page: 0 } }, [], "after").page, null);
  });

  it("a text pane draws numbered lines, gap markers and boxed lines", () => {
    const pane = { id: "t", label: "Text", text: { lines: [{ n: 1, text: "one" }, { n: 2, text: "two" }, { gap: true }, { n: 40, text: "forty" }] } };
    const boxes: Box[] = [box("2", "t"), box("40", "t", "before"), box("40", "t")];
    const d = VT.describePane(pane, boxes, "after");
    assert.equal(d.kind, "text");
    assert.deepEqual(d.lines, [
      { n: "1", text: "one", kind: null, marks: [], box: null },
      { n: "2", text: "two", kind: null, marks: [], box: 0 },
      { gap: true, hidden: 0 },
      { n: "40", text: "forty", kind: null, marks: [], box: 2 },
    ]);
    // aligned rows keep their kind and valid marks; bad marks drop; filler and counted folds pass through
    const aligned = VT.describePane({ id: "t", label: "T", text: { lines: [{ n: 5, text: "ab cd", kind: "edit", marks: [[3, 5]] }, { filler: true }, { gap: true, hidden: 31 }, { n: 9, text: "xy", kind: "add", marks: [[1, 9]] }] } }, [], "after");
    assert.deepEqual(aligned.lines, [{ n: "5", text: "ab cd", kind: "edit", marks: [[3, 5]], box: null }, { filler: true }, { gap: true, hidden: 31 }, { n: "9", text: "xy", kind: "add", marks: [], box: null }]);
    const nil = VT.describePane({ id: "t", label: "T", text: { lines: [{ n: 3, text: null }] } }, [{ side: "after", pane: "t", rect: { x: 0, y: 0, w: 1, h: 1 }, change: "k", confidence: "pixel" } as Box], "after");
    assert.deepEqual(nil.lines, [{ n: "3", text: "", kind: null, marks: [], box: null }]);
  });
});
