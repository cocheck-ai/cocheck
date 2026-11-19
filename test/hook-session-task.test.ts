import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { openLedger } from "../src/ledger.ts";
import { handleHook, hookClientName, parkedOpsOf, type HookPayload } from "../src/hook-adapter.ts";
import { buildBigWorkbook } from "./big-workbook.ts";
import { hookFolderOf } from "../src/tasks.ts";
import { itemStates } from "../src/items.ts";
import { signoffStatus } from "../src/signoff.ts";
import { hostOfClient } from "../src/timeline/attribution.ts";
import { loadRows, taskFolderOf } from "../src/timeline/load.ts";
import { workbookClaims } from "./helpers/claims.ts";

// one task per session. Two sessions in one folder make two tasks; a resumed session (same id) stays in its task; folder-only clients still work.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  await writeFile(path.join(folder, "book.xlsx"), buildBigWorkbook(10, 0));
  let clock = 1_000_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  let n = 0;
  /** One Bash call by `session` that writes `file` (a fresh synthetic text file). */
  const edit = async (session: string, file: string) => {
    const id = `toolu_${++n}`;
    const input = { command: `echo ${n} > ${file}`, description: `write ${file}` };
    const base = { session_id: session, transcript_path: `/x/${session}.jsonl`, cwd: folder, tool_name: "Bash", tool_use_id: id, tool_input: input };
    clock += 1000;
    await handleHook({ ...base, hook_event_name: "PreToolUse" } as HookPayload, opts);
    await writeFile(path.join(folder, "book.xlsx"), buildBigWorkbook(10, n));
    clock += 1000;
    await handleHook({ ...base, hook_event_name: "PostToolUse" } as HookPayload, opts);
  };
  const clients = () => {
    const ledger = openLedger(home);
    try {
      return ledger.allTaskIds().map((id) => ledger.taskClient(id) as string);
    } finally {
      ledger.close();
    }
  };
  return { home, folder, edit, clients, opts };
}

describe("one task per session", () => {
  it("two concurrent sessions in one folder make two tasks", async () => {
    const s = await setup();
    await s.edit("sess-A", "a.txt");
    await s.edit("sess-B", "b.txt");
    await s.edit("sess-A", "a2.txt");
    await s.edit("sess-B", "b2.txt");
    const clients = s.clients();
    assert.equal(clients.length, 2, JSON.stringify(clients));
    assert.deepEqual([...clients].sort(), [hookClientName("claude", s.folder, "sess-A"), hookClientName("claude", s.folder, "sess-B")].sort());
  });

  it("a resumed session (same id) stays in its task", async () => {
    const s = await setup();
    await s.edit("sess-A", "a.txt");
    await s.edit("sess-A", "a2.txt");
    assert.equal(s.clients().length, 1);
  });

  it("no session id falls back to the folder-only client", () => {
    assert.equal(hookClientName("claude", "/w", undefined), "claude-hook:/w");
    assert.equal(hookClientName("claude", "/w", ""), "claude-hook:/w");
    assert.equal(hookClientName("codex", "/w", "abc-1"), "codex-hook:/w?session=abc-1");
  });

  it("parsers read both the legacy and the session client", () => {
    for (const c of ["claude-hook:/w/proj", "claude-hook:/w/proj?session=abc-123", "claude-hook:/w/proj/?session=abc-123"]) {
      assert.equal(hookFolderOf(c), "/w/proj", c);
      assert.equal(hostOfClient(c), "claude", c);
    }
    assert.equal(hookFolderOf("some-client"), null);
  });

  it("taskFolderOf strips the session from the client for a legacy marker-less task", async () => {
    const s = await setup();
    const ledger = openLedger(s.home);
    try {
      const legacy = ledger.openTask(`claude-hook:${s.folder}`);
      const fresh = ledger.openTask(hookClientName("claude", s.folder, "sess-A"));
      assert.equal(taskFolderOf(ledger, s.home, legacy), s.folder);
      assert.equal(taskFolderOf(ledger, s.home, fresh), s.folder);
    } finally {
      ledger.close();
    }
  });

});

const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);

