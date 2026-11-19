import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// sticky notes in the bar. Harness copied from timeline-rail-composer-region-tool, with a stub server that keeps the notes the page saves.
// Guarded against: a whole-task note (no spot) can still be written AND can still take a spot; the send-back carries the notes with no id list from the page.

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
  let nextId = 0, noteSeq = 0; const server: Array<{ id: number; text: string; regionId: number | null; deleted: boolean; stop?: string | null }> = []; const regionBodies = new Map<number, any>(); const held: Array<() => void> = [];
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const answer = (j: unknown, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(j)) });
  const fetchStub = async (u: string, o?: { method?: string; body?: string }) => {
    const b = o?.body ? JSON.parse(o.body) : null;
    calls.push({ method: o?.method ?? "GET", url: u, body: b });
    if (/\/review\/notes/.test(u)) {
      const m = /\/review\/notes\/(\d+)/.exec(u);
      if (!m) { const id = ++noteSeq; server.push({ id, text: b.text, regionId: b.regionId ?? null, deleted: false, stop: b.stop ?? null }); return answer({ id }); }
      const n = server.find((x) => x.id === Number(m[1]))!; if (b.deleted) n.deleted = true; else n.text = b.text;
      return answer({ id: n.id });
    }
    if (u.includes("/review/region")) {
      const id = ++nextId; regionBodies.set(id, b); const picture = b.kind === "picture" && opts.picture !== false;
      const where = b.kind === "picture" ? `page ${b.page ?? 1} of the ${b.side} version` : b.kind === "cells" ? `${b.sheet}!${b.range}` : `lines ${b.from}-${b.to}`;
      const r = answer({ id, where, picture });
      if (opts.late) return new Promise((res) => held.push(() => res(r as never)));
      return r;
    }
    const json = u.includes("/review/status") ? { stops: {}, passes: null, notes: server.filter((n) => !n.deleted).map((n) => ({ id: n.id, text: n.text, ts: 1, regionId: n.regionId, region: n.regionId === null ? null : regionBodies.get(n.regionId), stop: n.stop ?? null, where: "a spot", picture: false })) } : u.includes("/review/model") ? model : u.includes("/review/verdict") ? { state: { status: b.status, note: b.note, history: [] }, submit: null } : u.includes("/review/sendback") ? { id: 4, prompt: "p", stops: [], nonce: "ab12cd", marker: "m" } : u.includes("/view/") ? servedFor(VIEWS[u.split("/view/")[1]!.split("?")[0]!], model, u) : {};
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
  const notePosts = () => calls.filter((c) => /\/review\/notes/.test(c.url)).map((c) => ({ url: c.url.replace(/^.*\/review/, "").replace(/\?.*$/, ""), body: c.body }));
  const marks = () => byId("nmarks").descendants().filter((n) => n.className.split(/\s+/).includes("nmark"));
  const listed = () => byId("pnotes").descendants().filter((n) => n.className.split(/\s+/).includes("pnote"));
  const saveNote = async (text: string) => { byId("nnote").value = text; byId("ngo").click(); await settle(); };
  return { notePosts, marks, listed, saveNote, server, model, poll, verdictPosts, byId, calls, wrap, cellAt, lineAt, dragOn, down, up, regionPosts, chips, openFail, openNote, next, body, free, box, key, listeners, settle, held, find, pane };
}



type P = Awaited<ReturnType<typeof boot>>;
const draw = async (p: P, target: N) => { p.box(); await p.dragOn(target, 200, 100, target, 300, 300); };

