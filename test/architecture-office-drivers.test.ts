// The Office drivers live under src/office/connector/. No file under src/platform, and no engine file outside src/office, names
// Microsoft Word, Excel or PowerPoint or imports from src/office/connector. Hits that predate the move are allowlisted per file below;
// the list may only shrink (an allowlisted file with no hit fails, so the room cannot be reused).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const SRC = path.join(import.meta.dirname, "..", "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (/\.(?:ts|cjs|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f: string): string => path.relative(path.join(SRC, ".."), f).split(path.sep).join("/");
const NAMES = /Microsoft (?:Word|Excel|PowerPoint)/;
const CONNECTOR_IMPORT = /from\s+["'][^"']*office\/connector\/|import\(\s*["'][^"']*office\/connector\//;

/** Files outside src/office that name an Office app or import the connector, with the rule each trips. Only shrinks. */
const ALLOWED: Record<string, string[]> = {
  // empty: no opener (darwin.ts MAC_APP, src/excel/open-in-excel.ts) names an Office app
};

describe("Office drivers stay under src/office/connector", () => {
  const files = sources(SRC).filter((f) => !rel(f).startsWith("src/office/"));
  const hits = (): Map<string, string[]> => {
    const found = new Map<string, string[]>();
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const rules = [NAMES.test(text) ? "names" : "", CONNECTOR_IMPORT.test(text) ? "imports-connector" : ""].filter((r) => r !== "");
      if (rules.length > 0) found.set(rel(f), rules);
    }
    return found;
  };

  it("no file outside src/office names an Office app or imports src/office/connector, beyond the allowlist", () => {
    const bad: string[] = [];
    for (const [f, rules] of hits()) for (const r of rules) if (!(ALLOWED[f] ?? []).includes(r)) bad.push(`${f}: ${r}`);
    assert.deepEqual(bad, []);
  });

  it("the allowlist holds no stale entry", () => {
    const found = hits();
    const stale = Object.entries(ALLOWED).flatMap(([f, rules]) => rules.filter((r) => !(found.get(f) ?? []).includes(r)).map((r) => `${f}: ${r}`));
    assert.deepEqual(stale, []);
  });

  it("src/platform names no Office app and imports no connector file except the one allowlisted opener", () => {
    const inPlatform = [...hits()].filter(([f]) => f.startsWith("src/platform/") && f !== "src/platform/darwin.ts");
    assert.deepEqual(inPlatform, []);
  });
});
