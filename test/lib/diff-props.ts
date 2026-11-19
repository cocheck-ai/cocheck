import type { FormatRow } from "../../src/timeline/timeline.ts";
import type { ViewChange } from "../../src/timeline/render/types.ts";
import type { LayerDiffRow } from "../../src/formats/layer.ts";

/*
 * DIFF PROPERTIES. Six checks on a connector's diff (P1 to P6) that assert properties, never field names, so the shared diff format
 * stays free to change. THIS FILE IS THE ONE PLACE that knows today's types: FormatRow (timeline.ts),
 * ViewChange (render/types.ts) and LayerDiffRow (formats/layer.ts). Tests and the conformance cases build a `DiffCase` through `diffCaseOf`, run the
 * checks by name, and plant bad inputs through `plant`; none of them names a schema field. When the format changes, only `diffCaseOf`,
 * `railCredits`, `plant` and the key list `CONNECTOR_SIDE_KEYS` move.
 *
 * Exports: p1LocatorFindable, p2SidesMatchKind, p3SidesRenderNonEmpty, p4CreditIsCoChecks, p5PrecisionWithinDeclared, p6Deterministic,
 * and `CHECKS` keyed "P1".."P6". Every check is `(c: DiffCase, o?: CheckOpts) => CheckResult`.
 */

export type Precision = "none" | "page" | "region" | "cell" | "words";
const LADDER: Precision[] = ["none", "page", "region", "cell", "words"];
export type Side = "before" | "after";
export type Credit = { state: "call"; call: string } | { state: "unsure" } | { state: "outside" };
export interface CheckResult { ok: boolean; failures: string[] }
export interface CheckOpts {
  /** The finest precision the connector declares (P5). */
  declared?: Precision;
  /** A second run of the same producer on the same inputs (P6). */
  again?: DiffCase;
}

interface Item {
  /** Where in the file; null on a change with no format row. */
  locator: string | null;
  /** What the kind word says happened. */
  action: "create" | "delete" | "modify";
  /** Sides the data says exist (a row: before/after state present; a change: a box or an "unplaced" note on that side). */
  sides: Record<Side, boolean>;
  /** Pane ids a change is drawn in (boxes), one per box. */
  panes: Array<{ side: Side; id: string }>;
  precision: Precision;
  /** Attribution keys found on the connector's own output. Must stay empty. */
  attributed: string[];
  /** CoCheck's credit for this change; null = missing (never allowed). Rows carry none. */
  credit: Credit | null;
  /** Free text and kind words kept for canonical comparison. */
  kind: string;
  text: string;
}

export interface DiffCase {
  format: string;
  rows: Item[];
  changes: Item[];
  panes: Record<Side, { count: number; texts: string[] }>;
  /** Call ids CoCheck knows for this task. */
  calls: string[];
}

// ---- reading today's shapes -------------------------------------------------------------------------------------------------------

/** Field names a connector row or change must never carry: who made the change is CoCheck's to say. */
const CONNECTOR_SIDE_KEYS = ["call", "calls", "callId", "agent", "agentId", "by", "credit", "credited", "attribution", "writer", "op", "ops", "lane", "actor"];

const keysDeep = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
};
const attributedKeys = (v: unknown): string[] => keysDeep(v).filter((k) => CONNECTOR_SIDE_KEYS.includes(k));

const actionOf = (kind: string, text: string): Item["action"] => {
  const s = /: row (inserted|deleted)$/.exec(text)?.[1];
  const w = s === "inserted" ? "added" : s === "deleted" ? "removed" : kind;
  return /\b(added|inserted|created|new)\b/.test(w) ? "create" : /\b(removed|deleted)\b/.test(w) ? "delete" : "modify";
};
const present = (v: unknown): boolean => v !== null && v !== undefined;

type RowIn = Partial<FormatRow> & Pick<LayerDiffRow, "location" | "kind"> & { before?: unknown; after?: unknown; described?: string };

const rowItem = (r: RowIn): Item => {
  const text = r.text ?? r.described ?? "";
  return { locator: r.location, action: actionOf(r.kind, text), sides: { before: present(r.before), after: present(r.after) }, panes: [], precision: "none", attributed: attributedKeys(r), credit: null, kind: r.kind, text };
};

