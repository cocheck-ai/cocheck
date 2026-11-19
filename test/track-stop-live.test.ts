import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runHook, type HookExit } from "../src/hook-cli.ts";
import { openLedger } from "../src/ledger.ts";
import { readRows } from "../src/timeline/load.ts";
import { liveState } from "../src/timeline/rail/live.ts";
import type { RawOp } from "../src/timeline/runs.ts";
import { book, makeRig, type Rig } from "./hook-corpus.ts";

// `cocheck track stop` writes an end-of-work mark into the session's task, so the page leaves "Agent still working".
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
const opsOf = (r: Rig): RawOp[] => {
  const l = openLedger(r.home);
  try {
    return readRows(l, 1).ops;
  } finally {
    l.close();
  }
};
const live = (ops: RawOp[]) => liveState(ops, Date.now() + 1000).live;

describe("stopping tracking ends 'still working'", () => {
  it("live while working, not live after the stop command, live again from the next prompt after a new start", async () => {
    const r = await makeRig();
    rigs.push(r);
    const c = ev(r, "s-stop");
    await fire(r, c.pre("sw1", "cocheck track start"));
    await fire(r, c.prompt("Raise every price"));
    await fire(r, c.pre("call_1", "python3 bump.py"));
    await writeFile(path.join(r.folder, "model.xlsx"), book({ A1: 10, A2: 2, A3: 3 }));
    await fire(r, c.post("call_1", "python3 bump.py"));
    assert.equal(live(opsOf(r)), true, "working before the stop");
    await fire(r, c.prompt("Stop the cocheck tracking"));
    await fire(r, c.pre("sw2", "cocheck track stop"));
    const ops = opsOf(r);
    assert.equal(live(ops), false, "the stop command ends the work");
    // Guard: the mark holds nothing about the stopped stretch.
    const argsOf = (o: RawOp): any => JSON.parse(o.args_json ?? "{}");
    const mark = ops.filter((o) => argsOf(o).hookEvent === "TrackingStopped");
    assert.equal(mark.length, 1);
    assert.deepEqual(Object.keys(argsOf(mark[0]!)).sort(), ["at", "hookAdapter", "hookEvent", "hookOpKey", "host", "session_id"]);
    assert.ok(!JSON.stringify(argsOf(mark[0]!)).includes("Stop the cocheck"), "no prompt text in the mark");
    // Stopped work adds nothing, so the task stays not live.
    await fire(r, c.prompt("more while stopped"));
    assert.equal(live(opsOf(r)), false);
    // A new start: live again from the next prompt, not from the start itself.
    await fire(r, c.pre("sw3", "cocheck track start"));
    assert.equal(live(opsOf(r)), false, "the start alone is not a prompt");
    await fire(r, c.prompt("Carry on"));
    assert.equal(live(opsOf(r)), true);
  });

  it("a stop of a session that never had a task writes nothing", async () => {
    const r = await rig2();
    const c = ev(r, "s-none");
    await fire(r, c.pre("sw1", "cocheck track start"));
    await fire(r, c.pre("sw2", "cocheck track stop"));
    assert.equal(opsOf(r).length, 0);
  });

  it("a second session still working in the task keeps it live", () => {
    const op = (id: number, session: string, args: Record<string, unknown>): RawOp => ({ id, args: { hookAdapter: 1, host: "claude", session_id: session, at: 1000 * id, ...args } }) as unknown as RawOp;
    const ops = [
      op(1, "A", { hookEvent: "UserPromptSubmit", prompts: ["do it"] }),
      op(2, "B", { hookEvent: "UserPromptSubmit", prompts: ["and me"] }),
      op(3, "A", { hookEvent: "TrackingStopped" }),
    ];
    assert.equal(liveState(ops, 4000).live, true, "B is still mid-turn");
    assert.equal(liveState([...ops, op(4, "B", { hookEvent: "Stop" })], 5000).live, false);
    assert.equal(liveState([...ops, op(4, "B", { hookEvent: "TrackingStopped" })], 5000).live, false);
  });
});

const rig2 = async () => {
  const r = await makeRig();
  rigs.push(r);
  return r;
};
