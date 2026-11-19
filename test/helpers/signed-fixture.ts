import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { collectSignoff, isBusy, pruneSignedCopies, refuseUnlessReady, SIGNOFF_BUSY, SIGNOFF_NOT_READY, SignoffError, signoffInput, signoffStatus } from "../../src/signoff.ts";
import type { Ledger, SignoffRow } from "../../src/ledger.ts";

/**
 * Test fixture only: a signed-off task for tests that need one as set-up. Runs every check a real
 * sign-off runs (ready, files unchanged), then inserts the row on a second connection with a
 * placeholder signature, because no code path in src/ records a sign-off without a signature.
 * Never import this from src/ or scripts/.
 */
export async function signOffForTest(ledger: Ledger, taskId: number, signer: string): Promise<SignoffRow> {
  const { who, seq, files, leftOut } = await collectSignoff(ledger, taskId, signer);
  const db = new DatabaseSync(path.join(ledger.home!, "ledger.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 2000;");
    // The same atomic step a real sign-off takes: write lock first, status and round checked again under it.
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isBusy(error)) throw new SignoffError(SIGNOFF_BUSY, "Another sign-off or review is saving right now; try again in a moment.");
      throw error;
    }
    let id: number;
    try {
      refuseUnlessReady(taskId, signoffStatus(ledger, taskId));
      const rounds = ledger.roundsForTask(taskId);
      if (rounds.at(-1)!.seq !== seq) {
        throw new SignoffError(SIGNOFF_NOT_READY, `Task ${taskId} can't be signed off yet: the agent submitted again while it was being signed; review round ${rounds.at(-1)!.seq} first.`);
      }
      const input = signoffInput(ledger, taskId, who, seq, files, leftOut);
      const result = db
        .prepare(
          `INSERT INTO signoffs (task_id, signer, ts, rounds, rejections_json, files_json, left_out_json, closed_task, signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test-fixture')`,
        )
        .run(input.taskId, input.signer, new Date().toISOString(), input.rounds, JSON.stringify(input.rejections), JSON.stringify(input.files), JSON.stringify(input.leftOut), input.closedTask ? 1 : 0);
      id = Number(result.lastInsertRowid);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    await pruneSignedCopies(ledger, taskId);
    return ledger.signoffsForTask(taskId).find((s) => s.id === id)!;
  } finally {
    db.close();
  }
}

/** Test fixture only: a sign-off row with a NULL signature, as an older ledger holds it. */
export function insertLegacySignoff(ledger: Ledger, input: { taskId: number; signer: string; rounds: number; closedTask?: boolean }): number {
  const db = new DatabaseSync(path.join(ledger.home!, "ledger.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 2000;");
    // The insert trigger refuses a NULL signature, as it should; an older row predates it, so drop it for this one connection's insert.
    db.exec("DROP TRIGGER signoffs_need_signature");
    try {
      const r = db
        .prepare(`INSERT INTO signoffs (task_id, signer, ts, rounds, rejections_json, files_json, left_out_json, closed_task) VALUES (?, ?, ?, ?, '[]', '[]', '[]', ?)`)
        .run(input.taskId, input.signer, new Date().toISOString(), input.rounds, input.closedTask ? 1 : 0);
      return Number(r.lastInsertRowid);
    } finally {
      db.exec(`CREATE TRIGGER signoffs_need_signature BEFORE INSERT ON signoffs
        WHEN NEW.signature IS NULL OR length(trim(NEW.signature)) = 0
        BEGIN SELECT RAISE(ABORT, 'sign-off needs a signature'); END;`);
    }
  } finally {
    db.close();
  }
}
