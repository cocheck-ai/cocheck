import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";
import { plantValueRows } from "./helpers/planted-rows.ts";

const DAY = 24 * 60 * 60 * 1000;
const SENTINELS = ["SENT_FLAG", "SENT_MOVED", "SENT_NOTICE", "SENT_BEFORE", "SENT_AFTER", "SENT_INTENT", "SENT_ARGS", "SENT_SUBMIT", "SENT_NOTE", "SENT_REQ", "SENT_ANSWER", "SENT_CONFIRM", "SENT_FINAL"];

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-r2b-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-r2b-folder-")));
  const ledger = openLedger(home);
  let skew = 0;
  const tasks = new TaskStore(ledger, home, [createFilesLayer()], () => Date.now() + skew);
  const file = (n: string) => path.join(folder, n);
  return {
    home, ledger, tasks, file,
    advance: (ms: number) => (skew = ms),
    cleanup: async () => {
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    },
  };
}

type T = Awaited<ReturnType<typeof setup>>;

/** A signed-off task whose every free-text field carries a sentinel. */
async function sentinelTask(t: T) {
  await writeFile(t.file("a.txt"), "SENT_BEFORE\n");
  const id = await t.tasks.touch("c", t.file("a.txt"));
  t.ledger.recordOp({ taskId: id, tool: "cocheck_write", args: { path: t.file("a.txt"), note: "SENT_ARGS" }, intent: "SENT_INTENT", clientName: "c", durationMs: 1, resultCode: "OK" });
  await writeFile(t.file("a.txt"), "SENT_AFTER\n");
  await t.tasks.submit("c", "SENT_SUBMIT", false);
  // The round writes no value row for a text file, so the row that carries SENT_BEFORE and SENT_AFTER is planted.
  plantValueRows(t.ledger, id, [{ file: t.file("a.txt"), before: "SENT_BEFORE", after: "SENT_AFTER" }]);
  for (const r of t.ledger.reviewRowsForTask(id)) t.ledger.recordDecision({ rowId: r.id, decision: "approve", note: "SENT_NOTE", reviewer: "Dana" });
  const req = t.ledger.recordRequest({ taskId: id, note: "SENT_REQ", reviewer: "Dana" });
  const res = t.ledger.recordRequestResolution({ requestId: req, resolution: "accepted", intent: "SENT_ANSWER", clientName: "c", opIds: [] });
  t.ledger.recordRequestConfirmation({ requestId: req, resolutionId: res, verdict: "confirm", note: "SENT_CONFIRM", reviewer: "Dana" });
  await t.tasks.submit("c", "SENT_FINAL", true);
  await signOffForTest(t.ledger, id, "Dana");
  return id;
}

/** One table's rows as text, so a test can name the table a sentinel must live in. */
function tableText(home: string, table: string): string {
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
  const out = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
  db.close();
  return out;
}

function dump(home: string, taskId: number): string {
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
  void taskId;
  const out = names.map((n) => JSON.stringify(db.prepare(`SELECT * FROM ${n}`).all())).join("\n");
  db.close();
  return out;
}

describe("value expiry covers every place a value lives", () => {
  it("no sentinel survives in any table or on the page", async () => {
    const t = await setup();
    const id = await sentinelTask(t);
    // Nothing writes round_results now, so plant a row the way an older round cut stored it; expiry must still blank it.
    assert.ok(!tableText(t.home, "round_results").includes("round_id"), "the round cut stores no round result");
    const raw = new DatabaseSync(path.join(t.home, "ledger.sqlite"));
    const roundId = t.ledger.roundsForTask(id)[0]!.id;
    raw.prepare("INSERT INTO round_results (round_id, task_id, result_json, ts) VALUES (?, ?, ?, ?)").run(roundId, id, JSON.stringify({ flags: [[1, [{ message: "SENT_FLAG" }]]], moved: [{ label: "SENT_MOVED" }], notices: ["SENT_NOTICE"] }), new Date().toISOString());
    raw.close();
    assert.ok(tableText(t.home, "round_results").includes("SENT_FLAG"), "round_results carries a value");
    assert.ok(tableText(t.home, "ops").includes("SENT_ARGS"), "ops.args_json carried a value");
    assert.ok(tableText(t.home, "review_rows").includes("SENT_AFTER"), "review_rows carried a value");
    const before = dump(t.home, id);
    for (const s of SENTINELS) assert.ok(before.includes(s), `${s} was never written, so its absence proves nothing`);
    t.advance(31 * DAY);
    await t.tasks.sweep();
    const all = dump(t.home, id);
    for (const s of SENTINELS) assert.ok(!all.includes(s), `${s} survived in the ledger`);
    const planted = JSON.parse(tableText(t.home, "round_results")) as Array<{ round_id: number; result_json: string }>;
    assert.deepEqual(planted.map((r) => [r.round_id, r.result_json]), [[t.ledger.roundsForTask(id)[0]!.id, '{"flags":[],"moved":[],"notices":[]}']], "the old row stays, blanked");
    const html = renderReviewPage(reviewModel(t.ledger, id));
    for (const s of SENTINELS) assert.ok(!html.includes(s), `${s} on the page`);
    assert.equal(t.ledger.reviewRowsForTask(id)[0]!.location.length > 0, true);
    assert.equal(t.ledger.signoffsForTask(id).length, 1);
    await t.cleanup();
  });
});

