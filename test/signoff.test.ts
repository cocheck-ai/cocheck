import { posixOnly } from "./helpers/platform.ts";
import { describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { openLedger, type RecordReviewRowInput } from "../src/ledger.ts";
import { MAX_FOLDER_BYTES } from "../src/formats/files/scan.ts";
import { signOffForTest, insertLegacySignoff } from "./helpers/signed-fixture.ts";
import { coverageLines, formatLocalTime, SignoffError, signoffStatus, verifyFile } from "../src/signoff.ts";
import type { Ledger } from "../src/ledger.ts";

/** The reviewer-side decision record, written straight to the ledger (the removed legacy page was its only other writer). */
const decide = (ledger: Ledger, _taskId: number, rowId: number, decision: "approve" | "reject", note: string, reviewer: string): void => {
  ledger.recordDecision({ rowId, decision, note, reviewer });
};

const REVIEW_CLI = path.join(import.meta.dirname, "..", "scripts", "review.ts");
const CLIENT = "claude-desktop";

function sha(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function row(input: Pick<RecordReviewRowInput, "filePath" | "location" | "status">): RecordReviewRowInput {
  return { layer: "xlsx", kind: "value", before: 1, after: 2, ops: [], description: `${input.location} changed`, detail: {}, ...input };
}

/**
 * A task over two real files (a workbook and a notes file) with round snapshots on disk:
 * round 1 (not final) has an unlogged row the reviewer rejects, round 2 is whatever `round2` says.
 */
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-signoff-home-"));
  // The ledger keys files by their real path (/var -> /private/var on macOS).
  const work = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-signoff-work-")));
  const book = path.join(work, "Budget Q3.xlsx");
  const notes = path.join(work, "notes.txt");
  const ledger = openLedger(home);
  const taskId = ledger.openTask(CLIENT);

  async function snap(round: number, file: string, bytes: string | null) {
    const dest = path.join(home, "tasks", String(taskId), `round-${round}`, path.basename(file));
    if (bytes !== null) {
      await mkdir(path.dirname(dest), { recursive: true });
      await writeSealed(dest, bytes);
    }
    return { taskId, round, filePath: file, layer: "xlsx", snapshotPath: dest, mode: bytes === null ? "missing" : "copy" };
  }

  await writeFile(book, "book v0");
  await writeFile(notes, "notes v0");
  ledger.recordSnapshot(await snap(0, book, "book v0"));
  ledger.recordSnapshot(await snap(0, notes, "notes v0"));
  await writeFile(book, "book v1");
  ledger.recordRound({
    taskId,
    seq: 1,
    intent: "first pass",
    clientName: CLIENT,
    final: false,
    lastOpId: 0,
    snapshots: [await snap(1, book, "book v1"), await snap(1, notes, "notes v0")],
    rows: [row({ filePath: book, location: "Sheet1!B3", status: "unlogged" })],
  });
  const r1 = ledger.reviewRowsForTask(taskId)[0]!;
  decide(ledger, taskId, r1.id, "reject", "should be 1,200", "Dana");

  return {
    home,
    work,
    book,
    notes,
    ledger,
    taskId,
    /** The agent answers the rejection and submits round 2 with the files as they are now. */
    async round2(opts: { final: boolean; rows?: RecordReviewRowInput[] } = { final: true }) {
      const decision = ledger.decisionsForTask(taskId).at(-1)!;
      ledger.recordResolution({ rowId: r1.id, resolution: "fixed", intent: "Dana's number is in B4", clientName: CLIENT, decisionId: decision.id, opIds: [] });
      await writeFile(book, "book v2");
      ledger.recordRound({
        taskId,
        seq: 2,
        intent: "second pass",
        clientName: CLIENT,
        final: opts.final,
        lastOpId: 0,
        snapshots: [await snap(2, book, "book v2"), await snap(2, notes, "notes v0")],
        rows: opts.rows ?? [row({ filePath: book, location: "Sheet1!B4", status: "explained" })],
      });
    },
    cli(args: string[], reviewer = "Dana") {
      const r = spawnSync(process.execPath, [REVIEW_CLI, ...args], {
        env: { ...process.env, COCHECK_HOME: home, COCHECK_REVIEWER: reviewer },
        encoding: "utf8",
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    /** Signs the task as a fixture (the real paths refuse without a signature). */
    sign(signer = "Dana") {
      return signOffForTest(ledger, taskId, signer);
    },
    async cleanup() {
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    },
  };
}

async function refusal(p: Promise<unknown>, code: string, message: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SignoffError, String(e));
    assert.equal(e.code, code);
    assert.match(e.message, message);
    return true;
  });
}

describe("sign-off: allowed only when review is finished", () => {
  it("refuses a non-final latest round only while an item is open, and says which", async () => {
    const t = await setup();
    await t.round2({ final: false, rows: [row({ filePath: t.book, location: "Sheet1!B4", status: "unlogged" })] });
    assert.deepEqual(signoffStatus(t.ledger, t.taskId).blockers, ["1 item still needs a decision."]);
    await refusal(signOffForTest(t.ledger, t.taskId, "Dana"), "SIGNOFF_NOT_READY", /1 item still needs a decision/);
    const cli = t.cli(["sign", String(t.taskId)]);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /usage/i);
    assert.doesNotMatch(cli.stderr, /\bsign </);
    assert.equal(t.ledger.signoffsForTask(t.taskId).length, 0);
    await t.cleanup();
  });

  it("refuses while any item is open: an unanswered rejection or an unresolved unlogged row", async () => {
    const t = await setup();
    // Round 1's rejection is still unanswered here, and round 2 is not submitted yet either.
    await refusal(signOffForTest(t.ledger, t.taskId, "Dana"), "SIGNOFF_NOT_READY", /1 item still needs a decision/);
    await t.round2({
      final: true,
      rows: [row({ filePath: t.book, location: "Sheet1!B4", status: "unlogged" }), row({ filePath: t.book, location: "Sheet1!B5", status: "explained" })],
    });
    const b5 = t.ledger.reviewRowsForTask(t.taskId).find((r) => r.location === "Sheet1!B5")!;
    decide(t.ledger, t.taskId, b5.id, "reject", "wrong", "Dana");
    assert.deepEqual(signoffStatus(t.ledger, t.taskId).blockers, ["2 items still need a decision."]);
    await refusal(signOffForTest(t.ledger, t.taskId, "Dana"), "SIGNOFF_NOT_READY", /2 items still need a decision/);
    assert.notEqual(t.cli(["sign", String(t.taskId)]).status, 0);
    assert.equal(t.ledger.signoffsForTask(t.taskId).length, 0);
    await t.cleanup();
  });

  it("refuses when a file on disk differs from what the latest round captured", async () => {
    const t = await setup();
    await t.round2();
    await writeFile(t.book, "book v2, edited after review");
    await refusal(signOffForTest(t.ledger, t.taskId, "Dana"), "SIGNOFF_FILES_CHANGED", /Budget Q3\.xlsx changed after the agent's last submit/);
    await rm(t.notes);
    await refusal(signOffForTest(t.ledger, t.taskId, "Dana"), "SIGNOFF_FILES_CHANGED", /notes\.txt is no longer on disk/);
    assert.equal(t.ledger.signoffsForTask(t.taskId).length, 0);
    await t.cleanup();
  });

  it("records signer, time, round count, rejections per round and the SHA-256 of every file (fixture)", async () => {
    const t = await setup();
    await t.round2();
    const before = new Date().toISOString();
    await t.sign("Dana Ruiz");
    const [rec, ...more] = t.ledger.signoffsForTask(t.taskId);
    assert.equal(more.length, 0);
    assert.equal(rec!.signer, "Dana Ruiz");
    assert.ok(rec!.ts >= before && rec!.ts <= new Date().toISOString(), rec!.ts);
    assert.equal(rec!.rounds, 2);
    assert.deepEqual(rec!.rejections, [
      { round: 1, rejections: 1 },
      { round: 2, rejections: 0 },
    ]);
    assert.deepEqual(rec!.files, [
      { path: t.book, sha256: sha("book v2") },
      { path: t.notes, sha256: sha("notes v0") },
    ]);
    // Once signed, again is refused.
    await refusal(signOffForTest(t.ledger, t.taskId, "Dana"), "ALREADY_SIGNED_OFF", /already signed off by Dana Ruiz/);
    // Append-only.
    assert.throws(() => t.ledger.execForTest("UPDATE signoffs SET signer = 'Eve'"), /append-only/);
    assert.throws(() => t.ledger.execForTest("DELETE FROM signoffs"), /append-only/);
    await t.cleanup();
  });
});

describe("verify <file>", () => {
  it("matches a signed-off file (exit 0), fails once it changes (exit 1), and knows unrelated files", async () => {
    const t = await setup();
    await t.round2();
    await t.sign();
    const rec = t.ledger.signoffsForTask(t.taskId)[0]!;

    const ok = t.cli(["verify", t.book]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), `signed off by Dana on ${formatLocalTime(rec.ts)} in task ${t.taskId}`);

    const sent = path.join(t.work, "sent.xlsx");
    await copyFile(t.book, sent);

    await writeFile(t.book, "book v3, changed after sign-off");
    const changed = t.cli(["verify", t.book]);
    assert.equal(changed.status, 1, changed.stdout);
    assert.equal(changed.stdout.trim(), `changed since Dana signed it off on ${formatLocalTime(rec.ts)} in task ${t.taskId}`);

    // A copy sent elsewhere still verifies, naming the path that was signed.
    const copy = t.cli(["verify", sent]);
    assert.equal(copy.status, 0, copy.stderr);
    assert.match(copy.stdout, new RegExp(`in task ${t.taskId} \\(as .*Budget Q3\\.xlsx\\)`));

    const stranger = path.join(t.work, "other.txt");
    await writeFile(stranger, "never reviewed");
    const none = t.cli(["verify", stranger]);
    assert.equal(none.status, 1);
    assert.equal(none.stdout.trim(), "never part of a sign-off");

    assert.equal(t.cli(["verify", path.join(t.work, "nope.xlsx")]).status, 1);
    await t.cleanup();
  });
});

