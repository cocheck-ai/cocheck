import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a helper's write carries `agent_id`. The main thread's open `wait_agent` (ops 1109/1110, 1119/1120)
// must not share its credit, or the change reads "can't tell which" (a "?" actor).
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const book = path.join(folder, "book.xlsx");
  await copyFile(probe(0), book);
  let clock = 1_000_000;
  const opts = { perSession: false, host: "codex" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const call = (event: string, id: string, tool: string, agent?: string) =>
    send({ hook_event_name: event, tool_name: tool, tool_use_id: id, tool_input: { command: "python3 edit.py" }, ...(agent ? { agent_id: agent } : {}) });
  const credited = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.filePath === book && s.credited.length > 0).map((s) => s.credited);
    } finally {
      l.close();
    }
  };
  await call("PreToolUse", "warm", "shell");
  await call("PostToolUse", "warm", "shell");
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  return { call, credited, write: (n: number) => copyFile(probe(n), book) };
}

describe("a waiting parent call does not share a helper's credit", () => {
  it("the helper's write is credited to the helper alone, not to the open wait_agent", async () => {
    const t = await setup();
    await t.call("PreToolUse", "wait1", "wait_agent");
    await t.call("PreToolUse", "h1", "shell", "helperA");
    await t.write(1);
    await t.call("PostToolUse", "h1", "shell", "helperA");
    assert.deepEqual(t.credited(), [["h1"]]);
  });

  it("the real Codex name `collaborationwait_agent` (recorded) is a wait too", async () => {
    const t = await setup();
    await t.call("PreToolUse", "wait1", "collaborationwait_agent");
    await t.call("PreToolUse", "h1", "apply_patch", "helperA");
    await t.write(1);
    await t.call("PostToolUse", "h1", "apply_patch", "helperA");
    assert.deepEqual(t.credited(), [["h1"]]);
  });

  it("a tool that only contains wait in its name still joins", async () => {
    const t = await setup();
    await t.call("PreToolUse", "m1", "await_input");
    await t.call("PreToolUse", "h1", "shell", "helperA");
    await t.write(1);
    await t.call("PostToolUse", "h1", "shell", "helperA");
    assert.deepEqual(t.credited(), [["h1", "m1"]]);
  });

  it("a main call that is not a wait still joins a helper's write", async () => {
    const t = await setup();
    await t.call("PreToolUse", "m1", "shell");
    await t.call("PreToolUse", "h1", "shell", "helperA");
    await t.write(1);
    await t.call("PostToolUse", "h1", "shell", "helperA");
    assert.deepEqual(t.credited(), [["h1", "m1"]]);
  });
});
