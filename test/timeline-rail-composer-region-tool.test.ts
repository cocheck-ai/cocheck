import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// The composer and the task note own the region tool. Harness copied from timeline-rail-regions-page.
// the Point tool replaces drag-while-a-note-is-open. Off, no drag is captured; on (Box or Freehand), a drag posts a spot to the fail box of the step on show, else the task note (opened if closed).
// A drag on a picture, the grid or the text diff points at a spot. The page posts the
// region shape (serves it; here the server's answers are stubbed), shows a chip, and hands the chip ids to the verdict and the send-back.
// Guarded against: a drag on the before pane never posts side "after", and a chip never survives into a different step's fail box.
// The page code runs as is in a vm with a DOM stub that keeps attributes, parents, listeners and hidden state.

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

const SHA = "a".repeat(64);
const cell = (ref: string, text: string) => ({ ref, text, value: text, formula: null, numFmt: "General", fill: null, bold: false });
const gridPane = (side: string, sheet: string) => ({ id: `${side}:${sheet}`, label: `${sheet}, ${side}`, grid: { sheet, state: "visible", columns: ["A", "B", "C", "D"].map((name) => ({ name, width: null, hidden: false })), rows: [4, 5, 9].map((row) => ({ row, hidden: false, cells: Object.fromEntries(["A", "B", "C", "D"].map((c) => [c, cell(`${c}${row}`, `${side}${c}${row}`)])) })), merges: [], moreRows: 0 } });
const textPane = (side: string) => ({ id: `${side}:t`, label: `${side} text`, text: { lines: [1, 2, 3, 4].map((n) => ({ n, text: `${side} line ${n}`, marks: [] })) } });
const picPane = (side: string, page: number | null) => ({ id: `${side}:p`, label: `${side} picture`, picture: { sha: SHA, width: 800, height: 1000, ...(page ? { page } : {}) } });
const view = (change: string, kind: string, before: unknown[], after: unknown[]) => ({ change, file: `${change}.bin`, engine: "", kind, before, after, boxes: [], caveats: [] });
const VIEWS: Record<string, unknown> = {
  k1: view("k1", "picture", [picPane("before", 2)], [picPane("after", 2)]),
  k2: view("k2", "grid", [gridPane("before", "Data"), gridPane("before", "Other")], [gridPane("after", "Data"), gridPane("after", "Other")]),
  k3: view("k3", "text", [textPane("before")], [textPane("after")]),
  k4: view("k4", "picture", [picPane("before", null)], [picPane("after", null)]),
};
const stopOf = (key: string) => ({ id: `chg-${key}`, label: `${key}.bin`, lane: "main", head: `Claude changed ${key}.bin`, change: { key, file: `${key}.bin`, kind: "modified", note: `Changed ${key}.bin.`, rowNotes: [], moreNote: null, viewUrl: `/timeline/7/view/${key}`, secret: false, secretLine: null, failed: null, ask: null, newFile: null, treeBefore: null, treeAfter: null } });

