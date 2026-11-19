import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { buildPasses } from "../src/timeline/rail/passes.ts";
import { stopIdentities } from "../src/timeline/rail/stop-status.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// the page draws a marker across the rail at each send-back and submission, a small chip on each tagged stop, the tag in the stop's header,
// and a two-way link between a rework and the stop it answers. Links are buttons (Tab and Enter), space on them is the button's own, and the
// typing guard is untouched. The page code runs as is in a vm with a DOM stub; the status answer is built from the real pure code.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, at: number): Change => ({ id, file, outside: false, at, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref(id.padEnd(64, "b")), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: 1, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [change("c1", "a.xlsx", 1000), change("c2", "b.xlsx", 2000), change("c4", "a.xlsx", 5000), change("c5", "b.xlsx", 6000)], line: { text: "t", source: "agent-description", label: "l" } }] }] }] } as unknown as Timeline;

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; focused = false; nodeType = 1; disabled = false; value = "";
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { focusedNode = this; }
  scrollIntoView() {}
  scrollTo() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
let focusedNode: N | null = null;
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
const idOf = (file: string) => buildRailModel(tl).stops.find((s) => s.change?.file === file)!.id;
const ids = stopIdentities(buildRailModel(tl), tl);
const row = (stop: string, status: "failed" | "passed", ms: number) => ({ id: 1, taskId: 7, stopId: stop, subject: ids.get(stop)!.subject, fingerprint: ids.get(stop)!.fingerprint, status, note: "wrong", reviewer: "t", ts: new Date(ms).toISOString() });
const passes = buildPasses(buildRailModel(tl), tl, [row("chg-c1", "failed", 3000), row("chg-c2", "passed", 3000)], [{ id: 1, taskId: 7, prompt: "p", stopIds: [], reviewer: "t", note: "", nonce: null, ts: new Date(4000).toISOString() }], []);
void idOf;

async function boot(opts: { passes?: unknown; hash?: string; model?: unknown } = {}) {
  focusedNode = null;
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const spy = { moves: 0, intervals: [] as unknown[] };
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const status = { stops: {}, passes: opts.passes === undefined ? passes : opts.passes, anyFailed: true, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true }, submitState: "none", submitted: null, earlier: [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: opts.hash ?? "" }, history: { replaceState() { spy.moves++; } }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; },
    setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); if (ms === 2600) spy.intervals.push(id); return id; }, clearInterval,
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? (opts.model ?? model) : u.includes("/review/status") ? status : { change: "x", file: "f", engine: "e", kind: "card", before: [], after: [], boxes: [], caveats: [] }) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  const press = async (k: string, target: unknown) => { let prevented = false; handlers.keydown!({ key: k, target, preventDefault() { prevented = true; } }); await settle(); return prevented; };
  const links = () => byId("ptag").descendants().filter((n) => has(n, "stoplink"));
  const cleanup = () => spy.intervals.forEach((i) => clearInterval(i as never));
  return { byId, press, spy, links, settle, cleanup, ptag: () => byId("ptag"), h1: () => byId("h1").textContent };
}
// the page's steps are the model's stops with a header step above each run of changes from one call; the rail rows and #n count those.
const pageSteps = (() => {
  const out: string[] = [];
  const st = model.stops as Array<{ id: string; call?: { id: string } }>;
  for (let i = 0; i < st.length; ) {
    let j = i + 1;
    while (st[i]!.call && j < st.length && st[j]!.call?.id === st[i]!.call!.id) j++;
    if (st[i]!.call && j - i > 1) out.push(`hdr:${st[i]!.call!.id}`);
    for (let k = i; k < j; k++) out.push(st[k]!.id);
    i = j;
  }
  return out;
})();
const indexOf = (stop: string) => pageSteps.indexOf(stop);
const headOf = (stop: string) => model.stops.find((s: { id: string }) => s.id === stop).title;

describe("the markers and chips on the rail", () => {
  it("draws a marker line labelled 'Sent back for review' across the rail", async () => {
    const p = await boot();
    try {
      const marks = p.byId("tl").children.filter((n) => has(n, "pmark"));
      assert.deepEqual(marks.map((m) => m.textContent), ["Sent back for review"]);
      assert.match(marks[0]!.attrs["aria-label"]!, /Sent back for review/);
    } finally { p.cleanup(); }
  });
  it("puts a small chip on each tagged stop and on no other", async () => {
    const p = await boot();
    try {
      const rows = p.byId("tl").children.filter((n) => has(n, "row"));
      const chipOf = (stop: string) => rows.find((r) => r.attrs["data-i"] === String(indexOf(stop)))!.descendants().filter((n) => has(n, "tg")).map((n) => n.textContent);
      assert.deepEqual(["chg-c1", "chg-c2", "chg-c4", "chg-c5"].map(chipOf), [[], [], ["rework"], ["touches passed"]]);
    } finally { p.cleanup(); }
  });
  it("with no passes in the status answer nothing is drawn: no marker, no chip, no tag line", async () => {
    const p = await boot({ passes: { markers: [], tags: {}, answeredBy: {} } });
    try {
      assert.equal(p.byId("tl").children.filter((n) => has(n, "pmark")).length, 0);
      assert.equal(p.byId("tl").descendants().filter((n) => has(n, "tg")).length, 0);
      assert.equal(p.ptag().hidden, true);
    } finally { p.cleanup(); }
  });
});

