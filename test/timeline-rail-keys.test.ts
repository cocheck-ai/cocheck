import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// while focus is in an editable element (textarea, input, select, contenteditable) the rail's global key handler leaves every key alone: no
// play/pause, no stop step, no sheet step, and no preventDefault (which would swallow the character). Outside editable elements every shortcut
// works as before. The page code runs as is in a vm with a DOM stub; the spies count what the handler did.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [change("c1", "book.xlsx")], line: { text: "t", source: "agent-description", label: "l" } }] }] }] } as unknown as Timeline;

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

// the page draws no sheet, so the tabs are pinned on text panes, the multi-pane view that keeps them
const pane = (side: string, sheet: string, text: string) => ({ id: `${side}:${sheet}`, label: sheet, text: { lines: [{ n: 1, text, kind: null, marks: [] }] } });
const box = (side: string, sheet: string) => ({ side, pane: `${side}:${sheet}`, line: 1, change: "c1", confidence: "exact" });
const view = (o: Record<string, unknown>) => ({ change: "c1", file: "book.xlsx", engine: "drawn by CoCheck", kind: "pages", before: [], after: [], boxes: [], caveats: [], ...o });
const isOn = (n: N) => n.className.split(/\s+/).includes("on");
const isChg = (n: N) => n.className.split(/\s+/).includes("chg");
const visibleText = (ws: N[]) => ws.filter((w) => !w.hidden).map((w) => w.textContent).join("|");

// Sheets: Cover (no change), Data (changed), Totals (changed).
const three = view({
  before: ["Cover", "Data", "Totals"].map((s) => pane("before", s, `${s} old`)),
  after: ["Cover", "Data", "Totals"].map((s) => pane("after", s, `${s} new`)),
  boxes: [box("after", "Data"), box("before", "Data"), box("after", "Totals")],
});

async function boot() {
  const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const spy = { moves: 0, intervals: [] as unknown[] };
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "#1" }, history: { replaceState() { spy.moves++; } }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; },
    setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); if (ms === 2600) spy.intervals.push(id); return id; }, clearInterval,
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? model : servedFor(three, model, u)) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  const press = async (k: string, target: unknown) => { let prevented = false; handlers.keydown!({ key: k, target, preventDefault() { prevented = true; } }); await settle(); return prevented; };
  // no start stop; the page opens on the change, the first step that needs a verdict.
  spy.moves = 0;
  const tabs = (side: "ta" | "tb") => byId(side).children;
  const wraps = (side: "va" | "vb") => byId(side).children;
  const cleanup = () => spy.intervals.forEach((i) => clearInterval(i as never));
  return { press, spy, tabs, wraps, cleanup, byId };
}

const KEYS = [" ", "Enter", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "[", "]"];
const EDITABLE: Array<[string, Record<string, unknown>]> = [
  ["textarea", { tagName: "TEXTAREA" }],
  ["text input", { tagName: "INPUT", type: "text" }],
  ["select", { tagName: "SELECT" }],
  ["contenteditable", { tagName: "DIV", isContentEditable: true }],
];

describe("keys inside an editable element belong to that element", () => {
  for (const [name, target] of EDITABLE) {
    for (const k of KEYS) {
      it(`${name}: ${JSON.stringify(k)} does nothing to the rail and is not prevented`, async () => {
        const p = await boot();
        try {
          assert.match(visibleText(p.wraps("va")), /Data new/);
          const prevented = await p.press(k, target);
          assert.equal(prevented, false, "preventDefault would swallow the key");
          assert.equal(p.spy.moves, 0, "no stop step");
          assert.equal(p.spy.intervals.length, 0, "no play");
          assert.match(visibleText(p.wraps("va")), /Data new/, "no sheet step");
        } finally { p.cleanup(); }
      });
    }
  }
  it("a textarea inside the rail's own fail box (real id) is covered the same way", async () => {
    const p = await boot();
    try {
      const note = Object.assign(mkNode("TEXTAREA"), { tagName: "TEXTAREA" });
      assert.equal(await p.press(" ", note), false);
      assert.equal(await p.press("Enter", note), false);
      assert.equal(p.spy.moves + p.spy.intervals.length, 0);
    } finally { p.cleanup(); }
  });
});

