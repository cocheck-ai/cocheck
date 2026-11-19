import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asServed, served } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// stepping from a file step (structure panel, Open button) to a "1 command, no file changed" step left them
// on the page, because the calls view never cleared them. Walking back from a later step showed none. The panel and buttons now follow the step,
// whatever step came before. Must not happen: a no-change step claiming the previous file's structure verdict or Open buttons.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, changes: Change[]) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: id, source: "agent-description", label: "l" } });
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 3, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [
    call("w1", 1, [change("c1", "budget.xlsx")]), call("q1", 2, []), call("w2", 3, [change("c2", "notes.txt")]),
  ] }] }] } as unknown as Timeline;

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

// a real finding (the connector's issue on the step, which shows its count and the fix prompt; the carry-over is measured with it)
const ISSUES = [{ text: "Some cells point at text that is not stored in the workbook, and Excel may ask to repair it.", side: "after", where: "xl/worksheets/sheet1.xml" }];
const chartView = { change: "c1", file: "budget.xlsx", engine: "drawn by CoCheck", kind: "grid", before: [], after: [], boxes: [], caveats: [] };

async function boot() {
  const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
  model.excel = true;
  const c1 = model.stops.find((s: { id: string }) => s.id === "chg-c1");
  c1.change.openExcel = { before: true, after: true };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [], addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, activeElement: null };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "#1" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval: () => 1, clearInterval() {},
    fetch: async (u: string) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(u.includes("/review/model") ? model : { ...(asServed(chartView) as object), issues: ISSUES })) }) };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  const press = async (k: string) => { handlers.keydown!({ key: k, target: body, preventDefault() {} }); await settle(); };
  const quiet = (): N => { const all = (n: N): N[] => [n, ...n.descendants()]; return all(byId("tl")).find((n) => n.className.split(/\s+/).includes("qline"))!; };
  const openQuiet = async () => { quiet().click(); await settle(); };
  const shown = () => ({
    // the step's issues: the header pill and the Details panel's Issues group
    structure: !byId("hissues").hidden && byId("hissues").textContent !== "" && !byId("detissues").hidden && byId("detissues").textContent !== "",
    // the Open in Excel buttons are gone; no step carries any
    open: byId("openxl").textContent !== "",
    heading: byId("h1").textContent,
  });
  return { press, openQuiet, shown };
}

describe("a no-change step renders its own empty structure and button area", () => {
  it("the file step shows the panel (the case the others are measured against); no Open buttons", async () => {
    const p = await boot();
    for (let i = 0; i < 6 && !/budget/.test(p.shown().heading); i++) await p.press("ArrowLeft");
    const s = p.shown();
    assert.deepEqual([s.structure, s.open], [true, false], JSON.stringify(s));
  });
  it("file step first, then the no-change step: none of the three carries over", async () => {
    const p = await boot();
    for (let i = 0; i < 6 && !/budget/.test(p.shown().heading); i++) await p.press("ArrowLeft");
    assert.equal(p.shown().structure, true);
    await p.openQuiet();
    const s = p.shown();
    assert.match(s.heading, /1 command, no file changed/);
    assert.deepEqual([s.structure, s.open], [false, false], JSON.stringify(s));
  });
  it("walking back from a later step gives the same empty area", async () => {
    const p = await boot();
    for (let i = 0; i < 6; i++) await p.press("ArrowRight");
    assert.match(p.shown().heading, /notes/);
    await p.openQuiet();
    const s = p.shown();
    assert.match(s.heading, /1 command, no file changed/);
    assert.deepEqual([s.structure, s.open], [false, false], JSON.stringify(s));
  });
  it("a real issue still renders on the file step (the issues panel is not removed with the carry-over)", async () => {
    const p = await boot();
    for (let i = 0; i < 6 && !/budget/.test(p.shown().heading); i++) await p.press("ArrowLeft");
    assert.equal(p.shown().structure, true);
  });
});
