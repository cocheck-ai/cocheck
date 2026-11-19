import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { toolLabel } from "../src/tool-label.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

// The page control "Show from your transcript" and the model's reveal list. The model carries call ids and field names only, never text;
// the page draws a revealed text in place, never stores it, and says plainly when the server returns nothing.
const SECRET = "password: hunter22";
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

async function boot(model: RailModel, reveal: (u: string, init?: { method?: string; body?: string }) => unknown = () => ({}), calls: string[] = []) {
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (ms === 6000 || f.name === "poll" ? 0 : setTimeout(f, 0)), clearTimeout() {},
    fetch: async (u: string, init?: { method?: string; body?: string }) => {
      if (u.includes("/review/reveal")) { calls.push(`${init?.method} ${u} ${init?.body}`); const r = reveal(u, init) as { ok: boolean; text?: string } | null; return r === null ? Promise.reject(new Error("net")) : { ok: r.ok, status: r.ok ? 200 : 404, json: async () => ({ text: r.text }) }; }
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      const v = /\/view\/([^?]+)/.exec(u);
      if (v) return json(decodeURIComponent(v[1]!) === "t" ? {} : {});
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
  return { byId, go, ai, shown, settle };
}



const pageModel = (reveal: Array<{ call: string; field: string }>): RailModel => ({ task: 7, folder: "work", actors: [{ id: "claude", name: "Claude", chip: "C", color: "#6fb0e3", main: true }],
  stops: [{ id: "start-1", label: "Started Helper 1", lane: "claude", head: "Started Helper 1 to fetch", brief: { by: "Claude", lines: [], withheld: true }, reveal }] } as unknown as RailModel);

describe("the page control", () => {
  it("a click posts the call and field, draws the text in place, and writes nothing to storage", async () => {
    const calls: string[] = [];
    const p = await boot(pageModel([{ call: "toolu_1", field: "prompt" }]), () => ({ ok: true, text: `${SECRET}\nand more` }), calls);
    await p.go("Started Helper 1");
    const btn = p.byId("bodyview").descendants().find((n) => n.tag === "button" && /Show from your transcript/.test(n.textContent))!;
    assert.ok(btn);
    assert.match(p.byId("bodyview").textContent, /withheld because it looked like it held a secret/);
    assert.ok(!p.byId("bodyview").textContent.includes("hunter22"));
    btn.click(); await p.settle();
    assert.deepEqual(calls, ['POST /timeline/7/review/reveal?t=tok {"call":"toolu_1","field":"prompt"}']);
    assert.match(p.byId("bodyview").textContent, /hunter22/);
    assert.equal(btn.hidden, true);
    // no storage object exists in the page's world, and the page source never names one
    // The viewer's own two choices (theme, quiet rows) are the one place the page writes to storage, in the block between these two comments; nothing else may
    const js = await readFile(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    const prefs = js.slice(js.indexOf("/* two choices that belong to the viewer"), js.indexOf("/* The newest-first order: the rail"));
    assert.ok(prefs.includes("localStorage"), "the prefs block is where it sits");
    assert.doesNotMatch(js.replace(prefs, ""), /localStorage|sessionStorage|indexedDB/);
  });
  it("a refusal or a network failure says the text is not available and shows nothing", async () => {
    for (const reply of [{ ok: false }, null]) {
      const p = await boot(pageModel([{ call: "toolu_1", field: "prompt" }]), () => reply);
      await p.go("Started Helper 1");
      const btn = p.byId("bodyview").descendants().find((n) => n.tag === "button" && /Show from your transcript/.test(n.textContent))!;
      btn.click(); await p.settle();
      assert.match(p.byId("bodyview").textContent, /The text is not available from your transcript\./);
      assert.ok(!p.byId("bodyview").textContent.includes("hunter22"));
    }
  });
  it("a step with nothing to reveal has no control", async () => {
    const p = await boot(pageModel([]));
    await p.go("Started Helper 1");
    assert.ok(!p.byId("bodyview").descendants().some((n) => n.tag === "button" && /transcript/.test(n.textContent)));
  });
});

// ---- the model ----
const c = (id: string, seq: number, extra: Record<string, unknown>, tool: string) => call(id, { session: "s1", tool, desc: id, at: seq * 10, named: [], extra: { startSeq: seq, ...extra } });
const modelOf = (ops: ReturnType<typeof call>[]) => buildRailModel(buildTimeline({ taskId: 1, build: "t", ops, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false }));
const rec = (text: string, withLocator = true) => ({ family: "name-assignment", sha256: "a".repeat(64), ...(withLocator ? { locator: { file: "/p/s.jsonl", id: "X" } } : {}) });
describe("the model lists what can be revealed, by call id and field name only", () => {
  const withOps = (label: Record<string, unknown>, tool: string) => modelOf([prompt("s1", ["Go."], { requests: [{ seq: 1, at: 10, firstStep: null }] }), c("S1", 2, { toolLabel: label }, tool), stop("s1", "ok")]);
  it("a withheld message with a locator carries reveal for that field; the model JSON holds no text", () => {
    const m = withOps({ fields: { to: "lead" }, dropped: { message: "secret-looking value, not recorded" }, withheld: { message: rec(SECRET) } }, "SendMessage");
    const s = m.stops.find((x) => x.label?.startsWith("Message"))!;
    assert.deepEqual(s.reveal, [{ call: "S1", field: "message" }]);
    assert.ok(!JSON.stringify(m).includes("hunter22"));
  });
  it("a withheld message with no locator (an older record, a host with none) carries no reveal", () => {
    const m = withOps({ fields: { to: "lead" }, dropped: { message: "secret-looking value, not recorded" }, withheld: { message: rec(SECRET, false) } }, "SendMessage");
    assert.equal(m.stops.find((x) => x.label?.startsWith("Message"))!.reveal, undefined);
  });
  it("an unflagged message carries no reveal", () => {
    const m = withOps({ fields: { to: "lead", message: "Memo done." } }, "SendMessage");
    assert.equal(m.stops.find((x) => x.label?.startsWith("Message"))!.reveal, undefined);
  });
});
