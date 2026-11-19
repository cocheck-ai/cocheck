// One plain sentence per change: what happened, in words a reader of the margin can take in at a glance. Pure, rule-based, no model.
//
// A note must never state a number or a quoted string the record for that change lacks. So every value in
// a note is a string the record already holds (a generic layer's displayed before and after, a connector's label, words and text, a file
// name), copied as is, with no tidying. So every digit run and every value in a note is a literal substring of the record for that change.
// A secret file's note is exactly `secretLine`; a task whose values expired gets a note with no values.
//
// this is the generic engine only. No file format's grammar lives here: a connector's step is worded from its own document
// (`ChangeFacts.connector`), and core's own rows (text, csv, a whole-file row) are worded from the generic layer's location and values.

import { pathKit } from "../paths.ts";
import { knownHostLabel } from "../hosts/index.ts";
import { secretLine } from "../secret-files.ts";
import { couldNotOpen } from "./broken.ts";

export interface Note {
  text: string;
  /** Always `rule`: no model wrote it. */
  source: "rule";
}

export interface NoteInput {
  /** Who made the change, as a name a sentence can start with: `by.actor` (`attribution.ts`). */
  actor: string;
  /** The file, as the timeline shows it (relative to the watched folder when inside it). */
  file: string;
  /** Where in the file, in the layer's own words (`row 5, column 3`, `line 7`); `file` for the whole file; null when unknown. */
  location?: string | null;
  /**
   * The row's kind, or a whole-file kind of the change: `created`, `deleted`, `text`, `picture` (a picture file whose two pictures were compared),
   * `compared` (any other file with a picture of both sides), `plain`, `nothing-changed` and `nothing-visible` (a connector's document vouched
   * for it), `fingerprint`. Any other word reads as a row inside the file.
   */
  kind: string;
  /** The displayed before and after of a row, exactly as the layer shows them. */
  before?: string | null;
  after?: string | null;
  /** The layer's own words for the row. */
  text?: string | null;
  /** For `text`: whether lines were added, removed, or both. */
  lines?: { added: boolean; removed: boolean } | null;
  /** For `created`: what the new file holds, in the connector's own words, stated after " with ". */
  holds?: string | null;
  /** The task's values expired: no value may be stated. */
  expired?: boolean;
  /** A secret file: the note is `secretLine` and nothing else. */
  secret?: boolean;
}

// ---- who ----

/** The name for a host recorded on a call. No host, no name: "Someone" (a call is credited, its host is not one name). */
export function actorName(host: string | null | undefined): string {
  if (!host) return "Someone";
  const h = host.trim().toLowerCase();
  return knownHostLabel(h) ?? host.trim().replace(/^./, (c) => c.toUpperCase());
}

// ---- words ----

const MAX_VALUE = 60;
const EMPTY = "(empty)";

const isEmpty = (v: string | null | undefined): boolean => v === null || v === undefined || v === EMPTY || v === "";

const sentence = (text: string): Note => ({ text, source: "rule" });

/** A value can be stated when it is short enough to be whole; a long one is left out rather than cut. */
const stateable = (v: string): boolean => v.length <= MAX_VALUE && v !== "[object Object]";

function folderOf(rel: string): string | null {
  const dir = dirOf(rel);
  return dir ? (dir.split("/").at(-1) ?? null) : null;
}
const baseOf = (rel: string): string => pathKit().baseName(rel);
const dirOf = (rel: string): string => {
  const c = pathKit().canon(rel);
  return c.lastIndexOf("/") < 0 ? "" : c.slice(0, c.lastIndexOf("/"));
};

