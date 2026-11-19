import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { runHook as runHookRaw } from "../src/hook-cli.ts";
import { addToRegistry } from "../src/registry.ts";
import { installStatus, runInstall, type InstallResult } from "../src/install.ts";

// `--for <claude|codex|both|none>`. Every run uses a scratch HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and COCHECK_HOME under the temp dir;
// the real ~/.claude, ~/.codex and Keychain are never read or written. The Codex config is the probe recording's shape.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const realLauncher = path.resolve(import.meta.dirname, "..", "scripts", "hook-launch.sh");
const PROBE = path.join(import.meta.dirname, "fixtures", "codex-probe-config.toml");
const CLAUDE_OWN = { theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] }] } };

let sandbox: string;
let cfg: string;
let codexHome: string;
let userHome: string;
let dataHome: string;
const claudeFile = () => path.join(cfg, "settings.json");
const codexFile = () => path.join(codexHome, "config.toml");
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-h005-")));
  userHome = path.join(sandbox, "home");
  cfg = path.join(userHome, ".claude");
  codexHome = path.join(userHome, ".codex");
  dataHome = path.join(sandbox, "data");
  await mkdir(userHome, { recursive: true });
  await mkdir(cfg, { recursive: true }); // Claude Code is present (an install with no --for detects hosts by their config folder)
  const folder = path.join(sandbox, "work");
  await mkdir(folder, { recursive: true });
  return folder;
}
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codexHome });
const run = (argv: string[], extra: Partial<Parameters<typeof runInstall>[0]> = {}): Promise<InstallResult> =>
  runInstall({ argv: ["node", "install.ts", ...argv], env: env(), cwd: sandbox, hookPath, stopReview: async () => "no review process was running", ...extra });
const install = (folder: string, flags: string[] = [], extra: Partial<Parameters<typeof runInstall>[0]> = {}) => run(["--home", dataHome, "--folder", folder, ...flags], extra);
const seedClaude = () => mkdir(cfg, { recursive: true }).then(() => writeFile(claudeFile(), JSON.stringify(CLAUDE_OWN, null, 2) + "\n"));
const seedCodex = async (text?: string) => {
  await mkdir(codexHome, { recursive: true });
  await writeFile(codexFile(), text ?? (await readFile(PROBE, "utf8")));
};
const bytes = (f: string) => readFile(f);

/** A launcher that fails for one host and passes everything else to the real one. */
async function launcherFailingFor(host: string) {
  const file = path.join(sandbox, "launch.sh");
  await writeFile(file, `#!/bin/sh\ncase " $* " in *" --host ${host} "*) echo "forced failure for ${host}" >&2; exit 1;; esac\nexec /bin/sh '${realLauncher}' "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

describe("no flag is Claude only, as before", () => {
  it("leaves Codex alone and creates no Codex folder", async () => {
    const folder = await fresh();
    await seedCodex();
    const before = await bytes(codexFile());
    const res = await install(folder, ["--for", "claude"]); // with no flag a present Codex is installed too
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(existsSync(claudeFile()));
    assert.deepEqual(await bytes(codexFile()), before);
    assert.doesNotMatch(res.stdout, /trust/i);
  });

  it("--for claude equals no flag", async () => {
    const folder = await fresh();
    const res = await install(folder, ["--for", "claude"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(existsSync(claudeFile()));
    assert.equal(existsSync(codexHome), false);
  });
});

describe("--for codex", () => {
  it("adds CoCheck's hooks to config.toml, keeps every user byte, backs up first, says to trust", posixOnly("asserts the POSIX launcher command shape; the Windows shape is covered by install-win32"), async () => {
    const folder = await fresh();
    await seedCodex();
    const original = await bytes(codexFile());
    const res = await install(folder, ["--for", "codex"]);
    assert.equal(res.exitCode, 0, res.stderr);
    const after = await readFile(codexFile(), "utf8");
    assert.ok(after.startsWith(original.toString("utf8")), "the user's own bytes stay as a prefix");
    assert.deepEqual(await bytes(`${codexFile()}.cocheck-backup`), original);
    const commands = [...after.matchAll(/^command = "(.*)" # cocheck$/gm)].map((m) => m[1]);
    assert.equal(commands.length, 7);
    for (const c of commands) {
      assert.match(c, /COCHECK_MANAGED=1 COCHECK_HOME=/);
      assert.match(c, / --host codex$/);
      assert.doesNotMatch(c, /--folder/);
    }
    for (const e of ["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit"]) assert.match(after, new RegExp(`^\\[\\[hooks\\.${e}\\]\\] # cocheck$`, "m"));
    assert.match(res.stdout, /trust the new hooks in Codex once/i);
    assert.equal(existsSync(claudeFile()), false, "Claude was not asked for");
    assert.match(res.stdout, /records the folder your agent is opened in/);
  });

  it("a second install changes nothing; uninstall --for codex restores the original bytes", async () => {
    const folder = await fresh();
    await seedCodex();
    const original = await bytes(codexFile());
    await install(folder, ["--for", "codex"]);
    const once = await bytes(codexFile());
    assert.equal((await install(folder, ["--for", "codex"])).exitCode, 0);
    assert.deepEqual(await bytes(codexFile()), once);
    const un = await run(["--uninstall", "--for", "codex"]);
    assert.equal(un.exitCode, 0, un.stderr);
    assert.deepEqual(await bytes(codexFile()), original);
  });

  it("works on a config that does not exist yet, and uninstall removes the file it created", async () => {
    const folder = await fresh();
    const res = await install(folder, ["--for", "codex"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(await readFile(codexFile(), "utf8"), /--host codex/);
    assert.equal((await run(["--uninstall", "--for", "codex"])).exitCode, 0);
    assert.equal(existsSync(codexFile()), false, "an absent config stays absent");
  });
});

