import path from "node:path";
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "./home-perms.ts";

/**
 * The review page's preferences, kept per install in `<home>/preferences.json` (owner-only) and served by the review process, not
 * the page's localStorage: the page's origin changes whenever the kept port is taken, and a new origin would forget the choice.
 * Known keys: `railOrder` ("oldest-first" | "newest-first") and `clean` (boolean). Keys this build does not know are kept.
 * `seenNew` ({"<task>": [stop ids]}): the steps whose "New since you signed off" mark the person opened and left. It is written
 * one step at a time by the patch `seen: {task, stop}`, never replaced whole; the newest MAX_SEEN_TASKS tasks are kept.
 */
type RailOrder = "oldest-first" | "newest-first";
export interface Preferences { railOrder: RailOrder; clean?: boolean }

const FILE = "preferences.json";
const MAX_SEEN_TASKS = 200, MAX_SEEN_STOPS = 5000;
const DEFAULTS: Preferences = { railOrder: "oldest-first" };

function load(home: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(home, FILE), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {}; // a missing or unreadable file means defaults
  }
}

/** The full object: the file's own keys, with each known key that holds a bad value (or none) back at its default. */
export function readPreferences(home: string): Record<string, unknown> & Preferences {
  const file = load(home);
  const out: Record<string, unknown> = { ...file, railOrder: file.railOrder === "newest-first" ? "newest-first" : DEFAULTS.railOrder };
  if (typeof file.clean !== "boolean") delete out.clean;
  return out as Record<string, unknown> & Preferences;
}

/** Merges the known keys of `patch` into the file and gives the full object, or `{ error }` when a known key holds a bad value (nothing is written then). */
export function updatePreferences(home: string, patch: Record<string, unknown>): { prefs: Record<string, unknown> & Preferences } | { error: string } {
  if ("railOrder" in patch && patch.railOrder !== "oldest-first" && patch.railOrder !== "newest-first") return { error: 'railOrder must be "oldest-first" or "newest-first"' };
  if ("clean" in patch && typeof patch.clean !== "boolean") return { error: "clean must be true or false" };
  const seen = patch.seen as { task?: unknown; stop?: unknown } | undefined;
  if ("seen" in patch && (seen === null || typeof seen !== "object" || !Number.isInteger(seen.task) || (seen.task as number) < 1 || typeof seen.stop !== "string" || seen.stop.length < 1 || seen.stop.length > 200)) return { error: "seen must be {task, stop}: a task number and a step id" };
  const next: Record<string, unknown> = { ...load(home) };
  if (seen !== undefined) {
    const was = next.seenNew !== null && typeof next.seenNew === "object" && !Array.isArray(next.seenNew) ? (next.seenNew as Record<string, unknown>) : {};
    const key = String(seen.task), list = Array.isArray(was[key]) ? (was[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (!list.includes(seen.stop as string)) list.push(seen.stop as string);
    // The task just written moves to the end, so the oldest tasks are the ones dropped past the cap.
    const rest = Object.entries(was).filter(([k]) => k !== key);
    next.seenNew = Object.fromEntries([...rest.slice(Math.max(0, rest.length - (MAX_SEEN_TASKS - 1))), [key, list.slice(-MAX_SEEN_STOPS)]]);
  }
  if ("railOrder" in patch) next.railOrder = patch.railOrder;
  if ("clean" in patch) next.clean = patch.clean;
  writeFileAtomicSync(path.join(home, FILE), JSON.stringify(next, null, 2) + "\n");
  return { prefs: readPreferences(home) };
}
