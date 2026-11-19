import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// A workbook pane shows one sheet at a time; its tabs switch it (mouse, keyboard), before and after together, and every sheet with a
// change has a tab marked changed. The review page code runs as is in a vm with a DOM stub that keeps attributes, listeners and hidden state.

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

async function boot(view: unknown) {
  const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "#1" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval, clearInterval, console,
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? model : servedFor(view, model, u)) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  const key = async (k: string, target: unknown = { tagName: "BODY" }) => { handlers.keydown!({ key: k, target, preventDefault() {} }); await settle(); };
  // No start stop; the page opens on the change (the first step that needs a verdict), so no key is pressed to reach it.
  const tabs = (side: "ta" | "tb") => byId(side).children;
  const wraps = (side: "va" | "vb") => byId(side).children;
  return { byId, key, tabs, wraps, settle };
}

const isOn = (n: N) => n.className.split(/\s+/).includes("on");
const visibleText = (ws: N[]) => ws.filter((w) => !w.hidden).map((w) => w.textContent).join("|");
const pic = (side: string, n: number, of: number) => ({ id: `${side}:page${n}`, label: `${side === "before" ? "Before" : "After"}, page ${n} of ${of}`, picture: { sha: "c".repeat(64), width: 10, height: 10, page: n } });
const view = (o: Record<string, unknown>) => ({ change: "c1", file: "deck.pptx", engine: "drawn by CoCheck", kind: "picture", before: [], after: [], boxes: [], caveats: [], ...o });
const labels = (ns: N[]) => ns.map((n) => n.textContent);

// Each pane's tabs carry their own side's label and page count.
describe("tab labels belong to their own side", () => {
  it("Before tabs say Before with the before page count, After tabs say After", async () => {
    const p = await boot(view({ before: [pic("before", 1, 6), pic("before", 2, 6)], after: [pic("after", 1, 7), pic("after", 2, 7)], boxes: [{ side: "after", pane: "after:page2", rect: { x: 0, y: 0, w: 1, h: 1 }, change: "c1", confidence: "pixel" }] }));
    assert.deepEqual(labels(p.tabs("tb")), ["Page 1 of 6", "Page 2 of 6"]);
    assert.deepEqual(labels(p.tabs("ta")), ["Page 1 of 7", "Page 2 of 7"]);
    assert.match(p.tabs("tb")[1]!.getAttribute("aria-label")!, /^Before, page 2 of 6/);
  });
  it("a picture with no label reads \"2 of 2\" from its page and the pages on its side", async () => {
    const bare = (side: string, n: number, of: number) => ({ id: `${side}:page${n}`, picture: { sha: "c".repeat(64), width: 10, height: 10, page: n, pageCount: of } });
    const p = await boot(view({ before: [bare("before", 1, 5), bare("before", 2, 5)], after: [bare("after", 1, 5), bare("after", 2, 5)] }));
    assert.deepEqual(labels(p.tabs("tb")), ["1 of 2", "2 of 2"]);
  });
  it("a page on one side only says so on the side that lacks it, and tabs still switch together", async () => {
    const p = await boot(view({ before: [pic("before", 1, 1)], after: [pic("after", 1, 2), pic("after", 2, 2)] }));
    assert.deepEqual(labels(p.tabs("ta")), ["Page 1 of 2", "Page 2 of 2"]);
    assert.deepEqual(labels(p.tabs("tb")), ["Page 1 of 1", "Page 2: not there yet"]);
    p.tabs("tb")[1]!.click();
    assert.deepEqual(p.tabs("ta").map(isOn), [false, true]);
    assert.deepEqual(p.tabs("tb").map(isOn), [false, true]);
    assert.match(visibleText(p.wraps("vb")), /did not exist yet/);
  });
});
