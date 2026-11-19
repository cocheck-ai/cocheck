import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any */
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);

// Change-first focus layer. Guarded cases covered by name below:
// (1) a change that loses its box and comment silently, (3) a comment showing words the page scrubs (secret / expired files through `full`), (5) the Point region tool.
// The vm harness copies the fake DOM of test/timeline-rail-regions-page.test.ts, extended with parentNode-aware queries, classList and layout rects.

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, any> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; value = ""; focused = false; nodeType = 1; rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  removeChild(c: N) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  insertBefore(c: N, ref: N | null) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  get nextSibling(): N | null { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] ?? null; }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { if (!s.className.split(/\s+/).includes(c)) s.className = (s.className + " " + c).trim(); }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x && x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(sel: string): N | null {
    for (let n: N | null = this; n; n = n.parentNode) {
      if (sel === ".vw[hidden]" && n.hidden && n.className.split(/\s+/).includes("vw")) return n;
      if (sel === ".pane" && n.className.split(/\s+/).includes("pane")) return n;
    }
    return null;
  }
  getBoundingClientRect() { return this.rect; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  has(c: string) { return this.className.split(/\s+/).includes(c); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

const SHA = "a".repeat(64);
const LONG = "Revenue was reported as " + "very detailed ".repeat(40) + "and nothing else.";
const pane = (side: string, extra: Record<string, unknown> = {}) => ({ id: `${side}:page1`, label: `${side} page 1`, picture: { sha: SHA, width: 1000, height: 1400, page: 1 }, ...extra });
const cardK1 = { place: "", verb: null, before: "Revenue was 3 percent", after: "Revenue was 4 percent", text: null, loc: "paragraph 1", full: { before: LONG.replace("reported", "old"), after: LONG } };
const cardK3 = { place: "Slide 2, Title 1", verb: "Added", before: null, after: "New title words", text: null, loc: "Slide 2 / Title 1", full: { before: null, after: "New title words in full" } };
const chg = (id: string, loc: string | null, boxes: unknown[], extra: Record<string, unknown> = {}) => ({ id, loc, kind: "paragraph", parent: null, boxes, ...extra });
const rect = (x: number, y: number, w = 300, h = 60) => ({ x, y, w, h });
const bb = (side: string, r: unknown, extra: Record<string, unknown> = {}) => ({ side, pane: `${side}:page1`, rect: r, ...extra });

interface Opts { cards?: unknown[]; rowNotes?: unknown[]; view?: Record<string, unknown> }
async function boot(changes: unknown[] | undefined, opts: Opts = {}) {
  const view = { change: "k1", file: "d.docx", engine: "LibreOffice", kind: "pages", before: [pane("before")], after: [pane("after")], boxes: [], caveats: [], ...(changes ? { changes } : {}), ...(opts.view ?? {}) };
  const stop = { id: "chg-k1", label: "d.docx", lane: "main", head: "Claude changed d.docx", change: { key: "k1", file: "d.docx", kind: "modified", note: "Changed d.docx.", rowNotes: opts.rowNotes ?? [], moreNote: null, viewUrl: "/timeline/7/view/k1", secret: false, secretLine: null, failed: null, ask: null, newFile: null, treeBefore: null, treeAfter: null, ...(opts.cards ? { cards: opts.cards } : {}) } };
  const files = [{ file: "d.docx", name: "d.docx", versions: [{ change: "k1", stop: "chg-k1", sha: "", lane: "main", chip: "C", at: null, label: "Changed", kind: "modified", kept: true }] }];
  const model = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops: [stop], files };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  for (const id of ["ncomp", "pcomp", "sbout", "toast"]) byId(id).hidden = true;
  const holder = mkNode(); holder.append(byId("stage"));
  byId("pb").className = "pane before"; byId("pa").className = "pane after";
  byId("stage").append(byId("pb"), byId("pa")); byId("pb").append(byId("tb"), byId("trb"), byId("vb")); byId("pa").append(byId("ta"), byId("tra"), byId("va"));
  const calls: Array<{ url: string; body: any }> = []; const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const all = (sel: string): N[] => { if (sel === ".bx.cf") return [...nodes.values(), body, holder].flatMap((n) => n.descendants()).filter((n, i, a) => n.has("bx") && n.has("cf") && a.indexOf(n) === i); return []; };
  const document: any = { body, activeElement: null, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: (sel: string) => { const m = /^\.bx\.cf\[data-change="([^"]+)"\]$/.exec(sel); return m ? all(".bx.cf").filter((n) => n.attrs["data-change"] === m[1]) : []; } };
  const answer = (j: unknown, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(j)) });
  const fetchStub = async (u: string, o?: { method?: string; body?: string }) => {
    const b = o?.body ? JSON.parse(o.body) : null;
    calls.push({ url: u, body: b });
    if (u.includes("/review/region")) return answer({ id: 1, where: "page 1", picture: true });
    const json = u.includes("/review/status") ? { stops: {}, passes: null } : u.includes("/review/model") ? model : u.includes("/view/") ? servedFor(view, model, u) : {};
    return answer(json);
  };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, setInterval, clearInterval, setTimeout, clearTimeout, fetch: fetchStub,
    addEventListener: (k: string, f: (e: unknown) => void) => { (listeners[k] ??= []).push(f); } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 25));
  await settle();
  byId("vsteps").click(); await settle(); await settle();
  const bxs = () => all(".bx.cf");
  const side = (id: string, s: string) => bxs().filter((n) => n.attrs["data-change"] === id && n.attrs["data-side"] === s);
  // layout for the fake: panes 0..200 and 250..450 wide, 500 tall; before boxes sit at x 10..60, after boxes at x 300..350
  const lay = () => {
    byId("pb").rect = { left: 0, top: 0, right: 200, bottom: 500, width: 200, height: 500 }; byId("pa").rect = { left: 250, top: 0, right: 450, bottom: 500, width: 200, height: 500 };
    byId("stage").rect = { left: 0, top: 0, right: 450, bottom: 500, width: 450, height: 500 };
    for (const id of ["pb", "pa"]) byId(id).descendants().filter((n) => n.has("pscroll")).forEach((n) => { n.rect = byId(id).rect; }); // cfv-pan: a paged view clips to its page column
    bxs().forEach((n, i) => { const l = n.attrs["data-side"] === "before" ? 10 : 300; n.rect = { left: l, top: 20 + 100 * i, right: l + 50, bottom: 40 + 100 * i, width: 50, height: 20 }; });
  };
  const enter = (n: N) => (n.listeners.mouseenter ?? []).forEach((f) => f({}));
  const leave = (n: N) => (n.listeners.mouseleave ?? []).forEach((f) => f({}));
  const comments = () => [...byId("pb").descendants(), ...byId("pa").descendants()].filter((n) => n.has("cm"));
  const pagewrap = (s: "before" | "after") => byId(s === "before" ? "vb" : "va").descendants().find((n) => n.has("pagewrap"))!;
  const lineD = () => byId("stage").descendants().filter((n) => n.tag === "path" && n.has("cf-ln")).map((n) => n.attrs.d!);
  const down = (target: N, x: number, y: number) => byId("stage").listeners.mousedown?.forEach((f) => f({ target, clientX: x, clientY: y, button: 0, preventDefault() {} }));
  const up = async (target: N, x: number, y: number) => { (listeners.mouseup ?? []).forEach((f) => f({ target, clientX: x, clientY: y, button: 0 })); await settle(); };
  return { byId, bxs, side, lay, enter, leave, comments, pagewrap, lineD, calls, settle, down, up, listeners, g, document, stage: byId("stage"), holder, view, regionPosts: () => calls.filter((c) => c.url.includes("/review/region")).map((c) => c.body) };
}

