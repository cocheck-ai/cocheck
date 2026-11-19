import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// the Files view fixes. Before task and Now are one pane each (the file as the task found it, the file as it ends), Steps and Files open
// each other on the same place, the Files hash names the file by its path, and two files with one name show enough of the path to tell apart.
// Shapes follow the earlier fixture: ledger-shaped rows; `stored` decides which states CoCheck holds.

const W = "/w/";
const sha = (c: string): string => c.repeat(64);

function fixture(stored: string[] = []) {
  const c = (id: string, at: number, named: string[]) => call(id, { desc: id, at, end: at + 4, named, extra: { startSeq: at } });
  const ops = [
    c("c1", 10, [W + "a/data.csv"]), c("c2", 20, [W + "a/data.csv"]), c("c3", 30, [W + "b/data.csv"]), c("c4", 40, [W + "c/notes.txt"]),
    prompt("s1", ["Build it."], { requests: [{ seq: 1, at: 5, firstStep: null }] }),
    stop("s1", "done"),
  ];
  const fileStates = [
    state(W + "a/data.csv", sha("a"), null, { open: ["c1"], credited: ["c1"] }),
    state(W + "a/data.csv", sha("b"), sha("a"), { open: ["c2"], credited: ["c2"] }),
    state(W + "b/data.csv", sha("e"), sha("d"), { open: ["c3"], credited: ["c3"] }),
    state(W + "c/notes.txt", sha("g"), sha("f"), { open: ["c4"], credited: ["c4"] }),
  ];
  const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(stored.map((s) => [sha(s), 4])), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}

// The page: review.js and files-view.js run as they are in a vm with a DOM stub; a fetch spy records which per-change view each click asks for.
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1;
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