describe("sticky notes in the bar", () => {
  it("three notes on three spots, then edit one and delete one: the bar list and the markers follow", async () => {
    const p = await boot(["k1", "k3"]);
    // note 1: picture before; note 2: picture after (same change, other side); note 3: a text line on the next change
    await p.openNote(); await draw(p, p.wrap("before")); await p.saveNote("first");
    await p.openNote(); await draw(p, p.wrap("after")); await p.saveNote("second");
    assert.equal(p.byId("ncomp").hidden, true, "Save closes the composer, ready for the next");
    await p.next();
    await p.openNote(); await p.dragOn(p.lineAt("before", 2), 10, 10, p.lineAt("before", 3), 10, 40); await p.saveNote("third");
    assert.deepEqual(p.notePosts().map((x) => x.body), [{ text: "first", regionId: 1, stop: "chg-k1" }, { text: "second", regionId: 2, stop: "chg-k1" }, { text: "third", regionId: 3, stop: "chg-k3" }]);
    assert.equal(p.listed().length, 3, "the bar lists every live note");
    assert.deepEqual(p.marks().map((m) => m.attrs["data-side"]), ["before"], "on the text change only the third note's marker, on its side");
    p.byId("pbprev").click(); await p.settle();
    assert.deepEqual(p.marks().map((m) => m.attrs["data-side"]).sort(), ["after", "before"], "back on the picture: the first two");
    // edit the second from its list entry: it reopens with its text, and Save posts the edit
    const entry = (n: number) => p.listed()[n]!.children;
    entry(1)[0]!.click(); await p.settle();
    assert.equal(p.byId("ncomp").hidden, false); assert.equal(p.byId("nnote").value, "second");
    await p.saveNote("second, edited");
    assert.deepEqual(p.notePosts().at(-1), { url: "/notes/2", body: { text: "second, edited" } });
    assert.match(p.listed()[1]!.textContent, /second, edited/);
    // delete the first
    entry(0)[1]!.click(); await p.settle();
    assert.deepEqual(p.notePosts().at(-1), { url: "/notes/1", body: { deleted: true } });
    assert.equal(p.listed().length, 2);
    assert.deepEqual(p.marks().map((m) => m.attrs["data-side"]), ["after"], "the deleted note's marker is gone");
    // send back: the page names no notes; the server carries the live ones
    p.byId("sendback").click(); await p.settle();
    assert.deepEqual(p.calls.find((c) => c.url.includes("/review/sendback"))!.body, {});
  });

  it("a note being typed survives a poll, with its spot and its open composer", async () => {
    const p = await boot(["k1"]);
    await p.openNote(); await draw(p, p.wrap("before"));
    p.byId("nnote").value = "half a thou";
    await p.poll();
    assert.equal(p.byId("ncomp").hidden, false); assert.equal(p.byId("nnote").value, "half a thou");
    assert.equal(p.chips("nchips").length, 1, "the spot stays");
    await p.saveNote("half a thought, done");
    assert.deepEqual(p.notePosts()[0]!.body, { text: "half a thought, done", regionId: 1, stop: "chg-k1" });
  });

  it("markers survive a live refresh and hide under the clean toggle", async () => {
    const p = await boot(["k1"]);
    await p.openNote(); await draw(p, p.wrap("after")); await p.saveNote("marked");
    assert.equal(p.marks().length, 1);
    await p.poll(); assert.equal(p.marks().length, 1, "a poll redraws the marker, never drops it");
    assert.equal(p.listed().length, 1);
    p.byId("cleanbtn").click(); await p.settle();
    assert.match(p.body.className, /clean/);
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /body\.clean [^{]*\.nmarks[^{]*\{display:none\}/, "body.clean hides the markers");
  });

  it("a whole-task note can be written with no spot and can still take a spot", async () => {
    const p = await boot(["k1"]);
    await p.openNote(); await p.saveNote("whole task");
    await p.openNote(); await draw(p, p.wrap("before")); await p.saveNote("with a spot");
    assert.deepEqual(p.notePosts().map((x) => x.body), [{ text: "whole task", stop: "chg-k1" }, { text: "with a spot", regionId: 1, stop: "chg-k1" }]);
    assert.equal(p.listed().length, 2);
    assert.equal(p.marks().length, 1, "only the note with a spot has a marker");
    assert.equal((p.byId("sendback") as unknown as { disabled: boolean }).disabled, false, "notes alone enable Send back");
    p.byId("sendback").click(); await p.settle();
    assert.equal(p.calls.filter((c) => c.url.includes("/review/sendback")).length, 1);
  });

  it("anchor: a Note-button note with no spot records the step on show, and its list entry goes back to that step; an old note with no step opens, stays put, no error", async () => {
    const p = await boot(["k1", "k3"]);
    await p.next();
    await p.openNote(); await p.saveNote("plain on k3");
    assert.deepEqual(p.notePosts().at(-1)!.body, { text: "plain on k3", stop: "chg-k3" });
    p.server.push({ id: 99, text: "old, no step", regionId: null, deleted: false }); // a note saved before the anchor existed
    await p.poll();
    p.byId("pbprev").click(); await p.settle();
    const here = async () => { p.byId("nno").click(); await p.openNote(); await p.saveNote("where am I"); return p.notePosts().at(-1)!.body.stop; };
    assert.equal(await here(), "chg-k1", "on k1 before clicking");
    p.listed()[0]!.children[0]!.click(); await p.settle();
    assert.equal(p.byId("nnote").value, "plain on k3", "the entry opens the note");
    assert.equal(await here(), "chg-k3", "clicking the note's entry went to the step it was made on");
    p.byId("pbprev").click(); await p.settle();
    const old = p.listed().find((x) => x.attrs["data-note"] === "99")!;
    old.children[0]!.click(); await p.settle();
    assert.equal(p.byId("nnote").value, "old, no step", "the old note still opens for editing");
    assert.equal(await here(), "chg-k1", "an old note with no step leaves the page where it was");
  });

  it("the old whole-task page elements are gone", () => {
    const html = renderReviewShell(7);
    for (const id of ["notepanel", "sbnote", "notebtn"]) assert.equal(html.includes(`id="${id}"`), false, id);
    assert.equal(html.includes('id="pbnote"'), true);
  });
});