describe("triggers only allow blanking", () => {
  it("rewriting a value to new content on an expired task is rejected", async () => {
    const t = await setup();
    const id = await sentinelTask(t);
    t.advance(31 * DAY);
    await t.tasks.sweep();
    const db = new DatabaseSync(path.join(t.home, "ledger.sqlite"));
    assert.throws(() => db.prepare("UPDATE review_rows SET after_json = '\"forged\"' WHERE task_id = ?").run(id), /append-only/);
    assert.throws(() => db.prepare("UPDATE ops SET args_json = '{\"x\":1}' WHERE task_id = ?").run(id), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM values_expired WHERE task_id = ?").run(id), /append-only/);
    assert.throws(() => db.prepare("UPDATE values_expired SET ts = 'x' WHERE task_id = ?").run(id), /append-only/);
    db.close();
    await t.cleanup();
  });

  it("values_expired takes a task only once it closed over 30 days ago", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "x\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    assert.throws(() => t.ledger.expireValues(id, new Date()), /30 days|append-only/);
    const db = new DatabaseSync(path.join(t.home, "ledger.sqlite"));
    assert.throws(() => db.prepare("INSERT INTO values_expired (task_id, ts) VALUES (?, ?)").run(id, new Date().toISOString()), /30 days|append-only/);
    db.close();
    await t.cleanup();
  });

  it("an unexpired task's values cannot be blanked", async () => {
    const t = await setup();
    const id = await sentinelTask(t);
    const db = new DatabaseSync(path.join(t.home, "ledger.sqlite"));
    assert.throws(() => db.prepare("UPDATE review_rows SET after_json = 'null' WHERE task_id = ?").run(id), /append-only/);
    db.close();
    await t.cleanup();
  });
});

describe("one definition of activity", () => {
  it("a final-submitted task nobody touches for 7 days expires", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    await t.tasks.submit("c", "done", true);
    t.advance(8 * DAY);
    await t.tasks.sweep();
    assert.equal(t.ledger.closureForTask(id)?.kind, "expired");
    await t.cleanup();
  });

  it("a task with only a reviewer page open 3 days ago stays open", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    await t.tasks.submit("c", "done", false);
    t.ledger.recordActivity(id, "reviewer", new Date(Date.now() + 5 * DAY));
    t.advance(8 * DAY);
    await t.tasks.sweep();
    assert.equal(t.ledger.closureForTask(id), undefined);
    await t.cleanup();
  });

  it("a task with only an agent read 3 days ago stays open", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    t.advance(3 * 60 * 60 * 1000);
    assert.equal(await t.tasks.touch("c", t.file("a.txt")), id);
    t.advance(7 * DAY + 60 * 60 * 1000);
    await t.tasks.sweep();
    assert.equal(t.ledger.closureForTask(id), undefined);
    await t.cleanup();
  });

  it("the 4-hour rollover reads the same activity record as expiry", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    const until = new Date(Date.now() + DAY).toISOString();
    assert.equal(t.ledger.lastActivityTs(id, until), t.ledger.lastActivity(id, { until, agentOnly: true }));
    await t.cleanup();
  });
});

describe("sweep timing", () => {
  it("sweeps on a one-hour unref'd timer, and a tick expires an idle task", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    let tick: (() => void) | undefined;
    let ms = 0;
    let unref = 0;
    const stop = t.tasks.startSweeps((fn, every) => {
      tick = fn;
      ms = every;
      return { unref: () => { unref++; }, [Symbol.dispose]() {} } as unknown as NodeJS.Timeout;
    });
    assert.equal(ms, 60 * 60 * 1000);
    assert.equal(unref, 1);
    t.advance(8 * DAY);
    tick!();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.ledger.closureForTask(id)?.kind, "expired");
    stop();
    await t.cleanup();
  });
});

describe("a concurrent cut clearing empty round folders", () => {
  it("a copy whose round folder vanished between mkdir and write is taken again", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-r2c-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-r2c-folder-")));
    const ledger = openLedger(home);
    const real = createFilesLayer();
    let sabotaged = false;
    const layer = {
      ...real,
      snapshot: async (src: string, dest: string) => {
        if (!sabotaged) {
          // what a rival cut does: clears the empty round folder after this copy made it and before the write lands
          sabotaged = true;
          throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${src}' -> '${dest}'`), { code: "ENOENT" });
        }
        return real.snapshot(src, dest);
      },
    } as typeof real;
    const tasks = new TaskStore(ledger, home, [layer]);
    await writeFile(path.join(folder, "a.txt"), "one\n");
    const id = await tasks.touch("c", path.join(folder, "a.txt"));
    assert.ok(id > 0);
    assert.equal(sabotaged, true);
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
});
