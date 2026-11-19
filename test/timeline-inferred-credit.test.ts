import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildTimeline, type FormatChanges, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// a credited change whose `credit_basis` is not a proof method (argv-tag, host-reported-edit), or has none (an older row),
// shows the one word "Inferred" beside its credit: no tooltip, no sentence, no basis name. A proven change and a change nobody's call is
// credited with show nothing new. Guarded against: a proven credit reading "Inferred", or an uncredited change claiming a credit.

const FILE = "/w/model.xlsx";
const goodView = { change: "x", file: "model.xlsx", engine: "drawn by CoCheck", kind: "diff", before: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "old", box: null }] } }], after: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "new", box: null }] } }], boxes: [], caveats: [] };
const FMT: FormatChanges = { module: "xlsx", rows: [], more: 0 };

const build = (host: string, basis: string | null | undefined, credited: boolean): { body: Timeline; model: RailModel } => {
  const ops: RawOp[] = [prompt("s1", ["Update it."]), call("c1", { host, at: 10, end: 40, cmd: "run" }), stop("s1")];
  const st: RawState = { ...state(FILE, "n1", "n0", { open: ["c1"], credited: credited ? ["c1"] : [] }), ...(basis === undefined ? {} : { credit_basis: basis }) };
  const input = { taskId: 1, build: "b", ops, fileStates: [st], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map([[st.id, FMT]]), quickLook: false, host } as TimelineInput;
  const body = JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline;
  return { body, model: buildRailModel(body) };
};
/** Every change in the body, wherever it sits, and every change stop on the rail: all must agree. */
const inferredOf = (host: string, basis: string | null | undefined, credited = true): boolean | undefined => {
  const { body, model } = build(host, basis, credited);
  const inBody = [...body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((c) => c.changes))), ...body.unplaced];
  assert.equal(inBody.length >= 1, true, "the change is in the body");
  const seen = new Set([...inBody.map((c) => c.inferred), ...model.stops.filter((s) => s.change).map((s) => s.change!.inferred)]);
  assert.equal(seen.size, 1, "body and rail agree");
  return [...seen][0];
};

for (const host of ["claude", "copilot"]) {
  describe(`${host} fixtures`, () => {
    it("proven credit (argv-tag, host-reported-edit) shows nothing new", () => {
      assert.equal(inferredOf(host, "argv-tag"), undefined);
      assert.equal(inferredOf(host, "host-reported-edit"), undefined);
    });
    it("every other basis, and a missing one, is Inferred", () => {
      for (const b of ["named", "window", "declared", "joint", null, undefined]) assert.equal(inferredOf(host, b), true, String(b));
    });
    it("an uncredited change (the person's own) shows nothing new, whatever its basis", () => {
      for (const b of ["unattributed", null, "window"]) assert.equal(inferredOf(host, b, false), undefined, String(b));
    });
  });
}

// The vm page stub below is copied from test/timeline-loading-widget.test.ts.
interface Node { tag: string; className: string; attrs: Record<string, string>; children: Node[]; hidden: boolean; textContent: string; [k: string]: unknown }
function makePage(answer: (u: string) => unknown, hash: string) {
  const nodes = new Map<string, Node>();
  const timers: Array<() => void> = [];
  const make = (tag: string): Node => {
    let text = "";
    const base = {
      tag, className: "", attrs: {} as Record<string, string>, children: [] as unknown[], hidden: false, nodeType: 1, dataset: {}, style: { setProperty() {}, removeProperty() {} },
      get textContent(): string { return text + (this.children as Node[]).map((c) => (c && typeof c === "object" ? c.textContent : "")).join(""); },
      set textContent(v: string) { text = v; this.children = []; },
      append(...c: unknown[]) { (this.children as unknown[]).push(...c); },
      setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); },
      getAttribute(k: string) { return this.attrs[k] ?? null; },
      get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; },
    };
    return new Proxy(base, { get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make("div") : undefined), set: (t, k, v) => { (t as Record<PropertyKey, unknown>)[k] = v; return true; } }) as unknown as Node;
  };
  const byId = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, make("div")); return nodes.get(id)!; };
  const body = make("body"); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => make(t), createElementNS: (_: string, t: string) => make(t), createTextNode: (t: string) => ({ nodeType: 3, textContent: t, children: [] }), querySelectorAll: () => [], addEventListener() {} };
  const g: Record<string, unknown> = {
    document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener() {}, setInterval: () => 1, clearInterval() {}, setTimeout: (f: () => void) => { timers.push(f); return timers.length; }, clearTimeout() {},
    fetch: async (u: string) => {
      const v = await answer(u);
      if (v instanceof Error) throw v;
      if (v && typeof v === "object" && "__status" in v) return { ok: false, status: (v as { __status: number }).__status, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(v)) };
    },
  };
  g.window = g; g.globalThis = g;
  return { g, byId, timers };
}

