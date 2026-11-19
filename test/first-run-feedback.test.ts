import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStatus, runInstall } from "../src/install.ts";
import { runTrack } from "../src/cli.ts";
import { skillText } from "../src/skill.ts";
import { chooseOpenTask } from "../src/open-pick.ts";
import { renderHome } from "../src/home-page.ts";
import { openLedger } from "../src/ledger.ts";

// first-run feedback; the person can tell whether tracking is on. Temp HOME only.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
async function rig() {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const userHome = path.join(sandbox, "home");
  mkdirSync(path.join(userHome, ".claude"), { recursive: true });
  writeFileSync(path.join(userHome, ".claude", "settings.json"), "{}\n");
  const folder = path.join(sandbox, "work");
  mkdirSync(folder);
  const dataHome = path.join(sandbox, "data");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, COPILOT_HOME: undefined };
  const res = await runInstall({ argv: ["node", "install.ts", "--home", dataHome, "--folder", folder, "--for", "claude"], env, cwd: sandbox, hookPath, stopReview: async () => "none", hookFires: () => undefined } as never);
  assert.equal(res.exitCode, 0, res.stderr);
  return { sandbox, userHome, dataHome, env };
}

describe("first-run feedback", () => {
  it("(1) the skill has the agent run track status after track start and say whether the session is listed", () => {
    const t = skillText("cocheck");
    assert.match(t, /track start`\. It takes effect[^\n]*Then run `cocheck track status` and tell the person whether this session is listed/);
    assert.match(t, /not listed[^\n]*tracking is off/);
  });

  it("(2) track start typed in a plain terminal says it changes nothing and to tell the agent; the agent's call (no TTY) is not told that", async () => {
    const r = await rig();
    const typed = runTrack(["start"], r.userHome, true);
    assert.match(typed.stdout, /This changes nothing/);
    assert.match(typed.stdout, /tell the agent "start tracking"/);
    assert.doesNotMatch(typed.stdout, /Tracking starts for this session/);
    // Guards against: a call from inside a tracked agent session (output captured, no TTY) must not be told it changes nothing
    for (const agent of [runTrack(["start"], r.userHome, false), runTrack(["start"], r.userHome)]) {
      assert.match(agent.stdout, /Tracking starts for this session with its next call/);
      assert.doesNotMatch(agent.stdout, /changes nothing/);
    }
  });

  it("(3) status before any hook call leads with installed; not seen yet, never recording; after a hook fire it says recording", async () => {
    const r = await rig();
    const before = installStatus(r.env, r.userHome, () => undefined).text;
    assert.match(before, /^CoCheck: installed; not seen yet\. Restart Claude, then say 'start tracking'/);
    assert.doesNotMatch(before, /recording to/);
    mkdirSync(path.join(r.dataHome, "journal"), { recursive: true });
    writeFileSync(path.join(r.dataHome, "journal", "s.jsonl"), `${JSON.stringify({ k: "event", host: "claude", at: new Date().toISOString() })}\n`);
    const after = installStatus(r.env, r.userHome, () => undefined).text;
    assert.match(after, /^CoCheck: recording to /);
    assert.doesNotMatch(after, /not seen yet/);
  });

  it("(4) the open-pick and home-page empty states say sessions start untracked and how to start", async () => {
    const pick = chooseOpenTask([], "/nowhere", {}, [], 1_800_000_000_000);
    assert.match("list" in pick ? pick.list : "", /Sessions start untracked: tell the agent "start tracking"/);
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-led-"));
    const ledger = openLedger(path.join(dir, "ledger.sqlite"));
    const html = renderHome(ledger, "tok", []);
    assert.match(html, /No sessions yet\. Sessions start untracked: tell the agent &quot;start tracking&quot;|No sessions yet\. Sessions start untracked: tell the agent "start tracking"/);
    ledger.close?.();
  });
});
