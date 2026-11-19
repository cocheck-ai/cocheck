// the end-state import test. The built-in Office connector (everything under src/office/connector/) and core (every
// other module under src/) meet only where this file says:
//   1. A connector module imports nothing from core except the generic file lock (src/file-lock.ts) and the core modules on CONNECTOR_USES_CORE,
//      each with its reason and the condition that ends it. The published kit helpers (public-kit/helpers/) are outside src/ and always allowed.
//   2. No core module imports from src/office/connector/, except the edges on CORE_USES_CONNECTOR.
// Both lists only shrink: an edge not listed fails, and a listed edge that no longer exists fails (delete the line). Imports are read by the
// same collector as the 0.3 ratchet (test/helpers/import-edges.ts): static, type-only, re-exports, dynamic import(), require(), new URL().
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SOURCE_EXT, importsOf } from "./helpers/import-edges.ts";

const ROOT = path.join(import.meta.dirname, "..");
const CONNECTOR = "src/office/connector/";
const FILE_LOCK = "src/file-lock.ts";

/**
 * The connector's remaining privileges: core modules the built-in Office connector still imports, by target, each with what it is for and the
 * condition that ends it. Worded to be read as G4's "remaining privileges" list. Only shrinks.
 */
const CONNECTOR_USES_CORE: Record<string, string> = {
  "src/platform/index.ts":
    "Talks to the operating system: which computer it is on, the installed Office version, starting and stopping Office. Ends when the platform layer is published as a kit helper (after launch).",
  "src/formats/layer.ts":
    "The shape of a change list (one row per change) that the connector's readers fill in. Ends when it is published as a kit helper.",
  "src/formats/files/layer.ts":
    "CoCheck's plain-file reader (text, CSV, whole file); the connector's document reader is built on top of it. Ends when it is published as a kit helper.",
  "src/formats/files/align.ts":
    "Lines up two versions of a list so an edited paragraph or line reads as one change. Ends when it is published as a kit helper.",
  "src/formats/files/scan.ts":
    "Tells a presentation file from other files, and skips app lock and temp files. Ends when it is published as a kit helper.",
  "src/paths.ts":
    "Compares two file paths the same way on every computer. Ends when it is published as a kit helper.",
};

/** Core-to-connector edges, `importer -> target`. */
// Empty: no core module imports the connector.
const CORE_USES_CONNECTOR: Record<string, string> = {};

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join("/");
const exists = (r: string): boolean => existsSync(path.join(ROOT, r)) && statSync(path.join(ROOT, r)).isFile();

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (SOURCE_EXT.test(e.name) && !e.name.endsWith(".d.ts")) out.push(rel(full));
  }
  return out;
}

const isConnector = (r: string): boolean => r.startsWith(CONNECTOR);
const isCore = (r: string): boolean => r.startsWith("src/") && !isConnector(r);

/** Every edge across the boundary, as `importer -> target`, in both directions. */
export function crossEdges(files: Array<{ rel: string; text: string }>, exists_: (r: string) => boolean = exists): { connectorToCore: string[]; coreToConnector: string[] } {
  const connectorToCore = new Set<string>(), coreToConnector = new Set<string>();
  for (const f of files) {
    if (f.rel.startsWith("src/timeline/rail/assets/")) continue; // page assets, not imports (the ratchet's rule too)
    for (const t of importsOf(f.rel, f.text, exists_)) {
      if (isConnector(f.rel) && isCore(t)) connectorToCore.add(`${f.rel} -> ${t}`);
      if (isCore(f.rel) && isConnector(t)) coreToConnector.add(`${f.rel} -> ${t}`);
    }
  }
  return { connectorToCore: [...connectorToCore].sort(), coreToConnector: [...coreToConnector].sort() };
}

