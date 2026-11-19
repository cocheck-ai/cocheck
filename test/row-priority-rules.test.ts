import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { itemStates, needsReviewer, type ItemState } from "../src/items.ts";
import { signoffStatus } from "../src/signoff.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";
import { changedOutsideWording, outsideClass } from "../src/fingerprint.ts";
import type { Ledger } from "../src/ledger.ts";

/** The reviewer-side decision record, written straight to the ledger (the removed legacy page was its only other writer). */
const decide = (ledger: Ledger, _taskId: number, rowId: number, decision: "approve" | "reject", note: string, reviewer: string): void => {
  ledger.recordDecision({ rowId, decision, note, reviewer });
};

const ZIP_MTIME = new Date(2020, 0, 1);
const book = (cell: string) =>
  zipSync({ "xl/workbook.xml": strToU8("<workbook><sheets/></workbook>"), "xl/worksheets/sheet1.xml": strToU8(`<s>${cell}</s>`) }, { mtime: ZIP_MTIME });
const deck = (text: string) => zipSync({ "docProps/core.xml": strToU8("p"), "ppt/slides/slide1.xml": strToU8(text) }, { mtime: ZIP_MTIME });

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-pr-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-pr-folder-")));
  const ledger = openLedger(home);
  const tasks = new TaskStore(ledger, home, [createXlsxLayer({ openState: async () => "closed" }), createPptxLayer(), createFilesLayer()]);
  const f = (n: string) => path.join(folder, n);
  await writeFile(f("a.txt"), "anchor\n");
  return {
    home, ledger, tasks, f,
    cleanup: async () => {
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    },
  };
}
type T = Awaited<ReturnType<typeof setup>>;
const isLow = (r: { detail: Record<string, unknown> }) => r.detail.lowPriority === true;

describe("rule 1: no file ending makes an outside change low priority", () => {
  it("outsideClass", () => {
    assert.equal(outsideClass("/x/d.pptx", false), "changed");
    assert.equal(outsideClass("/x/d.PPTX", false), "changed");
    assert.equal(outsideClass("/x/w.xlsx", false), "changed");
    assert.equal(outsideClass("/x/n.txt", false), "changed");
    assert.equal(outsideClass("/x/d.pptx", true), "deleted");
    assert.equal(outsideClass("/x/n.txt", true), "deleted");
  });

  it("a workbook cell edit, a plain-file edit and a pre-touch workbook change are each one normal (not low priority) row; a final close is no longer held by it", async () => {
    for (const how of ["cell", "plain", "pretouch"] as const) {
      const t = await setup();
      await writeFile(t.f("w.xlsx"), book("1"));
      await writeFile(t.f("n.txt"), "n1\n");
      const id = await t.tasks.touch("c", t.f("a.txt"));
      const target = how === "plain" ? "n.txt" : "w.xlsx";
      if (how === "plain") await writeFile(t.f("n.txt"), "n2\n");
      else await writeFile(t.f("w.xlsx"), book("2"));
      if (how === "pretouch") await t.tasks.touch("c", t.f("w.xlsx"));
      assert.equal((await t.tasks.submit("c", "final", true)).final, true, how);
      const rows = t.ledger.reviewRowsForTask(id).filter((r) => path.basename(r.filePath) === target);
      assert.equal(rows.length, 1, how);
      assert.equal(isLow(rows[0]!), false, how);
      assert.equal(rows[0]!.description, changedOutsideWording("changed"), how);
      await t.cleanup();
    }
  });

  it("a deck text edit is one normal row: no block on final close, a block on sign-off until decided", async () => {
    const t = await setup();
    await writeFile(t.f("d.pptx"), deck("one"));
    const id = await t.tasks.touch("c", t.f("a.txt"));
    await writeFile(t.f("d.pptx"), deck("two"));
    const summary = await t.tasks.submit("c", "final", true);
    assert.equal(summary.final, true);
    const rows = t.ledger.reviewRowsForTask(id);
    assert.equal(rows.length, 1);
    assert.equal(isLow(rows[0]!), false);
    assert.equal(rows[0]!.description, changedOutsideWording("changed"));
    assert.ok(signoffStatus(t.ledger, id).blockers.length > 0);
    decide(t.ledger, id, rows[0]!.id, "approve", "", "Dana");
    assert.deepEqual(signoffStatus(t.ledger, id).blockers, []);
    await t.cleanup();
  });
});

