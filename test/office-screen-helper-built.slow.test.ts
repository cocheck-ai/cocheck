// the screen helper is connector code. Its source lives at src/office/connector/native/cocheck-screen.m and the
// connector's prompt watch (screen-macos.ts SCREEN_HELPER, used by main.ts `officeDeps` and office-macos.ts launch time) looks for the built
// binary at dist/office/connector/helpers/cocheck-screen. This builds the real output into a temp dist (tsc -p tsconfig.build.json plus
// scripts/build-helpers.mjs), then loads the BUILT connector module and checks the helper is where it looks. If build-helpers.mjs still wrote
// to the old place, or the connector looked somewhere the build never writes, every Office review on a Mac would lose its prompt watch.
// macOS only: the helper is built with clang and only on macOS. Nothing here touches the checkout's dist/ or launches Office.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { placeKit } from "./helpers/install-layout.ts";

const ROOT = path.join(import.meta.dirname, "..");
const mac = process.platform === "darwin";

describe("the built connector finds the screen helper the build made (macOS only)", { skip: mac ? false : "macOS only: the helper is built with clang" }, () => {
  it("tsc to a temp dist plus build-helpers --dist puts cocheck-screen where the built screen-macos.js looks", { timeout: 600_000 }, async () => {
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "cocheck-")));
    const dist = path.join(tmp, "dist");
    symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"));
    placeKit(tmp); // public-kit beside dist, as installed
    const tsc = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", dist], { cwd: ROOT, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    const built = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-helpers.mjs"), `--dist=${dist}`], { cwd: ROOT, encoding: "utf8" });
    assert.equal(built.status, 0, built.stdout + built.stderr);

    const mod = (await import(pathToFileURL(path.join(dist, "office", "connector", "screen-macos.js")).href)) as { SCREEN_HELPER: string; macPromptWindows(os?: string): unknown };
    assert.equal(path.relative(dist, mod.SCREEN_HELPER), path.join("office", "connector", "helpers", "cocheck-screen"), "the built connector looks inside its own dist");
    assert.ok(existsSync(mod.SCREEN_HELPER), `no helper where the connector looks (${mod.SCREEN_HELPER}); build-helpers said:\n${built.stdout}${built.stderr}`);
    assert.ok((statSync(mod.SCREEN_HELPER).mode & 0o111) !== 0, "the helper is executable");
    assert.equal(typeof mod.macPromptWindows("darwin"), "function", "the prompt watch is wired on macOS");
    assert.equal(mod.macPromptWindows("linux"), undefined);
    assert.equal(existsSync(path.join(dist, "helpers", "cocheck-screen")), false, "no stray copy at the old path");
  });
});