/** One folder with a probe workbook; `ev(session, event, id?, command?)` sends a hook event. */
async function folderSetup(over: Record<string, unknown> = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-t130b-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-t130b-folder-")));
  await copyFile(probe(0), path.join(folder, "deck.xlsx"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000), ...over };
  const ev = (session: string, hook_event_name: string, id?: string, command = "ls", extra: Record<string, unknown> = {}) =>
    handleHook({ session_id: session, transcript_path: `/x/${session}.jsonl`, cwd: folder, hook_event_name, ...(id ? { tool_name: "Bash", tool_use_id: id, tool_input: { command, description: `desc ${id}` } } : {}), ...extra } as HookPayload, opts);
  const write = (n: number) => copyFile(probe(n), path.join(folder, "deck.xlsx"));
  const read = <T,>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  const taskOf = (session: string): number | undefined => read((l) => l.allTaskIds().find((id) => l.taskClient(id) === hookClientName("claude", folder, session)));
  const ops = (taskId: number) => read((l) => l.okOpsForTask(taskId, 0, l.maxOpId()).map((o) => ({ ...o, args: JSON.parse(o.argsJson) as Record<string, any> })));
  // an op credited with a change names the file instead of listing cells.
  const cellsOf = (taskId: number) => ops(taskId).filter((o) => typeof o.args.path === "string");
  return { home, folder, ev, write, read, taskOf, ops, cellsOf };
}

