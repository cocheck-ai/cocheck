import path from "node:path";
import { pdfHelperAvailable, readPdfOutcome } from "./render/pdf-helper.ts";
import type { ChangeInfo } from "./render/types.ts";

/**
 * "Nothing is hidden" (docs/timeline.md): CoCheck states what it observed and never judges a file. The only claim about a file state is
 * "CoCheck could not open the <side> version of <file> (<reason>)", and it comes from a failure of the very reader that draws that file's view,
 * on those exact bytes. A file kind with no reader, a reader that was not run, a timeout and an unavailable reader make no such claim.
 */

/** The largest state the view route reads; a larger one is not opened by anything, so it is not claimed about. */
export const OPEN_CAP_BYTES = 25 * 1024 * 1024;

export type Side = "before" | "after";

/** Locked is a reason inside the sentence, never a claim of its own. */
const LOCKED = "it is locked with a password";

/** What one reader said about one state: it opened, it failed with a reason, or it said nothing (no reader, not run, timeout, unavailable). */
export type ReadResult = { opened: true } | { failed: string } | { silent: true };
const OPENED: ReadResult = { opened: true };
const SILENT: ReadResult = { silent: true };

const ext = (file: string): string => path.extname(file).toLowerCase();

/** The pdf.js reader the view reads pages with (only where the view is drawn: the page drawer is here). A timeout is silent; so is a missing drawer. */
export async function readPdf(bytes: Buffer): Promise<ReadResult> {
  if (!pdfHelperAvailable()) return SILENT;
  const r = await readPdfOutcome(bytes);
  if (r.pages !== null) return OPENED;
  if (r.error === "timeout") return SILENT;
  return { failed: bytes.includes("/Encrypt") ? LOCKED : "the PDF reader could not open it" };
}

/** The reader the view of this file kind uses, run on the stored bytes. Throws only on a bug in a reader; the caller turns that into a caveat. */
export async function readState(file: string, bytes: Buffer): Promise<ReadResult> {
  const e = ext(file);
  if (e === ".pdf") return readPdf(bytes);
  return SILENT;
}

/** The B sentence. The one wording, used by the note and by the view. */
/** The earlier state is the "previous version" in every sentence the page shows; the later one stays "after". */
export const versionWord = (side: Side): string => (side === "before" ? "previous" : "after");
export const couldNotOpen = (file: string, side: Side, why: string): string => `CoCheck could not open the ${versionWord(side)} version of ${file} (${why}).`;

/** The A sentence, from the hook record's failure event. With the host's error text it quotes it; a record without one says so. */
export type ChangeKind = "created" | "modified" | "deleted";
/** What the call did to the file, in the change's own verb. */
const VERB: Record<ChangeKind, string> = { created: "created", deleted: "deleted", modified: "changed" };
export const callFailed = (file: string, kind: ChangeKind = "modified", error: string | null = null): string =>
  error !== null && error.trim() !== ""
    ? `The call that ${VERB[kind]} ${file} failed. The output said: ${error.trim()}`
    : `The call that ${VERB[kind]} ${file} failed, with no error text or exit code.`;
/** A change several open calls are credited with, of which some failed: names the failed call(s) and says the makers can't be told apart. */
export const callFailedShared = (file: string, kind: ChangeKind, who: readonly string[], error: string | null = null): string => {
  const names = who.length <= 1 ? (who[0] ?? "A call") : `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`;
  const head = `A call by ${names} failed while other calls were open. CoCheck can't tell which of them ${VERB[kind]} ${file}.`;
  return error !== null && error.trim() !== "" ? `${head} The output said: ${error.trim()}` : head;
};
export const callFailedAndUnopenable = (file: string, kind: ChangeKind = "modified"): string => `The call that ${VERB[kind]} ${file} failed, and CoCheck could not open the file it left.`;

/**
 * The change as a one-sided drawing: the readable side drawn in full, the other side named in the caveats. `side` is the side that
 * could not be opened; the readable one is drawn the way a created (after only) or deleted (before only) file is.
 */
export function readableSideOnly(info: ChangeInfo, side: Side, sentence: string): ChangeInfo {
  return { ...info, kind: side === "before" ? "created" : "deleted", unreadable: { side, sentence }, missing: [...(info.missing ?? []), sentence] };
}
