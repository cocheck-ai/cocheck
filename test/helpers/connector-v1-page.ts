// Drives the REAL review.js (with view-table.js and files-view.js) in a vm over a DOM stand-in for one Office before/after pair and
// captures what the page draws: the card (comment) of every change, the notes column, and every box (pane and position).
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { readFix, railOf, sha256, type LedgerSnapshot, type Pair } from "./connector-migration.ts";

const xlsxPair = (name: string, before: string, after: string): Pair => ({ name: `xlsx-${name}`, format: "xlsx", before, after });

/** Office before/after pairs in test/fixtures; `modelOf` replays one through the real ingestion path into the rail model. */
export const ALL_PAIRS: Pair[] = [
  xlsxPair("formula-edit", "formula-edit-before.xlsx", "formula-edit-after.xlsx"),
  xlsxPair("inserted-row", "inserted-row-before.xlsx", "inserted-row-after.xlsx"),
  xlsxPair("value-edit", "value-edit-before.xlsx", "value-edit-after.xlsx"),
  xlsxPair("column-insert", "column-insert-before.xlsx", "column-insert-after.xlsx"),
  xlsxPair("column-insert-crosssheet", "column-insert-crosssheet-before.xlsx", "column-insert-crosssheet-after.xlsx"),
  xlsxPair("shifted-crosssheet", "shifted-crosssheet-before.xlsx", "shifted-crosssheet-after.xlsx"),
  xlsxPair("insert-then-retarget", "cocheck-insert-then-retarget-before.xlsx", "cocheck-insert-then-retarget-after.xlsx"),
  xlsxPair("lbo-live-081", "lbo-model-before.xlsx", "lbo-model-after.xlsx"),
  xlsxPair("X", "X-before.xlsx", "X-after.xlsx"),
  xlsxPair("chart-three", "chart-three-before.xlsx", "chart-three-after.xlsx"),
  ...["axis", "removed", "renumbered", "roundtrip", "series-added", "series-removed", "title", "type"].map((k) => xlsxPair(`chart-edit-${k}`, "chart-edit-a.xlsx", `chart-edit-${k}.xlsx`)),
];

/** A ledger snapshot built from a pair (first state, then the edit), replayed by the real ingestion path into the rail model. */
export function snapshotOf(p: Pair): LedgerSnapshot {
  const b = readFix(p.before), a = readFix(p.after), ext = path.extname(p.before);
  const file = `book${ext}`;
  return {
    snapshot: p.name, client: "claude:/work", folder: "/work", blobs: { [sha256(b)]: p.before, [sha256(a)]: p.after },
    steps: [
      { seq: 1, phase: "Post", file, sha256: sha256(b), prevSha256: null, size: b.length, kept: "whole" },
      { seq: 2, phase: "Post", file, sha256: sha256(a), prevSha256: sha256(b), size: a.length, kept: "whole" },
    ],
    pane: p.name,
  };
}

export interface ModelChange { key: string; file: string; kind: string; note: string; rowNotes: Array<{ location: string; text: string }>; cards?: unknown[]; extraCards?: unknown[]; moreCards?: number; rewrite?: boolean }
export interface PairModel { model: { stops: Array<{ id: string; change?: ModelChange }>; [k: string]: unknown }; change: ModelChange }

export async function modelOf(p: Pair): Promise<PairModel> {
  const model = (await railOf(snapshotOf(p))) as unknown as PairModel["model"];
  const change = model.stops.map((s) => s.change).filter((c): c is ModelChange => c !== undefined && c.kind === "modified")[0]!;
  return { model, change };
}

// ---- the DOM stand-in ---------------------------------------------------------------------------------------------------------------------

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; value = ""; nodeType = 1; rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
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
  focus() {}
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
  querySelector(sel: string): N | null {
    const m = /^button(?:\[data-side="(\w+)"\])?$/.exec(sel);
    return m ? this.descendants().find((n) => n.tag === "button" && (m[1] === undefined || n.attrs["data-side"] === m[1])) ?? null : null;
  }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

// ---- the capture --------------------------------------------------------------------------------------------------------------------------

