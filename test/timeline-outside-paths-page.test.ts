import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// Page half: the Deliverables "Outside the folder" group asks for the directories when it opens and draws them under the file name.
const W = "/w/";
const sha = (c: string): string => c.repeat(64);
function fixture() {
  const c = (id: string, at: number, named: string[]) => call(id, { desc: id, at, end: at + 4, named, extra: { startSeq: at } });
  const ops = [c("c1", 10, [W + "a.csv"]), c("c2", 20, ["/elsewhere/scratch.csv"]), prompt("s1", ["Build it."], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")];
  const fileStates = [state(W + "a.csv", sha("a"), null, { open: ["c1"], credited: ["c1"] }), state("/elsewhere/scratch.csv", sha("b"), null, { open: ["c2"], credited: ["c2"] })];
  const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; open = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1; scrollLeft = 7;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {}
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

async function boot(hash: string, paths: unknown = {}, asked: string[] = []) {
  const model = JSON.parse(JSON.stringify(fixture()));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "1") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const intervals: unknown[] = [];
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: () => {}, setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); intervals.push(id); return id; }, clearInterval,
    fetch: async (u: string) => u.includes("/outside-paths") ? (asked.push(u), { ok: true, status: 200, json: async () => paths }) : u.includes("/review/model") ? { ok: true, status: 200, json: async () => model } : u.includes("/view/") ? { ok: true, status: 200, json: async () => ({ change: "c", file: "x", engine: "drawn by CoCheck", kind: "grid", before: [], after: [], boxes: [], caveats: [] }) } : { ok: false, status: 404, json: async () => ({}) } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  return { byId, model, cleanup: () => intervals.forEach((i) => clearInterval(i as never)), settle: () => new Promise((r) => setTimeout(r, 30)) };
}

const texts = (n: N): string[] => n.descendants().map((x) => x._text).filter((t) => t !== "");

describe("outside files show their directory from the separate route", () => {
  it("the model holds no directory; opening the group asks the route once and draws the directory under the file name, as text only", async () => {
    const m = fixture();
    const f = m.files.find((x) => x.outside)!;
    assert.equal(f.ref, "/outside/scratch.csv");
    assert.ok(!JSON.stringify(m).includes("/elsewhere"), "the model holds the directory");
    const asked: string[] = [];
    const p = await boot("#v=files", { [f.ref!]: ["/elsewhere/<b>deep</b>", "/other"] }, asked);
    try {
      assert.deepEqual(asked, [], "nothing asked while the group is closed");
      const box = p.byId("fileslist").descendants().find((n) => n.className === "outgrp")!;
      box.open = true; (box.listeners.toggle ?? []).forEach((fn) => fn({})); await p.settle();
      assert.equal(asked.length, 1);
      assert.match(asked[0]!, /^\/timeline\/1\/outside-paths\?t=tok$/);
      const od = p.byId("fileslist").descendants().filter((n) => n.className === "od");
      assert.deepEqual(od.map((n) => n.textContent), ["/elsewhere/<b>deep</b>", "/other"]);
      assert.ok(od.every((n) => n.children.every((c) => c.tag === "#text")), "text nodes only");
    } finally { p.cleanup(); }
  });
});