/** The Details panel's notes for changes the page could not show (fix/notes-panel: was the words list under the panes), and that no list is drawn in the page flow. */
const wordsOf = (p: { g: Record<string, unknown>; holder: N }): Array<{ text: string; change: string }> => {
  assert.equal(p.holder.children.filter((n) => n.has("cfwords")).length, 0, "no words list in the page flow");
  return [...(p.g.CoCheckDetails as { entries(): Array<{ kind: string; text: string; change: string }> }).entries()].filter((e) => e.kind === "unplaced");
};
const wordsText = (p: { g: Record<string, unknown>; holder: N }): string => wordsOf(p).map((e) => e.text).join("\n");

const twoSided = [
  chg("k1", "paragraph 1", [bb("before", rect(100, 200), { highlights: [{ x: 120, y: 200, w: 50, h: 20 }] }), bb("after", rect(100, 220))]),
  chg("k2", "Slide 2 / Title 1", [bb("after", rect(100, 600))]),
];

describe("change-first boxes", () => {
  it("draws one box per change per side, padded 0.7% of the image width at the sides and a quarter of that above and below, with data-change and data-side, and no group outlines or leaders", async () => {
    const p = await boot(twoSided, { cards: [cardK1, cardK3] });
    assert.equal(p.bxs().length, 3);
    const b = p.side("k1", "before")[0]!;
    assert.equal(b.attrs["data-change"], "k1"); assert.equal(b.attrs["data-side"], "before"); assert.equal(b.attrs.tabindex, "0");
    assert.equal(b.parentNode, p.pagewrap("before"), "inside the page it marks, so it scrolls with it");
    // x 100 on a 1000 px wide picture: pad 7 px; y 200 on 1400: a quarter of that, top (200-1.75)/1400
    assert.equal(Number.parseFloat(b.style.left).toFixed(3), "9.300"); assert.equal(Number.parseFloat(b.style.width).toFixed(3), "31.400");
    assert.equal(Number.parseFloat(b.style.top).toFixed(3), (100 * 198.25 / 1400).toFixed(3));
    assert.equal(p.pagewrap("before").children.filter((n) => n.has("hl")).length, 1, "the changed words are highlighted");
    const leaders = p.byId("svg").children.filter((n) => /\b(ld|grp|dot)\b/.test(n.className));
    assert.equal(leaders.length, 0, "no leader lines, dots or group outlines when changes are present");
    assert.equal(p.byId("notes").children.length, 0, "no side comment cards");
    assert.ok(p.stage.has("nonotes"));
  });
  it("the old line boxes of view.boxes are not drawn when changes are present", async () => {
    const p = await boot(twoSided, { cards: [cardK1], view: { boxes: [{ change: "k1", side: "after", pane: "after:page1", confidence: "text-match", text: "x", rect: rect(1, 1) }] } });
    const old = p.byId("va").descendants().filter((n) => n.has("bx") && !n.has("cf"));
    assert.equal(old.length, 0);
  });
});

