import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runHook, type HookExit } from "../src/hook-cli.ts";
import { openLedger } from "../src/ledger.ts";
import { homePage } from "../src/review-server.ts";
import { listTracked } from "../src/tracking.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// D2: a session that has just started tracking, with no call recorded yet, is on the home page. Temp homes only.
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const fire = (r: Rig, payload: unknown): Promise<HookExit> =>
  runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder], env: { COCHECK_HOME: r.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() });
const base = (r: Rig, session: string) => ({ session_id: session, cwd: r.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default" });
const pre = (r: Rig, session: string, id: string, command: string) => ({ ...base(r, session), hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command } });
const post = (r: Rig, session: string, id: string, command: string) => ({ ...base(r, session), hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: { stdout: "ok" } });
const home = (r: Rig): string => {
  const ledger = openLedger(r.home);
  try {
    return homePage(ledger, "tok", undefined, listTracked(r.home));
  } catch (e) {
    throw e;
  } finally {
    ledger.close();
  }
};

describe("D2: a newly tracked session reaches the home page", () => {
  it("shows right after start tracking, and again after the turn's Stop, with no second prompt", async () => {
    const r = await makeRig();
    rigs.push(r);
    await fire(r, pre(r, "s-d2", "sw1", "cocheck track start"));
    await fire(r, post(r, "s-d2", "sw1", "cocheck track start"));
    const html = home(r);
    assert.doesNotMatch(html, /Nothing is waiting for review/, "the tracked session is on the page");
    assert.match(html, /Tracking in .*, nothing recorded yet/);
    await fire(r, { ...base(r, "s-d2"), hook_event_name: "Stop", last_assistant_message: "Tracking is on." });
    assert.match(home(r), /Tracking in .*, nothing recorded yet/, "still there after the Stop");
  });

  it("a session that was never tracked, or was stopped with nothing recorded, is not a phantom on the home page", async () => {
    const r = await makeRig();
    rigs.push(r);
    await fire(r, { ...base(r, "s-never"), hook_event_name: "UserPromptSubmit", prompt: "hello" });
    assert.match(home(r), /No sessions yet|Nothing is waiting for review/, "untracked prompt: nothing listed");
    await fire(r, pre(r, "s-stop", "a", "cocheck track start"));
    await fire(r, pre(r, "s-stop", "b", "cocheck track stop"));
    assert.match(home(r), /No sessions yet|Nothing is waiting for review/, "started then stopped with no calls: nothing listed");
  });
});
