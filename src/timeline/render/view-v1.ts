// the one adapter from a renderer's View (src/timeline/render/types.ts) to a cocheck.changes/1 level-3 document, at the serve boundary
// (src/review-server.ts handleView). The page reads only the document. Envelope allow-list, exactly: engine, file, kind, pending, banner, caveats
// (plus the document's own spec, changes, pictures, and `source`, which carries the level). Product-only data (grids, text panes and the page's
// own drawing hints) lives only in `private`: pictures[].private and changes[].private. The words of a change come from the model's own row notes
// (the path that already scrubs paths and secrets) or the View change's label, never from other View text. No `system`, no document `level`, no `box.side` (a box's side is its picture's).
import { checkChanges, CHANGES_SPEC } from "../../connector/changes-v1.ts";
import type { Box, ChangeBox, Pane, View, ViewChange } from "./types.ts";

export interface CardWords {
  /** The model's row notes of the change. */
  rowNotes: Array<{ location: string; text: string }>;
}

type Side = "before" | "after";
interface V1Box { picture: string; rect?: unknown; highlights?: unknown; cell?: string; lines?: { from: number; to: number } }
interface V1Change { id: string; mark: string; label: string; before?: string; after?: string; text?: string; private?: { kind: string }; parent?: string | null; lines?: string[]; boxes?: V1Box[]; unplaced?: { before?: string; after?: string } }
interface V1Picture { id: string; side: Side; type: string; src?: string; label?: string; width?: number; height?: number; note?: string; absent?: boolean; unchanged?: boolean; reflowed?: boolean; changed?: boolean; private?: Record<string, unknown> }
/** who drew the picture the page shows. "connector": the named connector sent it. "cocheck": CoCheck drew it (Office, or an export connector's text); `name` is the connector id for an export, else "CoCheck". */
export interface V1Source { by: "connector" | "cocheck"; name: string; level: 1 | 2 | 3; /** set at capture when the connector's hello opted into the nothing-changed rule */ nothingChanged?: true }
/** `level` is never written (the level is the connector's, in `source`); the optional field is here only so a reader of a stored v1 document (src/connector/row-doc.ts) still compiles until it stops reading it. */
export interface V1Doc { spec: string; level?: number; source?: V1Source; changes: V1Change[]; pictures: V1Picture[]; caveats: string[]; engine: string; file: string; kind: string; pending?: true; banner?: { title: string; text: string } }

const SHA = /^[0-9a-f]{64}$/;
const CELL = /^[A-Za-z]{1,3}[1-9]\d*(?::[A-Za-z]{1,3}[1-9]\d*)?$/;
const NOT_MARKED = "not marked";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const rectOk = (r: unknown): r is { x: number; y: number; w: number; h: number } => typeof r === "object" && r !== null && num((r as { x: unknown }).x) && num((r as { y: unknown }).y) && num((r as { w: unknown }).w) && num((r as { h: unknown }).h);
const paneKey = (id: string): string => id.replace(/^(before|after):/, "");

// ---- pictures --------------------------------------------------------------------------------------------------------------------------

/** A pane id is unique per side; a picture id is unique per document, so an id both sides use is prefixed with its side. `idOf` maps (side, pane id) to the picture id. */
function picturesOf(view: View, idOf: Map<string, string>): V1Picture[] {
  // every pane any change or box points at, drawn or not: the page marks its tab changed from this, never from the drawn boxes only
  const changedPanes = new Set<string>([...view.boxes.map((b) => `${b.side}\u0000${b.pane}`), ...(view.changes ?? []).flatMap((c) => (c.boxes ?? []).map((b) => `${b.side}\u0000${b.pane}`))]);
  const out: V1Picture[] = [];
  const both = new Set(view.before.map((p) => p.id).filter((id) => view.after.some((q) => q.id === id)));
  for (const side of ["before", "after"] as const) {
    for (const p of view[side]) {
      const id = both.has(p.id) ? `${side}:${p.id}` : p.id;
      idOf.set(`${side}\u0000${p.id}`, id);
      const pic: V1Picture = { id, side, type: "html", label: p.label };
      if (p.grid) Object.assign(pic, { type: "grid", private: { grid: p.grid } });
      else if (p.text) Object.assign(pic, { type: "text", private: { text: p.text } });
      else if (p.picture && SHA.test(p.picture.sha) && p.picture.width > 0 && p.picture.height > 0) {
        const n = p.picture.page;
        Object.assign(pic, { type: "image", src: n !== undefined ? `pdfpage/${p.picture.sha}/${n}` : `preview/${p.picture.sha}`, width: p.picture.width, height: p.picture.height });
      }
      if (p.note !== undefined && p.note !== "") pic.note = p.note;
      for (const k of ["absent", "unchanged", "reflowed"] as const) if (p[k] === true) pic[k] = true;
      if (changedPanes.has(`${side}\u0000${p.id}`)) pic.changed = true;
      out.push(pic);
    }
  }
  return out;
}

// ---- boxes -----------------------------------------------------------------------------------------------------------------------------

interface Anchor { rect?: ChangeBox["rect"]; highlights?: ChangeBox["highlights"]; cell?: string; line?: number }

