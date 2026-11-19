import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStatus, runInstall } from "../src/install.ts";
import { main, versionText } from "../src/cli.ts";

// What the Homebrew package relies on. Scratch HOME, CLAUDE_CONFIG_DIR and data home; the real ones are never read or written.
const repo = path.resolve(import.meta.dirname, "..");
const hookPath = path.join(repo, "src", "hook.ts");
const launcher = path.join(repo, "scripts", "hook-launch.sh");

let sandbox: string;
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
const fresh = async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-s013-")));
  await mkdir(path.join(sandbox, "home"), { recursive: true });
  await mkdir(path.join(sandbox, "work"), { recursive: true });
};
const fakeNode = async (file: string, body: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
};
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: path.join(sandbox, "home"), CLAUDE_CONFIG_DIR: path.join(sandbox, "home", ".claude"), ...extra });
const install = (extra: NodeJS.ProcessEnv, opts: Partial<Parameters<typeof runInstall>[0]> = {}) =>
  runInstall({ argv: ["node", "install.ts", "--home", path.join(sandbox, "data"), "--folder", path.join(sandbox, "work"), "--for", "claude"], env: env(extra), cwd: sandbox, hookPath, stopReview: async () => "none", ...opts });
const hookCommand = async () => JSON.parse(await readFile(path.join(sandbox, "home", ".claude", "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;

describe("cocheck --version", () => {
  it("prints the package version, and the build stamp when dist/build-info.json exists", async () => {
    await fresh();
    await writeFile(path.join(sandbox, "package.json"), JSON.stringify({ version: "9.8.7" }));
    assert.equal(versionText(sandbox), "cocheck 9.8.7\n");
    await mkdir(path.join(sandbox, "dist"));
    await writeFile(path.join(sandbox, "dist", "build-info.json"), JSON.stringify({ builtAt: Date.UTC(2026, 9, 15, 12, 0, 0) }));
    assert.equal(versionText(sandbox), "cocheck 9.8.7 (built 2026-10-15T12:00:00.000Z)\n");
  });

  it("is a command: exit 0 and the repo's own version", async () => {
    const res = await main(["--version"]);
    const { version } = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.startsWith(`cocheck ${version}`), res.stdout);
  });
});

describe("the hook resolves Homebrew's stable node", () => {
  it("COCHECK_NODE wins over a different node on PATH, and a missing COCHECK_NODE falls back to PATH", posixOnly("runs the POSIX hook-launch.sh launcher through /bin/sh; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    const stable = await fakeNode(path.join(sandbox, "prefix", "opt", "node", "bin", "node"), 'echo stable > "$COCHECK_HOME/ran"');
    await fakeNode(path.join(sandbox, "other", "node"), 'echo other > "$COCHECK_HOME/ran"');
    const data = path.join(sandbox, "data");
    await mkdir(data, { recursive: true });
    const launch = (extra: NodeJS.ProcessEnv) => spawnSync("/bin/sh", [launcher, hookPath, "--host", "claude"], { input: "{}", encoding: "utf8", env: { HOME: path.join(sandbox, "home"), COCHECK_HOME: data, PATH: `${path.join(sandbox, "other")}:/usr/bin:/bin`, ...extra } });
    assert.equal(launch({ COCHECK_NODE: stable }).status, 0);
    assert.equal((await readFile(path.join(data, "ran"), "utf8")).trim(), "stable");
    assert.equal(launch({ COCHECK_NODE: path.join(sandbox, "gone", "node") }).status, 0);
    assert.equal((await readFile(path.join(data, "ran"), "utf8")).trim(), "other");
  });

  it("the default search list names the stable opt/node paths before the plain bin links", async () => {
    const text = await readFile(launcher, "utf8");
    assert.match(text, /COCHECK_NODE_SEARCH:-\/opt\/homebrew\/opt\/node\/bin\/node \/usr\/local\/opt\/node\/bin\/node \/opt\/homebrew\/bin\/node/);
  });

  it("the installer records the wrapper's COCHECK_NODE in the hook command, and only then", posixOnly("runs the POSIX hook-launch.sh launcher through /bin/sh; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    const stable = await fakeNode(path.join(sandbox, "prefix", "opt", "node", "bin", "node"), 'exec "' + process.execPath + '" "$@"');
    const withPin = await install({ COCHECK_NODE: stable });
    assert.equal(withPin.exitCode, 0, withPin.stderr);
    const cmd = await hookCommand();
    assert.ok(cmd.includes(`COCHECK_NODE='${stable}'`), cmd);
    assert.doesNotMatch(cmd, /Cellar/);
    // The pinned entry is still recognised as CoCheck's: status sees it, and uninstall removes it.
    assert.equal(installStatus(env({ COCHECK_NODE: stable }), path.join(sandbox, "home")).recording, true);
    const gone = await install({ COCHECK_NODE: stable }, { argv: ["node", "install.ts", "--uninstall"] });
    assert.equal(gone.exitCode, 0, gone.stderr);
    assert.doesNotMatch(await readFile(path.join(sandbox, "home", ".claude", "settings.json"), "utf8"), /COCHECK_MANAGED/);
    await rm(sandbox, { recursive: true, force: true });
    await fresh();
    const unpinned = await install({});
    assert.equal(unpinned.exitCode, 0, unpinned.stderr);
    assert.doesNotMatch(await hookCommand(), /COCHECK_NODE/);
  });

  it("a packaged layout (dist and scripts/hook-launch.sh, no src) installs, and COCHECK_ROOT names the stable libexec", posixOnly("runs the POSIX hook-launch.sh launcher through /bin/sh; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    const libexec = path.join(sandbox, "prefix", "opt", "cocheck", "libexec");
    await mkdir(path.join(libexec, "scripts"), { recursive: true });
    await mkdir(path.join(libexec, "dist"), { recursive: true });
    await cp(launcher, path.join(libexec, "scripts", "hook-launch.sh"));
    await writeFile(path.join(libexec, "package.json"), JSON.stringify({ version: "0.0.1" }));
    // The hook entry is the repo's own (a stand-in dist/hook.js cannot record); the launcher and the missing src/ come from the packaged layout.
    const res = await install({ COCHECK_ROOT: libexec });
    assert.equal(res.exitCode, 0, res.stderr);
    const cmd = await hookCommand();
    assert.ok(cmd.includes(path.join(libexec, "scripts", "hook-launch.sh")), cmd);
    assert.match(res.stdout, /Open the review page: cocheck open/);
  });
});