describe("shared observation, per-session routing", () => {
  it("a supervisor session gets nothing from another session's writes; an overlap stays joint in both tasks", async () => {
    const t = await folderSetup();
    await t.ev("A", "PreToolUse", "a0");
    await t.ev("A", "PostToolUse", "a0");
    // Phase 1: A idle, B writes.
    await t.ev("B", "PreToolUse", "b1", "python edit.py");
    await t.write(1);
    await t.ev("B", "PostToolUse", "b1", "python edit.py");
    assert.equal(t.taskOf("A"), undefined, "A has no task: B's write is none of its calls");
    assert.ok(t.taskOf("B") !== undefined);
    assert.deepEqual(t.cellsOf(t.taskOf("B")!).map((o) => o.args.tool_use_id), ["b1"]);
    // Phase 2: A's long call is open while B writes.
    await t.ev("A", "PreToolUse", "a1", "sleep 60");
    await t.ev("B", "PreToolUse", "b2", "python edit.py");
    await t.write(2);
    await t.ev("B", "PostToolUse", "b2", "python edit.py");
    await t.ev("A", "PostToolUse", "a1", "sleep 60");
    const a = t.taskOf("A");
    assert.ok(a !== undefined, "the overlap credits A's open call, so its task opens");
    for (const task of [a!, t.taskOf("B")!]) {
      const joint = t.cellsOf(task).filter((o) => o.args.jointWith.length > 1);
      assert.ok(joint.length >= 1);
      for (const o of joint) assert.deepEqual(o.args.jointWith, ["a1", "b2"]);
      const other = t.ops(task).filter((o) => o.args.hookEvent === "OtherSessionCall").map((o) => o.args.tool_use_id);
      assert.deepEqual(other, task === a ? ["b2"] : ["a1"], "the other session's call is a stand-in, never its words");
    }
    // A's task holds none of B's earlier call.
    assert.ok(!t.ops(a!).some((o) => o.args.tool_use_id === "b1"));
    // The page's model reads both tasks.
    for (const task of [a!, t.taskOf("B")!]) t.read((l) => loadRows(l, task, "test", { transcriptsRoot: t.home } as never));
  });

  it("a session's task opens lazily: read-only calls make none; its first change opens one that starts with them", async () => {
    const t = await folderSetup();
    await t.ev("S", "UserPromptSubmit", undefined, "ls", { prompt: "look around" });
    await t.ev("S", "PreToolUse", "r1");
    await t.ev("S", "PostToolUse", "r1");
    await t.ev("S", "Stop");
    // a tracked session's first prompt opens its task (the request shows at once); only a session never tracked has none (test/hook-first-prompt).
    assert.equal(t.read((l) => l.allTaskIds().length), 1, "the first prompt opened the session's task");
    await t.ev("S", "PreToolUse", "w1", "python edit.py");
    await t.write(1);
    await t.ev("S", "PostToolUse", "w1", "python edit.py");
    const task = t.taskOf("S")!;
    const ids = t.ops(task).map((o) => o.args.tool_use_id).filter(Boolean);
    assert.deepEqual(ids, ["r1", "w1"], "the parked read call comes first");
    assert.ok(t.cellsOf(task).length > 0);
    // The baseline is the file before the change: the step's earlier state is stored in the task.
    const states = t.read((l) => l.fileStatesForTask(task));
    assert.ok(states.some((s) => s.prevSha256 !== null && s.filePath.endsWith("deck.xlsx")));
    // The task's own baseline snapshot of the file is the state before the change, though the file had changed when the task opened.
    const snap = t.read((l) => l.snapshotsForTask(task)).find((x) => x.filePath.endsWith("deck.xlsx"));
    assert.ok(snap !== undefined && snap.mode !== "missing");
    const first = states.find((s) => s.prevSha256 !== null)!;
    assert.ok(existsSync(path.join(t.home, "tasks", String(task), "states", first.prevSha256!)), "the earlier state is stored in the task");
  });

  it("a change nobody's agent made (the user in Excel) goes to every session with an open task, and to none without one", async () => {
    const t = await folderSetup();
    // S and U each have a task (each wrote); C only chats.
    await t.ev("S", "PreToolUse", "s1", "python edit.py");
    await t.write(1);
    await t.ev("S", "PostToolUse", "s1", "python edit.py");
    await t.ev("U", "PreToolUse", "u1", "python edit.py");
    await t.write(2);
    await t.ev("U", "PostToolUse", "u1", "python edit.py");
    await t.ev("C", "PreToolUse", "c1");
    await t.ev("C", "PostToolUse", "c1");
    // The user saves the workbook; no call is open anywhere. The next hook event finds it.
    await t.write(3);
    await t.ev("C", "PreToolUse", "c2");
    await t.ev("C", "PostToolUse", "c2");
    const unowned = (task: number) => t.read((l) => l.fileStatesForTask(task)).filter((s) => s.credited.length === 0 && s.prevSha256 !== null && /not from an agent call/.test(s.note));
    assert.ok(unowned(t.taskOf("S")!).length >= 1, "S's task records the user's edit");
    assert.ok(unowned(t.taskOf("U")!).length >= 1, "U's task records it too");
    assert.equal(t.taskOf("C"), undefined, "a chat-only session gets no task");
  });

  it("a change nobody made before any task exists is held, and the first task begins with it as an unowned change (as the one task of a folder did on main)", async () => {
    const t = await folderSetup();
    await t.ev("A", "PreToolUse", "a0");
    await t.ev("A", "PostToolUse", "a0");
    await t.write(1); // the user edits while no session has a task
    await t.ev("A", "PreToolUse", "a1");
    await t.ev("A", "PostToolUse", "a1");
    assert.equal(t.read((l) => l.allTaskIds().length), 0);
    await t.ev("B", "PreToolUse", "b1", "python edit.py");
    await t.write(2);
    await t.ev("B", "PostToolUse", "b1", "python edit.py");
    const task = t.taskOf("B")!;
    const states = t.read((l) => l.fileStatesForTask(task)).filter((x) => x.filePath.endsWith("deck.xlsx"));
    // starting copy, then the unowned change (credited to no call), then B's own.
    assert.deepEqual(states.map((x) => [x.prevSha256 === null, x.credited.length]), [[true, 0], [false, 0], [false, 1]]);
    assert.equal(states[1]!.sha256, states[2]!.prevSha256, "the states link");
  });

  it("sibling edits: each session's own call is credited with its own change, and A's task never blocks B's sign-off", async () => {
    const t = await folderSetup();
    await t.ev("A", "PreToolUse", "a1", "python edit.py");
    await t.write(1);
    await t.ev("A", "PostToolUse", "a1", "python edit.py");
    await t.ev("B", "PreToolUse", "b1", "python edit.py");
    await t.write(2);
    await t.ev("B", "PostToolUse", "b1", "python edit.py");
    await t.ev("A", "Stop");
    await t.ev("B", "Stop");
    const a = t.taskOf("A")!;
    const b = t.taskOf("B")!;
    // the round writes no review rows; who made each change is the file states' credit. A's own call is credited in A's task.
    const creditsIn = (task: number) => t.read((l) => l.fileStatesForTask(task)).filter((x) => x.filePath.endsWith("deck.xlsx") && x.prevSha256 !== null).map((x) => [...x.credited]);
    assert.deepEqual(creditsIn(a), [["a1"]], "A's own call is credited in A's task, and B's change is not credited to A's call");
    assert.deepEqual(creditsIn(b), [["b1"]], "B's own call is credited in B's task");
    assert.equal(t.read((l) => itemStates(l, a)).length, 0, "no item in A's task");
    const blockers = t.read((l) => signoffStatus(l, b).blockers);
    assert.ok(!blockers.some((x) => x.includes(`Task ${a} `)), `A's rows do not block B: ${blockers.join(" | ")}`);
  });

  it("caps leave a note: parked ops, parked sessions, the held starting copy and unowned changes", async () => {
    const notesOf = (t: Awaited<ReturnType<typeof folderSetup>>, session: string) => t.ops(t.taskOf(session)!).filter((o) => o.args.hookEvent === "Dropped").flatMap((o) => o.args.notes as string[]);
    const fileNote = (t: Awaited<ReturnType<typeof folderSetup>>, session: string) => t.read((l) => l.fileStatesForTask(t.taskOf(session)!)).map((x) => x.note).join(" | ");
    // parked ops of one session
    const a = await folderSetup({ caps: { parkedOps: 2 } });
    for (const id of ["r1", "r2", "r3", "r4"]) {
      await a.ev("S", "PreToolUse", id, "ls");
      await a.ev("S", "PostToolUse", id, "ls");
    }
    await a.ev("S", "PreToolUse", "w1", "python edit.py");
    await a.write(1);
    await a.ev("S", "PostToolUse", "w1", "python edit.py");
    assert.ok(notesOf(a, "S").some((n) => /earlier calls and prompts of this session were dropped/.test(n)), notesOf(a, "S").join("|"));
    assert.match(fileNote(a, "S"), /held record dropped/);
    // parked sessions
    const b = await folderSetup({ caps: { parkedSessions: 1 } });
    for (const s of ["p1", "p2", "p3"]) {
      await b.ev(s, "PreToolUse", `${s}c`, "ls");
      await b.ev(s, "PostToolUse", `${s}c`, "ls");
    }
    await b.ev("W", "PreToolUse", "w1", "python edit.py");
    await b.write(1);
    await b.ev("W", "PostToolUse", "w1", "python edit.py");
    assert.ok(notesOf(b, "W").some((n) => /parked calls were dropped/.test(n)), notesOf(b, "W").join("|"));
    // the held starting copy and unowned changes
    const c = await folderSetup({ caps: { pendingFiles: 0 } });
    await c.ev("A", "PreToolUse", "a0", "ls");
    await c.ev("A", "PostToolUse", "a0", "ls");
    await c.write(1);
    await c.ev("A", "PreToolUse", "a1", "ls");
    await c.ev("A", "PostToolUse", "a1", "ls");
    await c.ev("B", "PreToolUse", "b1", "python edit.py");
    await c.write(2);
    await c.ev("B", "PostToolUse", "b1", "python edit.py");
    const notes = notesOf(c, "B");
    assert.ok(notes.some((n) => /starting copy of \d+ files was too large/.test(n)), notes.join("|"));
    assert.ok(notes.some((n) => /changes nobody's agent made/.test(n)), notes.join("|"));
  });

  it("coverage: a session that has no task yet still has its parked calls counted as recorded", async () => {
    const t = await folderSetup();
    await t.ev("S", "PreToolUse", "r1", "ls");
    await t.ev("S", "PostToolUse", "r1", "ls");
    assert.equal(t.read((l) => l.allTaskIds().length), 0);
    assert.deepEqual(parkedOpsOf(t.home, "claude", t.folder, "S"), [{ toolUseId: "r1", closedBy: "post" }]);
    assert.deepEqual(parkedOpsOf(t.home, "claude", t.folder, "other"), []);
  });

  it("a Codex helper arrives with the parent's session id and its own agent id: it stays in the parent's task", async () => {
    // Probe (test/narration-helper-codex.test.ts, recorded): a helper's payload carries the parent's session_id plus its agent_id.
    const t = await folderSetup({ host: "codex" });
    const send = (event: string, id: string, extra: Record<string, unknown>) => handleHook({ session_id: "11111111-1111-4111-8111-111111111111", cwd: t.folder, hook_event_name: event, tool_name: "Bash", tool_use_id: id, tool_input: { command: "python edit.py" }, ...extra } as HookPayload, { host: "codex", home: t.home, claimed: workbookClaims, folder: t.folder });
    await send("PreToolUse", "p1", {});
    await t.write(1);
    await send("PostToolUse", "p1", {});
    await send("PreToolUse", "h1", { agent_id: "22222222-2222-4222-8222-222222222222" });
    await t.write(2);
    await send("PostToolUse", "h1", { agent_id: "22222222-2222-4222-8222-222222222222" });
    assert.equal(t.read((l) => l.allTaskIds().length), 1, "parent and helper share one task");
  });
});

describe("session id in the client name", () => {
  it("an oversized or odd session id gives a bounded, path-free name", () => {
    const huge = hookClientName("claude", "/w", "s".repeat(70_000));
    assert.ok(huge.length < 200);
    assert.equal(hookFolderOf(huge), "/w");
    assert.equal(hookClientName("claude", "/w", "a/b c"), "claude-hook:/w?session=a_b_c");
  });
});
