// The diff object: the one shape a diff takes between a producer (a built-in format layer or a connector) and the rail, plus a lossless shim from
// today's FormatChanges rows and View change list. Nothing here is wired in: load.ts, rail/* and render/* do not import it yet.
//
// Structural rule: the public part of a DiffChange is what checkDiffAnswer accepts (anchors, kind, confidence, before, after, note). Anything that
// shape cannot carry rides in `builtin`, so format-only fields never leak into the public shape and fromDiffObject can rebuild today's data exactly.
// The row and the view entry of one change live in the same DiffChange; toDiffObject is the only place the two separate inputs meet.

import type { FormatChanges, FormatRow } from "../timeline/timeline.ts";
import type { View, ViewChange } from "../timeline/render/types.ts";

export type Confidence = "exact" | "derived" | "opaque";
export type Payload = { type: "text" | "html"; value: string } | { type: "json"; value: unknown } | { type: "image"; value: unknown };
export interface Anchor { path?: string; entity?: string; range?: { start: number; end: number }; label?: string }

export interface DiffChange {
  anchors: Anchor[];
  kind: string;
  confidence: Confidence;
  before?: Payload | null;
  after?: Payload | null;
  note?: string | { text: string; [k: string]: unknown };
  /** CoCheck only: what the public shape cannot express. A connector never sets it. */
  builtin?: { row?: FormatRow; view?: ViewChange };
}

/** CoCheck-only parts of the whole object: the rest of FormatChanges and View, and the order of the view's change list. */
export interface DiffBuiltin {
  /** Everything on the rows form of FormatChanges except `rows` and `more` (module, moreIn, identicalParts). Absent for `unavailable`. */
  rest?: Record<string, unknown>;
  /** The View without `changes` and `caveats`; null when no view was given. */
  view: Record<string, unknown> | null;
  /** The view's `changes` is a list (false: the key was absent). */
  viewHasChanges: boolean;
  /** For each entry of the view's change list in its own order, the index of the DiffChange that holds it. */
  viewOrder: number[];
}

export interface DiffObject {
  spec: "cocheck.diff/1";
  subject: string;
  connector: string;
  producer: "builtin" | "connector";
  before: { ref: string | null };
  after: { ref: string | null };
  changes: DiffChange[];
  caveats: string[];
  unavailable?: string;
  /** The change list is still being read by the review process (with `unavailable` saying so); the page asks again. */
  pending?: true;
  /** The review process could not read the change list; `unavailable` is CoCheck's own wording of why, `caveats` may hold what the connector said. */
  failed?: true;
  /** The hook recorded the row with no connector; this list was read later than the step, with the built-in that claims the file now. */
  readLater?: true;
  /** How the page's cocheck.changes/1 document for this connector row is made. "frozen": the document sealed at capture (`ref`); "export": CoCheck draws the stored before and after text of an export connector; "export-text": the same for a file row, with the exported texts held in the frozen record. Absent: no document was kept for the row, and the page says so. */
  served?: { kind: "frozen"; ref: string; level: 1 | 2 | 3 } | { kind: "export" } | { kind: "export-text"; before: string | null; after: string | null };
  more?: number;
  /** Migration X1: the issues of a frozen cocheck.changes/1 document, from every level (spec v1.2), in document order; absent when it has none. */
  issues?: Array<{ text: string; side?: string; where?: string }>;
  /** A frozen document that vouches nothing changed, as the page reads it (view-table.js coverageLine): "changed" for its NOTHING_CHANGED line, "visible" for NOTHING_VISIBLE. The step's note says the same. */
  nothing?: "changed" | "visible";
  builtin?: DiffBuiltin;
}

const clone = <T>(v: T): T => structuredClone(v);

function payload(v: unknown): Payload | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === "string" ? { type: "text", value: v } : { type: "json", value: clone(v) };
}

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.length > 0;

function anchorOf(row: FormatRow | undefined, view: ViewChange | undefined): Anchor {
  const label = nonEmpty(row?.location) ? row.location : nonEmpty(view?.label) ? view.label : nonEmpty(view?.loc) ? view.loc : (view?.id ?? "change");
  const cell = view?.boxes.find((b) => nonEmpty(b.cell))?.cell;
  const entity = nonEmpty(cell) ? cell : undefined;
  return entity === undefined ? { label } : { label, entity };
}

export function toDiffObject(subject: string, connector: string, changes: FormatChanges, view?: View | null): DiffObject {
  const rows: FormatRow[] = "rows" in changes ? changes.rows : [];
  const viewChanges: ViewChange[] = view?.changes ?? [];
  const out: DiffChange[] = [];
  const holder: number[] = new Array<number>(viewChanges.length).fill(-1);
  // each row takes the first view entry still unclaimed that names its location; the pair then lives in one DiffChange
  for (const r of rows) {
    const vi = viewChanges.findIndex((v, i) => holder[i] === -1 && v.loc === r.location);
    const v = vi === -1 ? undefined : viewChanges[vi];
    if (vi !== -1) holder[vi] = out.length;
    const c: DiffChange = { anchors: [anchorOf(r, v)], kind: r.kind, confidence: "exact" };
    const b = payload(r.before), a = payload(r.after);
    if (b !== undefined) c.before = b;
    if (a !== undefined) c.after = a;
    const note = nonEmpty(r.note?.text) ? r.note.text : nonEmpty(r.text) ? r.text : undefined;
    if (note !== undefined) c.note = note;
    c.builtin = v === undefined ? { row: clone(r) } : { row: clone(r), view: clone(v) };
    out.push(c);
  }
  // a view entry with no row is its own DiffChange
  viewChanges.forEach((v, i) => {
    if (holder[i] !== -1) return;
    holder[i] = out.length;
    out.push({ anchors: [anchorOf(undefined, v)], kind: v.kind, confidence: "derived", before: null, after: null, note: nonEmpty(v.label) ? v.label : undefined, builtin: { view: clone(v) } });
  });
  for (const c of out) if (c.note === undefined) delete c.note;

  const d: DiffObject = { spec: "cocheck.diff/1", subject, connector, producer: "builtin", before: { ref: null }, after: { ref: null }, changes: out, caveats: clone(view?.caveats ?? []) };
  const builtin: DiffBuiltin = { view: null, viewHasChanges: view?.changes !== undefined, viewOrder: holder };
  if ("unavailable" in changes) d.unavailable = changes.unavailable;
  else {
    const { rows: _r, more, ...rest } = changes;
    d.more = more;
    builtin.rest = clone(rest);
  }
  if (view !== undefined && view !== null) {
    const { changes: _c, caveats: _k, ...others } = view;
    builtin.view = clone(others) as Record<string, unknown>;
  }
  d.builtin = builtin;
  return d;
}

export function fromDiffObject(d: DiffObject): { changes: FormatChanges; view: View | null } {
  const b = d.builtin;
  const rows = d.changes.flatMap((c) => (c.builtin?.row === undefined ? [] : [clone(c.builtin.row)]));
  const changes = (d.unavailable !== undefined ? { unavailable: d.unavailable } : { ...clone(b?.rest ?? { module: d.connector }), rows, more: d.more ?? 0 }) as FormatChanges;
  if (b === undefined || b.view === null) return { changes, view: null };
  const view = { ...clone(b.view), caveats: clone(d.caveats) } as unknown as View;
  if (b.viewHasChanges) view.changes = b.viewOrder.map((i) => clone(d.changes[i]!.builtin!.view!));
  return { changes, view };
}
