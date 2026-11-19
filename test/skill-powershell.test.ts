import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInstall } from "../src/install.ts";
import { skillText } from "../src/skill.ts";
import { trackCommand, trackingOf } from "../src/tracking.ts";
import { runHook } from "../src/hook-cli.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// Codex on Windows read the skill's "Bash" as WSL bash.exe (denied by its sandbox). A win32 install says PowerShell; darwin is unchanged.
const ONE_COMMAND_RULE = "Do not put anything before it on the line, do not put it in a string, an echo or a heredoc, and do not chain it with another command: only a command that begins with exactly `cocheck track` switches tracking.";
// sha256 of skillText("cocheck") before this change (computed from the code at b7f8922).
const DARWIN_SHA = "699b6ed5601857e7afff851b51ac1397eeda95c2019dd43a3b15fad9a444d130";

const dirs: string[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  for (const r of rigs.splice(0)) await r.cleanup();
});

async function installOn(platform: string): Promise<string> {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(sandbox);
  const userHome = path.join(sandbox, "home");
  mkdirSync(userHome);
  for (const h of [".claude", ".codex", ".copilot"]) mkdirSync(path.join(userHome, h));
  const folder = path.join(sandbox, "work");
  mkdirSync(folder);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, COPILOT_HOME: undefined };
  const res = await runInstall({ argv: ["node", "install.ts", "--home", path.join(sandbox, "data"), "--folder", folder], env, cwd: sandbox, hookPath: path.resolve(import.meta.dirname, "..", "src", "hook.ts"), platform, stopReview: async () => "none", hookFires: () => undefined });
  assert.equal(res.exitCode, 0, res.stderr);
  return readFileSync(path.join(userHome, ".claude", "skills", "cocheck", "SKILL.md"), "utf8");
}

describe("skill text per platform", () => {
  it("a win32 install writes a skill that says PowerShell, never WSL bash, and keeps the one-command rule word for word", async () => {
    const t = await installOn("win32");
    assert.match(t, /Run each command below as its own shell command in PowerShell \(never WSL bash\), by itself\./);
    assert.ok(t.includes(ONE_COMMAND_RULE));
    assert.doesNotMatch(t, /Bash command/);
  });

  it("the darwin skill text is byte-identical to before", async () => {
    assert.equal(createHash("sha256").update(skillText("cocheck")).digest("hex"), DARWIN_SHA);
    const t = await installOn("darwin");
    assert.equal(t, skillText(t.match(/run `(.*?) track start`/)![1]));
    assert.match(t, /as its own Bash command, by itself\./);
  });
});

describe("the hook switches tracking only on a command that begins exactly with cocheck track, from each host's PowerShell tool", () => {
  const fire = async (r: Rig, host: string, payload: unknown, extra: string[] = []) => runHook({ argv: ["node", "hook.ts", "--host", host, ...extra], env: { ...process.env, COCHECK_HOME: r.home, HOME: r.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })(), now: () => Date.now() } as never);
  const cases: Array<[string, string, (command: string) => unknown, string[]]> = [
    ["claude", "s-claude", (command) => ({ session_id: "s-claude", cwd: "", transcript_path: "/x/c.jsonl", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_use_id: "t", tool_input: { command } }), []],
    ["codex", "s-codex", (command) => ({ session_id: "s-codex", cwd: "", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t", tool_input: { command } }), []],
    ["copilot", "s-copilot", (command) => ({ sessionId: "s-copilot", cwd: "", toolName: "powershell", toolArgs: { command } }), ["--event", "preToolUse"]],
  ];
  for (const [host, session, mk, extra] of cases) {
    it(`${host}: PowerShell start/stop switch tracking; a mention, a chain or a prefix does not`, async () => {
      const r = await makeRig();
      rigs.push(r);
      const send = (command: string) => {
        const p = mk(command) as { cwd: string };
        p.cwd = r.folder;
        return fire(r, host, p, extra);
      };
      for (const bad of ['Write-Output "cocheck track start"', "Get-Date; cocheck track start", "echo cocheck track start", "wsl cocheck track start"]) {
        await send(bad);
        assert.equal(trackingOf(r.home, host, session), undefined, bad);
      }
      await send("cocheck track start");
      assert.equal(trackingOf(r.home, host, session)?.folder, r.folder, "start switches on");
      await send("Get-Date; cocheck track stop");
      assert.ok(trackingOf(r.home, host, session) !== undefined, "a chained stop does not switch off");
      await send("& cocheck track stop");
      assert.equal(trackingOf(r.home, host, session), undefined, "stop switches off");
    });
  }
  it("the matcher itself", () => {
    assert.equal(trackCommand("cocheck track start"), "start");
    assert.equal(trackCommand("Get-Date; cocheck track start"), undefined);
  });
});