function anchorOf(byId: Map<string, V1Picture>, idOf: Map<string, string>, side: Side, rawPane: string, a: Anchor): V1Box | null {
  const paneId = idOf.get(`${side}\u0000${rawPane}`) ?? rawPane;
  if (a.rect === undefined && a.cell === undefined && a.line === undefined && a.highlights === undefined) return null;
  const pic = byId.get(paneId);
  if (pic === undefined || pic.side !== side) return null;
  if (pic.type === "image") {
    if (!rectOk(a.rect)) return null;
    const hl = a.highlights !== undefined && a.highlights.length > 0 && a.highlights.every(rectOk) ? { highlights: a.highlights } : {};
    return { picture: pic.id, rect: a.rect, ...hl };
  }
  if (pic.type === "grid") return a.cell !== undefined && CELL.test(a.cell) ? { picture: pic.id, cell: a.cell } : null;
  if (pic.type === "text") return a.line !== undefined && Number.isInteger(a.line) && a.line >= 1 ? { picture: pic.id, lines: { from: a.line, to: a.line } } : null;
  return null;
}

// ---- words -----------------------------------------------------------------------------------------------------------------------------

type Words = Pick<V1Change, "label" | "mark" | "before" | "after" | "text">;

function wordsFor(vc: Pick<ViewChange, "loc" | "label">, w: CardWords): Words {
  const note = vc.loc === null ? undefined : w.rowNotes.find((r) => r.location === vc.loc);
  if (note !== undefined) return { label: vc.loc!, mark: "changed", text: String(note.text) };
  return { label: "Change", mark: "described", text: vc.label !== undefined && vc.label !== "" ? vc.label : "Changed" };
}

// There is no card path for a producer with no change list: no core row carries a card.

// ---- the adapter -----------------------------------------------------------------------------------------------------------------------

export function viewToV1(view: View, words: CardWords): V1Doc {
  const idOf = new Map<string, string>();
  const pictures = picturesOf(view, idOf);
  const byId = new Map(pictures.map((p) => [p.id, p]));
  const sideOf = (b: V1Box): Side => byId.get(b.picture)!.side;
  const live = view.boxes.filter((b) => b.confidence !== "none");
  const changes: V1Change[] = [];
  const place = (side: Side, paneId: string, a: Anchor, boxes: V1Box[], unplaced: { before?: string; after?: string }): void => {
    const b = anchorOf(byId, idOf, side, paneId, a);
    if (b !== null) boxes.push(b); else unplaced[side] ??= NOT_MARKED;
  };

  if (view.changes !== undefined) {
    const ids = new Set(view.changes.map((c) => c.id));
    for (const vc of view.changes) {
      const boxes: V1Box[] = [], unplaced: { before?: string; after?: string } = { ...vc.unplaced };
      for (const b of vc.boxes ?? []) {
        const a = anchorOf(byId, idOf, b.side, b.pane, { rect: b.rect, highlights: b.highlights, cell: b.cell });
        if (a !== null) boxes.push(a); else if (!boxes.some((x) => sideOf(x) === b.side)) unplaced[b.side] ??= NOT_MARKED;
      }
      // a side that lost every box says so; a side that kept one is drawn
      for (const s of ["before", "after"] as const) if (boxes.some((x) => sideOf(x) === s) && unplaced[s] === NOT_MARKED && !vc.unplaced?.[s]) delete unplaced[s];
      const lines = (vc.lines ?? []).filter((l) => typeof l === "string");
      changes.push({ id: vc.id, ...wordsFor(vc, words), ...(vc.kind !== undefined && vc.kind !== null ? { private: { kind: vc.kind } } : {}), parent: vc.parent !== null && ids.has(vc.parent) && vc.parent !== vc.id ? vc.parent : null, ...(lines.length > 0 ? { lines } : {}), boxes, ...(Object.keys(unplaced).length > 0 ? { unplaced } : {}) });
    }
  } else {
    // bare marks: a cell box is a change of its own (its row note is its words), every other box a region with no card
    const cells = new Map<string, V1Change>();
    let n = 0;
    for (const b of live) {
      const a: Anchor = { rect: b.rect, cell: b.cell, line: b.line };
      if (b.cell !== undefined) {
        const key = `${paneKey(b.pane)}\u0000${b.cell}`;
        let ch = cells.get(key);
        if (ch === undefined) {
          const note = words.rowNotes.find((r) => r.location.slice(r.location.lastIndexOf("!") + 1) === b.cell);
          ch = { id: `r${++n}`, mark: "changed", label: note?.location ?? b.cell, ...(note ? { text: String(note.text) } : { text: "Changed" }), private: { kind: "cell" }, parent: null, boxes: [] };
          cells.set(key, ch); changes.push(ch);
        }
        place(b.side, b.pane, a, ch.boxes!, (ch.unplaced ??= {}));
        continue;
      }
      const ch: V1Change = { id: `r${++n}`, mark: "described", label: b.line !== undefined ? `Line ${b.line}` : "A marked region", private: { kind: "region" }, parent: null, boxes: [] };
      place(b.side, b.pane, a, ch.boxes!, (ch.unplaced ??= {}));
      changes.push(ch);
    }
    for (const c of changes) if (c.unplaced !== undefined && Object.keys(c.unplaced).length === 0) delete c.unplaced;
  }

  const doc: V1Doc = { spec: CHANGES_SPEC, source: { by: "cocheck", name: "CoCheck", level: 3 }, changes, pictures, caveats: view.caveats, engine: view.engine, file: view.file, kind: view.kind, ...(view.pending === true ? { pending: true as const } : {}), ...(view.banner !== undefined ? { banner: view.banner } : {}) };
  if (checkChanges(doc, 3).length === 0) return doc;
  // A document the check refuses is never served as it is: the changes stay as a list with their words, the pictures and boxes go, and the caveats say so.
  const { pictures: _p, ...rest } = doc;
  return { ...rest, source: { by: "cocheck", name: "CoCheck", level: 1 }, changes: changes.map(({ boxes: _b, unplaced: _u, ...c }) => c), caveats: [...view.caveats, "Part of this view could not be drawn, so the changes are listed without pictures."] } as unknown as V1Doc;
}

export type { Pane };
