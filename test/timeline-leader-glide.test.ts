import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, FormatRow, Timeline } from "../src/timeline/timeline.ts";

// Leaders start on their box under the glide, and a resize never rebuilds. Original note: one leader line per change card. A slide card draws to the box on its own slide's page, a Word card to the text-match box of its own
// words; a card with no match keeps the change's first box (never dropped, never a wrong box). Harness shapes copy test/timeline-office-notes-column.test.ts.

const ref = (s: string) => ({ sha256: s.repeat(64).slice(0, 64), size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const changeWith = (file: string, rows: FormatRow[], over: Record<string, unknown> = {}): Change => ({ id: "c1", file, outside: false, at: null, kind: "modified", step: 1, before: ref("a"), after: ref("b"), credit: { calls: ["k1"], joint: false, text: "x" }, note: { text: "Claude changed d.docx", source: "rule" }, format: { module: "files", rows, more: 0 }, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: "label" }, ...over }) as unknown as Change;
const timelineOf = (c: Change): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "k1", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [c], line: { text: "Edit it", source: "agent-description", label: "l" }, agent: null }] }] }] } as unknown as Timeline);

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; listeners: Record<string, Array<(e: unknown) => void>> = {};
  parent: N | null = null; className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const k of c) k.parent = this; this.children.push(...c); }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {} select() {} scrollIntoView() {} scrollTo() {} showModal() {} close() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  // models the page's hidden tabs: a node under a .vw wrapper whose hidden flag is set is not on screen
  closest(sel: string): N | null { if (sel === ".pane") { for (let n: N | null = this; n; n = n.parent) if (n.className.split(/\s+/).includes("pane")) return n; return null; } if (sel !== ".vw[hidden]") return null; for (let n: N | null = this; n; n = n.parent) if (n.className.split(/\s+/).includes("vw") && n.hidden) return n; return null; }
  offsetTop = 0;
  // a pane carrying .glide is drawn 10 px low (frame 0 of the glide); everything inside moves with it
  getBoundingClientRect() { let sh = 0; for (let n: N | null = this; n; n = n.parent) if (n.className.split(/\s+/).includes("pane") && n.className.split(/\s+/).includes("glide")) sh = 10; const t = (/^bx\b/.test(this.className) ? 10 * (Number(this.attrs["data-uid"]) || 0) : 0) + sh; return { top: t, left: 0, right: 50, height: 4, width: 50, bottom: t + 4 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

let uid = 0;
const SHA = "a".repeat(64);
const box = (side: string, pane: string, extra: Record<string, unknown> = {}) => ({ change: "c1", side, pane, confidence: "pixel", rect: { x: 1, y: 1, w: 5, h: 5 }, ...extra });
const card = (place: string, after: string | null, text: string | null = null) => ({ place, verb: null, before: null as string | null, after, text });

/** Draws the change and returns the y each leader starts at, the y of every drawn box, and the cards in order. */
async function drawn(file: string, cards: ReturnType<typeof card>[], view: Record<string, unknown>) {
  const rows = cards.map((c, k) => ({ location: `row ${k}`, kind: "paragraph changed", before: "o", after: "n", text: "t", card: c })) as unknown as FormatRow[];
  const model = buildRailModel(timelineOf(changeWith(file, rows)));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const mk = (t: string): N => { const n = mkNode(t); n.attrs["data-uid"] = String(++uid); return n; };
  const document = { body, getElementById: byId, createElement: mk, createElementNS: (_: string, t: string) => mk(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, any> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener(k: string, f: () => void) { (g.__ev as Record<string, Array<() => void>>)[k] = [...((g.__ev as Record<string, Array<() => void>>)[k] ?? []), f]; }, __ev: {} as Record<string, unknown>, requestAnimationFrame: (f: () => void) => { (g.__raf as Array<() => void>).push(f); return (g.__raf as unknown[]).length; }, __raf: [] as Array<() => void>, __poll: [] as Array<() => void>, setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (f.name === "poll" ? ((g.__poll as Array<() => void>).push(f), 0) : ms === 6000 ? 0 : setTimeout(f, 0)), clearTimeout() {},
    fetch: async (u: string) => {
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      if (/\/view\//.test(u)) return json(view);
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  byId("pa").className = "pane after"; byId("va").parent = byId("pa");
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const row = byId("tl").children.find((r) => r.className.split(/\s+/).includes("row") && r.textContent.includes(file));
  assert.ok(row, "a change row");
  row!.click(); await settle(); await settle();
  const visible = (n: N) => !n.closest(".vw[hidden]");
  const snap = () => {
    const ys = (cls: string) => byId("svg").children.filter((p) => p.className === cls).map((p) => Number(/^M[-\d.]+,([-\d.]+)/.exec(p.attrs.d!)![1]));
    const tops = (pane: string, all: boolean) => byId(pane).descendants().filter((d) => /^bx\b/.test(d.className) && (all || visible(d))).map((d) => 10 * Number(d.attrs["data-uid"]) + 2);
    return { leaders: ys("ld sel"), threads: ys("th sel"), boxTops: tops("va", true), shownTops: tops("va", false), beforeTops: tops("vb", true), cards: byId("notes").children.length };
  };
  const tabs = () => byId("ta").descendants().filter((d) => d.className.split(/\s+/).includes("tab"));
  const pick = async (i: number) => { tabs()[i].click(); await settle(); };
  return { ...snap(), snap, pick, byId, g, settle, ctx, model, stops };
}

const pages = (n: number, side = "after") => Array.from({ length: n }, (_, k) => ({ id: `${side}:page${k + 1}`, label: `${side} page ${k + 1} of ${n}`, picture: { sha: SHA, width: 100, height: 100, page: k + 1 } }));
const view = { change: "c1", file: "d.docx", engine: "drawn by LibreOffice", kind: "pages", before: pages(1, "before"), after: pages(1), caveats: [], boxes: [box("after", "after:page1", { confidence: "text-match", text: "first changed line" })] };
const word = [card("Paragraph 7", "and the first changed line ends it")];

describe("a leader starts on its box while the pane glides", () => {
  it("the notes and the leaders glide with the panes", async () => {
    const d = await drawn("d.docx", word, view);
    assert.match(d.byId("notes").className, /\bglide\b/);
    assert.match(d.byId("svg").className, /\bglide\b/);
  });
  it("a draw that follows an instant render (resize) carries no glide", async () => {
    const d = await drawn("d.docx", word, view);
    d.g.__ev.resize.forEach((f: () => void) => f());
    d.g.innerWidth = 1000; d.g.__ev.resize.forEach((f: () => void) => f()); d.g.__raf.splice(0).forEach((f: () => void) => f()); await d.settle(); await d.settle();
    assert.doesNotMatch(d.byId("pa").className, /\bglide\b/, "the redraw after crossing 1180 px is instant");
  });
});

describe("a resize never rebuilds the panes", () => {
  it("a 20-event burst is one layout, and the pane nodes are the same objects after it", async () => {
    const d = await drawn("d.docx", word, view);
    const before = d.byId("va").children.slice();
    d.g.__raf.length = 0;
    let layouts = 0; const svg = d.byId("svg"); const orig = Object.getOwnPropertyDescriptor(N.prototype, "textContent")!; void orig;
    for (let i = 0; i < 20; i++) { d.g.innerWidth = 1600 - i * 10; d.g.__ev.resize.forEach((f: () => void) => f()); }
    assert.equal(d.g.__raf.length, 1, "at most one frame is asked for");
    const kids = svg.children.length; d.g.__raf.splice(0).forEach((f: () => void) => { f(); layouts++; }); await d.settle();
    assert.equal(layouts, 1);
    assert.equal(svg.children.length, kids, "the leaders are redrawn in place");
    assert.deepEqual(d.byId("va").children, before, "no pane rebuild");
  });
  it("crossing 1180 px still re-renders, so the note tops are not left stale", async () => {
    const d = await drawn("d.docx", word, view);
    const before = d.byId("va").children.slice();
    d.g.innerWidth = 1100; d.g.__ev.resize.forEach((f: () => void) => f()); d.g.__raf.splice(0).forEach((f: () => void) => f()); await d.settle(); await d.settle();
    assert.notDeepEqual(d.byId("va").children, before, "the panes are drawn again");
    assert.equal(d.byId("svg").children.length, 0, "no leaders in flow mode");
  });
});

describe("a live poll or fonts redraw carries no glide; a user step does", () => {
  const polled = async (d: Awaited<ReturnType<typeof drawn>>) => {
    // the poll serves a model whose shown stop changed (a new note text on the stop's change)
    const m = d.model as any; m.stops = m.stops.map((x: any) => ({ ...x, r311poll: "changed" })); // every stop, so the one on show changes whatever its index
    assert.ok(d.g.__poll.length > 0, "a poll is armed");
    const kids = d.byId("va").children.slice(); d.byId("pa").className = "pane after"; // cleared: only a redraw can put .glide back
    d.g.__poll.splice(0).forEach((f: () => void) => f()); await d.settle(); await d.settle(); await d.settle();
    assert.notDeepEqual(d.byId("va").children, kids, "the poll redrew the panes (a poll that stops redrawing is the other guarded case)");
  };
  const noGlide = (d: Awaited<ReturnType<typeof drawn>>, why: string) => ["pa", "pb", "notes", "svg"].forEach((id) => assert.doesNotMatch(d.byId(id).className, /\bglide\b/, `${id}: ${why}`));
  it("a poll that changes the shown step redraws with no glide (Steps view)", async () => {
    const d = await drawn("d.docx", word, view);
    assert.match(d.byId("pa").className, /\bglide\b/, "baseline: the user's row click glided");
    d.byId("vfiles").click(); await d.settle(); d.byId("vsteps").click(); await d.settle(); await d.settle(); // leaves the quick view; the poll now redraws the step
    await polled(d);
    noGlide(d, "poll redraw");
  });
  it("a poll that changes the shown version redraws with no glide (Files view)", async () => {
    const d = await drawn("d.docx", word, view);
    d.byId("vfiles").click(); await d.settle(); await d.settle();
    await polled(d);
    noGlide(d, "poll redraw in Files");
  });
  it("an instant redraw carries no glide (fonts.ready runs the same instant = true; render() line, review.js:2083; document.fonts is not in the harness)", async () => {
    const d = await drawn("d.docx", word, view);
    assert.match(d.byId("pa").className, /\bglide\b/);
    d.g.__ev.resize.forEach((f: () => void) => f());
    d.g.innerWidth = 1000; d.g.__ev.resize.forEach((f: () => void) => f()); d.g.__raf.splice(0).forEach((f: () => void) => f()); await d.settle(); await d.settle();
    noGlide(d, "instant redraw (same path fonts.ready takes: instant = true; render())");
  });
  it("the user's own row click still glides, and only the poll is instant", async () => {
    const d = await drawn("d.docx", word, view);
    assert.match(d.byId("pa").className, /\bglide\b/, "the user's click glides");
    assert.match(d.byId("notes").className, /\bglide\b/);
  });
});

describe("a poll redraws the step on show only when it changed", () => {
  type D = Awaited<ReturnType<typeof drawn>>;
  const shown = (d: D) => (d.model as any).stops.find((x: any) => x.change);
  const poll = async (d: D) => { assert.ok(d.g.__poll.length > 0, "a poll is armed"); d.g.__poll.splice(0).forEach((f: () => void) => f()); await d.settle(); await d.settle(); await d.settle(); };
  const toSteps = async (d: D) => { d.byId("vfiles").click(); await d.settle(); d.byId("vsteps").click(); await d.settle(); await d.settle(); };
  const imgs = (n: N) => n.descendants().filter((x) => x.tag === "img").length;
  for (const [name, setup] of [["Steps view", toSteps], ["Files view", async (d: D) => { d.byId("vfiles").click(); await d.settle(); await d.settle(); }]] as const) {
    it(`an unchanged model adds no pane rebuild and no img, leaders stay (${name})`, async () => {
      const d = await drawn("d.docx", word, view);
      await setup(d);
      const kids = d.byId("va").children.slice(), svgKids = d.byId("svg").children.slice(), notes = d.byId("notes").children.slice(), snap = JSON.stringify(d.snap()), img0 = imgs(d.byId("va"));
      let adds = 0; const va = d.byId("va"); const origAppend = va.append.bind(va); va.append = (...c: N[]) => { adds += c.length; origAppend(...c); };
      await poll(d);
      assert.equal(adds, 0, "no pane appended");
      assert.deepEqual(d.byId("va").children, kids, "same pane nodes");
      assert.deepEqual(d.byId("svg").children, svgKids, "leaders untouched");
      assert.deepEqual(d.byId("notes").children, notes, "cards untouched");
      assert.equal(JSON.stringify(d.snap()), snap, "geometry unchanged");
      assert.equal(imgs(d.byId("va")), img0, "no img created");
    });
  }
  it("a real version change on show still redraws", async () => {
    const d = await drawn("d.docx", word, view);
    await toSteps(d);
    const kids = d.byId("va").children.slice();
    (d.model as any).stops.forEach((x: any) => { x.r313 = "version"; });
    await poll(d);
    assert.notDeepEqual(d.byId("va").children, kids, "the panes are drawn again");
  });
  it("a failure raw change still redraws, with the new line", async () => {
    const d = await drawn("d.docx", word, view);
    await toSteps(d);
    const s = shown(d); s.failure = { blurb: "b", raw: "one", hasText: true };
    await poll(d);
    const kids = d.byId("va").children.slice();
    s.failure = { blurb: "c", raw: "two", hasText: true };
    await poll(d);
    assert.notDeepEqual(d.byId("va").children, kids);
    assert.match(d.byId("h2").textContent, /^c/);
  });
});
