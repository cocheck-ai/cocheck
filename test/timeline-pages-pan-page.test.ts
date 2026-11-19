import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any */
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, FormatRow, Timeline } from "../src/timeline/timeline.ts";

// cfv-pan: the page column view of a Word or PowerPoint review (div.pscroll per side), placeholders, change stepping (N next, B back; P stays the verdict Pass),
// the fallback without view.changes, and a redraw of the same step keeping its place. Harness shapes as in the other vm page tests;
// the scroll geometry is a stub (real linked scrolling and region fractions are measured in Chrome, see the item report).

const ref = (s: string) => ({ sha256: s.repeat(64).slice(0, 64), size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const changeWith = (file: string, rows: FormatRow[], over: Record<string, unknown> = {}): Change => ({ id: "c1", file, outside: false, at: null, kind: "modified", step: 1, before: ref("a"), after: ref("b"), credit: { calls: ["k1"], joint: false, text: "x" }, note: { text: "Claude changed d.docx", source: "rule" }, format: { module: "files", rows, more: 0 }, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: "label" }, ...over }) as unknown as Change;
const timelineOf = (c: Change): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "k1", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [c], line: { text: "Edit it", source: "agent-description", label: "l" }, agent: null }] }] }] } as unknown as Timeline);


class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; listeners: Record<string, Array<(e: unknown) => void>> = {};
  parent: N | null = null; className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false;
  scrollTop = 0; scrollLeft = 0; scrollHeight = 5000; clientHeight = 500; scrollWidth = 400; clientWidth = 400; offsetHeight = 100;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  get tagName(): string { return this.tag.toUpperCase(); }
  get parentNode(): N | null { return this.parent; }
  get isConnected(): boolean { let n: N = this; while (n.parent) { if (!n.parent.children.includes(n)) return false; n = n.parent; } return true; }
  get offsetTop(): number { return this.cls("pslot") ? 100 * Number(this.attrs["data-row"]) : 0; }
  cls(c: string): boolean { return this.className.split(/\s+/).includes(c); }
  append(...c: N[]) { for (const k of c) k.parent = this; this.children.push(...c); }
  insertBefore(c: N, ref: N) { c.parent = this; this.children.splice(this.children.indexOf(ref), 0, c); }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {} select() {} scrollIntoView() {} scrollTo() {} showModal() {} close() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.cls(c) }; }
  closest(sel: string): N | null {
    if (sel === ".vw[hidden]") { for (let n: N | null = this; n; n = n.parent) if (n.cls("vw") && n.hidden) return n; return null; }
    const cls = sel.replace(/^\./, "");
    for (let n: N | null = this; n; n = n.parent) if (n.cls(cls)) return n;
    return null;
  }
  querySelector(sel: string): N | null {
    const m = /^\.bx\[data-change="(.*)"\]$/.exec(sel);
    return m ? this.descendants().find((d) => d.cls("bx") && d.attrs["data-change"] === m[1]) ?? null : null;
  }
  getBoundingClientRect() {
    if (this.cls("pscroll")) return { top: 0, bottom: 500, left: 0, right: 400, height: 500, width: 400 };
    if (this.cls("bx") && this.attrs["data-y"] !== undefined) { const sc = this.closest("pscroll"); const t = Number(this.attrs["data-y"]) - (sc ? sc.scrollTop : 0); return { top: t, bottom: t + 10, left: 0, right: 40, height: 10, width: 40 }; }
    return { top: 0, left: 0, right: 10, bottom: 4, height: 4, width: 10 };
  }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

const SHA = "a".repeat(64);
const pic = (side: string, n: number) => ({ id: `${side}:page${n}`, label: `${side} page ${n}`, picture: { sha: SHA, width: 100, height: 140, page: n } });
const gone = (side: string, n: number) => ({ id: `${side}:absent${n}`, label: `No page ${n} on this side`, absent: true });

