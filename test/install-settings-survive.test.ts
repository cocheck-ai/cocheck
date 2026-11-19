import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runInstall, type InstallResult } from "../src/install.ts";
import { defaultProfile } from "../src/hosts/index.ts";
import * as normalizeMod from "../src/normalize.ts";

// the one install command. Every run is sandboxed: HOME, COCHECK_HOME and CLAUDE_CONFIG_DIR are fresh temp dirs, checked
// non-empty and under the temp dir before each test. The real ~/.claude/settings.json is only ever read, for the hash test.
const REAL_SETTINGS = path.join(process.env.HOME ?? "", ".claude", "settings.json");
const realHash = () => (existsSync(REAL_SETTINGS) ? createHash("sha256").update(readFileSync(REAL_SETTINGS)).digest("hex") : "absent");
const hashBefore = realHash();
const realHome = process.env.HOME;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, COCHECK_HOME: process.env.COCHECK_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

let sandbox: string;
let cfg: string;
let dataHome: string;
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const settingsPath = () => path.join(cfg, "settings.json");
const backupPath = () => path.join(cfg, "settings.json.cocheck-backup");

before(async () => {
  assert.ok(realHome, "the real HOME must be known to guard it");
});
after(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-s002-install-")));
  cfg = path.join(sandbox, "home", ".claude");
  dataHome = path.join(sandbox, "data");
  await mkdir(path.join(sandbox, "home"), { recursive: true });
  await mkdir(cfg, { recursive: true }); // Claude Code is present (an install with no --for detects hosts by their config folder)
  process.env.HOME = path.join(sandbox, "home");
  process.env.USERPROFILE = process.env.HOME; // os.homedir() reads USERPROFILE on Windows
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.COCHECK_HOME = dataHome;
  for (const k of ["HOME", "CLAUDE_CONFIG_DIR", "COCHECK_HOME"] as const) {
    assert.ok(process.env[k] && process.env[k]!.startsWith(sandbox), `${k} must be non-empty and inside the sandbox`);
  }
  assert.ok(homedir().startsWith(sandbox), "os.homedir() must follow the sandbox HOME");
  assert.notEqual(path.resolve(cfg), path.join(realHome!, ".claude"));
  const folder = path.join(sandbox, "work");
  await mkdir(folder, { recursive: true });
  return folder;
}
const noBuild = { hookPath, build: () => { throw new Error("build must not run when the hook exists"); } };
const run = (argv: string[], extra: Partial<Parameters<typeof runInstall>[0]> = {}): Promise<InstallResult> =>
  runInstall({ argv: ["node", "install.ts", ...argv], env: { ...process.env } as NodeJS.ProcessEnv, cwd: sandbox, ...noBuild, ...extra });
const install = (folder: string, extra: string[] = []) => run(["--home", dataHome, "--folder", folder, ...extra]);
const userSettings = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"], deny: ["Read(.env)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/my-guard", timeout: 5 }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    Stop: [{ hooks: [{ type: "command", command: "afplay done.wav" }] }],
  },
  enabledPlugins: { "x@y": true },
};
const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const managed = (s: any) => JSON.stringify(s).includes("COCHECK_MANAGED=1");

describe("other settings survive install, reinstall and uninstall", () => {
  it("preserves other hooks, keys and permissions; backup equals the original bytes; idempotent", async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    const original = JSON.stringify(userSettings, null, 4) + "\n";
    await writeFile(settingsPath(), original);
    const first = await install(folder);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(await readFile(backupPath(), "utf8"), original);
    const after1 = await readJson(settingsPath());
    assert.equal(managed(after1), true);
    for (const ev of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "UserPromptSubmit"]) {
      assert.equal(JSON.stringify(after1.hooks[ev]).includes("COCHECK_MANAGED=1"), true, ev);
    }
    // CoCheck's SessionStart entry (the write hooks' environment) is added after the user's own, which stays first and unchanged.
    assert.deepEqual(after1.hooks.SessionStart[0], userSettings.hooks.SessionStart[0]);
    assert.equal(JSON.stringify(after1.hooks.SessionStart.slice(1)).includes("COCHECK_MANAGED=1"), true);
    assert.deepEqual(after1.hooks.PreToolUse[0], userSettings.hooks.PreToolUse[0]);
    assert.deepEqual(after1.hooks.Stop[0], userSettings.hooks.Stop[0]);
    assert.deepEqual({ ...after1, hooks: undefined }, { ...userSettings, hooks: undefined });
    const second = await install(folder);
    assert.equal(second.exitCode, 0, second.stderr);
    assert.deepEqual(await readJson(settingsPath()), after1);
    assert.equal(JSON.stringify(after1).split("COCHECK_MANAGED=1").length - 1, 7);
    const un = await run(["--uninstall"]);
    assert.equal(un.exitCode, 0, un.stderr);
    assert.deepEqual(await readJson(settingsPath()), userSettings);
    assert.equal(await readFile(backupPath(), "utf8"), original);
  });

  it("uninstall leaves a settings file with no hooks of its own as it was", async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    await writeFile(settingsPath(), JSON.stringify({ model: "x" }));
    assert.equal((await install(folder)).exitCode, 0);
    assert.equal((await run(["--uninstall"])).exitCode, 0);
    assert.deepEqual(await readJson(settingsPath()), { model: "x" });
  });

  it("the written command carries the marker, the home and the absolute hook path", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const cmd = (await readJson(settingsPath())).hooks.PreToolUse.flatMap((g: any) => g.hooks).map((h: any) => h.command)[0] as string;
    assert.match(cmd, /COCHECK_MANAGED=1/);
    assert.ok(cmd.includes(`COCHECK_HOME=${dataHome}`) || cmd.includes(`COCHECK_HOME='${dataHome}'`));
    assert.ok(cmd.includes(hookPath));
    assert.match(cmd, /--host claude/);
  });
});

