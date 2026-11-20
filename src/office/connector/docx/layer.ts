// The docx reading of the Office connector: Word's change list. Moved out of core's files layer (src/formats/files/layer.ts),
// which keeps text, csv and the whole-file row; this layer wraps it and reads a `.docx` by paragraph, header and footer on top. Rows,
// wording and fallbacks are the ones the full files layer gave before the move.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { diffRow, sha256Hex as hashOf, type FormatLayer, type LayerDiffRow } from "../../../formats/layer.ts";
import { createFilesLayer as createCoreFilesLayer, diffSequence } from "../../../formats/files/layer.ts";
import { alignSequences } from "../../../formats/files/align.ts";
import { differingParts, docxChartChanges, docxOnlySavedDetailsDiffer } from "../shared/package-media.ts";
import { readDocxModel, readDocxParagraphs, type DocxParagraph } from "./reader.ts";

const isDocx = (file: string): boolean => extname(file).toLowerCase() === ".docx";

/** The one-part names that take "differs". */
const SINGULAR = new Set(["paragraph formatting", "list numbering", "document settings", "theme"]);

/** What changed in a paragraph's look, in plain words ("Made bold", "Colour changed"); empty when nothing a reader sees differs. */
function formatWords(a: DocxParagraph["fmt"], b: DocxParagraph["fmt"]): string[] {
  const words: string[] = [];
  const flag = (key: string, noun: string, made: string, removed: string): void => {
    const [x, y] = [a[key] ?? "off", b[key] ?? "off"];
    if (x === y) return;
    words.push(!x.includes("on") && y.includes("on") ? made : x.includes("on") && !y.includes("on") ? removed : `${noun} changed`);
  };
  flag("bold", "Bold", "Made bold", "Removed bold");
  flag("italic", "Italic", "Made italic", "Removed italic");
  flag("underline", "Underline", "Underlined", "Removed underline");
  flag("strike", "Strikethrough", "Struck through", "Removed strikethrough");
  const named: Array<[string, string]> = [["color", "Colour changed"], ["highlight", "Highlight changed"], ["size", "Size changed"], ["font", "Font changed"], ["style", "Style changed"], ["alignment", "Alignment changed"]];
  for (const [key, text] of named) if ((a[key] ?? "") !== (b[key] ?? "")) words.push(text);
  return words;
}

