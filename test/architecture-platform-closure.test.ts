// The hooks load src/platform/index.ts, so its value-import closure must not reach the Excel connector (and through it fflate).
// Walks static value imports and re-exports (not `import type` / `export type`), plus dynamic import("...") with a literal path, except the type form `import("...").Name`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "src", "platform", "index.ts");

/** Every file reachable by value imports from `entry`, mapped to one importer chain. */
export function closure(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const specs: string[] = [];
    for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g)) if (m[1] === undefined) specs.push(m[2]!);
    for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)(?!\s*\.(?!then\b))/g)) specs.push(m[1]!);
    for (const spec of specs) {
      if (!spec.startsWith(".")) { if (!seen.has(`pkg:${spec}`)) seen.set(`pkg:${spec}`, [...seen.get(file)!, `pkg:${spec}`]); continue; }
      const next = path.resolve(path.dirname(file), spec);
      if (!existsSync(next) || seen.has(next)) continue;
      seen.set(next, [...seen.get(file)!, next]);
      queue.push(next);
    }
  }
  return seen;
}

describe("the platform's import closure stays out of the Excel connector", () => {
  it("src/platform/index.ts value imports reach nothing under src/office/connector/excel/ and not fflate", () => {
    const rel = (p: string): string => (p.startsWith("pkg:") ? p : path.relative(ROOT, p));
    const bad = [...closure(ENTRY)].filter(([f]) => f === "pkg:fflate" || f.split(path.sep).join("/").includes("/src/office/connector/excel/"));
    assert.deepEqual(bad.map(([, chain]) => chain.map(rel).join(" -> ")), []);
  });

  it("the walker sees a value import and skips a type import", () => {
    const c = closure(ENTRY);
    assert.ok(c.has(path.join(ROOT, "src", "platform", "darwin.ts")));
    assert.ok([...c.keys()].some((k) => k.startsWith("pkg:node:")));
  });
});
