// The Excel connector's change list and print plan for one before/after pair of workbooks. Pure: bytes in, changes and areas out.
//
// The XML alone decides what changed and where (no pixel comparison). Steps:
//   sheets matched by name, then by content (a rename); package parts (charts, images, comments, names, macros) diffed as changes;
//   per matched worksheet: columns aligned by content, rows aligned on the cells' constants (anchors on unique rows, LCS in gaps, a
//   similarity pass, reorder detection); cells compared under the maps (a formula is remapped through the maps before comparing, so an
//   insert never reads as a formula edit); each difference classed input, derived (formula unchanged, value recalculated), or format;
//   runs of the same change down a column collapse to one change with its exceptions as child changes; single edits of the same kind in
//   one column are grouped; derived cells hang under one summary per cause; changes in hidden rows, columns or sheets get a reason and no
//   area; the rest cluster into blocks (gap 4 rows, 2 columns; at most 60 x 15), ranked by stakes and capped (6 per sheet, 24 per file),
//   everything past the cap listed with the reason. Each pictured block becomes print areas on both sides: the block with 3 rows and 1
//   column of context (at least 10 x 5), tall uniform stretches folded to a top and a bottom piece, wide blocks folded to a left and a right
//   piece, before and after windows images of each other under the row map.
import { extractFormulaRefs, numToCol, remapFormulaRefs, toRelativeSignature } from "../xlsx/formula.ts";
import { xlsxChartDetail } from "../shared/package-media.ts";
import { align, type Alignment } from "./align.ts";
import { introducedErrors, type ErrorIssue, type ErrorSheet } from "./errors.ts";
import { heightPt, readWorkbook, type Cell, type Drawing, type Rect, type Sheet, type Value, type Workbook } from "./workbook.ts";

export interface XChange {
  id: string;
  mark: "added" | "removed" | "changed" | "moved" | "described";
  label: string;
  before?: string;
  after?: string;
  text?: string;
  lines?: string[];
  parent?: string;
  causedBy?: string;
  kind: string;
  private?: Record<string, unknown>;
}

export interface PrintArea {
  /** Pair group id (shared by the before and after pieces of one change area). */
  group: string;
  /** Piece order inside the group (fold pieces: top 0, bottom 1, ...). */
  order: number;
  /** The rectangle on this side, in this side's own rows and columns (1-based). */
  rect: Rect;
  /** The pictured changes on this area, each with its cells on this side (screen route: mapped to pixels). Empty on the print route. */
  boxes: PlanBox[];
}

/** One change's cells on one side: the side's own rows and columns (1-based). `drawing` is workbook.ts Drawing.objectName (the name Excel gives the chart object) when the change is an embedded chart (cells = its anchor range). */
export interface PlanBox { change: string; cells: Rect; drawing?: string; offset?: { x: number; y: number } }

/** The sheet behind a SheetPrint (for sizes), kept out of the plan's data so the plan's output is unchanged. */
const sheetOfPrint = new WeakMap<SheetPrint, Sheet>();
export const sheetOf = (sp: SheetPrint): Sheet | undefined => sheetOfPrint.get(sp);

export interface SheetPrint {
  /** The sheet's name on this side. */
  name: string;
  kind: "worksheet" | "chartsheet";
  /** Worksheet areas, in print order (one page each). Empty for a chart sheet (printed whole, fit to one page). */
  areas: PrintArea[];
  /** Print zoom (10-400) shared with the other side's copy of this sheet. */
  zoom: number;
  landscape: boolean;
  /** For a chart sheet: its one picture's group and order. */
  group?: string;
}

export interface GroupInfo {
  id: string;
  /** Rank, highest first. */
  score: number;
  /** Words for a side that has no picture in this group ("did not exist"). */
  placeholder?: { before?: string; after?: string };
  /** The change ids this group pictures. */
  changes: string[];
}

export interface ExcelPlan {
  changes: XChange[];
  caveats: string[];
  before: SheetPrint[];
  after: SheetPrint[];
  groups: GroupInfo[];
  /** Migration X2: error values and broken references the change introduced, one per after cell (spec v1.2 `issues`, `where` = the cell). */
  issues: ErrorIssue[];
}

export const LIMITS = { gapRows: 4, gapCols: 2, maxBlockRows: 60, maxBlockCols: 15, ctxRows: 3, ctxCols: 1, minRows: 10, minCols: 5, maxAreaRows: 40, foldKeep: 8, foldMin: 20, perSheet: 6, perFile: 24, maxPieces: 6, listChildren: 200, minZoom: 40 };

// ---------------------------------------------------------------- words

