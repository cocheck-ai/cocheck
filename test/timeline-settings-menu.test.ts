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

// Each step's body is decluttered (the review page v2 design, "Every step has the same frame", "Layout per step type", "AI text",
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
// The rewrite step's document in v1 terms: one picture pane per side and one bare marked region on the after side (a "region" change has no card
// of its own, so the page's notes path draws the change's one note, led to that mark). A cell box is a change drawn as boxes (no leader).
const SHA = "a".repeat(64);
const regionView = (key: string) => ({ change: key, file: "macro.xlsx", engine: "drawn by LibreOffice", kind: "card",
  before: [{ id: "before:p1", label: "Before", picture: { sha: SHA, width: 100, height: 100, page: 1 } }],
  after: [{ id: "after:p1", label: "After", picture: { sha: SHA, width: 100, height: 100, page: 1 } }],
  boxes: [{ change: key, side: "after", pane: "after:p1", confidence: "pixel", rect: { x: 1, y: 1, w: 5, h: 5 } }], caveats: [] });
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

type Prefs = { mode: "404" | "200"; clean?: boolean; railOrder?: string; posts: unknown[] };
const listeners: Record<string, Array<(e: unknown) => void>> = {};
async function boot(model: RailModel, prefs: Prefs = { mode: "404", posts: [] }, reducedMotion = false, leaders = false) {
  for (const k of Object.keys(listeners)) delete listeners[k];
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => asServed(v) });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener: (k: string, f: (e: unknown) => void) => { (listeners[k] ??= []).push(f); }, matchMedia: () => ({ matches: reducedMotion }), setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (ms === 6000 || f.name === "poll" ? 0 : setTimeout(f, ms)), clearTimeout() {},
    fetch: async (u: string, init?: { method?: string; body?: string }) => {
      if (u.includes("/review/preferences")) {
        if (init?.method === "POST") { prefs.posts.push(JSON.parse(init.body as string)); return prefs.mode === "200" ? json({ railOrder: "oldest-first", ...JSON.parse(init.body as string) }) : json({}, false); }
        return prefs.mode === "200" ? json({ railOrder: prefs.railOrder ?? "oldest-first", clean: prefs.clean }) : json({}, false);
      }
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      const v = /\/view\/([^?]+)/.exec(u);
      if (v) return json(decodeURIComponent(v[1]!) === "t" ? textView("t") : (leaders ? regionView : gridView)(decodeURIComponent(v[1]!)));
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
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


// Newest first and Clean diff move into a settings menu in the bar, and both animate. The page code runs as is in a vm with a DOM stub.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (k: string, target: N, over: Record<string, unknown> = {}) => {
  let prevented = false;
  for (const f of listeners.keydown ?? []) f({ key: k, target, metaKey: false, ctrlKey: false, altKey: false, preventDefault() { prevented = true; }, stopPropagation() {}, ...over });
  return prevented;
};
const outsideClick = (target: N) => { for (const f of listeners.click ?? []) f({ target, stopPropagation() {}, preventDefault() {} }); };
const tops = (p: Awaited<ReturnType<typeof boot>>) => p.byId("tl").children.filter((n) => n.attrs["data-key"]);