/** Problems: connector edges to core beyond the file lock and the list, core edges into the connector beyond the list, and stale lines. */
export function problems(edges: ReturnType<typeof crossEdges>): string[] {
  const out: string[] = [];
  const usedTargets = new Set<string>();
  for (const e of edges.connectorToCore) {
    const target = e.split(" -> ")[1]!;
    if (target === FILE_LOCK) continue;
    if (CONNECTOR_USES_CORE[target] !== undefined) usedTargets.add(target);
    else out.push(`connector module imports core: ${e.replace(" -> ", " imports ")}`);
  }
  for (const t of Object.keys(CONNECTOR_USES_CORE)) if (!usedTargets.has(t)) out.push(`stale CONNECTOR_USES_CORE line (no connector module imports it any more; delete it): ${t}`);
  const live = new Set(edges.coreToConnector);
  for (const e of edges.coreToConnector) if (CORE_USES_CONNECTOR[e] === undefined) out.push(`core module imports the connector: ${e.replace(" -> ", " imports ")}`);
  for (const e of Object.keys(CORE_USES_CONNECTOR)) if (!live.has(e)) out.push(`stale CORE_USES_CONNECTOR line (delete it): ${e}`);
  return out;
}

const repo = (): Array<{ rel: string; text: string }> => sources(path.join(ROOT, "src")).map((r) => ({ rel: r, text: readFileSync(path.join(ROOT, r), "utf8") }));

describe("the connector and core meet only where the end-state lists say", () => {
  it("no connector module imports core beyond the file lock and CONNECTOR_USES_CORE, no core module imports the connector beyond CORE_USES_CONNECTOR, and no line is stale", () => {
    assert.deepEqual(problems(crossEdges(repo())), []);
  });

  it("no format reader is left under src/formats/ outside the generic tier (layer.ts and files/ without docx)", () => {
    const left = sources(path.join(ROOT, "src", "formats")).filter((r) => r !== "src/formats/layer.ts" && !/^src\/formats\/files\/(?:align|csv|layer|scan|textlike)\.ts$/.test(r));
    assert.deepEqual(left, []);
  });

  describe("the check is not blind (planted, red-first)", () => {
    const ok = (r: string): boolean => exists(r) || r === "src/office/connector/xlsx/new.ts";
    const plant = (files: Array<{ rel: string; text: string }>): string[] => problems(crossEdges([...repo().filter((f) => !files.some((p) => p.rel === f.rel)), ...files], ok));

    it("a connector module importing a core module off the list fails, named", () => {
      assert.deepEqual(plant([{ rel: "src/office/connector/xlsx/new.ts", text: `import { x } from "../../../ledger.ts";` }]), [
        "connector module imports core: src/office/connector/xlsx/new.ts imports src/ledger.ts",
      ]);
    });
    it("a type-only or dynamic import counts", () => {
      assert.equal(plant([{ rel: "src/office/connector/xlsx/new.ts", text: `import type { T } from "../../../tasks.ts";\nconst m = await import("../../../signoff.ts");` }]).length, 2);
    });
    it("the file lock and a published helper are allowed", () => {
      assert.deepEqual(plant([{ rel: "src/office/connector/xlsx/new.ts", text: `import { withFileLock } from "../../../file-lock.ts";\nimport { decodePng } from "../../../../public-kit/helpers/png.mjs";` }]), []);
    });
    it("a core module importing the connector fails, named", () => {
      assert.deepEqual(plant([{ rel: "src/review-server.ts", text: readFileSync(path.join(ROOT, "src/review-server.ts"), "utf8") + `\nimport { readWorkbook } from "./office/connector/excel/workbook.ts";` }]), [
        "core module imports the connector: src/review-server.ts imports src/office/connector/excel/workbook.ts",
      ]);
    });
    it("a listed core module no connector module imports any more is stale", () => {
      const stale = problems({ connectorToCore: [], coreToConnector: [] });
      assert.deepEqual(stale, Object.keys(CONNECTOR_USES_CORE).map((t) => `stale CONNECTOR_USES_CORE line (no connector module imports it any more; delete it): ${t}`));
      assert.ok(stale.length > 0);
    });
  });
});