describe("--for both, none, and uninstall", () => {
  it("both writes both configs and keeps the user's own entries in both", async () => {
    const folder = await fresh();
    await seedClaude();
    await seedCodex();
    const res = await install(folder, ["--for", "both"]);
    assert.equal(res.exitCode, 0, res.stderr);
    const claude = JSON.parse(await readFile(claudeFile(), "utf8"));
    assert.equal(claude.theme, "dark");
    assert.deepEqual(claude.hooks.PreToolUse[0], CLAUDE_OWN.hooks.PreToolUse[0]);
    assert.match(await readFile(codexFile(), "utf8"), /--host codex/);
    assert.match(res.stdout, /trust the new hooks in Codex once/i);
  });

  it("uninstall --for codex leaves Claude installed and keeps the install record; status names both hosts", async () => {
    const folder = await fresh();
    await seedClaude();
    await seedCodex();
    await install(folder, ["--for", "both"]);
    let st = installStatus(env(), userHome);
    assert.equal(st.recording, true, st.text);
    assert.match(st.text, /Claude: installed/);
    assert.match(st.text, /Codex: installed/);
    const claudeBefore = await bytes(claudeFile());
    const un = await run(["--uninstall", "--for", "codex"]);
    assert.equal(un.exitCode, 0, un.stderr);
    assert.deepEqual(await bytes(claudeFile()), claudeBefore);
    assert.doesNotMatch(await readFile(codexFile(), "utf8"), /cocheck/);
    st = installStatus(env(), userHome);
    assert.equal(st.recording, true, st.text);
    assert.match(st.text, /Claude: installed/);
    assert.match(st.text, /Codex: not installed/);
  });

  it("uninstall with no flag removes every host the install recorded", async () => {
    const folder = await fresh();
    await install(folder, ["--for", "both"]);
    const un = await run(["--uninstall"]);
    assert.equal(un.exitCode, 0, un.stderr);
    assert.equal(existsSync(codexFile()), false, "Codex's config, made by the install, goes with it");
    assert.doesNotMatch(await readFile(claudeFile(), "utf8"), /COCHECK_MANAGED/);
  });

  it("none sets up the data home and review page with no hooks for any host", async () => {
    const folder = await fresh();
    await seedClaude();
    await seedCodex();
    const [c, x] = [await bytes(claudeFile()), await bytes(codexFile())];
    const res = await install(folder, ["--for", "none"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(await bytes(claudeFile()), c);
    assert.deepEqual(await bytes(codexFile()), x);
    assert.ok(existsSync(path.join(dataHome, "watched.json")));
    assert.match(res.stdout, /records the folder your agent is opened in/);
    assert.doesNotMatch(res.stdout, /trust/i);
    const st = installStatus(env(), userHome);
    assert.equal(st.recording, false);
    assert.match(st.text, /Claude: not installed/);
    assert.match(st.text, /Codex: not installed/);
  });

  it("an unknown --for value is refused", async () => {
    const folder = await fresh();
    const res = await install(folder, ["--for", "gemini"]);
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /--for/);
  });
});

describe("refusals and rollback leave every config as it was", () => {
  for (const [name, text] of [
    ["an inline [hooks] table", '[hooks]\nPreToolUse = []\n'],
    ["a [hooks.X] table", '[hooks.PreToolUse]\nmatcher = "x"\n'],
    ["a root hooks.X = [...] key", 'hooks.PreToolUse = [{ type = "command", command = "x" }]\n'],
  ] as const) {
    it(`refuses ${name}, touching neither config`, async () => {
      const folder = await fresh();
      await seedClaude();
      await seedCodex(text);
      const [c, x] = [await bytes(claudeFile()), await bytes(codexFile())];
      const res = await install(folder, ["--for", "both"]);
      assert.equal(res.exitCode, 1);
      assert.match(res.stderr, /config\.toml/);
      assert.match(res.stderr, /hooks/);
      assert.deepEqual(await bytes(claudeFile()), c);
      assert.deepEqual(await bytes(codexFile()), x);
      assert.equal(existsSync(`${codexFile()}.cocheck-backup`), false);
    });
  }

  it("a failed Codex check restores Codex and also Claude to their pre-install bytes", async () => {
    const folder = await fresh();
    await seedClaude();
    await seedCodex();
    const [c, x] = [await bytes(claudeFile()), await bytes(codexFile())];
    const res = await install(folder, ["--for", "both"], { launcher: await launcherFailingFor("codex") });
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /Nothing was installed/);
    assert.deepEqual(await bytes(claudeFile()), c);
    assert.deepEqual(await bytes(codexFile()), x);
    assert.equal(existsSync(`${claudeFile()}.cocheck-backup`), false);
    assert.equal(existsSync(`${codexFile()}.cocheck-backup`), false);
    assert.equal(installStatus(env(), userHome).record, undefined);
  });

  it("a failed Codex-only check removes a config CoCheck created", async () => {
    const folder = await fresh();
    const res = await install(folder, ["--for", "codex"], { launcher: await launcherFailingFor("codex") });
    assert.equal(res.exitCode, 1);
    assert.equal(existsSync(codexFile()), false);
  });
});

