// Which connector is enabled for each file type. A connector's manifest declares the types it claims (`matches.extensions`); this
// module decides, per type, the one connector that is enabled for it, from CoCheck's default rule and the user's setting file
// `<home>/connector-types.json` ({"types": {".md": "my-notes", ".csv": null}}: a connector id, or null for "none"). The file is written only by
// `cocheck connector enable|disable` (connector-types-cli.ts) and read on every match, so the read is one small file and never throws.
//
// The default rule: a type is already served when an enabled connector claims it or CoCheck draws it itself (CORE_DRAWN_TYPES). A built-in claims
// its types from the start, so it is enabled for them; any other connector claiming a type already served starts disabled for it; a type nothing
// served goes to the connector that claims it (the first folder by name when two do). Built-in and installed connectors follow the same setting: the
// user can enable or disable any of them for any type it claims.
import { readFileSync } from "node:fs";
import path from "node:path";
import { shippedBuiltinTypes } from "./builtins.ts";

export const ENABLED_TYPES_FILE = "connector-types.json";

/**
 * The file types already served without any installed connector, by ending: the ones CoCheck draws itself (its line readers .txt .md .csv, the pdf
 * renderer and the picture endings the page shows as pictures, timeline/notes.ts PICTURE_FILE), and every type the shipped built-in connectors
 * claim, read from their manifests (not a hardcoded list). A connector claim on one of these, or on a longer ending of one
 * (".notes.md"), finds the type already served. Code and other text files are read by content, not by ending, so they are not here.
 * test/enabled-types-derived.test.ts pins the set against the shipped manifest files; test/connector-capture-claims.test.ts builds its expected set from the manifests' claims and the enabled-per-type setting.
 */
const CORE_OWN_TYPES: readonly string[] = [".txt", ".md", ".csv", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".heic", ".tif", ".tiff", ".bmp", ".webp"];
export const CORE_DRAWN_TYPES: readonly string[] = [...new Set([...CORE_OWN_TYPES, ...shippedBuiltinTypes()])];

/** A type is the claimed ending, lower-cased, as the matcher compares it. */
export const typeKey = (ext: string): string => ext.toLowerCase();

/** True when every file of this type, or some of them, is a file CoCheck draws itself: the type ends in a core ending, or a core ending ends in it. */
export const coreDraws = (type: string): boolean => type !== "" && CORE_DRAWN_TYPES.some((c) => type.endsWith(c) || c.endsWith(type));

export interface EnabledTypes {
  /** The user's choices: type to connector id, or null for none. Empty when the file is absent or unusable. */
  types: Record<string, string | null>;
  /** Set when the file exists but could not be read or is not valid; the default rule is used then. */
  warning?: string;
}

/** Reads the setting file. Absent: no choices, no warning. Unreadable or malformed: no choices and a warning. Never throws. */
export function readEnabledTypes(home: string | undefined): EnabledTypes {
  if (home === undefined) return { types: {} };
  const file = path.join(home, ENABLED_TYPES_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { types: {} };
    return { types: {}, warning: `warning: ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}); CoCheck uses its default connector for every type` };
  }
  const bad = { types: {}, warning: `warning: ${file} is not valid ({"types": {".ending": "connector id" or null}}); CoCheck uses its default connector for every type` };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return bad;
    const types = (parsed as { types?: unknown }).types;
    if (types === null || typeof types !== "object" || Array.isArray(types)) return bad;
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(types)) {
      if (v !== null && typeof v !== "string") return bad;
      out[typeKey(k)] = v;
    }
    return { types: out };
  } catch {
    return bad;
  }
}

export interface Claimant {
  id: string;
  builtin: boolean;
  /** The types it claims, as `typeKey` gives them. */
  types: readonly string[];
}

export interface TypeState {
  type: string;
  /** Every connector claiming the type: built-ins first in registration order, then installed ones by folder name. */
  claimants: Claimant[];
  /** The enabled connector's id, or undefined for none. */
  enabled: string | undefined;
  /** "setting" when the user's file decided, else "default". */
  by: "default" | "setting";
}

/** The connector CoCheck's default rule enables for `type`, among `claimants` (in their order). */
export function defaultEnabled(type: string, claimants: readonly Claimant[]): string | undefined {
  const mine = claimants.filter((c) => c.types.includes(type));
  const builtin = mine.find((c) => c.builtin);
  if (builtin !== undefined) return builtin.id;
  if (coreDraws(type)) return undefined;
  return mine[0]?.id;
}

/** The state of one type: the user's choice when it names a connector that claims the type (or null), else the default. */
export function stateOf(type: string, claimants: readonly Claimant[], setting: EnabledTypes): TypeState {
  const mine = claimants.filter((c) => c.types.includes(type));
  if (Object.hasOwn(setting.types, type)) {
    const chosen = setting.types[type];
    if (chosen === null) return { type, claimants: mine, enabled: undefined, by: "setting" };
    if (mine.some((c) => c.id === chosen)) return { type, claimants: mine, enabled: chosen, by: "setting" };
  }
  return { type, claimants: mine, enabled: defaultEnabled(type, claimants), by: "default" };
}

/** Every type any claimant claims, sorted, with its state. */
export function typeStates(claimants: readonly Claimant[], setting: EnabledTypes): TypeState[] {
  const types = [...new Set(claimants.flatMap((c) => c.types))].filter((t) => t !== "").sort();
  return types.map((t) => stateOf(t, claimants, setting));
}
