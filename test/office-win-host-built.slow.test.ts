// the Windows Office host script ships beside its module. The client (src/office/connector/office-win.ts HOST_SCRIPT) loads
// office-win.ps1 from its own folder, and tsc does not copy .ps1 files, so the build copies it (scripts/copy-connector-assets.mjs, run by
// scripts/build.mjs). This builds into a temp dist exactly that way, loads the BUILT module, and checks the script is where it looks and
// is the source's bytes. Runs on every OS (no PowerShell is started). Nothing here touches the checkout's dist/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { placeKit } from "./helpers/install-layout.ts";

const ROOT = path.join(import.meta.dirname, "..");

describe("the built Windows Office client finds its host script", () => {
  it("tsc to a temp dist plus copy-connector-assets --dist puts office-win.ps1 next to office-win.js", { timeout: 600_000 }, async () => {
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "cocheck-build-")));
    const dist = path.join(tmp, "dist");
    symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"));
    placeKit(tmp); // public-kit beside dist, as installed
    const tsc = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", dist], { cwd: ROOT, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    const copied = spawnSync(process.execPath, [path.join(ROOT, "scripts", "copy-connector-assets.mjs"), `--dist=${dist}`], { cwd: ROOT, encoding: "utf8" });
    assert.equal(copied.status, 0, copied.stdout + copied.stderr);
    const mod = (await import(pathToFileURL(path.join(dist, "office", "connector", "office-win.js")).href)) as { HOST_SCRIPT: string };
    assert.equal(path.relative(dist, mod.HOST_SCRIPT), path.join("office", "connector", "office-win.ps1"), "the built client looks inside its own dist");
    assert.ok(existsSync(mod.HOST_SCRIPT), `no host script where the client looks (${mod.HOST_SCRIPT})`);
    assert.equal(readFileSync(mod.HOST_SCRIPT, "utf8"), readFileSync(path.join(ROOT, "src", "office", "connector", "office-win.ps1"), "utf8"));
  });
  it("scripts/build.mjs runs the copy", () => {
    assert.match(readFileSync(path.join(ROOT, "scripts", "build.mjs"), "utf8"), /copy-connector-assets\.mjs/);
  });
});
