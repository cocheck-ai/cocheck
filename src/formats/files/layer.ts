import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { clip, copySnapshot, diffRow, sha256Hex as hashOf, sizeLabel, type FormatLayer, type LayerDiffRow, type SnapshotMode } from "../layer.ts";
import { alignSequences } from "./align.ts";
import { parseCsv } from "./csv.ts";
import { isTrackedFolderFile, isWatchedFolderFile } from "./scan.ts";
import { isTextBytes } from "./textlike.ts";

/**
 * The layer for everything in a task's folder that no other layer reads: `.txt`/`.md` by line, `.csv`
 * by row then cell (comma, semicolon or tab delimited), and any other file
 * as one "binary file changed" row, unless its stored bytes are plain text (UTF-8, no NUL byte in the first 64 KB), in which case it
 * reads by line whatever its extension. Text is decoded as UTF-8, UTF-16 or else Latin-1; byte order
 * mark, encoding, line-ending and final-newline changes are rows of their own, and a byte-level
 * change with no readable difference is a "file changed" row, so no change goes unreported.
 * CoCheck has no write tools for these formats, so `explains` is always false: every change this
 * layer finds is unlogged by definition, which is the point of watching the folder.
 */
type Kind = "text" | "csv" | "binary";

function kindOf(filePath: string): Kind {
  switch (extname(filePath).toLowerCase()) {
    case ".txt":
    case ".md":
      return "text";
    case ".csv":
      return "csv";
    default:
      return "binary";
  }
}

const row = diffRow;

/** How a text file's bytes were read: its encoding, and whether they began with a byte order mark. */
interface Decoded {
  text: string;
  encoding: "UTF-8" | "UTF-16LE" | "UTF-16BE" | "Latin-1";
  bom: boolean;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes a text file: a BOM decides UTF-8 or UTF-16; else zero bytes in every other position
 * mean BOM-less UTF-16; else strict UTF-8; else Latin-1, which maps every byte to a character,
 * so a change in a legacy-encoded file still reads as the characters that changed.
 */
function decode(bytes: Buffer): Decoded {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString("utf8"), encoding: "UTF-8", bom: true };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString("utf16le"), encoding: "UTF-16LE", bom: true };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: swap16(bytes.subarray(2)).toString("utf16le"), encoding: "UTF-16BE", bom: true };
  }
  const pairs = Math.floor(bytes.length / 2);
  if (pairs > 0) {
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < pairs * 2; i += 2) {
      if (bytes[i] === 0) evenZeros++;
      if (bytes[i + 1] === 0) oddZeros++;
    }
    if (oddZeros > pairs / 2 && evenZeros === 0) return { text: bytes.toString("utf16le"), encoding: "UTF-16LE", bom: false };
    if (evenZeros > pairs / 2 && oddZeros === 0) return { text: swap16(bytes).toString("utf16le"), encoding: "UTF-16BE", bom: false };
  }
  try {
    return { text: utf8.decode(bytes), encoding: "UTF-8", bom: false };
  } catch {
    return { text: bytes.toString("latin1"), encoding: "Latin-1", bom: false };
  }
}

function swap16(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  return out.swap16();
}

function lineEndings(text: string): string | null {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = [crlf && "CRLF", lf && "LF", cr && "CR"].filter((k): k is string => !!k);
  return kinds.length === 0 ? null : kinds.length === 1 ? kinds[0]! : "mixed";
}

/**
 * Rows for byte-level differences a line or cell diff can't see: byte order mark, encoding, line
 * endings, final newline.
 */
function formatRows(a: Decoded, b: Decoded): LayerDiffRow[] {
  const out: LayerDiffRow[] = [];
  if (a.bom !== b.bom) {
    out.push(row("file", b.bom ? "byte order mark added" : "byte order mark removed", a.bom, b.bom));
  }
  if (a.encoding !== b.encoding) {
    out.push(row("file", "encoding changed", a.encoding, b.encoding));
  }
  const [eolA, eolB] = [lineEndings(a.text), lineEndings(b.text)];
  if (eolA !== null && eolB !== null && eolA !== eolB) {
    out.push(row("file", "line endings changed", eolA, eolB));
  }
  const [endA, endB] = [/[\r\n]$/.test(a.text), /[\r\n]$/.test(b.text)];
  if (a.text !== "" && b.text !== "" && endA !== endB) {
    out.push(row("file", endB ? "final newline added" : "final newline removed", endA, endB));
  }
  return out;
}

