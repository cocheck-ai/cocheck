import { CALC_CHAIN, isReorderNoise } from "./parts.ts";
import { quietCore } from "../shared/docprops-noise.ts";
import { XR_NS, startTags } from "../shared/ooxml-names.ts";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { SnapshotRefusal, copySnapshot, sha256Hex as hashOf, type LayerDiffRow, type LayerOp, type SnapshotMode } from "../../../formats/layer.ts";
import type { LabelCells, ParseMemo, SheetsChanged, XlsxFormatLayer } from "./memo.ts";
import { isCellError, type DiffRow, type WorkbookSnapshot } from "./types.ts";
import { createInflateRaw, crc32, inflateRawSync } from "node:zlib";
import { readWorkbookSnapshot, WorkbookTooLarge, type ReadLimits } from "./reader.ts";
import { diffWorkbooks } from "./diff.ts";
import { normalizePathForCompare } from "../../../paths.ts";
import { holdsHash } from "./written.ts";

/**
 * An op logged by the host-hook adapter (`src/hook-adapter.ts`; `args.hookAdapter === 1`) keeps the host's own tool name
 * and records no sheet or range, only the cells the adapter saw change between two copies of the file:
 * `args.hookCells` = `{sheet, cell, hash}` each (`hash` = `cellHash(observedKey(...))` of what the cell held after the call).
 * It touches exactly those cells.
 */
function isHookOp(op: LayerOp): boolean {
  return op.args.hookAdapter === 1;
}

interface HookCell {
  sheet: string;
  cell: string;
  hash: string;
}

function hookCellsOf(op: LayerOp): HookCell[] {
  return Array.isArray(op.args.hookCells) ? (op.args.hookCells as HookCell[]) : [];
}

const cellKey = (sheet: unknown, cell: unknown): string => `${String(sheet)}\u0000${String(cell)}`;

/** Per op, where each of its hook cells sits (the first position of a repeated cell), so a lookup is a Map get, not a scan. */
const hookCellIndexes = new WeakMap<LayerOp, Map<string, number>>();
function hookCellIndex(op: LayerOp): Map<string, number> {
  let index = hookCellIndexes.get(op);
  if (index === undefined) {
    index = new Map();
    const cells = hookCellsOf(op);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const k = cellKey(c.sheet, c.cell);
      if (!index.has(k)) index.set(k, i);
    }
    hookCellIndexes.set(op, index);
  }
  return index;
}

/**
 * `normalizePathForCompare` resolves symlinks (an lstat per path part), which per row per op made a large change's review
 * quadratic. An op's path is normalized once per op (the ops of a review are fresh objects); the file path is remembered for a
 * second, so a symlink changed later is still seen.
 */
const opPaths = new WeakMap<object, string>();
function opPathOf(op: LayerOp): string | undefined {
  const raw = op.args.path;
  if (typeof raw !== "string") return undefined;
  let norm = opPaths.get(op.args);
  if (norm === undefined) {
    norm = normalizePathForCompare(raw);
    opPaths.set(op.args, norm);
  }
  return norm;
}
let lastFile: { raw: string; norm: string; at: number } | undefined;
function filePathOf(raw: string): string {
  const now = Date.now();
  if (lastFile !== undefined && lastFile.raw === raw && now - lastFile.at < 1000) return lastFile.norm;
  const norm = normalizePathForCompare(raw);
  lastFile = { raw, norm, at: now };
  return norm;
}
import { round15 } from "./numbers.ts";

/** Whether Excel has the workbook open, and if so whether it has unsaved edits. */
export type ExcelOpenState = "closed" | "saved" | "unsaved";

/** Stable error code: the workbook is open in Excel with unsaved edits, so it can't be snapshotted. */
export const UNSAVED_CHANGES_OPEN = "UNSAVED_CHANGES_OPEN";

