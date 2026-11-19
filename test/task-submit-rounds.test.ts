import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { copyFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { SEQ_COLLISION, TaskError, TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";

const ZIP_MTIME = new Date(2020, 0, 1);
const enc = new TextEncoder();

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

function buildBook(cells: { a1: number; a2: number; b1: number }): Uint8Array {
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>${cells.a1}</v></c><c r="B1"><f>A1*2</f><v>${cells.b1}</v></c></row><row r="2"><c r="A2"><v>${cells.a2}</v></c></row></sheetData></worksheet>`;
  return zipSync(
    {
      "xl/workbook.xml": enc.encode(WORKBOOK_XML),
      "xl/_rels/workbook.xml.rels": enc.encode(WORKBOOK_RELS),
      "xl/worksheets/sheet1.xml": enc.encode(sheet),
    },
    { mtime: ZIP_MTIME },
  );
}

/**
 * A task that has touched book.xlsx and then seen the folder's secret file `.env` change on disk, so the next submit has a row to cut.
 * The round does not diff a workbook, so a row comes from the folder watch's fingerprint of a secret file (one row, no value).
 */
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-rounds-home-"));
  const work = await mkdtemp(path.join(tmpdir(), "cocheck-rounds-work-"));
  const book = path.join(work, "book.xlsx");
  await writeFile(book, buildBook({ a1: 1, a2: 2, b1: 2 }));
  const env = path.join(work, ".env");
  await writeFile(env, "KEY=one\n");
  const ledger = openLedger(home);
  const tasks = new TaskStore(ledger, home, [createXlsxLayer({ openState: async () => "closed" }), createFilesLayer()]);
  await tasks.touch("rounds-client", book);
  await writeFile(env, "KEY=two\n");
  return {
    book,
    env,
    ledger,
    tasks,
    sql(query: string): Record<string, unknown>[] {
      const db = new DatabaseSync(path.join(home, "ledger.sqlite"));
      const out = db.prepare(query).all() as Record<string, unknown>[];
      db.close();
      return out;
    },
    async cleanup() {
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

describe("a submit whose round number is taken", () => {
  /** Makes the next `n` round records collide on (task, seq), the way a reviewer's page open in another process does. */
  function forceCollisions(t: Setup, n: number) {
    const real = t.ledger.recordRound.bind(t.ledger);
    let left = n;
    let calls = 0;
    t.ledger.recordRound = ((...args: Parameters<typeof real>) => {
      calls++;
      if (left-- > 0) {
        throw new Error("UNIQUE constraint failed: rounds.task_id, rounds.seq");
      }
      return real(...args);
    }) as typeof t.ledger.recordRound;
    return () => calls;
  }

  it("retries through two collisions in a row and records the round", async () => {
    const t = await setup();
    const calls = forceCollisions(t, 2);
    const summary = await t.tasks.submit("rounds-client", "pass", false);
    assert.equal(calls(), 3);
    assert.equal(summary.round, 1);
    await t.cleanup();
  });

  it("gives up with SEQ_COLLISION after the retry cap (one try plus MAX_SEQ_COLLISION_RETRIES = 3)", async () => {
    const t = await setup();
    const calls = forceCollisions(t, Infinity);
    await assert.rejects(
      () => t.tasks.submit("rounds-client", "pass", false),
      (error) => error instanceof TaskError && error.code === SEQ_COLLISION,
    );
    assert.equal(calls(), 4);
    await t.cleanup();
  });
});

describe("a submit that collides with a reviewer-cut round (another process)", () => {
  /**
   * Makes the reviewer's page open "win the race": just before the agent's first round insert, a reviewer round with the same
   * number and rows (snapshots copied aside) is recorded, as another process's cutReviewerRound would have between the submit's
   * prepare and its record.
   */
  function reviewerWinsRace(t: Setup, between?: () => void) {
    const original = t.ledger.recordRound.bind(t.ledger);
    let armed = true;
    t.ledger.recordRound = ((input: Parameters<typeof original>[0]) => {
      if (armed && input.actor !== "reviewer") {
        armed = false;
        original({
          ...input,
          actor: "reviewer",
          intent: "Round cut when a reviewer opened the review page",
          snapshots: input.snapshots.map((s) => {
            if (s.snapshotPath === "") return s; // a fingerprint-only file has no copy
            copyFileSync(s.snapshotPath, `${s.snapshotPath}.rev`);
            return { ...s, snapshotPath: `${s.snapshotPath}.rev` };
          }),
        });
        between?.();
      }
      return original(input);
    }) as typeof t.ledger.recordRound;
  }

  it("with nothing new, attaches the summary to the reviewer's round: one round, no duplicate rows", async () => {
    const t = await setup();
    reviewerWinsRace(t);
    const summary = await t.tasks.submit("rounds-client", "raised the base input", false);
    assert.equal(summary.round, 1);
    assert.equal(t.sql("SELECT * FROM rounds").length, 1);
    const rows = t.sql("SELECT file_path FROM review_rows");
    assert.equal(rows.length, 1, "one row, not a duplicate of the reviewer's");
    const summaries = t.sql("SELECT payload_json FROM events WHERE kind = 'round_summary'");
    assert.equal(summaries.length, 1);
    assert.equal(JSON.parse(String(summaries[0]!.payload_json)).intent, "raised the base input");
    await t.cleanup();
  });

  it("with a new edit in between, cuts the agent's rows at the next round: two rounds, only the new rows in round 2", async () => {
    const t = await setup();
    reviewerWinsRace(t, () => writeFileSync(t.env, "KEY=three\n"));
    const summary = await t.tasks.submit("rounds-client", "raised the base input", false);
    assert.equal(summary.round, 2);
    assert.equal(t.sql("SELECT * FROM rounds").length, 2);
    assert.deepEqual(
      t.sql("SELECT file_path FROM review_rows WHERE round_id = (SELECT id FROM rounds WHERE seq = 2)").map((r) => path.basename(String(r.file_path))),
      [".env"],
    );
    await t.cleanup();
  });
});
