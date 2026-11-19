import path from "node:path";
import { alignSequences } from "../formats/files/align.ts";
import { decodeTextBytes } from "../formats/files/textlike.ts";

/**
 * The generic shape every file change in the timeline carries (`Change.generic`), whatever the file type. The text, picture and fingerprint tiers share it
 * exactly; docs/timeline.md states it. A format part (today the spreadsheet cell rows in `Change.format`) stays where it is and never
 * replaces `generic`.
 */

export interface GenericHunkLine {
  op: " " | "-" | "+";
  text: string;
}

export interface GenericHunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
  lines: GenericHunkLine[];
}

export interface GenericRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GenericFingerprintSide {
  sha: string;
  /** Null when the size is unknown (a secret side is never opened). Never 0 for "unknown". */
  size: number | null;
}

export interface Generic {
  tier: "text" | "picture" | "fingerprint";
  /** Plain words a page can print as is. */
  label: string;
  text?: { hunks: GenericHunk[]; cut?: string };
  picture?: { before: string | null; after: string | null; width: number; height: number; regions: GenericRegion[]; note?: string };
  fingerprint?: { before: GenericFingerprintSide | null; after: GenericFingerprintSide | null; kind: string; note: string };
  secret?: true;
  /** A side whose reader failed on its stored bytes, with the reader's reason in plain words. Only a failure; absent when every side opens or no reader spoke. */
  unopened?: Array<{ side: "before" | "after"; why: string }>;
  /** One line when reading a state threw something that is not the reader's own failure; no claim is made about that state. */
  readerCaveats?: string[];
  /** Set by the loader on a state a connector reads: core draws no view of it, whatever its bytes are; its renderer is a card. */
  claimed?: true;
  /** A preview is still being drawn, so this entry is a stand-in that a later build replaces. Never cached. */
  pending?: true;
}

/*
 * Tier choice: a list of tier functions tried in order, text then picture, with the fingerprint as the floor. A secret file
 * never reaches the list.
 */

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_CHANGED_LINES = 2000;
export const CONTEXT_LINES = 3;
/** The most bytes read into memory for one side. Above this only the first NUL_HEAD_BYTES are read, to tell text from binary. */
export const NUL_HEAD_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 32 * 1024 * 1024;

/** One side of a change as the tier functions see it. `bytes` is null when the bytes are not in the store (or too large to read). */
export interface Side {
  sha: string;
  size: number | null;
  bytes: Uint8Array | null;
  /** Why `bytes` is null, in words. */
  why: string | null;
  /** True when the head of the file was read and held a NUL byte, so the rest was not read: the file is not text. */
  binary?: true;
  /** True when `bytes` is only the head of a file over the read cap; `size` is the whole file. */
  head?: true;
}

export interface GenericSource {
  file: string;
  kind: "created" | "modified" | "deleted";
  /** The state before; null for a created file. */
  before: Side | null;
  /** The state after; null for a deleted file. */
  after: Side | null;
  secret: boolean;
  /** The label of a secret file's fingerprint (`secretLine` of its relative path). */
  secretLabel?: string;
}

/** A tier answers with a Generic, or null to leave the change to the next tier. */
export type Tier = (src: GenericSource) => Generic | null | Promise<Generic | null>;

export function kindOfFile(file: string): string {
  const ext = path.extname(file).toLowerCase().replace(/[^.a-z0-9]/g, "");
  return ext.length > 1 ? `${ext} file` : "file without an extension";
}

const sideOf = (s: Side | null): GenericFingerprintSide | null => (s === null ? null : { sha: s.sha, size: s.bytes?.length ?? s.size });

/** The floor: hashes and sizes, never contents. */
export function fingerprintTier(src: GenericSource, why: string): Generic {
  if (src.secret) {
    return {
      tier: "fingerprint",
      label: src.secretLabel ?? "A secret file was changed",
      fingerprint: { before: sideOf(src.before), after: sideOf(src.after), kind: kindOfFile(src.file), note: "This looks like a secret file, so only its fingerprint is kept. Its contents are never shown." },
      secret: true,
    };
  }
  const label = src.kind === "created" ? "New file, contents not shown" : src.kind === "deleted" ? "File deleted, contents not shown" : "File changed, contents not shown";
  return { tier: "fingerprint", label, fingerprint: { before: sideOf(src.before), after: sideOf(src.after), kind: kindOfFile(src.file), note: why } };
}

// ---- text tier ----

const splitLines = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

interface Entry {
  op: " " | "-" | "+";
  text: string;
  /** Which aligned pair a changed line belongs to. */
  pair: number;
}

/** Line hunks with context between two line lists, using the files layer's own alignment. `changed` is the number of aligned pairs. */
export function lineHunks(a: string[], b: string[]): { hunks: GenericHunk[]; changed: number; shownPairs: number } {
  const pairs = alignSequences(a, b);
  const entries: Entry[] = [];
  let i = 0;
  let j = 0;
  let dels: Entry[] = [];
  let ins: Entry[] = [];
  const flush = () => {
    entries.push(...dels, ...ins);
    dels = [];
    ins = [];
  };
  const keepTo = (bi: number) => {
    // Unchanged lines up to before-index bi (the after side moves in step).
    if (bi > i) flush();
    while (i < bi) {
      entries.push({ op: " ", text: a[i]!, pair: -1 });
      i++;
      j++;
    }
  };
  const allPairs = pairs;
  const kept = allPairs.slice(0, MAX_CHANGED_LINES);
  kept.forEach((p, n) => {
    if (p.before !== null) keepTo(p.before);
    else keepTo(i + (p.after! - j));
    if (p.before !== null) {
      dels.push({ op: "-", text: a[p.before]!, pair: n });
      i = p.before + 1;
    }
    if (p.after !== null) {
      ins.push({ op: "+", text: b[p.after]!, pair: n });
      j = p.after + 1;
    }
  });
  flush();
  if (kept.length === allPairs.length) keepTo(a.length);
  else {
    // Cut: only unchanged lines before the first unlisted pair are context, so no changed line is shown as unchanged.
    const next = allPairs[kept.length]!;
    keepTo(Math.min(i + CONTEXT_LINES, next.before ?? i + (next.after! - j)));
  }
  return { hunks: toHunks(entries), changed: allPairs.length, shownPairs: kept.length };
}

