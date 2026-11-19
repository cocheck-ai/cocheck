// The core-to-Office import ratchet. Every import edge from a core module to an Office module is pinned in
// ALLOWED below; a new edge fails, naming importer and target. A stale line fails too, and the list holds only the collector's one false positive.
//
// OFFICE MODULES (structural rule):
//   1. everything under src/office/ (src/office/connector/ included: imports from it into core are edges),
//   2. everything under src/excel/,
//   3. everything under src/formats/xlsx/, src/formats/pptx/ and src/formats/docx/ (empty; kept so nothing returns there).
//      src/formats/files/ is not Office: the docx reader lives under src/office/connector/docx/, and what stays here (text, csv,
//      the whole-file row, the folder scan, the aligner) is core's generic tier.
//   4. plus these single modules, each listed whole as Office-specific in
//      the core format code inventory:
//      - src/formats/package-media.ts       inventory 4: "formats/package-media.ts (595): charts, images, layouts and themes"
//      - src/formats/ooxml-names.ts         inventory 4: "formats/ooxml-names.ts (361), formats/docprops-noise.ts (15): namespace-safe XML helpers"
//      - src/formats/docprops-noise.ts      inventory 4: same line
//      - src/formats/structure-check.ts     inventory 4: "formats/structure-check.ts (667) + structure-cache.ts (63): Office would ask to repair"
//      - src/structure-cache.ts             inventory 4: same line
//      - src/timeline/render/office-off.ts  inventory 4: "render/office-off.ts (40): the Office card with no pictures"
//      - src/timeline/render/xlsx-read.ts   inventory 1f: "style rows ... via render/xlsx-read.ts (267)"
//      - src/timeline/render/xlsx-style-rows.ts  inventory 1f: "and render/xlsx-style-rows.ts (50)"
//      - src/timeline/render/xlsx-look.ts   inventory 1h: "render/xlsx-look.ts (276)" (grid drawing)
//      - src/timeline/sheet-rows.ts         inventory 1f: "sheet-rows.ts (76): sheets collapsed when there are too many rows"
//      - src/checks/ (all four files)       inventory 1e: "checks/index.ts, checks/errors.ts, checks/patterns.ts, checks/workbook-cache.ts"
//      - src/impact.ts                      inventory 1e: "impact.ts (682, the formula dependency graph)"
//   Not listed, on purpose: files the inventory calls mixed or generic (review.ts, items.ts, notes.ts, load.ts, fingerprint.ts,
//   hook-adapter.ts, tasks.ts, file-lock.ts "a generic file lock", platform openers). Their Office
//   imports are edges, which is the point.
// CORE = every other module under src/ (.ts, .mts, .cts, .mjs, .cjs). Rail assets (src/timeline/rail/assets/*.js) are not
// imports and are out of scope. Imports between two Office modules are not edges.
//
// Collected edges: static `import ... from`, side-effect `import "x"`, `import type` (counted), `export ... from` (re-exports,
// `export type` counted), dynamic `import("x")` and type-position `import("x").T`, `require("x")`,
// `new URL("x", import.meta.url)`, with `.js`, `.ts`, `.mjs`, `.cjs` or no suffix and directory index files. A dynamic `import()`
// or `require()` whose argument is not a string literal or `new URL(literal, import.meta.url)` is an edge to `<computed>`: it
// cannot be checked, so it must be allow-listed by hand.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { COMPUTED, SPEC_PATTERNS, resolveSpec, stripComments } from "./helpers/import-edges.ts";

export { resolveSpec, stripComments };

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const ASSETS = "src/timeline/rail/assets/";
const SOURCE_EXT = /\.(?:ts|mts|cts|mjs|cjs)$/;

const OFFICE_DIRS = ["src/office/", "src/excel/", "src/formats/xlsx/", "src/formats/pptx/", "src/formats/docx/", "src/checks/"];
const OFFICE_FILES = new Set([
  "src/formats/package-media.ts",
  "src/formats/ooxml-names.ts",
  "src/formats/docprops-noise.ts",
  "src/formats/structure-check.ts",
  "src/structure-cache.ts",
  "src/timeline/render/office-off.ts",
  "src/timeline/render/xlsx-look.ts",
  "src/timeline/sheet-rows.ts",
  "src/impact.ts",
]);

