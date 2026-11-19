import { alignSequences } from "../../formats/files/align.ts";
import { decodeTextBytes } from "../../formats/files/textlike.ts";
import { MAX_TEXT_BYTES } from "../generic.ts";
import { readableSideOnly, versionWord } from "../broken.ts";
import type { Box, ChangeInfo, FormatRenderer, Pane, TextLine, View } from "./types.ts";

/**
 * The text renderer: any file the text tier read (csv, txt, md, json, code; the tier decides by content, not by name). Two panes of numbered lines, aligned row for row (an empty
 * row opposite an added or removed line, changed words marked in an edited one), cropped to the changed rows plus or minus two with a counted fold between far-apart bands. Boxes sit on changed lines
 * only, confidence `exact`, from the same line alignment the text tier uses; an unchanged line never carries one. A created or deleted
 * file draws its one side (the first 40 lines) and an empty pane on the other, with no boxes.
 */

export const TEXT_ENGINE = "drawn by CoCheck from the lines of the file";
const CONTEXT = 2;
const FIRST_LINES = 40;
const MAX_DRAWN = 400;
const MAX_BOXES = 2000;
const MAX_LINE_CHARS = 1000;

const splitLines = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const cut = (s: string): string => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}...` : s);
const sideLabel = (side: "before" | "after"): string => (side === "before" ? "Before" : "After");

type Kind = "add" | "del" | "edit";
interface Row {
  before: number | null;
  after: number | null;
  kind?: Kind;
}

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const MAX_TOKEN_CELLS = 40_000;
const MAX_PAIR_CELLS = 10_000;
const MIN_SIMILAR = 0.4;

interface Tok {
  s: string;
  at: number;
}
const tokens = (text: string): Tok[] => Array.from(text.matchAll(TOKEN), (m) => ({ s: m[0], at: m.index! }));

/** Words that differ between two lines: [start, end) ranges on each, and the share of characters the lines hold in common (0 to 1). */
function wordDiff(x: string, y: string): { xs: [number, number][]; ys: [number, number][]; similar: number } {
  const a = tokens(x);
  const b = tokens(y);
  let head = 0;
  while (head < a.length && head < b.length && a[head]!.s === b[head]!.s) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail]!.s === b[b.length - 1 - tail]!.s) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const keepA = new Set<number>();
  const keepB = new Set<number>();
  if (ma.length * mb.length <= MAX_TOKEN_CELLS) {
    const w = mb.length + 1;
    const t = new Uint32Array((ma.length + 1) * w);
    for (let i = ma.length - 1; i >= 0; i--) for (let j = mb.length - 1; j >= 0; j--) t[i * w + j] = ma[i]!.s === mb[j]!.s ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < ma.length && j < mb.length) {
      if (ma[i]!.s === mb[j]!.s) {
        keepA.add(i++);
        keepB.add(j++);
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
      else j++;
    }
  }
  const ranges = (all: Tok[], keep: Set<number>): [number, number][] => {
    const out: [number, number][] = [];
    all.forEach((tok, k) => {
      const inMiddle = k >= head && k < all.length - tail;
      if (!inMiddle || keep.has(k - head) || /^\s+$/.test(tok.s)) return;
      const last = out[out.length - 1];
      if (last !== undefined && last[1] === tok.at) last[1] = tok.at + tok.s.length;
      else out.push([tok.at, tok.at + tok.s.length]);
    });
    return out;
  };
  const xs = ranges(a, keepA);
  const ys = ranges(b, keepB);
  const marked = (all: Tok[], keep: Set<number>): number => all.reduce((n, tok, k) => (k >= head && k < all.length - tail && !keep.has(k - head) ? n + tok.s.length : n), 0);
  const total = x.length + y.length;
  return { xs, ys, similar: total === 0 ? 1 : (total - marked(a, keepA) - marked(b, keepB)) / total };
}

/** One run of removed lines and one run of added lines, side by side in file order: pairs lines that look alike as edits, the rest stay removed or added. */
function pairRun(dels: number[], ins: number[], a: string[], b: string[]): Row[] {
  const rows: Row[] = [];
  const nd = dels.length;
  const ni = ins.length;
  if (nd === 0 || ni === 0 || nd * ni > MAX_PAIR_CELLS) {
    // too big to compare line by line: pair by position, as the line alignment does
    for (let k = 0; k < Math.max(nd, ni); k++) rows.push({ before: k < nd ? dels[k]! : null, after: k < ni ? ins[k]! : null, kind: k < nd && k < ni ? "edit" : k < nd ? "del" : "add" });
    return rows;
  }
  const gain = (i: number, j: number): number => {
    const s = wordDiff(a[dels[i]!]!, b[ins[j]!]!).similar;
    return s >= MIN_SIMILAR ? s : 0;
  };
  const w = ni + 1;
  const g = new Float64Array(nd * ni);
  for (let i = 0; i < nd; i++) for (let j = 0; j < ni; j++) g[i * ni + j] = gain(i, j);
  const best = new Float64Array((nd + 1) * w);
  for (let i = nd - 1; i >= 0; i--) {
    for (let j = ni - 1; j >= 0; j--) {
      const pair = g[i * ni + j]! > 0 ? best[(i + 1) * w + j + 1]! + g[i * ni + j]! : -1;
      best[i * w + j] = Math.max(best[(i + 1) * w + j]!, best[i * w + j + 1]!, pair);
    }
  }
  let i = 0;
  let j = 0;
  while (i < nd && j < ni) {
    const pair = g[i * ni + j]! > 0 ? best[(i + 1) * w + j + 1]! + g[i * ni + j]! : -1;
    if (pair >= best[i * w + j]! && pair > 0) rows.push({ before: dels[i++]!, after: ins[j++]!, kind: "edit" });
    else if (best[(i + 1) * w + j]! >= best[i * w + j + 1]!) rows.push({ before: dels[i++]!, after: null, kind: "del" });
    else rows.push({ before: null, after: ins[j++]!, kind: "add" });
  }
  while (i < nd) rows.push({ before: dels[i++]!, after: null, kind: "del" });
  while (j < ni) rows.push({ before: null, after: ins[j++]!, kind: "add" });
  return rows;
}

/** Every row of the aligned file: unchanged lines as rows of both sides, and each run of differences paired by `pairRun`. */
function alignedRows(a: string[], b: string[], pairs: { before: number | null; after: number | null }[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  let dels: number[] = [];
  let ins: number[] = [];
  const flush = (): void => {
    rows.push(...pairRun(dels, ins, a, b));
    dels = [];
    ins = [];
  };
  for (const p of pairs) {
    const same = p.before !== null ? p.before - i : p.after! - j;
    if (same > 0) {
      flush();
      for (let k = 0; k < same; k++) rows.push({ before: i + k, after: j + k });
      i += same;
      j += same;
    }
    if (p.before !== null) {
      dels.push(p.before);
      i = p.before + 1;
    }
    if (p.after !== null) {
      ins.push(p.after);
      j = p.after + 1;
    }
  }
  flush();
  for (; i < a.length && j < b.length; i++, j++) rows.push({ before: i, after: j });
  return rows;
}

/** The two panes' lines for `rows`, cropped to the changed rows plus or minus the context; far-apart bands fold to a gap that counts the unchanged lines. */
function crop(rows: Row[], a: string[], b: string[]): { before: TextLine[]; after: TextLine[]; undrawnBefore: number; undrawnAfter: number } {
  const want = new Set<number>();
  rows.forEach((r, k) => {
    if (r.kind === undefined) return;
    for (let m = k - CONTEXT; m <= k + CONTEXT; m++) if (m >= 0 && m < rows.length) want.add(m);
  });
  const kept = [...want].sort((x, y) => x - y).slice(0, MAX_DRAWN);
  const before: TextLine[] = [];
  const after: TextLine[] = [];
  const fold = (hidden: number): void => {
    before.push({ gap: true, hidden });
    after.push({ gap: true, hidden });
  };
  let prev = -1;
  for (const k of kept) {
    if (k - prev > 1) fold(k - prev - 1);
    prev = k;
    const r = rows[k]!;
    const x = r.before === null ? null : cut(a[r.before]!);
    const y = r.after === null ? null : cut(b[r.after]!);
    const marks = r.kind === "edit" ? wordDiff(x!, y!) : null;
    before.push(x === null ? { filler: true } : { n: r.before! + 1, text: x, ...(r.kind ? { kind: r.kind } : {}), ...(marks ? { marks: marks.xs } : {}) });
    after.push(y === null ? { filler: true } : { n: r.after! + 1, text: y, ...(r.kind ? { kind: r.kind } : {}), ...(marks ? { marks: marks.ys } : {}) });
  }
  if (prev < rows.length - 1 && kept.length > 0) fold(rows.length - 1 - prev);
  const shown = new Set(kept);
  let undrawnBefore = 0;
  let undrawnAfter = 0;
  rows.forEach((r, k) => {
    if (r.kind === undefined || shown.has(k)) return;
    if (r.before !== null) undrawnBefore++;
    if (r.after !== null) undrawnAfter++;
  });
  return { before, after, undrawnBefore, undrawnAfter };
}

/** A step is mostly additions when it adds lines and the lines it removes or rewrites are under a tenth of the changed lines. Decided from the diff alone. */
export function mostlyAdditions(rows: Row[]): boolean {
  const changed = rows.filter((r) => r.kind !== undefined).length;
  const removed = rows.filter((r) => r.kind !== undefined && r.before !== null).length;
  const added = rows.filter((r) => r.kind !== undefined && r.after !== null).length;
  return changed > 0 && added > 0 && removed * 10 < changed;
}

/** The one column of a mostly-additions step: the after side's lines, a removed line in the place it was, a rewritten line as its removed line then its added line. */
function unifiedLines(rows: Row[], a: string[], b: string[]): { lines: TextLine[]; undrawn: number } {
  const flat: Row[] = [];
  for (const r of rows) {
    if (r.kind === "edit") {
      flat.push({ before: r.before, after: null, kind: "del" });
      flat.push({ before: null, after: r.after, kind: "add" });
    } else flat.push(r);
  }
  const c = crop(flat, a, b);
  const lines = c.after.map((l, k): TextLine => ("filler" in l ? c.before[k]! : l));
  return { lines, undrawn: c.undrawnBefore + c.undrawnAfter };
}

/** The whole-file view (Now, Before task) lists this many lines and bytes of one state; what is past it is named exactly. */
export const WHOLE_LINES = 5000;
export const WHOLE_BYTES = 1024 * 1024;

function wholeView(bytes: Buffer | null, info: ChangeInfo): View {
  const caveats = [...(info.missing ?? [])];
  const side = info.whole!;
  const card = (...more: string[]): View => ({ change: info.id, file: info.file, engine: TEXT_ENGINE, kind: "card", before: [], after: [], boxes: [], caveats: [...caveats, ...more] });
  // A secret file is never shown, whole or in part.
  if (info.generic?.secret === true) return card("This file is withheld as a secret, so none of it is shown.");
  if (bytes === null) return card(`The ${side} state is not available, so nothing is shown.`);
  const text = decodeTextBytes(bytes);
  if (text === null) return card("This file is not plain text, so no line is drawn.");
  const lines = splitLines(text);
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    const size = Buffer.byteLength(l, "utf8") + 1;
    if (kept.length >= WHOLE_LINES || used + size > WHOLE_BYTES) break;
    kept.push(l);
    used += size;
  }
  const drawn: TextLine[] = kept.map((t, i) => ({ n: i + 1, text: cut(t) }));
  if (kept.length < lines.length) {
    drawn.push({ gap: true });
    const why = kept.length >= WHOLE_LINES ? `the limit of ${WHOLE_LINES.toLocaleString("en-US")} lines` : `the limit of ${(WHOLE_BYTES / 1048576).toFixed(0)} MB`;
    caveats.push(`Lines ${(kept.length + 1).toLocaleString("en-US")}-${lines.length.toLocaleString("en-US")} are not shown (${(lines.length - kept.length).toLocaleString("en-US")} of ${lines.length.toLocaleString("en-US")} lines, past ${why}).`);
  } else caveats.push(lines.length === 0 ? "The file is empty." : `The whole file, ${lines.length.toLocaleString("en-US")} ${lines.length === 1 ? "line" : "lines"}, as it is ${side === "after" ? "now" : "before the task"}.`);
  if (lines.some((l) => l.length > MAX_LINE_CHARS)) caveats.push(`A line longer than ${MAX_LINE_CHARS} characters is drawn cut short.`);
  const p: Pane = { id: `${side}:text`, label: sideLabel(side), text: { lines: drawn } };
  return { change: info.id, file: info.file, engine: TEXT_ENGINE, kind: "pages", before: side === "before" ? [p] : [], after: side === "after" ? [p] : [], boxes: [], caveats };
}

export const textRenderer: FormatRenderer = {
  name: "text",
  extensions: [],
  wholeView: true,
  view(before: Buffer | null, after: Buffer | null, info: ChangeInfo): View {
    if (info.whole !== undefined) return wholeView(info.whole === "before" ? before : after, info);
    const caveats = [...(info.missing ?? [])];
    const card = (...more: string[]): View => ({ change: info.id, file: info.file, engine: TEXT_ENGINE, kind: "card", before: [], after: [], boxes: [], caveats: [...caveats, ...more] });
    const need = info.kind === "created" ? [after] : info.kind === "deleted" ? [before] : [before, after];
    if (need.some((b) => b === null)) return card("One of the two states is not available, so no line is compared and none is boxed.");
    if (need.some((b) => b!.length > MAX_TEXT_BYTES)) return card("The file is too large to list its lines, so nothing is boxed.");
    const decode = (b: Buffer | null): string[] | null => {
      if (b === null) return [];
      const t = decodeTextBytes(b);
      return t === null ? null : splitLines(t);
    };
    const a = decode(before);
    const b = decode(after);
    if (a === null && b === null) return card("This file is not plain text, so no line is drawn and nothing is boxed.");
    if (a === null || b === null) {
      // One side is not text; the side that is text is drawn in full and the other is named.
      const bad = a === null ? "before" : "after";
      const sentence = `The ${bad} version of ${info.file} holds bytes that are not text, so no lines are drawn for it.`;
      return textRenderer.view(bad === "before" ? null : before, bad === "after" ? null : after, readableSideOnly(info, bad, sentence)) as View;
    }

    const empty = (side: "before" | "after"): Pane => info.unreadable?.side === side ? { id: `${side}:empty`, label: `The ${versionWord(side)} version is not text` } : { id: `${side}:empty`, label: side === "before" ? "There was nothing here yet" : "There is nothing here now, the file was deleted" };
    const pane = (side: "before" | "after", drawn: TextLine[]): Pane => ({ id: `${side}:text`, label: sideLabel(side), text: { lines: drawn } });

    if (info.kind !== "modified") {
      const side = info.kind === "created" ? "after" : "before";
      const lines = info.kind === "created" ? b : a;
      const first = lines.slice(0, FIRST_LINES);
      /* plain lines on both edges: the pane's own "New" or "Deleted" label says what they are, so a long new file is not a wall of added-line tint */
      const drawn: TextLine[] = first.map((text, i) => ({ n: i + 1, text: cut(text) }));
      if (lines.length > first.length) {
        drawn.push({ gap: true });
        caveats.push(`Only the first ${FIRST_LINES} of ${lines.length} lines are shown.`);
      }
      if (lines.length === 0) caveats.push("The file is empty.");
      if (info.unreadable) caveats.push("Only one version is text, so nothing is compared and nothing is boxed.");
      else caveats.push(info.kind === "created" ? "The file is new, so nothing is compared and nothing is boxed." : "The file was deleted, so nothing is compared and nothing is boxed.");
      const drawnPane = pane(side, drawn);
      return { change: info.id, file: info.file, engine: TEXT_ENGINE, kind: "pages", before: side === "after" ? [empty("before")] : [drawnPane], after: side === "after" ? [drawnPane] : [empty("after")], boxes: [], caveats };
    }

    const pairs = alignSequences(a, b);
    if (pairs.length === 0) {
      const same = before!.equals(after!);
      return card(same ? "The two states are the same bytes." : "The file differs but no line does (line endings, a final newline or a byte order mark). Nothing is boxed.");
    }
    const rows = alignedRows(a, b, pairs);
    const changedBefore = rows.flatMap((r) => (r.kind !== undefined && r.before !== null ? [r.before] : []));
    const changedAfter = rows.flatMap((r) => (r.kind !== undefined && r.after !== null ? [r.after] : []));
    const boxes: Box[] = [];
    let cutBoxes = 0;
    for (const [side, idx] of [["before", changedBefore], ["after", changedAfter]] as const) {
      for (const i of idx) {
        if (boxes.length >= MAX_BOXES) {
          cutBoxes++;
          continue;
        }
        boxes.push({ side, pane: `${side}:text`, line: i + 1, change: info.id, confidence: "exact" });
      }
    }
    if (mostlyAdditions(rows)) {
      const u = unifiedLines(rows, a, b);
      const dropped = boxes.filter((x) => x.side === "before").length;
      const kept = boxes.filter((x) => x.side === "after");
      caveats.push(`Mostly added lines, so they are drawn in one column: a bar marks each added line${dropped > 0 ? ", and the few removed lines are struck through where they were" : ""}. Only lines within ${CONTEXT} of a change are shown.`);
      if (dropped > 0) caveats.push(`${dropped} removed ${dropped === 1 ? "line is" : "lines are"} drawn struck through but not boxed.`);
      if (u.undrawn > 0) caveats.push(`${u.undrawn} changed lines are not drawn because the window is full; they are still boxed by line number.`);
      if (cutBoxes > 0) caveats.push(`${cutBoxes} more changed lines are not listed; only the first ${MAX_BOXES} boxes are given.`);
      if ([...a, ...b].some((l) => l.length > MAX_LINE_CHARS)) caveats.push(`A line longer than ${MAX_LINE_CHARS} characters is drawn cut short.`);
      return { change: info.id, file: info.file, engine: TEXT_ENGINE, kind: "pages", before: [], after: [pane("after", u.lines)], boxes: kept, caveats };
    }
    const drawn = crop(rows, a, b);
    // Both panes are always drawn and always hold the same rows; the side with no line of its own in a hunk shows filler rows there.
    const beforePanes = [pane("before", drawn.before)];
    const afterPanes = [pane("after", drawn.after)];
    caveats.push(`Boxes are lines with no identical partner on the other side, found by comparing the lines in order. Both sides are drawn row for row, with an empty row opposite an added or removed line. Only lines within ${CONTEXT} of a change are shown.`);
    if (drawn.undrawnBefore + drawn.undrawnAfter > 0) caveats.push(`${drawn.undrawnBefore + drawn.undrawnAfter} changed lines are not drawn because the window is full; they are still boxed by line number.`);
    if (cutBoxes > 0) caveats.push(`${cutBoxes} more changed lines are not listed; only the first ${MAX_BOXES} boxes are given.`);
    if ([...a, ...b].some((l) => l.length > MAX_LINE_CHARS)) caveats.push(`A line longer than ${MAX_LINE_CHARS} characters is drawn cut short.`);
    return { change: info.id, file: info.file, engine: TEXT_ENGINE, kind: "pages", before: beforePanes, after: afterPanes, boxes, caveats };
  },
};
