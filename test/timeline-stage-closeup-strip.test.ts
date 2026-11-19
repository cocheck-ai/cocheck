import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asServed } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The stage, from public fields only: the close-up's crop rules (union, padding, clipping, the mate rule, when to skip), the zoom bounds, the
// picture strip, where a step opens (the first change in list order with a box the page drew; level 2: the first picture marked changed), and one
// full-width pane for a created or removed subject. Pure rules run view-table.js in node; the page rules boot review.js in the vm page of
// test/connector-cpic-pages.test.ts.

const SHA = "a".repeat(64);
const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
function change(id: string, file: string, kind = "modified"): Change {
  return { id, file, outside: false, at: null, kind, step: 1, before: kind === "created" ? null : ref(SHA), after: kind === "deleted" ? null : ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } } as unknown as Change;
}
const request = (id: string, index: number, text: string, changes: Change[]) => ({
  id, index, session: "s", texts: [{ text, source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: `run-${id}`, rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
    calls: [{ id: `call-${id}`, index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }],
});
const timeline = (reqs: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: reqs }) as unknown as Timeline;
const modelOf = (kind = "modified") => JSON.parse(JSON.stringify(buildRailModel(timeline([request("r0", 0, "Do it", [change("c1", "deck/slides.bin", kind)])]))));

interface Node { tag: string; className: string; attrs: Record<string, string>; children: Node[]; hidden: boolean; textContent: string; [k: string]: unknown }
function makePage(answer: (u: string) => unknown, hash: string) {
  const nodes = new Map<string, Node>();
  const timers: Array<() => void> = [], delays: number[] = [], asked: string[] = [];
  const make = (tag: string): Node => {
    let text = "";
    const base = {
      tag, className: "", attrs: {} as Record<string, string>, children: [] as unknown[], hidden: false, nodeType: 1, dataset: {}, style: { setProperty() {}, removeProperty() {} },
      get textContent(): string { return text + (this.children as Node[]).map((c) => (c && typeof c === "object" ? c.textContent : "")).join(""); },
      set textContent(v: string) { text = v; this.children = []; },
      append(...c: unknown[]) { (this.children as unknown[]).push(...c); },
      setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); },
      getAttribute(k: string) { return this.attrs[k] ?? null; },
      get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; },
    };
    return new Proxy(base, { get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make("div") : undefined), set: (t, k, v) => { (t as Record<PropertyKey, unknown>)[k] = v; return true; } }) as unknown as Node;
  };
  const byId = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, make("div")); return nodes.get(id)!; };
  const body = make("body"); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => make(t), createElementNS: (_: string, t: string) => make(t), createTextNode: (t: string) => ({ nodeType: 3, textContent: t, children: [] }), querySelectorAll: () => [], addEventListener() {} };
  const g: Record<string, unknown> = {
    document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener() {}, setInterval: () => 1, clearInterval() {}, setTimeout: (f: () => void, ms?: number) => { timers.push(f); delays.push(ms ?? 0); return timers.length; }, clearTimeout() {},
    fetch: async (u: string) => {
      asked.push(u);
      const v = await answer(u);
      if (v instanceof Error) throw v;
      if (v && typeof v === "object" && "__status" in v) return { ok: false, status: (v as { __status: number }).__status, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(asServed(v))) };
    },
  };
  g.window = g; g.globalThis = g;
  return { g, byId, timers, delays, asked, nodes };
}
const settle = () => new Promise((r) => setTimeout(r, 15));
async function boot(answer: (u: string) => unknown, hash = "#1") {
  const page = makePage(answer, hash);
  const ctx = vm.createContext(page.g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await settle();
  /* fire every timer queued so far (not the ones they queue), then let the answers land */
  const tick = async () => { const fs = page.timers.splice(0); for (const f of fs) f(); await settle(); };
  return { ...page, tick };
}
const tree = (n: Node): Node[] => (n && typeof n === "object" && Array.isArray(n.children) ? n.children.flatMap((c) => (c && typeof c === "object" && "className" in c ? [c, ...tree(c)] : [])) : []);
/** every widget under a node, as its label */
const widgets = (n: Node): string[] => tree(n).filter((c) => c.className.split(/\s+/).includes("iload")).map((c) => {
  assert.equal(c.attrs.role, "status", "the widget is a status region");
  const sr = tree(c).find((x) => x.className === "iload-sr");
  assert.ok(sr && sr.textContent.trim() !== "", "the widget carries its label in words");
  return sr!.textContent;
});

const tree2 = (n: Node): Node[] => (n && typeof n === "object" && Array.isArray(n.children) ? n.children.flatMap((c) => (c && typeof c === "object" && "className" in c ? [c, ...tree2(c)] : [])) : []);
const has = (n: Node, c: string) => n.className.split(/\s+/).includes(c);

type R = { x: number; y: number; w: number; h: number };
interface VTApi {
  sceneOf(d: unknown): any; unionRect(r: R[]): R | null; cropRegion(r: R[], w: number, h: number): R | null; mateOf(p: any, o: any[]): any;
  closeUpPlan(s: any, id: string): any; closeUp(plan: any, colW: number, maxH: number, minH?: number): any; rowHeight(s: any, ids: string[], colW: number, maxH: number): number; zoomFor(o: Record<string, number>): number; stripOf(p: any[], m: any[]): any[]; pictureName(p: any): string;
}
async function vt(): Promise<VTApi> {
  const ctx = vm.createContext({ console });
  vm.runInContext(await readFile(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url), "utf8"), ctx);
  return (ctx as unknown as { CoCheckViewTable: VTApi }).CoCheckViewTable;
}
const S = (n: number) => String(n).repeat(64);
const pic = (id: string, side: "before" | "after", n: number, extra: Record<string, unknown> = {}) => ({ id, side, type: "image", label: "", src: `cpic/${S(n)}`, width: 1600, height: 900, ...extra });
const doc = (pictures: unknown[], changes: unknown[], level = 3) => ({ spec: "cocheck.changes/1", source: { by: "connector", name: "toy", level }, pictures, changes, caveats: [] });
const box = (picture: string, x: number, y: number, w: number, h: number, highlights?: R[]) => ({ picture, rect: { x, y, w, h }, ...(highlights ? { highlights } : {}) });