describe("missing, empty, symlinked and invalid settings", () => {
  it("a missing file (and directory) is created, with no backup", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    assert.equal(managed(await readJson(settingsPath())), true);
    assert.equal(existsSync(backupPath()), false);
  });

  it("an empty file is filled", async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    await writeFile(settingsPath(), "");
    assert.equal((await install(folder)).exitCode, 0);
    assert.equal(managed(await readJson(settingsPath())), true);
  });

  it("a symlinked settings file is edited in place: the link survives, the target changes", async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    const real = path.join(sandbox, "dotfiles", "claude-settings.json");
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, JSON.stringify(userSettings));
    await symlink(real, settingsPath());
    assert.equal((await install(folder)).exitCode, 0);
    assert.equal((await lstat(settingsPath())).isSymbolicLink(), true);
    assert.equal(managed(await readJson(real)), true);
    assert.equal((await run(["--uninstall"])).exitCode, 0);
    assert.equal((await lstat(settingsPath())).isSymbolicLink(), true);
    assert.deepEqual(await readJson(real), userSettings);
  });

  for (const [name, text] of [["truncated JSON", '{ "hooks": { '], ["a JSON array", "[1,2]"], ["hooks of the wrong shape", '{"hooks": []}'], ["an event of the wrong shape", '{"hooks": {"Stop": {}}}'], ["prose", "hello"]] as const) {
    it(`invalid settings (${name}): exit non-zero, the file, any backup and the registry untouched`, async () => {
      const folder = await fresh();
      await mkdir(cfg, { recursive: true });
      await writeFile(settingsPath(), text);
      await writeFile(backupPath(), "KEEP");
      const res = await install(folder);
      assert.notEqual(res.exitCode, 0);
      assert.doesNotMatch(res.stdout, /records the folder your agent is opened in/);
      assert.equal(await readFile(settingsPath(), "utf8"), text);
      assert.equal(await readFile(backupPath(), "utf8"), "KEEP");
      assert.equal(existsSync(path.join(dataHome, "watched.json")), false);
      const un = await run(["--uninstall"]);
      assert.notEqual(un.exitCode, 0);
      assert.equal(await readFile(settingsPath(), "utf8"), text);
    });
  }
});

describe("the first backup is kept", () => {
  it("a second install over changed settings does not overwrite the first backup", async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    const original = JSON.stringify(userSettings);
    await writeFile(settingsPath(), original);
    assert.equal((await install(folder)).exitCode, 0);
    const later = { ...userSettings, model: "sonnet", ...{ extra: true } };
    const withCoCheck = await readJson(settingsPath());
    await writeFile(settingsPath(), JSON.stringify({ ...withCoCheck, ...later, hooks: withCoCheck.hooks }));
    assert.equal((await install(folder)).exitCode, 0);
    assert.equal(await readFile(backupPath(), "utf8"), original);
    assert.equal((await run(["--uninstall"])).exitCode, 0);
    assert.equal(await readFile(backupPath(), "utf8"), original);
  });

  it("an existing backup file from before is never replaced", async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    await writeFile(settingsPath(), JSON.stringify(userSettings));
    await writeFile(backupPath(), "older backup");
    assert.equal((await install(folder)).exitCode, 0);
    assert.equal(await readFile(backupPath(), "utf8"), "older backup");
  });
});

