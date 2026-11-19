import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { served } from "./helpers/v1-served.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { fallbackRenderer } from "../src/timeline/render/fallback.ts";
import { textRenderer } from "../src/timeline/render/text.ts";
import type { Box, ChangeInfo, Pane, View } from "../src/timeline/render/types.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// every View kind a real renderer emits goes through the page's pure half (describePane, collapseBoxes), the loading
// screen of a step clears the last moment, and the other-moment tree drops generic.secret files. Views come from the real renderers.

await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
type Described = Record<string, unknown> & { lines?: Array<{ n?: string; box?: number | null; gap?: boolean }>; rows?: Array<{ cells?: Array<{ ref: string; box: number | null }> }>; rects?: Array<{ box: number }> };
const VT = (globalThis as unknown as {
  CoCheckViewTable: {
    sceneOf(d: unknown): { marks: Box[]; after: unknown[] };
    describePane(p: unknown, b: Box[], s: string): Described;
    loadingScreen(get: (id: string) => Stub, make?: (t: string) => unknown): void;
  };
}).CoCheckViewTable;

interface Stub { textContent: string; hidden: boolean; kids: unknown[]; append(n: unknown): void }
const stub = (): Stub => ({ textContent: "stale", hidden: false, kids: [], append(n) { this.kids.push(n); } });

const info = (extra: Partial<ChangeInfo> = {}): ChangeInfo => ({ id: "k1", file: "a.txt", kind: "modified", ...extra });
const buf = (s: string): Buffer => Buffer.from(s, "utf8");

/** The first boxed thing the page would anchor to, per side, and the box index it carries. */
function boxedIndexes(d: Described): number[] {
  if (d.kind === "grid") return (d.rows ?? []).flatMap((r) => (r.cells ?? []).flatMap((c) => (c.box === null ? [] : [c.box])));
  if (d.kind === "text") return (d.lines ?? []).flatMap((l) => (l.box == null ? [] : [l.box]));
  if (d.kind === "picture") return (d.rects ?? []).map((r) => r.box);
  return [];
}
function describeAfter(v: View): { boxes: Box[]; marked: number[] } {
  const scene = VT.sceneOf(served(v as unknown as Record<string, unknown>));
  const boxes = scene.marks;
  const marked = (scene.after as Pane[]).flatMap((p: Pane) => boxedIndexes(VT.describePane(p, boxes, "after")));
  return { boxes, marked };
}

describe("every renderer's real View is boxed by the page", () => {

  it("text: the changed line is marked on both sides, and the note's anchor is that line", async () => {
    const before = buf(["one", "two", "three", "four", "five"].join("\n"));
    const after = buf(["one", "two", "THREE", "four", "five"].join("\n"));
    const v = await textRenderer.view(before, after, info());
    const { boxes, marked } = describeAfter(v);
    assert.equal(marked.length, 1);
    assert.equal(boxes[marked[0]!]!.line, 3);
    const d = VT.describePane(v.after[0], boxes, "after");
    assert.equal(d.lines!.find((l) => l.box === marked[0])!.n, "3");
    const b = VT.describePane(v.before[0], boxes, "before");
    assert.equal(b.lines!.filter((l) => l.box != null).length, 1);
  });

  it("pages (fallback picture): the pixel region is a rect on the picture and anchors the note", async () => {
    const generic = { tier: "picture", label: "l", picture: { before: "a".repeat(64), after: "b".repeat(64), width: 100, height: 200, regions: [{ x: 10, y: 20, w: 30, h: 40 }], note: null } } as unknown as ChangeInfo["generic"];
    const v = await fallbackRenderer.view(null, null, info({ generic }));
    assert.equal(v.kind, "pages");
    const { boxes, marked } = describeAfter(v);
    assert.equal(marked.length, 1);
    assert.equal(boxes[marked[0]!]!.side, "after");
    const d = VT.describePane(v.after[0], boxes, "after");
    assert.deepEqual(d.rects!.map((r) => r.box), marked);
  });

  it("describePane reads box.line first and falls back to a cell-style location", () => {
    const pane = { id: "after:text", label: "x", text: { lines: [{ n: 1, text: "a" }, { n: 2, text: "b" }] } };
    const hit = (extra: Partial<Box>): Described => VT.describePane(pane, [{ side: "after", pane: "after:text", change: "c", confidence: "exact", ...extra }], "after");
    assert.deepEqual(hit({ line: 2 }).lines!.map((l) => l.box), [null, 0]);
    assert.deepEqual(hit({ cell: "L1" }).lines!.map((l) => l.box), [0, null]);
  });
});

describe("stepping to a moment", () => {
  it("clears panes, tabs, caveats, notes, leaders and trees before the fetch, and says it is loading", () => {
    const els: Record<string, Stub> = {};
    const get = (id: string): Stub => (els[id] ??= stub());
    VT.loadingScreen(get, (t) => t);
    for (const id of ["tb", "ta", "caveats", "notes", "svg"]) assert.equal(get(id).textContent, "", id);
    for (const id of ["trb", "tra"]) assert.deepEqual([get(id).textContent, get(id).hidden], ["", true], id);
    // no "this moment" on the page; the caveats sit behind a closed disclosure, so the panes alone say it is loading
    // each pane gets the loading widget, named for its side (the page passes a builder; here the label itself stands in)
    assert.deepEqual([get("vb").textContent, get("vb").kids], ["", ["Loading the before picture"]]);
    assert.deepEqual([get("va").textContent, get("va").kids], ["", ["Loading the after picture"]]);
  });
});

describe("other-moment tree", () => {
  const ref = { sha256: "a".repeat(64), size: 1, kept: "whole", stored: true, why: null, preview: { label: "l", ref: null, missing: null } };
  const ch = (id: string, file: string, generic: Record<string, unknown>): Change =>
    ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref, after: ref, credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: "l", ...generic } }) as unknown as Change;
  it("drops a file flagged generic.secret by name, not just by secret-looking path", () => {
    const changes = [ch("c1", "plain.txt", {}), ch("c2", "innocent-name.txt", { secret: true }), { ...ch("c3", "notes.txt", {}), kind: "created", before: null } as Change];
    const t = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [],
      requests: [{ id: "r1", index: 1, session: "s", texts: [{ text: "t", source: "user", label: "l" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
        runs: [{ id: "run1", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
          calls: [{ id: "call1", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }] }] } as unknown as Timeline;
    const m = buildRailModel(t);
    const tree = JSON.stringify(m.stops.filter((s) => s.change && !s.change.secret).map((s) => [s.change!.treeBefore, s.change!.treeAfter]));
    assert.ok(tree.includes("plain.txt"), "the tree is drawn at all");
    assert.ok(!tree.includes("innocent-name"));
  });
});
