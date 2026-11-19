// The one reader of installed connector manifests: <home>/connectors/<id>/cocheck-connector.json. The registry, the subject templates and the
// MCP matcher all read through it. Only a regular file is opened (a FIFO or a device at the path would block the read), a manifest that does
// not parse or has any `checkManifest` problem is skipped, and nothing here throws.
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { MANIFEST_FILE, checkManifest } from "./schema.ts";

/** A real manifest is a few hundred bytes; anything past this is skipped unread. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

export interface InstalledManifest {
  /** The folder name under connectors/. */
  dir: string;
  file: string;
  /** A manifest that passed `checkManifest`. */
  manifest: { id: string; matches: { extensions?: string[]; schemes?: string[]; subjects?: Record<string, string>; calls?: Record<string, { subjects: Array<{ from: "response"; template: string; created: true }> }>; mcpServers?: string[]; mcpTools?: string[] } };
  /** Set only by builtins.ts, for a connector shipped with CoCheck and registered by its code (never by anything a manifest says). */
  builtin?: true;
}

export interface ManifestReadOptions {
  /** Called once per skipped manifest that exists but is not a regular file, is over the size cap, or is unreadable, unparsable or invalid, or whose id differs from its folder name. */
  onSkip?: (file: string, why: string) => void;
  /** Called when the connectors folder exists but cannot be listed. */
  onFolderError?: (root: string, why: string) => void;
}

export function readInstalledManifests(home: string | undefined, opts: ManifestReadOptions = {}): InstalledManifest[] {
  if (home === undefined) return [];
  const root = path.join(home, "connectors");
  let dirs: string[];
  try {
    dirs = readdirSync(root).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") opts.onFolderError?.(root, (e as Error).message);
    return [];
  }
  const out: InstalledManifest[] = [];
  for (const dir of dirs) {
    const found = readManifestFolder(path.join(root, dir), dir, opts);
    if (found !== undefined) out.push(found);
  }
  return out;
}

/**
 * The manifest of one connector folder, or undefined (no manifest, not a regular file, over the cap, unparsable, invalid, or an id other than `id`).
 * `id` is the identity the caller gives the folder: its name under connectors/, or the id CoCheck's own code registers a built-in under.
 */
export function readManifestFolder(folder: string, id: string, opts: ManifestReadOptions = {}): InstalledManifest | undefined {
  const dir = path.basename(folder);
  const file = path.join(folder, MANIFEST_FILE);
  let st: Stats;
  try {
    st = statSync(file);
  } catch {
    return undefined; // no manifest in this folder
  }
  if (!st.isFile()) {
    opts.onSkip?.(file, `connectors/${dir}: not a regular file`);
    return undefined;
  }
  if (st.size > MAX_MANIFEST_BYTES) {
    opts.onSkip?.(file, `connectors/${dir}: manifest is over 64 KiB (${st.size} bytes)`);
    return undefined;
  }
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const problems = checkManifest(json);
    if (problems.length > 0) {
      opts.onSkip?.(file, `${problems[0]!.field || "manifest"} ${problems[0]!.fix}`);
      return undefined;
    }
    // The folder is the connector's identity (connectors/<id>/): a manifest that claims another id could take that connector's credential.
    // Exact comparison; on a case-insensitive disk a differently-cased copy of a real folder cannot coexist with it, so that case is not covered here.
    const claimed = (json as { id: string }).id;
    if (claimed !== id) {
      opts.onSkip?.(file, `connectors/${dir}: manifest id "${claimed}" does not match its folder name`);
      return undefined;
    }
    return { dir, file, manifest: json as InstalledManifest["manifest"] };
  } catch (e) {
    opts.onSkip?.(file, (e as Error).message);
    return undefined;
  }
}
