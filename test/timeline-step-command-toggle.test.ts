import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildTimeline, type FormatChanges, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// a file-change step shows the description and the collapsed "Show command" of the call(s) credited with it, under the step
// heading, the same control the "N calls, no change" view draws. The command text is only ever what the server's command route answers
// (scrubbed there); the timeline body carries none. Must not happen: a raw command in the model/body, or an uncredited step showing a command.

const FILE = "/w/package.json";
const FMT: FormatChanges = { module: "xlsx", rows: [], more: 0 };
const RAW = "npm init -y && echo sk-RAWSECRET-123";
const SCRUBBED = "npm init -y && echo [hidden]";
const goodView = { change: "x", file: "package.json", engine: "drawn by CoCheck", kind: "diff", before: [{ id: "p", label: "S", text: { lines: [{ n: 1, text: "old", box: null }] } }], after: [{ id: "p", label: "S", text: { lines: [{ n: 1, text: "new", box: null }] } }], boxes: [], caveats: [] };

const build = (credited: string[], extra: RawOp[] = [], withState = true): RailModel => {
  const ops: RawOp[] = [prompt("s1", ["Set it up."]), call("c1", { at: 10, end: 40, cmd: RAW, desc: "Initialize npm and git" }), call("c2", { at: 12, end: 41, cmd: RAW, desc: "Create the module" }), ...extra, stop("s1")];
  const st: RawState = { ...state(FILE, "n1", "n0", { open: ["c1", "c2"], credited }), credit_basis: "argv-tag" };
  const input = { taskId: 1, build: "b", ops, fileStates: withState ? [st] : [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map([[st.id, FMT]]), quickLook: false, host: "claude" } as TimelineInput;
  return buildRailModel(JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline);
};

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

async function open(model: RailModel, fetched: string[], hash: string) {
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => JSON.parse(JSON.stringify(v)) });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (ms === 6000 || f.name === "poll" ? 0 : setTimeout(f, 0)), clearTimeout() {},
    fetch: async (u: string) => {
      fetched.push(u);
      if (u.includes("/review/model")) return json(model);
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], el: 0 } });
      if (/\/call\/[^/]+\/command/.test(u)) return json({ command: SCRUBBED });
      if (u.includes("/view/")) return json(goodView);
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  return { byId, settle };
}
const toggles = (n: N) => n.descendants().filter((x) => x.tag === "button" && /(Show|Hide) command/.test(x.textContent));
const pres = (n: N) => n.descendants().filter((x) => x.tag === "pre");
const stepHash = (m: RailModel) => "#" + m.stops.findIndex((s) => s.change);

describe("a file step shows the credited call's description and a collapsed command", () => {
  it("the shell has the slot under the heading", () => { assert.match(renderReviewShell(7), /id="hcalls"/); });
  it("one shell call: description shown, collapsed, a click fetches the route and shows the server's text", async () => {
    const model = build(["c1"]);
    assert.doesNotMatch(JSON.stringify(model), /RAWSECRET/, "the model carries no command");
    const fetched: string[] = [];
    const p = await open(model, fetched, stepHash(model));
    const box = p.byId("hcalls");
    assert.equal(box.hidden, false);
    assert.match(box.textContent, /Initialize npm and git/);
    assert.doesNotMatch(box.textContent, /Create the module/);
    const btn = toggles(box); assert.equal(btn.length, 1); assert.equal(btn[0]!.textContent, "Show command");
    assert.equal(pres(box)[0]!.hidden, true, "collapsed by default");
    assert.equal(fetched.some((u) => /\/command/.test(u)), false, "nothing fetched before the click");
    btn[0]!.click(); await p.settle();
    assert.ok(fetched.includes("/timeline/7/call/c1/command?t=tok"), fetched.join(" "));
    assert.equal(pres(box)[0]!.hidden, false);
    assert.equal(pres(box)[0]!.textContent, SCRUBBED);
    assert.doesNotMatch(box.textContent, /RAWSECRET/);
    assert.equal(btn[0]!.textContent, "Hide command");
  });
  it("two credited calls: each listed with its own toggle", async () => {
    const model = build(["c1", "c2"]);
    const p = await open(model, [], stepHash(model));
    const box = p.byId("hcalls");
    assert.match(box.textContent, /Initialize npm and git/); assert.match(box.textContent, /Create the module/);
    assert.equal(toggles(box).length, 2);
  });
  it("no credited call: nothing shown, and moving to it from a credited step clears the slot", async () => {
    const model = build([]);
    const p = await open(model, [], stepHash(model));
    const box = p.byId("hcalls");
    assert.equal(box.hidden, true); assert.equal(toggles(box).length, 0); assert.equal(box.textContent, "");
  });
});

describe("W-C3: a call that ran no command has no Show command link", () => {
  const withWrite = (): RailModel => {
    const ops: RawOp[] = [prompt("s1", ["Write it."]), call("w1", { tool: "Write", at: 10, end: 40, cmd: "Write", desc: "Create the module" }), call("c2", { at: 12, end: 41, cmd: RAW, desc: "Run it" }), stop("s1")];
    const st: RawState = { ...state(FILE, "n1", "n0", { open: ["w1", "c2"], credited: ["w1", "c2"] }), credit_basis: "argv-tag" };
    const input = { taskId: 1, build: "b", ops, fileStates: [st], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map([[st.id, FMT]]), quickLook: false, host: "claude" } as TimelineInput;
    return buildRailModel(JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline);
  };
  it("the Write call is listed with no toggle; the shell call beside it keeps its toggle (a real command never loses its link)", async () => {
    const model = withWrite();
    const p = await open(model, [], stepHash(model));
    const box = p.byId("hcalls");
    assert.match(box.textContent, /Create the module/);
    assert.match(box.textContent, /Run it/);
    assert.equal(toggles(box).length, 1, "only the shell call has a Show command link");
    assert.equal(pres(box).length, 1);
  });
  it("the model marks only the call with no command", () => {
    const model = withWrite();
    const calls = model.stops.find((s) => s.change)!.calls!;
    assert.deepEqual(calls.map((c) => [c.id, c.noCommand === true]), [["w1", true], ["c2", false]]);
  });
});

describe("the no-change view is unchanged", () => {
  it("a quiet-call row still opens its calls with description, collapsed command and the same fetch", async () => {
    const model = build(["c1"], [call("q1", { tool: "Read", at: 50, end: 51, cmd: RAW, desc: "Read the notes" })]);
    const fetched: string[] = [];
    const p = await open(model, fetched, stepHash(model));
    const line = p.byId("tl").descendants().find((n) => /qline/.test(n.className));
    assert.ok(line, "a quiet line on the rail");
    line!.click(); await p.settle();
    const view = p.byId("bodyview");
    assert.match(p.byId("h1").textContent, /commands?, no file changed/);
    assert.match(view.textContent, /Read the notes/);
    assert.equal(toggles(p.byId("hcalls")).length, 0, "the file step's calls are gone in this view");
    const b = toggles(view); assert.ok(b.length >= 1); assert.ok(pres(view).every((x) => x.hidden), "all collapsed");
    b[b.length - 1]!.click(); await p.settle();
    assert.ok(fetched.includes("/timeline/7/call/q1/command?t=tok"));
    assert.equal(pres(view)[pres(view).length - 1]!.textContent, SCRUBBED);
  });
});
