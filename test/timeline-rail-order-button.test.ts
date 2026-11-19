import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";


const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, text: string, changes: Change[] = [], over: Record<string, unknown> = {}) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text, source: "agent-description", label: "l" }, agent: null, ...over });
const failed = (id: string, start: number, text: string, error: string, over: Record<string, unknown> = {}) => call(id, start, text, [], { outcome: "failed", error, ...over });
const timeline = (calls: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: calls.length, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls }] }] } as unknown as Timeline);

// ---------- the page ----------
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; scrollTop = 0; clientHeight = 0; focused = false;
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
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

// One request; a lone change a.txt; two failed calls; one call that changed b.txt and c.txt (a header); d.txt, then two calls that changed nothing.
const pageModel = buildRailModel(timeline([
  call("k1", 1, "write a", [change("a", "a.txt", "k1")]),
  failed("f1", 2, "Fetch FRED", "Exit code 1"), failed("f2", 3, "Test the site", "Exit code 92"),
  call("k2", 4, "Rerun the fetch", [change("b", "b.txt", "k2"), change("c", "c.txt", "k2")]),
  call("k3", 5, "write d", [change("d", "d.txt", "k3")]),
  call("q1", 6, "List the folder"), call("q2", 7, "Read a picture"),
]));

async function boot(model: RailModel, opts: { verdicts?: Record<string, "passed" | "failed">; hash?: string; markers?: unknown[]; files?: boolean; live?: boolean; noPrefs?: boolean; prefs?: Record<string, unknown> } = {}) {
  let served: RailModel = model;
  const prefs: Record<string, unknown> = { railOrder: "oldest-first", ...(opts.prefs ?? {}) };
  const prefPosts: Array<Record<string, unknown>> = [];
  const polls: Array<() => void> = []; // the live poll timer (2 s) is fired by the test, never by the clock
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const stops: Record<string, { status: string; note: string; stale: boolean; history: unknown[] }> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  for (const [id, status] of Object.entries(opts.verdicts ?? {})) stops[`chg-${id}`] = { status, note: status === "failed" ? "x" : "", stale: false, history: [] };
  const summary = () => ({ anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: (sel: string) => (sel === ".row" ? byId("tl").children.filter((n) => has(n, "row")) : []) }; // the rows, so paintPlace marks the current one
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: opts.hash ?? "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval: () => 0, clearInterval() {},
    setTimeout: (f: () => void, ms: number) => { if (f.name === "poll") { polls.push(f); return 0; } return ms === 6000 ? 0 : setTimeout(f, 0); }, clearTimeout() {},
    fetch: async (u: string, init?: { body?: string }) => {
      if (u.includes("/review/preferences")) {
        if (opts.noPrefs) return json({}, false);
        if (init?.body !== undefined) { const b = JSON.parse(init.body); prefPosts.push(b); Object.assign(prefs, b); }
        return json({ ...prefs });
      }
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(opts.live ? { ...served, live: true } : served)));
      if (u.includes("/review/status")) return json({ stops: JSON.parse(JSON.stringify(stops)), passes: { markers: opts.markers ?? [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], ...summary() });
      if (u.includes("/review/verdict")) {
        const b = JSON.parse(init!.body!);
        stops[b.stop] = { status: b.status, note: b.note, stale: false, history: [] };
        return json({ stop: b.stop, state: stops[b.stop], ...summary() });
      }
      if (u.includes("/view/")) return json({ change: "x", file: "f", engine: "e", kind: "card", before: [], after: [], boxes: [], caveats: [] });
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
  const ctx = vm.createContext(g);
  for (const f of opts.files ? ["view-table.js", "files-view.js", "review.js"] : ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const press = async (k: string, target: unknown = { tagName: "BODY" }) => { handlers.keydown!({ key: k, target, preventDefault() {} }); await settle(); };
  const tl = () => byId("tl");
  const rows = () => tl().children.filter((n) => has(n, "row"));
  const row = (label: string) => rows().find((r) => r.textContent.includes(label));
  const on = () => { const h = byId("h1").textContent; return h === "Rerun the fetch" ? "hdr" : model.stops.find((s) => (s.title ?? s.head) === h)?.id; };
  /* every slot in the column: steps, quiet rows, open quiet lists, markers; top and height in px */
  const slots = () => tl().children.filter((n) => has(n, "row") || has(n, "quiet") || has(n, "qlist")).map((n) => ({ n, top: parseFloat(String(n.style.top)), h: has(n, "qlist") ? 0 : parseFloat(String(n.style.height)) }));
  return { model, prefs, prefPosts, byId, press, settle, serve: async (m: RailModel) => { served = m; polls.splice(0).forEach((f) => f()); await settle(); }, tl, rows, row, on, slots, legend: () => byId("legend").children };

}

const topOf = (n: N | undefined) => parseFloat(String(n!.style.top));
const dotsOrder = (p: Awaited<ReturnType<typeof boot>>) => [...p.rows()].sort((a, b) => topOf(a) - topOf(b)).map((r) => r.attrs["data-i"]);

describe("the order button flips the rail", () => {
  it("a button flips the rows: oldest-first has the first stop on top, newest-first the last; flipping back restores every top", async () => {
    const p = await boot(pageModel);
    const btn = p.byId("railorder");
    const before = p.slots().map((s) => s.top);
    const idx = dotsOrder(p).map(Number);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, "default: stop order runs down the screen");
    btn.click(); await p.settle();
    assert.deepEqual(dotsOrder(p).map(Number), [...idx].sort((a, b) => b - a), "newest-first: reversed");
    assert.equal(btn.attrs["aria-pressed"], "true");
    const s = p.slots().sort((x, y) => x.top - y.top);
    for (let i = 1; i < s.length; i++) assert.ok(s[i]!.top >= s[i - 1]!.top + s[i - 1]!.h, "no row overlaps another when flipped");
    btn.click(); await p.settle();
    assert.deepEqual(p.slots().map((x) => x.top), before, "back to the first order, exactly");
    assert.equal(btn.attrs["aria-pressed"], "false");
  });

  it("quiet rows, the origin row, tail marks and the lane lines follow the flip", async () => {
    const markers = [{ kind: "sendback", label: "Sent back", pass: 2, beforeStop: "chg-d" }, { kind: "submit", label: "Signed off", pass: 3, beforeStop: null }];
    const p = await boot(pageModel, { markers });
    const q = () => p.tl().children.find((n) => has(n, "quiet"))!;
    const marks = () => p.tl().children.filter((n) => has(n, "pmark"));
    const origin = () => p.tl().children.find((n) => n.className === "origin")!;
    const svg = () => p.tl().children.find((n) => n.tag === "svg")!;
    const lastRow = () => p.row("d.txt")!;
    assert.ok(topOf(q()) > topOf(lastRow()), "oldest-first: the quiet calls are below the last stop");
    assert.ok(topOf(marks()[1]) > topOf(q()), "oldest-first: the tail mark is at the bottom");
    assert.ok(!origin().style.top, "oldest-first: the origin sits at the top");
    assert.ok(!svg().children.some((c) => c.tag === "g" && c.attrs.transform), "oldest-first: lane lines are drawn as they were");
    p.byId("railorder").click(); await p.settle();
    assert.ok(topOf(q()) < topOf(lastRow()), "newest-first: the quiet calls are above the last stop");
    assert.ok(topOf(marks()[1]) < topOf(q()), "newest-first: the tail mark is at the top");
    assert.ok(topOf(marks()[0]) < topOf(lastRow()) || topOf(marks()[0]) > topOf(lastRow()), "the marker before d.txt is drawn");
    const firstRow = p.row("a.txt")!;
    assert.ok(parseFloat(String(origin().style.top)) > topOf(firstRow), "newest-first: the origin is at the bottom, past the oldest stop");
    const flip = svg().children.find((c) => c.tag === "g" && /scale\(1,-1\)/.test(c.attrs.transform ?? ""));
    assert.ok(flip, "newest-first: the lane lines and branches are drawn in time order, mirrored");
    assert.match(flip!.attrs.transform!, /translate\(0,\d+(\.\d+)?\)/);
    assert.ok(marks()[0]!.attrs["aria-label"]!.includes("above"), "the marker's label says which side its pass is on");
  });
});

describe("keys", () => {
  // where the current row sits (the playhead is gone; the selection is the row itself)
  const ph = (p: Awaited<ReturnType<typeof boot>>) => topOf(p.rows().find((r) => r.attrs["aria-current"] === "true"));
  it("ArrowUp and ArrowDown move up and down the screen in both orders; the other keys keep time order", async () => {
    for (const rev of [false, true]) {
      const p = await boot(pageModel, { hash: "#4", prefs: { railOrder: rev ? "newest-first" : "oldest-first" } });
      assert.equal(p.byId("railorder").attrs["aria-pressed"], String(rev), "the stored order is on");
      const y0 = ph(p), h0 = p.byId("h1").textContent;
      await p.press("ArrowUp");
      assert.ok(ph(p) < y0, `ArrowUp goes up the screen (newest-first: ${rev})`);
      await p.press("ArrowDown"); await p.press("ArrowDown");
      assert.ok(ph(p) > y0, `ArrowDown goes down the screen (newest-first: ${rev})`);
      await p.press("ArrowUp");
      assert.equal(p.byId("h1").textContent, h0);
      // Right/Left (and the bottom bar's arrows) are time: Right is the next stop in time, whichever way the rail runs
      const idxOf = () => p.model.stops.findIndex((s) => (s.title ?? s.head) === p.byId("h1").textContent);
      const i0 = idxOf();
      await p.press("ArrowRight");
      assert.ok(idxOf() > i0, `ArrowRight is forward in time (newest-first: ${rev})`);
      // the bottom bar's arrows (which replaced the rail's back and forward buttons) are time too, whichever way the rail runs
      p.byId("pbprev").click(); await p.settle();
      assert.equal(idxOf(), i0, `the bottom bar's back is back in time (newest-first: ${rev})`);
      p.byId("pbnext").click(); await p.settle();
      assert.ok(idxOf() > i0, `the bottom bar's forward is forward in time (newest-first: ${rev})`);
    }
  });
});

describe("arrow keys walk every step", () => {
  it("in both rail orders, the arrow that runs forward in time visits every step once, in time order (Right opens a command header on the way)", async () => {
    for (const rev of [false, true]) {
      const p = await boot(pageModel, { hash: "#1", prefs: { railOrder: rev ? "newest-first" : "oldest-first" } });
      const idxOf = () => p.model.stops.findIndex((s) => (s.title ?? s.head) === p.byId("h1").textContent);
      const seen = [idxOf()];
      for (let k = 0; k < 20; k++) {
        await p.press(rev ? "ArrowUp" : "ArrowDown");
        if (idxOf() < 0) await p.press("ArrowRight"); // a collapsed command header: Right opens it, its files are next in time
        const i = idxOf(); if (i >= 0 && i !== seen[seen.length - 1]) seen.push(i);
      }
      assert.ok(seen[0]! >= 0);
      assert.deepEqual(seen, p.model.stops.map((_, i) => i).slice(seen[0]), `every step from the first, in time order (newest-first: ${rev})`);
    }
  });
});

describe("the choice is kept", () => {
  it("pressing the button stores the order through the preferences route, as a partial object (clean is left alone)", async () => {
    const p = await boot(pageModel, { prefs: { clean: true } });
    p.byId("railorder").click(); await p.settle();
    assert.deepEqual(p.prefPosts, [{ railOrder: "newest-first" }]);
    assert.equal(p.prefs.clean, true);
  });

  it("a stored newest-first order is on at the first paint, with the button pressed", async () => {
    const p = await boot(pageModel, { prefs: { railOrder: "newest-first" } });
    assert.equal(p.byId("railorder").attrs["aria-pressed"], "true");
    const idx = dotsOrder(p).map(Number);
    assert.deepEqual(idx, [...idx].sort((a, b) => b - a));
  });

  it("no answer from the preferences route (older server, or a failure) leaves the default order and a working page", async () => {
    const p = await boot(pageModel, { prefs: { railOrder: "newest-first" }, noPrefs: true });
    assert.ok(p.rows().length > 3);
  });

  it("a live poll never resets the choice, and a stop that lands at the top neither moves the stop on show out of view nor out of place", async () => {
    const more = buildRailModel(timeline([
      call("k1", 1, "write a", [change("a", "a.txt", "k1")]),
      failed("f1", 2, "Fetch FRED", "Exit code 1"), failed("f2", 3, "Test the site", "Exit code 92"),
      call("k2", 4, "Rerun the fetch", [change("b", "b.txt", "k2"), change("c", "c.txt", "k2")]),
      call("k3", 5, "write d", [change("d", "d.txt", "k3")]),
      call("k4", 6, "write e", [change("e", "e.txt", "k4")]),
    ]));
    // at the top of the list the new row is shown and the stop on show is still in the window
    const a = await boot(pageModel, { live: true, hash: "#2", prefs: { railOrder: "newest-first" } });
    const sa = a.byId("scroller"); sa.clientHeight = 150; sa.scrollTop = 0;
    const topmost = () => [...a.rows()].sort((x, y) => topOf(x) - topOf(y))[0]!;
    await a.serve(more);
    assert.equal(a.byId("railorder").attrs["aria-pressed"], "true", "the poll did not reset the order");
    const rowsNow = a.rows();
    assert.ok(rowsNow.some((r) => r.textContent.includes("e.txt")), "the new stop arrived");
    assert.ok(topmost().textContent.includes("e.txt"), "the new stop landed at the top");
    const y = topOf(a.rows().find((r) => r.attrs["aria-current"] === "true")), top = Number(sa.scrollTop), h = Number(sa.clientHeight);
    assert.ok(y >= top && y <= top + h, `the stop on show (${y}) is in the window ${top}..${top + h}`);
    // scrolled down the list: the stop on show keeps its place on the screen when a row is added above it
    const b = await boot(pageModel, { live: true, hash: "#2", prefs: { railOrder: "newest-first" } });
    const sb = b.byId("scroller"); sb.clientHeight = 150; sb.scrollTop = 40;
    const offBefore = topOf(b.rows().find((r) => r.attrs["aria-current"] === "true")) - Number(sb.scrollTop);
    await b.serve(more);
    const offAfter = topOf(b.rows().find((r) => r.attrs["aria-current"] === "true")) - Number(sb.scrollTop);
    assert.equal(offAfter, offBefore, "the stop on show stays where it was on the screen");
    assert.equal(b.byId("railorder").attrs["aria-pressed"], "true");
  });
});
