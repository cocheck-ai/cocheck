import { readFile, stat } from "node:fs/promises";
import { clip, copySnapshot, diffRow, sha256Hex as hashOf, sizeLabel, type FormatLayer, type LayerDiffRow, type SnapshotMode } from "../../../formats/layer.ts";
import { diffDecks, numbersIn, unitValues } from "./diff.ts";
import { brokenLinks } from "./links.ts";
import { isDeckFile } from "../../../formats/files/scan.ts";
import { readDeck } from "./reader.ts";

/**
 * The layer for PowerPoint decks (`.pptx`, `.pptm`): a snapshot is a byte copy, a diff reads both
 * decks and compares them by slide and shape (text, table cells, chart cached values, notes,
 * hyperlink targets and tooltips, comments).
 * Only content is compared, so a resave that rewrites timestamps, ids, part names or run splits
 * produces no rows; parts the reader doesn't model (images, layouts, shape geometry) are not
 * compared (`SKIPPED_RELATIONSHIPS` in the reader lists every skipped part type). A deck that
 * can't be read falls back to one whole-file row so a change is
 * never silently dropped. No host hook records a deck's cells, so no op touches or explains a deck row: every deck change is
 * unlogged, which is the point of watching the folder.
 */

const wholeRow = (kind: string, before: unknown, after: unknown, detail: Record<string, unknown>): LayerDiffRow => diffRow("file", kind, before, after, detail);

/** A row for each link marked broken between the two decks: an item no op explains. */
function newlyBroken(a: Uint8Array, b: Uint8Array): LayerDiffRow[] {
  const was = brokenLinks(a);
  return [...brokenLinks(b)]
    .filter(([location, now]) => was.get(location)?.reason !== now.reason)
    .map(([location, now]) => ({ location, kind: "link broken", before: null, after: now.reason, derivable: false, detail: { kind: "link broken", linkId: now.linkId } }));
}

export function createPptxLayer(): FormatLayer {
  return {
    name: "pptx",

    accepts(filePath) {
      return isDeckFile(filePath);
    },

    async snapshot(sourcePath, destPath): Promise<SnapshotMode> {
      return copySnapshot(sourcePath, destPath);
    },

    async diff(beforePath, afterPath) {
      if (beforePath === null && afterPath === null) {
        return [];
      }
      if (beforePath === null) {
        const bytes = await readFile(afterPath!);
        let slides: number | undefined;
        try {
          slides = readDeck(bytes).slides.length;
        } catch {
          // an unreadable new deck keeps the size-only row
        }
        return [wholeRow("new file", null, null, { bytes: bytes.length, ...(slides === undefined ? {} : { slides }) })];
      }
      if (afterPath === null) {
        return [wholeRow("file deleted", null, null, { bytes: (await stat(beforePath)).size })];
      }
      const [a, b] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
      if (a.equals(b)) {
        return [];
      }
      try {
        return [...diffDecks(readDeck(a), readDeck(b)), ...newlyBroken(a, b)];
      } catch {
        // an unreadable deck on either side falls through to the whole-file row
      }
      return [wholeRow("binary file changed", hashOf(a), hashOf(b), { bytesBefore: a.length, bytesAfter: b.length })];
    },

    describe(r) {
      switch (r.kind) {
        case "new file":
          return typeof r.detail.slides === "number"
            ? `new deck: ${r.detail.slides} ${r.detail.slides === 1 ? "slide" : "slides"} (${sizeLabel(Number(r.detail.bytes ?? 0))})`
            : `new file (${sizeLabel(Number(r.detail.bytes ?? 0))})`;
        case "file deleted":
          return "file deleted";
        case "binary file changed":
          return "file changed (could not read the deck; contents differ)";
        case "hyperlink target changed":
        case "hyperlink tooltip changed": {
          const text = String(r.detail.linkText ?? "");
          const what = r.kind === "hyperlink target changed" ? "link" : "link tooltip";
          return `${r.location}: ${what}${text ? ` '${text}'` : ""} ${clip(r.before)} -> ${clip(r.after)}`;
        }
        case "hyperlink added":
        case "comment added":
          return `${r.location} ${r.kind}: ${clip(r.after)}`;
        case "hyperlink removed":
        case "comment removed":
          return `${r.location} ${r.kind}: ${clip(r.before)}`;
        case "shape moved":
        case "shape resized":
        case "shape moved and resized": {
          const noun = ({ chart: "Chart", table: "Table", group: "Group" } as Record<string, string>)[String(r.detail.shapeKind)] ?? "Shape";
          return `${noun} ${r.kind.slice("shape ".length)}`;
        }
        case "slide moved":
          return `${r.location}: moved from position ${String(r.before)} to ${String(r.after)}`;
        case "link broken":
          return `${r.location}: link broken, ${String(r.after)}`;
        case "number changed":
        case "number added":
        case "number removed":
          return `${r.location}: ${r.kind} ${clip(r.before)} -> ${clip(r.after)}`;
        case "shape added":
        case "slide added":
        case "table row added":
        case "table cell added":
        case "chart series added":
          return `${r.location} added: ${clip(r.after)}`;
        case "shape removed":
        case "slide removed":
        case "table row removed":
        case "table cell removed":
        case "chart series removed":
          return `${r.location} removed: ${clip(r.before)}`;
        default:
          return `${r.location}: ${clip(r.before)} -> ${clip(r.after)}`;
      }
    },

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
      try {
        const unit = row.detail.unit;
        const value = typeof unit === "string" ? unitValues(readDeck(bytes)).get(unit) : undefined;
        const n = row.detail.numberIndex;
        if (typeof n === "number") {
          return withAfter(typeof value === "string" ? (numbersIn(value)[n - 1] ?? null) : null);
        }
        if (typeof unit === "string") {
          return withAfter(value ?? null);
        }
      } catch {
        // unreadable: fall through to the whole-file state
      }
      return withAfter(hashOf(bytes));
    },
  };
}
