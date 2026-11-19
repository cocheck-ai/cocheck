// Architecture pin (kept): a connector's runtime files stand alone. They import only node: built-ins, never mention src/ outside
// comments, and sit in a folder with no package.json or node_modules. Walks every connector runtime file left in the repo, except exactly the
// folders the production built-in list names (src/connector/builtins.ts): a built-in ships inside CoCheck and starts CoCheck's own program.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { PRODUCTION_BUILTIN_CONNECTORS } from "../src/connector/builtins.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The roots that hold connector runtime files: connectors/ when it exists, the public kit's toy product and the scaffold template. */
export function connectorRoots(root: string): string[] {
  return [path.join(root, "connectors"), path.join(root, "public-kit", "toy-product"), path.join(root, "public-kit", "scaffold", "template")].filter((d) => existsSync(d));
}

export function runtimeFiles(dirs: string[]): string[] {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(?:mjs|js|cjs|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(f); } };
  for (const d of dirs) walk(d);
  return files;
}

/** True when `file` is `dir` itself or inside it (a sibling sharing a name prefix is not). */
const within = (dir: string, file: string): boolean => { const rel = path.relative(dir, file); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };

/** Violations of the pin for the given roots; empty means clean. Files inside an `exempt` folder are not walked. */
export function pinViolations(root: string, dirs: string[], exempt: readonly string[] = []): string[] {
  const files = runtimeFiles(dirs).filter((f) => !exempt.some((d) => within(d, f)));
  const out: string[] = [];
  if (files.length === 0) return ["found no connector runtime file"];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const specs = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const s of specs) if (!s.startsWith("node:")) out.push(`${path.relative(root, f)} imports ${s}`);
    if (/\bsrc\//.test(src.replace(/^\s*\/\/.*$/gm, ""))) out.push(`${path.relative(root, f)} mentions src/ outside comments`);
  }
  for (const d of dirs) for (const bad of ["package.json", "node_modules"]) if (existsSync(path.join(d, bad))) out.push(`${path.relative(root, d)} has ${bad}`);
  return out;
}

describe("connector runtime pin: node: built-ins only, no src/ import, no package.json", () => {
  it("every connector runtime file in the repo is clean, and at least one was found (the production built-in folders are exempt)", () => {
    const dirs = connectorRoots(ROOT);
    assert.ok(runtimeFiles(dirs).length >= 1, "found at least one runtime file");
    assert.deepEqual(pinViolations(ROOT, dirs, PRODUCTION_BUILTIN_CONNECTORS.map((b) => b.dir)), []);
  });

  it("the exemption is exactly the production built-in folders: each exists, and a sibling with a longer name is still walked", async () => {
    for (const b of PRODUCTION_BUILTIN_CONNECTORS) assert.ok(existsSync(path.join(b.dir, "cocheck-connector.json")), `${b.id} folder is in the repo`);
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(path.join(tmpdir(), "pin-exempt-"));
    for (const name of ["shipped", "shipped-extra", "other"]) {
      mkdirSync(path.join(root, "connectors", name), { recursive: true });
      writeFileSync(path.join(root, "connectors", name, "connector.mjs"), 'const p = "../../src/x.ts";\n');
    }
    const got = pinViolations(root, [path.join(root, "connectors")], [path.join(root, "connectors", "shipped")]);
    assert.deepEqual(got.sort(), ["connectors/other/connector.mjs mentions src/ outside comments", "connectors/shipped-extra/connector.mjs mentions src/ outside comments"]);
  });

  it("must not: a planted file importing ../src, one importing a package, and a package.json are each caught", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(path.join(tmpdir(), "pin-"));
    const dir = path.join(root, "connectors", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "connector.mjs"), 'import { x } from "../src/foo.ts";\n');
    assert.match(pinViolations(root, [path.join(root, "connectors")]).join("\n"), /imports \.\.\/src\/foo\.ts/);
    writeFileSync(path.join(dir, "connector.mjs"), 'import pkg from "left-pad";\n');
    assert.match(pinViolations(root, [path.join(root, "connectors")]).join("\n"), /imports left-pad/);
    writeFileSync(path.join(dir, "connector.mjs"), 'import fs from "node:fs";\n');
    writeFileSync(path.join(root, "connectors", "package.json"), "{}");
    assert.match(pinViolations(root, [path.join(root, "connectors")]).join("\n"), /has package\.json/);
    assert.deepEqual(pinViolations(root, []), ["found no connector runtime file"]);
  });
});
