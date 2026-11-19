// The hook's side of an after-snapshot the review process did not take. When the PostToolUse hook of a call whose PreToolUse journaled a before side
// for a URI subject cannot get the review process to accept the after-snapshot request (not running, refused, no answer inside AFTER_SNAPSHOT_ACCEPT_MS),
// the hook writes one capture-outcome row itself, so the page shows a gap for that call instead of nothing. Any outcome the review process later records
// for the same call (a late acceptance) replaces it on the page, whatever the order the two rows were written in (`captureGapsOf`).
import type { CaptureOutcomeRow, Ledger } from "../ledger.ts";
import { TaskStore } from "../tasks.ts";
import type { AfterNotTakenReason } from "./local-process.ts";

/** What the step says for each class, in plain words. */
export const NOT_TAKEN_REASON: Record<AfterNotTakenReason, string> = {
  "not running": "This change wasn't recorded, because CoCheck's review page wasn't running.",
  refused: "This change wasn't recorded, because CoCheck's review page refused it.",
  "no answer in time": "This change wasn't recorded, because CoCheck's review page didn't answer in time.",
};

/** The gap sentence of a successful create call whose answer did not name the item (no object, no field, over the size cap). */
export const NO_SUBJECT_REASON = "This change wasn't recorded, because the tool's answer didn't name the item.";

/** The hook's own gap row for a create call whose answer is over the size cap (it is never sent to the review process). Throws only when the ledger cannot be written. */
export async function recordNoSubject(ledger: Ledger, home: string, input: { client: string; call: string }): Promise<void> {
  const taskId = await afterTaskOf(ledger, home, input.client, "").catch(() => null);
  ledger.recordCaptureOutcome({ taskId, client: `${input.client}${NOT_TAKEN_CLIENT_MARK}`, call: input.call, subject: "", outcome: "error", reason: NO_SUBJECT_REASON });
}

/** The client suffix that marks a capture-outcome row the hook wrote (the review process never writes one). */
export const NOT_TAKEN_CLIENT_MARK = "#after-not-taken";

/** The task an after-row of `client` goes to when the request names none: the client's current task, else a new one opened as the file sweep opens it. The review process and the hook share it. */
export async function afterTaskOf(ledger: Ledger, home: string, client: string, subject: string): Promise<number> {
  const store = new TaskStore(ledger, home, []);
  const current = store.currentTaskId(client);
  if (current !== undefined) return current;
  return store.touch(client, subject, { missing: true });
}

/**
 * Writes the hook's gap row for one call: session client, call id, subject, tool (in the reason's row through the call id; the step names the tool), time, and the reason class.
 * Throws only when the ledger cannot be written; the hook catches it.
 */
export async function recordNotTaken(ledger: Ledger, home: string, input: { client: string; call: string; subject: string; reason: AfterNotTakenReason }): Promise<void> {
  const taskId = await afterTaskOf(ledger, home, input.client, input.subject).catch(() => null);
  ledger.recordCaptureOutcome({ taskId, client: `${input.client}${NOT_TAKEN_CLIENT_MARK}`, call: input.call, subject: input.subject, outcome: "error", reason: NOT_TAKEN_REASON[input.reason] });
}

/**
 * A task's gaps by call id. A review-process outcome: a later one of the same call replaces an earlier failure, and "recorded" clears it. A hook-written
 * gap shows only when the review process recorded no outcome at all for that call, so a late acceptance's real row always wins.
 */
export function captureGapsOf(outcomes: readonly CaptureOutcomeRow[], gapOutcomes: readonly string[]): Map<string, string> {
  const gaps = new Map<string, string>();
  const notTaken = new Map<string, string>();
  const seen = new Set<string>();
  for (const o of outcomes) {
    if (o.client.endsWith(NOT_TAKEN_CLIENT_MARK)) {
      notTaken.set(o.call, o.reason);
      continue;
    }
    seen.add(o.call);
    if (gapOutcomes.includes(o.outcome)) gaps.set(o.call, o.reason);
    else if (o.outcome === "recorded") gaps.delete(o.call);
  }
  for (const [call, reason] of notTaken) if (!seen.has(call)) gaps.set(call, reason);
  return gaps;
}