describe("the tag in the header and the two-way link", () => {
  it("a rework says so in its header, with a link to the stop it answers; clicking it jumps there, and that stop links forward", async () => {
    const p = await boot({ hash: `#${indexOf("chg-c4")}` });
    try {
      assert.equal(p.ptag().hidden, false);
      assert.match(p.ptag().textContent, /Reworks a stop you failed/);
      assert.match(p.ptag().textContent, /after .Sent back for review./);
      const [back] = p.links();
      assert.match(back!.textContent, /^Go to the step it answers/);
      assert.equal(back!.tag, "button", "a button is reachable with Tab and works with Enter");
      back!.click(); await p.settle();
      assert.equal(p.h1(), headOf("chg-c1"));
      assert.match(p.ptag().textContent, /Reworked by a later step/);
      const [fwd] = p.links();
      assert.match(fwd!.textContent, /^Go to the rework/);
      assert.equal(focusedNode, fwd, "focus lands on the link back, so Enter returns");
      fwd!.click(); await p.settle();
      assert.equal(p.h1(), headOf("chg-c4"));
    } finally { p.cleanup(); }
  });
  it("'changes something you passed' is a warning with no link; a stop before the marker has no tag line", async () => {
    const p = await boot({ hash: `#${indexOf("chg-c5")}` });
    try {
      assert.match(p.ptag().textContent, /Changes something you passed/);
      assert.ok(p.ptag().descendants().some((n) => has(n, "changes_passed")));
      assert.equal(p.links().length, 0);
      const q = await boot({ hash: `#${indexOf("chg-c2")}` });
      try { assert.equal(q.ptag().hidden, true); } finally { q.cleanup(); }
    } finally { p.cleanup(); }
  });
});

describe("keys", () => {
  it("space or Enter on a link is the button's own: no play, no step, not prevented; the guard still holds", async () => {
    const p = await boot({ hash: `#${indexOf("chg-c4")}` });
    try {
      const inLinks = { tagName: "BUTTON", closest: (sel: string) => (sel.split(",").map((x) => x.trim()).includes(".ptag") ? {} : null) };
      assert.equal(await p.press(" ", inLinks), false, "space would otherwise play and be swallowed");
      assert.equal(await p.press("Enter", inLinks), false);
      assert.equal(p.spy.intervals.length, 0);
      for (const target of [{ tagName: "TEXTAREA" }, { tagName: "INPUT" }]) assert.equal(await p.press(" ", target), false);
      assert.equal(p.spy.intervals.length, 0);
    } finally { p.cleanup(); }
  });
});

describe("the page shell", () => {
  it("has the tag line in the header and nothing from the record in it", () => {
    const html = renderReviewShell(7);
    assert.match(html, /<p class="ptag" id="ptag" hidden><\/p>/);
  });
});

// The look-here marker: drawn from the stop's own `look` flag, next to (never instead of) a pass tag, on no stop without it.
// an icon-only mark (no wrapping word), its reason in the tooltip and aria-label, and the row's aria-label still says it.
describe("the look-here marker (deleted, not replaced)", () => {
  it("draws no marker even on a stop an old model marks; the pass tags stay", async () => {
    const m = JSON.parse(JSON.stringify(model)) as { stops: Array<{ id: string; look?: boolean }> };
    for (const s of m.stops) { delete s.look; if (s.id === "chg-c4" || s.id === "chg-c1") s.look = true; }
    const p = await boot({ model: m });
    try {
      const rows = p.byId("tl").children.filter((n) => has(n, "row"));
      const row = (stop: string) => rows.find((r) => r.attrs["data-i"] === String(indexOf(stop)))!;
      const chips = (stop: string) => row(stop).descendants().filter((n) => has(n, "tg") || has(n, "look")).map((n) => (has(n, "look") ? "[look]" : n.textContent));
      assert.deepEqual(["chg-c1", "chg-c2", "chg-c4", "chg-c5"].map(chips), [[], [], ["rework"], ["touches passed"]]);
      for (const stop of ["chg-c1", "chg-c4"]) assert.doesNotMatch(row(stop).attrs["aria-label"], /Look here/);
    } finally { p.cleanup(); }
  });
});