describe("outside editable elements every shortcut works as before", () => {
  const body = { tagName: "BODY" };
  it("space is not a page shortcut (there is no play): no timer, no step, not prevented", async () => {
    const p = await boot();
    try {
      assert.equal(await p.press(" ", body), false);
      assert.equal(p.spy.moves + p.spy.intervals.length, 0);
    } finally { p.cleanup(); }
  });
  for (const k of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
    it(`${k} steps a stop and is prevented`, async () => {
      const p = await boot();
      try {
        /* the page opens on the change, the model's last step: step back first to leave room to step forward */
        if (k === "ArrowRight" || k === "ArrowDown") { await p.press("ArrowLeft", body); p.spy.moves = 0; }
        assert.equal(await p.press(k, body), true);
        assert.equal(p.spy.moves, 1);
      } finally { p.cleanup(); }
    });
  }
  it("[ and ] step sheets and are prevented", async () => {
    const p = await boot();
    assert.equal(await p.press("]", body), true);
    assert.match(visibleText(p.wraps("va")), /Totals new/);
    assert.equal(await p.press("[", body), true);
    assert.match(visibleText(p.wraps("va")), /Data new/);
    p.cleanup();
  });
  it("Enter on the page body has no shortcut: it neither steps nor is prevented", async () => {
    const p = await boot();
    assert.equal(await p.press("Enter", body), false);
    assert.equal(p.spy.moves + p.spy.intervals.length, 0);
    p.cleanup();
  });
  it("a focused tab still takes its arrows, and a focused button still keeps its own space", async () => {
    const p = await boot();
    await p.press("ArrowLeft", p.tabs("ta")[1]);
    assert.match(visibleText(p.wraps("va")), /Cover new/);
    assert.equal(await p.press(" ", p.tabs("ta")[0]), false, "space on a tab is left to the tab");
    p.cleanup();
  });
});

describe("nothing else turns Enter into a move to the next stop", () => {
  it("the page has no form, and review.js listens for no Enter, keypress, keyup or submit outside the fail note", async () => {
    const html = renderReviewShell(7);
    assert.doesNotMatch(html, /<form\b/i);
    const js = await readFile(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    // the fail note's own textarea takes Enter (save) and Escape (cancel); that one line is the only Enter, and it is not global.
    const lines = js.split("\n");
    const enter = lines.filter((l) => /['"]Enter['"]/.test(l));
    // the review bar adds Cmd/Ctrl+Enter (save the open fail note, else the bar's sign-off or send-back) to the global handler; it needs a modifier, so a bare Enter still moves nothing.
    // Send-back choice: the send-back dialog's own keydown takes Enter (send) and Escape (cancel); it is on the dialog, not global, and stops the key there.
    assert.equal(enter.length, 3);
    assert.match(enter[0]!, /^\s*\$\('vnote'\)\.addEventListener\('keydown'/);
    assert.match(enter[2]!, /^\s*if \(e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)\)/);
    assert.match(enter[1]!, /^\s*if \(e\.key === 'Enter' && !\(e\.target && e\.target\.id === 'sbdlgcancel'\)\) \{ e\.preventDefault\(\); sbDlgGo\(\); \}/);
    assert.match(js, /\$\('sbdlg'\)\.addEventListener\('keydown', function \(e\) \{\n\s*if \(e\.stopPropagation\) e\.stopPropagation\(\);/, "the dialog keeps its keys to itself");
    assert.doesNotMatch(js, /keypress|keyup|['"]submit['"]\s*,|onsubmit|keyCode/);
    assert.equal(lines.filter((l) => /^\s*addEventListener\('keydown'/.test(l)).length, 1, "one global key handler");
    assert.equal((js.match(/addEventListener\('keydown'/g) ?? []).length, 3, "the global handler, the fail note's and the send-back dialog's");
  });
});