describe("the settings menu", () => {
  it("the toolbar carries a settings icon (inline svg, no glyph) after Sign off and a menu holding both toggles; the bottom bar has none", async () => {
    const html = renderReviewShell(7);
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    assert.ok(header.indexOf('id="submit"') < header.indexOf('id="setbtn"'), "after Sign off");
    const rest = html.slice(html.indexOf('id="pbar"'), html.indexOf('id="toast"'));
    assert.ok(!/id="setbtn"|id="setmenu"/.test(rest), "not in the bottom bar");
    const bar = header;
    const btn = /<button[^>]*id="setbtn"[^>]*>([\s\S]*?)<\/button>/.exec(bar);
    assert.ok(btn, "a settings button in the bar");
    assert.match(btn![0], /aria-label="Settings"/); assert.match(btn![0], /aria-haspopup/); assert.match(btn![0], /aria-expanded="false"/);
    assert.match(btn![1]!, /^\s*<svg[\s\S]*<\/svg>\s*$/, "an inline svg and nothing else");
    const menu = /<div[^>]*id="setmenu"[^>]*>([\s\S]*?)<\/div>/.exec(bar);
    assert.ok(menu && /hidden/.test(menu[0].split(">")[0]!), "the menu starts closed");
    assert.match(menu![1]!, /id="railorder"[^>]*aria-pressed="false"[^>]*>Newest First</);
    assert.match(menu![1]!, /id="cleanbtn"[^>]*aria-pressed="false"[^>]*>Clean Diff</);
  });
  it("css: a 32px control at the toolbar's right end, a menu opening downward, fades by animation, and the reduced-motion rule still stands", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /\.pbset\{[^}]*width:32px;height:32px/);
    assert.match(css, /\.setmenu\{[^}]*top:calc\(100% \+ var\(--s2\)\)/);
    assert.match(css, /body\.cout \.notes[^{]*\{animation:cfout/);
    assert.match(css, /\.tl \.flipo\{transition:transform var\(--dur-slow\)/);
    assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition:none!important\}\}/);
  });
  it("the icon opens and closes the menu; Esc and an outside click close it; a click inside does not", async () => {
    const p = await boot(build());
    const m = p.byId("setmenu"), b = p.byId("setbtn");
    
    b.click(); await p.settle();
    assert.equal(m.hidden, false); assert.equal(b.attrs["aria-expanded"], "true");
    outsideClick(p.byId("cleanbtn")); assert.equal(m.hidden, false, "a click on an option is inside");
    assert.equal(key("Escape", p.byId("cleanbtn")), true); assert.equal(m.hidden, true); assert.equal(b.attrs["aria-expanded"], "false"); assert.equal(b.focused, true, "focus returns to the icon");
    b.click(); assert.equal(m.hidden, false);
    outsideClick(p.byId("stage")); assert.equal(m.hidden, true, "outside click closes");
    b.click(); b.click(); assert.equal(m.hidden, true, "the icon toggles");
  });
  it("the menu never traps keys; P/F still act with it open or closed, and Space on an option is left to the button", async () => {
    const p = await boot(build());
    await p.go("fetch.py"); p.byId("setbtn").click(); await p.settle();
    for (const k of ["p"]) { assert.equal(key(k, p.byId("cleanbtn")), true, `${k} handled with the menu open and focus in it`); await p.settle(); }
    await p.go("fetch.py");
    assert.equal(key("f", p.byId("railorder")), true, "F handled with focus in the menu");
    (p.byId("railorder") as unknown as { tagName: string }).tagName = "BUTTON"; (p.byId("railorder") as unknown as { closest: (s: string) => N | null }).closest = (sel) => (sel.includes(".setwrap") ? p.byId("setwrap") : null);
    assert.equal(key(" ", p.byId("railorder")), false, "Space is the button's own");
    assert.equal(key("Tab", p.byId("railorder")), false, "Tab is never swallowed");
    key("Escape", p.byId("railorder")); key("Escape", p.byId("vnote"), { target: p.byId("setbtn") });
    assert.equal(p.byId("setmenu").hidden, true);
    await p.go("macro.xlsx");
    assert.equal(key("p", p.byId("setbtn")), true, "P works with the menu closed");
  });
  it("the toggles persist exactly as before: order and clean post once each, and both read back on load", async () => {
    const prefs: Prefs = { mode: "200", clean: true, railOrder: "newest-first", posts: [] };
    const p = await boot(build(), prefs);
    assert.equal(p.byId("railorder").attrs["aria-pressed"], "true"); assert.equal(p.byId("cleanbtn").attrs["aria-pressed"], "true"); assert.equal(has(p.body, "clean"), true);
    p.byId("railorder").click(); p.byId("cleanbtn").click(); await p.settle();
    assert.deepEqual(prefs.posts, [{ railOrder: "oldest-first" }, { clean: false }]);
  });
});

