// Core never draws a state a connector reads. The rule is structural, not a list of endings: a state is not drawn by core's picture
// tier, the /preview/ route or the picture-crop route when its row has a `connector`, when a known connector (built-in or installed) claims its file, or
// when it shares bytes with such a state. "Claims" is any known manifest's `matches.extensions`, read at view time, enabled for that type or not: a
// connector the person turned off for a type still owns how that type is seen (CoCheck's own picture of it would be something the app didn't draw).
// Every other file keeps the picture it had.
import path from "node:path";
import { knownConnectors } from "./builtins.ts";

/** The endings the known connectors claim now, lower-case with the dot (multi-dot endings kept whole). Never throws: an unreadable list claims nothing. */
export function claimedEndings(home: string | undefined): string[] {
  try {
    return [...new Set(knownConnectors(home).flatMap(({ manifest }) => manifest.matches.extensions ?? []).map((e) => e.toLowerCase()).filter((e) => e.length > 1))];
  } catch {
    return [];
  }
}

/** Whether a known connector claims this file, by its name's ending. Reads the manifests once per call of the outer function. */
export function claimedFile(home: string | undefined): (file: string) => boolean {
  const endings = claimedEndings(home);
  return (file) => {
    const name = path.basename(file.replace(/\\/g, "/")).toLowerCase();
    return endings.some((e) => name.endsWith(e));
  };
}

export interface StateRow {
  filePath: string;
  sha256: string;
  prevSha256: string | null;
  connector: string | null | undefined;
}

/**
 * The states of a task core may not draw: every state (either side) of a row with a `connector` or a claimed file, so a hash shared with such a row is
 * blocked under every name. `file` answers for a file name alone.
 */
export function noCorePicture(home: string | undefined, rows: readonly StateRow[]): { file: (file: string) => boolean; sha: (sha: string | null) => boolean } {
  const claimed = claimedFile(home);
  const blocked = new Set<string>();
  for (const r of rows) {
    if ((r.connector ?? null) === null && !claimed(r.filePath)) continue;
    blocked.add(r.sha256);
    if (r.prevSha256 !== null) blocked.add(r.prevSha256);
  }
  return { file: claimed, sha: (sha) => sha !== null && blocked.has(sha) };
}
