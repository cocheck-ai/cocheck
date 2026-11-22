import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHook, type HookExit } from "../src/hook-cli.ts";
import { runInstall } from "../src/install.ts";
import { allProfiles, findProfile, hasCapability, isHostKey, knownHostLabel, registerHost, type HostProfile } from "../src/hosts/index.ts";
import { profileOf } from "../src/hosts/index.ts";
const codex = profileOf("codex");
import { journalRecords, makeRig, type Rig } from "./hook-corpus.ts";

// the core reads each host's capabilities record, never a host name. A fourth host is one registry line; a host that lacks a
// capability gets the fallback. Every HOME and data home here is a fresh temp dir.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const dirs: string[] = [];
const rigs: Rig[] = [];
const undo: Array<() => void> = [];
afterEach(async () => {
  for (const u of undo.splice(0)) u();
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A fourth host, declared in one place. It is Codex's shape with its own key, folder and skill root, and none of the optional capabilities. */
const fake = (): HostProfile => ({
  ...codex,
  key: "zed",
  displayName: "Zed",
  capabilities: { failureEvent: false, argvTag: false, helperSessions: false, launchKey: false, readsForeignHooks: false },
  install: {
    ...codex.install!,
    hostFlag: "zed",
    skillRoot: path.join(".zed", "skills"),
    inBothAlias: undefined,
    reusesRecord: undefined,
    trustProblem: undefined,
    afterInstall: undefined,
    configFile: (_env, userHome) => path.join(userHome, ".zed", "config.toml"),
  },
});

const sandbox = async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(dir);
  return dir;
};

describe("a host lacking a capability gets the fallback, pinned per current host", () => {
  it("only Claude has the argv tag and SessionStart entry; only Copilot has helper sessions, the launch key and the foreign-hook gate", () => {
    const flags = (cap: "argvTag" | "helperSessions" | "launchKey" | "readsForeignHooks") => allProfiles().filter((p) => p.capabilities[cap]).map((p) => p.key);
    assert.deepEqual(flags("argvTag"), ["claude"]);
    assert.deepEqual(flags("helperSessions"), ["copilot"]);
    assert.deepEqual(flags("launchKey"), ["copilot"]);
    assert.deepEqual(flags("readsForeignHooks"), ["copilot"]);
    assert.equal(hasCapability("unknown-host", "argvTag"), false);
    assert.equal(hasCapability(undefined, "argvTag"), false);
  });

  it("a SessionStart sets the write hooks' environment for a host with argvTag and for no other", async () => {
    const r = await makeRig();
    rigs.push(r);
    undo.push(registerHost(fake()));
    const dir = await sandbox();
    const payload = (host: string) => ({ session_id: `s-${host}`, cwd: r.folder, hook_event_name: "SessionStart", transcript_path: "/x/t.jsonl" });
    const start = async (host: string): Promise<{ res: HookExit; envFile: string }> => {
      const envFile = path.join(dir, `${host}.env`);
      const res = await runHook({ argv: ["node", "hook.ts", "--host", host, "--folder", r.folder], env: { COCHECK_HOME: r.home, CLAUDE_ENV_FILE: envFile }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload(host))); })() });
      return { res, envFile };
    };
    const claude = await start("claude");
    assert.equal(claude.res.exitCode, 0, claude.res.stderr);
    assert.equal(existsSync(claude.envFile), true, "claude (argvTag) gets the environment");
    for (const host of ["codex", "copilot", "zed"]) {
      const { res, envFile } = await start(host);
      assert.equal(res.exitCode, 0, res.stderr);
      assert.equal(existsSync(envFile), false, `${host} has no argvTag, so no SessionStart entry`);
    }
  });
});

describe("a fourth host is one registry line", () => {
  it("is unknown until registered, then known everywhere the registry is read", () => {
    assert.equal(isHostKey("zed"), false);
    assert.equal(knownHostLabel("zed"), undefined);
    undo.push(registerHost(fake()));
    assert.equal(isHostKey("zed"), true);
    assert.equal(findProfile("zed")?.displayName, "Zed");
    assert.equal(knownHostLabel("zed"), "Zed");
  });

  it("install, --for and uninstall work for it with no other file edited", async () => {
    undo.push(registerHost(fake()));
    const box = await sandbox();
    const userHome = path.join(box, "home");
    mkdirSync(path.join(userHome, ".zed"), { recursive: true });
    const folder = path.join(box, "work");
    mkdirSync(folder);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: userHome };
    const run = (argv: string[]) => runInstall({ argv: ["node", "install.ts", ...argv], env, cwd: box, hookPath, platform: "darwin", hookFires: () => undefined, stopReview: async () => "no review process was running" });
    const done = await run(["--home", path.join(box, "data"), "--folder", folder, "--for", "zed"]);
    assert.equal(done.exitCode, 0, done.stderr);
    assert.match(readFileSync(path.join(userHome, ".zed", "config.toml"), "utf8"), /--host zed/);
    assert.equal(existsSync(path.join(userHome, ".zed", "skills", "cocheck", "SKILL.md")), true);
    assert.match(done.stdout, /Zed: hooks in [^\n]*config\.toml; skill in [^\n]*\.zed[\\/]skills[\\/]cocheck[\\/]SKILL\.md/);
    assert.equal(existsSync(path.join(userHome, ".claude")), false);
    assert.equal(existsSync(path.join(userHome, ".agents")), false);
    const gone = await run(["--uninstall", "--for", "zed"]);
    assert.equal(gone.exitCode, 0, gone.stderr);
    assert.equal(existsSync(path.join(userHome, ".zed", "config.toml")), false, "the install made the file, so the uninstall leaves none");
    assert.equal(existsSync(path.join(userHome, ".zed", "skills", "cocheck", "SKILL.md")), false);
    // `both` stays what it was; `--for` names the new key in its refusal.
    const both = await run(["--home", path.join(box, "data"), "--folder", folder, "--for", "both"]);
    assert.doesNotMatch(both.stdout, /Zed: hooks in/);
    const bad = await run(["--home", path.join(box, "data"), "--folder", folder, "--for", "nope"]);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /claude, codex, copilot, zed/);
  });

  it("the hook records its calls, adds no tag and handles no SessionStart environment", async () => {
    undo.push(registerHost(fake()));
    const r = await makeRig();
    rigs.push(r);
    const fire = (payload: unknown): Promise<HookExit> => runHook({ argv: ["node", "hook.ts", "--host", "zed", "--folder", r.folder], env: { COCHECK_HOME: r.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() });
    const base = { session_id: "s-zed", cwd: r.folder, transcript_path: "/x/zed.jsonl" };
    const pre = (id: string, command: string) => ({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command } });
    await fire(pre("z1", "cocheck track start"));
    const res = await fire(pre("z2", "python3 bump.py"));
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.stdout, "", "no argv tag for a host without the capability");
    assert.ok(journalRecords(r.home).some((rec: { id?: string }) => rec.id === "z2"));
  });
});
