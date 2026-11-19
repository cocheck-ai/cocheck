import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openLedger, type RecordReviewRowInput } from "../src/ledger.ts";
import { formatValue, isDateFormat } from "./helpers/xlsx-shown.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";

const CLIENT = "claude-desktop";

function row(input: Partial<RecordReviewRowInput> & Pick<RecordReviewRowInput, "filePath" | "location" | "status">): RecordReviewRowInput {
  return {
    layer: "xlsx",
    kind: "value",
    before: null,
    after: null,
    ops: [],
    description: `${input.location} changed`,
    detail: {},
    ...input,
  };
}

/**
 * A task with one round: an explained input change, an unlogged edit (percent format), 52
 * derived recalculations on another sheet, and one row from a non-xlsx layer.
 */
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-page-home-"));
  const work = await mkdtemp(path.join(tmpdir(), "cocheck-page-work-"));
  const book = path.join(work, "Budget Q3.xlsx");
  const notes = path.join(work, "notes.txt");
  const ledger = openLedger(home);
  const taskId = ledger.openTask(CLIENT);
  ledger.recordSnapshot({ taskId, round: 0, filePath: book, layer: "xlsx", snapshotPath: book, mode: "copy" });
  const rows: RecordReviewRowInput[] = [
    row({
      filePath: book,
      location: "Sheet1!B3",
      status: "explained",
      before: 1000,
      after: 1250,
      ops: [{ opId: 1, tool: "Bash", intent: "raise marketing budget per Ana's email", client: CLIENT }],
      detail: { numFmtBefore: "#,##0", numFmtAfter: "#,##0" },
    }),
    row({
      filePath: book,
      location: "Sheet1!C3",
      status: "unlogged",
      before: 0.1,
      after: 0.15,
      detail: { numFmtBefore: "0%", numFmtAfter: "0%" },
    }),
  ];
  for (let i = 1; i <= 52; i++) {
    rows.push(row({ filePath: book, location: `Sheet2!D${i}`, status: "derived", before: i, after: i * 2, detail: {} }));
  }
  rows.push(row({ filePath: notes, layer: "text", kind: "line", location: "line 4", status: "unlogged", before: "old line", after: "new line" }));
  ledger.recordRound({ taskId, seq: 1, intent: "first pass", clientName: CLIENT, final: true, lastOpId: 1, snapshots: [], rows });
  return {
    home,
    work,
    book,
    ledger,
    taskId,
    rowAt(location: string) {
      return ledger.reviewRowsForTask(taskId).find((r) => r.location === location)!;
    },
    async cleanup() {
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    },
  };
}


describe("the review page model", () => {
  it("the row model reads grouped by file and sheet, plainly, with open items first and derived rows collapsed", async () => {
    const t = await setup();
    const page = renderReviewPage(reviewModel(t.ledger, t.taskId));
    assert.match(page, /Budget Q3\.xlsx/);
    assert.match(page, /notes\.txt/);
    assert.match(page, /Sheet1/);
    assert.match(page, /Sheet2/);
    assert.match(page, /1,000/);
    assert.match(page, /1,250/);
    assert.match(page, /10%/);
    assert.match(page, /15%/);
    assert.match(page, /raise marketing budget per Ana&#39;s email/);
    assert.match(page, /claude-desktop/);
    assert.match(page, /Changed outside CoCheck/);
    assert.match(page, /55 changes/);
    assert.match(page, /2 need a look/);
    assert.match(page, /<details[^>]*>\s*<summary>52 recalculated cells/);
    assert.match(page, /line 4/);
    assert.match(page, /new line/);
    const at = (loc: string) => page.indexOf(`data-row="${t.rowAt(loc).id}"`);
    assert.ok(at("Sheet1!C3") > 0 && at("Sheet1!C3") < at("Sheet1!B3"), "the unlogged C3 floats above the explained B3");
    await t.cleanup();
  });

  it("says what happened for new and deleted files instead of (empty) to (empty)", async () => {
    const t = await setup();
    const fresh = path.join(t.work, "fresh.csv");
    const gone = path.join(t.work, "gone.csv");
    t.ledger.recordRound({
      taskId: t.taskId,
      seq: 2,
      intent: "files",
      clientName: CLIENT,
      final: true,
      lastOpId: 2,
      snapshots: [],
      rows: [
        row({ filePath: fresh, layer: "files", kind: "new file", location: "file", status: "unlogged", description: "new file (21 bytes)", detail: { kind: "new file", bytes: 21 } }),
        row({ filePath: gone, layer: "files", kind: "file deleted", location: "file", status: "unlogged", description: "file deleted", detail: { kind: "file deleted" } }),
      ],
    });
    const page = renderReviewPage(reviewModel(t.ledger, t.taskId));
    assert.match(page, /New file \(21 bytes\)/);
    assert.match(page, /File deleted/);
    assert.doesNotMatch(page, /was <b>\(empty\)<\/b>, now <b>\(empty\)<\/b>/);
    await t.cleanup();
  });
});

describe("date-formatted cells on the review page", () => {
  it("renders a date-formatted serial in the cell's own pattern", () => {
    process.env.COCHECK_LOCALE = "en-US";
    assert.equal(formatValue(45413, "m/d/yyyy"), "5/1/2024");
    assert.equal(formatValue(45413, 14), "5/1/2024");
    assert.equal(formatValue(45413, "yyyy-mm-dd", true), "2024-05-01 (stored 45413)");
    assert.equal(formatValue(45413.75, "d-mmm-yy h:mm"), "1-May-24 18:00");
    assert.equal(formatValue(43951, "[$-409]d-mmm-yy;@"), "30-Apr-20");
  });

  it("renders a plain number as Excel's format shows it", () => {
    assert.equal(formatValue(45413), "45413");
    assert.equal(formatValue(45413, "#,##0"), "45,413");
    assert.equal(formatValue(45413, "General"), "45413");
    assert.equal(formatValue(0.05, "0.0%"), "5.0%");
  });

  it("detects date formats the way Excel does", () => {
    for (const f of [14, 15, 22, 45, 46, 47, "mmm yy", "h:mm:ss AM/PM", "dddd, mmmm d", "[$-409]mmmm d, yyyy", "[h]:mm", "yyyy-mm-dd;@"]) {
      assert.equal(isDateFormat(f), true, String(f));
    }
    for (const f of [0, 1, 9, 10, 37, 44, 49, undefined, null, "", "General", "0.00", "#,##0", "0.0%", '0 "days"', '"year" 0', "[Red]0.00", "0.00E+00", '0 "m/d/y"']) {
      assert.equal(isDateFormat(f), false, String(f));
    }
  });
});
