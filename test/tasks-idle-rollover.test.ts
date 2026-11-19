import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { TASK_IDLE_ROLLOVER_MS, TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { startReviewServer } from "../src/review-server.ts";

const MIN = 60 * 1000;
const TOKEN = "t".repeat(48);

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-idle-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-idle-folder-")));
  const ledger = openLedger(home);
  let skew = 0;
  const tasks = new TaskStore(ledger, home, [createFilesLayer()], () => Date.now() + skew);
  const file = (name: string) => path.join(folder, name);
  await writeFile(file("a.env"), "one\n");
  // Task 1 with one logged op and one cut round holding a row.
  const first = await tasks.touch("c", file("a.env"));
  ledger.recordOp({ taskId: first, tool: "cocheck_write", args: { path: file("a.env") }, intent: "edit", clientName: "c", durationMs: 1, resultCode: "OK" });
  await writeFile(file("a.env"), "two\n");
  await tasks.submit("c", "first pass", false);
  const cleanup = async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  };
  return { tasks, ledger, home, file, first, cleanup, advance: (ms: number) => (skew = ms) };
}

describe("idle rollover", () => {
  it("the threshold is four hours", () => {
    assert.equal(TASK_IDLE_ROLLOVER_MS, 4 * 60 * MIN);
  });

  it("a touch 3 h 59 min after the last activity joins the same task", async () => {
    const { tasks, file, first, advance, cleanup } = await setup();
    await writeFile(file("c.txt"), "new\n");
    advance(TASK_IDLE_ROLLOVER_MS - MIN);
    assert.equal(await tasks.touch("c", file("c.txt")), first);
    await cleanup();
  });

  it("a touch past 4 h opens a new task and leaves the old task's rows unchanged", async () => {
    const { tasks, ledger, file, first, advance, cleanup } = await setup();
    const before = ledger.reviewRowsForTask(first);
    assert.equal(before.length, 1);
    await writeFile(file("a.env"), "three\n"); // outside change while idle
    await writeFile(file("d.txt"), "fresh\n");
    advance(TASK_IDLE_ROLLOVER_MS + MIN);
    const second = await tasks.touch("c", file("d.txt"));
    assert.notEqual(second, first);
    assert.deepEqual(ledger.reviewRowsForTask(first).filter((r) => r.roundSeq === 1), before);
    // The idle changes are not lost: the old task's closing round carries them, as unlogged rows.
    const closing = ledger.reviewRowsForTask(first).filter((r) => r.roundSeq === 2);
    // A newcomer (d.txt, not a secret name) gets no row of its own; the secret file's fingerprint row (a.env) stays.
    assert.deepEqual(closing.map((r) => [path.basename(r.filePath), r.status]), [["a.env", "unlogged"]]);
    // The new task's baseline was taken at touch, so the idle edit is nothing of its.
    const summary = await tasks.submit("c", "second pass", false);
    assert.equal(summary.taskId, second);
    assert.equal(summary.rows.length, 0);
    assert.deepEqual(tasks.openTaskIds("c"), [second]);
    await cleanup();
  });

  it("outside changes alone do not keep a task alive", async () => {
    const { tasks, file, first, advance, cleanup } = await setup();
    await writeFile(file("a.env"), "edited by hand\n");
    advance(TASK_IDLE_ROLLOVER_MS + MIN);
    await writeFile(file("a.env"), "edited again\n");
    assert.notEqual(await tasks.touch("c", file("a.env")), first);
    await cleanup();
  });

  it("the review index lists both tasks", async () => {
    const { tasks, ledger, home, file, first, advance, cleanup } = await setup();
    await writeFile(file("d.txt"), "fresh\n");
    advance(TASK_IDLE_ROLLOVER_MS + MIN);
    const second = await tasks.touch("c", file("d.txt"));
    await writeFile(file("d.txt"), "changed\n");
    await tasks.submit("c", "second pass", false);
    const review = await startReviewServer(ledger, TOKEN, home);
    try {
      const res = await fetch(`http://127.0.0.1:${review.port}/?t=${TOKEN}`);
      const html = await res.text();
      assert.match(html, new RegExp(`href="/timeline/${first}/review\\?t=${TOKEN}"`));
      assert.match(html, new RegExp(`href="/timeline/${second}/review\\?t=${TOKEN}"`));
    } finally {
      review.server.close();
      review.server.closeAllConnections();
    }
    await cleanup();
  });
});
