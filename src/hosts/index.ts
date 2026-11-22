// The host registry: the one place that lists the profiles. Lookups are functions, not a table built at load, so the profiles and the
// modules they import can load in any order. The built-in list is read at call time too: narration.ts imports this file and the profiles import narration.ts, so a module-level array would hit a profile before it is initialized.
import { loadHarnessFolder } from "./harnesses.ts";
import { matchesFingerprint } from "./shared.ts";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ToolEntry, ToolTable } from "./tool-classes.ts";
import type { HostCapabilities, HostKey, HostProfile } from "./types.ts";

export type { EventKind, HostCapabilities, HostKey, HostProfile, NarrationSource, PayloadFields, TrustRead } from "./types.ts";
export { MARKER } from "./types.ts";
export type { ToolClass, ToolEntry, ToolTable } from "./tool-classes.ts";

/** Every profile, in the order they are listed to the person: the built-in hosts, hosts added by `registerHost`, then outsider harnesses. */
export const allProfiles = (): readonly HostProfile[] => [...builtIn(), ...added, ...outsiders];

/** The registry: the profile modules, then the manifests that ship with CoCheck. */
// Listed in key order, whether a host is a profile module or a shipped manifest.
const builtIn = (): readonly HostProfile[] => [...shippedManifests()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
const moduleProfiles = (): readonly HostProfile[] => [];
const added: HostProfile[] = [];
let outsiders: HostProfile[] = [];
let outsiderErrors: string[] = [];

/**
 * The folder of built-in manifests: data, not code. It is `harnesses/` at the repo root when this module runs from src/hosts/, and `dist/harnesses`
 * when it runs from the built dist/hosts/ (scripts/build.mjs copies it there, as it does `connectors/`). Shipping a harness built in is a data change there.
 */
export const BUILTIN_HARNESSES_ROOT = import.meta.url.endsWith(".ts") ? path.join(import.meta.dirname, "..", "..", "harnesses") : path.join(import.meta.dirname, "..", "harnesses");
let shippedDir: string = BUILTIN_HARNESSES_ROOT;
let shipped: HostProfile[] | undefined;
function shippedManifests(): readonly HostProfile[] {
  if (shipped === undefined) {
    const loaded = loadHarnessFolder(shippedDir, "built-in", moduleProfiles().map((p) => p.key));
    // A built-in manifest that does not load is a defect of this build, not of the person's setup.
    if (loaded.errors.length > 0) throw new Error(`built-in harness manifest: ${loaded.errors[0]}`);
    shipped = loaded.profiles;
  }
  return shipped;
}

/** Points the built-in manifest folder somewhere else (a test), or back (undefined). */
export function setBuiltInHarnessDirForTest(dir: string | undefined): void {
  shippedDir = dir ?? BUILTIN_HARNESSES_ROOT;
  shipped = undefined;
}

/** The folder of the person's own harness manifests: `$COCHECK_HARNESS_DIR`, else `<data home>/harnesses`. */
export const outsiderHarnessDir = (env: NodeJS.ProcessEnv, home: string | undefined): string | undefined => env.COCHECK_HARNESS_DIR || process.env.COCHECK_HARNESS_DIR || (home === undefined ? undefined : path.join(home, "harnesses"));

/**
 * Loads the harnesses in `dir` as outsiders (replacing any loaded before) and returns one line per manifest skipped. Never throws: a manifest that does not
 * load is skipped, so it cannot stop another host's hook. An outsider's events never prove more than "inferred" (`HostProfile.trust`).
 */
export function loadOutsiderHarnesses(dir: string | undefined): string[] {
  try {
    const taken = [...builtIn(), ...added].map((p) => p.key);
    const loaded = dir === undefined ? { profiles: [], errors: [] } : loadHarnessFolder(dir, "outsider", taken);
    outsiders = loaded.profiles;
    outsiderErrors = loaded.errors;
  } catch (error) {
    outsiders = [];
    outsiderErrors = [`harnesses: ${error instanceof Error ? error.message : String(error)}`];
  }
  return outsiderErrors;
}

/** The lines for the manifests the last `loadOutsiderHarnesses` skipped. */
export const skippedHarnesses = (): readonly string[] => outsiderErrors;

/** Adds a profile after the built-in ones until the returned function is called. For tests that prove a new host needs no core edit. */
export function registerHost(profile: HostProfile): () => void {
  added.push(profile);
  return () => {
    const at = added.indexOf(profile);
    if (at >= 0) added.splice(at, 1);
  };
}

/** True when the host's profile declares the capability. A host with no profile has none. */
export const hasCapability = (host: string | null | undefined, cap: Exclude<keyof HostCapabilities, "failureEvent">): boolean => findProfile(host)?.capabilities[cap] === true;

export function isHostKey(v: unknown): v is HostKey {
  return allProfiles().some((p) => p.key === v);
}

/** The profile for a host key as stored on a record, or undefined when the key has none. */
export const findProfile = (key: string | null | undefined): HostProfile | undefined => allProfiles().find((x) => x.key === key);

/** The profile for a host key. Throws for a key with no profile. */
export function profileOf(key: string): HostProfile {
  const p = allProfiles().find((x) => x.key === key);
  if (p === undefined) throw new Error(`unknown hook host: ${String(key)}`);
  return p;
}

/** A stored tool name read the way the hook records it today: the host's own name for the tool (see `HostProfile.toolName`). */
export function toolNameOf(host: string | null | undefined, reported: string): string {
  const p = findProfile(host);
  return p?.toolName === undefined ? reported : p.toolName(reported, {});
}

/** The host a task is assumed to run under when nothing says otherwise: the default main lane, and the folder variable the hook falls back to. */
export const defaultProfile = (): HostProfile => profileWithExtra("install-default");

/** The profile that declares the named optional part (`HostProfile.extras`). Throws when no host does: a caller asks only for an extra the built-in hosts declare. */
export function profileWithExtra(name: string): HostProfile {
  const p = allProfiles().find((x) => x.extras?.includes(name) === true);
  if (p === undefined) throw new Error(`no host declares ${name}`);
  return p;
}

/** The host keys that have an installer, in the order they are listed to the person. */
export const installableKeys = (): string[] => allProfiles().filter((p) => p.install !== undefined).map((p) => p.key);

/** The environment variables hosts set to the project folder, in listing order. */
export const projectDirVars = (): string[] => allProfiles().flatMap((p) => (p.install?.projectDirEnv === undefined ? [] : [p.install.projectDirEnv]));

/**
 * True when a hook run of `host` carries the payload of a host that also runs this host's registration (a host that reads another's config):
 * the run records nothing (the reading host's own entry records). A host that reads foreign hooks itself is never skipped.
 * A built-in host's fingerprint decides on the payload shape alone. An outsider's fingerprint decides only when that outsider's own CoCheck hook
 * is installed for the payload's folder (`outsiderHookInstalled`): otherwise nothing else would record the run, so it is recorded as before.
 * The install check reads one small config file, and only for a payload that already matched an outsider's fingerprint.
 */
export function runsOtherHostsHook(host: string | null | undefined, payload: unknown, where?: { env: NodeJS.ProcessEnv; userHome: string }): boolean {
  if (hasCapability(host, "readsForeignHooks")) return false;
  return allProfiles().some(
    (p) => p.capabilities.readsForeignHooks && p.foreignHookFingerprint !== undefined && matchesFingerprint(p.foreignHookFingerprint, payload) && (p.trust !== "outsider" || (where !== undefined && outsiderHookInstalled(p, where.env, where.userHome, folderOfPayload(p, payload)))),
  );
}

/** The task folder a payload names, read through the profile's own `cwd` field (Cursor: `workspace_roots[0]`). Undefined unless it is an absolute path. */
function folderOfPayload(p: HostProfile, payload: unknown): string | undefined {
  try {
    const flat = p.readPayload === undefined ? (payload as Record<string, unknown>) : p.readPayload(payload);
    const cwd = flat?.[p.fields.cwd];
    return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when an outsider harness's own CoCheck hook is installed: its config file (for `folder`, when the path names `{project}`) exists and carries
 * CoCheck's hook for every event its install block lists. The same test `cocheck status` uses for a built-in host ("installed" means no event is missing).
 * An unreadable or unparsable config, or a path that needs a folder that is not given, is not installed.
 */
export function outsiderHookInstalled(p: HostProfile, env: NodeJS.ProcessEnv, userHome: string, folder: string | undefined): boolean {
  if (p.install === undefined) return false;
  try {
    const file = p.install.configFile(env, userHome, folder);
    if (!existsSync(file)) return false;
    return p.install.missingEvents(readFileSync(file, "utf8"), file).length === 0;
  } catch {
    return false;
  }
}

/** The outsider harnesses whose fingerprint is in force for one of `folders`: each with the config file that carries its hook, and the hosts whose hooks it makes skip a payload. */
export function activeOutsiderFingerprints(env: NodeJS.ProcessEnv, userHome: string, folders: readonly string[]): { profile: HostProfile; configFile: string; skippedBy: string[] }[] {
  const out: { profile: HostProfile; configFile: string; skippedBy: string[] }[] = [];
  for (const p of outsiders) {
    if (!p.capabilities.readsForeignHooks || p.foreignHookFingerprint === undefined) continue;
    // A user-scope config needs no folder; a project-scope one is looked for in each folder CoCheck watches.
    const candidates = [undefined, ...folders];
    const at = candidates.findIndex((f) => outsiderHookInstalled(p, env, userHome, f));
    if (at < 0) continue;
    const folder = candidates[at];
    let configFile: string;
    try {
      configFile = p.install!.configFile(env, userHome, folder);
    } catch {
      continue;
    }
    const named = (p.readsConfigsOf ?? []).map((k) => allProfiles().find((x) => x.key === k)?.displayName ?? k);
    out.push({ profile: p, configFile, skippedBy: named.length > 0 ? named : allProfiles().filter((x) => x.trust !== "outsider" && !x.capabilities.readsForeignHooks).map((x) => x.displayName) });
  }
  return out;
}

/** The hosts whose session id this environment carries (a shell the host started), each with its key and the id. */
export function sessionOfEnv(env: NodeJS.ProcessEnv): { host: HostKey; session: string }[] {
  return allProfiles().flatMap((p) => (p.sessionEnv !== undefined && typeof env[p.sessionEnv] === "string" && env[p.sessionEnv] !== "" ? [{ host: p.key, session: env[p.sessionEnv]! }] : []));
}

/** Clients that name themselves in a record but have no profile (nothing is recorded for them). Label only. */
const OTHER_CLIENTS: Readonly<Record<string, string>> = { gemini: "Gemini", cursor: "Cursor" };

/** The name for a host as stored on a record ("claude", "codex", or any client name). Undefined when nothing is known of it. */
export function knownHostLabel(host: string): string | undefined {
  const p = allProfiles().find((x) => x.key === host);
  return p !== undefined ? p.displayName : OTHER_CLIENTS[host];
}

/** True when a record from this host proves a failed call would have sent a failure event (so a call with none succeeded). */
export function reportsFailureEvents(host: string | null | undefined): boolean {
  return allProfiles().some((p) => p.key === host && p.capabilities.failureEvent);
}

// ---- tool classes ----

const toolIndexes = new WeakMap<ToolTable, { exact: Map<string, ToolEntry>; lower: Map<string, ToolEntry> }>();
function indexOfTable(table: ToolTable): { exact: Map<string, ToolEntry>; lower: Map<string, ToolEntry> } {
  let ix = toolIndexes.get(table);
  if (ix === undefined) {
    const entries = Object.entries(table);
    ix = { exact: new Map(entries), lower: new Map(entries.filter(([, e]) => e.anyCase === true).map(([n, e]) => [n.toLowerCase(), e])) };
    toolIndexes.set(table, ix);
  }
  return ix;
}

/**
 * What the host's table says a tool is, by the exact name; with `anyCase`, a name the host varies in letter case is also found in any case.
 * A record with no host, or a host with no profile, reads the built-in tables together (a name no host declares is unknown): the answer
 * a record gave before tables were per host, so a stored op that names no host keeps its credit.
 */
export function toolEntryOf(host: string | null | undefined, tool: string | null | undefined, anyCase = false): ToolEntry | undefined {
  if (tool == null) return undefined;
  const p = findProfile(host);
  const tables = (p !== undefined ? [p] : builtIn()).map((x) => indexOfTable(x.toolClasses));
  for (const ix of tables) {
    const e = ix.exact.get(tool);
    if (e !== undefined) return e;
  }
  if (anyCase) {
    const low = tool.toLowerCase();
    for (const ix of tables) {
      const e = ix.lower.get(low);
      if (e !== undefined) return e;
    }
  }
  return undefined;
}

/** True when the host's table says a call of this tool wakes a helper that already ran (see `ToolEntry.resumesHelper`). */
export const resumesHelper = (host: string | null | undefined, tool: string | null | undefined): boolean => toolEntryOf(host, tool)?.resumesHelper === true;

/** The class of a tool by its exact name, or undefined when the host does not declare it. */
export const toolClassOf = (host: string | null | undefined, tool: string | null | undefined) => toolEntryOf(host, tool)?.class;