describe("focus (hover or keyboard)", () => {
  it("hovering a box shows one callout on that box with the changed words marked, focuses its partner, adds no frost, and the line; leaving clears", async () => {
    const p = await boot(twoSided, { cards: [cardK1, cardK3] }); p.lay();
    p.enter(p.side("k1", "before")[0]!);
    const cms = p.comments();
    assert.equal(cms.length, 1, "one callout");
    assert.equal(cms[0]!.attrs["data-side"], "before"); assert.equal(cms[0]!.parentNode, p.side("k1", "before")[0]!.parentNode, "attached to the hovered box's page");
    const kids = cms[0]!.descendants();
    assert.deepEqual(kids.filter((n) => n.tag === "del").map((n) => n.textContent), ["old"], "the removed word struck");
    assert.deepEqual(kids.filter((n) => n.tag === "ins").map((n) => n.textContent), ["reported"], "the added word marked");
    assert.equal(kids.filter((n) => n.has("gap")).length, 1, "the long unchanged run elided");
    assert.ok(cms[0]!.textContent.length < 120, `short: ${cms[0]!.textContent}`);
    assert.ok(cms.every((c) => c.has("hv")));
    assert.ok(p.side("k1", "before")[0]!.has("hv") && p.side("k1", "after")[0]!.has("hv"), "the hovered box and its partner on the other side are focused");
    assert.ok(!p.side("k2", "after")[0]!.has("hv"), "other changes are not (the CSS dims them to 40%)");
    assert.ok(p.stage.has("cfon"));
    assert.equal([...p.byId("pb").descendants(), ...p.byId("pa").descendants()].filter((n) => n.has("cf-frost")).length, 0, "no frost layer");
    const d = p.lineD(); assert.equal(d.length, 1);
    assert.match(d[0]!, /^M60,30 L225,30 L225,\d+ L300,\d+$/, "from the before box's right edge to the after box's left edge, through the gutter");
    p.leave(p.side("k1", "before")[0]!);
    assert.equal(p.comments().length, 0); assert.ok(!p.stage.has("cfon")); assert.ok(!p.side("k1", "before")[0]!.has("hv")); assert.equal(p.lineD().length, 0);
  });
  it("a card with words and a text shows the text as its own extra line (renumbering)", async () => {
    const c = { ...cardK1, text: " Items below renumbered 2 to 1, 3 to 2" };
    const p = await boot(twoSided, { cards: [c] }); p.lay();
    p.enter(p.side("k1", "after")[0]!);
    const extra = p.comments()[0]!.children.filter((n) => n.has("cl"));
    assert.equal(extra.length, 1); assert.equal(extra[0]!.textContent, "Items below renumbered 2 to 1, 3 to 2");
  });
  it("a one-sided change shows its comment on its side only, and draws no line", async () => {
    const p = await boot(twoSided, { cards: [cardK1, cardK3] }); p.lay();
    p.enter(p.side("k2", "after")[0]!);
    assert.deepEqual(p.comments().map((c) => c.attrs["data-side"]), ["after"]);
    assert.match(p.comments()[0]!.textContent, /New title words in full/);
    assert.equal(p.lineD().length, 0);
  });
  it("guarded case: a change with no box on a side draws no leader thread, however it is hovered", async () => {
    const one = [chg("k1", "paragraph 1", [bb("before", rect(100, 200))], { unplaced: { after: "not marked" } }), chg("k2", "Slide 2 / Title 1", [bb("after", rect(100, 600))], { unplaced: { before: "not marked" } })];
    const p = await boot(one, { cards: [cardK1, cardK3] }); p.lay();
    p.enter(p.side("k1", "before")[0]!);
    assert.equal(p.comments().length, 1); assert.equal(p.lineD().length, 0, "no after box, no thread from the before box");
    p.leave(p.side("k1", "before")[0]!);
    p.enter(p.side("k2", "after")[0]!);
    assert.equal(p.lineD().length, 0, "no before box, no thread from the after box");
    p.leave(p.side("k2", "after")[0]!);
    assert.equal(p.lineD().length, 0);
  });
  it("guarded case: a card with no before side (an Added card) leads to no before box and draws no thread; a change with no box at all has nothing to hover and is a note in the Details panel", async () => {
    const none = [chg("k1", "paragraph 1", [bb("before", rect(100, 200)), bb("after", rect(100, 220))]), chg("k3", "Slide 2 / Title 1", [], { unplaced: { after: "not marked" } })];
    const p = await boot(none, { cards: [cardK1, cardK3] }); p.lay();
    assert.equal(p.side("k3", "before").length + p.side("k3", "after").length, 0, "a change with no box draws none");
    assert.ok(/^unplaced after: not marked \| /.test(wordsText(p)), "logged once, verbatim");
    p.enter(p.side("k1", "after")[0]!);
    assert.equal(p.lineD().length, 1, "positive control: a change with a box on both sides does draw its one thread");
    p.leave(p.side("k1", "after")[0]!);
    assert.equal(p.lineD().length, 0);
  });
  it("keyboard focus mirrors the pointer, and a focused box keeps its change shown when the pointer leaves", async () => {
    const p = await boot(twoSided, { cards: [cardK1] }); p.lay();
    const b = p.side("k1", "after")[0]!;
    (b.listeners.focus ?? []).forEach((f) => f({}));
    assert.deepEqual(p.comments().map((c) => c.attrs["data-side"]), ["after"], "on the focused box");
    p.document.activeElement = b; p.leave(b);
    assert.equal(p.comments().length, 1, "still focused");
    (b.listeners.blur ?? []).forEach((f) => f({}));
    assert.equal(p.comments().length, 0);
  });
  it("focusChange(id) is the same state as hovering, clearFocus() puts it away, and an unknown id does nothing", async () => {
    const p = await boot(twoSided, { cards: [cardK1] }); p.lay();
    const F = (p.g.window as any).CoCheckFocus;
    F.focusChange("k1");
    assert.deepEqual(p.comments().map((c) => c.attrs["data-side"]), ["after"], "stepping puts the callout on the After box first"); assert.ok(p.side("k1", "after")[0]!.has("hv"));
    F.clearFocus();
    assert.equal(p.comments().length, 0); assert.ok(!p.side("k1", "after")[0]!.has("hv")); assert.ok(!p.stage.has("cfon"));
    F.focusChange("nope"); assert.equal(p.comments().length, 0);
  });
  it("an edited place's callout marks the old words struck and the new ones inside the sentence, with no Edited: or Changed: prefix", async () => {
    const p = await boot(twoSided, { cards: [cardK1] }); p.lay();
    p.enter(p.side("k1", "after")[0]!);
    const cms = p.comments(); assert.equal(cms.length, 1);
    assert.match(cms[0]!.textContent, /^Revenue was old reported as very detailed/);
    assert.doesNotMatch(cms[0]!.textContent, /Edited: |Changed: /);
  });
  it("a change with no before or after words shows its text, else its label, only", async () => {
    const ch = [chg("k1", "shape 4", [bb("after", rect(10, 10))]), chg("k2", "shape 5", [bb("after", rect(10, 100))])];
    const shape5 = { place: "Shape 5", verb: null, before: null, after: null, text: null, loc: "shape 5", full: { before: null, after: null } };
    const p = await boot(ch, { cards: [shape5], rowNotes: [{ location: "shape 4", text: "Moved 12 px right" }] }); p.lay();
    const text = (id: string) => { p.enter(p.side(id, "after")[0]!); const t = p.comments().map((c) => c.textContent).join("|"); p.leave(p.side(id, "after")[0]!); return t; };
    assert.equal(text("k1"), "Moved 12 px right"); assert.equal(text("k2"), "Shape 5");
  });
  it("outside words go in as text, never markup", async () => {
    const ch = [chg("k1", "paragraph 1", [bb("after", rect(10, 10))])];
    const p = await boot(ch, { cards: [{ ...cardK1, full: { before: "a <b>x</b>", after: "a <img src=y onerror=z>" } }] }); p.lay();
    p.enter(p.side("k1", "after")[0]!);
    const cm = p.comments()[0]!;
    assert.ok(cm.descendants().every((n) => ["span", "del", "ins", "#text", "div"].includes(n.tag)), cm.descendants().map((n) => n.tag).join(","));
    assert.match(cm.textContent, /<img src=y onerror=z>/);
  });
  it("boxes draw in when a step is arrived at, and not on a redraw of the same step", async () => {
    const p = await boot(twoSided, { cards: [cardK1] });
    assert.ok(p.bxs().length === 3 && p.bxs().every((b) => b.has("cf-in")), "arriving draws in");
    const first = p.bxs()[0];
    (p.g as any).requestAnimationFrame = (f: () => void) => f(); (p.g as any).innerWidth = 1000; (p.listeners.resize ?? []).forEach((f) => f({})); await p.settle(); await p.settle(); await p.settle();
    assert.notEqual(p.bxs()[0], first, "redrawn (crossing 1180 px redraws the step)");
    assert.ok(p.bxs().every((b) => !b.has("cf-in")), "the same step drawn again does not draw in");
  });
  it("the line is hidden while one end's box is scrolled out of its pane", async () => {
    const p = await boot(twoSided, { cards: [cardK1] }); p.lay();
    p.enter(p.side("k1", "before")[0]!);
    assert.equal(p.lineD().length, 1);
    const a = p.side("k1", "after")[0]!; a.rect = { ...a.rect, top: 900, bottom: 920 };
    (p.g.window as any).CoCheckFocus.focusChange("k1");
    assert.equal(p.lineD().length, 0);
  });
  it("comment text comes from the card with the change's loc, else the row note, else the label, else Changed (never from the View)", async () => {
    const ch = [chg("k1", "Summary!B3", [bb("after", rect(10, 10))]), chg("k2", null, [bb("after", rect(10, 100))], { label: "Something changed on page 1", lines: ["Items below renumbered 2 to 1"] }), chg("k3", "paragraph 9", [bb("after", rect(10, 200))], { label: "VIEW TEXT SECRET" }), chg("k4", "paragraph 8", [bb("after", rect(10, 300))])];
    const p = await boot(ch, { cards: [cardK1], rowNotes: [{ location: "Summary!B3", text: "B3 changed from 1 to 2" }, { location: "paragraph 9", text: "from the row note" }] }); p.lay();
    const text = (id: string) => { p.enter(p.side(id, "after")[0]!); const t = p.comments().map((c) => c.textContent).join("|"); p.leave(p.side(id, "after")[0]!); return t; };
    assert.match(text("k1"), /B3 changed from 1 to 2/);
    assert.match(text("k2"), /Something changed on page 1/); assert.doesNotMatch(text("k2"), /Items below renumbered/, "a change with no words shows its text or label only");
    assert.match(text("k3"), /from the row note/); assert.doesNotMatch(text("k3"), /VIEW TEXT SECRET/, "a row note beats the label");
    assert.match(text("k4"), /Changed/);
  });
});

