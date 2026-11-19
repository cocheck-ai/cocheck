import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { asServed, served } from "./helpers/v1-served.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import { translateShell } from "../src/timeline/describe.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// each step's body is decluttered (docs/design/review-page-v2.md, "Every step has the same frame", "Layout per step type", "AI text",
// "Words to cut"). Failure steps have no panes; "created"
// is said once; a change too big to read cell by cell is one card; a text change has no notes column; the view's limits sit behind one
// disclosure under one engine line; and no step body carries the cut words. The page code runs as is in a vm with a DOM stub.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string, over: Record<string, unknown> = {}): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` }, ...over }) as unknown as Change;
const call = (id: string, start: number, text: string, changes: Change[] = [], over: Record<string, unknown> = {}) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text, source: "agent-description", label: "l" }, agent: null, ...over });
const failed = (id: string, start: number, text: string, error: string, over: Record<string, unknown> = {}) => call(id, start, text, [], { outcome: "failed", error, ...over });
const timeline = (calls: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: calls.length, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls }] }] } as unknown as Timeline);

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ location: `gdp!B${i + 2}`, kind: "value", before: "1", after: "2", text: "t", note: { text: `changed B${i + 2}`, source: "rule" } }));
const BIG = { module: "xlsx", rows: rows(100), more: 900, moreIn: [{ place: "gdp", count: 900, from: 102, to: 1001 }] };

// One request; a new file; two failed calls; one failed call that changed b.txt and c.txt (a header); a rewrite; a text change.
const build = (): RailModel => buildRailModel(timeline([
  call("k1", 1, "Write the new file", [change("n", "data/new.csv", "k1", { kind: "created", before: null, note: { text: "Claude created new.csv in the data folder.", source: "rule" } })]),
  failed("f1", 2, "Fetch FRED", "TimeoutError: The read operation timed out", { errorFull: "Exit code 1\nTraceback\nTimeoutError: The read operation timed out" }),
  failed("f2", 3, "Test the site", "Exit code 92"),
  call("k2", 4, "Rerun the fetch", [change("b", "b.txt", "k2"), change("c", "c.txt", "k2")], { outcome: "failed", error: "ValueError: bad sheet" }),
  call("k3", 5, "Pull the series again", [change("x", "macro.xlsx", "k3", { format: BIG })]),
  call("k4", 6, "Fix the fetch", [change("t", "fetch.py", "k4")]),
]));

// A grid view with one boxed cell and one caveat, and a text view for fetch.py.
const gridView = (key: string) => ({ change: key, file: "f", engine: "drawn by CoCheck from the cells, not by Excel", kind: "grid",
  before: [{ id: "before:S", label: "S", grid: { sheet: "gdp", columns: [{ name: "B" }], rows: [{ row: 2, cells: { B: { ref: "B2", text: "1" } } }] } }],
  after: [{ id: "after:S", label: "S", grid: { sheet: "gdp", columns: [{ name: "B" }], rows: [{ row: 2, cells: { B: { ref: "B2", text: "2" } } }] } }],
  boxes: [{ change: key, side: "after", pane: "after:S", cell: "B2" }], caveats: ["Charts are not drawn."] });
