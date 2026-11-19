import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The rail's rows, in review.js run in a vm with a DOM stub: one line per step (verb, then a name trimmed in the middle that keeps its tail),
// request section headers that quote the request's words, and one tab stop (roving tabindex) that the arrows, Home and End move.
// RAIL_ASSETS_ROOT points at another checkout's assets folder (red runs against the code before the change).
const ASSETS = process.env.RAIL_ASSETS_ROOT ?? new URL("../src/timeline/rail/assets/", import.meta.url).pathname;

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, text: string, changes: Change[] = []) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text, source: "agent-description", label: "l" }, agent: null });
const request = (id: string, at: number, text: string, calls: unknown[]) => ({
  id, index: 0, session: "s", texts: [{ text, source: "user", label: "what you typed" }], at, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run-" + id, rule: "x", files: [], callCount: calls.length, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls }],
});
const ASK1 = "Build the quarterly model and write a short memo about the cash flows, then check every figure against the filings";
const ASK2 = "Fix the summary";
const LONG_FILE = "spx_cashflows_quarterly_model_final.xlsx";
const NO_EXT = "reports/annual/2026/summary_of_the_whole_year_for_the_board";
const model = buildRailModel({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [
  request("r0", 1, ASK1, [call("k1", 2, "write the model", [change("a", LONG_FILE, "k1")]), call("k2", 3, "write a", [change("b", "a.txt", "k2")])]),
  request("r1", 10, ASK2, [call("k3", 11, "write the summary", [change("c", NO_EXT, "k3")])]),
] } as unknown as Timeline);

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; scrollTop = 0; clientHeight = 0;
  static doc: { activeElement: N | null } = { activeElement: null };
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  fire(k: string, e: Record<string, unknown> = {}) { (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this, ...e })); }
  click() { this.fire("click"); }
  focus() { N.doc.activeElement = this; } select() {} scrollIntoView() {} scrollTo() {} showModal() { this.open = true; } close() { this.open = false; }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

