import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { servedFor } from "./helpers/v1-served.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
/* eslint-disable @typescript-eslint/no-explicit-any */
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
const VT = (globalThis as any).CoCheckViewTable;

// The quiet grey notes (who drew the picture, the tally, "N changes have no box", "not marked", "Structure checked", the view's caveats) leave the
// page flow and sit in one Details panel opened from the bottom bar, grouped by step and deduplicated. Must not happen: (1) a note shown under a chat message
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
const fileStop = (id: string, key: string, quiet?: unknown) => ({ ...(quiet ? { quiet } : {}), id, label: "d.docx", lane: "main", head: `Claude changed d.docx (${key})`, change: { key, file: "d.docx", kind: "modified", note: "Changed d.docx.", rowNotes: [], moreNote: null, viewUrl: `/timeline/7/view/${key}`, secret: false, secretLine: null, failed: null, ask: null, newFile: null, treeBefore: null, treeAfter: null, cards: [card, card2], structure: { level: "clean", text: "Structure checked", lines: [] } } });
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
    if (u.includes("/view/")) { const key = /\/view\/([^/?#]+)/.exec(u)![1]!; views.push(key); return answer(servedFor(viewFor(key), model, u)); }
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


// Two choices that belong to the viewer a Light / Dark / Match system theme, and "Show commands that changed nothing" (the rail's
// quiet rows), off by default. Both are remembered in localStorage. For the second, a row that changed a file must never be hidden, and
// a step is never hidden; the real steps, the verdict counts and the keyboard order are the same either way.
const QUIET = { count: 3, calls: [{ id: "q1", text: "Read the sheet", lane: "main" }, { id: "q2", text: "List the folder", lane: "main" }, { id: "q3", text: "Run the checks", lane: "main" }] };
const stops = () => [fileStop("chg-a", "ka", QUIET), msgStop, fileStop("chg-b", "kb")];
const rail = (p: Awaited<ReturnType<typeof boot>>) => p.byId("tl").children;
const quietRows = (p: Awaited<ReturnType<typeof boot>>) => rail(p).filter((n) => n.has("quiet"));
const stepRows = (p: Awaited<ReturnType<typeof boot>>) => rail(p).filter((n) => n.has("row") && !n.has("quiet")).map((n) => n.attrs["data-key"]);
const SHOW = { "cocheck.showQuiet": "on" };

describe("the rail hides the commands that changed nothing by default", () => {
  it("off by default: no quiet row is drawn and the rail takes no room for one; on, the rows are back", async () => {
    const off = await boot({ stops: stops() }), on = await boot({ stops: stops(), ls: SHOW });
    assert.equal(quietRows(off).length, 0, "no quiet row by default");
    assert.equal(off.everyNode().filter((n) => n.has("qtick") || n.has("qline")).length, 0, "and no lane tick");
    assert.ok(quietRows(on).length >= 1, "the setting restores today's rows");
    assert.ok(on.everyNode().some((n) => n.has("qtick")), "with their ticks");
    const h = (p: typeof off) => parseFloat(String(p.byId("tl").style.height));
    assert.equal(h(on) - h(off), 22, "a quiet row is 22px: off, the rail is that much shorter");
  });
  it("every real step keeps its row and its place in the keyboard order, either way", async () => {
    const off = await boot({ stops: stops() }), on = await boot({ stops: stops(), ls: SHOW });
    assert.deepEqual(stepRows(off), stepRows(on), "the same step rows");
    assert.equal(stepRows(off).length, 3, "all three steps are drawn");
    const heads = async (p: typeof off) => { const out = [p.byId("h1").textContent]; for (let k = 0; k < 2; k++) { await p.key("ArrowRight"); out.push(p.byId("h1").textContent); } return out; };
    assert.deepEqual(await heads(off), await heads(on), "the keys walk the same steps");
    assert.equal(off.byId("pbpos").textContent, on.byId("pbpos").textContent, "the position counts the same steps");
  });
  it("a row that changed a file is never a quiet row: the file step stays when the setting is off", async () => {
    const p = await boot({ stops: stops() });
    assert.ok(stepRows(p).includes("s0") && stepRows(p).includes("s2"), "both file steps are on the rail");
    assert.equal(p.everyNode().filter((n) => n.has("hdr") || n.has("row")).filter((n) => /\(k[ab]\)|d\.docx/.test(n.textContent)).length > 0, true);
  });
  it("the settings menu button turns the rows on and off without a reload, and the choice is remembered", async () => {
    const p = await boot({ stops: stops() });
    const b = p.byId("quietbtn");
    assert.equal(b.attrs["aria-pressed"], "true");
    b.click(); await p.settle();
    assert.equal(p.store["cocheck.showQuiet"], "on");
    assert.equal(b.attrs["aria-pressed"], "false");
    assert.ok(quietRows(p).length >= 1, "rows drawn at once");
    assert.equal(stepRows(p).length, 3);
    b.click(); await p.settle();
    assert.equal(p.store["cocheck.showQuiet"], "off");
    assert.equal(quietRows(p).length, 0, "and gone again");
    assert.equal(stepRows(p).length, 3);
  });
  it("storage that refuses is survived: the default holds and the toggle still works for this page", async () => {
    const p = await boot({ stops: stops(), ls: "throws" });
    assert.equal(quietRows(p).length, 0);
    p.byId("quietbtn").click(); await p.settle();
    assert.ok(quietRows(p).length >= 1);
  });
  it("the shell carries the control and the theme choice in the settings menu", () => {
    const html = renderReviewShell(7);
    assert.match(html, /id="quietbtn"[^>]*aria-pressed="true"[^>]*>Hide Background Commands</);
    for (const [id, label] of [["themelight", "Light"], ["themedark", "Dark"], ["themeauto", "Match System"]]) assert.match(html, new RegExp(`id="${id}"[^>]*>${label}<`));
    assert.match(html, /id="themeauto" aria-pressed="true"/, "Match system is the default");
  });
});

describe("Light / Dark / Match system", () => {
  it("defaults to Match system and applies the choice at once through data-theme, remembered per viewer", async () => {
    const p = await boot({ stops: stops() });
    assert.equal(p.root.attrs["data-theme"], "auto");
    assert.equal(p.byId("themeauto").attrs["aria-pressed"], "true");
    p.byId("themedark").click();
    assert.equal(p.root.attrs["data-theme"], "dark");
    assert.equal(p.store["cocheck.theme"], "dark");
    assert.equal(p.byId("themedark").attrs["aria-pressed"], "true");
    assert.equal(p.byId("themeauto").attrs["aria-pressed"], "false");
    p.byId("themelight").click();
    assert.equal(p.root.attrs["data-theme"], "light");
    p.byId("themeauto").click();
    assert.equal(p.root.attrs["data-theme"], "auto");
    assert.equal(p.store["cocheck.theme"], "auto");
  });
  it("a remembered choice is applied when the page opens; a junk value is Match system", async () => {
    assert.equal((await boot({ stops: stops(), ls: { "cocheck.theme": "dark" } })).root.attrs["data-theme"], "dark");
    assert.equal((await boot({ stops: stops(), ls: { "cocheck.theme": "light" } })).root.attrs["data-theme"], "light");
    assert.equal((await boot({ stops: stops(), ls: { "cocheck.theme": "purple" } })).root.attrs["data-theme"], "auto");
  });
  it("storage that refuses does not break the page: Match system, and a click still themes this page", async () => {
    const p = await boot({ stops: stops(), ls: "throws" });
    assert.equal(p.root.attrs["data-theme"], "auto");
    p.byId("themedark").click();
    assert.equal(p.root.attrs["data-theme"], "dark");
  });
  it("the dark tokens are the same list under the system setting (unless Light is chosen) and under data-theme=dark", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    const media = /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{([^}]*)\}\}/.exec(css);
    const forced = /:root\[data-theme=dark\]\{([^}]*)\}/.exec(css);
    assert.ok(media && forced, "both blocks exist");
    assert.equal(media![1], forced![1]);
    assert.match(css, /--canvas:#1c1d20/);
    assert.match(css, /:root\[data-theme=light\]\{color-scheme:light\}/);
    assert.match(css, /:root\[data-theme=dark\]\{color-scheme:dark\}/);
  });
});
