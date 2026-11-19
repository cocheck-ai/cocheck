// The hook's one generic test for "a connector reads this file", and the opaque layer the hook's TaskStore keeps
// claimed files with. The hook builds no format layer: which files are claimed comes from the connectors' manifests and the per-type
// setting (installed-match.ts connectorClaimsFor), never from an extension list in core.
import { readFile } from "node:fs/promises";
import { normalizePathForCompare } from "../paths.ts";
import { copySnapshot, sha256Hex, type FormatLayer, type LayerDiffRow, type LayerOp, type SnapshotMode } from "../formats/layer.ts";
import { builtinClaims } from "./builtins.ts";
import { connectorClaimsFor } from "./installed-match.ts";

/** Whether a connector (built-in or installed, enabled for the file's type) claims the file. */
export type Claimed = (file: string) => boolean;

/** The predicate for one CoCheck home: reads the manifests and the type setting once, then answers per file. Never throws. */
export function claimedFor(home: string | undefined): Claimed {
  let of: (file: string) => string | undefined;
  try {
    of = connectorClaimsFor(home, builtinClaims());
  } catch {
    of = () => undefined;
  }
  return (file) => of(file) !== undefined;
}

/**
 * The name written to `snapshots.layer` for a claimed file from now on. Opaque: nothing reads it to pick a reader; a TaskStore holding
 * the claimed layer uses it for every stored snapshot, whatever name an older row carries (a bare format name).
 */
export const CLAIMED_LAYER = "claimed";

const FILE_CHANGED = "file changed";

/** One row about the whole file: no location inside it, never explained by an op (the connector, not core, says what changed). */
function wholeFileRow(before: Buffer | null, after: Buffer | null): LayerDiffRow {
  const b = before ?? Buffer.alloc(0);
  const a = after ?? Buffer.alloc(0);
  return { location: "file", kind: FILE_CHANGED, before: sha256Hex(b), after: sha256Hex(a), derivable: false, wholeFile: true, detail: { kind: FILE_CHANGED, bytesBefore: b.length, bytesAfter: a.length } };
}

const isHookOp = (op: LayerOp): boolean => op.args.hookAdapter === 1;

/**
 * The layer the hook's TaskStore keeps claimed files with. Byte copies only; two states differ when their bytes do, as one whole-file
 * row; a hook op on the file touches that row (it may have written the file) and never explains it. No format is read.
 */
export function claimedLayer(claimed: Claimed): FormatLayer {
  return {
    name: CLAIMED_LAYER,
    accepts: (file) => claimed(file),
    snapshot: (source, dest): Promise<SnapshotMode> => copySnapshot(source, dest),
    async diff(beforePath, afterPath) {
      const before = beforePath === null ? null : await readFile(beforePath);
      const after = afterPath === null ? null : await readFile(afterPath);
      if (before === null && after === null) return [];
      if (before !== null && after !== null && before.equals(after)) return [];
      return [wholeFileRow(before, after)];
    },
    describe: () => "the file's bytes changed",
    touches: (op, file) => isHookOp(op) && typeof op.args.path === "string" && normalizePathForCompare(op.args.path) === normalizePathForCompare(file),
    explains: () => false,
    async restate(snapshotPath, row) {
      return { ...row, after: snapshotPath === null ? null : sha256Hex(await readFile(snapshotPath)) };
    },
  };
}

/** A zip's local file header signature. */
const ZIP_HEADER = [0x50, 0x4b, 0x03, 0x04];

/** Bytes a zip's end-of-central-directory record can sit back from the end: its 22 bytes plus the longest comment. */
const EOCD_SEARCH = 22 + 0xffff;

/**
 * Why a claimed file's bytes are not a whole file yet, or undefined. Generic, no format read: an empty file, or bytes that open as a zip
 * container (they start with a local file header) but hold no end-of-central-directory record, were cut short, by a writer still writing
 * or one that stopped.
 * Such a state is kept and credited like any other, but it is never the base a later change is compared against.
 */
export function cutShortReason(bytes: Uint8Array): string | undefined {
  // A writer that truncates the file before writing it leaves it empty for a moment.
  if (bytes.length === 0) return "the file is empty (cut short or still being written)";
  // Two or three bytes that begin a zip's local file header ("PK", "PK\x03") are a zip cut inside that header.
  if (bytes.length < 4) return bytes.length >= 2 && bytes.every((b, i) => b === ZIP_HEADER[i]) ? "the file ends inside its zip header (cut short or still being written)" : undefined;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return undefined;
  const from = Math.max(0, bytes.length - EOCD_SEARCH);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return undefined;
  }
  return "the file ends before its zip directory (cut short or still being written)";
}

/** Why bytes read from a claimed file are not one state of it (any format): the file moved while they were read. */
export const MOVED_WHILE_READ = "the file changed while it was being read (still being written)";
