import type { GenericPart } from "../page.ts";

/**
 * The renderer contract (written first in docs/timeline.md "Renderers and the view route"). A renderer draws one change of one
 * file as a `View`. Boxes come from the data change; a pixel diff is only a cross-check. Confidence `none` never carries a box.
 */

/** One edge of a grid cell's border: its line style and colour. */
export interface Edge {
  style: string;
  /** RRGGBB, or null when the file says nothing (drawn in the automatic colour, black). */
  color: string | null;
}

/**
 * How a grid cell looks, resolved to values (colours as RRGGBB, never an index): font, fill, borders, alignment. The grid draws it.
 */
export interface Look {
  font: {
    name: string;
    /** Points. */
    size: number;
    bold: boolean;
    italic: boolean;
    underline: "single" | "double" | null;
    strike: boolean;
    /** RRGGBB; null is the automatic colour (black). */
    color: string | null;
  };
  /** A solid fill as RRGGBB. */
  fill: string | null;
  /** A patterned or gradient fill, by its identity. Not drawn. */
  pattern: string | null;
  border: { left: Edge | null; right: Edge | null; top: Edge | null; bottom: Edge | null };
  align: { h: string | null; v: string | null; wrap: boolean; indent: number };
}

export type Confidence = "exact" | "text-match" | "pixel" | "none";

export interface Cell {
  ref: string;
  text: string;
  value: string | number | boolean | null;
  formula: string | null;
  numFmt: string;
  /** Set only when the cell's number format could not be rendered exactly: `text` is then the stored value, marked "shown unformatted" on screen. */
  unformatted?: true;
  fill: string | null;
  bold: boolean;
  /** How the cell looks in the file: font, fill, borders, alignment, all resolved to values. The grid draws it. */
  look: Look;
  /** RRGGBB the number format gives the text (`[Red]`); it wins over the font colour. */
  color?: string;
  /** "formula" on a formula cell the file stores no value for: `text` is the formula, and the page greys it. */
  calc?: "formula";
}

export type GridRow = { gap: true } | { row: number; hidden: boolean; cells: Record<string, Cell> };

export interface GridPane {
  sheet: string;
  state: "visible" | "hidden" | "veryHidden";
  columns: Array<{ name: string; width: number | null; hidden: boolean }>;
  rows: GridRow[];
  merges: string[];
  /** Changed rows that are not drawn because the window is full. Their boxes are still listed. */
  moreRows: number;
  /** Set on a pane that holds the sheet's whole used range (up to the renderer's cap), not a window around the changes: `rows` then lists only the populated rows in order, with no gap rows, and `columns` runs from A to the last drawn column. The page draws such a pane as a live, scrollable, virtualised grid. */
  full?: true;
  /** With `full`: the number of the last row drawn (the sheet's last populated row, or the row cap). The page sizes its scroll area from it; rows not listed in `rows` are empty. */
  lastRow?: number;
  /** On a sheet with charts and no cells, its charts: the id and label of each chart's picture pane, so the page can link to them. */
  charts?: Array<{ pane: string; label: string }>;
}

/**
 * One row of a text pane. A modified file is drawn aligned: both panes hold the same rows, so row k on the left and row k on the
 * right are the same place in the file. `kind` marks a changed line ("edit" on both sides, "del" only before, "add" only after; absent for an
 * unchanged line), `marks` are [start, end) character ranges of the words that differ inside an edited line, `filler` is the empty row opposite
 * an added or removed line, and a `gap` that carries `hidden` stands for that many unchanged lines.
 */
export type TextLine = { n: number; text: string; kind?: "add" | "del" | "edit"; marks?: [number, number][] } | { filler: true } | { gap: true; hidden?: number };

export interface TextPane {
  lines: TextLine[];
}

/** A pane with no `grid`, `text` or `picture` is an empty side: its `label` says why ("There was nothing here yet"). */
export interface Pane {
  id: string;
  label: string;
  grid?: GridPane;
  /** Numbered lines of a text file, cropped to the changed lines plus or minus two with gap markers (text renderer). */
  text?: TextPane;
  /** `page`, when set, is a 1-based page of a PDF state: the picture is served at `/timeline/<task>/pdfpage/<sha>/<page>`, not `/preview/<sha>`. */
  picture?: { sha: string; width: number; height: number; page?: number };
  /** One plain sentence drawn under the picture. */
  note?: string;
  /** A paged view: a stand-in for a page the other side has and this side does not ("No page 3 on this side"). No picture. */
  absent?: true;
  /** A page whose pictures were compared and match (status P=): listed so the pages can be scrolled in order, with no box. */
  unchanged?: true;
  /** A page whose text is unchanged but whose page breaks moved (status R): its picture is not compared with its row partner, so nothing pixel-based (the pixel net) boxes it. */
  reflowed?: true;
}

