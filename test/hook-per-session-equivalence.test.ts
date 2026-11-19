import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleHook, type HookOptions, type HookPayload } from "../src/hook-adapter.ts";
import { book, dumpLedger } from "./hook-corpus.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the shipping default (one task per session) must record, for ONE session that writes, exactly what the old shared-task shape recorded.
// Each scenario runs twice in fresh folders, once with `perSession: false` (main's behaviour) and once on the default, and the two ledgers are
// compared whole: tasks, ops, steps, file states, rounds and review rows (client names compared without their `?session=` suffix).
// A session whose calls never change a file gets no task by design (item 3); every scenario here writes.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Rig {
  folder: string;
  outside: string;
  home: string;
  ev: (event: string, id?: string, command?: string, extra?: Record<string, unknown>) => Promise<unknown>;
  write: (cells: Record<string, number>, name?: string) => Promise<void>;
  writeOutside: (cells: Record<string, number>) => Promise<void>;
  tick: () => number;
}

async function runScenario(perSession: boolean, script: (r: Rig) => Promise<void>, over: Partial<HookOptions> = {}): Promise<Record<string, unknown[]>> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-t130eq-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-t130eq-folder-")));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-t130eq-outside-")));
  cleanups.push(async () => {
    for (const d of [home, folder, outside]) await rm(d, { recursive: true, force: true });
  });
  await writeFile(path.join(folder, "model.xlsx"), book({ A1: 1, A2: 2, A3: 3 }));
  await writeFile(path.join(outside, "ext.xlsx"), book({ A1: 5 }));
  let clock = 1_700_000_000_000;
  const opts: HookOptions = { host: "claude", home, claimed: workbookClaims, folder, now: () => (clock += 1000), perSession, ...over };
  const ev = (hook_event_name: string, id?: string, command = "python3 edit.py", extra: Record<string, unknown> = {}) =>
    handleHook({ session_id: "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name, ...(id ? { tool_name: "Bash", tool_use_id: id, tool_input: { command, description: `do ${id}` } } : {}), ...extra } as HookPayload, opts);
  const rig: Rig = {
    folder,
    outside,
    home,
    ev,
    write: (cells, name = "model.xlsx") => writeFile(path.join(folder, name), book(cells)),
    writeOutside: (cells) => writeFile(path.join(outside, "ext.xlsx"), book(cells)),
    tick: () => (clock += 1000),
  };
  await script(rig);
  return JSON.parse(JSON.stringify(dumpLedger(home, folder)).split(JSON.stringify(outside).slice(1, -1)).join("<outside>"));
}

/** Both runs, compared whole; `must` guards against a scenario that recorded nothing. */
async function same(name: string, script: (r: Rig) => Promise<void>, over: Partial<HookOptions> = {}): Promise<void> {
  const old = await runScenario(false, script, over);
  const now = await runScenario(true, script, over);
  assert.ok((old.tasks as unknown[]).length === 1 && (old.ops as unknown[]).length > 0, `${name}: the scenario records a task`);
  for (const table of Object.keys(old)) assert.deepEqual(now[table], old[table], `${name}: table ${table}`);
}

describe("the default per-session path equals the old shape for one writing session", () => {
  it("credit: a call that writes is credited; Stop cuts the round", async () => {
    await same("credit", async (r) => {
      await r.ev("UserPromptSubmit", undefined, "", { prompt: "raise A1" });
      await r.ev("PreToolUse", "c1");
      await r.write({ A1: 10, A2: 2, A3: 3 });
      await r.ev("PostToolUse", "c1");
      await r.ev("Stop");
    });
  });

  it("a read-only call before the first write is logged in the task the write opens", async () => {
    await same("read first", async (r) => {
      await r.ev("PreToolUse", "r1", "ls");
      await r.ev("PostToolUse", "r1", "ls");
      await r.ev("PreToolUse", "c1");
      await r.write({ A1: 10, A2: 2, A3: 3 });
      await r.ev("PostToolUse", "c1");
      await r.ev("Stop");
    });
  });

  it("joint: overlapping calls of one session share the change", async () => {
    await same("joint", async (r) => {
      await r.ev("PreToolUse", "a");
      await r.ev("PreToolUse", "b");
      await r.write({ A1: 11, A2: 2, A3: 3 });
      await r.ev("PostToolUse", "b");
      await r.ev("PostToolUse", "a");
      await r.ev("Stop");
    });
  });

  it("round cutting: two rounds, the second after more edits", async () => {
    await same("rounds", async (r) => {
      await r.ev("PreToolUse", "c1");
      await r.write({ A1: 10, A2: 2, A3: 3 });
      await r.ev("PostToolUse", "c1");
      await r.ev("Stop");
      await r.ev("UserPromptSubmit", undefined, "", { prompt: "now A3" });
      await r.ev("PreToolUse", "c2");
      await r.write({ A1: 10, A2: 2, A3: 30 });
      await r.ev("PostToolUse", "c2");
      await r.ev("Stop");
    });
  });

  it("Stop: a helper's call still open at the main Stop, a failed call and a new workbook", async () => {
    await same("stop", async (r) => {
      await r.ev("PreToolUse", "main1");
      await r.write({ A1: 10, A2: 2, A3: 3 });
      await r.ev("PostToolUse", "main1");
      await r.ev("PreToolUse", "h1", "sleep 5", { agent_id: "agent-1", agent_type: "general-purpose" });
      await r.ev("PreToolUse", "bad");
      await r.ev("PostToolUseFailure", "bad", "python3 broken.py", { error: "Exit code 3\nboom" });
      await r.ev("PreToolUse", "mk");
      await r.write({ A1: 1 }, "new.xlsx");
      await r.ev("PostToolUse", "mk");
      await r.ev("Stop");
      await r.ev("SubagentStop", undefined, "", { agent_id: "agent-1", agent_type: "general-purpose" });
    });
  });

  it("a hand edit between calls (nobody's change) is recorded in the task as before", async () => {
    await same("hand edit", async (r) => {
      await r.ev("PreToolUse", "c1");
      await r.write({ A1: 10, A2: 2, A3: 3 });
      await r.ev("PostToolUse", "c1");
      await r.write({ A1: 10, A2: 2, A3: 33 }); // the user saves in Excel
      await r.ev("PreToolUse", "c2", "ls");
      await r.ev("PostToolUse", "c2", "ls");
      await r.ev("Stop");
    });
  });

  it("narration: the agent's words from the session file attach to the call and the closing claim", async () => {
    const j = (o: unknown) => `${JSON.stringify(o)}\n`;
    await same("narration", async (r) => {
      const file = path.join(r.home, "t.jsonl");
      const asst = (...blocks: unknown[]) => j({ type: "assistant", uuid: `u-${blocks.length}`, isSidechain: false, requestId: "r1", message: { id: "m1", role: "assistant", content: blocks } });
      await mkdir(r.home, { recursive: true });
      await writeFile(file, asst({ type: "text", text: "I will raise A1." }, { type: "tool_use", id: "c1", name: "Bash", input: {} }));
      await r.ev("PreToolUse", "c1", "python3 edit.py", { transcript_path: file });
      await r.write({ A1: 10, A2: 2, A3: 3 });
      await r.ev("PostToolUse", "c1", "python3 edit.py", { transcript_path: file });
      await writeFile(file, asst({ type: "text", text: "I will raise A1." }, { type: "tool_use", id: "c1", name: "Bash", input: {} }) + asst({ type: "text", text: "Done: A1 is 10." }));
      await r.ev("Stop", undefined, "", { transcript_path: file, last_assistant_message: "Done: A1 is 10." });
    });
  });

  it("outside files: a workbook outside the folder a call names is baselined and credited", async () => {
    await same("outside", async (r) => {
      await r.ev("PreToolUse", "o1", `python3 edit.py ${path.join(r.outside, "ext.xlsx")}`);
      await r.writeOutside({ A1: 6 });
      await r.write({ A1: 10, A2: 2, A3: 3 });
      await r.ev("PostToolUse", "o1", `python3 edit.py ${path.join(r.outside, "ext.xlsx")}`);
      await r.ev("Stop");
    });
  });

  it("size cap: a small per-task store drops the oldest states the same way", async () => {
    await same(
      "size cap",
      async (r) => {
        for (let i = 1; i <= 4; i++) {
          await r.ev("PreToolUse", `c${i}`);
          await r.write({ A1: 10 * i, A2: 2, A3: 3 });
          await r.ev("PostToolUse", `c${i}`);
        }
        await r.ev("Stop");
      },
      { caps: { taskBytes: 1 } },
    );
  });
});
