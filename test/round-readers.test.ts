import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSealed } from "../src/seal.ts";
import { openLedger, type Ledger, type RecordReviewRowInput } from "../src/ledger.ts";
import { pruneCopies, withTaskLocks } from "../src/copies.ts";
import { TaskStore, TASK_IDLE_ROLLOVER_MS } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { itemStates, openItemCount } from "../src/items.ts";
import { signoffStatus } from "../src/signoff.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { book, makeRig, sessionFor, type Rig } from "./hook-corpus.ts";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { DatabaseSync } from "node:sqlite";

// Every reader of review_rows, round_results and itemStates, pinned at today's behaviour. Each reader is driven from rows
// planted through the ledger (the way a pre-change round left them), never from the round diff, so these stay green once the round diff
// and its row producers go. The one end-to-end pin (the Stop) shows that a round the hook cuts prints nothing.

const CLIENT = "claude-desktop";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function row(filePath: string, status: RecordReviewRowInput["status"] = "unlogged", detail: Record<string, unknown> = {}): RecordReviewRowInput {
  return { filePath, layer: "files", location: "file", kind: "file changed", status, before: null, after: null, ops: [], description: "the file's bytes changed", detail };
}

async function home(): Promise<{ home: string; work: string; ledger: Ledger }> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-h2-home-"));
  const work = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-h2-work-")));
  const ledger = openLedger(home);
  cleanups.push(async () => ledger.close());
  return { home, work, ledger };
}

describe("reader: copies.ts pruneCopies, final policy (copies.ts:55)", () => {
  // Which copies survive a final prune: a file only the folder watch holds keeps its latest copy only when some round has a row on it.
  for (const withRow of [true, false]) {
    it(`a watch-only file ${withRow ? "with" : "without"} a review row: its latest copy is ${withRow ? "kept" : "deleted"}; a touched file's latest copy is kept`, async () => {
      const { home: h, work, ledger } = await home();
      const watched = path.join(work, "watched.txt");
      const touched = path.join(work, "touched.txt");
      const taskId = ledger.openTask(CLIENT);
      await mkdir(path.join(h, "tasks", String(taskId)), { recursive: true });
      await writeFile(path.join(h, "tasks", String(taskId), "folder.json"), JSON.stringify({ folderOnly: [watched] }));
      const snap = async (round: number, file: string, text: string) => {
        const dest = path.join(h, "tasks", String(taskId), `round-${round}`, path.basename(file));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeSealed(dest, text);
        return { taskId, round, filePath: file, layer: "files", snapshotPath: dest, mode: "copy", sha256: sha(text) };
      };
      ledger.recordSnapshot(await snap(0, watched, "w0"));
      ledger.recordSnapshot(await snap(0, touched, "t0"));
      const r1 = [await snap(1, watched, "w1"), await snap(1, touched, "t1")];
      ledger.recordRound({ taskId, seq: 1, intent: "done", clientName: CLIENT, final: true, lastOpId: 0, snapshots: r1, rows: withRow ? [row(watched)] : [] });
      await withTaskLocks(h, [taskId], () => pruneCopies(ledger, taskId, "final"));
      const kept = (file: string, round: number) => {
        const s = ledger.snapshotsForTask(taskId).find((x) => x.filePath === file && x.round === round)!;
        return !s.removed && existsSync(s.snapshotPath);
      };
      assert.equal(kept(touched, 1), true, "the touched file's latest copy survives");
      assert.equal(kept(watched, 1), withRow, "the watch-only file's latest copy survives only with a row");
      assert.equal(kept(touched, 0), false);
      assert.equal(kept(watched, 0), false);
    });
  }
});

describe("reader: tasks.ts #awaitsFix (tasks.ts:214), when a task rolls over", () => {
  // An unanswered rejection on a row holds the task open past the idle threshold; with no rejection the next touch opens a new task.
  for (const rejected of [true, false]) {
    it(`idle past the threshold ${rejected ? "with" : "without"} an unanswered rejection: the next touch ${rejected ? "stays on" : "rolls over from"} the task`, async () => {
      const { home: h, work, ledger } = await home();
      let clock = Date.parse("2026-11-01T10:00:00Z");
      const store = new TaskStore(ledger, h, [createFilesLayer()], () => clock);
      const a = path.join(work, "a.txt");
      const b = path.join(work, "b.txt");
      await writeFile(a, "a0");
      await writeFile(b, "b0");
      const taskId = await store.touch(CLIENT, a);
      ledger.recordRound({ taskId, seq: 1, intent: "first", clientName: CLIENT, final: false, lastOpId: ledger.maxOpId(), snapshots: [], rows: [row(a)] });
      if (rejected) ledger.recordDecision({ rowId: ledger.reviewRowsForTask(taskId)[0]!.id, decision: "reject", note: "no", reviewer: "Dana" });
      clock += TASK_IDLE_ROLLOVER_MS + 60_000;
      const next = await store.touch(CLIENT, b);
      if (rejected) assert.equal(next, taskId, "an unanswered rejection holds the task");
      else assert.notEqual(next, taskId, "an idle task with no rejection rolls over");
    });
  }
});

