import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexSpawnPlan, resolveCodexBin } from "../src/hosts/codex-bin.ts";
import { platformFor } from "../src/platform/index.ts";

// On Windows, npm installs an extensionless `codex` sh shim beside codex.cmd and codex.ps1; the resolver must not take the shim.
const win = platformFor("win32");
const none = "/nonexistent/bundled";
let npmDir: string;
async function dir(files: string[]): Promise<string> {
  npmDir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  for (const f of files) await writeFile(path.join(npmDir, f), "x", { mode: 0o755 });
  return npmDir;
}
afterEach(() => undefined);

describe("resolveCodexBin on win32", () => {
  it("finds codex.cmd next to the npm shim and the .ps1, never the extensionless shim", async () => {
    const d = await dir(["codex", "codex.cmd", "codex.ps1"]);
    assert.equal(resolveCodexBin({ PATH: d }, none, win), path.join(d, "codex.cmd"));
  });
  it("finds codex.exe", async () => {
    const d = await dir(["codex.exe"]);
    assert.equal(resolveCodexBin({ PATH: d }, none, win), path.join(d, "codex.exe"));
  });
  it("must not: only the shim, or nothing, reads as not installed", async () => {
    const d = await dir(["codex", "codex.ps1"]);
    assert.equal(resolveCodexBin({ PATH: d }, none, win), undefined);
    assert.equal(resolveCodexBin({ PATH: "/nonexistent" }, none, win), undefined);
  });
  it("the Windows spelling Path is read", async () => {
    const d = await dir(["codex.cmd"]);
    assert.equal(resolveCodexBin({ Path: d }, none, win), path.join(d, "codex.cmd"));
  });
  it("posix still takes the extensionless codex", async () => {
    const d = await dir(["codex", "codex.cmd"]);
    assert.equal(resolveCodexBin({ PATH: d }, none, platformFor("darwin")), path.join(d, "codex"));
  });
});

describe("codexSpawnPlan", () => {
  it("a .cmd runs through a shell with the path quoted; an .exe or posix binary does not", () => {
    assert.deepEqual(codexSpawnPlan("C:\\Users\\a b\\AppData\\Roaming\\npm\\codex.cmd"), { command: '"C:\\Users\\a b\\AppData\\Roaming\\npm\\codex.cmd"', shell: true });
    assert.deepEqual(codexSpawnPlan("C:\\x\\codex.exe"), { command: "C:\\x\\codex.exe", shell: false });
    assert.deepEqual(codexSpawnPlan("/usr/local/bin/codex"), { command: "/usr/local/bin/codex", shell: false });
  });
});
