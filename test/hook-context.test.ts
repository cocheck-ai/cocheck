import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHookTracked as runHook, startSession } from "./helpers/track.ts";
import { runHook as runHookRaw } from "../src/hook-cli.ts";
import { dumpLedger, journalRecords } from "./hook-corpus.ts";

// on UserPromptSubmit in a watched folder the hook prints a short context text (Claude Code adds a UserPromptSubmit hook's stdout to
// the session), naming the folder and the open command. Nothing on any other event, outside the watched folders, or on an error. Every
// home and folder is a fresh temp dir; the real ~/.cocheck and ~/.claude are never read.
const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async (prefix: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${prefix}-`)));
  cleanups.push(d);
  return d;
};
const register = (home: string, folders: string[]) => writeFile(path.join(home, "watched.json"), JSON.stringify({ version: 1, folders }));
const prompt = (cwd: string, session = "s1") => ({ session_id: session, cwd, hook_event_name: "UserPromptSubmit", prompt: "make the summary" });
const fire = (home: string, folder: string, payload: unknown, extra: { fault?: (s: string) => void; root?: string; now?: () => number } = {}) =>
  runHook({
    argv: ["node", "hook.ts", "--host", "claude", "--folder", folder],
    env: { COCHECK_HOME: home },
    stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })(),
    ...extra,
  });
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("the hook tells Claude where to save and how to open the review", () => {
  it("UserPromptSubmit inside a watched folder: the text names the folder and the open command", async () => {
    const home = await tmp("home");
    const folder = await tmp("work");
    await mkdir(path.join(folder, "sub"));
    await register(home, [folder]);
    const res = await fire(home, folder, prompt(path.join(folder, "sub")));
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /CoCheck is recording this session/);
    assert.ok(res.stdout.includes(`inside ${folder}:`), res.stdout);
    assert.match(res.stdout, /temp or scratchpad/);
    // From a source checkout the form is the installer's: node <root>/scripts/cocheck.ts open.
    assert.ok(res.stdout.includes(`\`node ${path.join(repoRoot, "scripts", "cocheck.ts")} open\``), res.stdout);
    assert.ok(res.stdout.split(/(?<=\.) /).length <= 5, "about 3 to 5 sentences");
    // The prompt was still recorded.
    assert.ok(journalRecords(home).length > 0);
  });

  it("a packaged install (no scripts/cocheck.ts under the root) names `cocheck open`", async () => {
    const home = await tmp("home");
    const folder = await tmp("work");
    const root = await tmp("root");
    await register(home, [folder]);
    const res = await fire(home, folder, prompt(folder), { root });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(res.stdout.includes("run `cocheck open`"), res.stdout);
  });

  it("an untracked session, watched folder or not: no output and nothing written", async () => {
    const home = await tmp("home");
    const folder = await tmp("work");
    const elsewhere = await tmp("elsewhere");
    await register(home, [folder]);
    for (const where of [folder, elsewhere]) {
      const res = await runHookRaw({ argv: ["node", "hook.ts", "--host", "claude", "--folder", where], env: { COCHECK_HOME: home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(prompt(where))); })() });
      assert.deepEqual([res.exitCode, res.stdout, res.stderr], [0, "", ""]);
    }
    assert.deepEqual(journalRecords(home), []);
  });

  it("no registry: a tracked session still gets the text (watched.json is not what switches it on)", async () => {
    const home = await tmp("home");
    const folder = await tmp("work");
    const res = await fire(home, folder, prompt(folder));
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /CoCheck is recording this session/);
  });

  it("every other event inside a watched folder: no output", async () => {
    const home = await tmp("home");
    const folder = await tmp("work");
    await register(home, [folder]);
    const events = [
      { session_id: "s1", cwd: folder, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } },
      { session_id: "s1", cwd: folder, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" }, tool_response: { stdout: "" } },
      { session_id: "s1", cwd: folder, hook_event_name: "SubagentStop", agent_id: "a1" },
      { session_id: "s1", cwd: folder, hook_event_name: "Stop", stop_hook_active: false },
    ];
    for (const ev of events) {
      const res = await fire(home, folder, ev);
      assert.equal(res.exitCode, 0, `${ev.hook_event_name}: ${res.stderr}`);
      assert.equal(res.stdout, "", ev.hook_event_name);
    }
  });

  it("an error while building the text: no output, exit 0, and the ledger matches a run without the error", async () => {
    let clock = 1_700_000_000_000;
    const runOnce = async (fault?: (s: string) => void) => {
      const home = await tmp("home");
      const folder = await tmp("work");
      await register(home, [folder]);
      clock = 1_700_000_000_000;
      const res = await fire(home, folder, prompt(folder), { fault, now: () => (clock += 1000) });
      const ledger = dumpLedger(home, folder);
      return { res, ledger: JSON.stringify(ledger).split(JSON.stringify(folder).slice(1, -1)).join("<folder>"), journal: journalRecords(home).length };
    };
    const clean = await runOnce();
    const broken = await runOnce((step) => {
      if (step === "context") throw new Error("boom");
    });
    assert.notEqual(clean.res.stdout, "");
    assert.deepEqual([broken.res.exitCode, broken.res.stdout, broken.res.stderr], [0, "", ""]);
    assert.equal(broken.ledger, clean.ledger);
    assert.equal(broken.journal, clean.journal);
  });

  it("a capture failure on UserPromptSubmit: exit 1 as before, and no text", async () => {
    const home = await tmp("home");
    const folder = await tmp("work");
    await register(home, [folder]);
    const bad = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", folder], env: { COCHECK_HOME: home }, stdin: (async function* () { yield Buffer.from("{not json"); })() });
    assert.deepEqual([bad.exitCode, bad.stdout], [1, ""]);
  });

  it("the launcher passes the text through to Claude Code, and keeps stderr and the exit code", posixOnly("runs the POSIX hook-launch.sh launcher through /bin/sh; the Windows launcher is hook-launch.mjs"), async () => {
    const home = await tmp("home");
    const folder = await tmp("work");
    await register(home, [folder]);
    startSession(home, "claude", "s1", folder);
    const launcher = path.join(repoRoot, "scripts", "hook-launch.sh");
    const hook = path.join(repoRoot, "src", "hook.ts");
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, COCHECK_HOME: home, COCHECK_MANAGED: "1" };
    const ok = spawnSync("/bin/sh", [launcher, hook, "--host", "claude", "--folder", folder], { input: JSON.stringify(prompt(folder)), encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /CoCheck is recording this session/);
    assert.ok(ok.stdout.includes(folder));
    const pre = spawnSync("/bin/sh", [launcher, hook, "--host", "claude", "--folder", folder], { input: JSON.stringify({ session_id: "s1", cwd: folder, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t9", tool_input: { command: "ls" } }), encoding: "utf8", env });
    assert.deepEqual([pre.status, pre.stdout], [0, ""]);
    const bad = spawnSync("/bin/sh", [launcher, hook, "--host", "nope", "--folder", folder], { input: "{}", encoding: "utf8", env });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /usage: hook\.ts/);
  });
});
