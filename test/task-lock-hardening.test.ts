import { posixOnly } from "./helpers/platform.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireFileLock } from "../src/file-lock.ts";
import { pruneCopies, withTaskLocks } from "../src/copies.ts";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { plantValueRows } from "./helpers/planted-rows.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function copyFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name !== "folder.json") out.push(full);
    }
  };
  await walk(dir);
  return out;
}

describe("(a) the lock dir and files are owner-only when created", () => {
  it("withTaskLocks creates locks/ as 0700 and the lock file as 0600 while held", posixOnly("owner-only mode bits (0600/0700)"), async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    let dirMode = 0;
    let fileMode = 0;
    await withTaskLocks(home, [7], async () => {
      dirMode = (await stat(path.join(home, "locks"))).mode & 0o777;
      fileMode = (await stat(path.join(home, "locks", "task-7.lock"))).mode & 0o777;
    });
    assert.equal(dirMode.toString(8), "700");
    assert.equal(fileMode.toString(8), "600");
    await rm(home, { recursive: true, force: true });
  });

  it("the Excel lock keeps its default modes (not changed)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    const release = await acquireFileLock(path.join(dir, "sub", "excel.lock"));
    assert.equal(existsSync(path.join(dir, "sub", "excel.lock")), true);
    await release();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("(b) a live holder keeps the lock", () => {
  it("a holder working past staleMs is not taken over; a dead holder's lock still is", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    const lock = path.join(dir, "task-1.lock");
    const release = await acquireFileLock(lock, { staleMs: 150, heartbeatMs: 20 });
    // Holder works for 4x staleMs while a waiter polls.
    const waiter = acquireFileLock(lock, { staleMs: 150, pollMs: 10, timeoutMs: 600 });
    await assert.rejects(waiter, /EXCEL_LOCK_TIMEOUT/);
    assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, process.pid);
    await release();
    assert.equal(existsSync(lock), false);

    // A dead holder: a pid that does not exist, a fresh ts. Taken over at once.
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, ts: Date.now(), nonce: "dead" }));
    const started = Date.now();
    const r2 = await acquireFileLock(lock, { staleMs: 120_000, pollMs: 10, timeoutMs: 5_000, heartbeatMs: 20 });
    assert.ok(Date.now() - started < 1_000);
    await r2();
    await rm(dir, { recursive: true, force: true });
  });

  it("withTaskLocks heartbeats: a job longer than the stale threshold keeps the lock", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    const lock = path.join(home, "locks", "task-3.lock");
    const job = withTaskLocks(home, [3], async () => sleep(500), { staleMs: 150, heartbeatMs: 20 });
    await sleep(30);
    await assert.rejects(acquireFileLock(lock, { staleMs: 150, pollMs: 10, timeoutMs: 350 }), /EXCEL_LOCK_TIMEOUT/);
    await job;
    await rm(home, { recursive: true, force: true });
  });
});

describe("a heartbeat never outlives its release", () => {
  // The heartbeat timer is unref'd by design, so while a test waits on it alone the loop has nothing left to run and
  // Node 22's runner cancels the test ("event loop has already resolved"). A ref'd interval holds the loop open.
  let keepAlive: NodeJS.Timeout;
  before(() => { keepAlive = setInterval(() => {}, 1000); });
  after(() => clearInterval(keepAlive));

  /** A seam that parks the first heartbeat between its write and its rename until `open()` is called. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    let entered!: () => void;
    const inRefresh = new Promise<void>((r) => (entered = r));
    let first = true;
    const seam = async () => {
      if (!first) return;
      first = false;
      entered();
      await opened;
    };
    return { seam, open, inRefresh };
  }

  it("a release in the middle of a heartbeat leaves no lock and no tmp file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    const lock = path.join(dir, "task-1.lock");
    const g = gate();
    const release = await acquireFileLock(lock, { staleMs: 150, heartbeatMs: 5, beforeHeartbeatRename: g.seam });
    await g.inRefresh;
    const releasing = release();
    await sleep(30);
    g.open();
    await releasing;
    await sleep(60);
    assert.equal(existsSync(lock), false, "the lock stays released");
    assert.deepEqual((await readdir(dir)).filter((n) => n.includes(".beat-")), []);
    await rm(dir, { recursive: true, force: true });
  });

  it("a second holder's lock is never overwritten by the first holder's late heartbeat", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    const lock = path.join(dir, "task-1.lock");
    const g = gate();
    const release = await acquireFileLock(lock, { staleMs: 150, heartbeatMs: 5, beforeHeartbeatRename: g.seam });
    await g.inRefresh;
    const releasing = release();
    let secondNonce = "";
    const second = acquireFileLock(lock, { pollMs: 5, timeoutMs: 2_000 }).then(async (r) => {
      secondNonce = JSON.parse(await readFile(lock, "utf8")).nonce;
      return r;
    });
    await sleep(30);
    g.open();
    const releaseSecond = await second;
    await releasing;
    await sleep(60);
    assert.equal(JSON.parse(await readFile(lock, "utf8")).nonce, secondNonce);
    await releaseSecond();
    assert.equal(existsSync(lock), false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("(c) sweep decides the prune policy inside the task lock", () => {
  it("a reopen that lands while sweep waits for the lock is not pruned as closed", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-f-")));
    const ledger = openLedger(home);
    const tasks = new TaskStore(ledger, home, [createFilesLayer()], () => Date.now());
    const file = path.join(folder, "a.txt");
    await writeFile(file, "one\n");
    const id = await tasks.touch("c", file);
    ledger.recordOp({ taskId: id, tool: "cocheck_write", args: { path: file }, intent: "edit", clientName: "c", durationMs: 1, resultCode: "OK" });
    await writeFile(file, "two\n");
    // The round writes no value row for a text file, so the row the reviewer approves and then sends back is planted.
    plantValueRows(ledger, id, [{ file, before: "one", after: "two" }]);
    await tasks.submit("c", "first", true).catch(() => undefined);
    for (const r of ledger.reviewRowsForTask(id)) ledger.recordDecision({ rowId: r.id, decision: "approve", note: "", reviewer: "Dana" });
    await tasks.submit("c", "second", true).catch(() => undefined);
    await signOffForTest(ledger, id, "Dana");
    assert.deepEqual(await copyFiles(path.join(home, "tasks", String(id))), []);

    const held = await acquireFileLock(path.join(home, "locks", `task-${id}.lock`));
    const sweeping = tasks.sweep();
    await sleep(100);
    // The reviewer sends a row back while sweep waits: the task is live again and its baseline is re-copied.
    ledger.recordDecision({ rowId: ledger.reviewRowsForTask(id)[0]!.id, decision: "reject", note: "no", reviewer: "Dana" });
    await tasks.touch("c", file);
    const copied = await copyFiles(path.join(home, "tasks", String(id)));
    assert.ok(copied.length > 0, "the reopen re-copied the baseline");
    await held();
    await sweeping;
    assert.deepEqual(await copyFiles(path.join(home, "tasks", String(id))), copied, "sweep kept the live task's copies");
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
});

describe("(d) pruneCopies refuses to run outside the task lock", () => {
  it("throws without the lock, runs with it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    const ledger = openLedger(home);
    await assert.rejects(pruneCopies(ledger, 1, "open"), /task lock/);
    await withTaskLocks(home, [1], () => pruneCopies(ledger, 1, "open"));
    await assert.rejects(withTaskLocks(home, [2], () => pruneCopies(ledger, 1, "open")), /task lock/);
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
});

void mkdir;
