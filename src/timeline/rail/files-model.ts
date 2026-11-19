/**
 * The folder-tree part of the rail, in TypeScript and format-free: which files
 * exist at a moment, the tree rows that show them, and where a new file lives. Names only: nothing here ever holds file contents.
 */
import { pathKit } from "../../paths.ts";

export const dirName = (p: string): string => {
  const parts = pathKit().canon(p).split("/");
  return parts.slice(0, -1).join("/");
};
export const baseOf = (p: string): string => pathKit().baseName(p) || p;

/** The body cuts a path outside the work folder to its file name, so an outside file is told only by a path that left the folder. */
export const isOutside = (file: string): boolean => pathKit().isAbs(file) || file.startsWith("../") || file === "[outside path]";

export interface TreeRow {
  t: "dir" | "file";
  name: string;
  depth: number;
  open?: boolean;
  /** Files below a closed folder. */
  count?: number;
  /** The new file itself. */
  target?: boolean;
  /** The empty slot where the new file will go (the Before side). */
  gap?: boolean;
}

interface Node {
  dirs: Map<string, Node>;
  files: string[];
}

const countOf = (n: Node): number => n.files.length + [...n.dirs.values()].reduce((a, d) => a + countOf(d), 0);

/** Rows of the tree of `paths`, with only the folders on the way to `target` open. The target shows as a gap when it is not there yet. */
export function treeRows(paths: readonly string[], target: string, side: "before" | "after"): TreeRow[] {
  const root: Node = { dirs: new Map(), files: [] };
  const all = side === "before" ? [...paths, target] : paths.includes(target) ? [...paths] : [...paths, target];
  for (const p of new Set(all)) {
    const parts = p.split("/");
    let n = root;
    for (const d of parts.slice(0, -1)) {
      let next = n.dirs.get(d);
      if (next === undefined) n.dirs.set(d, (next = { dirs: new Map(), files: [] }));
      n = next;
    }
    n.files.push(p);
  }
  const rows: TreeRow[] = [];
  const walk = (n: Node, base: string, depth: number): void => {
    for (const d of [...n.dirs.keys()].sort()) {
      const full = base + d;
      const open = target.startsWith(full + "/");
      rows.push({ t: "dir", name: d, depth, open, count: countOf(n.dirs.get(d)!) });
      if (open) walk(n.dirs.get(d)!, full + "/", depth + 1);
    }
    for (const f of [...n.files].sort((a, b) => baseOf(a).localeCompare(baseOf(b)))) {
      const isTarget = f === target;
      rows.push({ t: "file", name: baseOf(f), depth, target: isTarget && side === "after", gap: isTarget && side === "before" });
    }
  };
  walk(root, "", 0);
  return rows;
}