const textView = (key: string) => ({ change: key, file: "fetch.py", engine: "drawn by CoCheck from the lines of the file", kind: "grid",
  before: [{ id: "before:t", label: "fetch.py", text: { lines: [{ n: 1, text: "a = 1", kind: "edit", marks: [] }] } }],
  after: [{ id: "after:t", label: "fetch.py", text: { lines: [{ n: 1, text: "a = 2", kind: "edit", marks: [] }] } }],
  boxes: [{ change: key, side: "after", pane: "after:t", line: 1 }], caveats: [] });

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; focused = false;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  fire(k: string, e: Record<string, unknown> = {}) { (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this, ...e })); }
  click() { this.fire("click"); }
  focus() { this.focused = true; } select() {} scrollIntoView() {} scrollTo() {} showModal() { this.open = true; } close() { this.open = false; }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { if (!s.className.split(/\s+/).includes(c)) s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

type Prefs = { mode: "404" | "200"; clean?: boolean; posts: unknown[] };
async function boot(model: RailModel, prefs: Prefs = { mode: "404", posts: [] }) {
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => asServed(v) });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (ms === 6000 || f.name === "poll" ? 0 : setTimeout(f, 0)), clearTimeout() {},
    fetch: async (u: string, init?: { method?: string; body?: string }) => {
      if (u.includes("/review/preferences")) {
        if (init?.method === "POST") { prefs.posts.push(JSON.parse(init.body as string)); return prefs.mode === "200" ? json({ railOrder: "oldest-first", ...JSON.parse(init.body as string) }) : json({}, false); }
        return prefs.mode === "200" ? json({ railOrder: "oldest-first", clean: prefs.clean }) : json({}, false);
      }
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      const v = /\/view\/([^?]+)/.exec(u);
      if (v) return json(decodeURIComponent(v[1]!) === "t" ? textView("t") : gridView(decodeURIComponent(v[1]!)));
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const row = (label: string) => byId("tl").children.find((r) => has(r, "row") && r.textContent.includes(label));
  const go = async (label: string) => {
    /* a file under a closed call header is reached by opening the header first (a click on a header opens or closes it) */
    if (!row(label)) { const h = byId("tl").children.find((r) => has(r, "hdr") && r.attrs["aria-expanded"] === "false"); h?.click(); await settle(); await settle(); }
    const r = row(label); assert.ok(r, `a rail row reads ${label}`); r!.click(); await settle(); await settle();
  };
  const ai = byId("h2");
  /* everything the step's body shows: the AI line, the header's failure line and files, the body, the notes, the panes */
  const shown = () => ["h2", "callfail", "hdrview", "bodyview", "reqtext", "notes", "vb", "va"].map((id) => (byId(id).hidden ? "" : byId(id).textContent)).join(" | ");
  return { byId, go, ai, shown, settle, body };
}

const clean = (p: { body: N }) => has(p.body, "clean");

describe("the clean-diff toggle", () => {
  it("the shell carries the button beside the view switch, and the css hides notes, leaders, boxes and cell outlines under body.clean", async () => {
    const html = renderReviewShell(7);
    assert.match(html, /id="cleanbtn"[^>]*aria-pressed="false"/);
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /body\.clean \.notes,body\.clean \.leaders,body\.clean \.bx\{display:none\}/);
    assert.match(css, /body\.clean \.grid td\.hit/);
    assert.match(css, /body\.clean \.stage\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)\}/, "the notes column's width is released");
  });
  it("toggling sets its own class (not nonotes) and it survives render() and a step change, with no preference route (404)", async () => {
    const prefs: Prefs = { mode: "404", posts: [] };
    const p = await boot(build(), prefs);
    const btn = p.byId("cleanbtn");
    assert.equal(clean(p), false);
    btn.click(); await p.settle();
    assert.equal(clean(p), true); assert.equal(btn.attrs["aria-pressed"], "true");
    assert.equal(has(p.byId("stage"), "nonotes"), false, "its own class, not nonotes");
    await p.go("macro.xlsx"); assert.equal(clean(p), true, "survives a render with notes");
    await p.go("fetch.py"); assert.equal(has(p.byId("stage"), "nonotes"), true, "a text-only change still takes the no-notes layout"); assert.equal(clean(p), true);
    assert.deepEqual(prefs.posts, [{ clean: true }]);
    btn.click(); await p.settle(); assert.equal(clean(p), false);
    assert.deepEqual(prefs.posts, [{ clean: true }, { clean: false }]);
  });
  it("with the preference route answering 200, clean is read on load and posted on toggle", async () => {
    const prefs: Prefs = { mode: "200", clean: true, posts: [] };
    const p = await boot(build(), prefs);
    assert.equal(clean(p), true, "read from GET on load");
    assert.equal(p.byId("cleanbtn").attrs["aria-pressed"], "true");
    p.byId("cleanbtn").click(); await p.settle();
    assert.equal(clean(p), false); assert.deepEqual(prefs.posts, [{ clean: false }]);
  });
  it("a preference call that rejects is swallowed and the in-page state stands", async () => {
    const p = await boot(build(), { mode: "404", posts: [] });
    p.byId("cleanbtn").click(); await p.settle(); await p.go("macro.xlsx");
    assert.equal(clean(p), true);
  });
  it("clean stays on across a render of a change with boxes (the boxes do not come back) and a solo step keeps its own layout", async () => {
    const p = await boot(build());
    p.byId("cleanbtn").click(); await p.settle();
    await p.go("b.txt"); await p.go("c.txt"); await p.go("fetch.py"); await p.go("macro.xlsx");
    assert.equal(clean(p), true, "never cleared by a render");
    assert.equal(has(p.byId("stage"), "clean"), false, "the class lives on the body, which render never rewrites");
  });
});