describe("words list wording and sides (now Details notes, fix/notes-panel)", () => {
  it("a reason is logged verbatim with its side; the hover comment carries no such words", async () => {
    const p = await boot([chg("k1", "paragraph 1", [bb("before", rect(100, 200))], { unplaced: { after: "not marked" } })], { cards: [cardK1] });
    const w = wordsText(p);
    assert.match(w, /^unplaced after: not marked \| /);
    const cm = (p.enter(p.side("k1", "before")[0]!), p.comments()[0]!);
    assert.doesNotMatch(cm.textContent, /not marked|unplaced/i);
  });
  it("a child whose parent has a box on a side is covered there and not listed; unplaced on the other side still is", async () => {
    const ch = [chg("k1", "paragraph 1", [bb("before", rect(100, 200)), bb("after", rect(100, 200))]),
      chg("k2", "paragraph 2", [], { parent: "k1", unplaced: { after: "not marked" } }),
      chg("k3", "paragraph 3", [], { parent: "k1", unplaced: { before: "not marked", after: "not marked" } }),
      chg("k4", "paragraph 4", [bb("before", rect(1, 1))], { unplaced: { after: "not marked" } })];
    const p = await boot(ch, { cards: [cardK1, cardK3] });
    assert.deepEqual(wordsOf(p).map((e) => e.change), ["k4"], "only k4 after");
  });
});