const quoted = (name: string): string => `'${name.replace(/'/g, "''")}'`;
/** "'A'", "'A' and 'B'", "'A', 'B' and 'C'"; with `more`, "'A', 'B' and other places". */
function joinWords(items: string[], more = false): string {
  const tail = more ? " and other places" : "";
  if (items.length <= 1) return items.join("") + tail;
  return more ? items.join(", ") + tail : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The sentence of a file-level shape, or null when the shape is a row inside the file. */
function fileNote(i: NoteInput): Note | null {
  const { actor, file } = i;
  switch (i.kind) {
    // "new file" and "file deleted" are the format layers' own words for a file made or removed; they read like the change itself.
    case "new file":
    case "created": {
      const dir = folderOf(file);
      const base = dir ? `${actor} created ${baseOf(file)} in the ${dir} folder` : `${actor} created ${file}`;
      // What the connector listed for the new file, in its own words (the rail keeps the part after " with ").
      return sentence(i.holds && !i.expired ? `${base} with ${i.holds}` : base);
    }
    case "file deleted":
    case "deleted":
      return sentence(`${actor} deleted ${file}`);
    case "text": {
      const l = i.lines;
      if (l?.added && !l.removed) return sentence(`${actor} added lines to ${file}`);
      if (l?.removed && !l.added) return sentence(`${actor} removed lines from ${file}`);
      return sentence(`${actor} edited lines in ${file}`);
    }
    case "picture":
      return sentence(`${actor} changed the picture ${file}`);
    case "compared":
      return sentence(`${actor} changed ${file} (CoCheck has a picture of both versions, not a reading of the file)`);
    case "plain":
      return sentence(`${actor} changed ${file}`);
    // A connector's document vouched that nothing changed (the page's own lines: view-table.js NOTHING_CHANGED and NOTHING_VISIBLE).
    case "nothing-changed":
      return sentence(`${actor} saved ${file} again: nothing changed.`);
    case "nothing-visible":
      return sentence(`${actor} saved ${file} again: nothing visible changed.`);
    case "fingerprint":
      return sentence(`${actor} changed ${file} (the file changed; CoCheck can't read inside it)`);
    default:
      return null;
  }
}

/** The one sentence for one change. */
export function noteOf(i: NoteInput): Note {
  if (i.secret) return sentence(secretLine(i.file));
  const { actor } = i;
  const whole = fileNote(i);
  if (whole) return whole;
  const loc = i.location ?? "";
  // A task whose values expired, or a row about the whole file: where, never what. Every other place is the layer's own words, as written.
  if (i.expired || loc === "file" || loc === "") return sentence(`${actor} changed ${loc === "file" || loc === "" ? i.file : loc}`);
  const before = isEmpty(i.before) ? null : i.before!;
  const after = isEmpty(i.after) ? null : i.after!;
  if (before !== null && before === after && stateable(before)) return sentence(`${actor} changed ${loc}; the shown value stays ${before}`);
  if (before !== null && after !== null && stateable(before) && stateable(after)) return sentence(`${actor} changed ${loc} from ${before} to ${after}`);
  return sentence(`${actor} changed ${loc}`);
}

// ---- one change ----

/** One change of a connector's document, as the loader keeps it (diff-object.ts): its label, mark, words and plain sentence. */
export interface ConnectorChangeFacts {
  label: string;
  mark: string;
  before: string | null;
  after: string | null;
  text: string | null;
}

export interface ChangeFacts {
  actor: string;
  file: string;
  change: "created" | "modified" | "deleted";
  secret: boolean;
  expired: boolean;
  /** Under strict evidence (`twinOf` in timeline.ts), the other path of the same call whose bytes equal this one's: the new file for a deleted
   *  file, the deleted file for a new one. A fact about content only, never a claim of a move. */
  twin?: { path: string } | null;
  tier: "text" | "picture" | "fingerprint";
  /** Both sides have a stored image picture (a modified file with `generic.picture.before` and `.after` both set). */
  bothPictures?: boolean;
  /** A renderer on this machine reads this file type (PDF), so the view carries what changed and the note claims nothing. */
  rendererReads?: boolean;
  /** The sides whose reader failed on the stored bytes, each with the reader's reason. Empty when every side opens or no reader spoke. */
  unopened?: ReadonlyArray<{ side: "before" | "after"; why: string }>;
  /** The text tier's hunk lines, when the tier is text. */
  hunkOps?: ReadonlyArray<" " | "-" | "+">;
  rows: ReadonlyArray<{ location: string; kind: string; before: string | null; after: string | null; text: string }>;
  /**
   * A connector read this change (the row has a connector): its document's changes, and whether the document vouches that nothing changed
   * (the page's line, view-table.js coverageLine). Present: the note is worded from these alone, and never says CoCheck can't read inside the file.
   */
  connector?: { changes: ReadonlyArray<ConnectorChangeFacts>; nothing?: "changed" | "visible" } | null;
}

/** Picture files: a change to one is a change to the picture, which the view compares pixel by pixel. */
export const PICTURE_FILE = /\.(png|jpe?g|gif|heic|tiff?|bmp|webp)$/i;

/** Where the changes a capped list left out are: a place the layer named and the rows they span (nulls when the location says neither). */
export interface MorePlace {
  place: string | null;
  count: number;
  from: number | null;
  to: number | null;
}

/** The most places one "more changes" sentence names. */
const MAX_PLACES = 4;

/** How many changes a capped list left out, and where, in one sentence. */
export function moreText(count: number, where: ReadonlyArray<MorePlace>): string {
  const places = where.slice(0, MAX_PLACES).map((w) => {
    const rows = w.from === null || w.to === null ? "" : w.from === w.to ? ` row ${w.from}` : ` rows ${w.from} to ${w.to}`;
    return w.place === null ? "the file" : `${quoted(w.place)}${rows}`;
  });
  const text = where.length > MAX_PLACES ? `${places.slice(0, MAX_PLACES).join(", ")} and other places` : joinWords(places);
  const head = `${count} more ${count === 1 ? "change is" : "changes are"} not noted`;
  return text === "" ? `${head}.` : `${head}, in ${text}.`;
}

/**
 * One place a change touched, as the notes column draws it: the place, then what it held struck through, then what it holds now. `verb` says a
 * place that came or went ("Added", "Removed"); `text` is a plain phrase for a change with no old and new words to show. Every word is copied from the record.
 */
export interface RowCard {
  place: string;
  verb: string | null;
  before: string | null;
  after: string | null;
  text: string | null;
  /** The format row's `location` this card is for: the change-first page matches a change's `loc` to it. */
  loc?: string;
  /** The old and new words unclipped (whitespace flattened), for the change-first comment. null where the card has no words on that side, and both null when the values expired. */
  full?: { before: string | null; after: string | null };
}

/** The note for one row of a generic layer. */
export function rowNote(f: Pick<ChangeFacts, "actor" | "file" | "secret" | "expired">, row: ChangeFacts["rows"][number]): Note {
  return noteOf({ actor: f.actor, file: f.file, location: row.location, kind: row.kind, before: row.before, after: row.after, text: row.text, expired: f.expired, secret: f.secret });
}

/** The note for the whole change: a file-level shape first, then a connector's document, then the tier. */
export function changeNote(f: ChangeFacts): Note {
  const note = withTwin(eventNote(f), f);
  if (!f.unopened || f.unopened.length === 0) return note;
  // Only the earlier copy unreadable and the new one fine is a file replaced; one plain line, not "changed ... can't read inside it" plus a reason.
  if (f.unopened.length === 1 && f.unopened[0]!.side === "before" && f.change === "modified" && !f.secret) return sentence(`${f.actor} replaced ${f.file}; the earlier copy could not be opened`);
  // What CoCheck could not open is appended to the event sentence, never put in its place.
  return { ...note, text: `${note.text.replace(/\.$/, "")}. ${f.unopened.map((u) => couldNotOpen(f.file, u.side, u.why)).join(" ")}` };
}

/** The start of the sentence a new file's note carries under strict evidence; the rail keeps it when it trims a new file's note. */
export const SAME_CONTENT_AS = "Same content as ";
/** The literal twin fact, appended to the event sentence: what the bytes prove and nothing more (no "moved", no "renamed"). */
export function twinSentence(change: ChangeFacts["change"], path: string): string | null {
  if (change === "created") return `${SAME_CONTENT_AS}${path}, which this call deleted.`;
  if (change === "deleted") return `This call created ${path} with the same content.`;
  return null;
}
function withTwin(note: Note, f: ChangeFacts): Note {
  const extra = f.twin && !f.secret ? twinSentence(f.change, f.twin.path) : null;
  return extra === null ? note : { ...note, text: `${note.text.replace(/\.$/, "")}. ${extra}` };
}

/** The verb of a connector's mark (spec v1: added, removed, changed, moved, described). */
const MARK_VERB: Readonly<Record<string, string>> = { added: "added", removed: "removed", moved: "moved" };

/** The sentence of one change a connector listed: its label, then its words or its own plain sentence. Values only when they are whole and not expired. */
function connectorChangeNote(f: ChangeFacts, c: ConnectorChangeFacts): Note {
  const { actor, file } = f;
  const label = c.label.trim() === "" ? file : c.label;
  if (f.expired) return sentence(`${actor} changed ${label}`);
  const before = isEmpty(c.before) ? null : c.before!;
  const after = isEmpty(c.after) ? null : c.after!;
  if (c.mark === "changed" && before !== null && after !== null && stateable(before) && stateable(after)) {
    return sentence(before === after ? `${actor} changed ${label}; the shown value stays ${before}` : `${actor} changed ${label} from ${before} to ${after}`);
  }
  if (c.text !== null && c.text.trim() !== "") return sentence(`${actor} changed ${file}: ${c.text.trim()}`);
  return sentence(`${actor} ${MARK_VERB[c.mark] ?? "changed"} ${label}`);
}

/** What a connector listed for a new file, for the created sentence: one change's own sentence or words, else how many it listed. */
function connectorHolds(c: ReadonlyArray<ConnectorChangeFacts>): string | null {
  if (c.length === 0) return null;
  if (c.length > 1) return `${c.length} listed changes`;
  const only = c[0]!;
  if (only.text !== null && only.text.trim() !== "") return only.text.trim();
  return only.after !== null && stateable(only.after) && !isEmpty(only.after) ? only.after : null;
}

function eventNote(f: ChangeFacts): Note {
  const base = { actor: f.actor, file: f.file, expired: f.expired, secret: f.secret };
  if (f.secret) return noteOf({ ...base, kind: "fingerprint" });
  if (f.change === "created") return noteOf({ ...base, kind: "created", holds: f.connector ? connectorHolds(f.connector.changes) : null });
  if (f.change === "deleted") return noteOf({ ...base, kind: "deleted" });
  if (f.connector) {
    // A connector read this file: its document says what changed, and CoCheck never claims it can't read inside it.
    const listed = f.connector.changes;
    if (listed.length === 1) return connectorChangeNote(f, listed[0]!);
    if (listed.length > 1) return sentence(`${f.actor} made several changes inside ${f.file}`);
    if (f.connector.nothing === "changed") return noteOf({ ...base, kind: "nothing-changed" });
    if (f.connector.nothing === "visible") return noteOf({ ...base, kind: "nothing-visible" });
    return noteOf({ ...base, kind: "plain" });
  }
  if (f.tier === "text") {
    const ops = f.hunkOps ?? [];
    return noteOf({ ...base, kind: "text", lines: { added: ops.includes("+"), removed: ops.includes("-") } });
  }
  // "can't read inside it" (the fingerprint line) only when there is neither a reader nor a picture of both sides.
  if (f.rendererReads && !PICTURE_FILE.test(f.file)) return noteOf({ ...base, kind: "plain" });
  if (f.tier === "picture" && f.bothPictures) return noteOf({ ...base, kind: PICTURE_FILE.test(f.file) ? "picture" : "compared" });
  return noteOf({ ...base, kind: "fingerprint" });
}