/** Marks rows read from a non-UTF-8 file so their description says how the bytes were read. */
function readAs(rows: LayerDiffRow[], a: Decoded, b: Decoded): LayerDiffRow[] {
  const legacy = a.encoding === "Latin-1" || b.encoding === "Latin-1";
  return legacy ? rows.map((r) => ({ ...r, detail: { ...r.detail, readAs: "Latin-1" } })) : rows;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Row-aligned sequence diff shared by text lines and (in the Office connector's document layer) paragraphs. */
export function diffSequence(a: string[], b: string[], unit: "line" | "paragraph"): LayerDiffRow[] {
  return alignSequences(a, b).map(({ before, after }) => {
    if (before !== null && after !== null) {
      return row(`${unit} ${after + 1}`, `${unit} changed`, a[before], b[after], { beforeIndex: before + 1, afterIndex: after + 1 });
    }
    if (after !== null) {
      return row(`${unit} ${after + 1}`, `${unit} added`, null, b[after], { afterIndex: after + 1 });
    }
    return row(`${unit} ${before! + 1}`, `${unit} removed`, a[before!], null, { beforeIndex: before! + 1 });
  });
}


/** True when the first row looks like column names: every field non-empty and non-numeric. */
function looksLikeHeader(first: string[] | undefined): first is string[] {
  return first !== undefined && first.length > 0 && first.every((f) => f.trim() !== "" && Number.isNaN(Number(f)));
}

function diffCsv(a: string[][], b: string[][]): LayerDiffRow[] {
  const headerAfter = looksLikeHeader(b[0]) ? b[0] : undefined;
  const headerBefore = looksLikeHeader(a[0]) ? a[0] : undefined;
  const sig = (r: string[]) => JSON.stringify(r);
  const out: LayerDiffRow[] = [];
  for (const { before, after } of alignSequences(a.map(sig), b.map(sig))) {
    if (before !== null && after !== null) {
      const ra = a[before]!;
      const rb = b[after]!;
      for (let c = 0; c < Math.max(ra.length, rb.length); c++) {
        if ((ra[c] ?? null) === (rb[c] ?? null)) continue;
        const column = headerAfter?.[c] ?? headerBefore?.[c] ?? `${c + 1}`;
        out.push(row(`row ${after + 1}, column ${column}`, "cell", ra[c] ?? null, rb[c] ?? null, { row: after + 1, column, columnIndex: c + 1 }));
      }
    } else if (after !== null) {
      out.push(row(`row ${after + 1}`, "row added", null, b[after], { row: after + 1 }));
    } else {
      out.push(row(`row ${before! + 1}`, "row removed", a[before!], null, { row: before! + 1 }));
    }
  }
  return out;
}

/**
 * `generic`: CoCheck's core reading. Text, csv and the whole-file row only, for every watched file: a package a connector
 * reads is a whole file, its contents are its connector's to read. Without it the layer leaves the packages that have layers of their own to
 * them. The Office connector reads documents with its own layer on top of this one (under src/office/connector/, M1).
 */
export function createFilesLayer(opts: { generic?: boolean; wholeOnly?: boolean } = {}): FormatLayer {
  const generic = opts.generic === true;
  // wholeOnly: a state a connector reads is never listed by its lines or cells, whatever its bytes are: one whole-file row.
  const wholeOnly = opts.wholeOnly === true;
  return {
    name: "files",

    accepts(filePath) {
      // generic: every watched file (a connector's package too, as one whole-file row); the full layer leaves those packages to their own layers
      return generic ? isWatchedFolderFile(filePath) : isTrackedFolderFile(filePath);
    },

    async snapshot(sourcePath, destPath): Promise<SnapshotMode> {
      return copySnapshot(sourcePath, destPath);
    },

    async diff(beforePath, afterPath) {
      if (beforePath === null && afterPath === null) {
        return [];
      }
      if (beforePath === null) {
        return [row("file", "new file", null, null, { bytes: (await stat(afterPath!)).size })];
      }
      if (afterPath === null) {
        return [row("file", "file deleted", null, null, { bytes: (await stat(beforePath)).size })];
      }
      const [a, b] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
      if (a.equals(b)) {
        return [];
      }
      // A layer picks its granularity by the after side's name; both snapshots carry the same one.
      let kind: Kind = wholeOnly ? "binary" : kindOf(afterPath);
      if (!wholeOnly && kind === "binary" && isTextBytes(a) && isTextBytes(b)) kind = "text";
      const whole = (note: string) => [row("file", "file changed", hashOf(a), hashOf(b), { bytesBefore: a.length, bytesAfter: b.length, note })];
      // Bytes differ, so every path below returns at least one row.
      if (kind === "text" || kind === "csv") {
        const [da, db] = [decode(a), decode(b)];
        const content =
          kind === "text"
            ? diffSequence(splitLines(da.text), splitLines(db.text), "line")
            : diffCsv(parseCsv(da.text), parseCsv(db.text));
        const rows = [...readAs(content, da, db), ...formatRows(da, db)];
        return rows.length > 0 ? rows : whole("same readable contents; formatting or encoding differs");
      }
      return [row("file", "binary file changed", hashOf(a), hashOf(b), { bytesBefore: a.length, bytesAfter: b.length })];
    },

    describe(r) {
      const text = describeRow(r);
      return r.detail.readAs ? `${text} (not UTF-8; read as ${r.detail.readAs})` : text;
    },

    // No CoCheck tool writes text or CSV files, so no logged op can account for a change here.
    touches() {
      return false;
    },

    explains() {
      return false;
    },

    async restate(snapshotPath, row) {
      const withAfter = (after: unknown): LayerDiffRow => ({ ...row, after });
      if (snapshotPath === null) {
        return withAfter(null);
      }
      const bytes = await readFile(snapshotPath);
      const n = Number(/(\d+)/.exec(row.location)?.[1]) - 1;
      if (Number.isNaN(n)) {
        return withAfter(hashOf(bytes));
      }
      try {
        const kind = kindOf(snapshotPath);
        switch (kind === "binary" && isTextBytes(bytes) ? "text" : kind) {
          case "text":
            return withAfter(splitLines(decode(bytes).text)[n] ?? null);
          case "csv": {
            const record = parseCsv(decode(bytes).text)[n];
            const col = row.detail.columnIndex;
            return withAfter(record === undefined ? null : typeof col === "number" ? (record[col - 1] ?? null) : record);
          }
        }
      } catch {
        // unreadable: fall through to the whole-file state
      }
      return withAfter(hashOf(bytes));
    },
  };
}

/** The sentence a removed or added list item adds about the markers below it, with its leading period. */
const renumbered = (r: LayerDiffRow): string => (typeof r.detail.renumbered === "string" ? `. ${r.detail.renumbered}` : "");

function describeRow(r: LayerDiffRow): string {
  switch (r.kind) {
    case "new file":
      return `new file (${sizeLabel(Number(r.detail.bytes ?? 0))})`;
    case "file deleted":
      return "file deleted";
    case "binary file changed":
      return "file changed (contents differ; no readable detail for this file type)";
    case "cell":
      return `${r.location}: ${clip(r.before)} -> ${clip(r.after)}`;
    case "row added":
      return `${r.location} added: ${clip((r.after as string[]).join(", "))}`;
    case "row removed":
      return `${r.location} removed: ${clip((r.before as string[]).join(", "))}`;
    case "line added":
    case "paragraph added":
    case "paragraphs added":
      return `${r.location} added: ${clip(r.after)}${renumbered(r)}`;
    case "line removed":
    case "paragraph removed":
    case "paragraphs removed":
      return `${r.location} removed: ${clip(r.before)}${renumbered(r)}`;
    case "paragraph formatting changed":
      return `${r.kind}: ${(r.detail.changes as string[]).join("; ")}`;
    case "picture resized":
      return r.kind;
    case "picture moved":
      return "picture moved: within the paragraph";
    case "file changed":
      return `file changed (${String(r.detail.note)})`;
    case "byte order mark added":
    case "byte order mark removed":
    case "final newline added":
    case "final newline removed":
      return r.kind;
    case "encoding changed":
    case "line endings changed":
      return `${r.kind}: ${String(r.before)} -> ${String(r.after)}`;
    default:
      return `${r.location}: ${clip(r.before)} -> ${clip(r.after)}`;
  }
}
