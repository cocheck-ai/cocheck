import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, entryKey, type RailModel } from "../src/timeline/rail/model.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// every per-file structure keys an outside change apart from an in-folder one (entries, folder trees, creation times); the outside key is a string no path can be;
// the Files hash selects each of two same-name entries.

const W = "/w";
const sha = (c: string): string => c.repeat(64);

/** Each item is [path, writer id]; written in the order given, one second apart. */
function build(writes: Array<[string, string]>): RailModel {
  const ops = [
    ...writes.map(([f, id], i) => call(id, { at: 10 + i * 5, end: 12 + i * 5, cmd: "python3 gen.py", named: [f], extra: { startSeq: 10 + i * 5 } })),
    prompt("s1", ["Make the numbers."], { requests: [{ seq: 1, at: 0, firstStep: null }] }),
    stop("s1", "done"),
  ];
  const fileStates = writes.map(([f, id], i) => state(f, sha("abcdefgh"[i]!), null, { open: [id], credited: [id] }));
  const input: TimelineInput = { taskId: 5, build: "t", ops, fileStates, folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}
const IN: [string, string] = [W + "/report.xlsx", "i1"], OUT: [string, string] = ["/tmp/x/report.xlsx", "o1"], NEW: [string, string] = [W + "/sub/other.txt", "n1"];
const treeNames = (rows: unknown): string => JSON.stringify(rows ?? []);
const treeAfterOf = (m: RailModel, file: string) => m.stops.find((s) => s.change?.file === file)!.change!.treeAfter;

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

async function boot(hash: string, built: RailModel) {
  const model = JSON.parse(JSON.stringify(built));
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

describe("folder trees", () => {
  for (const [label, order] of [["outside first", [OUT, IN, NEW]], ["in-folder first", [IN, OUT, NEW]]] as const) {
    it(`${label}: the tree after a third new file still lists the in-folder file`, () => {
      const m = build([...order]);
      assert.ok(treeNames(treeAfterOf(m, "sub/other.txt")).includes("report.xlsx"));
    });
  }
  it("an outside file alone is in no tree", () => {
    assert.ok(!treeNames(treeAfterOf(build([OUT, NEW]), "sub/other.txt")).includes("report.xlsx"));
  });
  it("creation times are kept apart: the in-folder file's tree before the outside write still lacks the outside one and lists nothing it should not", () => {
    const m = build([IN, OUT, NEW]);
    const outStop = m.stops.find((s) => s.change?.newFile?.outside === true)!.change!;
    assert.equal(outStop.treeBefore, null);
    assert.equal(outStop.treeAfter, null);
    const inStop = m.stops.find((s) => s.change?.file === "report.xlsx" && s.change.newFile?.outside === false)!.change!;
    assert.ok(treeNames(inStop.treeAfter).includes("report.xlsx"));
  });
  it("entryKey: outside keys differ from every path, including one named like the old prefix", () => {
    const o = entryKey({ file: "a.txt", outside: true });
    assert.notEqual(o, entryKey({ file: "[outside] a.txt", outside: false }));
    assert.notEqual(o, entryKey({ file: "a.txt", outside: false }));
    assert.ok(o.includes("\u0000"));
  });
});

describe("a real in-folder file named like the old outside key", () => {
  it("is never flagged outside, with the outside file written first or second", () => {
    for (const order of [[["/tmp/x/a.txt", "o1"], [W + "/[outside] a.txt", "i1"]], [[W + "/[outside] a.txt", "i1"], ["/tmp/x/a.txt", "o1"]]] as Array<Array<[string, string]>>) {
      const m = build(order);
      assert.equal(m.files.length, 2);
      const real = m.files.find((f) => f.file === "[outside] a.txt")!;
      assert.equal(real.outside, undefined);
      assert.equal(real.ref, undefined);
      assert.equal(m.files.filter((f) => f.outside).length, 1);
    }
  });
});

describe("the Files hash selects each same-name entry", () => {
  for (const order of [[OUT, IN], [IN, OUT]] as Array<Array<[string, string]>>) {
    it(`writes ${order[0] === IN ? "in-folder first" : "outside first"}`, async () => {
      const m = build(order);
      const entries = m.files.filter((f) => f.name === "report.xlsx");
      assert.equal(entries.length, 2);
      for (const e of entries) {
        const addr = e.ref ?? e.file;
        const p = await boot(`#v=files&f=${encodeURIComponent(addr)}&p=1`, m);
        try {
          assert.equal(p.spy.hashes.at(-1), `#v=files&f=${encodeURIComponent(addr)}&p=1`);
          const sel = p.byId("fileslist").descendants().filter((n) => n.attrs["aria-current"] === "true").map((n) => n.attrs["data-file"]);
          assert.deepEqual(sel, [String(m.files.indexOf(e))]);
        } finally { p.cleanup(); }
      }
    });
  }
});
