import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// A view of several panes shows one at a time (the tabs serve text and picture panes); its tabs switch it (mouse, keyboard), before and after together, and every sheet with a
// change has a tab marked changed. The review page code runs as is in a vm with a DOM stub that keeps attributes, listeners and hidden state.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [change("c1", "book.xlsx")], line: { text: "t", source: "agent-description", label: "l" } }] }] }] } as unknown as Timeline;

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; focused = false; nodeType = 1;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { this.focused = true; }
  scrolled: Array<unknown> = [];
  scrollIntoView(o: unknown) { this.scrolled.push(o); }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(sel: string): N | null { for (let n: N | null = this; n; n = n.parentNode) if (sel === ".vw[hidden]" && n.hidden && n.className.split(/\s+/).includes("vw")) return n; return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

async function boot(view: unknown) {
  const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "#1" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval, clearInterval, console,
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? model : servedFor(view, model, u)) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  const key = async (k: string, target: unknown = { tagName: "BODY" }) => { handlers.keydown!({ key: k, target, preventDefault() {} }); await settle(); };
  // No start stop; the page opens on the change (the first step that needs a verdict), so no key is pressed to reach it.
  const tabs = (side: "ta" | "tb") => byId(side).children;
  const wraps = (side: "va" | "vb") => byId(side).children;
  return { byId, key, tabs, wraps, settle };
}

// The page draws no sheet, so the tabs are pinned on text panes, the multi-pane view that keeps them
const pane = (side: string, sheet: string, text: string) => ({ id: `${side}:${sheet}`, label: sheet, text: { lines: [{ n: 1, text, kind: null, marks: [] }] } });
const box = (side: string, sheet: string) => ({ side, pane: `${side}:${sheet}`, line: 1, change: "c1", confidence: "exact" });
const view = (o: Record<string, unknown>) => ({ change: "c1", file: "book.xlsx", engine: "drawn by CoCheck", kind: "pages", before: [], after: [], boxes: [], caveats: [], ...o });
const isOn = (n: N) => n.className.split(/\s+/).includes("on");
const isChg = (n: N) => n.className.split(/\s+/).includes("chg");
const visibleText = (ws: N[]) => ws.filter((w) => !w.hidden).map((w) => w.textContent).join("|");

// Sheets: Cover (no change), Data (changed), Totals (changed).
const three = view({
  before: ["Cover", "Data", "Totals"].map((s) => pane("before", s, `${s} old`)),
  after: ["Cover", "Data", "Totals"].map((s) => pane("after", s, `${s} new`)),
  boxes: [box("after", "Data"), box("before", "Data"), box("after", "Totals")],
});

describe("sheet tabs switch the sheet", () => {
  it("one sheet shows at a time, and it is the first changed sheet", async () => {
    const p = await boot(three);
    assert.equal(p.wraps("va").filter((w) => !w.hidden).length, 1);
    assert.equal(p.wraps("vb").filter((w) => !w.hidden).length, 1);
    assert.match(visibleText(p.wraps("va")), /Data new/);
    assert.match(visibleText(p.wraps("vb")), /Data old/);
    assert.deepEqual(p.tabs("ta").map(isOn), [false, true, false]);
  });

  it("clicking a tab switches both panes together", async () => {
    const p = await boot(three);
    p.tabs("tb")[2]!.click();
    assert.match(visibleText(p.wraps("va")), /Totals new/);
    assert.match(visibleText(p.wraps("vb")), /Totals old/);
    assert.deepEqual(p.tabs("ta").map(isOn), [false, false, true]);
    assert.deepEqual(p.tabs("tb").map(isOn), [false, false, true]);
  });

  it("the keyboard switches: arrows on a focused tab, and [ ] anywhere; arrows elsewhere still step moments", async () => {
    const p = await boot(three);
    await p.key("ArrowLeft", p.tabs("ta")[1]);
    assert.match(visibleText(p.wraps("va")), /Cover new/);
    assert.equal(p.tabs("ta")[0]!.focused, true);
    await p.key("]"); await p.key("]");
    assert.match(visibleText(p.wraps("va")), /Totals new/);
    await p.key("]");
    assert.match(visibleText(p.wraps("va")), /Totals new/, "stops at the last tab");
    await p.key("[");
    assert.match(visibleText(p.wraps("vb")), /Data old/);
  });

  it("every sheet with a change is marked changed, on both panes, and a quiet sheet is not", async () => {
    const p = await boot(three);
    for (const side of ["ta", "tb"] as const) {
      assert.deepEqual(p.tabs(side).map(isChg), [false, true, true]);
      assert.match(p.tabs(side)[1]!.attrs["aria-label"]!, /changed/);
      assert.doesNotMatch(p.tabs(side)[0]!.attrs["aria-label"]!, /changed/);
    }
    p.tabs("ta")[0]!.click();
    assert.deepEqual(p.tabs("ta").map(isChg), [false, true, true], "marks survive a switch");
  });


  it("a sheet whose only changes are past the draw cap is still marked changed, from the whole change list, not from the drawn boxes", async () => {
    // the one change on Totals has no drawn box (its cell is past the cap): it is unplaced, and the legacy list still names its cell
    const v = view({ ...three, boxes: [box("after", "Totals")], changes: [{ id: "k1", loc: "Totals!Z999", kind: "cell", parent: null, boxes: [], unplaced: { after: "not marked" } }] });
    const p = await boot(v);
    assert.equal(isChg(p.tabs("ta")[2]!), true, "Totals is marked changed");
    assert.equal(isChg(p.tabs("ta")[0]!), false, "a quiet sheet is not");
  });

  it("an added sheet gets a tab on the before pane too, marked changed, saying it did not exist", async () => {
    const v = view({ before: [pane("before", "Data", "old")], after: [pane("after", "Data", "new"), pane("after", "Extra", "fresh")], boxes: [box("after", "Data")] });
    const p = await boot(v);
    assert.equal(p.tabs("tb").length, 2);
    assert.deepEqual(p.tabs("tb").map(isChg), [true, true]);
    p.tabs("tb")[1]!.click();
    assert.match(visibleText(p.wraps("vb")), /did not exist yet/);
    assert.match(visibleText(p.wraps("va")), /fresh/);
  });

  it("a removed sheet gets a tab on the after pane, marked changed, saying it is gone", async () => {
    const v = view({ before: [pane("before", "Data", "old"), pane("before", "Old", "bye")], after: [pane("after", "Data", "new")], boxes: [] });
    const p = await boot(v);
    assert.deepEqual(p.tabs("ta").map(isChg), [false, true]);
    assert.match(visibleText(p.wraps("va")), /is gone now/, "opens on the first changed sheet, the removed one");
    assert.match(visibleText(p.wraps("vb")), /bye/);
  });
});