describe("sign-off: atomic checks, cross-task items, coverage, reopened, local time", () => {
  it("shows times as local time in words", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      assert.equal(formatLocalTime("2026-09-29T04:10:03.340Z"), "29 Sep 2026, 00:10 EDT");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("a rejection recorded while the files are being hashed blocks the sign-off", async () => {
    const t = await setup();
    await t.round2();
    const b4 = t.ledger.reviewRowsForTask(t.taskId).find((r) => r.location === "Sheet1!B4")!;
    const p = signOffForTest(t.ledger, t.taskId, "Dana");
    decide(t.ledger, t.taskId, b4.id, "reject", "wrong", "Eve");
    await refusal(p, "SIGNOFF_NOT_READY", /1 item still needs a decision/);
    assert.equal(t.ledger.signoffsForTask(t.taskId).length, 0);
    await t.cleanup();
  });

  it("two concurrent sign-offs record exactly one", async () => {
    const t = await setup();
    await t.round2();
    const results = await Promise.allSettled([signOffForTest(t.ledger, t.taskId, "Dana"), signOffForTest(t.ledger, t.taskId, "Eve")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((lost.reason as SignoffError).code, "ALREADY_SIGNED_OFF");
    assert.equal(t.ledger.signoffsForTask(t.taskId).length, 1);
    await t.cleanup();
  });

  it("is refused while another task of the same client has an open item on one of this task's files", async () => {
    const t = await setup();
    await t.round2();
    const other = t.ledger.openTask(CLIENT);
    t.ledger.recordRound({
      taskId: other,
      seq: 1,
      intent: "elsewhere",
      clientName: CLIENT,
      final: false,
      lastOpId: 0,
      snapshots: [],
      rows: [row({ filePath: t.book, location: "Sheet2!A1", status: "unlogged" })],
    });
    assert.deepEqual(signoffStatus(t.ledger, t.taskId).blockers, [
      `Task ${other} has 1 open item on ${t.book}; a file can't be signed off while it has an open question anywhere.`,
    ]);
    await refusal(signOffForTest(t.ledger, t.taskId, "Dana"), "SIGNOFF_NOT_READY", new RegExp(`Task ${other} has 1 open item`));
    // Another client's open item on the same path doesn't block.
    await t.cleanup();
  });

  it("is refused while another SESSION's task in the same folder has an open item on one of this task's files", async () => {
    const t = await setup();
    await t.round2();
    const other = t.ledger.openTask(`${CLIENT}?session=B`);
    t.ledger.recordRound({
      taskId: other,
      seq: 1,
      intent: "elsewhere",
      clientName: `${CLIENT}?session=B`,
      final: false,
      lastOpId: 0,
      snapshots: [],
      rows: [row({ filePath: t.book, location: "Sheet2!A1", status: "unlogged" })],
    });
    assert.deepEqual(signoffStatus(t.ledger, t.taskId).blockers, [
      `Task ${other} has 1 open item on ${t.book}; a file can't be signed off while it has an open question anywhere.`,
    ]);
    await t.cleanup();
  });

  it("is refused while another task of the same client has an item awaiting the reviewer on one of this task's files", async () => {
    const t = await setup();
    await t.round2();
    const other = t.ledger.openTask(CLIENT);
    t.ledger.recordRound({
      taskId: other,
      seq: 1,
      intent: "elsewhere",
      clientName: CLIENT,
      final: false,
      lastOpId: 0,
      snapshots: [],
      rows: [row({ filePath: t.book, location: "Sheet2!A1", status: "unlogged" })],
    });
    const elsewhere = t.ledger.reviewRowsForTask(other)[0]!;
    t.ledger.recordResolution({ rowId: elsewhere.id, resolution: "accepted", intent: "the user's edit", clientName: CLIENT, decisionId: null, opIds: [] });
    assert.deepEqual(signoffStatus(t.ledger, t.taskId).blockers, [
      `Task ${other} has 1 open item on ${t.book}; a file can't be signed off while it has an open question anywhere.`,
    ]);
    await t.cleanup();
  });

  it("records every file hashed and every file left out with the reason; the coverage lines and verify show it", posixOnly("a child process started with TZ in its environment reads UTC on Windows, so its zone name differs from this process"), async () => {
    const t = await setup();
    // A file only an earlier round held (the folder watch baselined it, the last submit didn't capture it).
    const held = path.join(t.work, "held.txt");
    await writeFile(held, "held v0");
    const heldSnap = path.join(t.home, "tasks", String(t.taskId), "round-0", "held.txt");
    await mkdir(path.dirname(heldSnap), { recursive: true });
    await writeSealed(heldSnap, "held v0");
    t.ledger.recordSnapshot({ taskId: t.taskId, round: 0, filePath: held, layer: "files", snapshotPath: heldSnap, mode: "copy" });
    await t.round2();
    await writeFile(path.join(t.home, "tasks", String(t.taskId), "folder.json"), JSON.stringify({ dir: t.work, folderOnly: [held] }));
    const scratch = path.join(t.work, "~$Budget Q3.xlsx");
    await writeFile(scratch, "owner");
    const big = path.join(t.work, "big.bin");
    await writeFile(big, "");
    await truncate(big, MAX_FOLDER_BYTES + 1024 * 1024);
    const late = path.join(t.work, "late.txt");
    await writeFile(late, "created after the last submit");

    await t.sign();
    const rec = t.ledger.signoffsForTask(t.taskId)[0]!;
    assert.deepEqual(rec.files.map((f) => f.path), [t.book, t.notes]);
    const reasons = new Map(rec.leftOut!.map((l) => [l.path, l.reason]));
    assert.deepEqual([...reasons.keys()].sort(), [big, held, late, scratch].sort());
    assert.match(reasons.get(big)!, new RegExp(`${Math.round((MAX_FOLDER_BYTES + 1024 * 1024) / 1048576)} MB \\(limit ${Math.round(MAX_FOLDER_BYTES / 1048576)} MB per file\\)`));
    assert.match(reasons.get(scratch)!, /scratch file/);
    assert.match(reasons.get(late)!, /after the agent's last submit/);
    assert.match(reasons.get(held)!, /not captured at the agent's last submit/);

    const out = { stdout: coverageLines(rec).join("\n") };
    assert.match(out.stdout, /hashed 2 files, left out 4:/);
    assert.match(out.stdout, new RegExp(`left out: ${late.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`));

    const v = t.cli(["verify", late]);
    assert.equal(v.status, 1);
    assert.equal(v.stdout.trim(), `left out of Dana's sign-off on ${formatLocalTime(rec.ts)}: ${reasons.get(late)}`);
    await t.cleanup();
  });

});

describe("sign-off: coverage edges, deletions, lock contention", () => {
  it("counts every left-out file past the listed 500, and verify names the folder for an unlisted one", async () => {
    const t = await setup();
    await t.round2();
    const dir = path.join(t.work, "skipped");
    await mkdir(dir);
    await writeFile(path.join(t.home, "tasks", String(t.taskId), "folder.json"), JSON.stringify({ dir, skipped: "the folder was over its caps; its files were not watched." }));
    for (let i = 0; i < 700; i++) await writeFile(path.join(dir, `f${String(i).padStart(3, "0")}.txt`), `x${i}`);
    const rec = await signOffForTest(t.ledger, t.taskId, "Dana");
    assert.match(coverageLines(rec)[0]!, /left out 700:/);
    const unlisted = path.join(dir, "f699.txt");
    const v = await verifyFile(t.ledger, unlisted);
    assert.equal(v.match, false);
    assert.match(v.message, /^left out of Dana's sign-off on .*\(not individually listed\)/);
    assert.doesNotMatch(v.message, /never part of/);
    await t.cleanup();
  });

  it("records a file deleted in review as deleted", async () => {
    const t = await setup();
    await t.round2();
    const seq = 3;
    await rm(t.notes);
    const dest = path.join(t.home, "tasks", String(t.taskId), `round-${seq}`, "notes.txt");
    t.ledger.recordRound({
      taskId: t.taskId, seq, intent: "deleted notes", clientName: CLIENT, final: true, lastOpId: 0,
      snapshots: [{ taskId: t.taskId, round: seq, filePath: t.book, layer: "xlsx", snapshotPath: path.join(t.home, "tasks", String(t.taskId), "round-2", "Budget Q3.xlsx"), mode: "copy" },
        { taskId: t.taskId, round: seq, filePath: t.notes, layer: "xlsx", snapshotPath: dest, mode: "missing" }],
      rows: [],
    });
    const rec = await signOffForTest(t.ledger, t.taskId, "Dana");
    assert.deepEqual(rec.files.map((f) => f.path), [t.book]);
    assert.ok(coverageLines(rec).some((l) => l.includes(t.notes) && /deleted in review/.test(l)), coverageLines(rec).join("\n"));
    assert.match(coverageLines(rec)[0]!, /left out none|deleted 1/);
    await t.cleanup();
  });

  it("refuses with a plain SIGNOFF_BUSY when another connection holds the write lock", async () => {
    const t = await setup();
    await t.round2();
    const other = new DatabaseSync(path.join(t.home, "ledger.sqlite"));
    other.exec("BEGIN IMMEDIATE");
    try {
      await assert.rejects(signOffForTest(t.ledger, t.taskId, "Dana"), (e: unknown) => {
        assert.ok(e instanceof SignoffError, String(e));
        assert.equal(e.code, "SIGNOFF_BUSY");
        assert.match(e.message, /Another sign-off or review is saving right now; try again in a moment\./);
        assert.doesNotMatch(e.message, /locked/);
        return true;
      });
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    assert.equal(t.ledger.signoffsForTask(t.taskId).length, 0);
    await t.cleanup();
  });
});

describe("sign-off closes the task", () => {
  it("dress rehearsal: final, reject, non-final fix round, sign, with no third agent session", async () => {
    const t = await setup();
    // round 1 is non-final with a rejected row; the fix round is submitted non-final.
    await t.round2({ final: false });
    const before = signoffStatus(t.ledger, t.taskId);
    assert.deepEqual(before.blockers, []);
    const tasks = new TaskStore(t.ledger, t.home, [createFilesLayer()]);
    assert.deepEqual(tasks.openTaskIds(CLIENT), [t.taskId], "open until signed");

    const record = await signOffForTest(t.ledger, t.taskId, "Dana");
    assert.equal(record.closedTask, true);
    assert.equal(record.rounds, 2);
    assert.deepEqual(tasks.openTaskIds(CLIENT), [], "the sign-off closed the task");
    assert.equal(tasks.currentTaskId(CLIENT), undefined);
    assert.deepEqual(signoffStatus(t.ledger, t.taskId).blockers, []);
    await t.cleanup();
  });

  it("a sign-off on an already final round does not claim to have closed it", async () => {
    const t = await setup();
    await t.round2({ final: true });
    const record = await signOffForTest(t.ledger, t.taskId, "Dana");
    assert.equal(record.closedTask, false);
    await t.cleanup();
  });

  it("a later touch of a signed file opens a new task; a rejection after sign-off still reopens", async () => {
    const t = await setup();
    await t.round2({ final: false });
    await signOffForTest(t.ledger, t.taskId, "Dana");
    const tasks = new TaskStore(t.ledger, t.home, [createFilesLayer()]);
    await writeFile(t.notes, "notes v1");
    const next = await tasks.touch(CLIENT, t.notes);
    assert.notEqual(next, t.taskId);
    assert.deepEqual(tasks.openTaskIds(CLIENT), [next]);
    const b4 = t.ledger.reviewRowsForTask(t.taskId).find((r) => r.location === "Sheet1!B4")!;
    decide(t.ledger, t.taskId, b4.id, "reject", "wrong after all", "Eve");
    assert.deepEqual(tasks.openTaskIds(CLIENT), [t.taskId, next]);
    await t.cleanup();
  });

});

describe("sign-off covers only files the task touched", () => {
  it("leaves out a folder-watch file nothing touched, and says why; verify reports it as left out", async () => {
    const t = await setup();
    await t.round2();
    // notes.txt was only baselined by the folder watch: same bytes in every round, no row, no op.
    await writeFile(path.join(t.home, "tasks", String(t.taskId), "folder.json"), JSON.stringify({ dir: t.work, folderOnly: [t.notes] }));
    const rec = await signOffForTest(t.ledger, t.taskId, "Dana");
    assert.deepEqual(rec.files.map((f) => f.path), [t.book]);
    const entry = rec.leftOut!.find((l) => l.path === t.notes)!;
    assert.match(entry.reason, /not touched by this task/);
    const v = await verifyFile(t.ledger, t.notes);
    assert.equal(v.match, false);
    assert.match(v.message, /left out of Dana's sign-off.*not touched by this task/);
    assert.equal((await verifyFile(t.ledger, t.book)).match, true);
    await t.cleanup();
  });

  it("still includes a watched file changed only by an unlogged hand edit, and it blocks while open", async () => {
    const t = await setup();
    const decision = t.ledger.decisionsForTask(t.taskId).at(-1)!;
    const r1 = t.ledger.reviewRowsForTask(t.taskId)[0]!;
    t.ledger.recordResolution({ rowId: r1.id, resolution: "fixed", intent: "fixed", clientName: CLIENT, decisionId: decision.id, opIds: [] });
    await writeFile(path.join(t.home, "tasks", String(t.taskId), "folder.json"), JSON.stringify({ dir: t.work, folderOnly: [t.notes] }));
    await writeFile(t.notes, "notes hand-edited");
    const dest = (round: number, f: string) => path.join(t.home, "tasks", String(t.taskId), `round-${round}`, path.basename(f));
    await mkdir(path.dirname(dest(2, t.book)), { recursive: true });
    await writeSealed(dest(2, t.book), "book v1");
    await writeSealed(dest(2, t.notes), "notes hand-edited");
    await writeFile(t.book, "book v1");
    t.ledger.recordRound({
      taskId: t.taskId,
      seq: 2,
      intent: "second pass",
      clientName: CLIENT,
      final: true,
      lastOpId: 0,
      snapshots: [
        { taskId: t.taskId, round: 2, filePath: t.book, layer: "xlsx", snapshotPath: dest(2, t.book), mode: "copy" },
        { taskId: t.taskId, round: 2, filePath: t.notes, layer: "xlsx", snapshotPath: dest(2, t.notes), mode: "copy" },
      ],
      rows: [row({ filePath: t.notes, location: "line 1", status: "unlogged" })],
    });
    await refusal(signOffForTest(t.ledger, t.taskId, "Dana"), "SIGNOFF_NOT_READY", /still needs a decision/);
    const open = t.ledger.reviewRowsForTask(t.taskId).find((r) => r.filePath === t.notes)!;
    decide(t.ledger, t.taskId, open.id, "approve", "my own edit", "Dana");
    const rec = await signOffForTest(t.ledger, t.taskId, "Dana");
    assert.deepEqual(rec.files.map((f) => f.path).sort(), [t.book, t.notes].sort());
    assert.ok(!rec.leftOut!.some((l) => l.path === t.notes));
    await t.cleanup();
  });

  it("includes a watched file whose snapshots differ even with no review row", async () => {
    const t = await setup();
    await t.round2();
    await writeFile(path.join(t.home, "tasks", String(t.taskId), "folder.json"), JSON.stringify({ dir: t.work, folderOnly: [t.notes] }));
    await writeSealed(path.join(t.home, "tasks", String(t.taskId), "round-1", "notes.txt"), "notes v1");
    const rec = await signOffForTest(t.ledger, t.taskId, "Dana");
    assert.deepEqual(rec.files.map((f) => f.path).sort(), [t.book, t.notes].sort());
    await t.cleanup();
  });
});
