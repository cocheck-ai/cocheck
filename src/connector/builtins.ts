// The connectors shipped with CoCheck (built-ins). Each is a normal connector-v1 folder (manifest, JSON lines); the only thing special about it is that
// CoCheck's own code registers it here, so it is enabled from the start for the types it claims (connector/enabled-types.ts). Nothing a manifest says makes
// a connector built-in. A built-in whose folder is missing or whose manifest does not pass checkManifest is simply not registered.
// The folders ship under `connectors/` beside the compiled code: <repo>/connectors when this module runs from src/, dist/connectors when it runs
// from the built dist/ (scripts/build.mjs copies them there).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availableOn } from "../platform/index.ts";
import { readInstalledManifests, readManifestFolder, type InstalledManifest } from "./installed-manifests.ts";
import { ownNode, requireRun } from "./run-argv.ts";

export interface BuiltinConnector {
  id: string;
  /** The connector folder (absolute). */
  dir: string;
  /** The OS names it is available on; absent means every OS. */
  platforms?: readonly string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** Where the shipped connector folders are: the running module's own location decides (src/connector/*.ts or dist/connector/*.js). */
export const BUILTIN_CONNECTORS_ROOT = import.meta.url.endsWith(".ts") ? path.join(here, "..", "..", "connectors") : path.join(here, "..", "connectors");

/** The production list. Office knowledge lives inside the folders; here they are only ids and folders. All three run on every OS: where no Office driver is built, they answer the change list. */
export const PRODUCTION_BUILTIN_CONNECTORS: readonly BuiltinConnector[] = [
  { id: "microsoft-excel", dir: path.join(BUILTIN_CONNECTORS_ROOT, "microsoft-excel") },
  { id: "microsoft-word", dir: path.join(BUILTIN_CONNECTORS_ROOT, "microsoft-word") },
  { id: "microsoft-powerpoint", dir: path.join(BUILTIN_CONNECTORS_ROOT, "microsoft-powerpoint") },
];

let override: readonly BuiltinConnector[] | undefined;

/** Test seam: replaces the built-in list for this process (undefined restores the default list). A test that wants the shipped ones passes PRODUCTION_BUILTIN_CONNECTORS. */
export function setBuiltinConnectorsForTest(list: readonly BuiltinConnector[] | undefined): void {
  override = list;
}

/**
 * The default list: the production one, or none when COCHECK_TEST_NO_BUILTIN_CONNECTORS=1. Only the test bootstrap (scripts/test-bootstrap.ts) sets
 * that variable, so tests (and the child processes they start, which inherit it) get no built-in unless a test asks; unset, nothing changes.
 */
const defaultList = (): readonly BuiltinConnector[] => (process.env.COCHECK_TEST_NO_BUILTIN_CONNECTORS === "1" ? [] : PRODUCTION_BUILTIN_CONNECTORS);

/** The built-in list as registered (before the platform filter and the folder check). */
export const builtinConnectorList = (): readonly BuiltinConnector[] => override ?? defaultList();

/** The built-ins available here whose folder holds a valid manifest with their id, each marked `builtin`. Never throws. */
export function readBuiltinManifests(): InstalledManifest[] {
  const out: InstalledManifest[] = [];
  for (const b of builtinConnectorList()) {
    if (!availableOn(b.platforms)) continue;
    try {
      const found = readManifestFolder(b.dir, b.id);
      if (found !== undefined) out.push({ ...found, builtin: true });
    } catch {
      // not registered
    }
  }
  return out;
}

/** What `connectorClaimsFor` takes: each available built-in's id and the extensions its manifest claims. */
export const builtinClaims = (): Array<{ id: string; extensions: readonly string[] }> => readBuiltinManifests().map(({ manifest }) => ({ id: manifest.id, extensions: manifest.matches.extensions ?? [] }));

/**
 * The connector with this id: a built-in first (an installed folder that reuses a built-in's id is never used), else the installed one. Undefined when neither.
 * Never throws.
 */
export function connectorById(home: string | undefined, id: string): InstalledManifest | undefined {
  try {
    return readBuiltinManifests().find((m) => m.manifest.id === id) ?? readInstalledManifests(home).find((m) => m.manifest.id === id);
  } catch {
    return undefined;
  }
}

/** Every connector: the available built-ins, then the installed ones whose id no built-in has. */
export function knownConnectors(home: string | undefined): InstalledManifest[] {
  const builtins = readBuiltinManifests();
  const ids = new Set(builtins.map((b) => b.manifest.id));
  return [...builtins, ...readInstalledManifests(home).filter((m) => !ids.has(m.manifest.id))];
}

/** The argv a connector is started with, built-in or installed. A bare `node` is CoCheck's own runtime (process.execPath), never whatever `node` is on PATH. Throws as requireRun does. */
export function connectorArgv(c: InstalledManifest): string[] {
  return ownNode([...requireRun((c.manifest as { run?: unknown }).run)]);
}

/** Every type the manifests of these built-in folders claim, lower-cased and distinct. A folder that does not read adds nothing. Never throws. */
export function builtinTypesOf(list: readonly BuiltinConnector[]): readonly string[] {
  const out: string[] = [];
  for (const b of list) {
    try {
      out.push(...(readManifestFolder(b.dir, b.id)?.manifest.matches.extensions ?? []).map((e) => e.toLowerCase()));
    } catch {
      // not readable: claims nothing
    }
  }
  return [...new Set(out)];
}

let shipped: readonly string[] | undefined;
/**
 * Every type the shipped built-ins claim, from their manifests (the production list, whatever a test registered or COCHECK_TEST_NO_BUILTIN_CONNECTORS
 * says), read once. enabled-types.ts counts these as types already served, so an installed connector starts disabled for them (read from the manifests, not a hardcoded list of endings). Never throws: a folder that does not read adds nothing.
 */
export function shippedBuiltinTypes(): readonly string[] {
  return (shipped ??= builtinTypesOf(PRODUCTION_BUILTIN_CONNECTORS));
}
