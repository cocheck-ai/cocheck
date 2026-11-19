import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

/**
 * One identity. Every fingerprint CoCheck writes is the plain SHA-256 of the file's bytes, whatever its type. A pure
 * re-save is told apart from an edit by keeping both sides of a claimed file and asking its connector (P3), never by a filter here.
 */

/** The SHA-256 of a file, read as a stream so a large file is never held whole. */
export async function sha256Stream(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** How an outside change to a fingerprint-only file ranks: `deleted`, else `changed`. No file ending changes the class. */
type OutsideClass = "changed" | "deleted";

/** A deletion is `deleted`; every other outside change is a normal `changed` open item, for any file type. */
export function outsideClass(_filePath: string, deleted: boolean): OutsideClass {
  return deleted ? "deleted" : "changed";
}

/** What a change whose before-side has no bytes reads, for any file type and at normal priority. */
export const NO_BEFORE_WORDING = "changed or saved again; its earlier contents weren't kept";

/** The words of the one row an outside change gets, by its class. */
export function changedOutsideWording(cls: OutsideClass = "changed"): string {
  if (cls === "deleted") return "deleted outside CoCheck; its earlier contents weren't kept";
  return NO_BEFORE_WORDING;
}
