import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hookFires, installStatus, runInstall, type InstallResult } from "../src/install.ts";
import { platformFor } from "../src/platform/index.ts";

// install, reinstall and uninstall with the Windows platform injected (`run.platform = "win32"`). Nothing here spawns powershell or icacls:
// the install check is stubbed (one test runs the real check through `node`, which exists on every runner). Paths use path.join and os.tmpdir, so
// the same file runs on a Windows runner. Every home is a temp dir; HOME and USERPROFILE both point at it.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const NO_HOST_VARS = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, COPILOT_HOME: undefined };
async function rig(platform: string) {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(sandbox);
  const userHome = path.join(sandbox, "home");
  mkdirSync(userHome);
  for (const h of [".claude", ".codex", ".copilot"]) mkdirSync(path.join(userHome, h));
  const folder = path.join(sandbox, "work");
  mkdirSync(folder);
  const dataHome = path.join(sandbox, "data");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome, ...NO_HOST_VARS };
  const fires: string[] = [];
  const run = (argv: string[]): Promise<InstallResult> =>
    runInstall({ argv: ["node", "install.ts", ...argv], env, cwd: sandbox, hookPath, platform, stopReview: async () => "no review process was running", hookFires: (launcher, _hook, _env, _install, plat) => { fires.push(`${path.basename(launcher)}:${plat?.name}`); return undefined; } });
  return { userHome, folder, dataHome, env, run, fires, sandbox };
}
/** Every file under `dir` (relative path -> bytes as hex), folders listed too. */
function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      out[path.relative(base, f) + "/"] = "";
      snapshot(f, base, out);
    } else out[path.relative(base, f)] = readFileSync(f).toString("hex");
  }
  return out;
}

describe("Windows install gate and hook commands", () => {
  it("installs on win32: Claude and Codex carry the command, Copilot's powershell field carries it and bash is absent", async () => {
    const r = await rig("win32");
    const res = await r.run(["--home", r.dataHome, "--folder", r.folder]);
    assert.equal(res.exitCode, 0, res.stderr);
    const launcher = path.resolve(import.meta.dirname, "..", "scripts", "hook-launch.mjs");
    const prefix = `node "${launcher}" COCHECK_MANAGED=1 --home "${r.dataHome}" "${hookPath}" --host `;
    const claude = JSON.parse(readFileSync(path.join(r.userHome, ".claude", "settings.json"), "utf8"));
    assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, `${prefix}claude`);
    const codex = readFileSync(path.join(r.userHome, ".codex", "config.toml"), "utf8");
    assert.ok(codex.includes(`command = ${JSON.stringify(`${prefix}codex`)}`), "Codex's command field carries the win32 command");
    const copilot = JSON.parse(readFileSync(path.join(r.userHome, ".copilot", "hooks", "cocheck.json"), "utf8"));
    assert.equal(copilot.hooks.postToolUse[0].powershell, `${prefix}copilot --event postToolUse`);
    assert.equal(copilot.hooks.preToolUse[0].powershell, `${prefix}copilot --event preToolUse; exit 0`);
    for (const list of Object.values<any[]>(copilot.hooks)) assert.equal("bash" in list[0], false);
    assert.deepEqual([...new Set(r.fires)], ["hook-launch.mjs:win32"]);
    assert.match(res.stdout, /Needs Node 22\.18 or newer/);
  });

  it("macOS bytes are unchanged: bash field, shell launcher, no powershell", async () => {
    const r = await rig("darwin");
    const res = await r.run(["--home", r.dataHome, "--folder", r.folder]);
    assert.equal(res.exitCode, 0, res.stderr);
    const copilot = JSON.parse(readFileSync(path.join(r.userHome, ".copilot", "hooks", "cocheck.json"), "utf8"));
    assert.match(copilot.hooks.preToolUse[0].bash, /^COCHECK_MANAGED=1 COCHECK_HOME='.*' \/bin\/sh '.*hook-launch\.sh' '.*' --host copilot --event preToolUse \|\| true$/);
    assert.equal("powershell" in copilot.hooks.preToolUse[0], false);
    assert.deepEqual([...new Set(r.fires)], ["hook-launch.sh:darwin"]);
  });

  it("linux stays refused", async () => {
    const r = await rig("linux");
    const res = await r.run(["--home", r.dataHome, "--folder", r.folder]);
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /Linux is not supported/);
  });
});

