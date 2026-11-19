// What a manifest's `requires` asks of the machine, and which of it is unmet here. `cocheck connector test` reports "unverified" for an unmet
// requirement, because a test that cannot run the connector's real conditions proves nothing. Pure: the environment and the PATH are passed in.
import { existsSync } from "node:fs";
import path from "node:path";

export interface RequiresEnv { env: Record<string, string | undefined>; pathDirs: string[]; pathExts?: string[] }

/** The session this process runs in. COCHECK_SESSION ("desktop" or anything else) decides when set; otherwise a CI or SSH session is not a desktop. */
export function sessionOf(env: Record<string, string | undefined>): "desktop" | "headless" {
  const v = env["COCHECK_SESSION"];
  if (v !== undefined && v !== "") return v === "desktop" ? "desktop" : "headless";
  return env["CI"] !== undefined && env["CI"] !== "" || env["SSH_CONNECTION"] !== undefined || env["SSH_TTY"] !== undefined ? "headless" : "desktop";
}

/** One sentence per requirement of the manifest that this machine does not meet; empty when all are met (or `requires` asks nothing checkable). Apps and runtimes are documentation only. */
export function unmetRequires(manifest: unknown, here: RequiresEnv): string[] {
  const req = (manifest as { requires?: { session?: unknown; binaries?: unknown } } | null)?.requires;
  if (typeof req !== "object" || req === null) return [];
  const out: string[] = [];
  if (req.session === "desktop" && sessionOf(here.env) !== "desktop") out.push('requires.session "desktop": this is not a desktop session (set COCHECK_SESSION=desktop in one)');
  if (Array.isArray(req.binaries)) {
    for (const b of req.binaries) {
      if (typeof b !== "string" || b === "") continue;
      const names = [b, ...(here.pathExts ?? []).map((e) => b + e)];
      if (!here.pathDirs.some((d) => names.some((n) => existsSync(path.join(d, n))))) out.push(`requires.binaries "${b}": not found on PATH`);
    }
  }
  return out;
}
