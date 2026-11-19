import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm, writeFile, unlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { MAX_FOLDER_BYTES, MAX_FOLDER_FILES } from "../src/formats/files/scan.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import type { FormatLayer } from "../src/formats/layer.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { changedOutsideWording } from "../src/fingerprint.ts";

/** A stand-in xlsx layer: the folder watch must leave xlsx to it and never hand it to the files layer. */
const fakeXlsx: FormatLayer = {
  name: "xlsx",
  accepts: (p) => /\.xlsx$/i.test(p),
  snapshot: async () => "missing",
  diff: async () => [],
  describe: () => "",
  touches: () => false,
  explains: () => false,
  restate: async (_p, row) => row,
};

const fakePptx: FormatLayer = { ...fakeXlsx, name: "pptx", accepts: (p) => /\.pptx$/i.test(p) };

async function setup(layers: FormatLayer[] = [fakeXlsx, createFilesLayer()]) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-fw-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-fw-folder-")));
  const ledger = openLedger(home);
  const tasks = new TaskStore(ledger, home, layers);
  const book = path.join(folder, "book.xlsx");
  await writeFile(book, "x");
  const cleanup = async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  };
  return { tasks, ledger, folder, book, cleanup };
}

describe("task folder watch", () => {
  it("an edit made by hand to a text file in the folder shows as unlogged", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    const notes = path.join(folder, "notes.txt");
    await writeFile(notes, "alpha\nbeta\n");
    await tasks.touch("c", book);
    await writeFile(notes, "alpha\nBETA\n");
    const summary = await tasks.submit("c", "done", false);
    assert.equal(summary.rows.length, 1);
    assert.equal(summary.rows[0]!.status, "unlogged");
    assert.equal(summary.rows[0]!.description, changedOutsideWording(), "an untouched file is a fingerprint, so one row and no diff");
    await cleanup();
  });

  // The round does not report a newcomer as a 'new file' row; it is baselined as a fingerprint, and a later change is one row.
  it("a file created in the folder after open is a newcomer: no row at once, one fingerprint-only row when it changes", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    await tasks.touch("c", book);
    await writeFile(path.join(folder, "fresh.csv"), "a,b\n1,2\n");
    await writeFile(path.join(folder, "~$lock.docx"), "junk");
    const summary = await tasks.submit("c", "done", false);
    assert.deepEqual(summary.rows, []);
    await writeFile(path.join(folder, "fresh.csv"), "a,b\n1,3\n");
    const second = await tasks.submit("c", "again", false);
    // The newcomer is a fingerprint only: a later edit is one fingerprint-only row, not a diff.
    assert.deepEqual(second.rows.map((r) => r.description), [changedOutsideWording()]);
    await cleanup();
  });

  it("a deleted file is an unlogged 'file deleted' row", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    const gone = path.join(folder, "old.md");
    await writeFile(gone, "bye");
    await tasks.touch("c", book);
    await unlink(gone);
    const summary = await tasks.submit("c", "done", false);
    assert.deepEqual(summary.rows.map((r) => [r.status, r.description]), [["unlogged", changedOutsideWording("deleted")]]);
    await cleanup();
  });

  it("a folder over the file cap is skipped with a note, and submit still works", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    for (let i = 0; i < MAX_FOLDER_FILES + 1; i++) await writeFile(path.join(folder, `f${i}.txt`), "x");
    await tasks.touch("c", book);
    await writeFile(path.join(folder, "f0.txt"), "changed");
    const summary = await tasks.submit("c", "done", false);
    assert.equal(summary.rows.length, 0);
    assert.match(summary.notes![0]!, new RegExp(`limit ${MAX_FOLDER_FILES}`));
    await cleanup();
  });
});

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