const precisionOf = (c: ViewChange): Precision => {
  let p = 0;
  for (const b of c.boxes) {
    const x = b.highlights !== undefined && b.highlights.length > 0 ? 4 : b.cell !== undefined ? 3 : b.rect !== undefined ? 2 : 1;
    p = Math.max(p, x);
  }
  return LADDER[p]!;
};

const changeItem = (c: ViewChange, credits: Record<string, Credit>): Item => {
  const sides: Record<Side, boolean> = { before: false, after: false };
  for (const b of c.boxes) sides[b.side] = true;
  for (const s of ["before", "after"] as const) if (c.unplaced?.[s] !== undefined) sides[s] = true;
  return { locator: c.loc, action: "modify", sides, panes: c.boxes.map((b) => ({ side: b.side, id: b.pane })), precision: precisionOf(c), attributed: attributedKeys(c), credit: credits[c.id] ?? null, kind: c.kind, text: (c.lines ?? []).join(" / ") + (c.label ?? "") };
};

interface G2In { format: string; panes: { before: number; after: number }; paneText: { before: string[]; after: string[] }; changes: ViewChange[] | null }

/**
 * Today's shapes to a DiffCase. `layer`: the format layer's rows (`{ rows }`, as the layer returns them); `view`: the renderer's change list with
 * its pane counts and pane text. `credits` is CoCheck's own credit, by change id (see `railCredits`, `creditedTo`); a change without one has none.
 */
export function diffCaseOf(layer: { rows: RowIn[] }, view: G2In, credits: Record<string, Credit> = {}, calls: string[] = []): DiffCase {
  return {
    format: view.format,
    rows: layer.rows.map(rowItem),
    changes: (view.changes ?? []).map((c) => changeItem(c, credits)),
    panes: { before: { count: view.panes.before, texts: [...view.paneText.before] }, after: { count: view.panes.after, texts: [...view.paneText.after] } },
    calls,
  };
}

/** CoCheck's credit read from a rail-model snapshot (the lane of the file's version): "unsure" and "outside" are explicit states; a lane naming an agent is not a call and is refused. */
export function railCredits(rail: unknown, changeIds: string[]): Record<string, Credit> {
  const lane = (rail as { files: Array<{ versions: Array<{ lane: string }> }> }).files[0]?.versions[0]?.lane;
  const credit: Credit | undefined = lane === "unsure" ? { state: "unsure" } : lane === "other" ? { state: "outside" } : undefined;
  if (credit === undefined) throw new Error(`rail lane "${lane}" is not an explicit unsure/outside state: pass a call credit through creditedTo`);
  return Object.fromEntries(changeIds.map((id) => [id, credit]));
}

interface RailStop { lane: string; call?: { id: string }; calls?: Array<{ id: string }>; change?: { key: string; file: string; kind: string; note?: string } }

/**
 * A DiffCase read from a rail-model snapshot alone (a snapshot with no G1/G2 capture). One change per rail stop that carries a change; its credit is CoCheck's lane:
 * an agent lane is a call (the stop's first call id, known to the case), "other" is outside, "unsure" is an explicit unsure (a joint credit, several calls on the unsure lane, stays unsure).
 * `keys` maps a change's key (c2, c3, ...) to its position in `changes`.
 */
export function railCaseOf(rail: unknown): { case: DiffCase; keys: Record<string, number> } {
  const stops = (rail as { stops: RailStop[] }).stops.filter((x) => x.change !== undefined);
  const calls: string[] = [];
  const keys: Record<string, number> = {};
  const changes = stops.map((st, i): Item => {
    let credit: Credit;
    if (st.lane === "unsure") credit = { state: "unsure" };
    else if (st.lane === "other") credit = { state: "outside" };
    else if (st.lane.startsWith("agent:") && st.calls?.[0] !== undefined) { credit = { state: "call", call: st.calls[0].id }; calls.push(st.calls[0].id); }
    else throw new Error(`rail lane "${st.lane}" is not a call, outside or unsure credit`);
    const ch = st.change!;
    keys[ch.key] = i;
    return { locator: ch.file, action: ch.kind === "created" ? "create" : "modify", sides: { before: ch.kind !== "created", after: true }, panes: [], precision: "none", attributed: [], credit, kind: ch.kind, text: ch.note ?? "" };
  });
  return { case: { format: "rail", rows: [], changes, panes: { before: { count: 0, texts: [] }, after: { count: 0, texts: [] } }, calls }, keys };
}