describe("the Codex hook takes its task folder from the payload's cwd", () => {
  const stdin = (o: unknown) => (async function* () { yield Buffer.from(JSON.stringify(o)); })();
  const payload = (cwd: string) => ({ session_id: "019a-codex-session", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "call_h005" });

  it("records inside a watched folder with no --folder and no folder variable", async () => {
    const folder = await fresh();
    addToRegistry(dataHome, folder);
    const res = await runHook({ argv: ["node", "hook.ts", "--host", "codex"], env: { COCHECK_HOME: dataHome, COCHECK_MANAGED: "1" }, stdin: stdin(payload(folder)) });
    assert.equal(res.exitCode, 0, res.stderr);
    const { readdirSync } = await import("node:fs");
    assert.ok(readdirSync(path.join(dataHome, "journal")).some((n) => n.endsWith(".jsonl")));
  });

  it("writes nothing for an untracked session, whatever its cwd (a watched folder no longer records by itself)", async () => {
    const folder = await fresh();
    addToRegistry(dataHome, folder);
    const res = await runHookRaw({ argv: ["node", "hook.ts", "--host", "codex"], env: { COCHECK_HOME: dataHome, COCHECK_MANAGED: "1" }, stdin: stdin(payload(sandbox)) });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(existsSync(path.join(dataHome, "journal")), false);
  });

  it("Claude still takes CLAUDE_PROJECT_DIR and ignores the payload cwd", async () => {
    const folder = await fresh();
    addToRegistry(dataHome, folder);
    const res = await runHook({ argv: ["node", "hook.ts", "--host", "claude"], env: { COCHECK_HOME: dataHome, COCHECK_MANAGED: "1", CLAUDE_PROJECT_DIR: folder }, stdin: stdin(payload(sandbox)) });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(existsSync(path.join(dataHome, "journal")), "the variable names the folder; the payload cwd is not read");
    // A tracked Claude session with no variable, no --folder and no stored folder has no task folder: loud, as for any other event.
    const bare = await runHook({ argv: ["node", "hook.ts", "--host", "claude"], env: { COCHECK_HOME: dataHome, COCHECK_MANAGED: "1" }, stdin: stdin({ ...payload(folder), session_id: "bare" }) });
    assert.equal(bare.exitCode, 1);
  });
});
