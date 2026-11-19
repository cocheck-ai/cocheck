import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// every per-file version strip opens at its first node (Before task), whatever the previous file showed; an explicit &p wins; the
// view switch reads Timeline and Deliverables (ids and hash values unchanged); the file list scrolls on its own.

const W = "/w/";
const sha = (c: string): string => c.repeat(64);
function fixture() {
  const c = (id: string, at: number, named: string[]) => call(id, { desc: id, at, end: at + 4, named, extra: { startSeq: at } });
  const ops = [c("c1", 10, [W + "a.csv"]), c("c2", 20, [W + "a.csv"]), c("c3", 30, [W + "b.csv"]), c("c4", 40, [W + "b.csv"]),
    prompt("s1", ["Build it."], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")];
  const fileStates = [
    state(W + "a.csv", sha("a"), null, { open: ["c1"], credited: ["c1"] }), state(W + "a.csv", sha("b"), sha("a"), { open: ["c2"], credited: ["c2"] }),
    state(W + "b.csv", sha("d"), sha("c"), { open: ["c3"], credited: ["c3"] }), state(W + "b.csv", sha("e"), sha("d"), { open: ["c4"], credited: ["c4"] }),
  ];
  const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1; scrollLeft = 7;
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

async function boot(hash: string) {
  const model = JSON.parse(JSON.stringify(fixture()));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "1") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const intervals: unknown[] = [];
  const keydowns: Array<(e: unknown) => void> = [];
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: (k: string, f: (e: unknown) => void) => { if (k === "keydown") keydowns.push(f); }, setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); intervals.push(id); return id; }, clearInterval,
    fetch: async (u: string) => u.includes("/review/model") ? { ok: true, status: 200, json: async () => model } : u.includes("/view/") ? { ok: true, status: 200, json: async () => ({ change: "c", file: "x", engine: "drawn by CoCheck", kind: "grid", before: [], after: [], boxes: [], caveats: [] }) } : { ok: false, status: 404, json: async () => ({}) } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  return { byId, model, key: (key: string) => keydowns.forEach((f) => f({ key, target: mkNode(), preventDefault() {}, metaKey: false, ctrlKey: false, altKey: false })), cleanup: () => intervals.forEach((i) => clearInterval(i as never)), settle: () => new Promise((r) => setTimeout(r, 30)) };
}
const curP = (p: Awaited<ReturnType<typeof boot>>): string[] => p.byId("strip").children.filter((n) => n.attrs["aria-selected"] === "true").map((n) => n.attrs["data-p"]!);
const listBtn = (p: Awaited<ReturnType<typeof boot>>, file: string) => p.byId("fileslist").descendants().find((n) => n.tag === "button" && n.attrs["data-file"] === String(p.model.files.findIndex((f: { file: string }) => f.file === file)))!;

describe("every per-file strip opens at its first node", () => {
  it("picking a file from the list opens version 0, even after the previous file was left on its last version", async () => {
    const p = await boot("#v=files&f=" + encodeURIComponent("a.csv") + "&p=3");
    try {
      assert.deepEqual(curP(p), ["3"]);
      listBtn(p, "b.csv").click(); await p.settle();
      assert.deepEqual(curP(p), ["3"], "the other file opens at Now, the final product");
      assert.equal(p.byId("strip").scrollLeft, 0, "the strip is scrolled to its newest card");
      p.byId("strip").children[0]!.click(); await p.settle();
      assert.deepEqual(curP(p), ["0"], "Before task is the first node on screen");
      listBtn(p, "a.csv").click(); await p.settle();
      assert.deepEqual(curP(p), ["3"]);
    } finally { p.cleanup(); }
  });
  it("boot with a file and no &p opens version 0; an explicit &p wins", async () => {
    const a = await boot("#v=files&f=" + encodeURIComponent("b.csv"));
    try { assert.deepEqual(curP(a), ["3"]); assert.equal(a.byId("vfiles").attrs["aria-pressed"], "true"); } finally { a.cleanup(); }
    const b = await boot("#v=files&f=" + encodeURIComponent("b.csv") + "&p=2");
    try { assert.deepEqual(curP(b), ["2"]); } finally { b.cleanup(); }
  });
});

describe("names and scroll", () => {
  it("the view switch reads Timeline and Deliverables; ids and the #v=files hash stay", async () => {
    const page = await readFile(new URL("../src/timeline/rail/page.ts", import.meta.url), "utf8");
    assert.match(page, /id="vsteps"[^>]*>Timeline<\/button>/);
    assert.match(page, /id="vfiles"[^>]*>Deliverables<\/button>/);
    assert.doesNotMatch(page, /id="vsteps"[^>]*>Steps</);
    // Deliverables comes first and is the pressed one in the shell
    assert.match(page, /<button type="button" id="vfiles" aria-pressed="true">Deliverables<\/button><button type="button" id="vsteps" aria-pressed="false">Timeline<\/button>/);
  });
  it("the file list column has its own height and overflow, like the rail's scroller; the rail's rules are untouched", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    const list = /\n\.list\{([^}]*)\}/.exec(css)![1]!;
    assert.match(list, /height:calc\(100vh - 54px\)/);
    assert.match(list, /overflow-y:auto/);
    assert.match(css, /\.rail\{position:sticky;top:54px;height:calc\(100vh - 54px\);display:flex;flex-direction:column;/);
    assert.match(css, /\.scroller\{flex:1;min-height:0;overflow-y:auto;/);
  });
});

// the strip reads left to right in time; Right goes forward in time, Left back.
describe("strip order and arrow keys", () => {
  it("paints Before task, v1, v2, Now; Right goes forward in time, Left back", async () => {
    const p = await boot("#v=files&f=" + encodeURIComponent("a.csv"));
    try {
      assert.deepEqual(p.byId("strip").children.map((n) => n.attrs["data-p"]), ["0", "1", "2", "3"]);
      assert.deepEqual(curP(p), ["3"], "opens on the newest, the rightmost card");
      p.key("ArrowLeft"); await p.settle();
      assert.deepEqual(curP(p), ["2"], "Left = back in time");
      p.key("ArrowRight"); p.key("ArrowRight"); await p.settle();
      assert.deepEqual(curP(p), ["3"], "Right = forward in time, stops at Now");
      p.key("ArrowLeft"); p.key("ArrowLeft"); p.key("ArrowLeft"); p.key("ArrowLeft"); await p.settle();
      assert.deepEqual(curP(p), ["0"], "stops at Before task");
    } finally { p.cleanup(); }
  });
  it("the shell has no keyboard hint sentence, and no Now/End frame is styled", async () => {
    const html = renderReviewShell(1);
    assert.doesNotMatch(html, /back in time|from the final product/);
    assert.match(html, /aria-label="Versions, oldest first"/);
    const p = await boot("#v=files&f=" + encodeURIComponent("a.csv"));
    try { assert.ok(!p.byId("strip").children.some((n) => / end\b/.test(" " + n.className))); } finally { p.cleanup(); }
  });
});
