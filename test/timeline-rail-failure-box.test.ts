import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { stopIdentities, summarize } from "../src/timeline/rail/stop-status.ts";
import { buildSendBack } from "../src/timeline/rail/send-back.ts";

// A failed change's line on the page. The page code runs as is in a vm with a DOM stub (as test/timeline-rail-keys.test.ts does):
// the failure shows under the heading, plain; the output's exact words sit behind "Show output"; and the line never reaches the
// send-back prompt or the review summary.

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, any> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; focused = false; nodeType = 1;
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


const RAW = Array.from({ length: 9 }, (_, i) => `line ${i + 1} <b>not markup</b>`).join("\n");
const VIEW = { change: "k1", file: "a.xlsx", engine: "", kind: "card", before: [], after: [], boxes: [], caveats: [] };
const failStop = (blurb: string, hasText = true) => ({
  id: "chg-k1", label: "a.xlsx", lane: "main", head: "Claude changed a.xlsx",
  change: { key: "k1", file: "a.xlsx", kind: "modified", note: "Changed a.xlsx.", rowNotes: [], moreNote: null, viewUrl: "/timeline/7/view/k1", secret: false, secretLine: null, failed: "The call that changed a.xlsx failed.", ask: null, newFile: null, treeBefore: null, treeAfter: null },
  failure: { blurb, raw: hasText ? RAW : blurb, hasText },
});

async function boot(hasText = true) {
  const model: any = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops: [failStop("line 1 <b>not markup</b>", hasText)] };
  const served = JSON.parse(JSON.stringify(model));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const timers: Array<() => void> = [];
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener() {}, setInterval, clearInterval, setTimeout: (f: () => void, ms: number) => { if (f.name === "poll") return 0; /* the idle poll is not a line being asked for */ timers.push(f); return timers.length; },
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? JSON.parse(JSON.stringify(served)) : u.includes("/view/") ? VIEW : {}) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  const line = byId("h2");
  const find = (cls: string): N | undefined => line.descendants().find((n) => n.className.split(/\s+/).includes(cls));
  const output = (): N | undefined => line.descendants().find((n) => n.tag === "pre");
  const button = (): N | undefined => line.descendants().find((n) => n.tag === "button");
  return { find, output, button, timers, line, text: () => line.textContent, notes: () => byId("notes").textContent };
}

describe("a failed change's line", () => {
  it("the failure shows plain under the heading, and the output stays behind Show output", async () => {
    const p = await boot();
    assert.match(p.text(), /^line 1 <b>not markup<\/b>/);
    assert.ok(p.find("plainline"));
    assert.doesNotMatch(p.text() + p.notes(), /\bAI\b|From the host|the host/);
    assert.doesNotMatch(p.notes(), /The call failed/, "no separate failure card beside the panes");
    const raw = p.output()!;
    assert.equal(raw.hidden, true, "the output is hidden until asked for");
    const btn = p.button()!;
    assert.equal(btn.attrs.type, "button");
    assert.equal(btn.textContent, "Show output");
    btn.click();
    assert.equal(raw.hidden, false);
    assert.equal(raw.textContent, RAW, "exactly the output: all 9 lines, markup left as text");
    btn.click();
    assert.equal(raw.hidden, true);
  });

  it("when the output said nothing, CoCheck's sentence stands alone with no button", async () => {
    const p = await boot(false);
    assert.match(p.text(), /line 1 <b>not markup<\/b>/);
    assert.equal(p.button(), undefined);
  });

  it("the page does not ask for the model again for the line", async () => {
    const p = await boot();
    assert.equal(p.timers.length, 0);
  });
});

describe("the failure line never reaches the send-back prompt or the review summary", () => {
  it("quotes the stop as before, with no line text", () => {
    const c: any = { id: "c1", file: "/work/budget.xlsx", kind: "modified", before: { sha256: "b" }, after: { sha256: "a" }, note: { text: "Changed budget.xlsx.", source: "rule" }, format: null };
    const stop: any = { id: "chg-c1", label: "budget.xlsx", head: "Claude changed /work/budget.xlsx", lane: "main", change: { key: "c1", file: c.file, kind: c.kind, note: "Changed budget.xlsx.", rowNotes: [], secret: false },
      failure: { blurb: "BLURBMARK the save was refused", raw: "RAWMARK permission denied" } };
    const timeline: any = { unplaced: [c], requests: [] };
    const model: any = { task: 7, folder: "/work", actors: [], stops: [stop] };
    const ids = stopIdentities(model, timeline);
    const rows = [{ id: 1, taskId: 7, stopId: "chg-c1", subject: ids.get("chg-c1")!.subject, fingerprint: ids.get("chg-c1")!.fingerprint, status: "failed" as const, note: "wrong", reviewer: "t", ts: "2026-10-12T00:00:00.000Z" }];
    const summary = summarize(model, timeline, rows);
    const out = buildSendBack(model, timeline, summary);
    assert.doesNotMatch(out.prompt + JSON.stringify(summary), /BLURBMARK/);
    assert.match(out.prompt, /Claude changed \/work\/budget\.xlsx/);
  });
});
