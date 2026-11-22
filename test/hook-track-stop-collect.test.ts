import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleEvent, handleHook, hookClientName, markTrackingStopped, type HookPayload } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { readRows } from "../src/timeline/load.ts";
import { readRecord } from "../src/timeline/runs.ts";

// Once a session runs `cocheck track stop`, its task stops collecting: a change nobody's agent made after the stop is never shown in
// it. A session still tracking keeps the existing rule (every open task of the folder gets such a change).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Host = "claude" | "codex" | "copilot";

async function setup(host: Host) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-stop-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-stop-folder-")));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  await writeFile(path.join(folder, "old.txt"), "old\n");
  let clock = 1_000_000;
  const now = () => (clock += 1000);
  const opts = { host, home, folder, now };
  const COPILOT_EVENTS: Record<string, string> = { PreToolUse: "preToolUse", PostToolUse: "postToolUse", UserPromptSubmit: "userPromptSubmitted", Stop: "agentStop" };
  const ev = (session: string, hook_event_name: string, id?: string, command = "ls", extra: Record<string, unknown> = {}) =>
    host === "copilot"
      ? handleEvent(normalize("copilot", { sessionId: session, cwd: folder, timestamp: clock, ...(id ? { toolName: "bash", toolArgs: { command } } : {}), ...(hook_event_name === "PostToolUse" ? { toolResult: { resultType: "success", textResultForLlm: "" } } : {}), ...extra }, COPILOT_EVENTS[hook_event_name]), opts)
      : handleHook({ session_id: session, transcript_path: `/x/${session}.jsonl`, cwd: folder, hook_event_name, ...(id ? { tool_name: "Bash", tool_use_id: id, tool_input: { command, description: `run ${id}` } } : {}), ...extra } as HookPayload, opts);
  const call = async (session: string, id: string, command: string, write?: [string, string]) => {
    await ev(session, "PreToolUse", id, command);
    if (write) await writeFile(path.join(folder, write[0]), write[1]);
    await ev(session, "PostToolUse", id, command);
  };
  const turn = async (session: string, prompt: string, id: string, command: string, write?: [string, string]) => {
    await ev(session, "UserPromptSubmit", undefined, "ls", { prompt });
    await call(session, id, command, write);
  };
  // What the hook's tracking gate does on `cocheck track stop`: the mark in the session's task; the session's events stop arriving.
  const stop = (session: string) => markTrackingStopped(home, host, folder, session, now);
  const read = <T,>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  const taskOf = (session: string) => read((l) => l.allTaskIds().find((id) => l.taskClient(id) === hookClientName(host, folder, session)));
  const changesOf = (session: string) => {
    const id = taskOf(session);
    assert.ok(id !== undefined, `${session}'s task opened`);
    return read((l) => {
      const { ops, fileStates } = readRows(l, id);
      return readRecord(ops, fileStates).states.filter((s) => s.change).map((s) => ({ file: path.relative(folder, s.file_path), credited: s.credited }));
    });
  };
  const files = (session: string) => [...new Set(changesOf(session).map((c) => c.file))].sort();
  return { folder, ev, call, turn, stop, changesOf, files };
}

describe("a stopped session's task stops collecting changes", () => {
  for (const host of ["claude", "codex", "copilot"] as const) {
    it(`${host}: changes nobody's agent made after track stop never reach the stopped task; a session still tracking gets them`, async () => {
      const t = await setup(host);
      await t.turn("Z", "first task", "z1", "echo z > z.txt", ["z.txt", "z\n"]);
      await t.ev("Z", "Stop");
      t.stop("Z");
      // Nobody tracks the folder: a hand edit and a new file.
      await writeFile(path.join(t.folder, "old.txt"), "old, edited after the stop\n");
      await writeFile(path.join(t.folder, "loose.txt"), "made by hand\n");
      // Another session starts tracking and works; a hand edit lands while it tracks.
      await t.turn("A", "second task", "a1", "echo a > a.txt", ["a.txt", "a\n"]);
      await writeFile(path.join(t.folder, "late.txt"), "made by hand while A tracks\n");
      await t.call("A", "a2", "echo b > b.txt", ["b.txt", "b\n"]);
      await t.ev("A", "Stop");
      assert.deepEqual(t.files("Z"), ["z.txt"], `the stopped task holds only its own work: ${JSON.stringify(t.changesOf("Z"))}`);
      assert.deepEqual(t.files("A"), ["a.txt", "b.txt", "late.txt"], `the tracking session keeps the hand edit made while it tracked: ${JSON.stringify(t.changesOf("A"))}`);
    });
  }

  it("a session that did not stop still collects changes nobody made (the existing rule for open tasks)", async () => {
    const t = await setup("claude");
    await t.turn("Z", "first task", "z1", "echo z > z.txt", ["z.txt", "z\n"]);
    await t.ev("Z", "Stop");
    await t.turn("A", "second task", "a1", "echo a > a.txt", ["a.txt", "a\n"]);
    await writeFile(path.join(t.folder, "late.txt"), "made by hand while both track\n");
    await t.call("A", "a2", "echo b > b.txt", ["b.txt", "b\n"]);
    await t.ev("A", "Stop");
    assert.ok(t.files("Z").includes("late.txt"), `a session still tracking gets the change: ${JSON.stringify(t.changesOf("Z"))}`);
    assert.ok(t.files("A").includes("late.txt"));
  });

  it("a stopped session that starts again collects again", async () => {
    const t = await setup("claude");
    await t.turn("Z", "first task", "z1", "echo z > z.txt", ["z.txt", "z\n"]);
    await t.ev("Z", "Stop");
    t.stop("Z");
    await t.turn("Z", "again", "z2", "echo y > y.txt", ["y.txt", "y\n"]);
    await writeFile(path.join(t.folder, "late.txt"), "made by hand after the restart\n");
    await t.call("Z", "z3", "ls");
    await t.ev("Z", "Stop");
    assert.deepEqual(t.files("Z"), ["late.txt", "y.txt", "z.txt"], JSON.stringify(t.changesOf("Z")));
  });
});
