// Reads harness manifests from a folder (`<dir>/<key>/cocheck-harness.json`) and compiles them. The built-in folder ships with CoCheck
// (harnesses/ at the repo root, dist/harnesses/ in a build); the outsider folder is the person's own (`<CoCheck data home>/harnesses/`, or $COCHECK_HARNESS_DIR).
// A manifest that does not load is skipped with one plain line naming the file and the field; the others still load.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { compileManifest } from "./compile.ts";
import { MANIFEST_FILE, validateManifest, type HarnessManifest } from "./manifest.ts";
import type { HostProfile } from "./types.ts";

/** Folder names that are not host keys: `--for` words and the key a record without a host carries. */
export const RESERVED_KEYS = ["both", "all", "none", "unknown"];

/**
 * What an outsider manifest may not declare: each would claim a proof only first-party code earns, or a built-in alias. An outsider's `foreignHookFingerprint`
 * is allowed: it makes another host's hook skip a payload only while the outsider's own CoCheck hook is installed for that folder (see `runsOtherHostsHook`).
 */
function outsiderProblem(m: HarnessManifest): string | undefined {
  if (m.argvTag !== undefined || m.capabilities?.argvTag === true) return "argvTag: only a built-in host can tag a shell call (an outsider's events are never proof)";
  if (m.install?.inBothAlias === true) return "install.inBothAlias: `--for both` means the built-in hosts";
  return undefined;
}

export interface Loaded {
  profiles: HostProfile[];
  /** One plain line per manifest that was skipped. */
  errors: string[];
}

/** The manifests under `dir`. `reserved`: keys already taken (a manifest may not reuse one). `source` "outsider" caps the profile's trust and applies the outsider rules. */
export function loadHarnessFolder(dir: string, source: "built-in" | "outsider", reserved: readonly string[]): Loaded {
  const out: Loaded = { profiles: [], errors: [] };
  let names: string[];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
    names = readdirSync(dir).sort();
  } catch (error) {
    out.errors.push(`${dir}: cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    return out;
  }
  const taken = new Set([...reserved, ...RESERVED_KEYS]);
  for (const name of names) {
    const file = path.join(dir, name, MANIFEST_FILE);
    const label = `${name}/${MANIFEST_FILE}`;
    try {
      if (!existsSync(file)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(`${label}: not valid JSON`);
      }
      const m = validateManifest(raw, label, { outsider: source === "outsider", builtIn: source === "built-in" });
      if (m.key !== name) throw new Error(`${label}: key: ${JSON.stringify(m.key)} must match the folder name ${JSON.stringify(name)}`);
      if (taken.has(m.key)) throw new Error(`${label}: key: ${JSON.stringify(m.key)} is already a host; a manifest cannot reuse a key`);
      if (source === "outsider") {
        const problem = outsiderProblem(m);
        if (problem !== undefined) throw new Error(`${label}: ${problem}`);
      }
      out.profiles.push(compileManifest(m, source));
      taken.add(m.key);
    } catch (error) {
      out.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}