interface Call { method: string; url: string; body: any }
async function boot(keys: string[], opts: { picture?: boolean; late?: boolean; tool?: boolean } = {}) {
  const files = keys.map((k) => ({ file: `${k}.bin`, name: `${k}.bin`, versions: [{ change: k, stop: `chg-${k}`, sha: "", lane: "main", chip: "C", at: null, label: "Changed", kind: "modified", kept: true }] }));
  const model: any = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops: keys.map(stopOf), files };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  for (const id of ["ncomp", "pcomp", "sbout", "toast"]) byId(id).hidden = true; // the page ships these hidden
  byId("stage").append(byId("pb"), byId("pa")); byId("pb").append(byId("tb"), byId("trb"), byId("vb")); byId("pa").append(byId("ta"), byId("tra"), byId("va"));
  const polls: Array<() => void> = []; const calls: Call[] = []; const listeners: Record<string, Array<(e: unknown) => void>> = {};
  let nextId = 0; const held: Array<() => void> = [];
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const answer = (j: unknown, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(j)) });
  const fetchStub = async (u: string, o?: { method?: string; body?: string }) => {
    const b = o?.body ? JSON.parse(o.body) : null;
    calls.push({ method: o?.method ?? "GET", url: u, body: b });
    if (u.includes("/review/region")) {
      const id = ++nextId, picture = b.kind === "picture" && opts.picture !== false;
      const where = b.kind === "picture" ? `page ${b.page ?? 1} of the ${b.side} version` : b.kind === "cells" ? `${b.sheet}!${b.range}` : `lines ${b.from}-${b.to}`;
      const r = answer({ id, where, picture });
      if (opts.late) return new Promise((res) => held.push(() => res(r as never)));
      return r;
    }
    const json = u.includes("/review/status") ? { stops: {}, passes: null } : u.includes("/review/model") ? model : u.includes("/review/verdict") ? { state: { status: b.status, note: b.note, history: [] }, submit: null } : u.includes("/review/sendback") ? { id: 4, prompt: "p", stops: [], nonce: "ab12cd", marker: "m" } : u.includes("/view/") ? servedFor(VIEWS[u.split("/view/")[1]!.split("?")[0]!], model, u) : {};
    return answer(json);
  };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, setInterval, clearInterval, setTimeout: (f: () => void, ms: number) => { if (f.name === "poll") { polls.push(f); return 0 as never; } return setTimeout(f, ms); }, clearTimeout, fetch: fetchStub,
    addEventListener: (k: string, f: (e: unknown) => void) => { (listeners[k] ??= []).push(f); } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 25));
  await settle();
  byId("vsteps").click(); await settle(); // the page opens on Deliverables when the model lists files
  const find = (root: N, pred: (n: N) => boolean) => root.descendants().filter(pred);
  const pane = (side: "before" | "after") => byId(side === "before" ? "vb" : "va");
  const wrap = (side: "before" | "after", box = { left: 100, top: 50, width: 400, height: 500 }) => {
    const w = find(pane(side), (n) => n.className.split(/\s+/).includes("pagewrap")).find((n) => !n.closest(".vw[hidden]"))!;
    w.rect = { ...box, right: box.left + box.width, bottom: box.top + box.height };
    return w;
  };
  const cellAt = (side: "before" | "after", ref: string) => find(pane(side), (n) => n.attrs["data-cell"] === ref).find((n) => !n.closest(".vw[hidden]"))!;
  const lineAt = (side: "before" | "after", n: number) => find(pane(side), (x) => x.attrs["data-line"] === String(n))[0]!;
  const down = (target: N, x: number, y: number) => byId("stage").listeners.mousedown?.forEach((f) => f({ target, clientX: x, clientY: y, button: 0, preventDefault() {} }));
  const up = async (target: N, x: number, y: number) => { (listeners.mouseup ?? []).forEach((f) => f({ target, clientX: x, clientY: y, button: 0 })); await settle(); };
  const dragOn = async (a: N, ax: number, ay: number, b: N = a, bx = ax, by = ay) => { down(a, ax, ay); (listeners.mousemove ?? []).forEach((f) => f({ target: b, clientX: bx, clientY: by })); await up(b, bx, by); };
  const regionPosts = () => calls.filter((c) => c.url.includes("/review/region")).map((c) => c.body);
  const chips = (id: string) => byId(id).descendants().filter((n) => n.className.split(/\s+/).includes("rchip"));
  const openFail = async () => { byId("pbfail").click(); await settle(); };
  const openNote = async () => { byId("pbnote").click(); await settle(); };
  const free = () => byId("regfree").click();
  const box = () => byId("regbox").click();
  const key = (k: string) => (listeners.keydown ?? []).forEach((f) => f({ key: k, target: mkNode(), preventDefault() {} }));
  const next = async () => { byId("pbnext").click(); await settle(); };
  const poll = async () => { const f = polls.pop(); assert.ok(f, "a poll is scheduled"); f(); await settle(); await settle(); };
  const verdictPosts = () => calls.filter((c) => c.url.includes("/review/verdict")).map((c) => c.body);
  return { model, poll, verdictPosts, byId, calls, wrap, cellAt, lineAt, dragOn, down, up, regionPosts, chips, openFail, openNote, next, body, free, box, key, listeners, settle, held, find, pane };
}


const ring: Array<[number, number]> = [[200, 100], [300, 100], [350, 200], [300, 300], [200, 300], [150, 200], [200, 100]];
const freehand = async (p: Awaited<ReturnType<typeof boot>>, target: N) => {
  p.byId("regfree").click();
  p.down(target, ring[0]![0], ring[0]![1]);
  for (const [x, y] of ring.slice(1, -1)) (p.listeners.mousemove ?? []).forEach((f) => f({ target, clientX: x, clientY: y }));
  const l = ring.at(-1)!; await p.up(target, l[0], l[1]);
};