describe("tabs for any sheet name, legible, reachable", () => {
  const names = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"];
  const odd = view({
    before: names.map((s) => pane("before", s, `${s} old`)),
    after: names.map((s) => pane("after", s, `${s} new`)),
    boxes: [box("after", "__proto__"), box("after", "constructor")],
  });
  it("a sheet named constructor or __proto__ has a tab, is drawn when selected, and carries its changed mark", async () => {
    const p = await boot(odd);
    for (const side of ["ta", "tb"] as const) {
      assert.deepEqual(p.tabs(side).map((t) => t.textContent), names);
      assert.deepEqual(p.tabs(side).map(isChg), [true, true, false, false, false]);
    }
    for (let i = 0; i < names.length; i++) {
      p.tabs("tb")[i]!.click();
      assert.equal(p.wraps("va").filter((w) => !w.hidden).length, 1);
      assert.match(visibleText(p.wraps("va")), new RegExp(`${names[i]} new`));
      assert.match(visibleText(p.wraps("vb")), new RegExp(`${names[i]} old`));
    }
  });

  it("a sheet named __proto__ added on one side still gets its placeholder tab", async () => {
    const v = view({ before: [pane("before", "Data", "old")], after: [pane("after", "Data", "new"), pane("after", "__proto__", "fresh")], boxes: [] });
    const p = await boot(v);
    assert.deepEqual(p.tabs("tb").map((t) => t.textContent), ["Data", "Before, __proto__: not there yet"]);
    assert.deepEqual(p.tabs("tb").map(isChg), [false, true]);
  });

  it("the strip is not a fixed 30px box that its own scrollbar overlaps", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    const rule = /\n\.tabs\{([^}]*)\}/.exec(css)![1]!;
    assert.doesNotMatch(rule, /(^|;)height:/);
    assert.match(rule, /min-height:/);
    assert.match(rule, /overflow-x:auto/);
  });

  it("the selected tab is scrolled into view on both panes after a click, arrow keys and [ ]", async () => {
    const p = await boot(three);
    const lastScroll = (n: N) => n.scrolled.length;
    const before = [p.tabs("ta")[2]!, p.tabs("tb")[2]!].map(lastScroll);
    p.tabs("ta")[2]!.click();
    assert.deepEqual([p.tabs("ta")[2]!, p.tabs("tb")[2]!].map(lastScroll), before.map((n) => n + 1));
    const c0 = [p.tabs("ta")[1]!, p.tabs("tb")[1]!].map(lastScroll);
    await p.key("ArrowLeft", p.tabs("ta")[2]);
    assert.deepEqual([p.tabs("ta")[1]!, p.tabs("tb")[1]!].map(lastScroll), c0.map((n) => n + 1));
    const c1 = [p.tabs("ta")[2]!, p.tabs("tb")[2]!].map(lastScroll);
    await p.key("]");
    assert.deepEqual([p.tabs("ta")[2]!, p.tabs("tb")[2]!].map(lastScroll), c1.map((n) => n + 1));
  });
});