export interface PageCapture {
  heading: string;
  panes: { before: number; after: number };
  /** The notes column cards (the notes path), in order. */
  notes: string[];
  /** The comment of every change that has a box, by change id (what hovering or focusing it shows). */
  cards: Array<{ id: string; comment: string }>;
  /** Every change that shows on no side of a picture, as its note in the Details panel (fix/notes-panel; was the words list under the panes). */
  wordsList: string[];
  /** The change id of each of those notes, in the same order. */
  wordsIds: string[];
  /** Every change box: the change, its side, the pane it sits in and its place (percent of the picture, or px on a live grid). */
  boxes: Array<{ change: string; side: string; pane: string | null; at: string }>;
  /** The changed words highlighted inside a box. */
  highlights: Array<{ change: string; pane: string | null; at: string }>;
  /** Cells outlined in a static grid. */
  hits: Array<{ pane: string | null; cell: string }>;
  /** The view's caveats, as Details notes joined by a space (fix/notes-panel; was the caveats line). */
  caveats: string;
  /** Every drawn grid element on the page: a sheet table (table.grid that is not a text pane), a live grid's scroll box or table, a cell (data-cell), a formula cell or popover. */
  gridNodes: number;
  /** The text the two pane areas show. */
  paneText: { before: string; after: string };
  /** Any page element by id, as drawn: its text, whether it is hidden, and the tags under it (so drawn-as-text can be checked). */
  node: (id: string) => { text: string; hidden: boolean; tags: string[] };
}