describe("words list (no change loses its box and its comment silently)", () => {
  it("states every unplaced change once, with the comment and the reason, as Details notes", async () => {
    const ch = [chg("k1", "paragraph 1", [bb("before", rect(100, 200))], { unplaced: { after: "not marked" } }), chg("k2", "Slide 2 / Title 1", [], { unplaced: { before: "the whole slide changed colour", after: "the whole slide changed colour" } }), chg("k3", "paragraph 1", [bb("after", rect(1, 1))])];
    const p = await boot(ch, { cards: [cardK1, cardK3] });
    const w = wordsText(p);
    assert.deepEqual(wordsOf(p).map((e) => e.change), ["k1", "k2", "k2"], "k1 after, k2 before, k2 after");
    assert.match(w, /unplaced after: not marked \| .*Revenue was reported as/);
    assert.match(w, /unplaced before: the whole slide changed colour \| .*Added: New title words/);
    assert.doesNotMatch(w, /k3/);
  });
  it("a change with no box at all and no reason still says it is not marked; a box the page cannot mount (unknown pane) is listed too", async () => {
    const ch = [chg("k1", "paragraph 1", []), chg("k2", "Slide 2 / Title 1", [{ side: "after", pane: "after:nowhere", rect: rect(1, 1) }])];
    const p = await boot(ch, { cards: [cardK1, cardK3] });
    assert.equal(wordsOf(p).length, 2);
    assert.match(wordsText(p), /unplaced \w+: not marked/);
  });
  // the card path of view-v1 (one change per model card, boxed by page number or matched words) is deleted; no core row carries a card
  it("a redraw leaves no stale note or callout", async () => {
    const p = await boot([chg("k1", "paragraph 1", [bb("before", rect(1, 1))], { unplaced: { after: "not marked" } })], { cards: [cardK1] }); p.lay();
    p.enter(p.side("k1", "before")[0]!);
    assert.equal(p.comments().length, 1);
    p.byId("vsteps").click(); await p.settle();
    // a view of the same step drawn again (live refresh): layout() is the start of every drawing
    (p.g.window as any).CoCheckFocus.clearFocus();
    assert.equal(p.comments().length, 0);
    assert.equal(wordsOf(p).length, 1, "one note, never two");
  });
});

