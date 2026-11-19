import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { homePage } from "../src/review-server.ts";
import { closureOf, signoffStatus } from "../src/signoff.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";
import { plantValueRows } from "./helpers/planted-rows.ts";

const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const ledger = openLedger(home);
  let skew = 0;
  const tasks = new TaskStore(ledger, home, [createFilesLayer()], () => Date.now() + skew);
  const file = path.join(folder, "a.txt");
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

/** The round writes no value row for a text file, so the two rows the sequence reviews are planted (a changed "TWO" and "THREE"). */
function plantRows(t: T, id: number): void {
  plantValueRows(t.ledger, id, [
    { file: t.file, before: "two", after: "TWO", location: "line 2" },
    { file: t.file, before: "three", after: "THREE", location: "line 3" },
  ]);
}

/** The reviewer's sequence up to a sign-off that stands. */
async function signedOnly(t: T): Promise<number> {
  await writeFile(t.file, "one\ntwo\nthree\n");
  const id = await t.tasks.touch("c", t.file);
  await writeFile(t.file, "one\nTWO\nTHREE\n");
  await t.tasks.submit("c", "edit", false);
  plantRows(t, id);
  for (const r of t.ledger.reviewRowsForTask(id)) t.ledger.recordDecision({ rowId: r.id, decision: "approve", note: "", reviewer: "Dana" });
  await t.tasks.submit("c", "final", true);
  await signOffForTest(t.ledger, id, "Dana");
  return id;
}

/** The reviewer's sequence up to and including the reject that reopens the task. */
async function signedThenRejected(t: T, _start?: number): Promise<number> {
  await writeFile(t.file, "one\ntwo\nthree\n");
  const id = await t.tasks.touch("c", t.file);
  await writeFile(t.file, "one\nTWO\nTHREE\n");
  await t.tasks.submit("c", "edit", false);
  plantRows(t, id);
  for (const r of t.ledger.reviewRowsForTask(id)) t.ledger.recordDecision({ rowId: r.id, decision: "approve", note: "", reviewer: "Dana" });
  await t.tasks.submit("c", "final", true);
  await signOffForTest(t.ledger, id, "Dana");
  assert.equal(existsSync(path.join(t.home, "tasks", String(id), "round-0")), false, "sign-off deletes every copy");
  const row = t.ledger.reviewRowsForTask(id).find((r) => r.after !== undefined && JSON.stringify(r).includes("THREE"))!;
  t.ledger.recordDecision({ rowId: row.id, decision: "reject", note: "no", reviewer: "Dana" });
  assert.equal(signoffStatus(t.ledger, id).reopened, true);
  return id;
}