async function page(view: Record<string, unknown>, cards: unknown[] = []) {
  const rows = cards.map((c, k) => ({ location: `row ${k}`, kind: "paragraph changed", before: "o", after: "n", text: "t", card: c })) as unknown as FormatRow[];
  const model = buildRailModel(timelineOf(changeWith("d.docx", rows)));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const posts: string[] = [];
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const mk = (t: string): N => mkNode(t);
  const document = { body, getElementById: byId, createElement: mk, createElementNS: (_: string, t: string) => mk(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const focused: string[] = [];
  const g: Record<string, any> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, innerHeight: 900, scrollY: 0, scrollBy() {}, URLSearchParams, console, navigator: {},
    getComputedStyle: (n: N) => ({ overflowY: n.cls("pscroll") ? "auto" : "visible", overflowX: "visible" }), addEventListener(k: string, f: (e: unknown) => void) { (g.__ev as Record<string, Array<(e: unknown) => void>>)[k] = [...((g.__ev as Record<string, Array<(e: unknown) => void>>)[k] ?? []), f]; }, __ev: {} as Record<string, unknown>, requestAnimationFrame: (f: () => void) => { (g.__raf as Array<() => void>).push(f); return (g.__raf as unknown[]).length; }, __raf: [] as Array<() => void>, setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (f.name === "poll" ? 0 : ms === 6000 ? 0 : setTimeout(f, 0)), clearTimeout() {},
    fetch: async (u: string, o?: { method?: string }) => {
      if (o?.method === "POST") posts.push(u);
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      if (/\/view\//.test(u)) return json(servedFor(view, model, u));
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  byId("pa").className = "pane after"; byId("va").parent = byId("pa"); byId("pb").className = "pane before"; byId("vb").parent = byId("pb"); byId("stage").parent = byId("main"); byId("pa").children.push(byId("va")); byId("pb").children.push(byId("vb"));
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const open = async () => { const row = byId("tl").children.find((r) => r.className.split(/\s+/).includes("row") && r.textContent.includes("d.docx")); assert.ok(row, "a change row"); row!.click(); await settle(); await settle(); };
  g.CoCheckFocus = { focusChange: (id: string) => { focused.push(id); }, clearFocus() {} }; // the focus layer's own entry point; stepping calls it
  await open();
  const col = (side: string) => byId(side === "before" ? "vb" : "va").descendants().find((d) => d.cls("pscroll"))!;
  /** the box drawing code draws .bx[data-change]; the harness plants them at a page row so stepping has something to find */
  const plant = (side: string, change: string, row: number, y: number) => { const sc = col(side); const pw = sc.descendants().filter((d) => d.cls("pagewrap"))[row]!; const b = mkNode(); b.className = "bx cf"; b.attrs["data-change"] = change; b.attrs["data-y"] = String(y); pw.append(b); return b; };
  const key = (k: string, target: N = mkNode()) => { let prevented = false; for (const f of (g.__ev.keydown as Array<(e: unknown) => void>) ?? []) f({ key: k, target, preventDefault() { prevented = true; }, metaKey: false, ctrlKey: false, altKey: false }); return prevented; };
  /** a full redraw of the step on show (what a live refresh does): the width crossing the flow switch rebuilds the panes */
  const redraw = async () => { g.innerWidth = 1000; for (const f of (g.__ev.resize as Array<() => void>) ?? []) f(); for (const f of g.__raf.splice(0)) f(); await settle(); await settle(); };
  return { byId, g, settle, col, plant, key, focused, posts, open, redraw };
}

describe("page columns (cfv-pan)", () => {
  const view = (extra: Record<string, unknown> = {}) => ({ change: "c1", file: "d.docx", engine: "e", kind: "pages", before: [pic("before", 1), pic("before", 2), gone("before", 3)], after: [pic("after", 1), pic("after", 2), pic("after", 3)], caveats: [], boxes: [], ...extra });

  it("each side is one div.pscroll[data-side] holding every page slot, with a placeholder for the page the side lacks and lazy images", async () => {
    const p = await page(view());
    for (const side of ["before", "after"]) {
      const sc = p.col(side);
      assert.equal(sc.attrs["data-side"], side);
      assert.equal(sc.children.length, 3);
    }
    const before = p.col("before");
    assert.match(before.children[2]!.textContent, /No page 3 on this side/);
    assert.equal(before.descendants().filter((d) => d.cls("pagewrap")).length, 2);
    assert.deepEqual(p.col("after").descendants().filter((d) => d.cls("pagewrap")).map((d) => d.attrs["data-page"]), ["1", "2", "3"]);
    assert.ok(p.col("after").descendants().filter((d) => d.tag === "img").every((d) => d.attrs.loading === "lazy" && d.attrs.width === "100" && d.attrs.height === "140"));
    assert.equal(p.byId("ta").children.length, 0, "no sheet tabs for a paged view");
  });

  it("N steps through view.changes in array order, B steps back, each step calls focusChange; the view opens on the first change without focusing", async () => {
    const p = await page(view({ changes: [{ id: "k1" }, { id: "k2" }, { id: "k3" }] }));
    p.plant("after", "k1", 0, 100); p.plant("after", "k2", 1, 1500); p.plant("after", "k3", 2, 3000);
    assert.deepEqual(p.focused, [], "opening focuses nothing");
    // the boxes are planted after the draw, so at open no change had a box to open on: the first N goes to the first change in list order
    assert.ok(p.key("n"));
    assert.deepEqual(p.focused, ["k1"]);
    assert.ok(p.key("n"));
    assert.deepEqual(p.focused, ["k1", "k2"]);
    assert.equal(p.col("after").scrollTop, 1500 + 5 - 250, "the second change's box (on a picture) is centred in the column (500 px tall)");
    p.key("n"); p.key("b"); p.key("b"); p.key("b");
    assert.deepEqual(p.focused, ["k1", "k2", "k3", "k2", "k1", "k1"], "stops at the ends");
  });

  it("P is not a step key and never reaches the stepper; typing in a field and an unrelated key do nothing", async () => {
    const p = await page(view({ changes: [{ id: "k1" }, { id: "k2" }] }));
    p.plant("after", "k1", 0, 100); p.plant("after", "k2", 1, 1500);
    p.key("p"); p.key("x");
    assert.deepEqual(p.focused, []);
    const input = mkNode("input");
    assert.equal(p.key("n", input), false);
    const ta = mkNode("textarea");
    assert.equal(p.key("n", ta), false);
    assert.deepEqual(p.focused, []);
    assert.deepEqual(p.posts.filter((u) => /verdict/.test(u)), [], "stepping records no verdict");
    p.key("n"); p.key("b");
    assert.deepEqual(p.posts.filter((u) => /verdict/.test(u)), []);
  });

  // the card path of view-v1 (one change per model card, boxed by page number or matched words) is deleted; no core row carries a card

  it("a redraw of the same step puts the columns back on the same page and fraction", async () => {
    const p = await page(view());
    for (const side of ["before", "after"]) { p.col(side).scrollTop = 250; for (const f of p.col(side).listeners.scroll ?? []) f({}); }
    const old = p.col("before");
    await p.redraw();
    assert.notEqual(p.col("before"), old, "the columns were rebuilt");
    assert.equal(p.col("before").scrollTop, 250);
    assert.equal(p.col("after").scrollTop, 250);
  });
});