describe("Clean view and the Point tool (guarded case 5)", () => {
  it("Clean view hides the boxes, callout and line; going clean clears a focus", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    const rule = /body\.clean \.cm,[^{]*\{display:none\}/.exec(css)![0];
    for (const sel of [".cm", ".hl", "svg.cf-line"]) assert.ok(rule.includes(`body.clean ${sel}`), sel);
    assert.match(css, /body\.clean \.notes,body\.clean \.leaders,body\.clean \.bx\{display:none\}/, "the boxes (.bx.cf too) hide with today's rule");
    const p = await boot(twoSided, { cards: [cardK1] }); p.lay();
    p.enter(p.side("k1", "before")[0]!);
    assert.equal(p.comments().length, 1);
    p.byId("cleanbtn").click(); await p.settle(); await p.settle(); await p.settle();
    assert.equal(p.comments().length, 0, "no comment survives going clean");
    assert.ok(!p.stage.has("cfon"));
  });
  it("while the Point tool is on a box and its comment take no pointer, nothing stays focused, and a drag over a box still posts the fractions of the page", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /body\.regon \.bx\.cf,body\.regon \.cm\{pointer-events:none\}/);
    const p = await boot(twoSided, { cards: [cardK1] }); p.lay();
    p.enter(p.side("k1", "before")[0]!);
    assert.equal(p.comments().length, 1);
    p.byId("pbfail").click(); await p.settle();
    assert.equal(p.comments().length, 0, "opening the composer (the Point tool) clears the focus");
    const w = p.pagewrap("before"); w.rect = { left: 100, top: 50, width: 400, height: 500, right: 500, bottom: 550 };
    const onBox = p.side("k1", "before")[0]!;
    p.down(onBox, 200, 100); (p.listeners.mousemove ?? []).forEach((f) => f({ target: onBox, clientX: 300, clientY: 300 })); await p.up(onBox, 300, 300);
    const posts = p.regionPosts();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].rect.map((v: number) => Math.round(v * 1000) / 1000), [0.25, 0.1, 0.25, 0.4]);
    assert.equal(posts[0].side, "before");
  });
});