describe("Newest first glides the rail to its new places", () => {
  it("each moved row starts at its old place (a translateY) and eases to the new one; at rest no transform stays", async () => {
    const p = await boot(build());
    const old = new Map(tops(p).map((n) => [n.attrs["data-key"], parseFloat(String(n.style.top))]));
    p.byId("railorder").click(); await p.settle();
    const moved = tops(p).filter((n) => String(n.style.transform || "").startsWith("translateY(") || has(n, "flipo"));
    assert.ok(moved.length >= 3, "rows are mid-glide");
    for (const n of moved) {
      const now = parseFloat(String(n.style.top)), was = old.get(n.attrs["data-key"])!;
      assert.ok(has(n, "flipo"), "the glide class is on");
      if (was !== now) { const d = parseFloat(/translateY\((-?[\d.]+)px\)|$/.exec(String(n.style.transform))?.[1] ?? "NaN"); assert.ok(Math.abs(d - (was - now)) < 1.5 || n.style.transform === "", `${n.attrs["data-key"]}: starts where it stood`); }
    }
    await wait(500);
    for (const n of tops(p)) { assert.ok(!n.style.transform, "no transform left at rest"); assert.ok(!has(n, "flipo")); }
    assert.equal(p.byId("railorder").attrs["aria-pressed"], "true");
  });
  it("reduced motion: the rows jump, nothing glides", async () => {
    const p = await boot(build(), { mode: "404", posts: [] }, true);
    p.byId("railorder").click(); await p.settle();
    for (const n of tops(p)) { assert.ok(!n.style.transform); assert.ok(!has(n, "flipo")); }
  });
  it("the leaders are laid out again at the final geometry after the swap, never left at old places", async () => {
    const p = await boot(build(), { mode: "404", posts: [] }, false, true);
    await p.go("macro.xlsx");
    const svg = () => p.byId("svg");
    const before = svg().children.slice();
    assert.ok(before.length > 0, "leaders drawn for this step");
    p.byId("railorder").click(); await p.settle(); await wait(500);
    const after = svg().children;
    assert.ok(after.length === before.length && after.length > 0, "the same leaders stand");
    assert.ok(tops(p).every((n) => !n.style.transform));
  });
});

describe("Clean diff fades the notes, leaders and boxes", () => {
  it("on: the fade runs first (cout) and the clean class lands when it ends; off: clean goes, leaders are drawn again, and the fade in (cin) runs", async () => {
    const prefs: Prefs = { mode: "404", posts: [] };
    const p = await boot(build(), prefs, false, true);
    await p.go("macro.xlsx");
    p.byId("cleanbtn").click(); await p.settle();
    assert.equal(has(p.body, "cout"), true, "fading out"); assert.equal(has(p.body, "clean"), false, "not hidden yet");
    assert.equal(p.byId("cleanbtn").attrs["aria-pressed"], "true"); assert.deepEqual(prefs.posts, [{ clean: true }], "persisted at once");
    await wait(400);
    assert.equal(has(p.body, "clean"), true); assert.equal(has(p.body, "cout"), false);
    const svgBefore = p.byId("svg").children.slice();
    p.byId("cleanbtn").click(); await p.settle();
    assert.equal(has(p.body, "clean"), false); assert.equal(has(p.body, "cin"), true, "fading in");
    assert.ok(p.byId("svg").children.length > 0 && p.byId("svg").children.every((c) => !svgBefore.includes(c)), "leaders redrawn at the restored geometry");
    await wait(400);
    assert.equal(has(p.body, "cin"), false);
    assert.deepEqual(prefs.posts, [{ clean: true }, { clean: false }]);
  });
  it("a second click mid-fade settles on the last choice", async () => {
    const p = await boot(build());
    p.byId("cleanbtn").click(); p.byId("cleanbtn").click(); await wait(400);
    assert.equal(has(p.body, "clean"), false); assert.equal(has(p.body, "cout"), false); assert.equal(p.byId("cleanbtn").attrs["aria-pressed"], "false");
  });
  it("reduced motion: the class lands at once, no fade classes", async () => {
    const p = await boot(build(), { mode: "404", posts: [] }, true);
    p.byId("cleanbtn").click(); await p.settle();
    assert.equal(has(p.body, "clean"), true); assert.equal(has(p.body, "cout"), false);
    p.byId("cleanbtn").click(); await p.settle();
    assert.equal(has(p.body, "clean"), false); assert.equal(has(p.body, "cin"), false);
  });
});