describe("rule 2: every undecided row of every round is on the page and decidable", () => {
  it("a round-1 low deck row and a round-2 row are both on the page, both decided there, then sign-off succeeds", async () => {
    const t = await setup();
    await writeFile(t.f("d1.pptx"), deck("one"));
    await writeFile(t.f("d2.pptx"), deck("one"));
    const id = await t.tasks.touch("c", t.f("a.txt"));
    await writeFile(t.f("d1.pptx"), deck("two"));
    await t.tasks.submit("c", "r1", false);
    await writeFile(t.f("d2.pptx"), deck("two"));
    await t.tasks.submit("c", "r2", false);
    await t.tasks.submit("c", "r3", true);
    const model = reviewModel(t.ledger, id);
    const page = renderReviewPage(model);
    const rows = t.ledger.reviewRowsForTask(id);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.ok(page.includes(`data-row="${r.id}"`), `row ${r.id} (round ${r.roundSeq}) is on the page`);
    assert.ok(signoffStatus(t.ledger, id).blockers.length > 0);
    for (const r of rows) decide(t.ledger, id, r.id, "approve", "", "Dana");
    assert.deepEqual(signoffStatus(t.ledger, id).blockers, []);
    await signOffForTest(t.ledger, id, "Dana");
    await t.cleanup();
  });

  it("an undecided low row of another task on the same file blocks this task's sign-off", async () => {
    const t = await setup();
    await writeFile(t.f("d.pptx"), deck("one"));
    const a = await t.tasks.touch("c", t.f("a.txt"));
    await writeFile(t.f("d.pptx"), deck("two"));
    await t.tasks.submit("c", "A final", true);
    assert.equal(t.ledger.reviewRowsForTask(a).length, 1);
    await writeFile(t.f("b.txt"), "b\n");
    const b = await t.tasks.touch("c", t.f("b.txt"));
    assert.notEqual(a, b);
    await t.tasks.submit("c", "B final", true);
    const blockers = signoffStatus(t.ledger, b).blockers;
    assert.ok(blockers.some((x) => new RegExp(`Task ${a} has`).test(x)), blockers.join(" | "));
    await t.cleanup();
  });
});

describe("negative controls assert the priority class too", () => {
  it("one cell in an untouched workbook is one normal row; one slide in an untouched deck is one normal row too", async () => {
    const t = await setup();
    await writeFile(t.f("w.xlsx"), book("1"));
    await writeFile(t.f("d.pptx"), deck("one"));
    const id = await t.tasks.touch("c", t.f("a.txt"));
    await writeFile(t.f("w.xlsx"), book("2"));
    await writeFile(t.f("d.pptx"), deck("two"));
    await t.tasks.submit("c", "round", false);
    const rows = t.ledger.reviewRowsForTask(id);
    const by = new Map(rows.map((r) => [path.basename(r.filePath), r]));
    assert.equal(rows.length, 2);
    assert.equal(isLow(by.get("w.xlsx")!), false);
    assert.equal(by.get("w.xlsx")!.description, changedOutsideWording("changed"));
    assert.equal(isLow(by.get("d.pptx")!), false);
    assert.equal(by.get("d.pptx")!.description, changedOutsideWording("changed"));
    await t.cleanup();
  });
});
void (null as unknown as T);

