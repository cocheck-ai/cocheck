import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import type { Change, FormatRow, Timeline } from "../src/timeline/timeline.ts";

// Below 1100 px the rail is a collapsible sidebar with a toolbar toggle: collapsed by default, closed by Escape, a chosen row or a click outside; focus goes in on open and back to the toggle on close.

const ref = (s: string) => ({ sha256: s.repeat(64).slice(0, 64), size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const changeWith = (file: string, rows: FormatRow[], over: Record<string, unknown> = {}): Change => ({ id: "c1", file, outside: false, at: null, kind: "modified", step: 1, before: ref("a"), after: ref("b"), credit: { calls: ["k1"], joint: false, text: "x" }, note: { text: "Claude changed d.docx", source: "rule" }, format: { module: "files", rows, more: 0 }, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: "label" }, ...over }) as unknown as Change;
const timelineOf = (c: Change): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "k1", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [c], line: { text: "Edit it", source: "agent-description", label: "l" }, agent: null }] }] }] } as unknown as Timeline);


class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; listeners: Record<string, Array<(e: unknown) => void>> = {};
  parentNode: N | null = null; className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; focused = 0;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const k of c) k.parentNode = this; this.children.push(...c); }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { focusedNode = this; } select() {} scrollIntoView() {} scrollTo() {} showModal() {} close() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest() { return null; }
  offsetTop = 0;
  getBoundingClientRect() { return { top: 0, left: 0, right: 50, height: 4, width: 50, bottom: 4 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
let focusedNode: N | null = null;
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

const SHA = "a".repeat(64);
const view = { change: "c1", file: "d.docx", engine: "drawn by LibreOffice", kind: "pages", before: [], after: [{ id: "after:p1", label: "p", picture: { sha: SHA, width: 100, height: 100, page: 1 } }], caveats: [], boxes: [] };

async function boot(width: number) {
  const model = buildRailModel(timelineOf(changeWith("d.docx", [])));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const mk = (t: string): N => mkNode(t);
  const document = { body, getElementById: byId, createElement: mk, createElementNS: (_: string, t: string) => mk(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const ev: Record<string, Array<(e: unknown) => void>> = {};
  const g: Record<string, any> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: width, URLSearchParams, console, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    addEventListener(k: string, f: (e: unknown) => void) { (ev[k] ??= []).push(f); }, requestAnimationFrame: (f: () => void) => { f(); return 1; },
    fetch: async (u: string) => {
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      if (/\/view\//.test(u)) return json(view);
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const key = (k: string) => (ev.keydown ?? []).forEach((f) => f({ key: k, target: byId("tl"), preventDefault() {}, stopPropagation() {} }));
  const clickAt = (t: N) => (ev.click ?? []).forEach((f) => f({ target: t, stopPropagation() {} }));
  return { byId, settle, key, clickAt, ev, g };
}
const isOpen = (d: Awaited<ReturnType<typeof boot>>) => d.byId("railtoggle").getAttribute("aria-expanded") === "true";

describe("the rail below 1100 px is a sidebar behind a toolbar toggle", () => {
  it("the shell has a toggle after the logo, labelled and collapsed", async () => {
    const html = renderReviewShell(7);
    assert.match(html, /<a class="wordmark"[\s\S]*?<\/a>\s*<button type="button" class="railtoggle" id="railtoggle" aria-label="Show steps"[^>]*aria-expanded="false" aria-controls="railcol"/);
  });
  it("the toggle is hidden at 1100 px and wider, and the narrow rules make the rail an overlay, never stacked", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /\.railtoggle\{display:none/);
    assert.match(css, /@media \(max-width:1099px\)\{[^@]*\.railtoggle\{display:inline-flex/);
    assert.match(css, /@media \(max-width:1099px\)\{[^@]*\.railcol\{position:fixed/);
    assert.doesNotMatch(css, /max-width:1180px\)\{[^@]*\.rail\{position:static/);
  });
  it("opens on the toggle, with aria-expanded, a changed label and focus inside the rail", async () => {
    const d = await boot(1000);
    assert.ok(!isOpen(d), "collapsed until asked (the shell's markup holds the initial state)");
    d.byId("railtoggle").click();
    assert.ok(isOpen(d));
    assert.equal(d.byId("railtoggle").getAttribute("aria-label"), "Hide steps");
    assert.match(d.byId("railcol").className, /\bopen\b/);
    assert.ok(focusedNode && focusedNode.parentNode === d.byId("tl"), "focus is on a rail row");
    assert.equal(focusedNode!.getAttribute("tabindex"), "0", "the roving tab stop");
  });
  it("Escape closes it and focus returns to the toggle", async () => {
    const d = await boot(1000);
    d.byId("railtoggle").click(); d.key("Escape");
    assert.ok(!isOpen(d)); assert.doesNotMatch(d.byId("railcol").className, /\bopen\b/);
    assert.equal(focusedNode, d.byId("railtoggle"));
  });
  it("choosing a step row closes it", async () => {
    const d = await boot(1000);
    d.byId("railtoggle").click();
    const row = d.byId("tl").children.find((r) => r.className.split(/\s+/).includes("row") && !r.className.includes("hdr"))!;
    row.click();
    assert.ok(!isOpen(d)); assert.equal(focusedNode, d.byId("railtoggle"));
  });
  it("a click outside closes it, a click inside does not", async () => {
    const d = await boot(1000);
    d.byId("railtoggle").click();
    d.byId("tl").parentNode = d.byId("railcol");
    d.clickAt(d.byId("tl"));
    assert.ok(isOpen(d), "inside the rail");
    d.clickAt(d.byId("stage"));
    assert.ok(!isOpen(d), "outside");
  });
  it("widening the window to 1100 px closes it", async () => {
    const d = await boot(1000);
    d.byId("railtoggle").click();
    d.g.innerWidth = 1100; (d.ev.resize ?? []).forEach((f) => f({}));
    assert.ok(!isOpen(d));
  });
});
