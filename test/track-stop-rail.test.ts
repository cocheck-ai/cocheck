import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runHook, type HookExit } from "../src/hook-cli.ts";
import { openLedger } from "../src/ledger.ts";
import { loadRows, taskHostOf } from "../src/timeline/load.ts";
import { buildTimeline, type Timeline } from "../src/timeline/timeline.ts";
import { buildRailModel, TRACKING_STOPPED } from "../src/timeline/rail/model.ts";
import { book, makeRig, type Rig } from "./hook-corpus.ts";

// A stop made by a shell command in the session shows on the rail. The record cannot say who decided (the skill has the agent run the
// command when the person asks), so the words name the command, never "the agent" or "you".
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const fire = (r: Rig, payload: unknown): Promise<HookExit> =>
  runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder], env: { COCHECK_HOME: r.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() });
const ev = (r: Rig, session: string) => {
  const base = { session_id: session, cwd: r.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default" };
  return {
    prompt: (text: string) => ({ ...base, hook_event_name: "UserPromptSubmit", prompt: text }),
    pre: (id: string, command: string) => ({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command } }),
    post: (id: string, command: string) => ({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: { stdout: "ok" } }),
  };
};
const railOf = (r: Rig) => {
  const l = openLedger(r.home);
  try {
    const tl = buildTimeline({ ...loadRows(l, 1, "test"), build: "t", folder: r.folder, host: taskHostOf(l, 1), stored: new Map(), formats: new Map(), quickLook: false }) as Timeline;
    return buildRailModel(tl);
  } finally {
    l.close();
  }
};
const work = async (r: Rig, c: ReturnType<typeof ev>) => {
  await fire(r, c.pre("sw1", "cocheck track start"));
  await fire(r, c.prompt("Raise every price"));
  await fire(r, c.pre("call_1", "python3 bump.py"));
  await writeFile(path.join(r.folder, "model.xlsx"), book({ A1: 10, A2: 2, A3: 3 }));
  await fire(r, c.post("call_1", "python3 bump.py"));
};

describe("tracking stop on the rail", () => {
  it("a stop command in the session shows as a visible rail row, worded as a command (never silent, never claims who)", async () => {
    const r = await makeRig();
    rigs.push(r);
    const c = ev(r, "s-1");
    await work(r, c);
    await fire(r, c.pre("sw2", "cocheck track stop"));
    const marks = railOf(r).stops.filter((s) => s.label === "Tracking stopped");
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.head, TRACKING_STOPPED);
    assert.match(marks[0]!.head, /stopped by a command in the session/);
    assert.doesNotMatch(marks[0]!.head, /\b(agent|you|person)\b/i);
  });

  it("no stop command, no mark (a session still tracked shows none)", async () => {
    const r = await makeRig();
    rigs.push(r);
    await work(r, ev(r, "s-2"));
    assert.equal(railOf(r).stops.filter((s) => s.label === "Tracking stopped").length, 0);
  });
});