describe("the registry, the home and the watching sign", () => {
  it("registers the folder (default cwd), and a second folder is added without dropping the first", async () => {
    const folder = await fresh();
    const second = path.join(sandbox, "work2");
    await mkdir(second);
    assert.equal((await run(["--home", dataHome], { cwd: folder })).exitCode, 0);
    assert.equal((await install(second)).exitCode, 0);
    const reg = await readJson(path.join(dataHome, "watched.json"));
    assert.deepEqual([...reg.folders].sort(), [folder, second].sort());
  });

  it("install requires an explicit --home", async () => {
    const folder = await fresh();
    const res = await run(["--folder", folder]);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /--home/);
    assert.equal(existsSync(settingsPath()), false);
  });

  it("~/.cocheck (and anything inside it) stays refused, and nothing is written", async () => {
    const folder = await fresh();
    for (const home of [path.join(homedir(), ".cocheck"), path.join(homedir(), ".cocheck", "sub")]) {
      const res = await run(["--home", home, "--folder", folder]);
      assert.notEqual(res.exitCode, 0, home);
      assert.equal(existsSync(settingsPath()), false);
      assert.equal(existsSync(path.join(homedir(), ".cocheck")), false);
    }
  });

  it("a relative --home is refused", async () => {
    const folder = await fresh();
    assert.notEqual((await run(["--home", "rel/data", "--folder", folder])).exitCode, 0);
  });

  it("prints the records-the-folder line only after the hook-fires check passes", async () => {
    const folder = await fresh();
    const ok = await install(folder);
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.ok(ok.stdout.includes(`The install check ran in ${folder}`));
    const sandbox2 = await mkdtemp(path.join(tmpdir(), "cocheck-s002-bad-"));
    try {
      const folder2 = path.join(sandbox, "work3");
      await mkdir(folder2);
      const bad = await run(["--home", path.join(sandbox, "data2"), "--folder", folder2], { hookPath: path.join(sandbox2, "missing-hook.js"), build: () => {} });
      assert.notEqual(bad.exitCode, 0);
      assert.doesNotMatch(bad.stdout, /records the folder your agent is opened in/);
      assert.match(bad.stderr, /hook/i);
    } finally {
      await rm(sandbox2, { recursive: true, force: true });
    }
  });

  it("the hook-fires check writes to a scratch home, never the chosen data home", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    assert.deepEqual((await readdir(dataHome)).sort(), ["installed-node.txt", "watched.json"]);
  });

  it("says nothing about LibreOffice (CoCheck does not use it)", async () => {
    const folder = await fresh();
    assert.doesNotMatch((await install(folder)).stdout, /LibreOffice/);
  });

  it("builds when the built hook is missing and refuses a Node that is too old", async () => {
    const folder = await fresh();
    let built = 0;
    const dist = path.join(sandbox, "dist-hook.mjs");
    const res = await run(["--home", dataHome, "--folder", folder], { hookPath: dist, build: () => { built++; require_copy(hookPath, dist); } });
    assert.equal(built, 1);
    assert.equal(res.exitCode, 0, res.stderr);
    const old = await run(["--home", dataHome, "--folder", folder], { nodeVersion: "20.1.0" });
    assert.notEqual(old.exitCode, 0);
    assert.match(old.stderr, /Node/);
  });
});

function require_copy(from: string, to: string) {
  // the "build": a tiny wrapper that runs the real hook source, so the check can fire it
  const body = `import ${JSON.stringify(from)};\n`;
  writeFileSyncCompat(to, body);
}
import { writeFileSync as writeFileSyncCompat } from "node:fs";

describe("the prompt hook is installed", () => {
  it("install writes UserPromptSubmit with no matcher, next to the other events; uninstall removes it", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const hooks = (await readJson(settingsPath())).hooks;
    assert.equal(hooks.UserPromptSubmit?.length, 1);
    assert.ok(!("matcher" in hooks.UserPromptSubmit[0]), "UserPromptSubmit takes no matcher");
    assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /COCHECK_MANAGED=1/);
    for (const e of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop"]) assert.ok(hooks[e], `${e} still installed`);
    assert.equal((await run(["--uninstall"])).exitCode, 0);
    assert.equal(existsSync(settingsPath()) ? JSON.stringify((await readJson(settingsPath())).hooks ?? {}) : "{}", "{}");
  });

  it("the installer's event list equals the set of events the hook adapter handles", () => {
    const installed = [...defaultProfile().install!.events].sort();
    const handled = [...((normalizeMod as any).HANDLED_EVENTS ?? [])].sort();
    assert.ok(handled.length > 0, "normalize.ts must export HANDLED_EVENTS");
    assert.deepEqual(installed, handled);
  });
});

describe("the real home is never touched", () => {
  it("the real ~/.claude/settings.json hash is unchanged by this file's runs (read-only check)", () => {
    assert.equal(realHash(), hashBefore);
  });
});
