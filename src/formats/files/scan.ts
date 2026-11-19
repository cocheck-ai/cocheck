import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** The watch keeps fingerprints, not copies, of files no CoCheck call touched, so these caps are higher than when it copied; they still bound the hashing work. */
export const MAX_FOLDER_FILES = 500;
/** The sweep walk lists at most this many directory entries (files and folders, skipped ones not counted); past it the walk stops and the record says so. A project of 100000 entries is already far past what a review can hold. */
export const MAX_WALK_ENTRIES = 100_000;
export const MAX_FOLDER_BYTES = 200 * 1024 * 1024;

/**
 * Leftovers an editor keeps next to an open or crashed document, never the user's content: Office
 * owner files (`~$*`) and the document app's temp files (`~WRL*.tmp`), LibreOffice locks (`.~lock.*#`), macOS
 * resource forks (`._*`) and `.DS_Store`, plus CoCheck's own review export.
 */
function isScratchFile(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name.startsWith("~$") ||
    name.startsWith("._") ||
    /^\.~lock\..*#$/.test(name) ||
    /^~WRL.*\.tmp$/i.test(name) ||
    name.endsWith(".cocheck-review.html")
  );
}

/** Folders the hook adapter's recursive watch does not enter: version control and dependencies, never the user's own work. */
/** The folder CoCheck itself keeps delivery copies in, inside a task folder. Never watched, never an agent change, never a skip note. */
export const DELIVERY_FOLDER = ".cocheck";

export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".cache"]);

/** Whether the folder watch tracks `filePath`: every file but editor scratch files. */
export function isWatchedFolderFile(filePath: string): boolean {
  return !isScratchFile(path.basename(filePath));
}

/** Whether `filePath` is a presentation package, which the Office connector's presentation layer reads. */
export function isDeckFile(filePath: string): boolean {
  return isWatchedFolderFile(filePath) && /\.pp[ts][xm]$/i.test(filePath);
}

/** Whether the files layer handles `filePath`: a watched file that isn't a spreadsheet or presentation package (each read by its own connector layer). */
export function isTrackedFolderFile(filePath: string): boolean {
  return isWatchedFolderFile(filePath) && !/\.xls[xm]$/i.test(filePath) && !isDeckFile(filePath);
}

export type FolderScan =
  /** `notes`: files left out one by one (e.g. over the size cap), in plain words. */
  | { ok: true; files: string[]; notes: string[] }
  | { ok: false; note: string };

function mb(bytes: number): string {
  return `${Math.round(bytes / 1048576)} MB`;
}

/**
 * Non-recursive listing of the watched files in `dir`, or a note saying why the folder was
 * skipped. A single file over `MAX_FOLDER_BYTES` is left out by name and the rest still watched;
 * the folder is skipped only when what's left is still over a cap.
 */
export function scanFolder(dir: string): FolderScan {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { ok: true, files: [], notes: [] };
  }
  const files: string[] = [];
  const notes: string[] = [];
  let bytes = 0;
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    if (!isWatchedFolderFile(full)) continue;
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_FOLDER_BYTES) {
        notes.push(`${full} is ${mb(st.size)} (limit ${mb(MAX_FOLDER_BYTES)} per file); changes to it were not watched.`);
        continue;
      }
      bytes += st.size;
    } catch {
      continue;
    }
    files.push(full.normalize("NFC"));
  }
  if (files.length > MAX_FOLDER_FILES) {
    return { ok: false, note: `folder ${dir} has ${files.length} files (limit ${MAX_FOLDER_FILES}); other files there were not watched.` };
  }
  if (bytes > MAX_FOLDER_BYTES) {
    return { ok: false, note: `folder ${dir} holds ${mb(bytes)} (limit ${mb(MAX_FOLDER_BYTES)}); other files there were not watched.` };
  }
  return { ok: true, files, notes };
}

/** Whether `dir` is a Python environment, whatever its name: it holds `pyvenv.cfg` (venv, virtualenv) or a `conda-meta` folder (conda). */
export function isPythonEnvironment(dir: string): boolean {
  return existsSync(path.join(dir, "pyvenv.cfg")) || existsSync(path.join(dir, "conda-meta"));
}