// "the model card carries loc and the unclipped words" went with core's Word and deck cards (notes.ts cardOf); the page builds
// a connector change's card from its document (view-table.js noteCard, pinned below).

describe("view-table helpers (node)", () => {
  const VT = (globalThis as any).CoCheckViewTable;
  it("missingSides: a parent-covered side is skipped, an uncovered side is kept", () => {
    const all = [{ id: "p", boxes: [{ side: "after" }] }, { id: "c", parent: "p", boxes: [], unplaced: { before: "x", after: "not marked" } }];
    assert.deepEqual(VT.missingSides(all[1], {}, all), [{ side: "before", why: "x" }]);
    assert.deepEqual(VT.missingSides({ id: "d", parent: "p", boxes: [] }, {}, all), []);
  });
  const tm = (side: string, pane: string, text: string, r: unknown) => ({ change: "k1", side, pane, confidence: "text-match", text, rect: r });
  const found = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, true]));
  it("padBox pads 0.7% of the width at the sides, a quarter of that above and below, and clips to the picture", () => {
    const p = VT.padBox({ x: 100, y: 200, w: 300, h: 60 }, 1000, 1400);
    assert.deepEqual([p.left, p.width].map((v: number) => +v.toFixed(3)), [9.3, 31.4]);
    assert.equal(+p.top.toFixed(4), +(100 * 198.25 / 1400).toFixed(4));
    const c = VT.padBox({ x: 2, y: 1, w: 996, h: 1398 }, 1000, 1400);
    assert.deepEqual([c.left, c.top, c.width, c.height], [0, 0, 100, 100]);
  });
  it("missingSides names each unplaced side, an unmounted boxed side, and a change with nothing", () => {
    assert.deepEqual(VT.missingSides({ boxes: [{ side: "before" }], unplaced: { after: "x" } }, { before: true, after: false }), [{ side: "after", why: "x" }]);
    assert.deepEqual(VT.missingSides({ boxes: [{ side: "before" }] }, { before: false, after: false }), [{ side: "before", why: "not marked" }]);
    assert.deepEqual(VT.missingSides({ boxes: [] }, {}), [{ side: "after", why: "not marked" }]);
    assert.deepEqual(VT.missingSides({ boxes: [{ side: "after" }] }, { after: true }), []);
  });
});