const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** Boots the page on the pair's one modified change and returns what it drew. `serve` answers the view request with the raw View (old page) or the v1 document (new page). */
export async function drivePage(pm: PairModel, serve: (key: string, file: string) => Promise<unknown>, assetsDir?: string, opts: { noPanes?: boolean } = {}): Promise<PageCapture> {
  const m = JSON.parse(JSON.stringify(pm.model)) as PairModel["model"] & { excel?: boolean };
  m.excel = true;
  const idx = m.stops.findIndex((s) => s.change?.key === pm.change.key);
  const src = await Promise.all(["view-table.js", "files-view.js", "review.js"].map((f) => readFile(assetsDir !== undefined ? path.join(assetsDir, f) : new URL(`../../src/timeline/rail/assets/${f}`, import.meta.url), "utf8")));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  for (const id of ["ncomp", "pcomp", "sbout", "toast"]) byId(id).hidden = true;
  const holder = mkNode(); holder.append(byId("stage"));
  byId("pb").className = "pane before"; byId("pa").className = "pane after";
  byId("stage").append(byId("pb"), byId("pa")); byId("pb").append(byId("tb"), byId("trb"), byId("vb")); byId("pa").append(byId("ta"), byId("tra"), byId("va"));
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const roots = (): N[] => [...nodes.values(), body, holder];
  const everyNode = (): N[] => roots().flatMap((n) => [n, ...n.descendants()]).filter((n, i, a) => a.indexOf(n) === i);
  const bxCf = (): N[] => everyNode().filter((n) => n.has("bx") && n.has("cf"));
  let uid = 0;
  const mk = (t: string): N => { const n = mkNode(t); n.attrs["data-uid"] = String(++uid); return n; };
  const document = { body, activeElement: null, getElementById: byId, createElement: mk, createElementNS: (_: string, t: string) => mk(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, addEventListener() {},
    querySelectorAll: (sel: string) => { const mm = /^\.bx\.cf\[data-change="([^"]+)"\]$/.exec(sel); return mm ? bxCf().filter((n) => n.attrs["data-change"] === mm[1]) : []; } };
  const json = (v: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(v)) });
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: `#${idx}` }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, setTimeout, clearTimeout, navigator: {},
    addEventListener() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (u: string) => {
      if (u.includes("/review/status")) return json({ stops: {}, passes: { markers: [], tags: {} } });
      if (u.includes("/review/model")) return json(m);
      const key = /\/view\/([^/?]+)/.exec(u)?.[1];
      if (key === undefined) return json({});
      return json(await serve(decodeURIComponent(key), pm.change.file));
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  ["view-table.js", "files-view.js", "review.js"].forEach((f, k) => vm.runInContext(src[k]!, ctx, { filename: f }));
  // the view answers asynchronously: wait until the panes are drawn (or the view is plainly empty), then let the page settle
  const waiting = (): boolean => (byId("vb").children.length === 0 && byId("va").children.length === 0) || [...byId("vb").descendants(), ...byId("va").descendants()].some((n) => n.has("iload") || n.has("loadpane"));
  for (let k = 0; k < 400 && !opts.noPanes && waiting(); k++) await new Promise((r) => setTimeout(r, 30));
  for (let k = 0; k < 6; k++) await new Promise((r) => setTimeout(r, 40));
  const paneOfNode = (n: N): string | null => { for (let p: N | null = n.parentNode; p; p = p.parentNode) if (p.attrs["data-pane"] !== undefined) return p.attrs["data-pane"]!; return null; };
  const at = (n: N): string => ["left", "top", "width", "height"].map((k) => String(n.style[k] ?? "")).join("|");
  const bx = bxCf();
  const ids = [...new Set(bx.map((n) => n.attrs["data-change"]!))].sort(natural);
  // the comment of each boxed change: focus it exactly as hovering does, read the comment nodes the page drew, put it away
  const focus = (g.CoCheckFocus ?? (g.window as Record<string, unknown>).CoCheckFocus) as { focusChange(id: string): void; clearFocus(): void } | undefined;
  const cards: PageCapture["cards"] = [];
  for (const id of ids) {
    focus?.focusChange(id);
    const cms = everyNode().filter((n) => n.has("cm") && n.attrs["data-change"] === id);
    cards.push({ id, comment: cms.length ? cms[0]!.textContent : "" });
    focus?.clearFocus();
  }
  const all = (n: N): N[] => [n, ...n.descendants()];
  const details = [...((g.CoCheckDetails as { entries(): Array<{ kind: string; text: string; change: string | null }> } | undefined)?.entries() ?? [])];
  const words = details.filter((e) => e.kind === "unplaced");
  const capture = {
    heading: byId("h1").textContent,
    panes: { before: all(byId("tb")).filter((n) => n.tag === "button").length, after: all(byId("ta")).filter((n) => n.tag === "button").length },
    notes: all(byId("notes")).filter((n) => n.has("note")).map((n) => n.textContent),
    cards,
    wordsIds: words.map((e) => e.change ?? ""),
    wordsList: words.map((e) => e.text),
    boxes: bx.map((n) => ({ change: n.attrs["data-change"]!, side: n.attrs["data-side"] ?? "", pane: paneOfNode(n), at: at(n) })).sort((a, b) => natural(a.change, b.change) || a.side.localeCompare(b.side) || a.at.localeCompare(b.at)),
    highlights: everyNode().filter((n) => n.has("cf-hl")).map((n) => ({ change: n.attrs["data-change"]!, pane: paneOfNode(n), at: at(n) })).sort((a, b) => natural(a.change, b.change) || a.at.localeCompare(b.at)),
    hits: everyNode().filter((n) => n.tag === "td" && n.has("hit")).map((n) => ({ pane: paneOfNode(n), cell: n.attrs["data-cell"] ?? "" })),
    caveats: details.filter((e) => e.kind === "caveat").map((e) => e.text).join(" "),
    gridNodes: everyNode().filter((n) => (n.tag === "table" && n.has("grid") && !n.has("textpane")) || n.has("gscroll") || n.has("ggrid") || n.has("fpop") || n.attrs["data-cell"] !== undefined || n.attrs["data-formula"] !== undefined).length,
    paneText: { before: byId("vb").textContent, after: byId("va").textContent },
  } as Omit<PageCapture, "node">;
  // not enumerable, so captures still compare with deepEqual
  return Object.defineProperty(capture, "node", { enumerable: false, value: (id: string) => ({ text: byId(id).textContent, hidden: byId(id).hidden, tags: byId(id).descendants().map((n) => n.tag) }) }) as PageCapture;
}