describe("a task reopened after sign-off keeps working", () => {
  it("the reviewer's sequence: submit succeeds, the rejected row is fixed and the task signs again", async () => {
    const t = await setup();
    const id = await signedThenRejected(t);
    await t.tasks.touch("c", t.file);
    await writeFile(t.file, "one\nTWO\nTHREE fixed\n");
    // The round writes no value row, so the fix's row is planted before the round that cuts.
    const fixRows = plantValueRows(t.ledger, id, [{ file: t.file, before: "THREE", after: "THREE fixed", location: "line 3" }]);
    const summary = await t.tasks.submit("c", "fix", false);
    const decision = t.ledger.decisionsForTask(id).at(-1)!;
    const rejected = t.ledger.reviewRowsForTask(id).find((r) => r.id === decision.rowId)!;
    t.ledger.recordResolution({ rowId: rejected.id, resolution: "fixed", intent: "fixed", clientName: "c", decisionId: decision.id, opIds: [] });
    for (const rowId of fixRows) t.ledger.recordDecision({ rowId, decision: "approve", note: "", reviewer: "Dana" });
    await t.tasks.submit("c", "final again", true);
    const again = await signOffForTest(t.ledger, id, "Dana");
    assert.equal(again.rounds, summary.round + 1);
    assert.equal(existsSync(path.join(t.home, "tasks", String(id), `round-${summary.round + 1}`)), false, "the second sign-off deletes every copy again");
    await t.cleanup();
  });

  // The "changed after the task closed" row is deleted (it reached nothing visible); the rebuilt baseline still holds the hand edit.
  it("a file changed on disk between sign-off and reopen: the rebuilt baseline holds the hand edit", async () => {
    const t = await setup();
    const id = await signedThenRejected(t);
    await writeFile(t.file, "one\nTWO\nTHREE by hand\n");
    await t.tasks.touch("c", t.file);
    const baseline = t.ledger.snapshotsForTask(id).filter((s) => !s.removed && s.filePath === t.file).at(-1)!;
    assert.equal(baseline.sha256, createHash("sha256").update("one\nTWO\nTHREE by hand\n").digest("hex"), "the baseline is the file as it stands, hand edit included");
    await t.cleanup();
  });

  it("sweep over a reopened task keeps its copies and values", async () => {
    const t = await setup();
    const id = await signedThenRejected(t);
    await t.tasks.touch("c", t.file);
    const copies = t.ledger.snapshotsForTask(id).filter((s) => !s.removed && s.snapshotPath !== "");
    assert.ok(copies.length > 0, "the reopened task has a baseline copy again");
    t.advance(6 * DAY);
    await t.tasks.sweep();
    assert.equal(t.ledger.valuesExpiredAt(id), undefined, "values intact: the task is live again");
    assert.equal(t.ledger.closureForTask(id), undefined);
    for (const s of copies) assert.ok(existsSync(s.snapshotPath), "open-policy pruning keeps the latest copy");
    await writeFile(t.file, "one\nTWO\nTHREE fixed\n");
    const summary = await t.tasks.submit("c", "fix", false);
    assert.ok(summary.round > 0, "the reopened task cuts a round");
    await t.cleanup();
  });

  it("value expiry counts from the latest close, not the first sign-off", async () => {
    const t = await setup();
    const id = await signedThenRejected(t);
    t.advance(31 * DAY);
    await t.tasks.sweep();
    // reopened and idle for 7 days: expires as of now, so values stay until 30 days after that
    assert.equal(t.ledger.valuesExpiredAt(id), undefined);
    assert.ok(t.ledger.closureForTask(id), "idle reopened task expires again");
    await t.cleanup();
  });

  it("closedNotes and the review index agree with closureOf for a reopened task", async () => {
    const t = await setup();
    const id = await signedThenRejected(t);
    await writeFile(t.file, "one\nTWO\nTHREE by hand\n");
    assert.equal(closureOf(t.ledger, id), undefined);
    assert.deepEqual(reviewModel(t.ledger, id).closedNotes, [], "a reopened task is not closed, so no closed-task notes");
    const live = homePage(t.ledger, "tok");
    assert.doesNotMatch(live, /title="Expired"/);
    t.advance(8 * DAY);
    await t.tasks.sweep();
    assert.equal(closureOf(t.ledger, id)?.kind, "expired");
    assert.match(reviewModel(t.ledger, id).closedNotes.join("\n"), /expired, not signed off/);
    const gone = homePage(t.ledger, "tok");
    assert.match(gone, /class="gl exp" title="Expired"/, "reopened then expired lists as expired, not waiting");
    await t.cleanup();
  });

  it("a reopened task resolved without a new round counts its 30 days from the moment it was worked on again", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const start = Date.now();
    const t = await setup();
    try {
      const id = await signedThenRejected(t, start);
      mock.timers.setTime(start + 29 * DAY);
      t.ledger.recordDecision({ rowId: t.ledger.reviewRowsForTask(id).find((r) => JSON.stringify(r).includes("THREE"))!.id, decision: "reject", note: "again", reviewer: "Dana" });
      mock.timers.setTime(start + 30 * DAY);
      const decision = t.ledger.decisionsForTask(id).at(-1)!;
      t.ledger.recordResolution({ rowId: decision.rowId, resolution: "fixed", intent: "fixed", clientName: "c", decisionId: decision.id, opIds: [] });
      assert.equal(closureOf(t.ledger, id)?.kind, "signed", "all items resolved: closed again under the original sign-off");
      assert.equal(closureOf(t.ledger, id)?.ts, new Date(start + 30 * DAY).toISOString());
      mock.timers.setTime(start + 31 * DAY);
      await t.tasks.sweep();
      assert.equal(t.ledger.valuesExpiredAt(id), undefined, "the reviewer worked on day 29 and 30; values must survive day 31");
      mock.timers.setTime(start + 61 * DAY);
      await t.tasks.sweep();
      assert.ok(t.ledger.valuesExpiredAt(id), "and expire 30 days after it closed again");
    } finally {
      await t.cleanup();
      mock.timers.reset();
    }
  });

  it("a signed task never reopened keeps its sign-off time: a page open on day 25 doesn't move the 30 days", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const start = Date.now();
    const t = await setup();
    try {
      const id = await signedOnly(t);
      mock.timers.setTime(start + 25 * DAY);
      t.ledger.recordActivity(id, "reviewer", new Date());
      assert.equal(closureOf(t.ledger, id)?.ts, t.ledger.signoffsForTask(id).at(-1)!.ts);
      mock.timers.setTime(start + 31 * DAY);
      await t.tasks.sweep();
      assert.ok(t.ledger.valuesExpiredAt(id), "values expire 30 days after the sign-off, however often the page is opened");
    } finally {
      await t.cleanup();
      mock.timers.reset();
    }
  });

  it("an expired task never flips back to signed on later activity", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const start = Date.now();
    const t = await setup();
    try {
      const id = await signedThenRejected(t, start);
      mock.timers.setTime(start + 10 * DAY);
      await t.tasks.sweep();
      assert.equal(closureOf(t.ledger, id)?.kind, "expired", "reopened and idle for 7 days: expired");
      mock.timers.setTime(start + 11 * DAY);
      t.ledger.recordActivity(id, "agent", new Date());
      const decision = t.ledger.decisionsForTask(id).at(-1)!;
      t.ledger.recordResolution({ rowId: decision.rowId, resolution: "fixed", intent: "fixed", clientName: "c", decisionId: decision.id, opIds: [] });
      assert.equal(closureOf(t.ledger, id)?.kind, "expired");
    } finally {
      await t.cleanup();
      mock.timers.reset();
    }
  });
});