describe("Windows round trip leaves each host config as it was", () => {
  it("install, reinstall, uninstall: byte-identical except the declared footprint (the .cocheck-backup copies)", async () => {
    const r = await rig("win32");
    const claudeFile = path.join(r.userHome, ".claude", "settings.json");
    const codexFile = path.join(r.userHome, ".codex", "config.toml");
    writeFileSync(claudeFile, JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2) + "\n");
    writeFileSync(codexFile, 'model = "gpt-5"\n\n[projects."x"]\ntrust_level = "trusted"\n');
    const before = snapshot(r.userHome);
    const args = ["--home", r.dataHome, "--folder", r.folder];
    assert.equal((await r.run(args)).exitCode, 0);
    const first = snapshot(r.userHome);
    assert.equal((await r.run(args)).exitCode, 0);
    const record = path.join(".config", "cocheck", "install.json"); // carries installedAt, so it differs by design
    // Existing behaviour on every platform: a reinstall backs up Copilot's own file (it existed by then), so that one backup is new.
    const copilotBackup = path.join(".copilot", "hooks", "cocheck.json.cocheck-backup");
    const { [copilotBackup]: made, ...again } = snapshot(r.userHome);
    assert.ok(made !== undefined);
    assert.deepEqual({ ...again, [record]: "" }, { ...first, [record]: "" }, "a reinstall changes nothing else");
    const out = await r.run(["--uninstall"]);
    assert.equal(out.exitCode, 0, out.stderr);
    const after = snapshot(r.userHome);
    const footprint = Object.keys(after).filter((k) => !(k in before));
    assert.deepEqual(footprint.filter((k) => k !== copilotBackup && k !== path.join(".copilot", "hooks") + "/").sort(), [path.join(".claude", "settings.json.cocheck-backup"), path.join(".codex", "config.toml.cocheck-backup")].sort());
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} is byte-identical`);
    assert.equal(existsSync(path.join(r.userHome, ".copilot", "hooks", "cocheck.json")), false, "Copilot's file is gone");
    assert.equal(existsSync(path.join(r.userHome, ".config")), false);
  });

  it("uninstall finds a Copilot entry in either field (a foreign file is never removed)", async () => {
    const r = await rig("win32");
    const file = path.join(r.userHome, ".copilot", "hooks", "cocheck.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const foreign = JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", powershell: "echo COCHECK_MANAGED=1 & del *" }] } });
    writeFileSync(file, foreign);
    const res = await r.run(["--uninstall", "--for", "copilot"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(readFileSync(file, "utf8"), foreign);
    // A bash-field entry in CoCheck's marked shape (an install from a Git Bash setup) is found too.
    const win = platformFor("win32");
    const cmd = win.hookCommand.build({ dataHome: r.dataHome, launcher: "C:\\l\\hook-launch.mjs", hookPath: "C:\\h\\hook.js", host: "copilot" });
    writeFileSync(file, JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: `${cmd} --event preToolUse` }] } }));
    assert.equal((await r.run(["--uninstall", "--for", "copilot"])).exitCode, 0);
    assert.equal(existsSync(file), false);
  });
});

describe("Windows status and install check", () => {
  it("status names live Excel and the per-call tag as absent, one plain line each, on win32 only", async () => {
    const r = await rig("win32");
    assert.equal((await r.run(["--home", r.dataHome, "--folder", r.folder])).exitCode, 0);
    const win = installStatus(r.env, r.userHome, undefined, platformFor("win32")).text;
    assert.match(win, /^  Live Excel: not available on this system[^\n]*$/m);
    assert.match(win, /^  Per-call tag: not available on this system[^\n]*$/m);
    assert.doesNotMatch(win, /hooks missing/);
    const mac = installStatus(r.env, r.userHome, undefined, platformFor("darwin")).text;
    assert.doesNotMatch(mac, /Live Excel|Per-call tag/);
  });

  it("the real install check starts node on hook-launch.mjs the way the host would (no shell)", async () => {
    const r = await rig("win32");
    const launcher = path.resolve(import.meta.dirname, "..", "scripts", "hook-launch.mjs");
    const install = (await import("../src/hosts/index.ts")).findProfile("claude")!.install!;
    assert.equal(hookFires(launcher, hookPath, { PATH: process.env.PATH, ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }) }, install, platformFor("win32")), undefined);
  });
});
