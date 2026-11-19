// Bring back a withheld helper field from the host's own transcript, on the person's click, for that view only.
// The ledger holds only the field name, the rule family, the sha256 of the raw text and the locator (transcript file and call id). This reads the
// transcript (read only), and returns the text only when its sha256 equals the recorded one. It writes nothing: no ledger, cache or log.
// Anything wrong (no locator, a path outside the profile root, a link that leads out, a missing file, a hash that differs) returns undefined.
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { findProfile } from "./hosts/index.ts";
import type { WithheldRecord } from "./tool-label.ts";

/** True when `file` resolves to a regular `.jsonl` file whose real path is inside the real `root`. */
function underRoot(file: string, root: string): string | undefined {
  try {
    if (!path.isAbsolute(file) || !path.isAbsolute(root) || !file.endsWith(".jsonl")) return undefined;
    const real = realpathSync(file);
    const realRoot = realpathSync(root);
    const rel = path.relative(realRoot, real);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return lstatSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The text of the withheld `field`, or undefined. Never throws. `root` is the host's profile root (where its transcripts live). */
export async function revealWithheld(field: string, record: WithheldRecord | undefined, root: string, host: string | null | undefined): Promise<string | undefined> {
  try {
    const loc = record?.locator;
    if (record === undefined || loc === undefined || typeof loc.file !== "string" || typeof loc.id !== "string" || loc.id === "") return undefined;
    const reader = findProfile(host)?.reveal;
    if (reader === undefined) return undefined;
    const real = underRoot(loc.file, root);
    if (real === undefined) return undefined;
    const text = await reader.fieldText(real, loc.id, field);
    if (typeof text !== "string") return undefined;
    return createHash("sha256").update(text).digest("hex") === record.sha256 ? text : undefined;
  } catch {
    return undefined;
  }
}