const MAX_RENUMBERED = 4;
function renumberedWords(moves: Array<[string, string]>): string {
  const shown = moves.slice(0, MAX_RENUMBERED).map(([f, t]) => `${f} to ${t}`);
  const rest = moves.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/**
 * The rows of two Word files. Text rows come from aligning the paragraphs: a changed paragraph is one row ("paragraph N"), and a run of consecutive
 * added (or removed) paragraphs is one row ("paragraphs N-M", numbered on the side where they exist). Paragraphs that kept their text are then
 * compared for look and pictures ("paragraph formatting changed", "picture resized", "picture moved"), and header and footer parts by number
 * ("header 1", "footer 1"). A list marker that moved because of an added or removed item is a sentence on that row, not a row of its own;
 * one with no such cause is named on a formatting row so it never vanishes.
 */
function diffDocx(aBytes: Uint8Array, bBytes: Uint8Array): LayerDiffRow[] {
  const [ma, mb] = [readDocxModel(aBytes), readDocxModel(bBytes)];
  const [pa, pb] = [ma.paragraphs, mb.paragraphs];
  const pairs = alignSequences(pa.map((p) => p.text), pb.map((p) => p.text));
  interface Entry { pos: number; row: LayerDiffRow; lists: Set<string> }
  const entries: Entry[] = [];
  const matched: Array<[number, number]> = [];
  const equal: Array<[number, number]> = [];
  let [i, j] = [0, 0];
  let run: { side: "added" | "removed"; first: number; last: number; entry: Entry; texts: string[] } | null = null;
  const stretch = (n: number): void => {
    for (let k = 0; k < n; k++) {
      matched.push([i + k, j + k]);
      equal.push([i + k, j + k]);
    }
    i += n;
    j += n;
  };
  const closeRun = (): void => {
    if (run === null) return;
    const { side, first, last, entry, texts } = run;
    const joined = texts.join("\n");
    entry.row = first === last
      ? side === "added" ? diffRow(`paragraph ${first + 1}`, "paragraph added", null, joined, { afterIndex: first + 1 }) : diffRow(`paragraph ${first + 1}`, "paragraph removed", joined, null, { beforeIndex: first + 1 })
      : diffRow(`paragraphs ${first + 1}-${last + 1}`, `paragraphs ${side}`, side === "removed" ? joined : null, side === "added" ? joined : null, side === "added" ? { afterIndex: first + 1, afterLast: last + 1, count: texts.length } : { beforeIndex: first + 1, beforeLast: last + 1, count: texts.length });
    entries.push(entry);
    run = null;
  };
  for (const pair of pairs) {
    const n = pair.after !== null ? pair.after - j : pair.before! - i;
    if (n < 0 || (pair.before !== null && pair.after !== null && pair.before - i !== n)) throw new Error("docx alignment is not monotonic");
    closeRunIfNot(pair);
    stretch(n);
    if (pair.before !== null && pair.after !== null) {
      closeRun();
      matched.push([pair.before, pair.after]);
      entries.push({ pos: pair.after, row: diffRow(`paragraph ${pair.after + 1}`, "paragraph changed", pa[pair.before]!.text, pb[pair.after]!.text, { beforeIndex: pair.before + 1, afterIndex: pair.after + 1 }), lists: new Set() });
      i++;
      j++;
    } else if (pair.after !== null) {
      const here = pb[pair.after]!;
      if (run === null) run = { side: "added", first: pair.after, last: pair.after, entry: { pos: pair.after, row: null as never, lists: new Set() }, texts: [] };
      run.last = pair.after;
      run.texts.push(here.text);
      if (here.list) run.entry.lists.add(here.list.numId);
      j++;
    } else {
      const here = pa[pair.before!]!;
      if (run === null) run = { side: "removed", first: pair.before!, last: pair.before!, entry: { pos: j - 0.5, row: null as never, lists: new Set() }, texts: [] };
      run.last = pair.before!;
      run.texts.push(here.text);
      if (here.list) run.entry.lists.add(here.list.numId);
      i++;
    }
  }
  closeRun();
  while (i < pa.length && j < pb.length) stretch(1);

  function closeRunIfNot(pair: { before: number | null; after: number | null }): void {
    if (run === null) return;
    const contiguous = run.side === "added" ? pair.before === null && pair.after === run.last + 1 : pair.after === null && pair.before === run.last + 1;
    if (!contiguous) closeRun();
  }

  // Look and pictures of paragraphs whose text did not change.
  for (const [bi, bj] of equal) {
    const [x, y] = [pa[bi]!, pb[bj]!];
    const words = formatWords(x.fmt, y.fmt);
    if (words.length > 0) entries.push({ pos: bj, lists: new Set(), row: diffRow(`paragraph ${bj + 1}`, "paragraph formatting changed", null, null, { beforeIndex: bi + 1, afterIndex: bj + 1, changes: words }) });
    const [ix, iy] = [x.pics.map((p) => p.img), y.pics.map((p) => p.img)];
    if (ix.length > 0 && ix.length === iy.length) {
      const sameOrder = ix.every((h, k) => h === iy[k]);
      const sameSet = [...ix].sort().join() === [...iy].sort().join();
      if (sameOrder && x.pics.some((p, k) => p.cx !== y.pics[k]!.cx || p.cy !== y.pics[k]!.cy)) {
        entries.push({ pos: bj + 0.25, lists: new Set(), row: diffRow(`paragraph ${bj + 1}`, "picture resized", null, null, { beforeIndex: bi + 1, afterIndex: bj + 1 }) });
      } else if (!sameOrder && sameSet) {
        entries.push({ pos: bj + 0.25, lists: new Set(), row: diffRow(`paragraph ${bj + 1}`, "picture moved", null, null, { beforeIndex: bi + 1, afterIndex: bj + 1 }) });
      }
    }
  }

  // List markers that moved: a sentence on the added or removed item behind them, else a formatting row of their own.
  const uncaused = new Map<string, { pos: number; moves: Array<[string, string]> }>();
  for (const [bi, bj] of matched) {
    const [x, y] = [pa[bi]!, pb[bj]!];
    if (x.label === null || y.label === null || x.label === y.label || y.list === null) continue;
    const numId = y.list.numId;
    const cause = [...entries].filter((e) => (e.row.kind === "paragraph added" || e.row.kind === "paragraph removed" || e.row.kind.startsWith("paragraphs ")) && e.pos <= bj && e.lists.has(numId)).sort((p, q) => q.pos - p.pos)[0];
    if (cause) {
      const moves = ((cause.row.detail.renumberedMoves as Array<[string, string]> | undefined) ?? []).concat([[x.label, y.label]]);
      cause.row.detail.renumberedMoves = moves;
      cause.row.detail.renumbered = `Items below renumbered ${renumberedWords(moves)}`;
    } else {
      const own = uncaused.get(numId) ?? { pos: bj, moves: [] };
      own.moves.push([x.label, y.label]);
      uncaused.set(numId, own);
    }
  }
  for (const { pos, moves } of uncaused.values()) {
    entries.push({ pos: pos + 0.5, lists: new Set(), row: diffRow(`paragraph ${pos + 1}`, "paragraph formatting changed", null, null, { afterIndex: pos + 1, changes: [`List renumbered ${renumberedWords(moves)}`] }) });
  }

  // Charts edited in place: what differs in each chart part, in words (a chart is not paragraph text, so the rows above never see it).
  for (const c of docxChartChanges(aBytes, bBytes)) entries.push({ pos: c.index - 1 + 0.3, lists: new Set(), row: diffRow(`paragraph ${c.index}`, "chart changed", null, null, { afterIndex: c.index, changes: c.lines, ...(c.title !== null ? { title: c.title } : {}) }) });
  const rows = entries.sort((p, q) => p.pos - q.pos).map((e) => e.row);
  for (const [unit, was, now] of [["header", ma.headers, mb.headers], ["footer", ma.footers, mb.footers]] as const) {
    for (const n of [...new Set([...was.keys(), ...now.keys()])].sort((p, q) => p - q)) {
      const [x, y] = [was.get(n), now.get(n)];
      if ((x ?? "") !== (y ?? "")) rows.push(diffRow(`${unit} ${n}`, `${unit} changed`, x ?? null, y ?? null, { part: `${unit}${n}.xml` }));
    }
  }
  return rows;
}

/**
 * The files layer as the connector program reads with it: core's files layer, plus a `.docx` read by paragraph. `generic` or `wholeOnly` is
 * core's own reading, returned unchanged (a document is one whole-file row there).
 */
export function createFilesLayer(opts: { generic?: boolean; wholeOnly?: boolean } = {}): FormatLayer {
  const core = createCoreFilesLayer(opts);
  if (opts.generic === true || opts.wholeOnly === true) return core;
  return {
    ...core,

    async diff(beforePath, afterPath) {
      if (beforePath === null || afterPath === null || !isDocx(afterPath)) return core.diff(beforePath, afterPath);
      const [a, b] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
      if (a.equals(b)) {
        return [];
      }
      const whole = (note: string) => [diffRow("file", "file changed", hashOf(a), hashOf(b), { bytesBefore: a.length, bytesAfter: b.length, note })];
      // Bytes differ, so every path below returns at least one row, except a docx whose parts are all byte-identical (only the zip's own
      // entry timestamps moved): that is the one empty answer, and the timeline says "saved again".
      try {
        const parts = differingParts(a, b);
        // A plain re-save that rewrites only the core and app properties is the same empty answer as byte-identical parts
        if (parts?.length === 0 || docxOnlySavedDetailsDiffer(a, b)) return [];
        let rows: LayerDiffRow[];
        try {
          rows = diffDocx(a, b);
        } catch {
          // the richer reading failed on this file: the plain paragraph rows still say every text change
          rows = diffSequence(readDocxParagraphs(a), readDocxParagraphs(b), "paragraph");
        }
        // Equal text, so name what differs (null: unreadable or over the cap, today's generic wording).
        const named = parts === null ? "headers, footers, formatting or other parts" : parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
        return rows.length > 0 ? rows : whole(`body text unchanged; ${named} differ${parts?.length === 1 && SINGULAR.has(parts[0]!) ? "s" : ""}`);
      } catch {
        // an unreadable docx falls through to the whole-file row
      }
      return [diffRow("file", "binary file changed", hashOf(a), hashOf(b), { bytesBefore: a.length, bytesAfter: b.length })];
    },

    describe(r) {
      if (r.kind !== "chart changed") return core.describe(r);
      return `chart${typeof r.detail.title === "string" ? ` '${r.detail.title}'` : ""} changed: ${(r.detail.changes as string[]).join("; ")}`;
    },

    async restate(snapshotPath, row) {
      if (snapshotPath === null || !isDocx(snapshotPath)) return core.restate(snapshotPath, row);
      const withAfter = (after: unknown): LayerDiffRow => ({ ...row, after });
      const bytes = await readFile(snapshotPath);
      const n = Number(/(\d+)/.exec(row.location)?.[1]) - 1;
      if (Number.isNaN(n)) {
        return withAfter(hashOf(bytes));
      }
      try {
        if (/^(paragraph formatting changed|picture resized|picture moved|chart changed)$/.test(row.kind)) return withAfter(row.after);
        const hf = /^(header|footer) (\d+)$/.exec(row.location);
        if (hf) {
          const model = readDocxModel(bytes);
          return withAfter((hf[1] === "header" ? model.headers : model.footers).get(Number(hf[2])) ?? null);
        }
        const paras = readDocxParagraphs(bytes);
        const span = /^paragraphs (\d+)-(\d+)$/.exec(row.location);
        if (span) return withAfter(paras.slice(Number(span[1]) - 1, Number(span[2])).join("\n"));
        return withAfter(paras[n] ?? null);
      } catch {
        // unreadable: fall through to the whole-file state
      }
      return withAfter(hashOf(bytes));
    },
  };
}
