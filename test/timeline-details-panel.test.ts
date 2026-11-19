import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { servedFor } from "./helpers/v1-served.ts";
/* eslint-disable @typescript-eslint/no-explicit-any */
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
const VT = (globalThis as any).CoCheckViewTable;

// fix/notes-panel: the quiet grey notes (who drew the picture, the tally, "N changes have no box", "not marked", "Structure checked", the view's caveats) leave the
// page flow and sit in one Details panel opened from the bottom bar, grouped by step and deduplicated. Guarded cases: (1) a note shown under a chat message
// (it belongs to a file step), (2) a change that reaches the page nowhere (it must still be in the panel), (3) the connector's technical reason shown to the reviewer.

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, any> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; value = ""; focused = false; nodeType = 1; rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: Array<N | string>) { for (const y of c) { const x = typeof y === "string" ? Object.assign(mkNode("#text"), { _text: y, nodeType: 3 }) : y; x.parentNode = this; this.children.push(x); } }
  removeChild(c: N) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  insertBefore(c: N, ref: N | null) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  get nextSibling(): N | null { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] ?? null; }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { if (!s.className.split(/\s+/).includes(c)) s.className = (s.className + " " + c).trim(); }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x && x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(sel: string): N | null {
    for (let n: N | null = this; n; n = n.parentNode) {
      if (sel === ".vw[hidden]" && n.hidden && n.className.split(/\s+/).includes("vw")) return n;
      if (sel === ".pane" && n.className.split(/\s+/).includes("pane")) return n;
    }
    return null;
  }
  getBoundingClientRect() { return this.rect; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  has(c: string) { return this.className.split(/\s+/).includes(c); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

const SHA = "a".repeat(64);
const TECH = "not marked: rows 2 and 1999 are tied to the same two lines";
const pane = (side: string) => ({ id: `${side}:page1`, label: `${side} page 1`, picture: { sha: SHA, width: 1000, height: 1400, page: 1 } });
const rect = (x: number, y: number) => ({ x, y, w: 300, h: 60 });
const card = { place: "", verb: "Added", before: null, after: "Sheet NVDA YoY", text: null, loc: "paragraph 1", full: { before: null, after: "Sheet NVDA YoY" } };
const card2 = { place: "", verb: null, before: "Revenue was 3", after: "Revenue was 4", text: null, loc: "paragraph 2", full: { before: "Revenue was 3", after: "Revenue was 4" } };
// k1's change c1 is unplaced on the After side with the connector's technical reason; c2 is boxed on both sides
const viewFor = (key: string) => ({
  change: key, file: "d.docx", engine: "LibreOffice", kind: "pages", before: [pane("before")], after: [pane("after")], boxes: [],
  caveats: ["Word prints comments in a side pane, so comments are hidden on these pages"],
  changes: [
    { id: "k1", loc: "paragraph 1", kind: "paragraph", parent: null, boxes: [], unplaced: { after: TECH } },
    { id: "k2", loc: "paragraph 2", kind: "paragraph", parent: null, boxes: [{ side: "before", pane: "before:page1", rect: rect(100, 200) }, { side: "after", pane: "after:page1", rect: rect(100, 220) }] },
  ],
});
const fileStop = (id: string, key: string) => ({ id, label: "d.docx", lane: "main", head: `Claude changed d.docx (${key})`, change: { key, file: "d.docx", kind: "modified", note: "Changed d.docx.", rowNotes: [], moreNote: null, viewUrl: `/timeline/7/view/${key}`, secret: false, secretLine: null, failed: null, ask: null, newFile: null, treeBefore: null, treeAfter: null, cards: [card, card2] } });
const msgStop = { id: "msg-1", label: "To you", lane: "main", head: "Claude wrote to you", message: { from: "main", to: null, toName: "you", lines: ["All done."] } };

async function boot(over: { stops?: unknown[]; ls?: Record<string, string> | "throws"; hash?: string } = {}) {
  const stops = over.stops ?? [fileStop("chg-a", "ka"), msgStop, fileStop("chg-b", "kb")];
  const model = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops, files: [] };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  for (const id of ["ncomp", "pcomp", "sbout", "toast", "detpanel", "pbdcount"]) byId(id).hidden = true;
  byId("detpanel").append(byId("detlist")); // as in the shell (page.ts)
  const holder = mkNode(); holder.append(byId("stage"));
  byId("pb").className = "pane before"; byId("pa").className = "pane after";
  byId("stage").append(byId("pb"), byId("pa")); byId("pb").append(byId("tb"), byId("trb"), byId("vb")); byId("pa").append(byId("ta"), byId("tra"), byId("va"));
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const everyNode = (): N[] => [...nodes.values(), body, holder].flatMap((n) => [n, ...n.descendants()]).filter((n, i, a) => a.indexOf(n) === i);
  const views: string[] = [];
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const document: any = { body, activeElement: null, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: (sel: string) => { const m = /^\.bx\.cf\[data-change="([^"]+)"\]$/.exec(sel); return m ? everyNode().filter((n) => n.has("bx") && n.has("cf") && n.attrs["data-change"] === m[1]) : sel === ".row" ? [] : []; }, addEventListener() {} };
  const answer = (j: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(j)) });
  const fetchStub = async (u: string) => {
    if (u.includes("/view/")) { const key = /\/view\/([^/?#]+)/.exec(u)![1]!; views.push(key); if (key === "kx") return { ok: false, status: 500, json: async () => ({}) }; return answer(servedFor(viewFor(key), model, u)); }
    return answer(u.includes("/review/status") ? { stops: {}, passes: null } : u.includes("/review/model") ? model : {});
  };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: over.hash ?? "#0" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, fetch: fetchStub, navigator: {},
    addEventListener: (k: string, f: (e: unknown) => void) => { (listeners[k] ??= []).push(f); } };
  const store: Record<string, string> = over.ls && over.ls !== "throws" ? { ...over.ls } : {};
  g.localStorage = over.ls === "throws" ? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } } : { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  document.documentElement = mkNode("html");
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = async () => { for (let k = 0; k < 8; k++) await new Promise((r) => setTimeout(r, 15)); };
  await settle();
  const key = async (k: string) => { (listeners.keydown ?? []).forEach((f) => f({ key: k, target: { tagName: "BODY", classList: { contains: () => false }, closest: () => null }, preventDefault() {} })); await settle(); };
  // what a reviewer reads in the page flow: everything except the Details panel itself and the bottom bar
  const flowText = () => everyNode().filter((n) => n.parentNode === null || n === holder).filter((n) => !["detpanel", "pbar", "pbdcount", "pbdetails"].includes(n.id))
    .map((n) => (n.hidden ? "" : n.textContent)).join("\n");
  return { byId, everyNode, holder, settle, key, flowText, views, g, store, root: document.documentElement as N };
}

describe("the Details log is raw: each note verbatim, with its source", () => {
  const item = (unplaced: Record<string, string>, priv?: Record<string, unknown>) => ({ id: "c1", kind: null, parent: null, boxes: [], unplaced, lines: [], comment: { head: "Sheet NVDA YoY", verb: "Added", before: null, after: null, text: null, lines: [] }, mark: "added", change: { id: "c1", mark: "added", unplaced, ...(priv ? { private: priv } : {}) } });
  it("an unplaced side logs the connector's reason as it wrote it, with the side, the change and the connector id", () => {
    const view = { source: { by: "connector", name: "microsoft-excel", level: 3, text: "Picture from microsoft-excel" }, changeFirst: true, items: [item({ after: TECH })], caveats: ["Book!A1:D31 printed on 2 pages; only its first page is shown."], before: [], after: [] };
    const notes = VT.stepNotes(view);
    assert.deepEqual(notes.map((n: any) => [n.src, n.text]), [
      ["microsoft-excel", "Picture from microsoft-excel"], ["microsoft-excel", "1 added"],
      ["microsoft-excel", `unplaced after: ${TECH} | Sheet NVDA YoY: Added`],
      ["microsoft-excel", "Book!A1:D31 printed on 2 pages; only its first page is shown."],
    ]);
  });
  it("a technical reason kept in private.unplacedWhy is the one logged; a failed change list logs nothing (its body says why)", () => {
    const n = VT.stepNotes({ changeFirst: true, items: [item({ after: "not marked" }, { unplacedWhy: { after: "rows 2 and 1999 are tied to the same two lines" } })], caveats: [], before: [], after: [] });
    assert.equal(n[n.length - 1].text, "unplaced after: rows 2 and 1999 are tied to the same two lines | Sheet NVDA YoY: Added");
    assert.equal(n[n.length - 1].src, "cocheck");
    assert.deepEqual(VT.stepNotes({ failed: true, caveats: ["the connector crashed"], items: [] }), []);
  });
  it("the same-pictures banner is a log line too (no grid is drawn, so no line says rows were left out of one)", () => {
    const n = VT.stepNotes({ items: [], caveats: [], before: [{ grid: { moreRows: 4 } }], after: [], banner: { title: "No visible difference", text: "Cell B2 changed. The pages look the same on both sides (rule)." } });
    assert.deepEqual(n.map((x: any) => x.text), ["No visible difference: Cell B2 changed. The pages look the same on both sides (rule)."]);
  });
});

describe("notes are grouped by step and deduplicated", () => {
  it("a note said on several steps appears once with every step listed; per-step notes stay under their own step", () => {
    const r = VT.groupNotes([{ step: "a", notes: [{ kind: "source", src: "x", text: "Picture from x" }, { kind: "tally", src: "x", text: "1 added" }] }, { step: "b", notes: [{ kind: "source", src: "x", text: "Picture from x" }, { kind: "tally", src: "x", text: "2 added" }] }]);
    assert.equal(r.count, 3);
    assert.deepEqual(r.entries.map((e: any) => [[...e.steps], e.src, e.text]), [[["a", "b"], "x", "Picture from x"], [["a"], "x", "1 added"], [["b"], "x", "2 added"]]);
  });
});

describe("the review page: no grey notes in the flow, one Details panel in the bar", () => {
  it("a file step shows no words list, source, tally, caveats or clean structure badge; the unmarked change is in the panel in plain words", async () => {
    const p = await boot();
    const flow = p.flowText();
    for (const bad of [/no box on these pages/, /not marked/i, /tied to the same two lines/, /Made by CoCheck/, /Structure checked/, /comments are hidden/, /no place in the picture/, /\b\d+ (added|changed)\b/])
      assert.doesNotMatch(flow, bad, `the page flow says ${bad}`);
    assert.equal(p.everyNode().filter((n) => n.has("cfwords") || n.has("sbadge") || n.has("unplaced")).length, 0);
    assert.equal(p.byId("pbdcount").hidden, false, "the count shows when there are notes");
    assert.ok(Number(p.byId("pbdcount").textContent) >= 3, p.byId("pbdcount").textContent);
    const entries = (p.g as any).CoCheckDetails.entries();
    const un = entries.filter((e: any) => e.kind === "unplaced");
    assert.equal(un.length, 1, JSON.stringify(entries));
    assert.equal(un[0].text, `unplaced after: ${TECH} | paragraph 1: Added: Sheet NVDA YoY`, "verbatim, the technical reason included");
    // the clean structure badge is not drawn (tolerated and clean give nothing anywhere)
    assert.ok(!entries.some((e: any) => e.kind === "structure" || /Structure checked/.test(e.text)), "no clean structure note");
    assert.ok(entries.some((e: any) => /comments are hidden/.test(e.text)), "the caveat is a note");
  });
  it("a chat message after a file step shows none of the file step's notes (they belong to the file step)", async () => {
    const p = await boot();
    await p.key("ArrowRight");
    assert.match(p.byId("h1").textContent, /wrote to you/);
    const flow = p.flowText();
    assert.match(flow, /All done\./);
    assert.doesNotMatch(flow, /no box on these pages|not marked|unplaced/i);
    assert.equal(p.everyNode().filter((n) => n.has("cfwords") && n.parentNode !== null).length, 0);
    const entries = (p.g as any).CoCheckDetails.entries();
    assert.ok(entries.every((e: any) => !e.steps.includes("msg-1")), "no note is filed under a message");
  });
  it("opening the panel reads only the step on show and lists only its notes", async () => {
    const p = await boot();
    p.byId("pbdetails").click(); await p.settle();
    assert.equal(p.byId("detpanel").hidden, false);
    assert.equal(p.byId("pbdetails").attrs["aria-expanded"], "true");
    assert.ok(!p.views.includes("kb"), "the panel did not ask for a step that is not on show");
    const entries = (p.g as any).CoCheckDetails.entries();
    assert.ok(entries.length >= 3);
    assert.ok(entries.every((e: any) => [...e.steps].join() === "chg-a"), JSON.stringify(entries));
    const panel = p.byId("detpanel").textContent;
    assert.equal(panel.split("tied to the same two lines").length - 1, 1, panel);
    assert.ok(!p.byId("detpanel").descendants().some((n) => n.tag === "button" && n.attrs["data-step"] === "chg-b"), "no entry names another step");
    const lines = [...(p.g as any).CoCheckDetails.lines()];
    assert.ok(lines.every((l: string) => /^#1 /.test(l)), lines.join("\n"));
  });
  it("the bar's Details control is its own button, distinct from Note, with a count badge", async () => {
    const html = await readFile(new URL("../src/timeline/rail/page.ts", import.meta.url), "utf8");
    assert.match(html, /id="pbdetails"[^>]*aria-controls="detpanel"/);
    assert.match(html, /id="pbdcount"[^>]*hidden/);
    assert.match(html, /id="pbnote"/);
    assert.match(html, /id="detpanel"[^>]*hidden/);
    assert.match(html, /id="detclose"[^>]*aria-label="Close details"/);
    assert.match(html, /id="detcopy"/);
  });
});

// the Details panel and its count speak only of the step on screen (on a call header, of its files). Guarded against: hiding the step's own
// notes (its caveat, its unplaced change; there is no clean structure line) along with the other steps' - each must still be there for the step on show.
describe("Details is for the step on screen", () => {
  const countOf = (p: Awaited<ReturnType<typeof boot>>) => (p.byId("pbdcount").hidden ? 0 : Number(p.byId("pbdcount").textContent));
  it("the count is the on-screen step's own notes, and moving to another step updates it", async () => {
    const p = await boot();
    const own = (p.g as any).CoCheckDetails.entries();
    assert.ok(own.every((e: any) => [...e.steps].join() === "chg-a"), JSON.stringify(own));
    assert.equal(countOf(p), own.length, "the count is the step's own notes");
    for (const kind of ["unplaced"]) assert.ok(own.some((e: any) => e.kind === kind), `the step's own ${kind} note is still listed`);
    assert.ok(own.some((e: any) => /comments are hidden/.test(e.text)), "the step's own caveat is still listed");
    await p.key("ArrowRight"); // the chat message: no notes, no count
    assert.equal(p.byId("pbdcount").hidden, true);
    assert.equal(countOf(p), 0);
    assert.deepEqual([...(p.g as any).CoCheckDetails.entries()], []);
    await p.key("ArrowRight"); // the next file step: its notes, not the first step's
    await p.settle();
    const next = (p.g as any).CoCheckDetails.entries();
    assert.ok(next.length > 0 && next.every((e: any) => [...e.steps].join() === "chg-b"), JSON.stringify(next));
    assert.equal(countOf(p), next.length);
  });
  it("a step with no notes shows no count, even while another step's notes exist, and the panel says so", async () => {
    const p = await boot({ stops: [msgStop, fileStop("chg-a", "ka")] });
    await p.settle();
    assert.equal(p.byId("pbdcount").hidden, true, JSON.stringify((p.g as any).CoCheckDetails.entries()));
    assert.equal(p.byId("pbdetails").attrs["aria-label"], "Details");
    p.byId("pbdetails").click(); await p.settle();
    assert.match(p.byId("detpanel").textContent, /Nothing logged\./);
    assert.ok(!p.views.includes("ka"), "the step that is not on show was not read for it");
  });
  it("on a call header the panel holds its own files' notes and not another step's", async () => {
    const call = { id: "k-call", text: "Ran the build" };
    const a = { ...fileStop("chg-a", "ka"), call }, b = { ...fileStop("chg-b", "kb"), call };
    const p = await boot({ stops: [a, b, fileStop("chg-c", "kc")] });
    p.byId("pbdetails").click(); await p.settle();
    assert.match(p.byId("h1").textContent, /Ran the build/, "the header is on show");
    const entries = (p.g as any).CoCheckDetails.entries();
    const steps = new Set(entries.flatMap((e: any) => [...e.steps]));
    assert.deepEqual([...steps].sort(), ["chg-a", "chg-b"], "both files of the header, and not the file outside it");
    assert.ok(!p.views.includes("kc"), "the file outside the header was not read");
  });
});