function toHunks(entries: Entry[]): GenericHunk[] {
  const hunks: GenericHunk[] = [];
  let bLine = 0; // before lines passed so far
  let aLine = 0;
  const before: number[] = []; // before line count preceding each entry
  const after: number[] = [];
  for (const e of entries) {
    before.push(bLine);
    after.push(aLine);
    if (e.op !== "+") bLine++;
    if (e.op !== "-") aLine++;
  }
  let from = -1;
  let lastChange = -1;
  const close = (end: number) => {
    const lines = entries.slice(from, end);
    const beforeLines = lines.filter((l) => l.op !== "+").length;
    const afterLines = lines.filter((l) => l.op !== "-").length;
    hunks.push({
      beforeStart: beforeLines === 0 ? before[from]! : before[from]! + 1,
      beforeLines,
      afterStart: afterLines === 0 ? after[from]! : after[from]! + 1,
      afterLines,
      lines: lines.map((l) => ({ op: l.op, text: l.text })),
    });
  };
  for (let n = 0; n < entries.length; n++) {
    if (entries[n]!.op === " ") continue;
    if (from === -1) from = Math.max(0, n - CONTEXT_LINES);
    else if (n - lastChange - 1 > 2 * CONTEXT_LINES) {
      close(lastChange + 1 + CONTEXT_LINES);
      from = n - CONTEXT_LINES;
    }
    lastChange = n;
  }
  if (from !== -1) close(Math.min(entries.length, lastChange + 1 + CONTEXT_LINES));
  return hunks;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const megabytes = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

/** A head cut at a byte count can end inside a multi-byte character: drop up to three trailing bytes before calling it not text. */
function decodeHead(bytes: Uint8Array): string | null {
  for (let drop = 0; drop <= 3 && drop < bytes.length; drop++) {
    const t = decodeTextBytes(bytes.subarray(0, bytes.length - drop));
    if (t !== null) return t;
  }
  return null;
}

/** The text tier: both stored sides decode as UTF-8 with no NUL byte in the first 64 KB. Null when they do not, or a side has no bytes. */
export const textTier: Tier = (src) => {
  if (src.secret) return null;
  const sides = [src.before, src.after].filter((s): s is Side => s !== null);
  if (sides.length === 0 || sides.some((s) => s.bytes === null)) return null;
  const texts = sides.map((s) => (s.head ? decodeHead(s.bytes!) : decodeTextBytes(s.bytes!)));
  if (texts.some((t) => t === null)) return null;
  const aText = src.before ? (texts[0] as string) : "";
  const bText = src.after ? (texts[src.before ? 1 : 0] as string) : "";
  const total = Math.max(...sides.map((s) => (s.head ? (s.size ?? s.bytes!.length) : s.bytes!.length)));
  const lead = src.kind === "created" ? "Text, new file" : src.kind === "deleted" ? "Text, file deleted" : "Text";
  if (total > MAX_TEXT_BYTES) {
    return {
      tier: "text",
      label: `${lead}, too large to list lines`,
      text: { hunks: [], cut: `The file is ${megabytes(total)}, over the ${megabytes(MAX_TEXT_BYTES)} limit, so its lines are not listed.` },
    };
  }
  const { hunks, changed, shownPairs } = lineHunks(splitLines(aText), splitLines(bText));
  let label: string;
  if (changed === 0) label = `${lead}, no line changed (line endings, final newline or byte order mark differ)`;
  else if (src.kind === "modified") label = `Text, ${plural(changed, "line", "lines")} changed`;
  else label = `${lead}, ${plural(changed, "line", "lines")}`;
  const text: NonNullable<Generic["text"]> = { hunks };
  if (changed > shownPairs) text.cut = `${plural(changed, "line is", "lines are")} changed, over the ${MAX_CHANGED_LINES} limit, so only the first ${shownPairs} are listed.`;
  return { tier: "text", label, text };
};

/**
 * Tried in order; the first to answer wins, and the fingerprint is the floor. The loader's list is text, then picture (`picture.ts`,
 * which needs the store and the renderer, so it is built there). A secret file never reaches a tier.
 */
export const TIERS: Tier[] = [textTier];

export async function chooseGeneric(src: GenericSource, tiers: Tier[] = TIERS): Promise<Generic> {
  if (src.secret) return fingerprintTier(src, "");
  for (const tier of tiers) {
    const out = await tier(src);
    if (out) return out;
  }
  const missing = [src.before, src.after].find((s) => s !== null && s.bytes === null && !s.binary);
  if (missing) return fingerprintTier(src, `The bytes of one version are not available (${missing.why ?? "not in the store"}), so only its fingerprint is shown.`);
  return fingerprintTier(src, "This is not a plain text file, so only its fingerprint is shown.");
}