describe("task folder watch, later rounds", () => {
  it("leftover lock and temp files are not reported as new files", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    await tasks.touch("c", book);
    for (const junk of [".~lock.a.docx#", "~WRL0001.tmp", "._notes.txt", "~$b.docx"]) {
      await writeFile(path.join(folder, junk), "junk");
    }
    const summary = await tasks.submit("c", "done", false);
    assert.deepEqual(summary.rows, []);
    await cleanup();
  });

  it("a byte-only change (CRLF to LF) in a tracked file yields a row", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    const notes = path.join(folder, "notes.txt");
    await writeFile(notes, "a\r\nb\r\n");
    await tasks.touch("c", book);
    await writeFile(notes, "a\nb\n");
    const summary = await tasks.submit("c", "done", false);
    assert.deepEqual(summary.rows.map((r) => [r.status, r.description]), [["unlogged", changedOutsideWording()]]);
    await cleanup();
  });

  it("every workbook in the folder is baselined by byte copy and a hand edit to one no call touched is unlogged", async () => {
    const asked: string[] = [];
    const xlsx = createXlsxLayer({ openState: async (p) => (asked.push(p), "closed") });
    const { tasks, folder, book, cleanup } = await setup([xlsx, createFilesLayer()]);
    await copyFile(fixture("value-edit-before.xlsx"), book);
    const second = path.join(folder, "second.xlsx");
    await copyFile(fixture("value-edit-before.xlsx"), second);
    await tasks.touch("c", book);
    await copyFile(fixture("value-edit-after.xlsx"), second);
    const summary = await tasks.submit("c", "done", false);
    const onSecond = summary.rows.filter((r) => r.file === second);
    assert.ok(onSecond.length > 0, "the second workbook's edit is reported");
    // Diffed like any workbook: the hand edit is unlogged, and the formulas it moved are derived from it.
    // a workbook no call touched is a fingerprint, so its hand edit is one fingerprint-only row, not a cell diff.
    assert.deepEqual(onSecond.map((r) => [r.location, r.status, r.description]), [["file", "unlogged", changedOutsideWording()]]);
    assert.ok(!asked.includes(second), "the folder workbook is never checked through Excel");
    await cleanup();
  });

  it("one oversized file is skipped by name, the rest of the folder stays watched, and the note is a banner", async () => {
    const { tasks, ledger, folder, book, cleanup } = await setup();
    await writeFile(path.join(folder, "big.bin"), "");
    await truncate(path.join(folder, "big.bin"), MAX_FOLDER_BYTES + 1024 * 1024);
    const notes = path.join(folder, "notes.txt");
    await writeFile(notes, "a\n");
    await tasks.touch("c", book);
    await writeFile(notes, "b\n");
    const summary = await tasks.submit("c", "done", false);
    assert.deepEqual(summary.rows.map((r) => r.description), [changedOutsideWording()]);
    assert.match(summary.notes?.join(" ") ?? "", /big\.bin/);
    const model = reviewModel(ledger, summary.taskId);
    assert.match(model.notes.join(" "), /big\.bin/);
    assert.match(renderReviewPage(model), /class="banner"[^>]*>[^<]*big\.bin/);
    await cleanup();
  });

  it("an unwatched folder's note stays on the review page after a later round", async () => {
    const { tasks, ledger, folder, book, cleanup } = await setup();
    for (let i = 0; i < MAX_FOLDER_FILES + 1; i++) await writeFile(path.join(folder, `f${i}.txt`), "x");
    const taskId = await tasks.touch("c", book);
    await tasks.submit("c", "one", false);
    await tasks.submit("c", "two", false);
    assert.match(reviewModel(ledger, taskId).notes.join(" "), new RegExp(`limit ${MAX_FOLDER_FILES}`));
    await cleanup();
  });

  it("a reopened older task diffs only its own files; the current task owns the folder scan", async () => {
    const { tasks, ledger, folder, cleanup } = await setup();
    const notes = path.join(folder, "notes.txt");
    const other = path.join(folder, "other.txt");
    await writeFile(notes, "n\n");
    await writeFile(other, "o\n");
    const t1 = await tasks.touch("c", notes);
    await writeFile(other, "O\n");
    const r1 = await tasks.submit("c", "r1", false);
    ledger.recordDecision({ rowId: r1.rows[0]!.id, decision: "approve", note: "", reviewer: "r" });
    await tasks.submit("c", "final", true);
    ledger.recordDecision({ rowId: r1.rows[0]!.id, decision: "reject", note: "no", reviewer: "r" });
    assert.deepEqual(tasks.openTaskIds("c"), [t1], "a rejection at the final round's watermark reopens the task");
    const fresh = path.join(folder, "fresh.txt");
    await writeFile(fresh, "f\n");
    const t2 = await tasks.touch("c", fresh);
    assert.notEqual(t2, t1);
    await writeFile(other, "OO\n");
    const result = await tasks.submit("c", "r2", false);
    const onT1 = result.otherTasks?.find((s) => s.taskId === t1);
    assert.deepEqual(onT1?.rows ?? [], [], "no newcomer or folder-only row lands on the reopened task");
    assert.deepEqual(result.rows.map((r) => [r.file, r.description]), [[other, changedOutsideWording()]]);
    assert.equal(await tasks.touch("c", fresh), t2);
    await cleanup();
  });

  it("a reopened task's own file is reported on it alone, not again by the current task's folder watch", async () => {
    const { tasks, ledger, folder, cleanup } = await setup();
    const notes = path.join(folder, "notes.env");
    await writeFile(notes, "a\n");
    const t1 = await tasks.touch("c", notes);
    await writeFile(notes, "b\n");
    const r1 = await tasks.submit("c", "r1", false);
    ledger.recordDecision({ rowId: r1.rows[0]!.id, decision: "approve", note: "", reviewer: "r" });
    await tasks.submit("c", "final", true);
    ledger.recordDecision({ rowId: r1.rows[0]!.id, decision: "reject", note: "no", reviewer: "r" });
    const fresh = path.join(folder, "fresh.txt");
    await writeFile(fresh, "f\n");
    const t2 = await tasks.touch("c", fresh);
    assert.equal(await tasks.touch("c", notes), t1);
    await writeFile(notes, "c\n");
    const result = await tasks.submit("c", "r2", false);
    assert.equal(result.taskId, t2);
    assert.deepEqual(result.rows, [], "the current task doesn't report the reopened task's file");
    // A secret-named file keeps a row through the round (the fingerprint row); a text diff of an ordinary file went with the round diff.
    assert.equal(result.otherTasks?.[0]?.rows.length, 1);
    assert.match(result.otherTasks![0]!.rows[0]!.description, /^A secret file was changed: notes\.env/);
    await cleanup();
  });

  it("a rejection recorded at the same op watermark as the final round reopens the task", async () => {
    const { tasks, ledger, folder, book, cleanup } = await setup();
    const notes = path.join(folder, "notes.txt");
    await writeFile(notes, "a\n");
    const taskId = await tasks.touch("c", book);
    await writeFile(notes, "b\n");
    const r1 = await tasks.submit("c", "r1", false);
    ledger.recordDecision({ rowId: r1.rows[0]!.id, decision: "approve", note: "", reviewer: "r" });
    await tasks.submit("c", "final", true);
    assert.deepEqual(tasks.openTaskIds("c"), []);
    ledger.recordDecision({ rowId: r1.rows[0]!.id, decision: "reject", note: "wrong", reviewer: "r" });
    assert.deepEqual(tasks.openTaskIds("c"), [taskId]);
    await cleanup();
  });
});

