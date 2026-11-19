// Which folders may never be a task folder: the user's home, a filesystem root, and any folder that contains the home.
// Structural, never a name list. The path flavour is a parameter so Windows paths are tested on any OS.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Flavour = typeof path.posix;

/** The user's home as the OS sees it: HOME, else USERPROFILE (Windows), else the OS answer. */
export function userHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export const HOME_REFUSAL = "CoCheck does not track your home folder or a drive root, so open this session in a project folder and start tracking there.";

function canon(p: string, flavour: Flavour, real: boolean): string {
  let out = flavour.resolve(p);
  if (real) {
    try {
      out = realpathSync(out);
    } catch {
      // not on disk here: the lexical form stands
    }
  }
  out = flavour.normalize(out);
  const root = flavour.parse(out).root;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return flavour === path.win32 ? out.toLowerCase() : out;
}

/**
 * True when `folder` is `home`, a filesystem root, or a folder that contains `home`. `flavour` is `path` for the running OS (links are
 * resolved) or `path.win32` / `path.posix` for a path of another OS (compared as written).
 */
export function isUnsafeTaskFolder(folder: string, home: string, flavour: Flavour = path): boolean {
  const real = flavour === path;
  const f = canon(folder, flavour, real);
  const h = canon(home, flavour, real);
  if (f === flavour.parse(f).root.toLowerCase() || f === flavour.parse(f).root) return true;
  if (f === h) return true;
  const rel = flavour.relative(f, h);
  return rel !== "" && !rel.startsWith("..") && !flavour.isAbsolute(rel);
}