export interface Box {
  side: "before" | "after";
  pane: string;
  cell?: string;
  /** 1-based line number in the pane's `text`. */
  line?: number;
  rect?: { x: number; y: number; w: number; h: number };
  /** The words of the matched line, on a `text-match` box of a PDF, so a card can find the box of its own paragraph. */
  text?: string;
  change: string;
  confidence: Confidence;
}

/**
 * One change as the change-first page draws it (feat/change-first-views contract, shared by every producer and the page).
 * One box per change per side (a change that crosses a page break gets one box per page); no line boxes, no group outlines.
 * Every change is boxed on each side where it exists, or says why not in `unplaced` ("not marked"): a change is never dropped silently.
 */
export interface ChangeBox {
  side: "before" | "after";
  /** A pane id of this view: "after:page3", "before:Summary", "after:chart:1". */
  pane: string;
  /** Picture pixels of that pane (PDF points x 2, origin top-left), unpadded: the page pads when it draws. Clipped to the picture. */
  rect?: { x: number; y: number; w: number; h: number };
  /** A cell or range ("B3", "B3:D7") of a grid pane; the box sits on the cell edge. */
  cell?: string;
  /** The changed words inside `rect`, same pixels; empty or absent when none (a moved object has none). */
  highlights?: Array<{ x: number; y: number; w: number; h: number }>;
}

export interface ViewChange {
  /** Stable within this view, in reading order ("k1", "k2", ...): the page steps through changes in this order. */
  id: string;
  /** Exactly the `location` of the format-layer row this change is ("line 7", "row 5, column 3", "paragraphs 4-7"); the page takes the comment from the card or row note with this location, so comment text always comes through the model's own card path. */
  loc: string | null;
  kind: "paragraph" | "table-cell" | "table-row" | "shape" | "picture" | "chart" | "cell" | "moved" | "recolour" | "notes";
  /** A child names its parent (containment in the file); a child gets a box only when it sits outside its parent's box. */
  parent: string | null;
  boxes: ChangeBox[];
  /** Set iff the change exists on that side but has no box there: plain structural words ("not marked", "the whole page changed colour"), never document text. */
  unplaced?: { before?: string; after?: string };
  /** Consequences stated on this change's comment, never boxed ("Items below renumbered 2 to 1, 3 to 2", "7 formula cells recalculated"). Structural words and numbers only. */
  lines?: string[];
  /** The comment when no card or row note has `loc`: structural words only ("Something changed on page 3"). */
  label?: string;
}

export interface View {
  change: string;
  file: string;
  /** Who drew it, named on screen. */
  engine: string;
  kind: "grid" | "pages" | "card";
  before: Pane[];
  after: Pane[];
  boxes: Box[];
  /** Change-first boxes (feat/change-first-views). Absent from a producer that has not moved yet: the page then builds one box per card from `boxes`. */
  changes?: ViewChange[];
  caveats: string[];
  /** Set when both states draw identically: the page prints this above the pictures ("No visible difference" and one sentence of what changed). */
  banner?: { title: string; text: string };
  /** A picture for this change is still being drawn: the page asks again, with a bounded backoff, until this is absent. */
  pending?: true;
}

/** What the timeline body holds for the change being drawn. */
export interface ChangeInfo {
  id: string;
  file: string;
  kind: "created" | "modified" | "deleted";
  generic?: GenericPart;
  /** Sentences from the caller about a state it could not supply (bytes no longer in the store); a renderer prints them as caveats. */
  missing?: string[];
  /** Set by a renderer that draws only the readable side of a modified file; `side` is the one that could not be opened. */
  unreadable?: { side: "before" | "after"; sentence: string };
  /** Draw the whole of this one state (every page, every sheet), not the change: the Now and Before task positions of the Files view. */
  whole?: "before" | "after";
  /** One plain sentence of what changed in the file, from the change's format rows; the banner of two identical-looking states says it. */
  changeSentence?: string;
  /** Aborted when the requester went away; a renderer passes it to anything queued so abandoned work never starts. */
  signal?: AbortSignal;
}

export interface FormatRenderer {
  name: string;
  /** Lower-case, with the dot: ".csv". */
  extensions: string[];
  /** True when this renderer has a whole-file view (`ChangeInfo.whole`): it draws pages or lines, or is the card for a claimed type. The review server asks this, never the ending. */
  wholeView?: true;
  view(before: Buffer | null, after: Buffer | null, change: ChangeInfo): View | Promise<View>;
}