describe("task folder watch, pre-existing files", () => {
  it("50 untouched pre-existing decks and workbooks produce no rows beside one agent-edited deck", async () => {
    const { tasks, folder, cleanup } = await setup([fakeXlsx, fakePptx, createFilesLayer()]);
    for (let i = 0; i < 25; i++) {
      await writeFile(path.join(folder, `old${i}.pptx`), `deck ${i}`);
      await writeFile(path.join(folder, `old${i}.xlsx`), `book ${i}`);
    }
    await writeFile(path.join(folder, `empty.txt`), "");
    const deck = path.join(folder, "board.pptx");
    await writeFile(deck, "v1");
    await tasks.touch("c", deck);
    await writeFile(deck, "v2");
    const summary = await tasks.submit("c", "done", false);
    assert.ok(summary.rows.every((r) => r.file === deck), JSON.stringify(summary.rows.map((r) => [r.file, r.kind])));
    await cleanup();
  });

  it("a pre-existing file edited by hand during the task is unlogged, and one created during it is no row", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    const old = path.join(folder, "old.txt");
    await writeFile(old, "a\n");
    await tasks.touch("c", book);
    await writeFile(old, "b\n");
    await writeFile(path.join(folder, "fresh.txt"), "n\n");
    const summary = await tasks.submit("c", "done", false);
    assert.deepEqual(
      summary.rows.map((r) => [path.basename(r.file), r.status, r.kind]).sort(),
      [["old.txt", "unlogged", "changed outside CoCheck"]],
    );
    await cleanup();
  });

  it("a deleted file is one row, and no row of a newcomer reads 'was (empty), now (empty)'", async () => {
    const { tasks, folder, book, cleanup } = await setup([fakeXlsx, createPptxLayer(), createFilesLayer()]);
    const gone = path.join(folder, "gone.md");
    await writeFile(gone, "bye");
    await tasks.touch("c", book);
    await writeFile(path.join(folder, "blank.txt"), "");
    await writeFile(path.join(folder, "fresh.csv"), "a\n");
    await copyFile(fixture("deck-resave.pptx"), path.join(folder, "fresh deck.pptx"));
    await unlink(gone);
    const summary = await tasks.submit("c", "done", false);
    // The newcomers are baselined with no row; the deletion is the one row, in the one wording.
    assert.deepEqual(summary.rows.map((r) => [path.basename(r.file), r.description]), [["gone.md", changedOutsideWording("deleted")]]);
    await cleanup();
  });

  it("the baseline of a 200-file folder takes under a second", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    for (let i = 0; i < 195; i++) await writeFile(path.join(folder, `f${i}.pptx`), Buffer.alloc(50_000, i));
    const t0 = performance.now();
    await tasks.touch("c", book);
    assert.ok(performance.now() - t0 < 1000);
    await cleanup();
  });
});