/** The ids of a case's changes in order (for building credits). */
export const changeIdsOf = (view: { changes: ViewChange[] | null }): string[] => (view.changes ?? []).map((c) => c.id);

/** A credit to one call for every change id given. */
export const creditedTo = (call: string, ids: string[]): Record<string, Credit> => Object.fromEntries(ids.map((id) => [id, { state: "call", call } as Credit]));

// ---- helpers -------------------------------------------------------------------------------------------------------------------------

const blank = (s: string): boolean => s.trim().length === 0;
const sidesOf = (c: DiffCase, item: Item): Side[] => {
  // a change drawn nowhere (a child of another change) takes its sides from the row it is
  const row = item.locator === null ? undefined : c.rows.find((r) => r.locator === item.locator);
  const out = new Set<Side>();
  for (const s of ["before", "after"] as const) if (item.sides[s] || (!anySide(item) && row?.sides[s] === true)) out.add(s);
  return [...out];
};
const anySide = (i: Item): boolean => i.sides.before || i.sides.after;

/** Whether a locator names a place inside the before or the after state of this case. */
function findable(c: DiffCase, loc: string): boolean {
  const lines = (side: Side) => c.panes[side].texts;
  const cell = /^(.+)!\$?([A-Z]+)\$?(\d+)$/.exec(loc);
  if (cell !== null) {
    const [, sheet, col, row] = cell as unknown as [string, string, string, string];
    return (["before", "after"] as const).some((s) => lines(s).some((t) => t.startsWith(`${sheet}, `) && t.split(" ; ").some((l) => l.startsWith(`${row}: `) && l.split(" | ").some((x) => x.replace(/^\d+: /, "").startsWith(`${col}=`)))));
  }
  const range = /^(.+)!(\d+):(\d+)$/.exec(loc);
  if (range !== null) {
    const [, sheet, row] = range as unknown as [string, string, string, string];
    return (["before", "after"] as const).some((s) => lines(s).some((t) => t.startsWith(`${sheet}, `) && t.split(" ; ").some((l) => l.startsWith(`${row}: `))));
  }
  const para = /^paragraphs? (\d+)(?:-(\d+))?$/.exec(loc);
  if (para !== null) { const n = Number(para[1]); return n >= 1 && n <= Math.max(c.panes.before.texts.length, c.panes.after.texts.length); }
  const slide = /^Slide (\d+)\b/.exec(loc);
  if (slide !== null) { const n = Number(slide[1]); return n >= 1 && n <= Math.max(c.panes.before.count, c.panes.after.count); }
  return false;
}

/** Whether a pane id (a box's pane) resolves to a pane of this case. */
function paneExists(c: DiffCase, side: Side, id: string): boolean {
  const page = /:page(\d+)$/.exec(id);
  if (page !== null) return Number(page[1]) >= 1 && Number(page[1]) <= c.panes[side].count;
  const named = /^(?:before|after):([^:]+)$/.exec(id);
  if (named !== null) return c.panes[side].texts.some((t) => t.startsWith(`${named[1]}, `));
  return false;
}

const result = (failures: string[]): CheckResult => ({ ok: failures.length === 0, failures });

// ---- the six checks -----------------------------------------------------------------------------------------------------------------

/** P1: every change has a locator findable in its before or after state. */
export function p1LocatorFindable(c: DiffCase): CheckResult {
  const f: string[] = [];
  for (const r of c.rows) if (r.locator === null || !findable(c, r.locator)) f.push(`row locator not findable: ${r.locator}`);
  for (const ch of c.changes) {
    if (ch.locator !== null) { if (!findable(c, ch.locator)) f.push(`change locator not findable: ${ch.locator}`); continue; }
    // no format row: the drawn place is the locator, and it must exist
    if (ch.panes.length === 0 || !ch.panes.every((p) => paneExists(c, p.side, p.id))) f.push(`change with no locator and no resolvable pane (${ch.kind})`);
  }
  if (c.rows.length === 0 && c.changes.length === 0) f.push("no change at all");
  return result(f);
}