/**
 * `recalc-only`: every formula and constant matches the file, so the flag came from recalculation.
 * `differs`: the first input that differs, as `Sheet!A1`. `unverified`: the check could not finish, so the snapshot refuses.
 */
export type RecalcVerdict = { kind: "recalc-only" } | { kind: "differs"; cell: string } | { kind: "unverified" };

/** The sentence an unsaved-workbook refusal uses. `firstDiff`, when the comparison with the file found one, names the first input that differs. */
export function unsavedChangesMessage(name: string, firstDiff?: string): string {
  const where = firstDiff ? ` ${firstDiff} differs from the saved file.` : "";
  return `"${name}" is open in Excel with unsaved changes.${where} Save the workbook in Excel, then I'll retry.`;
}

/**
 * The Excel-facing seam the xlsx layer's `snapshot` goes through. Every caller passes it (there is no default that drives
 * Excel): the live callers pass `openState: async () => "closed"`, tests pass "unsaved" to exercise the refusal.
 */
export interface XlsxSnapshotDeps {
  openState: (filePath: string) => Promise<ExcelOpenState>;
  /**
   * Runs when `openState` says "unsaved": compares Excel's formulas and constants with the file, so a flag that
   * only recalculation set does not refuse. Absent means every "unsaved" refuses.
   */
  recalcOnly?: (filePath: string) => Promise<RecalcVerdict>;
}

/** Location string for an xlsx row: the sheet and the row's post-change address. */
function locationOf(row: DiffRow): string {
  return `${row.sheet}!${afterAddress(row.cell)}`;
}

/** `cellLabel` in diff.ts renders a moved cell as "B3->B4"; ops address the post-change cell. */
function afterAddress(cell: string): string {
  const parts = cell.split("->");
  return parts[parts.length - 1]!;
}

function normalizeCell(cell: string): string {
  return cell.replace(/\$/g, "").toUpperCase();
}

/** Empty placeholder for a missing side, carrying the other side's sheet names so cells still diff. */
function emptyLike(other: WorkbookSnapshot): WorkbookSnapshot {
  return { sheets: other.sheets.map((s) => ({ name: s.name, cells: new Map() })), dateSystem: other.dateSystem };
}

async function load(filePath: string | null): Promise<WorkbookSnapshot | null> {
  return filePath === null ? null : readWorkbookSnapshot(await readFile(filePath));
}

/**
 * Past these, `diff` doesn't compare a workbook cell by cell and reports one "too large" row
 * instead. Measured on generated 3-column sheets: two 600,000-cell workbooks (200,000 rows) read
 * and diff in under 350 MB of heap; two of a million cells ran out at 500 MB. The byte bound
 * stops a workbook whose parts would inflate past what fits as one string before any of it is
 * inflated.
 */
export const DIFF_LIMITS: Required<ReadLimits> = { maxCells: 600_000, maxUnzippedBytes: 64 * 1048576 };

/**
 * Kinds of `wholeFile` rows; the cell diff's own kinds are "value" | "formula" | "structure". A
 * workbook CoCheck couldn't read, and a workbook with no cells appearing or going away, are
 * "file changed" rows too, told apart by `detail.unreadable` / `detail.added` / `detail.removed`.
 */
const TOO_LARGE = "too large";
const FILE_CHANGED = "file changed";
/** A workbook that first appears in a task: one row summarizing it (`detail.sheets`, `detail.cells`), not one per cell. */
const NEW_FILE = "new file";

/** Parts Excel rewrites on every save whatever changed (app version, preview image); `docProps/core.xml` is
 * noise only in its timestamp, last-author and revision fields (see `NORMALIZED_PARTS`).
 * `docProps/custom.xml` is deliberately not here: custom properties carry sensitivity labels and workflow data.
 * `xl/workbook.xml` gets the same treatment for its revision pointer. */
export const RESAVE_NOISE = /^docProps\/(app\.xml|thumbnail\.[^/]*)$/;