describe("close-up crop rules (pure)", () => {
  it("drawBoxes: a change's touching boxes draw as one; stacked boxes of two changes meet midway and never overlap; a box inside another keeps its pad", async () => {
    const VT = (await vt()) as any;
    const W = 1000, H = 1000, P = W * 0.007;
    const px = (b: any) => ({ y0: b.top * H / 100, y1: (b.top + b.height) * H / 100, x0: b.left * W / 100, x1: (b.left + b.width) * W / 100 });
    // one change, two paragraphs that touch: one drawn box, the second entry folded into the first
    const one = VT.drawBoxes([{ rect: { x: 100, y: 100, w: 600, h: 50 }, key: "a" }, { rect: { x: 100, y: 150, w: 600, h: 50 }, key: "a" }], W, H);
    assert.equal(one[1], null);
    const u = px(one[0]);
    assert.ok(Math.abs(u.x0 - (100 - P)) < 1e-6 && u.y0 < 100 && u.y1 > 200, `the union, padded: ${JSON.stringify(u)}`);
    // two changes on adjacent lines: edges stay on their own side of the line between them
    const two = VT.drawBoxes([{ rect: { x: 100, y: 100, w: 600, h: 50 }, key: "a" }, { rect: { x: 100, y: 150, w: 600, h: 50 }, key: "b" }], W, H);
    const a = px(two[0]), b = px(two[1]);
    assert.ok(a.y1 < 150 && b.y0 > 150 && a.y1 < b.y0, `no overlap across the line between them: ${a.y1} ${b.y0}`);
    assert.ok(a.y0 < 100 && b.y1 > 200, "the outer edges keep their pad");
    // a word box inside a paragraph box of another change keeps its own pad
    const nest = VT.drawBoxes([{ rect: { x: 100, y: 100, w: 600, h: 100 }, key: "a" }, { rect: { x: 300, y: 120, w: 80, h: 30 }, key: "b" }], W, H);
    const n = px(nest[1]);
    assert.ok(Math.abs(n.x0 - (300 - P)) < 1e-6 && n.y0 < 120 && n.y1 > 150);
    // above and below, a box's pad is a quarter of the side pad, so its edge stays in the gap between lines of text
    const pb = VT.padBox({ x: 100, y: 200, w: 300, h: 60 }, W, H);
    assert.ok(Math.abs(pb.top * H / 100 - (200 - P / 4)) < 1e-6 && Math.abs(pb.left * W / 100 - (100 - P)) < 1e-6);
  });
  it("a wide, short box gets height for context: no wider than 4 to 1, grown evenly above and below, shifted back inside the picture", async () => {
    const VT = await vt();
    const r = VT.cropRegion([{ x: 200, y: 400, w: 800, h: 20 }], 1600, 900)!;
    assert.ok(r.w / r.h <= 4 + 1e-9, `aspect ${r.w}/${r.h}`);
    assert.ok(r.y < 400 && r.y + r.h > 420, "the box sits inside, with context above and below");
    assert.ok(Math.abs((400 + 10) - (r.y + r.h / 2)) < 1e-6, "evenly around the box");
    const t = VT.cropRegion([{ x: 200, y: 2, w: 800, h: 20 }], 1600, 900)!;
    assert.ok(t.y >= 0 && t.w / t.h <= 4 + 1e-9, "at the picture's edge the region shifts inside instead of shrinking");
    const tall = VT.cropRegion([{ x: 400, y: 400, w: 200, h: 100 }], 1600, 900)!;
    assert.ok(Math.abs(tall.h - (100 + 2 * (1600 * 0.007 + 24))) < 1e-9, "a box that is not wide keeps its plain padding");
  });
  it("rowHeight: the tallest close-up of the changes, and a close-up given that height shows more of the picture, never a larger scale", async () => {
    const VT = await vt();
    const d = doc([pic("b1", "before", 1), pic("a1", "after", 3)], [{ id: "c1", mark: "changed", boxes: [box("b1", 100, 100, 200, 20), box("a1", 100, 100, 200, 20)] }, { id: "c2", mark: "changed", boxes: [box("b1", 100, 500, 200, 200), box("a1", 100, 500, 200, 200)] }]);
    const sc = VT.sceneOf(d);
    const h1 = VT.closeUp(VT.closeUpPlan(sc, "c1"), 800, 360)!, h2 = VT.closeUp(VT.closeUpPlan(sc, "c2"), 800, 360)!;
    assert.ok(h2.height > h1.height, "the changes differ in height alone");
    assert.equal(VT.rowHeight(sc, ["c1", "c2"], 800, 360), h2.height);
    assert.equal(VT.rowHeight(sc, ["c1", "nope"], 800, 360), h1.height);
    const grown = VT.closeUp(VT.closeUpPlan(sc, "c1"), 800, 360, h2.height)!;
    assert.equal(grown.height, h2.height, "the row height is the same across the step");
    assert.equal(grown.scale, h1.scale, "scale unchanged");
    assert.ok(grown.after.h > h1.after.h, "more of the picture around the change");
  });
  it("the region is the union of the rects, padded around the drawn box by a fifth of the box (at least 24 px), clipped to the picture", async () => {
    const VT = await vt();
    assert.deepEqual({ ...VT.unionRect([{ x: 100, y: 100, w: 50, h: 20 }, { x: 300, y: 90, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 5 }])! }, { x: 100, y: 90, w: 210, h: 30 });
    assert.equal(VT.unionRect([]), null);
    const r = VT.cropRegion([{ x: 400, y: 400, w: 200, h: 100 }], 1600, 900)!;
    const P = 1600 * 0.007; // padBox's own padding of the drawn box
    assert.ok(Math.abs(r.x - (400 - P - 40)) < 1e-9 && Math.abs(r.w - (200 + 2 * (P + 40))) < 1e-9, `x pad: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.y - (400 - P - 24)) < 1e-9, `y pad has the 24 px floor (a fifth of 100 is 20): ${r.y}`);
    const c = VT.cropRegion([{ x: 5, y: 880, w: 100, h: 15 }], 1600, 900)!;
    assert.equal(c.x, 0); assert.equal(c.y + c.h, 900, "clipped to the picture");
  });
  it("the mate is the same group and order, else the same label (side word aside), else the only picture; none when ambiguous", async () => {
    const VT = await vt();
    const p = (id: string, x: Record<string, unknown>) => ({ id, label: "", picture: { sha: S(1), width: 10, height: 10 }, ...x });
    const a = p("a", { group: "g", order: 1, label: "After, Slide 2" });
    assert.equal(VT.mateOf(a, [p("b0", { group: "g", order: 0, label: "Before, Slide 2" }), p("b1", { group: "g", order: 1 })]).id, "b1", "group and order first");
    assert.equal(VT.mateOf(a, [p("b0", { label: "Before, Slide 1" }), p("b1", { label: "Before, Slide 2" })]).id, "b1", "then the label");
    assert.equal(VT.mateOf(a, [p("only", { label: "x" })]).id, "only", "then the only picture");
    assert.equal(VT.mateOf(a, [p("b0", { label: "x" }), p("b1", { label: "y" })]), null);
  });
  it("closeUpPlan: each side's own box; a box on one side only borrows the rect on a same-sized mate, else the one crop alone; highlights join the union", async () => {
    const VT = await vt();
    const both = VT.sceneOf(doc([pic("b1", "before", 1), pic("a1", "after", 2)], [{ id: "c1", mark: "changed", boxes: [box("b1", 100, 100, 80, 40), box("a1", 120, 100, 80, 40, [{ x: 300, y: 110, w: 20, h: 10 }])] }]));
    const pl = VT.closeUpPlan(both, "c1");
    assert.equal(pl.before.pane.id, "b1"); assert.equal(pl.after.pane.id, "a1");
    assert.equal(pl.before.rects[0].x, 100); assert.equal(pl.after.rects.length, 2, "rect plus its highlight");
    const added = VT.sceneOf(doc([pic("b1", "before", 1), pic("a1", "after", 2)], [{ id: "c1", mark: "added", boxes: [box("a1", 120, 100, 80, 40)] }]));
    const pa = VT.closeUpPlan(added, "c1");
    assert.equal(pa.before.pane.id, "b1", "same width and height: the mate shows the same rect"); assert.equal(pa.before.boxed, false); assert.equal(pa.before.rects[0].x, 120);
    const resized = VT.sceneOf(doc([pic("b1", "before", 1, { width: 1200 }), pic("a1", "after", 2)], [{ id: "c1", mark: "added", boxes: [box("a1", 120, 100, 80, 40)] }]));
    assert.equal(VT.closeUpPlan(resized, "c1").before, null, "a mate of another size: the one crop alone");
    assert.equal(VT.closeUpPlan(VT.sceneOf(doc([pic("b1", "before", 1), pic("a1", "after", 2)], [{ id: "c1", mark: "changed" }])), "c1"), null, "no box, no close-up");
  });
  it("closeUp: one scale for both sides, never past one picture pixel per CSS pixel; skipped over half the picture or under 1.2x", async () => {
    const VT = await vt();
    const plan = (w: number, h: number, r: R, W = 1600, H = 900) => ({ before: null, after: { pane: { id: "a", picture: { width: W, height: H } }, rects: [r], boxed: true } });
    const cu = VT.closeUp(plan(0, 0, { x: 700, y: 400, w: 120, h: 40 }), 548, 360)!;
    assert.ok(cu, "a small box gets a close-up");
    assert.ok(cu.scale <= 1, "at most one picture pixel per CSS pixel"); assert.ok(cu.gain >= 1.2);
    assert.ok(Math.abs(cu.after.w * cu.scale - 548) < 1e-6, "the crop fills the column width");
    assert.ok(cu.after.x <= 700 && cu.after.x + cu.after.w >= 820, "the box is inside the crop");
    assert.equal(VT.closeUp(plan(0, 0, { x: 0, y: 0, w: 1300, h: 600 }), 548, 360), null, "covers more than half the picture");
    assert.equal(VT.closeUp(plan(0, 0, { x: 100, y: 100, w: 1100, h: 60 }), 548, 360), null, "a wide box gains under 1.2x");
    assert.equal(VT.closeUp(plan(0, 0, { x: 100, y: 100, w: 40, h: 20 }, 600, 400), 548, 360), null, "a 600 px picture in a 548 px column can gain at most 1.09x without going blurry");
    const two = VT.closeUp({ before: { pane: { id: "b", picture: { width: 1600, height: 900 } }, rects: [{ x: 100, y: 100, w: 300, h: 40 }], boxed: true }, after: { pane: { id: "a", picture: { width: 1600, height: 900 } }, rects: [{ x: 100, y: 100, w: 120, h: 40 }], boxed: true } }, 548, 360)!;
    assert.ok(Math.abs(two.before.w - two.after.w) < 1e-6 && Math.abs(two.before.h - two.after.h) < 1e-6, "same region size on both sides (one scale)");
  });
  it("zoomFor: never below fit-width, never past the picture's pixels, the box at about 60% of the pane", async () => {
    const VT = await vt();
    assert.equal(VT.zoomFor({ boxW: 400, boxH: 50, paneW: 500, paneH: 700, fitW: 500, picW: 1600 }), 1, "a big box stays at fit-width");
    assert.equal(VT.zoomFor({ boxW: 50, boxH: 20, paneW: 500, paneH: 700, fitW: 500, picW: 1000 }), 2, "capped at the picture's own pixels (1000/500)");
    assert.equal(VT.zoomFor({ boxW: 100, boxH: 20, paneW: 500, paneH: 700, fitW: 500, picW: 4000 }), 3);
  });
  it("stripOf: thumbnail for an image, numbered chip otherwise, a dot for a box or changed, a place for a missing picture", async () => {
    const VT = await vt();
    const e = VT.stripOf([{ id: "p1", label: "Slide 1", picture: { sha: S(1), width: 1, height: 1, page: 1 } }, { id: "p2", label: "Frame 7", changed: true }, null, { id: "p4", label: "", picture: { sha: S(1), width: 1, height: 1 } }], [{ pane: "p4", side: "after" }]);
    assert.deepEqual(e.map((x) => [x.thumb, x.text, x.dot, x.none]), [[true, "1", false, false], [false, "7", true, false], [false, "3", false, true], [true, "4", true, false]]);
    assert.equal(VT.pictureName({ label: "", picture: { page: 2, pageCount: 5 } }), "2 of 5", "N of M when there is no label, never a noun");
    assert.equal(VT.pictureName({ label: "After, Slide 2" }), "Slide 2");
  });
});

const PICS = [pic("b1", "before", 1, { page: 1 }), pic("b2", "before", 2, { page: 2 }), pic("a1", "after", 3, { page: 1 }), pic("a2", "after", 4, { page: 2 })];
const bootDoc = (d: unknown, kind = "modified") => boot((u) => (u.includes("/review/model") ? modelOf(kind) : u.includes("/view/") ? d : {}));
const stage = (p: { g: Record<string, unknown> }) => (p.g.CoCheckStage as { at(): { change: string | null; row: number } }).at();

describe("where a step opens, and the page's stage", () => {
  it("opens on the first change in list order that has a drawable box, past a first change with none", async () => {
    const p = await bootDoc(doc(PICS, [{ id: "c0", mark: "changed", label: "no box" }, { id: "c1", mark: "changed", boxes: [box("b2", 100, 100, 80, 40), box("a2", 100, 100, 80, 40)] }, { id: "c2", mark: "changed", boxes: [box("a1", 10, 10, 40, 20)] }]));
    assert.equal(stage(p).change, "c1", "c0 has no box, c1 is next in list order (c2 on an earlier page does not jump ahead)");
  });
  it("list order, not page order: a first change on page 2 wins over a later one on page 1", async () => {
    const p = await bootDoc(doc(PICS, [{ id: "c2", mark: "changed", boxes: [box("a2", 10, 10, 40, 20)] }, { id: "c1", mark: "changed", boxes: [box("a1", 10, 10, 40, 20)] }]));
    assert.equal(stage(p).change, "c2");
  });
  it("level 2 (pictures, no boxes): opens on the first picture marked changed", async () => {
    const pics = [pic("b1", "before", 1, { page: 1 }), pic("b2", "before", 2, { page: 2, changed: true }), pic("a1", "after", 3, { page: 1 }), pic("a2", "after", 4, { page: 2, changed: true })];
    const p = await bootDoc(doc(pics, [{ id: "c1", mark: "changed", label: "page 2" }], 2));
    assert.deepEqual([stage(p).change, stage(p).row], [null, 1]);
  });
  it("a created subject: one pane, labelled New and the subject's name; no empty before pane, no 'nothing here' words", async () => {
    const p = await bootDoc(doc([pic("a1", "after", 3, { page: 1 }), pic("a2", "after", 4, { page: 2 })], [{ id: "c1", mark: "added", boxes: [box("a2", 10, 10, 40, 20)] }]), "created");
    assert.match(p.byId("stage").className, /solo-after/);
    assert.equal(p.byId("lsa").textContent, "New"); assert.equal(p.byId("lna").textContent, "slides.bin"); assert.equal(p.byId("lna").hidden, false);
    assert.equal(p.byId("vb").textContent, "", "the before side draws nothing");
    assert.equal(tree2(p.byId("vb")).length, 0);
  });
  const textView = (before: unknown[], lines: unknown[]) => ({ change: "c1", file: "deck/notes.txt", engine: "e", kind: "pages", before, after: [{ id: "after:text", label: "After", text: { lines } }], boxes: [], caveats: [] });
  const addLines = [{ n: 1, text: "one", kind: "add" }, { n: 2, text: "two", kind: "add" }];
  it("a created text file is the one New pane: no Before label, no before pane, no zero-line words", async () => {
    const p = await bootDoc(textView([{ id: "before:empty", label: "There was nothing here yet" }], addLines), "created");
    assert.match(p.byId("stage").className, /solo-after/);
    assert.equal(p.byId("lsa").textContent, "New"); assert.equal(p.byId("lna").textContent, "slides.bin");
    assert.equal(p.byId("lsb").textContent, "Before");
    assert.equal(p.byId("vb").textContent, "", "nothing is drawn on the before side");
    assert.ok(!p.byId("stage").textContent.includes("No lines here before"));
  });
  it("a modified mostly-additions text file is one column labelled for both sides, with no before pane and no zero-line words", async () => {
    const p = await bootDoc(textView([], addLines));
    assert.match(p.byId("stage").className, /unified/); assert.match(p.byId("stage").className, /solo-after/);
    assert.equal(p.byId("lsa").textContent, "Before and after");
    assert.ok(!p.byId("pb").textContent.includes("No lines here before"));
    assert.ok(!p.byId("stage").textContent.includes("No lines here before"));
  });
  it("a removed subject: the before side alone, labelled Removed", async () => {
    const p = await bootDoc(doc([pic("b1", "before", 1, { page: 1 })], [{ id: "c1", mark: "removed" }]), "deleted");
    assert.match(p.byId("stage").className, /solo-before/);
    assert.equal(p.byId("lsb").textContent, "Removed"); assert.equal(p.byId("lnb").textContent, "slides.bin");
    assert.equal(p.byId("va").textContent, "");
  });
  it("a modified subject keeps both panes and the side words", async () => {
    const p = await bootDoc(doc(PICS, [{ id: "c1", mark: "changed", boxes: [box("a2", 10, 10, 40, 20)] }]));
    assert.doesNotMatch(p.byId("stage").className, /solo-/);
    assert.equal(p.byId("lsa").textContent, "After"); assert.equal(p.byId("lna").hidden, true);
  });
  it("the picture strip: an entry per picture, a dot on a picture with a box or changed, none on the others; no strip for a single picture", async () => {
    const pics = [pic("b1", "before", 1, { page: 1 }), pic("a1", "after", 3, { page: 1 }), pic("a2", "after", 4, { page: 2 }), pic("a3", "after", 5, { page: 3, changed: true })];
    const p = await bootDoc(doc(pics, [{ id: "c1", mark: "changed", boxes: [box("a2", 10, 10, 40, 20)] }]));
    const btns = tree2(p.byId("sta")).filter((n) => has(n, "pst"));
    assert.equal(p.byId("sta").hidden, false);
    assert.deepEqual(btns.map((b) => has(b, "dot")), [false, true, true], "a2 has a box, a3 is changed");
    assert.ok(btns.every((b) => tree2(b).some((c) => c.tag === "img")), "image pictures are thumbnails");
    assert.equal(p.byId("stb").hidden, true, "the before side has one picture: no strip");
  });
});

describe("stage order, ring and labels", () => {
  it("the strip rings the picture holding the current change, not the one at the top of the column", async () => {
    const pics = [pic("b1", "before", 1, { page: 1 }), pic("a1", "after", 3, { page: 1 }), pic("a2", "after", 4, { page: 2 }), pic("a3", "after", 5, { page: 3 })];
    const p = await bootDoc(doc(pics, [{ id: "c1", mark: "changed", boxes: [box("a3", 10, 10, 40, 20)] }]));
    const btns = tree2(p.byId("sta")).filter((n) => has(n, "pst"));
    assert.deepEqual(btns.map((b) => has(b, "on")), [false, false, true], "a3 holds the change");
  });
  it("goStep lays the close-up row out before it centres the box, and the row keeps one height across the step", async () => {
    const src = await readFile(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("function goStep("), src.indexOf("function stepChange("));
    assert.ok(body.indexOf("paintCloseUp(") > 0 && body.indexOf("paintCloseUp(") < body.indexOf("centreIn("), "paintCloseUp runs before centreIn");
    assert.ok(!/centreIn[\s\S]*paintCloseUp\(/.test(body), "and not again after it");
    assert.match(src, /VT\.rowHeight\(/, "the row height comes from the whole step");
  });
  it("a request row's aria-label never ends in a double period", async () => {
    const src = await readFile(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    assert.match(src, /railTip\(st\)\.replace\(\/\\\.\\s\*\$\/, ''\) \+ '\.'/);
  });
  it("view-table.js carries no literal dashes (escapes only)", async () => {
    const src = await readFile(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url), "utf8");
    assert.ok(!/[\u2013\u2014]/.test(src));
  });
});