describe("the fail composer owns the region tool", () => {
  it("with the composer closed the task note panel still offers Box and Freehand, and a region attaches to the note", async () => {
    const p = await boot(["k1"]);
    await p.openNote();
    assert.equal(p.byId("pcomp").hidden, true);
    p.byId("nregfree").click();
    assert.equal(p.byId("nregfree").attrs["aria-pressed"], "true"); assert.equal(p.byId("nregbox").attrs["aria-pressed"], "false");
    const w = p.wrap("before");
    await freehand(p, w);
    const posts = p.regionPosts();
    assert.equal(posts.length, 1); assert.equal(posts[0].shape.type, "lasso");
    assert.equal(p.chips("nchips").length, 1); assert.equal(p.chips("vchips").length, 0);
    p.byId("nregbox").click();
    await p.dragOn(w, 200, 100, w, 300, 300);
    assert.equal(p.chips("nchips").length, 1, "a sticky note points at one spot, a newer draw replaces the older");
  });

  it("the draw cursor (body.regon) and drawing exist only while the composer or the note panel is open", async () => {
    const p = await boot(["k1"]);
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300); assert.equal(p.regionPosts().length, 0, "closed: nothing is drawn");
    assert.doesNotMatch(p.body.className, /regon/);
    await p.openFail(); assert.match(p.body.className, /regon/);
    assert.equal(p.byId("pcomp").hidden, false);
  });

  it("a poll that inserts a stop before the failing one while the composer is open; Save lands note and region on the intended stop id", async () => {
    const p = await boot(["k3"]);
    await p.openFail();
    p.byId("vnote").value = "wrong line";
    const w = p.lineAt("before", 1);
    await p.dragOn(w, 1, 1, p.lineAt("before", 3), 1, 40);
    assert.equal(p.regionPosts().length, 1); assert.equal(p.chips("vchips").length, 1);
    p.model.stops.splice(0, 0, stopOf("k4"));
    await p.poll();
    assert.equal(p.byId("pcomp").hidden, false, "the composer survives the refresh");
    assert.equal(p.byId("vnote").value, "wrong line");
    assert.equal(p.chips("vchips").length, 1);
    p.byId("vfailgo").click(); await p.settle();
    const v = p.verdictPosts();
    assert.equal(v.length, 1); assert.equal(v[0].stop, "chg-k3"); assert.equal(v[0].note, "wrong line"); assert.deepEqual(v[0].regions, [1]);
  });

  it("two stops failed, one with Box and one with Freehand: both verdicts carry their note and their own region", async () => {
    const p = await boot(["k1", "k3"]);
    await p.openFail(); p.byId("vnote").value = "first";
    const w = p.wrap("before"); await p.dragOn(w, 200, 100, w, 300, 300);
    p.byId("vfailgo").click(); await p.settle();
    p.byId("pbnext").click(); for (let i = 0; i < 8; i++) await p.settle(); console.log("DBG", p.find(p.byId("vb"), (n) => n.className.includes("pagewrap")).length, p.find(p.byId("va"), (n) => n.className.includes("pagewrap")).length, p.byId("vb").children.length, p.byId("vsteps").hidden, p.byId("pbpos").textContent, p.byId("pblabel").textContent);
    await p.openFail(); p.byId("vnote").value = "second";
    for (const n of [1, 2, 3, 4]) p.lineAt("before", n).rect = { left: 100, top: 100 + n * 20, width: 300, height: 20, right: 400, bottom: 120 + n * 20 };
    p.byId("regfree").click(); const t = p.lineAt("before", 2), path: Array<[number, number]> = [[120, 145], [300, 145], [300, 185], [120, 185], [120, 145]];
    p.down(t, path[0]![0], path[0]![1]); for (const [x, y] of path.slice(1, -1)) (p.listeners.mousemove ?? []).forEach((f) => f({ target: t, clientX: x, clientY: y })); await p.up(t, 120, 145);
    p.byId("vfailgo").click(); await p.settle();
    const posts = p.regionPosts(), v = p.verdictPosts();
    assert.equal(posts.length, 2); assert.equal(posts[0].shape, undefined); assert.equal(posts[0].kind, "picture"); assert.equal(posts[1].kind, "lines"); assert.equal(p.byId("regfree").attrs["aria-pressed"], "true");
    assert.deepEqual(v.map((x) => [x.stop, x.status, x.note, x.regions]), [["chg-k1", "failed", "first", [1]], ["chg-k3", "failed", "second", [2]]]);
  });

  it("U on a failed stop puts the composer back with its note and region as a draft", async () => {
    const p = await boot(["k1"]);
    await p.openFail(); p.byId("vnote").value = "keep me";
    const w = p.wrap("before"); await p.dragOn(w, 200, 100, w, 300, 300);
    p.byId("vfailgo").click(); await p.settle();
    assert.equal(p.byId("pcomp").hidden, true);
    p.key("u"); await p.settle(); await p.settle();
    assert.equal(p.verdictPosts().at(-1).status, "not_reviewed");
    assert.equal(p.byId("pcomp").hidden, false);
    assert.equal(p.byId("vnote").value, "keep me");
    assert.equal(p.chips("vchips").length, 1);
  });
});
