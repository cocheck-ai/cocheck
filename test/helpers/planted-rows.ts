import type { Ledger, RecordReviewRowInput } from "../../src/ledger.ts";

/**
 * The round cut writes no row that carries a before and an after value, so a test of a kept reader or expiry
 * (sign-off, send-back, values expiring, the 4-hour rollover) plants one through the ledger, the way an older round cut left it: a round of
 * its own, after the rounds the task has. Returns the round's row ids.
 */
export function plantValueRows(
  ledger: Ledger,
  taskId: number,
  rows: Array<{ file: string; before?: string; after?: string; status?: RecordReviewRowInput["status"]; location?: string }>,
  opts: { final?: boolean; intent?: string; client?: string } = {},
): number[] {
  const seq = ledger.roundsForTask(taskId).length + 1;
  ledger.recordRound({
    taskId,
    seq,
    intent: opts.intent ?? "planted",
    clientName: opts.client ?? "c",
    final: opts.final ?? false,
    lastOpId: ledger.maxOpId(),
    snapshots: [],
    rows: rows.map((r) => ({
      filePath: r.file,
      layer: "files",
      location: r.location ?? "line 1",
      kind: "line",
      status: r.status ?? "unlogged",
      before: r.before ?? "one",
      after: r.after ?? "two",
      ops: [],
      description: `line 1: '${r.before ?? "one"}' -> '${r.after ?? "two"}'`,
      detail: {},
    })),
  });
  return ledger.reviewRowsForTask(taskId).filter((r) => r.roundSeq === seq).map((r) => r.id);
}
