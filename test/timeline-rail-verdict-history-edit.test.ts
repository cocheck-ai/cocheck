import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// The saved fail note and its history on the review page. History reads in the page's own style: local time (no raw ISO string), no dash chain.
// Clicking (or Enter on) the saved fail note opens the fail composer prefilled for the step on show; saving writes to that step only.
// The page code runs as is in a vm with a DOM stub.

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, any> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; value = ""; focused = false; nodeType = 1; rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  removeChild(c: N) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(sel: string): N | null { for (let n: N | null = this; n; n = n.parentNode) if (sel === ".vw[hidden]" && n.hidden && n.className.split(/\s+/).includes("vw")) return n; return null; }
  getBoundingClientRect() { return this.rect; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

const ISO = "2026-11-01T21:54:44.300Z";
const OLD = "2020-03-05T10:00:00.000Z";
const stopOf = (key: string) => ({ id: `chg-${key}`, label: `${key}.bin`, lane: "main", head: `Claude changed ${key}.bin`, change: { key, file: `${key}.bin`, kind: "modified", note: `Changed ${key}.bin.`, rowNotes: [], moreNote: null, viewUrl: `/timeline/7/view/${key}`, secret: false, secretLine: null, failed: null, ask: null, newFile: null, treeBefore: null, treeAfter: null } });
const failed = (note: string, ts: string) => ({ status: "failed", note, stale: false, history: [{ status: "failed", note, reviewer: "dana", ts, current: true }] });

interface Call { url: string; body: any }
async function boot() {
  const model = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops: ["k1", "k2"].map(stopOf) };
  const status = { stops: { "chg-k1": failed("fail", ISO), "chg-k2": failed("other", OLD) }, passes: null };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  for (const id of ["ncomp", "pcomp", "sbout", "toast"]) byId(id).hidden = true;
  const calls: Call[] = [];
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const answer = (j: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(j)) });
  const fetchStub = async (u: string, o?: { body?: string }) => {
    const b = o?.body ? JSON.parse(o.body) : null;
    calls.push({ url: u, body: b });
    const json = u.includes("/review/status") ? status : u.includes("/review/model") ? model : u.includes("/review/verdict") ? { state: { status: b.status, note: b.note, history: [] }, submit: null } : u.includes("/view/") ? { change: "k1", file: "k1.bin", engine: "", kind: "card", before: [], after: [], boxes: [], caveats: [] } : {};
    return answer(json);
  };
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, setInterval, clearInterval, setTimeout, clearTimeout, fetch: fetchStub,
    addEventListener: (k: string, f: (e: unknown) => void) => { (listeners[k] ??= []).push(f); } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 25));
  await settle();
  return { byId, calls, settle, verdictPosts: () => calls.filter((c) => c.url.includes("/review/verdict")).map((c) => c.body) };
}

describe("verdict history and the saved fail note", () => {
  it("history shows local time and never the raw ISO string or a dash chain", async () => {
    const p = await boot();
    const text = p.byId("vhistlist").textContent;
    assert.doesNotMatch(text, /T\d\d:\d\d:\d\d/);
    assert.doesNotMatch(text, /2026-11-01/);
    assert.doesNotMatch(text, / - /);
    assert.match(text, /Failed/); assert.match(text, /fail/); assert.match(text, /dana/);
    assert.match(text, /\d{1,2}:\d\d/);
  });

  it("clicking the saved fail note opens the composer prefilled, and saving writes to that step only", async () => {
    const p = await boot();
    assert.equal(p.byId("vstat").hidden, false);
    assert.match(renderReviewShell(7), /<button type="button" class="vsaved" id="vstat"/);
    p.byId("vstat").click(); await p.settle();
    assert.equal(p.byId("pcomp").hidden, false);
    assert.equal(p.byId("vnote").value, "fail");
    p.byId("vnote").value = "fail, reworded"; p.byId("vfailgo").click(); await p.settle();
    assert.deepEqual(p.verdictPosts().map((b) => ({ stop: b.stop, status: b.status, note: b.note })), [{ stop: "chg-k1", status: "failed", note: "fail, reworded" }]);
  });

  it("the saved note is a native button, so Enter and Space reach it with no key handler of their own", () => {
    assert.match(renderReviewShell(7), /<button type="button" class="vsaved" id="vstat"/);
  });
});