/** The workbook part, whose `<xr:revisionPtr>` attributes Excel regenerates on every save. */
export const WORKBOOK_PART = "xl/workbook.xml";

/** The core properties part, whose save time, last author and revision count change on every save. */
export const CORE_PART = "docProps/core.xml";

/** The workbook text with each revisionPtr element (Excel's revision namespace, whatever prefix it is bound to) reduced to its bare tag. */
function withoutRevisionAttributes(text: string): string {
  let out = "";
  let at = 0;
  try {
    for (const tag of startTags(text, WORKBOOK_PART)) {
      if (tag.local !== "revisionPtr" || tag.uri !== XR_NS) continue;
      out += `${text.slice(at, tag.index)}<${tag.qname}${/\/\s*>$/.test(tag.text) ? "/" : ""}>`;
      at = tag.index + tag.text.length;
    }
  } catch {
    return text;
  }
  return out + text.slice(at);
}

/**
 * A part's bytes with per-save noise removed. In `xl/workbook.xml`, the attributes of
 * `<xr:revisionPtr>` (a fresh `documentId` GUID per save, plus `revIDLastSave`, `xr10:uidLastSave`
 * and `xr6:coauthVersion*`). In `docProps/core.xml`, `dcterms:modified`, `cp:lastModifiedBy` and
 * `cp:revision`; a changed title, author, subject or keywords stays visible. Everything else stays
 * byte-exact, so a sheet added or a view changed still differs.
 */
export function comparable(name: string, bytes: Uint8Array): Buffer {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (name === WORKBOOK_PART) {
    return Buffer.from(withoutRevisionAttributes(buf.toString("latin1")), "latin1");
  }
  if (name === CORE_PART) {
    const text = quietCore(buf.toString("latin1"));
    return Buffer.from(text, "latin1");
  }
  return buf;
}

/** One central-directory entry: what the zip claims about a part, and where its compressed bytes are. */
export interface ZipPart {
  method: number;
  crc: number;
  compressed: number;
  size: number;
  data: Uint8Array;
}

/**
 * The package's parts as its central directory declares them, without inflating anything. Anything
 * unusual (zip64, encryption, a method other than stored/deflate, a repeated name, a truncated
 * record) throws, so the caller treats the package as not noise.
 */
export function zipDirectory(zip: Uint8Array): Map<string, ZipPart> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("no end of central directory");
  }
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff) {
    throw new Error("zip64");
  }
  const parts = new Map<string, ZipPart>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== 0x02014b50) {
      throw new Error("bad central directory");
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = Buffer.from(zip.buffer, zip.byteOffset + at + 46, nameLength).toString("utf8");
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8) || compressed === 0xffffffff || size === 0xffffffff || parts.has(name) || next > zip.length) {
      throw new Error("unsupported zip entry");
    }
    if (local + 30 > zip.length || view.getUint32(local, true) !== 0x04034b50) {
      throw new Error("bad local header");
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > zip.length) {
      throw new Error("part runs past the file");
    }
    parts.set(name, { method, crc, compressed, size, data: zip.subarray(start, start + compressed) });
    at = next;
  }
  return parts;
}

function declaredTotal(parts: Map<string, ZipPart>): number {
  let total = 0;
  for (const part of parts.values()) {
    total += part.size;
  }
  return total;
}

/** A part's real bytes, inflated whole but never past its declared size; a lie about size or CRC throws. */
export function inflateBounded(part: ZipPart): Uint8Array {
  const bytes = part.method === 0 ? part.data : inflateRawSync(part.data, { maxOutputLength: Math.max(part.size, 1) });
  if (bytes.length !== part.size || crc32(bytes) !== part.crc) {
    throw new Error("part disagrees with its header");
  }
  return bytes;
}

/**
 * A part's real CRC and size, inflated in chunks so memory stays flat however large it is. Stops
 * and throws as soon as it yields more than the part declared, so a size lie can't run away.
 */