export function isOffice(rel: string): boolean {
  return OFFICE_FILES.has(rel) || OFFICE_DIRS.some((d) => rel.startsWith(d));
}

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join("/");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (SOURCE_EXT.test(e.name) && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

export type Edge = `${string} -> ${string}`;

/** Every edge from `importerRel` (given its source text) to an Office module. Empty for an Office importer. */
export function edgesOf(importerRel: string, text: string, exists: (rel: string) => boolean): Edge[] {
  if (isOffice(importerRel) || importerRel.startsWith(ASSETS)) return [];
  const code = stripComments(text);
  const found = new Set<Edge>();
  for (const re of SPEC_PATTERNS) {
    for (const m of code.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const target = spec === undefined ? undefined : resolveSpec(importerRel, spec, exists);
      if (target !== undefined && isOffice(target)) found.add(`${importerRel} -> ${target}`);
    }
  }
  for (const _ of code.matchAll(COMPUTED)) found.add(`${importerRel} -> <computed>`);
  return [...found].sort();
}

const existsInRepo = (r: string): boolean => existsSync(path.join(ROOT, r)) && statSync(path.join(ROOT, r)).isFile();

function collect(): Edge[] {
  return sources(SRC)
    .map(rel)
    .flatMap((r) => edgesOf(r, readFileSync(path.join(ROOT, r), "utf8"), existsInRepo))
    .sort();
}

/** New edges (not allow-listed), as messages naming importer and target. */
export function unlisted(edges: readonly Edge[], allowed: readonly string[]): string[] {
  const ok = new Set(allowed);
  return edges.filter((e) => !ok.has(e)).map((e) => `new core-to-Office import: ${e.replace(" -> ", " imports ")}`);
}

// The one false positive. One edge per line; a stale line fails.
const ALLOWED: string[] = [
  "src/attribution/tag.ts -> <computed>", // a require(t) inside the generated preload source string, not an import
];

describe("core-to-Office import ratchet", () => {
  it("no core module imports an Office module beyond the allow-list", () => {
    assert.deepEqual(unlisted(collect(), ALLOWED), []);
  });

  it("the allow-list has no duplicate lines", () => {
    assert.equal(new Set(ALLOWED).size, ALLOWED.length);
  });

  it("no allow-list entry is stale (the list only shrinks, strictly)", () => {
    const live = new Set(collect());
    assert.deepEqual(ALLOWED.filter((e) => !live.has(e as Edge)), []);
  });

  describe("the collector catches each import form (planted, red-first)", () => {
    const office = "src/formats/xlsx/reader.ts";
    const exists = (r: string): boolean => r === office || existsInRepo(r);
    const plant = (text: string, importer = "src/timeline/load.ts"): string[] => unlisted(edgesOf(importer, text, exists), ALLOWED.filter((e) => !e.endsWith(office)));
    const named = [`new core-to-Office import: src/timeline/load.ts imports ${office}`];
    const forms: Record<string, string> = {
      "static .js-suffixed": `import { readWorkbook } from "../formats/xlsx/reader.js";`,
      "static .ts-suffixed": `import { readWorkbook } from '../formats/xlsx/reader.ts';`,
      "no suffix": `import * as r from "../formats/xlsx/reader";`,
      "multi-line": `import {\n  a,\n  b as c,\n} from\n  "../formats/xlsx/reader.js";`,
      "import type (counted)": `import type { Workbook } from "../formats/xlsx/reader.js";`,
      "inline type specifier": `import { type Workbook } from "../formats/xlsx/reader.js";`,
      "side-effect": `import "../formats/xlsx/reader.js";`,
      "re-export named": `export { readWorkbook } from "../formats/xlsx/reader.js";`,
      "re-export star": `export * from "../formats/xlsx/reader.js";`,
      "re-export star as": `export * as reader from "../formats/xlsx/reader.js";`,
      "export type from": `export type { Workbook } from "../formats/xlsx/reader.js";`,
      "dynamic import()": `const m = await import("../formats/xlsx/reader.js");`,
      "dynamic import() in a template": "const s = `${(await import(`../formats/xlsx/reader.js`)).x}`;",
      "type-position import()": `let w: import("../formats/xlsx/reader.js").Workbook;`,
      "require()": `const r = require("../formats/xlsx/reader.js");`,
      "new URL(.., import.meta.url)": `const u = new URL("../formats/xlsx/reader.ts", import.meta.url);`,
      "after a regex holding a quote and slashes": `const re = /["'\\/]/g; import("../formats/xlsx/reader.js");`,
      "after a string holding //": `const u = "http://x"; import { a } from "../formats/xlsx/reader.js";`,
    };
    for (const [name, text] of Object.entries(forms)) {
      it(`${name}: the planted edge fails, named`, () => assert.deepEqual(plant(text), named));
    }

    it("a computed dynamic import() in core is an edge to <computed>", () => {
      assert.deepEqual(plant(`const m = await import(name);`), ["new core-to-Office import: src/timeline/load.ts imports <computed>"]);
    });

    it("an import into src/office/connector from core is an edge", () => {
      assert.deepEqual(unlisted(edgesOf("src/hook-adapter.ts", `import { x } from "./office/connector/main.js";`, existsInRepo), ALLOWED), [
        "new core-to-Office import: src/hook-adapter.ts imports src/office/connector/main.ts",
      ]);
    });

    it("commented-out imports, Office-to-Office imports and package imports are not edges", () => {
      assert.deepEqual(plant(`// import { a } from "../formats/xlsx/reader.js";\n/* import("../formats/xlsx/reader.js") */`), []);
      assert.deepEqual(edgesOf("src/formats/pptx/layer.ts", `import { a } from "../xlsx/reader.js";`, exists), []);
      assert.deepEqual(plant(`import { unzipSync } from "fflate";`), []);
    });
  });
});