describe("reader: tasks.ts #isOpen final-round check (tasks.ts:333)", () => {
  // A task whose last round is final is closed, unless a row was rejected after it.
  for (const rejected of [true, false]) {
    it(`a final round ${rejected ? "then a rejection: the task is open again" : "alone: the task is closed"}`, async () => {
      const { home: h, work, ledger } = await home();
      const store = new TaskStore(ledger, h, [createFilesLayer()]);
      const a = path.join(work, "a.txt");
      const taskId = ledger.openTask(CLIENT);
      ledger.recordRound({ taskId, seq: 1, intent: "done", clientName: CLIENT, final: true, lastOpId: ledger.maxOpId(), snapshots: [], rows: [row(a)] });
      if (rejected) ledger.recordDecision({ rowId: ledger.reviewRowsForTask(taskId)[0]!.id, decision: "reject", note: "no", reviewer: "Dana" });
      assert.deepEqual(store.openTaskIds(CLIENT), rejected ? [taskId] : []);
    });
  }
});

describe("reader: items.ts itemStates, and through it signoff.ts (openItemCount, lowPriorityCount, elsewhereBlockers)", () => {
  it("an unlogged row is an open item; a low-priority row awaits a decision; another-session, explained and derived rows are not items", async () => {
    const { work, ledger } = await home();
    const f = path.join(work, "a.txt");
    const taskId = ledger.openTask(CLIENT);
    ledger.recordRound({
      taskId, seq: 1, intent: "x", clientName: CLIENT, final: false, lastOpId: 0, snapshots: [],
      rows: [row(f), row(f, "unlogged", { lowPriority: true }), row(f, "explained", { anotherSession: true }), row(f, "explained"), row(f, "derived")],
    });
    const states = itemStates(ledger, taskId);
    assert.deepEqual(states.map((s) => [s.openReason ?? null, s.lowPriority ?? false]), [["unlogged", false], [null, true], [null, false], [null, false], [null, false]]);
    assert.equal(openItemCount(ledger, taskId), 1);
    assert.deepEqual(signoffStatus(ledger, taskId).blockers, ["1 item still needs a decision.", "1 low-priority change needs a decision."]);
  });

  it("an open row on a shared file in another task of the folder blocks this task's sign-off", async () => {
    const { work, ledger } = await home();
    const f = path.join(work, "a.txt");
    const client = `claude-hook:${work}`;
    const mine = ledger.openTask(`${client}?session=s1`);
    const other = ledger.openTask(`${client}?session=s2`);
    ledger.recordRound({ taskId: mine, seq: 1, intent: "x", clientName: client, final: false, lastOpId: 0, snapshots: [{ taskId: mine, round: 1, filePath: f, layer: "files", snapshotPath: "", mode: "missing" }], rows: [] });
    ledger.recordRound({ taskId: other, seq: 1, intent: "x", clientName: client, final: false, lastOpId: 0, snapshots: [], rows: [row(f)] });
    assert.deepEqual(signoffStatus(ledger, mine).blockers, [
      `Task ${other} has 1 open item on ${f}; a file can't be signed off while it has an open question anywhere.`,
    ]);
  });
});

describe("reader: round_results (ledger.ts expireValues only)", () => {
  it("nothing in a round cut writes round_results", async () => {
    const { work, ledger, home: h } = await home();
    const taskId = ledger.openTask(CLIENT);
    ledger.recordRound({ taskId, seq: 1, intent: "x", clientName: CLIENT, final: false, lastOpId: 0, snapshots: [], rows: [row(path.join(work, "a.txt"))] });
    const db = new DatabaseSync(path.join(h, "ledger.sqlite"), { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM round_results").get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  });
});

describe("reader: the Stop hook's SubmitSummary (hook-adapter.ts submit, hook-cli.ts runHook)", () => {
  it("a Stop that cuts a round prints nothing: stdout is empty and stderr names no row", async () => {
    const r: Rig = await makeRig();
    cleanups.push(r.cleanup);
    setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
    cleanups.push(async () => setBuiltinConnectorsForTest(undefined));
    let clock = 1_700_000_000_000;
    let stop: { stdout: string; stderr: string } | undefined;
    for (const ev of sessionFor("claude", r.folder)) {
      if (ev.write) await writeFile(path.join(r.folder, "model.xlsx"), book(ev.write));
      const payload = Buffer.from(JSON.stringify(ev.payload));
      const res = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder], env: { COCHECK_HOME: r.home }, stdin: (async function* () { yield payload; })(), now: () => (clock += 1000) });
      assert.equal(res.exitCode, 0, res.stderr);
      if (ev.payload.hook_event_name === "Stop") stop = res;
    }
    const ledger = openLedger(r.home);
    try {
      const taskId = ledger.allTaskIds()[0]!;
      // The round does not diff, so the Stop's round records no row; the file states hold who made each change.
      assert.deepEqual(ledger.reviewRowsForTask(taskId), []);
      assert.equal(openItemCount(ledger, taskId), 0);
      assert.ok(ledger.fileStatesForTask(taskId).length > 0, "the changes are file states");
    } finally {
      ledger.close();
    }
    assert.equal(stop!.stdout, "", "the Stop prints no summary");
    assert.doesNotMatch(stop!.stderr, /file changed|bytes changed|unlogged|open item/i);
  });
});
