// The watched-folder registry: `<COCHECK_HOME>/watched.json`, written by the installer and read by the hook before it writes
// anything. A folder is watched when its resolved path is a registered folder or inside one; resolution follows symlinks and "..",
// and a sibling that merely shares a prefix (`/x/proj-evil` against `/x/proj`) is outside.
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { writeFileAtomicSync } from "./home-perms.ts";
import path from "node:path";

const REGISTRY_FILE = "watched.json";

export class RegistryError extends Error {}

/** The real path of `p`, or of its nearest existing ancestor with the missing tail re-attached (a folder can be gone yet still be "inside"). */
export function resolveFolder(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail).normalize("NFC");
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p).normalize("NFC");
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** The comparison form of a resolved folder path: lower case where the file system ignores case. */
export const foldFolder = (x: string) => (process.platform === "darwin" || process.platform === "win32" ? x.toLowerCase() : x);

/** Whether `folder` is `root` or inside it, both already resolved and folded; a sibling sharing a prefix is outside. */
export function isInsideFolded(folder: string, root: string): boolean {
  return folder === root || folder.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Reads the registry. Returns undefined when the file does not exist; throws RegistryError when it exists and cannot be trusted. */
export function readRegistry(home: string): string[] | undefined {
  const file = path.join(home, REGISTRY_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RegistryError(`watched-folder registry ${file} is unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RegistryError(`watched-folder registry ${file} is not valid JSON`);
  }
  const folders = (parsed as { folders?: unknown } | null)?.folders;
  if (!Array.isArray(folders) || folders.some((f) => typeof f !== "string" || !path.isAbsolute(f))) {
    throw new RegistryError(`watched-folder registry ${file} has the wrong shape (want {"folders": [absolute paths]})`);
  }
  return folders as string[];
}

/** Adds `folder` (resolved) to the registry, keeping the folders already there. Throws RegistryError on a registry it cannot read. */
export function addToRegistry(home: string, folder: string): string[] {
  const folders = readRegistry(home) ?? [];
  const resolved = resolveFolder(folder);
  if (!folders.some((f) => foldFolder(f) === foldFolder(resolved))) folders.push(resolved);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, REGISTRY_FILE);
  writeFileAtomicSync(file, JSON.stringify({ version: 1, folders }, null, 2) + "\n");
  return folders;
}