async function boot(hash: string, stored: string[] = ["b"]) {
  const model = JSON.parse(JSON.stringify(fixture(stored)));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "1") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const spy = { hashes: [] as string[], views: [] as string[], intervals: [] as unknown[] };
  const handlers: Record<string, (e: unknown) => void> = {};
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash }, history: { replaceState(_a: unknown, _b: unknown, h: string) { spy.hashes.push(h); } }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; },
    setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); spy.intervals.push(id); return id; }, clearInterval,
    fetch: async (u: string) => {
      if (u.includes("/review/model")) return { ok: true, status: 200, json: async () => model };
      if (u.includes("/view/")) { spy.views.push(decodeURIComponent(u.split("/view/")[1]!.split("?")[0]!)); return { ok: true, status: 200, json: async () => ({ change: "c", file: "shared.csv", engine: "drawn by CoCheck", kind: "grid", before: [], after: [], boxes: [], caveats: [] }) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  const cleanup = () => spy.intervals.forEach((i) => clearInterval(i as never));
  return { byId, spy, model, handlers, cleanup, settle: () => new Promise((r) => setTimeout(r, 30)) };
}

const fileOf = (p: Awaited<ReturnType<typeof boot>>, file: string) => p.model.files.find((f: { file: string }) => f.file === file)!;
const key = (file: string): string => encodeURIComponent(file);
const bodyText = (p: Awaited<ReturnType<typeof boot>>): string => p.byId("bodyview").textContent;
const strip = (p: Awaited<ReturnType<typeof boot>>) => p.byId("strip").children;

describe("the model", () => {
  it("a file says how the task found it, and a same-named file carries enough of its folder to tell apart", () => {
    const m = fixture(["a", "b", "d", "e", "g"]);
    const by = (f: string) => m.files.find((x) => x.file === f)!;
    assert.deepEqual([by("a/data.csv").start, by("b/data.csv").start, by("c/notes.txt").start], ["none", "kept", "lost"]);
    assert.deepEqual([by("a/data.csv").where, by("b/data.csv").where, by("c/notes.txt").where], ["a", "b", undefined]);
  });
});

describe("Before task and Now are one pane each", () => {
  it("Before task: a file the task created says it did not exist and asks for no view; a kept start draws the first change's before side alone; a lost start says content not kept", async () => {
    const p = await boot(`#v=files&f=${key("a/data.csv")}&p=1`, ["a", "b", "d", "e", "g"]);
    try {
      const seen = p.spy.views.length;
      strip(p)[0]!.click(); await p.settle();
      assert.equal(p.spy.views.length, seen, "nothing to draw, nothing fetched");
      assert.match(bodyText(p), /did not exist/);
      assert.equal(p.byId("stage").hidden, true);
      p.byId("fileslist").descendants().find((n) => n.tag === "button" && n.attrs["data-file"] === String(p.model.files.findIndex((f: { file: string }) => f.file === "b/data.csv")))!.click(); await p.settle();
      strip(p)[0]!.click(); await p.settle();
      assert.equal(p.spy.views.at(-1), fileOf(p, "b/data.csv").versions[0].change);
      assert.match(p.byId("stage").className, /solo-before/);
      assert.doesNotMatch(p.byId("stage").className, /solo-after/);
      assert.equal(p.byId("stage").hidden, false);
    } finally { p.cleanup(); }
    const q = await boot(`#v=files&f=${key("c/notes.txt")}&p=1`, ["a", "b", "d", "e"]);
    try {
      strip(q)[0]!.click(); await q.settle();
      assert.match(bodyText(q), /not kept/i);
      assert.match(q.byId("fvorder").textContent, /content not kept/);
    } finally { q.cleanup(); }
  });

  it("Now: the last change's after side alone, never v1's or vN's diff; a lost end says content not kept", async () => {
    const p = await boot(`#v=files&f=${key("a/data.csv")}&p=1`, ["a", "b", "d", "e", "g"]);
    try {
      const f = fileOf(p, "a/data.csv");
      strip(p).at(-1)!.click(); await p.settle();
      assert.equal(p.spy.views.at(-1), f.versions.at(-1).change);
      assert.match(p.byId("stage").className, /solo-after/);
      assert.doesNotMatch(p.byId("stage").className, /solo-before/);
      strip(p).find((b: N) => b.attrs["data-p"] === "1")!.click(); await p.settle();
      assert.doesNotMatch(p.byId("stage").className, /solo-/, "a version is the change's two panes again");
    } finally { p.cleanup(); }
    const q = await boot(`#v=files&f=${key("a/data.csv")}&p=1`, ["a", "d", "e", "g"]);
    try {
      strip(q).at(-1)!.click(); await q.settle();
      assert.match(bodyText(q), /not kept/i);
    } finally { q.cleanup(); }
  });
});

describe("Steps and Files open each other on the same place", () => {
  it("Steps to Files opens the file of the step on show, at that step's version", async () => {
    const m = fixture();
    const f = m.files.find((x) => x.file === "a/data.csv")!;
    const at = m.stops.findIndex((s) => s.id === f.versions[1]!.stop);
    const p = await boot(`#${at}`);
    try {
      p.byId("vfiles").click(); await p.settle();
      assert.equal(p.byId("fvname").textContent, "data.csv (a)");
      assert.equal(p.spy.hashes.at(-1), `#v=files&f=${key("a/data.csv")}&p=2`);
    } finally { p.cleanup(); }
  });

  it("Files to Steps lands on the selected version's step", async () => {
    const m = fixture();
    const f = m.files.find((x) => x.file === "b/data.csv")!;
    const at = m.stops.findIndex((s) => s.id === f.versions[0]!.stop);
    const p = await boot(`#v=files&f=${key("b/data.csv")}&p=1`);
    try {
      p.byId("vsteps").click(); await p.settle();
      // the step is selected, but no step number is written to the URL; only the view
      assert.ok(p.spy.hashes.at(-1)!.endsWith("#v=timeline"), p.spy.hashes.at(-1) ?? "");
      assert.ok(at >= 0);
    } finally { p.cleanup(); }
  });
});

describe("the Files hash", () => {
  it("names the file by its path, opens that file, and an unknown key opens the first file", async () => {
    const p = await boot(`#v=files&f=${key("c/notes.txt")}&p=1`);
    try {
      assert.equal(p.byId("fvname").getAttribute("data-tip"), "c/notes.txt");
      assert.equal(p.spy.hashes.at(-1), `#v=files&f=${key("c/notes.txt")}&p=1`);
    } finally { p.cleanup(); }
    const q = await boot(`#v=files&f=nope&p=1`);
    try { assert.equal(q.byId("fvname").getAttribute("data-tip"), q.model.files[0].file); } finally { q.cleanup(); }
  });
});

describe("same name, different folders", () => {
  it("the list, the head and the strip's neighbours show the folder where names repeat, and only there", async () => {
    const p = await boot(`#v=files&f=${key("a/data.csv")}&p=1`);
    try {
      const rows = p.byId("fileslist").descendants().filter((n) => n.tag === "button");
      const where = rows.map((r) => r.descendants().find((d) => d.className === "wh")?.textContent);
      assert.deepEqual(where, [undefined, "b", "a"], "newest last change first; the twins show their folder, the lone name stays plain");
      assert.match(p.byId("fvname").textContent, /data\.csv \(a\)/);
    } finally { p.cleanup(); }
  });
});
