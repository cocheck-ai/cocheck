import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleEvent, handleHook, hookClientName, type HookPayload } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { readRows } from "../src/timeline/load.ts";
import { readRecord } from "../src/timeline/runs.ts";

// A session that starts tracking in a folder that already holds files: those files are its starting copy, never changes of its own,
// even when the folder was looked at before (another session, an earlier stretch of tracking) and changed while nobody tracked it.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Host = "claude" | "codex" | "copilot";

async function setup(host: Host) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-start-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-start-folder-")));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  await writeFile(path.join(folder, "old.txt"), "old\n");
  let clock = 1_000_000;
  const opts = { host, home, folder, now: () => (clock += 1000) };
  const COPILOT_EVENTS: Record<string, string> = { PreToolUse: "preToolUse", PostToolUse: "postToolUse", UserPromptSubmit: "userPromptSubmitted", Stop: "agentStop" };
  // Copilot's recorded shape: sessionId, toolName/toolArgs and no call id; Claude Code and Codex share the snake_case shape.
  const ev = (session: string, hook_event_name: string, id?: string, command = "ls", extra: Record<string, unknown> = {}) =>
    host === "copilot"
      ? handleEvent(normalize("copilot", { sessionId: session, cwd: folder, timestamp: clock, ...(id ? { toolName: "bash", toolArgs: { command } } : {}), ...(hook_event_name === "PostToolUse" ? { toolResult: { resultType: "success", textResultForLlm: "" } } : {}), ...extra }, COPILOT_EVENTS[hook_event_name]), opts)
      : handleHook({ session_id: session, transcript_path: `/x/${session}.jsonl`, cwd: folder, hook_event_name, ...(id ? { tool_name: "Bash", tool_use_id: id, tool_input: { command, description: `run ${id}` } } : {}), ...extra } as HookPayload, opts);
  const call = async (session: string, id: string, command: string, write?: [string, string]) => {
    await ev(session, "PreToolUse", id, command);
    if (write) await writeFile(path.join(folder, write[0]), write[1]);
    await ev(session, "PostToolUse", id, command);
  };
  const read = <T,>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  const taskOf = (session: string) => read((l) => l.allTaskIds().find((id) => l.taskClient(id) === hookClientName(host, folder, session)));
  /** The task's file states as the review page reads them: which are changes, and the starting copy's hash per file. */
  const statesOf = (taskId: number) =>
    read((l) => {
      const { ops, fileStates } = readRows(l, taskId);
      return readRecord(ops, fileStates).states.map((s) => ({ file: path.relative(folder, s.file_path), sha: s.sha256, prev: s.prev_sha256, change: s.change, credited: s.credited }));
    });
  const sha = async (rel: string) => createHash("sha256").update(await readFile(path.join(folder, rel))).digest("hex");
  /** An earlier tracked session's work in the folder, then files that arrive and change while nobody tracks it. */
  const earlierThenUntracked = async (closeEarlier: boolean) => {
    await ev("Z", "UserPromptSubmit", undefined, "ls", { prompt: "first task" });
    await call("Z", "z1", "echo z > z.txt", ["z.txt", "z\n"]);
    await ev("Z", "Stop");
    if (closeEarlier) {
      const z = taskOf("Z");
      assert.ok(z !== undefined, "the earlier session has a task");
      read((l) => l.recordExpiry(z, new Date(2_000_000)));
    }
    await mkdir(path.join(folder, "sub"));
    for (let i = 0; i < 3; i++) await writeFile(path.join(folder, "sub", `pre${i}.txt`), `pre ${i}\n`);
    await writeFile(path.join(folder, "old.txt"), "old, edited while untracked\n");
  };
  return { folder, ev, call, taskOf, statesOf, sha, earlierThenUntracked };
}

const PRESENT = ["old.txt", "sub/pre0.txt", "sub/pre1.txt", "sub/pre2.txt", "z.txt"];

async function assertStartsClean(t: Awaited<ReturnType<typeof setup>>, session: string, own: string[]) {
  const id = t.taskOf(session);
  assert.ok(id !== undefined, "the session's task opened");
  const states = t.statesOf(id);
  const changed = states.filter((s) => s.change).map((s) => s.file).sort();
  assert.deepEqual(changed, [...own].sort(), `only the session's own changes are changes: ${JSON.stringify(states)}`);
  for (const file of PRESENT) {
    const start = states.find((s) => s.file === file);
    assert.ok(start !== undefined && !start.change, `${file} is in the starting copy`);
    assert.equal(start.sha, await t.sha(file), `${file}'s starting copy is the file as it stood when tracking began`);
  }
}

describe("a session's starting copy is the folder as it stood when its tracking began", () => {
  for (const host of ["claude", "codex", "copilot"] as const) {
    it(`${host}: files present before tracking, in a folder tracked earlier, are not shown as created or modified`, async () => {
      const t = await setup(host);
      await t.earlierThenUntracked(true);
      await t.ev("A", "UserPromptSubmit", undefined, "ls", { prompt: "second task" });
      await t.call("A", "a1", "cat old.txt");
      await t.call("A", "a2", "echo n > new.txt", ["new.txt", "n\n"]);
      await t.ev("A", "Stop");
      await assertStartsClean(t, "A", ["new.txt"]);
    });
  }

  it("tracking started mid-turn (first event a call, no prompt): the same", async () => {
    const t = await setup("claude");
    await t.earlierThenUntracked(true);
    await t.call("A", "a1", "cat old.txt");
    await t.call("A", "a2", "echo n > new.txt", ["new.txt", "n\n"]);
    await t.ev("A", "Stop");
    await assertStartsClean(t, "A", ["new.txt"]);
  });

  it("with the earlier session's task still open, the new session's task still starts clean", async () => {
    const t = await setup("claude");
    await t.earlierThenUntracked(false);
    await t.ev("A", "UserPromptSubmit", undefined, "ls", { prompt: "second task" });
    await t.call("A", "a2", "echo n > new.txt", ["new.txt", "n\n"]);
    await t.ev("A", "Stop");
    await assertStartsClean(t, "A", ["new.txt"]);
  });

  for (const prompt of [true, false]) {
    it(`a change made outside the agents after tracking began is still a change (${prompt ? "task opened by the prompt" : "task not open yet"})`, async () => {
      const t = await setup("claude");
      await t.earlierThenUntracked(true);
      if (prompt) await t.ev("A", "UserPromptSubmit", undefined, "ls", { prompt: "second task" });
      await t.call("A", "a1", "cat old.txt");
      const before = await t.sha("sub/pre0.txt");
      await writeFile(path.join(t.folder, "late.txt"), "made by hand\n");
      await writeFile(path.join(t.folder, "sub", "pre0.txt"), "edited by hand\n");
      await t.call("A", "a2", "echo n > new.txt", ["new.txt", "n\n"]);
      await t.ev("A", "Stop");
      const states = t.statesOf(t.taskOf("A")!);
      const late = states.find((s) => s.file === "late.txt");
      assert.ok(late?.change === true && late.prev === null && late.credited.length === 0, `late.txt is a creation nobody's agent made: ${JSON.stringify(states)}`);
      const edit = states.find((s) => s.file === "sub/pre0.txt" && s.change);
      assert.ok(edit !== undefined && edit.prev === before && edit.credited.length === 0, `the hand edit is a change from the starting copy: ${JSON.stringify(states)}`);
      assert.ok(states.some((s) => s.file === "new.txt" && s.change && s.credited.includes("a2")), "the agent's own creation is credited");
    });
  }
});
