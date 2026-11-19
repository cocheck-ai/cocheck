// File rows the hook recorded with no connector (rows from before connectors, and types no built-in claimed on that OS at the time)
// whose file a built-in claims today. They get a change list the way a live row does, read later: the review process queues a pending capture for each
// when the task loads, and settleFileCapture reads it with today's claimant, under the task lock. Only the capture tables are written; the file_states
// row the hook wrote is never touched. A row whose stored sides are gone gets "no change list was kept" instead of a run.
import { existsSync } from "node:fs";
import path from "node:path";
import type { FileStateRow, Ledger } from "../ledger.ts";
import { storeDirOf } from "../states.ts";
import { builtinClaims } from "./builtins.ts";
import { connectorClaimsFor } from "./installed-match.ts";

/** The reason a queued old row gets when CoCheck no longer has both stored sides of its change (a size cap, a sign-off, an expiry, a hash-only file). */
export const NO_LIST_KEPT = "no change list was kept: CoCheck no longer had the stored copies of this change when it came to read it";
/** The reason a queued old row gets when no built-in claims its file any more (the user moved the type to another connector, or none). */
export const NO_CLAIM_NOW = "no change list was kept: no built-in connector is enabled for this file type now";

/**
 * Today's built-in claimant of a file, by the enabled claims (connectorClaimsFor), or undefined. A type the user moved to an installed connector is
 * not an old row's to re-ask: undefined. Reads the manifests and the setting file once per call; never throws.
 */
export function oldRowClaimsFor(home: string): (file: string) => string | undefined {
  try {
    const builtins = builtinClaims();
    const ids = new Set(builtins.map((b) => b.id));
    const of = connectorClaimsFor(home, builtins);
    return (file) => {
      const id = of(file);
      return id !== undefined && ids.has(id) ? id : undefined;
    };
  } catch {
    return () => undefined;
  }
}

/** Whether both sides a capture of this row reads are still in the task's store (a missing side is null and needs nothing). A hash-only row has none. */
export function sidesStored(home: string, row: Pick<FileStateRow, "taskId" | "prevSha256" | "sha256" | "kept">): boolean {
  if (row.kept === "hash") return false;
  const dir = storeDirOf(home, row.taskId);
  const refs = [row.prevSha256, row.kept === "gone" ? null : row.sha256].filter((r): r is string => r !== null);
  return refs.length > 0 && refs.every((r) => existsSync(path.join(dir, r)));
}

/**
 * Queues a pending capture for every change row of the task (not the starting copy) with no connector, no capture yet, and a file a built-in claims
 * today; returns how many it queued.
 * Writes only `file_state_captures` (one 'pending' row each, idempotent). Nothing runs here: settlePendingCaptures reads them one at a time, under the
 * task lock. A task whose values expired is left alone (its sides are gone and the page says so). Never throws.
 */
export function queueOldRows(ledger: Ledger, home: string, taskId: number): number {
  try {
    if (ledger.valuesExpiredAt(taskId) !== undefined) return 0;
    const all = ledger.fileStatesForTask(taskId);
    // The task's starting copy is not a change and the page asks nothing for it: the same rule as the timeline's (runs.ts readRecord, `baseline`).
    const firstStep = Math.min(...all.map((r) => r.stepId), Infinity);
    const rows = all.filter((r) => r.connector === null && r.capture === null && !(r.prevSha256 === null && r.credited.length === 0 && r.stepId === firstStep));
    if (rows.length === 0) return 0;
    const claim = oldRowClaimsFor(home);
    let n = 0;
    for (const r of rows) if (claim(r.filePath) !== undefined && ledger.queueCapture(r.id)) n++;
    return n;
  } catch {
    return 0;
  }
}