/** P2: sides present match the kind: a create has no before, a delete has no after (in the rows, and in where the change is drawn). */
export function p2SidesMatchKind(c: DiffCase): CheckResult {
  const f: string[] = [];
  for (const r of c.rows) {
    if (r.action === "create" && r.sides.before) f.push(`create with a before side: ${r.locator}`);
    if (r.action === "delete" && r.sides.after) f.push(`delete with an after side: ${r.locator}`);
  }
  for (const ch of c.changes) {
    const row = ch.locator === null ? undefined : c.rows.find((r) => r.locator === ch.locator);
    const action = row?.action ?? ch.action;
    if (action === "create" && ch.sides.before) f.push(`create drawn on the before side: ${ch.locator}`);
    if (action === "delete" && ch.sides.after) f.push(`delete drawn on the after side: ${ch.locator}`);
  }
  return result(f);
}

/** P3: each present side renders to a non-empty pane. */
export function p3SidesRenderNonEmpty(c: DiffCase): CheckResult {
  const f: string[] = [];
  const need = new Set<Side>();
  for (const r of c.rows) for (const s of ["before", "after"] as const) if (r.sides[s]) need.add(s);
  for (const ch of c.changes) for (const s of sidesOf(c, ch)) need.add(s);
  for (const s of need) {
    const p = c.panes[s];
    if (p.count < 1 || p.texts.length === 0) f.push(`${s} side present but has no pane`);
    else if (p.texts.some(blank)) f.push(`${s} side has an empty pane`);
  }
  for (const ch of c.changes) for (const pn of ch.panes) if (!paneExists(c, pn.side, pn.id)) f.push(`box names a pane that does not exist: ${pn.id}`);
  return result(f);
}

/** P4: each change ties to one agent call (or an explicit unsure/outside state) filled by CoCheck; the connector's own output carries no attribution. */
export function p4CreditIsCoChecks(c: DiffCase): CheckResult {
  const f: string[] = [];
  for (const it of [...c.rows, ...c.changes]) if (it.attributed.length > 0) f.push(`connector side carries attribution (${it.attributed.join(",")}): ${it.locator}`);
  for (const ch of c.changes) {
    const cr = ch.credit;
    if (cr === null) f.push(`change has no credit (must be a call or an explicit unsure/outside): ${ch.locator ?? ch.kind}`);
    else if (cr.state === "call" && (cr.call.trim() === "" || !c.calls.includes(cr.call))) f.push(`credit names a call CoCheck does not know: "${cr.call}"`);
  }
  return result(f);
}

/** P5: the precision a change claims is never finer than the connector declares. */
export function p5PrecisionWithinDeclared(c: DiffCase, o: CheckOpts = {}): CheckResult {
  const declared = o.declared;
  if (declared === undefined) return result(["no declared precision given"]);
  const f: string[] = [];
  for (const ch of c.changes) if (LADDER.indexOf(ch.precision) > LADDER.indexOf(declared)) f.push(`claims ${ch.precision}, declared ${declared}: ${ch.locator ?? ch.kind}`);
  return result(f);
}

const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v);
const key = (v: unknown): string => JSON.stringify(sorted(v));
/** The case in canonical order: items sorted by their own content, pane ids sorted, keys sorted. */
function canonical(c: DiffCase): string {
  const norm = (i: Item) => ({ ...i, panes: [...i.panes].sort((a, b) => (key(a) < key(b) ? -1 : 1)) });
  const order = (xs: Item[]) => xs.map(norm).sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return key({ ...c, rows: order(c.rows), changes: order(c.changes), calls: [...c.calls].sort() });
}

/** P6: output is deterministic after canonical ordering: a second run equals the first, and reordering the items changes nothing. */
export function p6Deterministic(c: DiffCase, o: CheckOpts = {}): CheckResult {
  const f: string[] = [];
  if (o.again === undefined) f.push("no second run given");
  else if (canonical(c) !== canonical(o.again)) f.push("a second run differs after canonical ordering");
  const shuffled: DiffCase = { ...c, rows: [...c.rows].reverse(), changes: [...c.changes].reverse() };
  if (canonical(c) !== canonical(shuffled)) f.push("canonical form depends on item order");
  return result(f);
}

export const CHECKS: Record<"P1" | "P2" | "P3" | "P4" | "P5" | "P6", (c: DiffCase, o?: CheckOpts) => CheckResult> = {
  P1: p1LocatorFindable, P2: p2SidesMatchKind, P3: p3SidesRenderNonEmpty, P4: p4CreditIsCoChecks, P5: p5PrecisionWithinDeclared, P6: p6Deterministic,
};

