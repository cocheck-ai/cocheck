import { realpathSync } from "node:fs";
import path, { resolve as resolvePath } from "node:path";
import { platform, type Platform } from "./platform/index.ts";

/**
 * Resolves `path` to an absolute, symlink-resolved form for comparing two paths that may denote
 * the same file. Falls back to a plain `resolve` (no symlink resolution) when the path doesn't
 * exist yet - e.g. comparing a not-yet-open file's target path.
 */
export function normalizePathForCompare(path: string): string {
  const resolved = resolvePath(path);
  let candidate: string;
  try {
    candidate = realpathSync(resolved);
  } catch {
    candidate = resolved;
  }
  // NFC-normalize both sides: macOS's filesystem (HFS+/APFS) and AppleScript's own string
  // handling can each hand back the same filename decomposed differently (NFD vs NFC) - most
  // often for an accented character - so two paths naming the identical file could otherwise
  // fail a byte-for-byte comparison here.
  return candidate.normalize("NFC");
}

/**
 * The one place a path is tested, compared and shown. A path is read in its canonical form: "/" separators, normalised ("../" cannot make an
 * outside path read as inside), a Windows drive letter upper case, and Git Bash's `/c/...` mapped to `C:/...` (win32 only). Comparison folds case
 * where the platform says to (`paths.foldsCase`: Windows, not the Mac); display keeps the case the path was written in.
 */
export interface PathKit {
  /** An absolute path in this platform's forms (Windows: `C:\x`, `C:/x`, `\\host\share`, and Git Bash `/c/x`). */
  isAbs(p: string): boolean;
  /** The absolute path normalised with "/" separators; a relative path comes back as written. */
  canon(p: string): string;
  /** `canon`, folded for comparison where the platform folds case. */
  key(p: string): string;
  /** Whether two paths name the same place. */
  same(a: string, b: string): boolean;
  /** Whether `p` is strictly inside `folder`. */
  inside(folder: string, p: string): boolean;
  /** `p` relative to `folder` with "/" separators, or null when it is not strictly inside. */
  rel(folder: string, p: string): string | null;
  /** The last name of a path, either separator on Windows. */
  baseName(p: string): string;
  /** The path without its last name, in canonical form for an absolute path. */
  dirName(p: string): string;
  /** The path without trailing separators. */
  trimEnd(p: string): string;
  /** The path in the platform's own form for a filesystem call (Windows: `C:\x`, with Git Bash `/c/x` mapped); a relative path comes back as written. */
  native(p: string): string;
}

export function createPathKit(plat: Pick<Platform, "name" | "paths">): PathKit {
  const win = plat.name === "win32";
  const fold = (s: string): string => (plat.paths.foldsCase ? s.toLowerCase() : s);
  const gitBash = (p: string): string => (win && /^\/[A-Za-z](?:\/|$)/.test(p) ? `${p[1]!.toUpperCase()}:${p.slice(2) || "/"}` : p);
  const isAbs = (p: string): boolean => (win ? plat.paths.isAbs(p) || /^\/[A-Za-z](?:\/|$)/.test(p) : plat.paths.isAbs(p));
  const trimEnd = (p: string): string => p.replace(win ? /[\\/]+$/ : /\/+$/, "");
  const canon = (p: string): string => {
    if (!isAbs(p)) return p;
    if (!win) return path.posix.normalize(p);
    const s = gitBash(p).replace(/\\/g, "/");
    const unc = s.startsWith("//");
    const n = path.posix.normalize(s);
    return (unc ? "/" + n : n).replace(/^([a-z]):/, (_, d: string) => d.toUpperCase() + ":");
  };
  const key = (p: string): string => fold(canon(p));
  const root = (folder: string): string => canon(trimEnd(folder));
  const rel = (folder: string, p: string): string | null => {
    const f = root(folder).replace(/\/+$/, ""); // a drive or filesystem root ("C:/", "/") keeps no trailing "/"
    const q = canon(p);
    return fold(q).startsWith(fold(f) + "/") ? q.slice(f.length + 1) : null;
  };
  const baseName = (p: string): string => String(p ?? "").split(win ? /[\\/]/ : "/").pop() as string;
  return {
    isAbs,
    canon,
    key,
    same: (a, b) => key(a) === key(b),
    inside: (folder, p) => rel(folder, p) !== null,
    rel,
    baseName,
    dirName: (p) => {
      const c = canon(p);
      return c.slice(0, Math.max(0, c.lastIndexOf("/")));
    },
    trimEnd,
    native: (p) => (win && isAbs(p) ? canon(p).replace(/\//g, "\\") : p),
  };
}

/** The running platform's kit. Looked up when called, so a test that swaps the platform is honoured. */
export const pathKit = (): PathKit => createPathKit(platform());