const quoteSheet = (n: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && !/^[A-Z]{1,3}\d+$/i.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
export const addr = (r: number, c: number): string => `${numToCol(c)}${r}`;
export const rangeText = (x: Rect): string => (x.r1 === x.r2 && x.c1 === x.c2 ? addr(x.r1, x.c1) : `${addr(x.r1, x.c1)}:${addr(x.r2, x.c2)}`);
const at = (sheet: string, x: Rect): string => `${quoteSheet(sheet)}!${rangeText(x)}`;
const n = (x: number): string => x.toLocaleString("en-US");
const rowsText = (a: number, b: number): string => (a === b ? `row ${n(a)}` : `rows ${n(a)}-${n(b)}`);

function valueWords(v: Value): string {
  if (v === null) return "empty";
  if (typeof v === "object") return v.error;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
function cellWords(c: Cell | undefined): string | undefined {
  if (c === undefined || (c.f === null && c.v === null)) return undefined;
  return c.f !== null ? `=${c.f}` : valueWords(c.v);
}
const valEq = (a: Value, b: Value): boolean => {
  if (a === null || b === null) return a === b;
  if (typeof a === "object" || typeof b === "object") return typeof a === "object" && typeof b === "object" && a.error === b.error;
  return a === b;
};
const isErr = (v: Value): boolean => v !== null && typeof v === "object";
const VOLATILE = /\b(RAND|RANDBETWEEN|RANDARRAY|NOW|TODAY|OFFSET|INDIRECT)\s*\(/i;

// ---------------------------------------------------------------- sheet matching

interface Pair { a?: Sheet; b?: Sheet; renamed?: boolean }

function cellSig(s: Sheet): Set<string> {
  const out = new Set<string>();
  for (const [r, row] of s.rows) for (const [c, cell] of row) { out.add(`${r},${c}=${cell.f !== null ? "=" + cell.f : valueWords(cell.v)}`); if (out.size > 20000) return out; }
  return out;
}
function jaccard(x: Set<string>, y: Set<string>): number {
  if (x.size === 0 && y.size === 0) return 1;
  let i = 0; for (const k of x) if (y.has(k)) i++;
  return i / (x.size + y.size - i);
}

function matchSheets(A: Workbook, B: Workbook): Pair[] {
  const pairs: Pair[] = [];
  const bByName = new Map(B.sheets.map((s) => [s.name, s] as const));
  const usedB = new Set<Sheet>();
  const leftA: Sheet[] = [];
  for (const a of A.sheets) { const b = bByName.get(a.name); if (b && b.kind === a.kind) { pairs.push({ a, b }); usedB.add(b); } else leftA.push(a); }
  const leftB = B.sheets.filter((s) => !usedB.has(s));
  // renames: content similarity at least 0.6, same kind (formulas pointing at the renamed sheet change their text, so compare loosely)
  for (const a of leftA) {
    let best: Sheet | undefined, bv = 0.6;
    const sa = cellSig(a);
    for (const b of leftB) if (!usedB.has(b) && b.kind === a.kind) { const v = a.kind === "chartsheet" ? (a.drawings[0]?.sha === b.drawings[0]?.sha ? 1 : 0) : jaccard(sa, cellSig(b)); if (v >= bv) { bv = v; best = b; } }
    if (best) { pairs.push({ a, b: best, renamed: true }); usedB.add(best); } else pairs.push({ a });
  }
  for (const b of leftB) if (!usedB.has(b)) pairs.push({ b });
  // keep the after order, then removed sheets
  const pos = (p: Pair): number => (p.b ? B.sheets.indexOf(p.b) : 1000 + A.sheets.indexOf(p.a!));
  return pairs.sort((x, y) => pos(x) - pos(y));
}

// ---------------------------------------------------------------- per-sheet alignment

interface Aligned {
  rows: Alignment;
  cols: Alignment;
  /** merged row index k -> before row / after row (1-based) or null */
  kA: (number | null)[];
  kB: (number | null)[];
  mA: (number | null)[];
  mB: (number | null)[];
  /** before row -> k, after row -> k (1-based rows) */
  aRowK: Map<number, number>;
  bRowK: Map<number, number>;
  aColM: Map<number, number>;
  bColM: Map<number, number>;
}

/** Sheet qualifiers in a formula rewritten to the pair's token, so a formula pointing at a renamed sheet reads the same on both sides. */
export function canonNames(f: string, map: Map<string, string> | undefined): string {
  if (!map) return f;
  let out = f;
  for (const [nm, tok] of map) {
    const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_.'])(?:'${esc.replace(/'/g, "''")}'|${esc})!`, "g"), `${tok}!`);
  }
  return out;
}

function r1c1(sheet: Sheet, r: number, c: number, cell: Cell, cache: Map<string, string>, names?: Map<string, string>): string {
  if (cell.f === null) return "";
  const key = `${r},${c}`;
  let s = cache.get(key);
  if (s === undefined) {
    try { s = canonNames(toRelativeSignature(cell.f, addr(r, c), sheet.name), names).replace(/\bR(\d+)/g, "R#"); } catch { s = cell.f; }
    cache.set(key, s);
  }
  return s;
}
const constKey = (c: Cell | undefined): string => (c === undefined ? "" : c.f !== null ? "ƒ" : c.v === null ? "" : typeof c.v === "object" ? `#${c.v.error}` : `${typeof c.v === "number" ? "n" : typeof c.v === "boolean" ? "b" : "s"}${String(c.v)}`);

function alignSheet(a: Sheet, b: Sheet, namesA?: Map<string, string>, namesB?: Map<string, string>): Aligned {
  const ra = new Map<string, string>(), rb = new Map<string, string>();
  const full = (s: Sheet, cache: Map<string, string>, r: number, c: number): string => {
    const cell = s.rows.get(r)?.get(c);
    if (cell === undefined) return "";
    return cell.f !== null ? `=${r1c1(s, r, c, cell, cache, s === a ? namesA : namesB)}` : constKey(cell);
  };
  // both sides span the same extent, including what drawings cover, so a chart beside the data has columns and rows to sit in
  const ext = (s: Sheet): { r: number; c: number } => s.drawings.reduce((m, d) => (d.anchor ? { r: Math.max(m.r, d.anchor.r2), c: Math.max(m.c, d.anchor.c2) } : m), { r: 0, c: 0 });
  const ea = ext(a), eb = ext(b);
  // columns: both sides to the same count (a column filled where the other side has none pairs with it); rows: only up to what drawings cover
  const maxC = Math.max(a.maxCol, b.maxCol, ea.c, eb.c);
  const extR = Math.max(ea.r, eb.r), rowsA = Math.max(a.maxRow, extR), rowsB = Math.max(b.maxRow, extR);
  // columns: by the multiset of what they hold
  const colBag = (s: Sheet, cache: Map<string, string>): Map<string, number>[] => {
    const bags: Map<string, number>[] = [];
    for (let c = 1; c <= maxC; c++) bags.push(new Map());
    for (const [r, row] of s.rows) for (const [c] of row) { const k = full(s, cache, r, c); if (k === "") continue; const m = bags[c - 1]!; m.set(k, (m.get(k) ?? 0) + 1); }
    return bags;
  };
  const ba = colBag(a, ra), bb = colBag(b, rb);
  const bagKey = (m: Map<string, number>): string => [...m].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([k, v]) => `${k}*${v}`).join("\u0001");
  const bagSim = (x: Map<string, number>, y: Map<string, number>): number => {
    let inter = 0, tx = 0, ty = 0;
    for (const v of x.values()) tx += v;
    for (const v of y.values()) ty += v;
    if (tx === 0 && ty === 0) return 1;
    for (const [k, v] of x) inter += Math.min(v, y.get(k) ?? 0);
    return inter / (tx + ty - inter);
  };
  const cols0 = align(ba.map(bagKey), bb.map(bagKey), (i, j) => bagSim(ba[i]!, bb[j]!));
  // a column filled where the other side's same column is empty and unmatched is new cells, not an inserted column
  for (let i = 0; i < maxC; i++) {
    if (cols0.aToB[i] === null && cols0.bToA[i] === null && (ba[i]!.size === 0 || bb[i]!.size === 0)) {
      const before = cols0.aToB.slice(0, i).filter((x) => x !== null), last = before.length ? Math.max(...(before as number[])) : -1;
      const nextA = cols0.aToB.slice(i + 1).find((x) => x !== null);
      if (last < i && (nextA === undefined || nextA! > i)) { cols0.aToB[i] = i; cols0.bToA[i] = i; }
    }
  }
  const cols: Alignment = cols0.reordered ? cols0 : { ...cols0, ops: opsFrom(cols0.aToB, cols0.bToA) };
  const colPairs: [number, number][] = [];
  cols.aToB.forEach((j, i) => { if (j !== null) colPairs.push([i + 1, j + 1]); });
  // rows: keyed by constants over the matched columns (formulas count as present, not by text: a formula edit is a modification)
  const rowKey = (s: Sheet, r: number, side: 0 | 1): string => {
    const row = s.rows.get(r);
    if (!row) return "";
    let k = "";
    for (const p of colPairs) k += constKey(row.get(p[side])) + "\u0001";
    return k;
  };
  const ka: string[] = [], kb: string[] = [];
  for (let r = 1; r <= rowsA; r++) ka.push(rowKey(a, r, 0));
  for (let r = 1; r <= rowsB; r++) kb.push(rowKey(b, r, 1));
  const sim = (i: number, j: number): number => {
    let same = 0, any = 0;
    for (const [ca, cb] of colPairs) {
      const x = full(a, ra, i + 1, ca), y = full(b, rb, j + 1, cb);
      if (x === "" && y === "") continue;
      any++;
      if (x === y) same++;
    }
    return any === 0 ? 1 : same / any;
  };
  const rows = align(ka, kb, sim);
  const out: Aligned = { rows, cols, kA: [], kB: [], mA: [], mB: [], aRowK: new Map(), bRowK: new Map(), aColM: new Map(), bColM: new Map() };
  rows.ops.forEach((o, k) => { out.kA.push(o.a === null ? null : o.a + 1); out.kB.push(o.b === null ? null : o.b + 1); if (o.a !== null) out.aRowK.set(o.a + 1, k); if (o.b !== null) out.bRowK.set(o.b + 1, k); });
  cols.ops.forEach((o, m) => { out.mA.push(o.a === null ? null : o.a + 1); out.mB.push(o.b === null ? null : o.b + 1); if (o.a !== null) out.aColM.set(o.a + 1, m); if (o.b !== null) out.bColM.set(o.b + 1, m); });
  return out;
}

/** One sheet that exists on one side only: rows and columns map to themselves. */
/** How far a sheet reaches: its cells, and the drawings anchored to them (a sheet that holds only charts has no cells and still has something to show). */
const reach = (s: Sheet): { r: number; c: number } => s.drawings.reduce((m, d) => (d.anchor ? { r: Math.max(m.r, d.anchor.r2), c: Math.max(m.c, d.anchor.c2) } : m), { r: s.maxRow, c: s.maxCol });

function oneSided(s: Sheet, side: "a" | "b"): Aligned {
  const ext = reach(s);
  const ops = Array.from({ length: ext.r }, (_, i) => (side === "a" ? { a: i, b: null } : { a: null, b: i }));
  const cops = Array.from({ length: ext.c }, (_, i) => (side === "a" ? { a: i, b: null } : { a: null, b: i }));
  const mk = (o: typeof ops): Alignment => ({ aToB: [], bToA: [], ops: o, reordered: false, moved: 0 });
  const out: Aligned = { rows: mk(ops), cols: mk(cops), kA: [], kB: [], mA: [], mB: [], aRowK: new Map(), bRowK: new Map(), aColM: new Map(), bColM: new Map() };
  ops.forEach((o, k) => { out.kA.push(o.a === null ? null : o.a + 1); out.kB.push(o.b === null ? null : o.b + 1); if (o.a !== null) out.aRowK.set(o.a + 1, k); if (o.b !== null) out.bRowK.set(o.b + 1, k); });
  cops.forEach((o, m) => { out.mA.push(o.a === null ? null : o.a + 1); out.mB.push(o.b === null ? null : o.b + 1); if (o.a !== null) out.aColM.set(o.a + 1, m); if (o.b !== null) out.bColM.set(o.b + 1, m); });
  return out;
}

function opsFrom(aToB: (number | null)[], bToA: (number | null)[]): { a: number | null; b: number | null }[] {
  const ops: { a: number | null; b: number | null }[] = [];
  let i = 0, j = 0;
  while (i < aToB.length || j < bToA.length) {
    if (i < aToB.length && aToB[i] === null) { ops.push({ a: i++, b: null }); continue; }
    if (j < bToA.length && bToA[j] === null) { ops.push({ a: null, b: j++ }); continue; }
    if (i < aToB.length && j < bToA.length) { ops.push({ a: i++, b: j++ }); continue; }
    if (i < aToB.length) ops.push({ a: i++, b: null }); else ops.push({ a: null, b: j++ });
  }
  return ops;
}

// ---------------------------------------------------------------- items (what a block is made of)

interface Item {
  change: XChange;
  /** merged-space rectangle */
  k0: number; k1: number; m0: number; m1: number;
  score: number;
  /** A uniform stretch (insert run, delete run, filled pattern): its middle may fold. */
  uniform: boolean;
  /** rows (merged) that must stay visible inside a uniform item: its exceptions */
  keep?: number[];
}

interface Sides { before?: Rect; after?: Rect }
interface Ctx {
  changes: XChange[];
  caveats: string[];
  next: number;
  /** cells of the exceptions to a pattern, per side (an exception is a change but not a block item) */
  exceptions: Map<string, Sides>;
  /** the drawings behind a chart change, per side */
  charts: Map<string, { before?: Drawing; after?: Drawing }>;
}
/** The sides a change exists on, from its mark: added after only, removed before only, anything else both. */
const sidesOfMark = (mark: XChange["mark"]): { before: boolean; after: boolean } => ({ before: mark !== "added", after: mark !== "removed" });
const newId = (ctx: Ctx): string => `c${++ctx.next}`;
function push(ctx: Ctx, ch: Omit<XChange, "id">): XChange {
  const full = { id: newId(ctx), ...ch } as XChange;
  ctx.changes.push(full);
  return full;
}
function unplace(ch: XChange, why: string, side: "before" | "after" | "both" = "after"): void {
  const un = (ch.private?.unplaced as Record<string, string> | undefined) ?? {};
  if (side === "both" || side === "before") un.before = why;
  if (side === "both" || side === "after") un.after = why;
  ch.private = { ...(ch.private ?? {}), unplaced: un };
  const line = `Not in the pictures: ${why}.`;
  ch.lines = [...(ch.lines ?? []).filter((l) => l !== line), line];
}

// ---------------------------------------------------------------- the sheet diff

interface CellDiff { k: number; m: number; ra: number | null; rb: number | null; ca: number | null; cb: number | null; a?: Cell; b?: Cell; kind: "input" | "derived" | "format"; sig: string }

interface SheetResult { items: Item[]; pair: Pair; al: Aligned }

const sheetLabel = (p: Pair): string => quoteSheet(p.b?.name ?? p.a!.name);

function diffSheet(ctx: Ctx, p: Pair, nameMapA: Map<string, string>, nameMapB: Map<string, string>, mapsBySheetA: Map<string, Aligned>): SheetResult {
  const a = p.a!, b = p.b!;
  const al = mapsBySheetA.get(a.name)!;
  const items: Item[] = [];
  const sname = b.name;
  const hiddenWhy = (r: number | null, c: number | null, s: Sheet): string | undefined => {
    if (s.state !== "visible") return `on the ${s.state === "veryHidden" ? "very hidden" : "hidden"} sheet ${s.name}`;
    if (r !== null && s.hiddenRows.has(r)) return `in hidden row ${n(r)}`;
    if (c !== null && s.hiddenCols.has(c)) return `in hidden column ${numToCol(c)}`;
    if (r !== null && s.autoFilter && r > s.autoFilter.r1 && r <= s.autoFilter.r2 && s.hiddenRows.has(r)) return `in row ${n(r)}, filtered out`;
    return undefined;
  };
  // a sheet whose cells were all removed: one change, its old top pictured, the after side says it is empty
  if (b.rows.size === 0 && a.rows.size > 0) {
    const ch = push(ctx, { mark: "removed", label: `Sheet ${sheetLabel(p)}`, text: `Sheet ${sname} is now empty: its ${n(a.maxRow)} rows by ${n(a.maxCol)} columns were cleared`, kind: "sheet-emptied", private: { sheet: sname } });
    if (a.state !== "visible") unplace(ch, hiddenWhy(null, null, a)!, "before");
    else items.push({ change: ch, k0: 0, k1: Math.min(al.kA.length, 30) - 1, m0: 0, m1: Math.min(al.mA.length, 12) - 1, score: 100, uniform: false, ...{ emptied: true } } as Item);
    return { items, pair: p, al };
  }
  // reorder
  if (al.rows.reordered) {
    const ch = push(ctx, { mark: "moved", label: `${sheetLabel(p)} rows`, text: `${n(al.rows.moved)} rows reordered (sorted); their values did not change except where listed`, kind: "reorder" });
    unplace(ch, "a reorder moves rows; the pictures show the changed cells", "both");
  }
  // structural runs: rows
  const runs = (ops: { a: number | null; b: number | null }[], side: "a" | "b"): [number, number][] => {
    const out: [number, number][] = [];
    let s = -1;
    for (let k = 0; k <= ops.length; k++) {
      const hit = k < ops.length && (side === "a" ? ops[k]!.b === null && ops[k]!.a !== null : ops[k]!.a === null && ops[k]!.b !== null);
      if (hit && s < 0) s = k;
      if (!hit && s >= 0) { out.push([s, k - 1]); s = -1; }
    }
    return out;
  };
  const lastMatchedB = (() => { let m = 0; for (const o of al.rows.ops) if (o.a !== null && o.b !== null) m = Math.max(m, o.b + 1); return m; })();
  const lastMatchedA = (() => { let m = 0; for (const o of al.rows.ops) if (o.a !== null && o.b !== null) m = Math.max(m, o.a + 1); return m; })();
  const usedCols = (s: Sheet, r1: number, r2: number, colM: Map<number, number>): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (let r = r1; r <= r2; r++) for (const c of s.rows.get(r)?.keys() ?? []) { const m = colM.get(c); if (m !== undefined) { lo = Math.min(lo, m); hi = Math.max(hi, m); } }
    return lo === Infinity ? [0, Math.max(0, colM.size - 1)] : [lo, hi];
  };
  const emptyRows = (s: Sheet, r1: number, r2: number): boolean => { for (let r = r1; r <= r2; r++) if (s.rows.get(r)?.size) return false; return true; };
  for (const [k0, k1] of runs(al.rows.ops, "b")) {
    const r1 = al.kB[k0]!, r2 = al.kB[k1]!;
    if (emptyRows(b, r1, r2)) continue;
    const count = r2 - r1 + 1;
    const end = r1 > lastMatchedB;
    const before = r1 - 1;
    // what the inserted rows hold, by column: a formula filled down reads as one line
    const lines: string[] = [];
    for (let c = 1; c <= b.maxCol && lines.length < 6; c++) {
      const first = b.rows.get(r1)?.get(c);
      if (!first || first.f === null) continue;
      const cache = new Map<string, string>();
      const sig = r1c1(b, r1, c, first, cache);
      let same = 0;
      for (let r = r1; r <= r2; r++) { const x = b.rows.get(r)?.get(c); if (x && x.f !== null && r1c1(b, r, c, x, cache) === sig) same++; }
      lines.push(same === count ? `Column ${numToCol(c)}: =${first.f} filled down` : `Column ${numToCol(c)}: formulas in ${n(same)} of ${n(count)} rows, starting =${first.f}`);
    }
    const ch = push(ctx, { mark: "added", label: `${sheetLabel(p)}!${r1}:${r2}`, text: end ? `${n(count)} row${count === 1 ? "" : "s"} added at the end (${rowsText(r1, r2)})` : `${n(count)} row${count === 1 ? "" : "s"} inserted after row ${n(before)} (now ${rowsText(r1, r2)})`, ...(lines.length ? { lines } : {}), kind: "rows-inserted", private: { sheet: sname, rows: [r1, r2] } });
    const [m0, m1] = usedCols(b, r1, r2, al.bColM);
    const hid = [...Array(count).keys()].every((i) => b.hiddenRows.has(r1 + i));
    if (b.state !== "visible" || hid) { unplace(ch, hiddenWhy(r1, null, b) ?? "hidden"); continue; }
    items.push({ change: ch, k0, k1, m0, m1, score: 30, uniform: true });
  }
  for (const [k0, k1] of runs(al.rows.ops, "a")) {
    const r1 = al.kA[k0]!, r2 = al.kA[k1]!;
    if (emptyRows(a, r1, r2)) continue;
    const count = r2 - r1 + 1;
    const end = r1 > lastMatchedA;
    const ch = push(ctx, { mark: "removed", label: `${quoteSheet(a.name)}!${r1}:${r2}`, text: end ? `${n(count)} row${count === 1 ? "" : "s"} deleted at the end (were ${rowsText(r1, r2)})` : `${n(count)} row${count === 1 ? "" : "s"} deleted (were ${rowsText(r1, r2)})`, kind: "rows-deleted", private: { sheet: a.name, rows: [r1, r2] } });
    const [m0, m1] = usedCols(a, r1, r2, al.aColM);
    if (a.state !== "visible") { unplace(ch, hiddenWhy(r1, null, a)!, "before"); continue; }
    items.push({ change: ch, k0, k1, m0, m1, score: 30, uniform: true });
  }
  // structural runs: columns
  for (const [m0, m1] of runs(al.cols.ops, "b")) {
    const c1 = al.mB[m0]!, c2 = al.mB[m1]!;
    if ([...Array(c2 - c1 + 1).keys()].every((i) => ![...b.rows.values()].some((row) => row.has(c1 + i)))) continue;
    const ch = push(ctx, { mark: "added", label: `${sheetLabel(p)}!${numToCol(c1)}:${numToCol(c2)}`, text: `${c2 - c1 + 1 === 1 ? "Column" : `${c2 - c1 + 1} columns`} ${c1 === c2 ? numToCol(c1) : `${numToCol(c1)}-${numToCol(c2)}`} inserted`, kind: "cols-inserted" });
    items.push({ change: ch, k0: 0, k1: Math.min(al.kB.length - 1, LIMITS.maxAreaRows), m0, m1, score: 30, uniform: true });
  }
  for (const [m0, m1] of runs(al.cols.ops, "a")) {
    const c1 = al.mA[m0]!, c2 = al.mA[m1]!;
    if ([...Array(c2 - c1 + 1).keys()].every((i) => ![...a.rows.values()].some((row) => row.has(c1 + i)))) continue;
    const ch = push(ctx, { mark: "removed", label: `${quoteSheet(a.name)}!${numToCol(c1)}:${numToCol(c2)}`, text: `${c2 - c1 + 1 === 1 ? "Column" : `${c2 - c1 + 1} columns`} ${c1 === c2 ? numToCol(c1) : `${numToCol(c1)}-${numToCol(c2)}`} deleted`, kind: "cols-deleted" });
    items.push({ change: ch, k0: 0, k1: Math.min(al.kA.length - 1, LIMITS.maxAreaRows), m0, m1, score: 30, uniform: true });
  }

  // cells under the maps
  const cacheA = new Map<string, string>(), cacheB = new Map<string, string>();
  const rowMapOf = (sheetName: string): ((r: number) => number) => {
    const m = mapsBySheetA.get(sheetName);
    if (!m) return (r) => r;
    return (r) => { const k = m.aRowK.get(r); if (k === undefined) return r + (m.kB.length - m.kA.length > 0 && r > (m.kA.length) ? m.kB.length - m.kA.length : 0); for (let x = k; x < m.kB.length; x++) { const rb = m.kB[x]; if (rb !== null && rb !== undefined) return rb; } return r; };
  };
  const colMapOf = (sheetName: string): ((c: number) => number) => {
    const m = mapsBySheetA.get(sheetName);
    if (!m) return (c) => c;
    return (c) => { const x = m.aColM.get(c); if (x === undefined) return c; for (let y = x; y < m.mB.length; y++) { const cb = m.mB[y]; if (cb !== null && cb !== undefined) return cb; } return c; };
  };
  const remapped = (f: string): string => {
    try {
      return remapFormulaRefs(f, a.name, (sh, r) => rowMapOf(sh)(r), (sh, c) => colMapOf(sh)(c)).text;
    } catch { return f; }
  };
  const diffs: CellDiff[] = [];
  for (let k = 0; k < al.kA.length; k++) {
    const ra = al.kA[k], rb = al.kB[k];
    if (ra === null || rb === null || ra === undefined || rb === undefined) continue;
    const rowA = a.rows.get(ra), rowB = b.rows.get(rb);
    if (!rowA && !rowB) continue;
    for (let m = 0; m < al.mA.length; m++) {
      const ca = al.mA[m], cb = al.mB[m];
      if (ca === null || cb === null || ca === undefined || cb === undefined) continue;
      const x = rowA?.get(ca), y = rowB?.get(cb);
      if (x === undefined && y === undefined) continue;
      let kind: CellDiff["kind"] | undefined;
      if (x?.f != null && y?.f != null) {
        const fa = canonNames(remapped(x.f), nameMapA), fb = canonNames(y.f, nameMapB);
        if (fa.replace(/\s+/g, "") !== fb.replace(/\s+/g, "")) kind = "input";
        else if (x.cached && y.cached && !valEq(x.v, y.v)) kind = "derived";
      } else if ((x?.f ?? null) !== null || (y?.f ?? null) !== null) kind = "input";
      else if (!valEq(x?.v ?? null, y?.v ?? null)) kind = "input";
      if (kind === undefined && (x?.look ?? "") !== (y?.look ?? "") && !(x === undefined || y === undefined)) kind = "format";
      if (kind === undefined) continue;
      const sa = x ? (x.f !== null ? `=${r1c1(a, ra, ca, x, cacheA, nameMapA)}` : `c:${x.v === null ? "empty" : typeof x.v}`) : "none";
      const sb = y ? (y.f !== null ? `=${r1c1(b, rb, cb, y, cacheB, nameMapB)}` : `c:${y.v === null ? "empty" : typeof y.v}`) : "none";
      const sig = kind === "format" ? `fmt|${x?.look}|${y?.look}` : `${kind}|${sb}|${sa}|${y && isErr(y.v) ? "err" : ""}`;
      diffs.push({ k, m, ra, rb, ca, cb, ...(x ? { a: x } : {}), ...(y ? { b: y } : {}), kind, sig });
    }
  }

  // derived cells: one summary per cause, after the input changes exist
  const inputs = diffs.filter((d) => d.kind !== "derived");
  const derived = diffs.filter((d) => d.kind === "derived");

  // patterns per column
  const byCol = new Map<number, CellDiff[]>();
  for (const d of inputs) { const l = byCol.get(d.m); if (l) l.push(d); else byCol.set(d.m, [d]); }
  interface Seg { sig: string; cells: CellDiff[]; except: CellDiff[] }
  const owner = new Map<CellDiff, XChange>();
  const singles: CellDiff[] = [];
  const describeCell = (d: CellDiff): Omit<XChange, "id"> => {
    const bw = cellWords(d.a), aw = cellWords(d.b);
    const mark: XChange["mark"] = bw === undefined ? "added" : aw === undefined ? "removed" : "changed";
    const lines: string[] = [];
    if (d.kind === "format") lines.push("Formatting changed; the value did not.");
    if (d.b && isErr(d.b.v)) lines.push(`Shows the error ${valueWords(d.b.v)}.`);
    if (d.b?.f && VOLATILE.test(d.b.f)) lines.push("Uses a function whose value differs on every open.");
    return { mark, label: `${quoteSheet(sname)}!${addr(d.rb!, d.cb!)}`, ...(bw !== undefined && mark !== "added" ? { before: bw } : {}), ...(aw !== undefined && mark !== "removed" ? { after: aw } : {}), ...(lines.length ? { lines } : {}), kind: d.kind === "format" ? "format" : d.a?.f || d.b?.f ? "formula" : "value", private: { sheet: sname, cell: addr(d.rb!, d.cb!), beforeCell: addr(d.ra!, d.ca!) } };
  };
  const cellScore = (d: CellDiff): number => {
    if (d.b && isErr(d.b.v) && !(d.a && isErr(d.a.v))) return 80;
    if (d.kind === "format") return 5;
    const f = d.b?.f ?? d.a?.f;
    let s = f ? 40 : 20;
    if (f && /\b(SUM|SUBTOTAL|AVERAGE|COUNT|MAX|MIN)\s*\(/i.test(f)) s += 60;
    const x = d.a?.v, y = d.b?.v;
    if (typeof x === "number" && typeof y === "number" && Math.abs(y - x) > 0.5 * Math.max(Math.abs(x), 1e-9)) s += 10;
    return s;
  };
  for (const [m, list] of byCol) {
    list.sort((x, y) => x.k - y.k);
    const segs: Seg[] = [];
    for (const d of list) {
      const last = segs[segs.length - 1];
      if (last && last.sig === d.sig && last.cells[last.cells.length - 1]!.k === d.k - 1) last.cells.push(d);
      else segs.push({ sig: d.sig, cells: [d], except: [] });
    }
    // merge a run, a short run of exceptions (up to 3 rows), and a run with the same change again
    for (let i = 0; i + 2 < segs.length; ) {
      const x = segs[i]!, e = segs[i + 1]!, y = segs[i + 2]!;
      const contiguous = x.cells[x.cells.length - 1]!.k + 1 === e.cells[0]!.k && e.cells[e.cells.length - 1]!.k + 1 === y.cells[0]!.k;
      if (x.sig === y.sig && contiguous && e.cells.length + e.except.length <= 3 && x.cells.length + y.cells.length >= 3) {
        segs.splice(i, 3, { sig: x.sig, cells: [...x.cells, ...y.cells], except: [...x.except, ...e.cells, ...e.except, ...y.except] });
      } else i++;
    }
    // a run followed by a short tail of exceptions to the end (boundary rows): attach them
    for (let i = 0; i + 1 < segs.length; i++) {
      const x = segs[i]!, e = segs[i + 1]!;
      if (x.cells.length >= 3 && e.cells.length === 1 && e.except.length === 0 && x.cells[x.cells.length - 1]!.k + 1 === e.cells[0]!.k && (i + 2 >= segs.length || segs[i + 2]!.cells[0]!.k > e.cells[0]!.k + 1)) { x.except.push(...e.cells); segs.splice(i + 1, 1); }
    }
    for (const s of segs) {
      if (s.cells.length < 3) { singles.push(...s.cells, ...s.except); continue; }
      const first = s.cells[0]!, last = s.cells[s.cells.length - 1]!;
      const allK = [...s.cells, ...s.except].map((d) => d.k);
      const k0 = Math.min(...allK), k1 = Math.max(...allK);
      const r1 = al.kB[k0]!, r2 = al.kB[k1]!, c = first.cb!;
      const fb = cellWords(first.b), fa = cellWords(first.a);
      const isFormula = !!(first.b?.f || first.a?.f);
      const what = first.kind === "format" ? "Formatting changed" : !first.a ? (isFormula ? "Formula filled in" : "Values entered in") : !first.b ? "Cleared" : isFormula ? "Formula changed in" : "Values changed in";
      const exc = s.except.map((d) => al.kB[d.k]!).sort((x, y) => x - y);
      const text = `${what} ${n(s.cells.length)} cells, ${rowsText(al.kB[first.k]!, al.kB[last.k]!)}${exc.length ? `, except ${exc.length === 1 ? "row" : "rows"} ${exc.map(n).join(", ")}` : ""}`;
      const lastB = cellWords(last.b), lastA = cellWords(last.a);
      const sideWords = (w: string | undefined, wl: string | undefined): string | undefined => (w === undefined ? undefined : isFormula ? `${w} (filled down)` : wl !== undefined && wl !== w ? `${w} \u2026 ${wl}` : w);
      const parent = push(ctx, { mark: !first.a ? "added" : !first.b ? "removed" : "changed", label: `${quoteSheet(sname)}!${numToCol(c)}${r1}:${numToCol(c)}${r2}`, ...(first.a && sideWords(fa, lastA) !== undefined ? { before: sideWords(fa, lastA)! } : {}), ...(first.b && sideWords(fb, lastB) !== undefined ? { after: sideWords(fb, lastB)! } : {}), text, kind: "pattern", private: { sheet: sname, range: `${numToCol(c)}${r1}:${numToCol(c)}${r2}`, count: s.cells.length, constant: !isFormula, rows: [r1, r2], col: c } });
      for (const d of s.cells) owner.set(d, parent);
      const keep: number[] = [];
      let sc = Math.max(...s.cells.slice(0, 1).map(cellScore));
      for (const d of s.except) {
        const ch = push(ctx, { ...describeCell(d), parent: parent.id, lines: [...(describeCell(d).lines ?? []), "Breaks the pattern of the cells around it."] });
        owner.set(d, ch);
        ctx.exceptions.set(ch.id, { before: { r1: d.ra!, r2: d.ra!, c1: d.ca!, c2: d.ca! }, after: { r1: d.rb!, r2: d.rb!, c1: d.cb!, c2: d.cb! } });
        keep.push(d.k);
        sc = Math.max(sc, cellScore(d));
        const why = hiddenWhy(d.rb, d.cb, b);
        if (why) unplace(ch, why);
      }
      const hidden = hiddenWhy(null, c, b);
      if (hidden || b.state !== "visible") { unplace(parent, hidden ?? hiddenWhy(null, null, b)!); continue; }
      items.push({ change: parent, k0, k1, m0: m, m1: m, score: sc, uniform: true, keep });
    }
  }
  // constant runs side by side over the same rows: one rectangle of values
  const constItems = items.filter((it) => it.change.kind === "pattern" && (it.change.private as { constant?: boolean }).constant === true && !(it.keep ?? []).length);
  constItems.sort((x, y) => x.k0 - y.k0 || x.m0 - y.m0);
  for (let i = 0; i < constItems.length; i++) {
    const x = constItems[i]!;
    if (!items.includes(x)) continue;
    let m1 = x.m1, count = (x.change.private as { count: number }).count;
    const absorbed: Item[] = [];
    for (const y of constItems) if (y !== x && items.includes(y) && y.k0 === x.k0 && y.k1 === x.k1 && y.m0 === m1 + 1 && y.change.mark === x.change.mark) { m1 = y.m1; count += (y.change.private as { count: number }).count; absorbed.push(y); }
    if (!absorbed.length) continue;
    const c1 = al.mB[x.m0]!, c2 = al.mB[m1]!, r1 = al.kB[x.k0]!, r2 = al.kB[x.k1]!;
    for (const y of absorbed) { items.splice(items.indexOf(y), 1); ctx.changes.splice(ctx.changes.indexOf(y.change), 1); }
    Object.assign(x.change, { label: `${quoteSheet(sname)}!${numToCol(c1)}${r1}:${numToCol(c2)}${r2}`, text: `Values ${x.change.mark === "added" ? "entered in" : x.change.mark === "removed" ? "cleared from" : "changed in"} ${n(count)} cells, ${numToCol(c1)}${r1}:${numToCol(c2)}${r2}`, private: { ...x.change.private, range: `${numToCol(c1)}${r1}:${numToCol(c2)}${r2}`, count } });
    delete x.change.before; delete x.change.after;
    x.m1 = m1;
  }
  // single edits along one row (an edit across many columns): one run
  const byRow = new Map<number, CellDiff[]>();
  for (const d of singles) { const l = byRow.get(d.k); if (l) l.push(d); else byRow.set(d.k, [d]); }
  const inRun = new Set<CellDiff>();
  for (const [k, list] of byRow) {
    list.sort((x, y) => x.m - y.m);
    let s0 = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i]!.m === list[i - 1]!.m + 1 && list[i]!.kind === list[0 + s0]!.kind && (list[i]!.a?.f != null) === (list[s0]!.a?.f != null)) continue;
      const run = list.slice(s0, i);
      s0 = i;
      if (run.length < 3) continue;
      const r = al.kB[k]!, c1 = run[0]!.cb!, c2 = run[run.length - 1]!.cb!;
      const kindWord = run[0]!.kind === "format" ? "Formatting changed in" : run.some((d) => d.a?.f || d.b?.f) ? "Formulas changed in" : "Values changed in";
      const ch = push(ctx, { mark: run.every((d) => !d.a) ? "added" : run.every((d) => !d.b) ? "removed" : "changed", label: `${quoteSheet(sname)}!${numToCol(c1)}${r}:${numToCol(c2)}${r}`, text: `${kindWord} ${n(run.length)} cells across row ${n(r)}, ${numToCol(c1)}${r}:${numToCol(c2)}${r}`, before: `${cellWords(run[0]!.a) ?? "empty"} \u2026 ${cellWords(run[run.length - 1]!.a) ?? "empty"}`, after: `${cellWords(run[0]!.b) ?? "empty"} \u2026 ${cellWords(run[run.length - 1]!.b) ?? "empty"}`, kind: "row-run", private: { sheet: sname, range: `${numToCol(c1)}${r}:${numToCol(c2)}${r}`, count: run.length } });
      for (const d of run) { inRun.add(d); owner.set(d, ch); }
      const why = hiddenWhy(r, null, b);
      if (why) { unplace(ch, why); continue; }
      items.push({ change: ch, k0: k, k1: k, m0: run[0]!.m, m1: run[run.length - 1]!.m, score: Math.max(...run.map(cellScore)), uniform: true });
    }
  }
  // single edits: grouped when many share a column and a kind of edit
  const singleByColSig = new Map<string, CellDiff[]>();
  for (const d of singles) {
    if (inRun.has(d)) continue; const key = `${d.m}|${d.sig}`; const l = singleByColSig.get(key); if (l) l.push(d); else singleByColSig.set(key, [d]); }
  for (const [, list] of singleByColSig) {
    list.sort((x, y) => x.k - y.k);
    let pictured = list;
    let groupParent: XChange | undefined;
    if (list.length >= 8) {
      const c = list[0]!.cb!;
      const r1 = al.kB[list[0]!.k]!, r2 = al.kB[list[list.length - 1]!.k]!;
      groupParent = push(ctx, { mark: "changed", label: `${quoteSheet(sname)}!${numToCol(c)}${r1}:${numToCol(c)}${r2}`, text: `${n(list.length)} single-cell edits in column ${numToCol(c)}, ${rowsText(r1, r2)}; the first 3 are pictured`, kind: "group", private: { sheet: sname, count: list.length } });
      pictured = list.slice(0, 3);
    }
    list.forEach((d, i) => {
      if (groupParent && i >= LIMITS.listChildren) return;
      const ch = push(ctx, { ...describeCell(d), ...(groupParent ? { parent: groupParent.id } : {}) });
      owner.set(d, ch);
      const why = hiddenWhy(d.rb, d.cb, b);
      if (why) { unplace(ch, why); return; }
      if (groupParent && !pictured.includes(d)) { unplace(ch, "the same kind of edit as the pictured ones in this column"); return; }
      items.push({ change: ch, k0: d.k, k1: d.k, m0: d.m, m1: d.m, score: cellScore(d), uniform: false });
    });
    if (groupParent && list.length > LIMITS.listChildren) groupParent.lines = [`${n(list.length - LIMITS.listChildren)} more edits like these are not listed one by one.`];
  }

  // derived summaries, by cause
  if (derived.length > 0) {
    const vol = derived.filter((d) => d.b?.f && VOLATILE.test(d.b.f));
    const real = derived.filter((d) => !vol.includes(d));
    if (vol.length > 0) ctx.caveats.push(`${n(vol.length)} cell${vol.length === 1 ? "" : "s"} on ${sname} use${vol.length === 1 ? "s" : ""} a function (RAND, NOW, TODAY, OFFSET, INDIRECT) whose value differs every time the file opens; not listed as changes.`);
    const groups = new Map<string, CellDiff[]>();
    for (const d of real) {
      let cause = "";
      try {
        const refs = extractFormulaRefs(d.b!.f!, sname).refs;
        outer: for (const ref of refs) for (const ch of ctx.changes) {
          const pv = ch.private as { sheet?: string; cell?: string; range?: string } | undefined;
          if (!pv || ch.kind === "derived" || !pv.sheet) continue;
          const sh = pv.sheet;
          if (sh !== ref.sheet && !(ref.sheet === a.name && sh === sname)) continue;
          const box = pv.cell ? rangeOf(pv.cell) : pv.range ? rangeOf(pv.range) : null;
          if (box && box.r1 <= ref.r2 && box.r2 >= ref.r1 && box.c1 <= ref.c2 && box.c2 >= ref.c1) { cause = ch.parent ?? ch.id; break outer; }
        }
      } catch { /* not resolvable */ }
      const l = groups.get(cause); if (l) l.push(d); else groups.set(cause, [d]);
    }
    for (const [cause, list] of groups) {
      const rs = list.map((d) => d.rb!), cs = list.map((d) => d.cb!);
      const box = { r1: Math.min(...rs), r2: Math.max(...rs), c1: Math.min(...cs), c2: Math.max(...cs) };
      const causeCh = ctx.changes.find((c) => c.id === cause);
      const ch = push(ctx, { mark: "changed", label: at(sname, box), text: `${n(list.length)} cell${list.length === 1 ? "" : "s"} recalculated: formula${list.length === 1 ? "" : "s"} unchanged, value${list.length === 1 ? "" : "s"} changed${causeCh ? ` because of ${causeCh.label}` : ""}`, kind: "derived", ...(cause ? { causedBy: cause } : {}), private: { sheet: sname, count: list.length } });
      unplace(ch, "values Excel recalculated from a changed input; the input is what is pictured", "both");
    }
  }
  return { items, pair: p, al };
}

export function rangeOf(s: string): Rect | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(s.replace(/^.*!/, ""));
  if (!m) return null;
  const col = (x: string): number => [...x].reduce((v, ch) => v * 26 + ch.charCodeAt(0) - 64, 0);
  const c1 = col(m[1]!), r1 = Number(m[2]), c2 = m[3] ? col(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1;
  return { r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: Math.min(c1, c2), c2: Math.max(c1, c2) };
}

// ---------------------------------------------------------------- blocks, pieces, areas

interface Block { items: Item[]; k0: number; k1: number; m0: number; m1: number; score: number }

export function clusterItems(items: Item[], L = LIMITS): Block[] {
  const blocks: Block[] = [];
  const sorted = [...items].sort((x, y) => x.k0 - y.k0 || x.m0 - y.m0);
  for (const it of sorted) {
    let joined: Block | undefined;
    for (const bl of blocks) {
      const rowGap = Math.max(0, Math.max(it.k0, bl.k0) - Math.min(it.k1, bl.k1) - 1);
      const colGap = Math.max(0, Math.max(it.m0, bl.m0) - Math.min(it.m1, bl.m1) - 1);
      const overlap = it.k0 <= bl.k1 && it.k1 >= bl.k0 && it.m0 <= bl.m1 && it.m1 >= bl.m0;
      if (!overlap && (rowGap > L.gapRows || colGap > L.gapCols)) continue;
      const k0 = Math.min(bl.k0, it.k0), k1 = Math.max(bl.k1, it.k1), m0 = Math.min(bl.m0, it.m0), m1 = Math.max(bl.m1, it.m1);
      const big = k1 - k0 + 1 > L.maxBlockRows || m1 - m0 + 1 > L.maxBlockCols;
      // an item already past the caps on its own joins only what it overlaps; otherwise the caps hold
      if (big && !overlap) continue;
      joined = bl;
      bl.items.push(it); bl.k0 = k0; bl.k1 = k1; bl.m0 = m0; bl.m1 = m1; bl.score = Math.max(bl.score, it.score) + (bl.items.length > 1 ? 1 : 0);
      break;
    }
    if (!joined) blocks.push({ items: [it], k0: it.k0, k1: it.k1, m0: it.m0, m1: it.m1, score: it.score });
  }
  return blocks;
}

/** Row windows (merged space) for a block: whole when short, else folded around what must stay visible. */
export function rowPieces(bl: Block, kMax: number, L = LIMITS): { pieces: [number, number][]; folded: [number, number][] } {
  const h = bl.k1 - bl.k0 + 1;
  if (h + 2 * L.ctxRows <= L.maxAreaRows) return { pieces: [win(bl.k0, bl.k1, kMax, L.ctxRows, L.minRows)], folded: [] };
  // rows that must show: every non-uniform item's rows, each uniform item's ends and its exceptions
  const must: [number, number][] = [];
  for (const it of bl.items) {
    if (!it.uniform || it.k1 - it.k0 + 1 <= 2 * L.foldKeep + L.foldMin) { must.push([it.k0, it.k1]); continue; }
    must.push([it.k0, it.k0 + L.foldKeep - 1], [it.k1 - L.foldKeep + 1, it.k1]);
    for (const k of it.keep ?? []) must.push([k, k]);
  }
  must.sort((x, y) => x[0] - y[0]);
  // windows with context, merged when they overlap or the gap between them is too short to fold
  let wins: [number, number][] = [];
  for (const [a0, a1] of must) {
    const w = win(a0, a1, kMax, L.ctxRows, 1);
    const last = wins[wins.length - 1];
    if (last && w[0] - last[1] - 1 < L.foldMin) last[1] = Math.max(last[1], w[1]);
    else wins.push(w);
  }
  // a window that grew past one page splits into page-sized pieces
  wins = wins.flatMap(([w0, w1]) => {
    const out: [number, number][] = [];
    for (let s = w0; s <= w1; s += L.maxAreaRows) out.push([s, Math.min(w1, s + L.maxAreaRows - 1)]);
    return out;
  });
  wins = wins.map(([w0, w1]) => win(w0 + 0, w1, kMax, 0, L.minRows));
  const folded: [number, number][] = [];
  for (let i = 0; i + 1 < wins.length; i++) if (wins[i + 1]![0] - wins[i]![1] > 1) folded.push([wins[i]![1] + 1, wins[i + 1]![0] - 1]);
  return { pieces: wins, folded };
}

/** [lo, hi] grown by `ctx` on each side and to at least `min`, clamped to [0, max]; a shortfall at one edge moves to the other side. */
export function win(lo: number, hi: number, max: number, ctx: number, min: number): [number, number] {
  let a = lo - ctx, b = hi + ctx;
  const need = Math.max(0, min - (b - a + 1));
  a -= Math.floor(need / 2); b += Math.ceil(need / 2);
  if (a < 0) { b += -a; a = 0; }
  if (b > max) { a -= b - max; b = max; }
  return [Math.max(0, a), Math.min(max, b)];
}

/** Column windows (merged space): one when narrow, else a left and a right piece. */
export function colPieces(bl: Block, mMax: number, L = LIMITS): { pieces: [number, number][]; folded: [number, number][] } {
  const w = bl.m1 - bl.m0 + 1;
  if (w + 2 * L.ctxCols <= L.maxBlockCols) return { pieces: [win(bl.m0, bl.m1, mMax, L.ctxCols, L.minCols)], folded: [] };
  const half = Math.floor((L.maxBlockCols - 1) / 2);
  const left = win(bl.m0, bl.m0 + half - 1, mMax, L.ctxCols, 1), right = win(bl.m1 - half + 1, bl.m1, mMax, L.ctxCols, 1);
  return { pieces: [left, right], folded: right[0] - left[1] > 1 ? [[left[1] + 1, right[0] - 1]] : [] };
}

// ---------------------------------------------------------------- the whole workbook

/** What differs between two sides of a chart, from its XML (title, axis titles, plot type, series), plus a resized frame; undefined when nothing known differs. A moved frame is not listed: its anchor is in each side's own rows and columns, which an insert shifts. */
function chartDetail(x: Drawing, y: Drawing): string | undefined {
  const bits: string[] = [];
  const d = x.xml !== undefined && y.xml !== undefined ? xlsxChartDetail(x.xml, y.xml) : undefined;
  if (d) bits.push(d);
  if (x.anchor && y.anchor && (x.anchor.r2 - x.anchor.r1 !== y.anchor.r2 - y.anchor.r1 || x.anchor.c2 - x.anchor.c1 !== y.anchor.c2 - y.anchor.c1)) bits.push(`size ${x.anchor.c2 - x.anchor.c1 + 1} by ${x.anchor.r2 - x.anchor.r1 + 1} cells \u2192 ${y.anchor.c2 - y.anchor.c1 + 1} by ${y.anchor.r2 - y.anchor.r1 + 1} cells`);
  return bits.length ? bits.join("; ") : undefined;
}
const describeDrawing = (d: Drawing): string => `${d.kind === "chart" ? "Chart" : d.kind === "image" ? "Picture" : "Shape"}${d.name ? ` '${d.name}'` : ""}`;

/** The change list and print plan for a before/after pair. `before` or `after` null: the file did not exist on that side. */
export function planExcel(beforeBytes: Uint8Array | null, afterBytes: Uint8Array | null, L = LIMITS): ExcelPlan {
  const A = beforeBytes ? readWorkbook(beforeBytes) : null;
  const B = afterBytes ? readWorkbook(afterBytes) : null;
  const ctx: Ctx = { changes: [], caveats: [], next: 0, exceptions: new Map(), charts: new Map() };
  const plan: ExcelPlan = { changes: ctx.changes, caveats: ctx.caveats, before: [], after: [], groups: [], issues: [] };
  const empty: Workbook = { sheets: [], names: new Map(), parts: new Map(), fullCalcOnLoad: false, uncached: 0, macros: false };
  const pairs = matchSheets(A ?? empty, B ?? empty);
  // sheet name tokens, so a formula pointing at a renamed sheet compares equal
  const nameMapA = new Map<string, string>(), nameMapB = new Map<string, string>();
  pairs.forEach((p, i) => { if (p.a) nameMapA.set(p.a.name, `⟦S${i}⟧`); if (p.b) nameMapB.set(p.b.name, `⟦S${i}⟧`); });
  const mapsA = new Map<string, Aligned>();
  for (const p of pairs) if (p.a && p.b && p.a.kind === "worksheet") mapsA.set(p.a.name, alignSheet(p.a, p.b, nameMapA, nameMapB));

  interface Scored { p: Pair; al: Aligned; block: Block; oneSide?: "a" | "b"; chart?: boolean }
  const scored: Scored[] = [];

  // workbook-level parts and sheets
  for (const p of pairs) {
    if (p.a && !p.b) {
      const ch = push(ctx, { mark: "removed", label: `Sheet ${quoteSheet(p.a.name)}`, text: `Sheet ${p.a.name} deleted${p.a.kind === "worksheet" ? ` (it held ${n(countCells(p.a))} cells)` : ""}`, kind: "sheet-deleted" });
      if (p.a.state !== "visible") unplace(ch, `the sheet was ${p.a.state === "veryHidden" ? "very hidden" : "hidden"}`, "before");
      else scored.push({ p, al: oneSided(p.a, "a"), block: topBlock(p.a, ch, 100), oneSide: "a", ...(p.a.kind === "chartsheet" ? { chart: true } : {}) });
    } else if (p.b && !p.a) {
      const created = A === null;
      const cells = countCells(p.b), formulas = countFormulas(p.b), charts = p.b.drawings.filter((d) => d.kind === "chart").length;
      const ch = push(ctx, { mark: "added", label: `Sheet ${quoteSheet(p.b.name)}`, text: p.b.kind === "worksheet" ? `Sheet ${p.b.name} ${created ? "created" : "added"}: ${n(p.b.maxRow)} rows by ${n(p.b.maxCol)} columns, ${n(cells)} cells${formulas ? ` (${n(formulas)} formulas)` : ""}${charts ? `, ${n(charts)} chart${charts === 1 ? "" : "s"}` : ""}` : `Chart sheet ${p.b.name} ${created ? "created" : "added"}`, kind: "sheet-added" });
      if (p.b.state !== "visible") unplace(ch, `the sheet is ${p.b.state === "veryHidden" ? "very hidden" : "hidden"}`);
      else scored.push({ p, al: oneSided(p.b, "b"), block: topBlock(p.b, ch, created ? 50 : 100), oneSide: "b", ...(p.b.kind === "chartsheet" ? { chart: true } : {}) });
    } else if (p.a && p.b && p.renamed) {
      push(ctx, { mark: "changed", label: `Sheet ${quoteSheet(p.b.name)}`, before: p.a.name, after: p.b.name, text: `Sheet renamed from ${p.a.name} to ${p.b.name}; formulas that point at it were updated with it`, kind: "sheet-renamed" });
    }
  }
  if (A && B) {
    const orderA = pairs.filter((p) => p.a && p.b).sort((x, y) => A.sheets.indexOf(x.a!) - A.sheets.indexOf(y.a!)).map((p) => p.b!.name);
    const orderB = pairs.filter((p) => p.a && p.b).sort((x, y) => B.sheets.indexOf(x.b!) - B.sheets.indexOf(y.b!)).map((p) => p.b!.name);
    if (orderA.join("\u0001") !== orderB.join("\u0001")) push(ctx, { mark: "moved", label: "Sheet order", before: orderA.join(", "), after: orderB.join(", "), text: "The order of the sheets changed", kind: "sheet-order" });
    for (const p of pairs) {
      if (!p.a || !p.b) continue;
      if (p.a.state !== p.b.state) push(ctx, { mark: "changed", label: `Sheet ${quoteSheet(p.b.name)}`, before: p.a.state, after: p.b.state, text: `Sheet ${p.b.name} is now ${p.b.state === "visible" ? "shown" : p.b.state === "hidden" ? "hidden" : "very hidden"}`, kind: "sheet-state" });
      // drawings: charts, pictures, shapes, matched by content, then by name
      const da = [...p.a.drawings], db = [...p.b.drawings];
      const used = new Set<Drawing>();
      const changedCharts: { before?: Drawing; after?: Drawing; ch: XChange }[] = [];
      for (const x of da) {
        let y = db.find((d) => !used.has(d) && d.kind === x.kind && d.sha === x.sha);
        if (y) { used.add(y); continue; }
        // a chart pairs only on an exact object-name match on this sheet (never on its title); other drawings keep the name match, and a chart with no object name on either side keeps the title match
        y = db.find((d) => !used.has(d) && d.kind === x.kind && (x.kind === "chart" ? (x.objectName !== undefined ? d.objectName === x.objectName : d.objectName === undefined && d.name !== "" && d.name === x.name) : d.name !== "" && d.name === x.name));
        if (y) { used.add(y); const detail = x.kind === "chart" ? chartDetail(x, y) : undefined; const ch = push(ctx, { mark: "changed", label: `${quoteSheet(p.b.name)} (${describeDrawing(x)})`, text: `${describeDrawing(y)} on ${p.b.name} changed${detail ? `: ${detail}` : ""}`, kind: x.kind }); changedCharts.push({ before: x, after: y, ch }); continue; }
        const ch = push(ctx, { mark: "removed", label: `${quoteSheet(p.b.name)} (${describeDrawing(x)})`, text: `${describeDrawing(x)} removed from sheet ${p.b.name}`, kind: x.kind });
        changedCharts.push({ before: x, ch });
      }
      for (const y of db) if (!used.has(y)) { const ch = push(ctx, { mark: "added", label: `${quoteSheet(p.b.name)} (${describeDrawing(y)})`, text: `${describeDrawing(y)} added to sheet ${p.b.name}`, kind: y.kind }); changedCharts.push({ after: y, ch }); }
      for (const cc of changedCharts) {
        ctx.charts.set(cc.ch.id, { ...(cc.before ? { before: cc.before } : {}), ...(cc.after ? { after: cc.after } : {}) });
        if (p.b.kind === "chartsheet") { scored.push({ p, al: oneSided(p.b, "b"), block: { items: [], k0: 0, k1: 0, m0: 0, m1: 0, score: 100 }, chart: true }); (scored[scored.length - 1]!.block as Block & { change?: XChange }).change = cc.ch; continue; }
        const anchor = cc.before?.anchor ?? cc.after?.anchor;
        const al = mapsA.get(p.a.name);
        if (!anchor || !al) { unplace(cc.ch, "it is not anchored to cells"); continue; }
        const kmap = cc.before?.anchor ? al.aRowK : al.bRowK, mmap = cc.before?.anchor ? al.aColM : al.bColM;
        const k0 = kmap.get(anchor.r1) ?? anchor.r1 - 1, k1 = kmap.get(anchor.r2) ?? anchor.r2 - 1, m0 = mmap.get(anchor.c1) ?? anchor.c1 - 1, m1 = mmap.get(anchor.c2) ?? anchor.c2 - 1;
        const it: Item = { change: cc.ch, k0: Math.min(k0, al.kA.length - 1), k1: Math.min(k1, Math.max(al.kA.length, al.kB.length) - 1), m0: Math.min(m0, Math.max(al.mA.length, al.mB.length) - 1), m1: Math.min(m1, Math.max(al.mA.length, al.mB.length) - 1), score: cc.ch.mark === "removed" ? 100 : 60, uniform: false };
        (cc.ch.private ??= {}).anchor = rangeText(anchor);
        scored.push({ p, al, block: { items: [it], k0: it.k0, k1: Math.max(it.k0, it.k1), m0: it.m0, m1: Math.max(it.m0, it.m1), score: it.score } });
      }
      // comments
      for (const [ref, t] of p.a.comments) if (p.b.comments.get(ref) !== t) { const ch = push(ctx, { mark: p.b.comments.has(ref) ? "changed" : "removed", label: `${quoteSheet(p.b.name)}!${ref} (comment)`, before: t, ...(p.b.comments.has(ref) ? { after: p.b.comments.get(ref)! } : {}), kind: "comment" }); unplace(ch, "comments do not print", "both"); }
      for (const [ref, t] of p.b.comments) if (!p.a.comments.has(ref)) { const ch = push(ctx, { mark: "added", label: `${quoteSheet(p.b.name)}!${ref} (comment)`, after: t, kind: "comment" }); unplace(ch, "comments do not print", "both"); }
    }
    // defined names
    for (const [k, v] of A.names) { const w = B.names.get(k); if (w !== v) { const ch = push(ctx, { mark: w === undefined ? "removed" : "changed", label: `Name ${k.split("|")[0]}`, before: v, ...(w !== undefined ? { after: w } : {}), kind: "name" }); unplace(ch, "a defined name has no place on a sheet", "both"); } }
    for (const [k, v] of B.names) if (!A.names.has(k)) { const ch = push(ctx, { mark: "added", label: `Name ${k.split("|")[0]}`, after: v, kind: "name" }); unplace(ch, "a defined name has no place on a sheet", "both"); }
    if (A.macros !== B.macros) { const ch = push(ctx, { mark: B.macros ? "added" : "removed", label: "Macros", text: B.macros ? "The workbook now holds macros (a VBA project)" : "The workbook's macros (VBA project) were removed", kind: "macros" }); unplace(ch, "macros do not print", "both"); }
    for (const kind of ["tables", "pivotTables", "externalLinks"]) {
      const pa = [...A.parts.keys()].filter((x) => x.includes(`/${kind}/`) && x.endsWith(".xml")).length, pb = [...B.parts.keys()].filter((x) => x.includes(`/${kind}/`) && x.endsWith(".xml")).length;
      if (pa !== pb) { const ch = push(ctx, { mark: pb > pa ? "added" : "removed", label: kind === "tables" ? "Tables" : kind === "pivotTables" ? "Pivot tables" : "External links", text: `${kind === "tables" ? "Tables" : kind === "pivotTables" ? "Pivot tables" : "Links to other workbooks"}: ${pa} before, ${pb} after`, kind }); unplace(ch, "this is a workbook part, not cells", "both"); }
    }
  }

  // cells, per matched worksheet
  for (const p of pairs) {
    if (!p.a || !p.b || p.a.kind !== "worksheet" || p.b.kind !== "worksheet") continue;
    const r = diffSheet(ctx, p, nameMapA, nameMapB, mapsA);
    if (p.b.state !== "visible") continue;
    for (const bl of clusterItems(r.items, L)) scored.push({ p, al: r.al, block: bl });
  }
  if (B && B.uncached > 0) ctx.caveats.push(`${n(B.uncached)} formula${B.uncached === 1 ? " has" : "s have"} no saved value in the after file; Excel calculates ${B.uncached === 1 ? "it" : "them"} when it opens the file, and the pictures show Excel's result.`);
  if (B?.fullCalcOnLoad) ctx.caveats.push("The after file asks Excel to recalculate everything when it opens; the values shown are Excel's recalculation, which may differ from the values saved in the file.");

  // rank and cap
  scored.sort((x, y) => y.block.score - x.block.score);
  const perSheet = new Map<string, number>();
  let total = 0;
  let gi = 0;
  const sheetsOut = { before: new Map<string, SheetPrint>(), after: new Map<string, SheetPrint>() };
  const pendingBoxes: { change: XChange; group: string; sheet: { before?: string; after?: string }; cells: Sides; drawing: { before?: string; after?: string }; offset: { before?: { x: number; y: number }; after?: { x: number; y: number } } }[] = [];
  const pendingZoom: { sp: SheetPrint; side: "before" | "after"; sheet: Sheet; key: string }[] = [];
  const omitted: XChange[] = [];
  for (const s of scored) {
    const key = s.p.b?.name ?? s.p.a!.name;
    const used = perSheet.get(key) ?? 0;
    const blockChanges = s.block.items.length ? s.block.items.map((i) => i.change) : [(s.block as Block & { change?: XChange }).change].filter((x): x is XChange => !!x);
    if (used >= L.perSheet || total >= L.perFile) { omitted.push(...blockChanges); for (const ch of blockChanges) unplace(ch, `past the picture limit (${L.perSheet} areas a sheet, ${L.perFile} a file)`, "both"); continue; }
    perSheet.set(key, used + 1); total++;
    const group = `g${++gi}`;
    const info: GroupInfo = { id: group, score: s.block.score, changes: blockChanges.map((c) => c.id) };
    plan.groups.push(info);
    for (const ch of blockChanges) (ch.private ??= {}).group = group;
    if (s.chart) {
      for (const side of ["before", "after"] as const) {
        const sh = side === "before" ? s.p.a : s.p.b;
        if (!sh) { info.placeholder = { ...(info.placeholder ?? {}), [side]: side === "before" ? "This chart sheet did not exist" : "This chart sheet was deleted" }; continue; }
        if (sh.state !== "visible") continue;
        sheetsOut[side].set(sh.name, { name: sh.name, kind: "chartsheet", areas: [], zoom: 100, landscape: true, group });
      }
      continue;
    }
    // pieces in merged space, then each side's own rows and columns
    const kMax = s.al.kA.length - 1, mMax = s.al.mA.length - 1;
    const asOne = (s.block as Block & { whole?: true }).whole === true;
    const rp = asOne ? { pieces: [[s.block.k0, Math.min(s.block.k1, kMax)] as [number, number]], folded: [] as [number, number][] } : rowPieces(s.block, kMax, L);
    const cp = asOne ? { pieces: [[s.block.m0, Math.min(s.block.m1, mMax)] as [number, number]], folded: [] as [number, number][] } : colPieces(s.block, mMax, L);
    const main = blockChanges[0]!;
    for (const [f0, f1] of rp.folded) {
      const kind = s.block.items.find((i) => i.uniform && i.k0 <= f0 && i.k1 >= f1);
      const ra = s.al.kB.slice(f0, f1 + 1).filter((x): x is number => x !== null), rb = s.al.kA.slice(f0, f1 + 1).filter((x): x is number => x !== null);
      const rows = ra.length ? ra : rb;
      if (!rows.length) continue;
      const ch = push(ctx, { mark: "described", label: `${quoteSheet(key)}!${rows[0]}:${rows[rows.length - 1]}`, text: `${rowsText(rows[0]!, rows[rows.length - 1]!)} not shown${kind ? ` (${kind.change.kind === "rows-inserted" ? "all inserted" : kind.change.kind === "rows-deleted" ? "all deleted" : "the same change throughout"}, no other changes)` : ""}`, parent: main.id, kind: "fold" });
      unplace(ch, "folded to keep the picture to the changed edges", "both");
    }
    for (const [f0, f1] of cp.folded) {
      const cs = s.al.mB.slice(f0, f1 + 1).filter((x): x is number => x !== null);
      if (!cs.length) continue;
      const ch = push(ctx, { mark: "described", label: `${quoteSheet(key)}!${numToCol(cs[0]!)}:${numToCol(cs[cs.length - 1]!)}`, text: `Columns ${numToCol(cs[0]!)}-${numToCol(cs[cs.length - 1]!)} not shown (the same change continues across them)`, parent: main.id, kind: "fold" });
      unplace(ch, "folded to keep the picture to the changed edges", "both");
    }
    // the cells of each pictured change, per side it exists on, in that side's own rows and columns
    const boundOf = (side: "before" | "after", k0: number, k1: number, m0: number, m1: number): Rect | undefined => {
      const ks = (side === "before" ? s.al.kA : s.al.kB).slice(k0, k1 + 1).filter((x): x is number => x !== null);
      const ms = (side === "before" ? s.al.mA : s.al.mB).slice(m0, m1 + 1).filter((x): x is number => x !== null);
      return ks.length && ms.length ? { r1: Math.min(...ks), r2: Math.max(...ks), c1: Math.min(...ms), c2: Math.max(...ms) } : undefined;
    };
    const sheetNames = { ...(s.p.a ? { before: s.p.a.name } : {}), ...(s.p.b ? { after: s.p.b.name } : {}) };
    for (const it of s.block.items) {
      const exs = [it.change, ...ctx.changes.filter((c) => c.parent === it.change.id && ctx.exceptions.has(c.id))];
      for (const ch of exs) {
        if (ch.private?.unplaced) continue;
        const on = sidesOfMark(ch.mark), cells: Sides = {}, drawing: { before?: string; after?: string } = {}, offset: { before?: { x: number; y: number }; after?: { x: number; y: number } } = {};
        const chart = ctx.charts.get(ch.id), ex = ctx.exceptions.get(ch.id);
        for (const side of ["before", "after"] as const) {
          if (!on[side]) continue;
          const r = chart ? chart[side]?.anchor : ex ? ex[side] : boundOf(side, it.k0, it.k1, it.m0, it.m1);
          if (!r) continue;
          cells[side] = { ...r };
          if (chart?.[side]) { drawing[side] = chart[side]!.objectName ?? chart[side]!.name; if (chart[side]!.anchorOffset) offset[side] = chart[side]!.anchorOffset; }
        }
        if (cells.before || cells.after) pendingBoxes.push({ change: ch, group, sheet: sheetNames, cells, drawing, offset });
      }
    }
    let order = 0;
    const pieces = rp.pieces.slice(0, L.maxPieces);
    for (const [k0, k1] of pieces) for (const [m0, m1] of cp.pieces) {
      for (const side of ["before", "after"] as const) {
        const ks = side === "before" ? s.al.kA : s.al.kB, ms = side === "before" ? s.al.mA : s.al.mB;
        const sh = side === "before" ? s.p.a : s.p.b;
        if (!sh || sh.kind !== "worksheet") continue;
        // a sheet with no cells has nothing to show, unless drawings sit on it (a sheet of charts)
        if (side === "after" && sh.rows.size === 0 && !sh.drawings.some((d) => d.anchor !== undefined)) continue;
        let rows = ks.slice(k0, k1 + 1).filter((x): x is number => x !== null);
        const cols = ms.slice(m0, m1 + 1).filter((x): x is number => x !== null);
        if (!rows.length || !cols.length) continue;
        if (Math.max(...rows) - Math.min(...rows) + 1 > 2 * (k1 - k0 + 1)) {
          // this side's rows are scattered (a reorder): a window around the block's own rows, in this side's own rows
          const core = ks.slice(s.block.k0, s.block.k1 + 1).filter((x): x is number => x !== null);
          if (core.length) { const [w0, w1] = win(Math.min(...core) - 1, Math.max(...core) - 1, Math.max(0, sh.maxRow - 1), L.ctxRows, L.minRows); rows = [w0 + 1, w1 + 1]; }
        }
        const rect: Rect = { r1: Math.min(...rows), r2: Math.max(...rows), c1: Math.min(...cols), c2: Math.max(...cols) };
        let sp = sheetsOut[side].get(sh.name);
        if (!sp) { sp = { name: sh.name, kind: "worksheet", areas: [], zoom: 100, landscape: false }; sheetsOut[side].set(sh.name, sp); sheetOfPrint.set(sp, sh); pendingZoom.push({ sp, side, sheet: sh, key }); }
        sp.areas.push({ group, order, rect, boxes: [] });
      }
      order++;
    }
    if (s.oneSide) info.placeholder = s.oneSide === "b" ? { before: A === null ? "The file did not exist yet" : "This sheet did not exist" } : { after: "This sheet was deleted" };
    if (s.block.items.some((i) => (i as Item & { emptied?: boolean }).emptied)) info.placeholder = { after: "The sheet is now empty: nothing to print" };
  }
  if (omitted.length) ctx.caveats.push(`${n(omitted.length)} change${omitted.length === 1 ? "" : "s"} past the picture limit ${omitted.length === 1 ? "is" : "are"} listed without a picture.`);

  // merge areas on one sheet side that overlap or touch (Excel merges touching print ranges itself, and no row should print twice)
  for (const side of ["before", "after"] as const) for (const sp of sheetsOut[side].values()) sp.areas = mergeAreas(sp.areas);
  // groups whose areas merged on either side become one group; pieces are then numbered top to bottom on each side
  const up = new Map<string, string>();
  const find = (g: string): string => { let x = g; while (up.has(x)) x = up.get(x)!; return x; };
  for (const side of ["before", "after"] as const) for (const sp of sheetsOut[side].values()) for (const ar of sp.areas as (PrintArea & { also?: { group: string }[] })[]) for (const o of ar.also ?? []) { const x = find(o.group), y = find(ar.group); if (x !== y) up.set(x, y); }
  if (up.size > 0) {
    const keep: GroupInfo[] = [];
    for (const g of plan.groups) {
      const r = find(g.id);
      if (r === g.id) { keep.push(g); continue; }
      const into = plan.groups.find((x) => x.id === r)!;
      into.changes.push(...g.changes); into.score = Math.max(into.score, g.score);
      for (const id of g.changes) { const ch = ctx.changes.find((c) => c.id === id); if (ch?.private) ch.private.group = r; }
    }
    plan.groups = keep;
    for (const side of ["before", "after"] as const) for (const sp of sheetsOut[side].values()) {
      for (const ar of sp.areas) ar.group = find(ar.group);
      const byGroup = new Map<string, PrintArea[]>();
      for (const ar of sp.areas) { const l = byGroup.get(ar.group); if (l) l.push(ar); else byGroup.set(ar.group, [ar]); }
      for (const l of byGroup.values()) l.sort((x, y) => x.rect.r1 - y.rect.r1 || x.rect.c1 - y.rect.c1).forEach((ar, i) => { ar.order = i; });
    }
  }
  for (const side of ["before", "after"] as const) for (const sp of sheetsOut[side].values()) {
    for (const ar of sp.areas) delete (ar as PrintArea & { also?: unknown }).also;
    sp.areas.sort((x, y) => x.rect.r1 - y.rect.r1 || x.rect.c1 - y.rect.c1);
  }
  // boxes: each pictured change on the first area of its group, on each side, that touches its cells
  for (const pb of pendingBoxes) {
    const g = find(pb.group);
    for (const side of ["before", "after"] as const) {
      const cells = pb.cells[side], name = pb.sheet[side];
      if (!cells || name === undefined) continue;
      const sp = sheetsOut[side].get(name);
      const ar = sp?.areas.find((a) => a.group === g && a.rect.r1 <= cells.r2 && a.rect.r2 >= cells.r1 && a.rect.c1 <= cells.c2 && a.rect.c2 >= cells.c1);
      if (ar) ar.boxes.push({ change: pb.change.id, cells, ...(pb.drawing[side] !== undefined ? { drawing: pb.drawing[side]! } : {}), ...(pb.offset[side] ? { offset: pb.offset[side]! } : {}) });
    }
  }
  // zoom and orientation, shared by both sides of a sheet so before and after print at the same scale
  const PAGE = { w: 612 - 36, h: 792 - 36 };
  const need = new Map<string, { w: number; h: number }>();
  for (const { sp, sheet, key } of pendingZoom) {
    let w = 0, h = 0;
    for (const ar of sp.areas) {
      let aw = 30, ah = 16;
      for (let c = ar.rect.c1; c <= ar.rect.c2; c++) aw += printedWidthPt(sheet, c);
      for (let r = ar.rect.r1; r <= ar.rect.r2; r++) ah += heightPt(sheet, r) * PRINT_ROW_K;
      w = Math.max(w, aw); h = Math.max(h, ah);
    }
    const prev = need.get(key) ?? { w: 0, h: 0 };
    need.set(key, { w: Math.max(prev.w, w), h: Math.max(prev.h, h) });
  }
  for (const { sp, key } of pendingZoom) {
    const nd = need.get(key)!;
    const landscape = nd.w > PAGE.w && nd.h <= PAGE.w;
    const pw = landscape ? PAGE.h : PAGE.w, ph = landscape ? PAGE.w : PAGE.h;
    sp.landscape = landscape;
    sp.zoom = Math.max(L.minZoom, Math.min(100, Math.floor(100 * Math.min(pw / nd.w, ph / nd.h))));
  }
  plan.before = [...sheetsOut.before.values()];
  plan.after = [...sheetsOut.after.values()];
  // the list in priority order: pictured groups by rank, then the rest; children right after their parents
  const rank = new Map<string, number>();
  plan.groups.forEach((g, i) => g.changes.forEach((id) => { if (!rank.has(id)) rank.set(id, i); }));
  const byId = new Map(ctx.changes.map((c) => [c.id, c] as const));
  const top = ctx.changes.filter((c) => !c.parent || !byId.has(c.parent));
  const weight = (c: XChange): number => (c.kind === "chart" || c.kind === "image" || c.kind === "sheet-deleted") && c.mark === "removed" ? -2 : rank.has(c.id) ? rank.get(c.id)! : 1e6;
  const ordered: XChange[] = [];
  const kids = new Map<string, XChange[]>();
  for (const c of ctx.changes) if (c.parent && byId.has(c.parent)) { const l = kids.get(c.parent); if (l) l.push(c); else kids.set(c.parent, [c]); }
  const visit = (c: XChange): void => { ordered.push(c); for (const k of kids.get(c.id) ?? []) visit(k); };
  top.map((c, i) => ({ c, i })).sort((x, y) => weight(x.c) - weight(y.c) || x.i - y.i).forEach(({ c }) => visit(c));
  plan.changes = ordered;
  plan.issues = introducedErrors(pairs.flatMap((p): ErrorSheet[] => (p.b ? [{ label: quoteSheet(p.b.name), after: p.b, beforeOf: beforeCellOf(p.a, p.a ? mapsA.get(p.a.name) : undefined) }] : [])));
  return plan;
}

/** The before cell an after cell was compared with: through the pair's row and column alignment; an after row or column the alignment does not reach keeps its own address. */
function beforeCellOf(a: Sheet | undefined, al: Aligned | undefined): ErrorSheet["beforeOf"] {
  if (a === undefined) return () => undefined;
  return (r, c) => {
    if (al === undefined) return a.rows.get(r)?.get(c);
    const k = al.bRowK.get(r), m = al.bColM.get(c);
    const ra = k === undefined ? r : al.kA[k], ca = m === undefined ? c : al.mA[m];
    return ra === null || ra === undefined || ca === null || ca === undefined ? undefined : a.rows.get(ra)?.get(ca);
  };
}

// What Excel's print measures on this Mac (measured): a column of stored width w prints round(w*8)*0.75 pt (width 13: 156 px at
// zoom 100), a hidden column nothing; a row prints at 14/15 of its stored height. The file's own widths (widthPt) are 15% too generous for the zoom sum.
export const PRINT_ROW_K = 14 / 15;
export const printedWidthPt = (s: Sheet, c: number): number => (s.hiddenCols.has(c) ? 0 : Math.round((s.widths.get(c) ?? s.defaultWidth) * 8) * 0.75);

function mergeAreas(areas: PrintArea[]): PrintArea[] {
  const out: PrintArea[] = [];
  for (const ar of areas) {
    const hit = out.find((o) => o.rect.r1 <= ar.rect.r2 + 1 && o.rect.r2 >= ar.rect.r1 - 1 && o.rect.c1 <= ar.rect.c2 + 1 && o.rect.c2 >= ar.rect.c1 - 1);
    if (hit) {
      hit.rect = { r1: Math.min(hit.rect.r1, ar.rect.r1), r2: Math.max(hit.rect.r2, ar.rect.r2), c1: Math.min(hit.rect.c1, ar.rect.c1), c2: Math.max(hit.rect.c2, ar.rect.c2) };
      (hit as PrintArea & { also?: { group: string; order: number }[] }).also = [...((hit as PrintArea & { also?: { group: string; order: number }[] }).also ?? []), { group: ar.group, order: ar.order }];
    } else out.push({ ...ar, rect: { ...ar.rect } });
  }
  // a merge can make two earlier areas touch: repeat until stable
  return out.length < areas.length ? mergeAreas(out) : out;
}

function countCells(s: Sheet): number { let k = 0; for (const r of s.rows.values()) k += r.size; return k; }
function countFormulas(s: Sheet): number { let k = 0; for (const r of s.rows.values()) for (const c of r.values()) if (c.f !== null) k++; return k; }

/** The top of a one-sided sheet: rows 1.. up to 30, columns up to 12. */
/**
 * The top of a sheet shown whole (added or deleted): its first 30 rows by 12 columns of cells, widened to hold every drawing that starts inside that corner (up to 60 rows by 40
 * columns), so a chart beside the data, or a sheet that holds only charts, is in the picture (a created sheet of four charts and no cells read "0 cells, not pictured").
 */
function topBlock(s: Sheet, ch: XChange, score: number): Block {
  const near = s.drawings.flatMap((d) => (d.anchor && d.anchor.r1 <= 30 && d.anchor.c1 <= 12 ? [d.anchor] : []));
  const dr = Math.min(60, near.reduce((m, a) => Math.max(m, a.r2), 0)), dc = Math.min(40, near.reduce((m, a) => Math.max(m, a.c2), 0));
  const k1 = Math.max(0, Math.max(Math.min(s.maxRow, 30), dr) - 1), m1 = Math.max(0, Math.max(Math.min(s.maxCol, 12), dc) - 1);
  // widened for drawings: shown as one piece, never folded (a fold through the middle would cut a chart in two)
  const whole = dr > Math.min(s.maxRow, 30) || dc > Math.min(s.maxCol, 12);
  return { items: [{ change: ch, k0: 0, k1, m0: 0, m1, score, uniform: false }], k0: 0, k1, m0: 0, m1, score, ...(whole ? { whole: true as const } : {}) };
}