async function measurePart(part: ZipPart): Promise<{ crc: number; size: number }> {
  if (part.method === 0) {
    return { crc: crc32(part.data), size: part.data.length };
  }
  const inflater = createInflateRaw();
  inflater.end(part.data);
  let crc = 0;
  let size = 0;
  for await (const chunk of inflater as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > part.size) {
      inflater.destroy();
      throw new Error("part inflates past its declared size");
    }
    crc = crc32(chunk, crc);
  }
  return { crc, size };
}

/** Whether two parts hold the same bytes, judged by what they inflate to and never by what they declare. */
async function samePart(x: ZipPart, y: ZipPart): Promise<boolean> {
  if (x.method === y.method && x.data.length === y.data.length && Buffer.compare(x.data, y.data) === 0 && x.crc === y.crc && x.size === y.size) {
    return true;
  }
  const [mx, my] = [await measurePart(x), await measurePart(y)];
  return mx.size === x.size && my.size === y.size && mx.crc === x.crc && my.crc === y.crc && mx.size === my.size && mx.crc === my.crc;
}

/**
 * Whether two workbooks' packages hold the same parts with the same bytes, once Excel's per-save
 * noise is set aside (see `RESAVE_NOISE`, `comparable`), so a re-save that only moved Excel's
 * timestamps is no change. A package whose declared parts sum past `maxUnzippedBytes` is never
 * inflated, so never noise. Below that, `workbook.xml` and `core.xml` are inflated whole (never
 * past their declared size) and every other part is streamed through a CRC, so memory stays flat
 * and a declared size or CRC that lies can't produce noise. A package that won't unzip is never noise.
 */