describe("the page renders one word", () => {
  const shell = renderReviewShell(7);
  it("the shell holds only the word, no title or sentence", () => {
    const m = /<span id="hinferred"[^>]*>([^<]*)<\/span>/.exec(shell);
    assert.ok(m, "the Inferred slot is in the shell");
    assert.equal(m![1], "Likely"); // copy: the page writes "<actor> (likely)" into it
    assert.doesNotMatch(m![0], /title=|aria-label=/);
  });

  async function shown(basis: string | null): Promise<boolean> {
    const model = JSON.parse(JSON.stringify(build("claude", basis, true).model));
    const page = makePage((u) => (u.includes("/review/model") ? model : u.includes("/view/") ? goodView : {}), "#1");
    const ctx = vm.createContext(page.g);
    for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
    await new Promise((r) => setTimeout(r, 30));
    return page.byId("hinferred").hidden; // a boolean: the stub node answers "then", so it must not be returned from an async function
  }
  it("copy: the slot names the actor with the doubt, \"<actor> (likely)\", never the bare word Inferred", async () => {
    const model = JSON.parse(JSON.stringify(build("claude", "window", true).model));
    const page = makePage((u) => (u.includes("/review/model") ? model : u.includes("/view/") ? goodView : {}), "#1");
    const ctx = vm.createContext(page.g);
    for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
    await new Promise((r) => setTimeout(r, 30));
    const t = String(page.byId("hinferred").textContent);
    assert.match(t, /^\S.* \(likely\)$/, t);
    assert.doesNotMatch(t, /Inferred/);
  });
  it("an inferred change's heading shows the word; a proven one hides it", async () => {
    assert.equal(await shown("window"), false);
    assert.equal(await shown(null), false);
    assert.equal(await shown("argv-tag"), true);
  });
});

// Inferred needs a resolvable credited call, and the Files view says the same one word beside the maker of each inferred version.
describe("gone credit shows no Inferred", () => {
  it("a change whose credited call is gone shows none, in body and rail", () => {
    const ops: RawOp[] = [prompt("s1", ["Update it."]), call("c1", { host: "claude", at: 10, end: 40, cmd: "run" }), stop("s1")];
    const st: RawState = { ...state(FILE, "n1", "n0", { open: ["c1"], credited: ["c9"] }), credit_basis: "window" };
    const input = { taskId: 1, build: "b", ops, fileStates: [st], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map([[st.id, FMT]]), quickLook: false, host: "claude" } as TimelineInput;
    const body = JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline;
    const inBody = [...body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((c) => c.changes))), ...body.unplaced];
    assert.equal(inBody.length >= 1, true);
    assert.deepEqual(inBody.map((c) => c.inferred), inBody.map(() => undefined));
    const model = buildRailModel(body);
    assert.deepEqual(model.files.flatMap((f) => f.versions.map((v) => v.inferred)), [undefined]);
  });
  it("file versions carry the flag only when inferred", () => {
    const flags = (basis: string | null, credited: boolean) => build("claude", basis, credited).model.files.flatMap((f) => f.versions.map((v) => v.inferred));
    assert.deepEqual(flags("window", true), [true]);
    assert.deepEqual(flags("argv-tag", true), [undefined]);
    assert.deepEqual(flags("window", false), [undefined]);
  });
});

describe("the Files view paints the word", () => {
  type FV = { paintStrip: (box: Node, file: unknown, p: number, h: unknown) => void; paintHead: (n: Node, o: Node, file: unknown, p: number, h: unknown) => void; paintList: (...a: unknown[]) => void };
  async function load(): Promise<{ fv: FV; mk: (t: string) => Node }> {
    const page = makePage(() => ({}), "#1");
    const ctx = vm.createContext(page.g);
    vm.runInContext(await readFile(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), ctx, { filename: "files-view.js" });
    const g = page.g as { document: { createElement: (t: string) => Node }; CoCheckFilesView?: FV };
    const fv = g.CoCheckFilesView ?? (vm.runInContext("CoCheckFilesView", ctx) as FV);
    return { fv, mk: (t) => g.document.createElement(t) };
  }
  const words = (n: Node): string[] => [n.className === "hinferred" ? n.textContent : "", ...n.children.flatMap((c) => (c && typeof c === "object" ? words(c as Node) : []))].filter(Boolean);
  const run = async (inferred: boolean, miniToo = false) => {
    const { fv, mk } = await load();
    const h = {
      el: (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]) => { const n = mk(tag); n.className = String(attrs.class ?? ""); (n.append as (...c: unknown[]) => void)(...kids.flat().filter((k) => k !== "" && k != null).map((k) => (typeof k === "string" ? { nodeType: 3, textContent: k, children: [] } : k))); return n; },
      chip: () => mk("i"), name: () => "Claude", color: () => "red",
    };
    const file = { file: "/w/model.xlsx", name: "model.xlsx", start: "kept", versions: [{ change: "c1", stop: "s1", sha: "x", lane: "claude", chip: "C", at: null, label: "Edited", kind: "modified", kept: true, ...(inferred ? { inferred: true } : {}) }] };
    const box = mk("div"), name = mk("span"), order = mk("div");
    fv.paintStrip(box, file, 1, h); fv.paintHead(name, order, file, 1, h);
    const list = mk("div"); fv.paintList(list, [file], 0, { ...h, pick() {} });
    return { strip: words(box), head: words(order), list: words(list), miniToo };
  };
  it("an inferred version reads (likely) in the head only: no text on its strip card, the doubt is in the card tooltip", async () => {
    const r = await run(true);
    assert.deepEqual(r.strip, []); // the card carries no per-card doubt text
    assert.deepEqual(r.head, ["(likely)"]);
    assert.deepEqual(r.list, []);
  });
  it("a proven, uncredited or lost-credit version shows nothing new", async () => {
    const r = await run(false);
    assert.deepEqual([r.strip, r.head, r.list], [[], [], []]);
  });
});