async function boot(m: RailModel) {
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const stops: Record<string, unknown> = {};
  for (const s of m.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  N.doc.activeElement = null;
  const document = {
    body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t),
    createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; },
    querySelectorAll: (sel: string) => (sel === ".row" ? byId("tl").children.filter((n) => has(n, "row")) : []),
    get activeElement() { return N.doc.activeElement; },
  };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval: () => 0, clearInterval() {},
    setTimeout: (f: () => void, ms: number) => (f.name === "poll" || ms === 6000 ? 0 : setTimeout(f, 0)), clearTimeout() {},
    fetch: async (u: string) => {
      if (u.includes("/review/preferences")) return json({ railOrder: "oldest-first" });
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(m)));
      if (u.includes("/review/status")) return json({ stops: JSON.parse(JSON.stringify(stops)), passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      if (u.includes("/view/")) return json({ change: "x", file: "f", engine: "e", kind: "card", before: [], after: [], boxes: [], caveats: [] });
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  g.localStorage = { getItem: () => null, setItem() {} };
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(ASSETS + f, "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const rows = () => byId("tl").children.filter((n) => has(n, "row"));
  const row = (text: string) => rows().find((r) => r.textContent.includes(text))!;
  const press = async (key: string, target: unknown) => { handlers.keydown!({ key, target, preventDefault() {} }); await settle(); };
  return { byId, rows, row, press, settle };
}
const cls = (r: N, c: string) => r.descendants().find((n) => has(n, c));

describe("rail rows", () => {
  it("a long name loses its middle and keeps its tail; the verb stays whole and apart from the name, for a file and for a name with no extension", async () => {
    const p = await boot(model);
    for (const [name, end] of [[LONG_FILE, ".xlsx"], [NO_EXT.split("/").pop()!, "for_the_board"]] as const) {
      const r = p.row(name.slice(-8));
      assert.ok(r, `a row for ${name}`);
      const verb = cls(r, "vb"), head = cls(r, "txh"), tail = cls(r, "txt");
      assert.equal(verb?.textContent.trim(), "Changed", "the verb is its own part, never trimmed");
      assert.ok(head && tail, "the name is split into a trimmed start and a kept tail");
      assert.ok(tail!.textContent.endsWith(end), `the tail keeps the end of the name: ${tail!.textContent}`);
      assert.equal(head!.textContent + tail!.textContent, name, "start and tail are the whole name, nothing lost or doubled");
      assert.ok(!head!.textContent.includes("Changed"), "the verb is not part of the trimmed start");
      assert.ok(r.attrs.title!.includes(name) && r.attrs["aria-label"]!.includes(name), "the whole name is on hover and for screen readers");
    }
  });

  it("each request is a section header quoting its words over its steps, selectable; rows carry no letter chip and there is no playhead", async () => {
    const p = await boot(model);
    const heads = p.rows().filter((r) => has(r, "req"));
    assert.equal(heads.length, 2, "one header per request");
    assert.equal(heads[0]!.textContent, `Request 1: ${ASK1}`, "the request's own words (CSS trims them to one line)");
    assert.equal(heads[1]!.textContent, `Request 2: ${ASK2}`);
    assert.equal(heads[0]!.attrs.title, `Request 1: ${ASK1}`, "the full words on hover");
    const top = (n: N) => parseFloat(String(n.style.top));
    const under = (h: N, next: N | undefined) => p.rows().filter((r) => !has(r, "req") && top(r) > top(h) && (!next || top(r) < top(next))).map((r) => r.textContent);
    assert.deepEqual(under(heads[0]!, heads[1]).filter((t) => /Changed/.test(t)).length, 2, "the first request's two changes sit under its header");
    assert.ok(under(heads[1]!, undefined).some((t) => t.includes("for_the_board")), "the second request's change sits under its header");
    assert.ok(!cls(heads[0]!, "mark"), "a header has no lane dot");
    heads[1]!.click(); await p.settle();
    assert.equal(heads[1]!.attrs["aria-current"] ?? p.row("Request 2").attrs["aria-current"], "true", "a header is a stop that can be selected");
    assert.equal(p.rows().flatMap((r) => r.descendants()).filter((n) => has(n, "chip")).length, 0, "no letter chips on rows");
    assert.equal(p.byId("tl").children.filter((n) => has(n, "ph") || has(n, "grip")).length, 0, "no playhead line or grip");
    assert.ok(!p.byId("legend").children.some((b) => b.attrs["data-g"] === "you"), "the person is no lane in the legend: requests are headers");
  });

  it("one tab stop: only the current row takes Tab; Up and Down move and select, focus follows; Home and End go to the ends", async () => {
    const p = await boot(model);
    const stops = () => p.rows().filter((r) => r.attrs.tabindex === "0");
    assert.equal(stops().length, 1, "exactly one row is in the tab order");
    assert.equal(stops()[0]!.attrs["aria-current"], "true", "and it is the current row");
    assert.ok(p.rows().filter((r) => r.attrs.tabindex !== "0").every((r) => r.attrs.tabindex === "-1"), "every other row is out of the tab order");
    const first = stops()[0]!; first.focus();
    const at = () => p.rows().findIndex((r) => r.attrs["aria-current"] === "true");
    const was = at();
    await p.press("ArrowDown", first);
    assert.equal(at(), was + 1, "Down selects the next row");
    const now = p.rows()[at()]!;
    assert.equal(now.attrs.tabindex, "0"); assert.equal(stops().length, 1, "still one tab stop");
    assert.equal((p.byId("tl") as unknown as { children: N[] }).children.includes(N.doc.activeElement!) && N.doc.activeElement!.attrs["aria-current"], "true", "focus moved with the selection");
    await p.press("ArrowUp", N.doc.activeElement);
    assert.equal(at(), was, "Up goes back");
    await p.press("End", N.doc.activeElement);
    assert.equal(at(), p.rows().length - 1, "End goes to the last row");
    await p.press("Home", N.doc.activeElement);
    assert.equal(at(), 0, "Home goes to the first row");
    assert.equal(N.doc.activeElement!.attrs["aria-current"], "true");
  });
});