/** Every check on one case, `opts` as the checks want it; the failures by name. */
export function runAll(c: DiffCase, o: CheckOpts): Record<string, string[]> {
  return Object.fromEntries(Object.entries(CHECKS).map(([n, fn]) => [n, fn(c, o).failures]));
}

// ---- planting bad input (the negative cases) ----------------------------------------------------------------------------------------

const copy = (c: DiffCase): DiffCase => structuredClone(c);

/** Each plant returns a copy of the case with one property broken, so a test can show its check goes red. */
export const plant = {
  /** P1: a locator that names nothing in either state. */
  unfindableLocator(c: DiffCase): DiffCase {
    const d = copy(c);
    const bad = "Nowhere!ZZ9999";
    if (d.rows[0] !== undefined) d.rows[0].locator = bad;
    if (d.changes[0] !== undefined) d.changes[0].locator = bad;
    return d;
  },
  /** P1: the first row and change point at a place past the end of the file (a paragraph, a slide, a cell in an absent row). */
  locatorAt(c: DiffCase, loc: string): DiffCase {
    const d = copy(c);
    if (d.rows[0] !== undefined) d.rows[0].locator = loc;
    if (d.changes[0] !== undefined) d.changes[0].locator = loc;
    return d;
  },
  /** P2: a create whose change is drawn with a before box (a row says create, the change is drawn on both sides). */
  createDrawnBefore(c: DiffCase): DiffCase {
    const d = copy(c);
    const ch = d.changes.find((x) => x.locator !== null)!;
    d.rows.unshift({ locator: ch.locator, action: "create", sides: { before: false, after: true }, panes: [], precision: "none", attributed: [], credit: null, kind: "added", text: "" });
    ch.sides = { before: true, after: true };
    return d;
  },
  /** P2: a delete whose change is drawn with an after box. */
  deleteDrawnAfter(c: DiffCase): DiffCase {
    const d = copy(c);
    const ch = d.changes.find((x) => x.locator !== null)!;
    d.rows.unshift({ locator: ch.locator, action: "delete", sides: { before: true, after: false }, panes: [], precision: "none", attributed: [], credit: null, kind: "removed", text: "" });
    ch.sides = { before: true, after: true };
    return d;
  },
  /** P2: a create that still has a before side, and a delete that still has an after side. */
  createWithBefore(c: DiffCase): DiffCase {
    const d = copy(c);
    d.rows.push({ locator: d.rows[0]?.locator ?? "paragraph 1", action: "create", sides: { before: true, after: true }, panes: [], precision: "none", attributed: [], credit: null, kind: "added", text: "" });
    return d;
  },
  deleteWithAfter(c: DiffCase): DiffCase {
    const d = copy(c);
    d.rows.push({ locator: d.rows[0]?.locator ?? "paragraph 1", action: "delete", sides: { before: true, after: true }, panes: [], precision: "none", attributed: [], credit: null, kind: "removed", text: "" });
    return d;
  },
  /** P3: every pane on a present side drawn with nothing in it. */
  emptyPane(c: DiffCase): DiffCase {
    const d = copy(c);
    for (const s of ["before", "after"] as const) d.panes[s].texts = d.panes[s].texts.map(() => "   ");
    return d;
  },
  /** P3: a present side with no pane at all. */
  noPane(c: DiffCase): DiffCase {
    const d = copy(c);
    for (const s of ["before", "after"] as const) d.panes[s] = { count: 0, texts: [] };
    return d;
  },
  /** P4: the connector's own output says who wrote the change. */
  connectorAttribution(c: DiffCase): DiffCase {
    const d = copy(c);
    (d.changes[0] ?? d.rows[0]!).attributed.push("by");
    return d;
  },
  /** P4: a change nobody credited, not even as unsure. */
  missingCredit(c: DiffCase): DiffCase {
    const d = copy(c);
    if (d.changes[0] !== undefined) d.changes[0].credit = null;
    return d;
  },
  /** P4: a credit to a call CoCheck never saw. */
  unknownCall(c: DiffCase): DiffCase {
    const d = copy(c);
    if (d.changes[0] !== undefined) d.changes[0].credit = { state: "call", call: "no-such-call" };
    return d;
  },
  /** P6: a second run whose output moved (a clock, a random id, an unstable order of content). */
  nondeterministic(c: DiffCase): DiffCase {
    const d = copy(c);
    const it = d.changes[0] ?? d.rows[0]!;
    it.text += " #" + 7;
    return d;
  },
};
