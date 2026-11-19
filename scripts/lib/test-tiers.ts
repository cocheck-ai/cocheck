// Test tiers. The slow set is every `*.slow.test.ts` file (fuzz with many seeds, large-workbook ceilings, real PDF renders,
// process-spawn races, the release-script test, the platforms checks): a file joins it by its name, never by a list here.
// The fast set is every other `*.test.ts`. Together they are the whole set, and the runner prints the sum so a file cannot drop out of both.
import { readdirSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

export const SLOW_SUFFIX = ".slow.test.ts";

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith(".test.ts")) out.push(path.relative(process.cwd(), path.join(dir, e.name)));
  }
}

export function discoverTests(root = process.cwd()): { all: string[]; fast: string[]; slow: string[] } {
  const all: string[] = [];
  walk(root, all);
  all.sort();
  const slow = all.filter((f) => f.endsWith(SLOW_SUFFIX));
  const fast = all.filter((f) => !f.endsWith(SLOW_SUFFIX));
  return { all, fast, slow };
}

/** The runner's accounting line. Throws if the two tiers do not add up to the whole set. */
export function tierArithmetic(t: { all: string[]; fast: string[]; slow: string[] }): string {
  const line = `test files: fast ${t.fast.length} + slow ${t.slow.length} = ${t.fast.length + t.slow.length}; full set ${t.all.length}`;
  if (t.fast.length + t.slow.length !== t.all.length || new Set([...t.fast, ...t.slow]).size !== t.all.length) {
    throw new Error(`${line}: the tiers do not add up to the full set`);
  }
  return line;
}

/** The args the runner hands node after `--test`. Named files (any non-flag argument) run alone; with none, the tier's explicit list runs. */
export function selectTestArgs(passThrough: string[], tierFiles: string[]): string[] {
  return passThrough.some((a) => !a.startsWith("-")) ? passThrough : [...passThrough, ...tierFiles];
}