describe("invariant: every row that blocks sign-off is on the page and a reviewer action clears it", () => {
  const blocksSignoff = (s: ItemState) => {
    assert.equal(needsReviewer(s), Boolean(s.openReason || s.awaiting || s.lowPriority));
    return needsReviewer(s);
  };

  /** Rows in every state across three rounds: open, low, unlogged, awaiting after reject + accepted, approved, rejected-then-fixed. */
  async function everyState() {
    const t = await setup();
    for (const n of ["n1", "n2", "n3", "n4", "n5"]) await writeFile(t.f(`${n}.txt`), "v1\n");
    for (const d of ["d1", "d2"]) await writeFile(t.f(`${d}.pptx`), deck("one"));
    const id = await t.tasks.touch("c", t.f("a.txt"));
    for (const n of ["n1", "n2", "n3", "n4"]) await writeFile(t.f(`${n}.txt`), "v2\n");
    await writeFile(t.f("d1.pptx"), deck("two"));
    await t.tasks.submit("c", "round 1", false);
    await writeFile(t.f("n5.txt"), "v2\n");
    await writeFile(t.f("d2.pptx"), deck("two"));
    await t.tasks.submit("c", "round 2", false);
    await t.tasks.submit("c", "round 3", false);
    const rowOf = (name: string) => t.ledger.reviewRowsForTask(id).find((r) => path.basename(r.filePath) === name)!;
    // n3 approved; n2 rejected then answered "accepted" (awaiting); n4 rejected then answered "fixed" (closed)
    t.ledger.recordDecision({ rowId: rowOf("n3.txt").id, decision: "approve", note: "", reviewer: "Dana" });
    for (const [name, resolution] of [["n2.txt", "accepted"], ["n4.txt", "fixed"]] as const) {
      const d = t.ledger.recordDecision({ rowId: rowOf(name).id, decision: "reject", note: "no", reviewer: "Dana" });
      t.ledger.recordResolution({ rowId: rowOf(name).id, resolution, intent: "answer", clientName: "c", decisionId: d, opIds: [] });
    }
    return { t, id, rowOf };
  }

  it("blocks sign-off => on the page => an action clears it; the rest never block", async () => {
    const { t, id } = await everyState();
    const states = itemStates(t.ledger, id);
    const blocking = states.filter(blocksSignoff);
    assert.ok(blocking.length >= 5, `built rows in every blocking state: ${blocking.length}`);
    // A deck changed outside is no longer low priority, so no row here is; the decks' rows block as normal open items.
    assert.ok(blocking.some((s) => s.awaiting) && blocking.some((s) => s.openReason));
    assert.ok(!blocking.some((s) => s.lowPriority));
    const page = renderReviewPage(reviewModel(t.ledger, id));
    for (const s of blocking) assert.ok(page.includes(`data-row="${s.row.id}"`), `row ${s.row.id} (${s.row.roundSeq}) is on the page`);
    assert.ok(signoffStatus(t.ledger, id).blockers.length > 0);
    for (const s of blocking) {
      decide(t.ledger, id, s.row.id, "approve", "", "Dana");
    }
    assert.deepEqual(signoffStatus(t.ledger, id).blockers, []);
    await signOffForTest(t.ledger, id, "Dana");
    await t.cleanup();
  });

  it("a round-1 row rejected and answered accepted is on the page after round 2; the reviewer confirms it and sign-off succeeds", async () => {
    const t = await setup();
    await writeFile(t.f("n.txt"), "v1\n");
    const id = await t.tasks.touch("c", t.f("a.txt"));
    await writeFile(t.f("n.txt"), "v2\n");
    await t.tasks.submit("c", "round 1", false);
    const row = t.ledger.reviewRowsForTask(id)[0]!;
    const d = t.ledger.recordDecision({ rowId: row.id, decision: "reject", note: "why", reviewer: "Dana" });
    t.ledger.recordResolution({ rowId: row.id, resolution: "accepted", intent: "on purpose", clientName: "c", decisionId: d, opIds: [] });
    await writeFile(t.f("a.txt"), "anchor2\n");
    await t.tasks.submit("c", "round 2", false);
    const page = renderReviewPage(reviewModel(t.ledger, id));
    assert.ok(page.includes(`data-row="${row.id}"`), "on the page");
    assert.ok(signoffStatus(t.ledger, id).blockers.length > 0);
    decide(t.ledger, id, row.id, "approve", "", "Dana");
    for (const r of t.ledger.reviewRowsForTask(id).filter((x) => x.id !== row.id)) decide(t.ledger, id, r.id, "approve", "", "Dana");
    assert.deepEqual(signoffStatus(t.ledger, id).blockers, []);
    await signOffForTest(t.ledger, id, "Dana");
    await t.cleanup();
  });
});
