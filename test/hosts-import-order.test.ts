// Every host profile module, and the registry, must load first in a fresh process without a ReferenceError (import cycle through narration.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

for (const mod of ["src/hosts/claude.ts", "src/hosts/codex.ts", "src/hosts/copilot.ts", "src/codex-config.ts", "src/hosts/index.ts"]) {
  test(`${mod} can be the first import`, () => {
    const code = `await import(${JSON.stringify(pathToFileURL(path.join(root, mod)).href)}); const h = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/hosts/index.ts")).href)}); console.log(h.allProfiles().map((p) => p.key).join(","));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "claude,codex,copilot");
  });
}