async function onlyResaveNoise(a: Uint8Array, b: Uint8Array, maxUnzippedBytes: number): Promise<boolean> {
  try {
    const before = zipDirectory(a);
    const after = zipDirectory(b);
    if (declaredTotal(before) > maxUnzippedBytes || declaredTotal(after) > maxUnzippedBytes) {
      return false;
    }
    const ignored = (name: string): boolean => RESAVE_NOISE.test(name) || name === CALC_CHAIN;
    const names = [...before.keys()].filter((name) => !ignored(name));
    if (names.length !== [...after.keys()].filter((name) => !ignored(name)).length) {
      return false;
    }
    for (const name of names) {
      const x = before.get(name)!;
      const y = after.get(name);
      if (!y) {
        return false;
      }
      if (name === WORKBOOK_PART || name === CORE_PART) {
        if (!comparable(name, inflateBounded(x)).equals(comparable(name, inflateBounded(y)))) {
          return false;
        }
      } else if (!(await samePart(x, y)) && !isReorderNoise(name, x, y)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** A reader error in words: its message without the "xlsx: " prefix, or the error itself. */
function unreadableReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^xlsx:\s*/, "") || "unknown error";
}

/** A cell value as JSON, with numbers cut to the 15 significant digits Excel keeps. */
function shownValue(value: unknown): string {
  return JSON.stringify(typeof value === "number" ? round15(value) : value);
}

/** One side of a formula row in words: `formula =A1*2 (4)`, or just the value when there's no formula. */
function sideInWords(formula: string | null | undefined, value: unknown): string {
  const shown = value === null || value === undefined ? "empty" : shownValue(value);
  if (formula === null || formula === undefined) {
    return shown;
  }
  return value === null || value === undefined ? `formula =${formula} (no stored value)` : `formula =${formula} (${shown})`;
}

function wholeFileRow(kind: string, before: Buffer, after: Buffer, detail: Record<string, unknown>): LayerDiffRow {
  return {
    location: "file",
    kind,
    before: hashOf(before),
    after: hashOf(after),
    derivable: false,
    wholeFile: true,
    detail: { kind, bytesBefore: before.length, bytesAfter: after.length, ...detail },
  };
}

function toLayerRow(row: DiffRow): LayerDiffRow {
  const isFormulaCell = row.formulaBefore != null && row.formulaAfter != null;
  return {
    location: locationOf(row),
    kind: row.kind,
    before: row.kind === "formula" ? { value: row.valueBefore, formula: row.formulaBefore } : row.valueBefore,
    after: row.kind === "formula" ? { value: row.valueAfter, formula: row.formulaAfter } : row.valueAfter,
    // The xlsx diff reports kind "value" for a formula cell only when its formula text is
    // unchanged (relative to any row/column shift); requiring an unchanged number format too
    // keeps a hand-reformatted formula cell from being waved through as a recalc.
    derivable: row.kind === "value" && isFormulaCell && row.numFmtBefore === row.numFmtAfter,
    detail: { ...row },
  };
}

/** The text cells of every sheet, by sheet name: what a row label is read from. */
function textCellsOf(book: WorkbookSnapshot): LabelCells {
  const built = new Map<string, Map<string, unknown>>();
  return (name) => {
    const hit = built.get(name);
    if (hit !== undefined) return hit;
    const sheet = book.sheets.findLast((sh) => sh.name === name);
    if (sheet === undefined) return undefined;
    const text = new Map<string, unknown>();
    for (const [address, c] of sheet.cells) if (typeof c.value === "string") text.set(address, c.value);
    built.set(name, text);
    return text;
  };
}

/** `limits`: where `diff` stops comparing cell by cell; tests pass smaller ones. */
export function createXlsxLayer(deps: XlsxSnapshotDeps, limits: Required<ReadLimits> = DIFF_LIMITS): XlsxFormatLayer {
  /**
   * The one diff pass behind `diff` and `diffWithLabels`: same rows, and the after side's text cells from the parse it already did.
   */
  async function diffWithLabels(beforePath: string | null, afterPath: string | null, keep?: { memo: ParseMemo; beforeKey: string | null; afterKey: string | null }): Promise<{ rows: LayerDiffRow[]; labels: LabelCells | null; sheets?: SheetsChanged }> {
    // A parse is looked up in the caller's memo first, and what it threw is remembered too, so an unreadable version is tried once.
    const parse = (bytes: Uint8Array, key: string | null): WorkbookSnapshot => {
      if (keep === undefined || key === null) return readWorkbookSnapshot(bytes, limits);
      const hit = keep.memo.get(key);
      if (hit !== undefined) {
        if (hit.ok) return hit.value as WorkbookSnapshot;
        throw hit.error;
      }
      try {
        const value = readWorkbookSnapshot(bytes, limits);
        keep.memo.set(key, { ok: true, value });
        return value;
      } catch (error) {
        keep.memo.set(key, { ok: false, error });
        throw error;
      }
    };
    const only = (row: LayerDiffRow): { rows: LayerDiffRow[]; labels: LabelCells | null } => ({ rows: [row], labels: null });
    const a = beforePath === null ? null : await readFile(beforePath);
    const b = afterPath === null ? null : await readFile(afterPath);
    if (a === null && b === null) {
      return { rows: [], labels: null };
    }
    if (a !== null && b !== null && a.equals(b)) {
      return { rows: [], labels: null };
    }
    let before: WorkbookSnapshot | null;
    let after: WorkbookSnapshot | null = null;
    let reading: "before" | "after" = "before";
    try {
      before = a === null ? null : parse(a, keep?.beforeKey ?? null);
      reading = "after";
      after = b === null ? null : parse(b, keep?.afterKey ?? null);
    } catch (error) {
      if (a !== null && b !== null && (await onlyResaveNoise(a, b, limits.maxUnzippedBytes))) {
        return { rows: [], labels: null };
      }
      const empty = Buffer.alloc(0);
      if (error instanceof WorkbookTooLarge) {
        return only(wholeFileRow(TOO_LARGE, a ?? empty, b ?? empty, { limit: error.limit }));
      }
      return only(wholeFileRow(FILE_CHANGED, a ?? empty, b ?? empty, { unreadable: unreadableReason(error), unreadableSide: reading }));
    }
    const dateSystem = (after ?? before)!.dateSystem;
    const beforeNames = new Set((before?.sheets ?? []).map((s) => s.name));
    const afterNames = new Set((after?.sheets ?? []).map((s) => s.name));
    const sheets: SheetsChanged = { added: [...afterNames].filter((n) => !beforeNames.has(n)), removed: [...beforeNames].filter((n) => !afterNames.has(n)) };
    const rows = diffWorkbooks(before ?? emptyLike(after!), after ?? emptyLike(before!)).map((row) => {
      const layerRow = toLayerRow(row);
      // Only a 1904 book is tagged, so a 1900 row's detail is what it always was.
      return dateSystem === 1904 ? { ...layerRow, detail: { ...layerRow.detail, dateSystem } } : layerRow;
    });
    if (rows.length > 0) {
      return { rows, labels: after === null ? null : textCellsOf(after), sheets };
    }
    if (a === null || b === null) {
      return only(wholeFileRow(FILE_CHANGED, a ?? Buffer.alloc(0), b ?? Buffer.alloc(0), a === null ? { added: true } : { removed: true }));
    }
    // A sheet with no cells appearing or going away leaves no cell row, but it is not "no cell changed".
    const sheetsAdded = sheets.added;
    const sheetsRemoved = sheets.removed;
    if (sheetsAdded.length > 0 || sheetsRemoved.length > 0) {
      return { ...only(wholeFileRow(FILE_CHANGED, a, b, { sheetsAdded, sheetsRemoved })), sheets };
    }
    return (await onlyResaveNoise(a, b, limits.maxUnzippedBytes)) ? { rows: [], labels: null } : only(wholeFileRow(FILE_CHANGED, a, b, { cellsUnchanged: true }));
  }

  return {
    name: "xlsx",

    accepts(filePath) {
      return /\.xls[xm]$/i.test(filePath);
    },

    async snapshot(sourcePath, destPath): Promise<SnapshotMode> {
      if (!existsSync(sourcePath)) {
        return "missing";
      }
      // Excel for Mac has no save-a-copy verb: save-as moves the open window onto the copy and
      // reverting it reloads the original from disk, losing the user's unsaved edits either way.
      // The disk bytes alone would miss those edits, so the only lossless answer is to refuse
      // and leave the window exactly as it is.
      if ((await deps.openState(sourcePath)) === "unsaved") {
        const verdict: RecalcVerdict = deps.recalcOnly ? await deps.recalcOnly(sourcePath) : { kind: "unverified" };
        // Recalculation only: the file's bytes carry every input, so the copy is a faithful baseline.
        if (verdict.kind !== "recalc-only") {
          throw new SnapshotRefusal(UNSAVED_CHANGES_OPEN, unsavedChangesMessage(basename(sourcePath), verdict.kind === "differs" ? verdict.cell : undefined));
        }
      }
      return copySnapshot(sourcePath, destPath);
    },

    /**
     * Equal bytes diff to nothing without being parsed, and so do bytes that differ only in
     * `docProps/` (Excel's save timestamps and app metadata). A workbook past `DIFF_LIMITS` on
     * either side is one "too large" row, and one the reader can't make sense of is one "file
     * changed" row saying so, never an error out of submit. Bytes that differ with no cell
     * differing (column widths, other parts) are one "file changed" row, and so is a workbook with
     * no cells appearing or going away, so no byte change goes unreported.
     */
    async diff(beforePath, afterPath) {
      return (await diffWithLabels(beforePath, afterPath)).rows;
    },

    diffWithLabels,

    async summarizeNew(afterPath) {
      const b = await readFile(afterPath);
      let after: WorkbookSnapshot;
      try {
        after = readWorkbookSnapshot(b, limits);
      } catch {
        return null;
      }
      let cells = 0;
      let errors = 0;
      let brokenRefs = 0;
      for (const sheet of after.sheets) {
        for (const cell of sheet.cells.values()) {
          cells += 1;
          if (isCellError(cell.value)) errors += 1;
          if (typeof cell.formula === "string" && /#REF!/i.test(cell.formula.replace(/"(?:[^"]|"")*"/g, '""'))) brokenRefs += 1;
        }
      }
      if (cells === 0) {
        return null;
      }
      return wholeFileRow(NEW_FILE, Buffer.alloc(0), b, { sheets: after.sheets.length, cells, errors, brokenRefs });
    },

    describe(row) {
      if (row.kind === TOO_LARGE) {
        return `workbook changed, but it's too large to compare cell by cell (${String(row.detail.limit)}); open it to check`;
      }
      if (row.kind === NEW_FILE) {
        const { sheets, cells, errors, brokenRefs } = row.detail as { sheets: number; cells: number; errors?: number; brokenRefs?: number };
        const found = [
          errors ? `${errors} error ${errors === 1 ? "value" : "values"}` : "",
          brokenRefs ? `${brokenRefs} broken ${brokenRefs === 1 ? "reference" : "references"}` : "",
        ].filter(Boolean);
        return `new workbook: ${sheets} ${sheets === 1 ? "sheet" : "sheets"}, ${cells} ${cells === 1 ? "cell" : "cells"}` +
          (found.length > 0 ? ` (${found.join(", ")})` : "");
      }
      if (row.kind === FILE_CHANGED && typeof row.detail.unreadable === "string") {
        return "CoCheck can't read this file; open it in Excel to check it still opens";
      }
      if (row.kind === FILE_CHANGED && row.detail.added === true) {
        return "new workbook, with no cells yet";
      }
      if (row.kind === FILE_CHANGED && row.detail.removed === true) {
        return "workbook deleted (it had no cells)";
      }
      if (row.kind === FILE_CHANGED && (Array.isArray(row.detail.sheetsAdded) || Array.isArray(row.detail.sheetsRemoved))) {
        const names = (key: string) => (row.detail[key] as string[]).map((n) => `"${n}"`).join(", ");
        const added = (row.detail.sheetsAdded as string[]).length > 0 ? `sheet ${names("sheetsAdded")} added (no cells)` : "";
        const removed = (row.detail.sheetsRemoved as string[]).length > 0 ? `sheet ${names("sheetsRemoved")} removed (no cells)` : "";
        return `workbook changed: ${[added, removed].filter(Boolean).join("; ")}`;
      }
      if (row.kind === FILE_CHANGED) {
        return "workbook changed, but no cell did (column widths, formatting or other parts of the file); open it to check";
      }
      const d = row.detail as unknown as DiffRow;
      if (d.kind === "structure") {
        return `${d.sheet} ${d.cell}: ${d.note ?? "structure changed"}`;
      }
      if (d.kind === "formula" && d.expectedFormulaAfterShift !== undefined && typeof d.formulaAfter === "string") {
        return `${row.location}: formula would have become =${d.expectedFormulaAfterShift} with the row/column shift; ` +
          `now =${d.formulaAfter} (was ${shownValue(d.valueBefore ?? null)}, now ${shownValue(d.valueAfter ?? null)})`;
      }
      if (d.kind === "formula") {
        return `${row.location}: was ${sideInWords(d.formulaBefore, d.valueBefore)}, now ${sideInWords(d.formulaAfter, d.valueAfter)}`;
      }
      if (d.numFmtBefore !== undefined && d.numFmtAfter !== undefined && d.numFmtBefore !== d.numFmtAfter &&
        JSON.stringify(d.valueBefore) === JSON.stringify(d.valueAfter)) {
        return `${row.location}: number format ${JSON.stringify(d.numFmtBefore)} -> ${JSON.stringify(d.numFmtAfter)}`;
      }
      return `${row.location}: ${shownValue(d.valueBefore ?? null)} -> ${shownValue(d.valueAfter ?? null)}`;
    },

    /**
     * A host-hook op touches exactly the cells it recorded in `hookCells`, on its own file; a whole-file row (too large,
     * file changed) is touched by every hook op on the file. Any other op touches nothing.
     */
    touches(op: LayerOp, filePath, row) {
      return touchedIndex(op, filePath, row) !== undefined;
    },

    /**
     * A touching hook op explains a cell row only when the cell's after-state is what it recorded (see `written.ts` for how
     * values and formulas compare): the cell's `hash` in `hookCells` must hold. A structure row is explained by touching.
     */
    explains(op: LayerOp, filePath, row) {
      const index = touchedIndex(op, filePath, row);
      if (index === undefined || row.kind === TOO_LARGE || row.kind === FILE_CHANGED) {
        return false;
      }
      const dd = row.detail as unknown as DiffRow;
      return dd.kind === "structure" || holdsHash(hookCellsOf(op)[index]?.hash, dd.valueAfter, dd.formulaAfter);
    },

    /**
     * The same answer as `ops.filter((op) => touches(op, filePath, row))`, without asking every op about every row.
     * The host-hook ops of the file are indexed by the cells they name; any other op touches nothing.
     */
    touchFinder(ops: LayerOp[], filePath: string) {
      const file = normalizePathForCompare(filePath);
      const hookOps: number[] = [];
      const byCell = new Map<string, number[]>();
      ops.forEach((op, i) => {
        if (!isHookOp(op)) return;
        if (opPathOf(op) === undefined || opPathOf(op) !== file) return;
        hookOps.push(i);
        for (const k of hookCellIndex(op).keys()) {
          const list = byCell.get(k);
          if (list) list.push(i);
          else byCell.set(k, [i]);
        }
      });
      return (row: LayerDiffRow): LayerOp[] => {
        const wholeFile = row.kind === TOO_LARGE || row.kind === FILE_CHANGED;
        let hit: number[];
        if (wholeFile) hit = hookOps;
        else {
          const dd = row.detail as unknown as DiffRow;
          hit = byCell.get(cellKey(dd.sheet, dd.cell)) ?? [];
        }
        return hit.map((i) => ops[i]!);
      };
    },

    async restate(snapshotPath, row) {
      if (row.kind === TOO_LARGE || row.kind === FILE_CHANGED) {
        return { ...row, after: snapshotPath === null ? null : hashOf(await readFile(snapshotPath)) };
      }
      const d = row.detail as unknown as DiffRow;
      if (d.kind === "structure") {
        return row;
      }
      const book = await load(snapshotPath);
      const cell = book?.sheets.find((s) => s.name === d.sheet)?.cells.get(normalizeCell(afterAddress(d.cell)));
      const valueAfter = cell?.value ?? null;
      const formulaAfter = cell?.formula ?? null;
      return {
        ...row,
        after: formulaAfter !== null ? { value: valueAfter, formula: formulaAfter } : valueAfter,
        detail: { ...row.detail, valueAfter, formulaAfter },
      };
    },
  };
}

/** The position of `row`'s cell in the hook op's `hookCells`, or undefined when the op didn't record it (or isn't a hook op on this file). */
function touchedIndex(op: LayerOp, filePath: string, row: LayerDiffRow): number | undefined {
  if (!isHookOp(op) || opPathOf(op) === undefined || opPathOf(op) !== filePathOf(filePath)) {
    return undefined;
  }
  if (row.kind === TOO_LARGE || row.kind === FILE_CHANGED) return 0;
  const dd = row.detail as unknown as DiffRow;
  return hookCellIndex(op).get(cellKey(dd.sheet, dd.cell));
}