// The menu is in reach on every task, a composer closes it, and the grid highlight fades with the rest.
describe("the bar and the menu on every task", () => {
  it("a task with failed calls only (no change stop) has no bottom bar, the toolbar settings still open, and Newest first works", async () => {
    const p = await boot(buildRailModel(timeline([failed("f1", 1, "Fetch FRED", "Exit code 1"), failed("f2", 2, "Test the site", "Exit code 92"), failed("f3", 3, "Rerun", "Exit code 3")])));
    const bar = p.byId("pbar");
    assert.ok(has(bar, "solo") || bar.hidden, "the bottom bar has nothing to show");
    p.byId("setbtn").click(); await p.settle();
    assert.equal(p.byId("setmenu").hidden, false);
    p.byId("railorder").click(); await p.settle();
    assert.equal(p.byId("railorder").attrs["aria-pressed"], "true");
  });
  it("a task with changes is not solo", async () => {
    const p = await boot(build());
    await p.go("fetch.py");
    assert.equal(p.byId("pbar").hidden, false); assert.ok(!has(p.byId("pbar"), "solo"));
  });
  it("opening the fail composer closes the open settings menu", async () => {
    const p = await boot(build());
    await p.go("fetch.py"); p.byId("setbtn").click(); await p.settle();
    assert.equal(p.byId("setmenu").hidden, false);
    key("f", p.byId("setbtn")); await p.settle();
    assert.equal(p.byId("pcomp").hidden, false, "the composer is open");
    assert.equal(p.byId("setmenu").hidden, true, "the menu is closed");
    assert.equal(p.byId("setbtn").attrs["aria-expanded"], "false");
  });
  it("css: td.hit (grid panes) fades in and out on the notes' clock, and the bar has an icon-only form", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /body\.cout \.grid:not\(\.textpane\) td\.hit\{animation:hitout var\(--dur\) /);
    assert.match(css, /body\.cin \.grid:not\(\.textpane\) td\.hit\{animation:hitin var\(--dur-slow\) /);
    assert.match(css, /@keyframes hitout\{to\{background-color:transparent;outline-color:transparent\}\}/);
    assert.match(css, /@keyframes hitin\{from\{background-color:transparent;outline-color:transparent\}\}/);
    assert.match(css, /\.pbar\.solo>:not\(\.prow\)\{display:none\}/);
    assert.match(css, /\.pbar\.solo\{display:none\}/);
    assert.match(css, /\.pbar:has\(\.pcomp:not\(\[hidden\]\)\) \.setmenu\{display:none\}/);
  });
  it("progress is a 16px ring with a visible track at 0, and the aria-live text keeps saying N of M reviewed", async () => {
    const html = renderReviewShell(7);
    assert.ok(!/id="progbar"/.test(html), "no bar");
    assert.match(html, /<span id="progtext" aria-live="polite">/);
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /\.progress \.ring\{[^}]*width:16px;height:16px/);
    assert.match(css, /\.progress \.rtrack\{stroke:var\(--well\)\}/);
    assert.match(css, /\.progress \.rfill\{stroke:var\(--before\)/);
    const p = await boot(build());
    await p.go("fetch.py");
    assert.match(p.byId("progtext").textContent, /^0 of \d+ changes? reviewed$/);
    assert.equal((p.byId("progring") as unknown as { style: Record<string, string> }).style.strokeDashoffset, "100", "empty at 0");
  });
});
