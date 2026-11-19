// What an Office file would reach when opened (link workbooks, remote images, INCLUDETEXT and OLE links), said as caveats on the connector's
// answer. Core does not draw an Office file, so the connector says it. Nothing is fetched.
import { preflight, type PreflightResult } from "./shared/preflight.ts";

const MAX_REACH_CAVEATS = 3;
/** One "This file would reach <target>" per distinct external target, a few then "and N more". Reads a preflight result only. */
export function reachCaveats(r: PreflightResult): string[] {
  const seen = new Set<string>();
  for (const h of r.hints) for (const t of h.targets ?? []) seen.add(t.target);
  const all = [...seen];
  const out = all.slice(0, MAX_REACH_CAVEATS).map((t) => `This file would reach ${t}`);
  if (all.length > MAX_REACH_CAVEATS) out.push(`and ${all.length - MAX_REACH_CAVEATS} more`);
  return out;
}

/** The reach caveats of one state's bytes (the after state, as the page did); none for no bytes or a file preflight can't read. */
export function reachOf(bytes: Buffer | null, file: string): string[] {
  if (bytes === null) return [];
  try {
    return reachCaveats(preflight(bytes, file));
  } catch {
    return [];
  }
}
