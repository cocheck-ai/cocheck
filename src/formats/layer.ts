import { copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The format-neutral layer interface the review loop (`src/tasks.ts`) drives. A layer owns one
 * file format end to end: how to capture a file's state (`snapshot`), how to compare two captured
 * states (`diff`), how to say a diff row in words (`describe`), which logged ops wrote a given
 * row's location (`touches`) and whether the row still holds what an op wrote (`explains`) - only
 * the layer knows its tools' argument shapes. The task store never looks
 * inside a row beyond `location`, `kind`, `before`, `after` and `derivable`, so a second layer
 * (text, CSV, a connector's own) plugs in without touching it.
 */

/**
 * How a snapshot's bytes were captured. `copy`: a byte copy of the file on disk (closed, or open
 * with no unsaved edits). `missing`: nothing exists at the path, so the snapshot is "empty".
 * (Round-1 ledgers may also hold `excel-save-copy`, a path since removed; see `SnapshotRefusal`.)
 */
/**
 * How a snapshot was captured. `fingerprint`: no copy was kept, `snapshotPath` is empty and `sha256`
 * holds the file's fingerprint (see `src/fingerprint.ts`); the folder watch takes these for files no CoCheck call touched.
 */
export type SnapshotMode = "copy" | "missing" | "fingerprint";

/**
 * Thrown by `snapshot` when the file's state can't be captured without changing what the user
 * sees - e.g. a file open in its app with unsaved edits, which the app can only copy by
 * save-as, and save-as moves the open window onto the copy and drops the edits from the original.
 * `code` is a stable error code the task store passes through to the caller unchanged.
 */
export class SnapshotRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A logged op as a layer sees it when deciding whether it explains a row. */
export interface LayerOp {
  opId: number;
  tool: string;
  args: Record<string, unknown>;
  intent: string;
  client: string | null;
}

export interface LayerDiffRow {
  /** Where in the file the change is; stable within a file, e.g. "Sheet1!B3" for a spreadsheet cell. */
  location: string;
  /** Layer-defined change kind, e.g. "value" | "formula" | "structure" for a spreadsheet layer. */
  kind: string;
  before: unknown;
  after: unknown;
  /**
   * True when, absent any op that wrote this location, the change is still fully accounted for
   * as a downstream consequence of other changes (a spreadsheet: a formula cell whose formula text and
   * number format are unchanged but whose cached result moved). Such a row is `derived`, not
   * `unlogged`.
   */
  derivable: boolean;
  /**
   * True for a row about the whole file rather than a location in it (a spreadsheet too large
   * to compare cell by cell, or one whose bytes changed with no cell changing). No op can be
   * checked against such a row, so it's always `unlogged`; `touches` says which ops wrote the file,
   * and the row names them.
   */
  wholeFile?: boolean;
  /** The layer's own full row, stored verbatim for later review. */
  detail: Record<string, unknown>;
}

export interface FormatLayer {
  /** Stable layer id stored with every snapshot and review row, e.g. "files". */
  readonly name: string;
  /** Whether this layer handles the file at `filePath`. */
  accepts(filePath: string): boolean;
  /** Captures `sourcePath`'s current state at `destPath`. */
  snapshot(sourcePath: string, destPath: string): Promise<SnapshotMode>;
  /** Diffs two snapshots; `null` on either side means that side was `missing` (empty). */
  diff(beforePath: string | null, afterPath: string | null): Promise<LayerDiffRow[]>;
  /** One-line human description of a row. */
  describe(row: LayerDiffRow): string;
  /** Whether `op` wrote `row`'s location in `filePath`, whatever it wrote there. */
  touches(op: LayerOp, filePath: string, row: LayerDiffRow): boolean;
  /**
   * Whether `op` explains `row`: it touches the row's location and the row's after-state is what
   * the op wrote. An op that touches a row it doesn't explain was overwritten by something else.
   */
  explains(op: LayerOp, filePath: string, row: LayerDiffRow): boolean;
  /**
   * `(row) => ops.filter((op) => touches(op, filePath, row))` for one file, built once so a large change is not
   * rows x ops `touches` calls. Optional; the task store falls back to filtering.
   */
  touchFinder?(ops: LayerOp[], filePath: string): (row: LayerDiffRow) => LayerOp[];
  /**
   * `row` with its after-state replaced by the state at `row.location` in the snapshot at
   * `snapshotPath` (`null`: a missing file). Lets a caller ask `explains` about a location's
   * current contents, e.g. whether a fix still holds.
   */
  restate(snapshotPath: string | null, row: LayerDiffRow): Promise<LayerDiffRow>;
  /**
   * One whole-file row summarizing the file at `afterPath`, for a file that first appeared in a
   * task with no CoCheck op behind it (replacing its per-cell rows). `null`: no summary, keep the
   * per-cell rows. Optional.
   */
  summarizeNew?(afterPath: string): Promise<LayerDiffRow | null>;
}

/** One diff row with no logged writer behind it: `detail` always carries the row's own `kind`. */
export const diffRow = (location: string, kind: string, before: unknown, after: unknown, detail: Record<string, unknown> = {}): LayerDiffRow => ({
  location,
  kind,
  before,
  after,
  derivable: false,
  detail: { kind, ...detail },
});

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Shortens long text so a description stays one readable line. */
export function clip(value: unknown): string {
  const flat = String(value ?? "").replace(/\s*\n\s*/g, " / ");
  return `'${flat.length > 80 ? `${flat.slice(0, 77)}...` : flat}'`;
}

/** Byte-copies `source` to `dest` (making its folder), or answers "missing" when `source` is not there. */
export async function copySnapshot(source: string, dest: string): Promise<SnapshotMode> {
  if (!existsSync(source)) {
    return "missing";
  }
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(source, dest);
  return "copy";
}
