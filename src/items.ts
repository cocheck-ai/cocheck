import type { DecisionRow, Ledger, RequestConfirmationRow, RequestResolutionRow, RequestRow, ResolutionRow, ReviewRowRecord } from "./ledger.ts";

/** Why an item is open: a reviewer rejected it, or no logged op explains the change. */
type OpenReason = "rejected" | "unlogged";

export interface ItemState {
  row: ReviewRowRecord;
  /** The row's latest reviewer decision, if any. */
  decision?: DecisionRow;
  /** The row's latest resolution, if any. */
  resolution?: ResolutionRow;
  /** Set when the item is open. */
  openReason?: OpenReason;
  /**
   * Set when the agent's answer asks the reviewer instead of closing the item: `accepted` on an
   * unlogged row or a rejection, `fixed` on an unlogged row. Not open (the agent has done its part),
   * but not closed either: sign-off waits for the reviewer to confirm, or reject and reopen it.
   */
  awaiting?: boolean;
  /**
   * An undecided "re-saved or changed outside CoCheck" row (`detail.lowPriority`). Not open, so it
   * never holds up the agent's final submit, but sign-off waits for the reviewer to decide it.
   */
  lowPriority?: boolean;
}

/**
 * Every review row of `taskId` with its current state. Decisions and resolutions are append-only
 * and the latest of each per row wins:
 *
 * - latest decision `approve`: closed.
 * - latest decision `reject`: open until a resolution answers that rejection (its `decision_id`);
 *   a later rejection reopens it.
 * - no decision: open while the row is `unlogged` and unresolved; `explained` and `derived` rows
 *   are not items until a reviewer rejects them.
 *
 * The agent can't close a catch: its answer to an unlogged row (either kind), and `accepted` on a
 * rejection, leave the item `awaiting` until the reviewer's next decision on the row (approve
 * closes it, reject reopens it). Only `fixed` on a rejection closes on its own.
 */
export function itemStates(ledger: Ledger, taskId: number): ItemState[] {
  const decisions = new Map<number, DecisionRow>();
  for (const d of ledger.decisionsForTask(taskId)) {
    decisions.set(d.rowId, d);
  }
  const resolutions = new Map<number, ResolutionRow[]>();
  for (const r of ledger.resolutionsForTask(taskId)) {
    resolutions.set(r.rowId, [...(resolutions.get(r.rowId) ?? []), r]);
  }
  return ledger.reviewRowsForTask(taskId).map((row) => {
    const decision = decisions.get(row.id);
    const rowResolutions = resolutions.get(row.id) ?? [];
    const state: ItemState = { row, decision, resolution: rowResolutions.at(-1) };
    if (decision?.decision === "reject") {
      const answer = rowResolutions.findLast((r) => r.decisionId === decision.id);
      if (!answer) {
        state.openReason = "rejected";
      } else if (answer.resolution === "accepted") {
        state.awaiting = true;
      }
    } else if (decision === undefined && row.status === "unlogged") {
      if (isLowPriorityRow(row)) {
        state.lowPriority = true;
      } else if (rowResolutions.length === 0) {
        state.openReason = "unlogged";
      } else {
        state.awaiting = true;
      }
    }
    return state;
  });
}

/** Whether a review row (or a row about to be recorded) is low priority: the one reader of `detail.lowPriority`, only rows written by earlier builds carry it. */
export function isLowPriorityRow(row: { status: string; detail?: unknown }): boolean {
  return isAnotherSessionRow(row) || (row.status === "unlogged" && (row.detail as { lowPriority?: unknown } | undefined)?.lowPriority === true);
}

/** A change a sibling session's task credited to its own call. It is shown with the low-priority rows but is closed: no item, no sign-off blocker. */
export function isAnotherSessionRow(row: { detail?: unknown }): boolean {
  return (row.detail as { anotherSession?: unknown } | undefined)?.anotherSession === true;
}

/**
 * Whether a row's current state would block sign-off: it is open, its answer awaits the reviewer, or it is
 * an undecided low-priority row. The one predicate sign-off, the page and the decision check share, so a
 * row that blocks sign-off is always on the page and takes a reviewer decision.
 */
export function needsReviewer(state: ItemState): boolean {
  return Boolean(state.openReason || state.awaiting || state.lowPriority);
}

interface RequestState {
  request: RequestRow;
  /** The latest answer to the request, if any. */
  resolution?: RequestResolutionRow;
  open: boolean;
  /** The agent declined (`accepted`) and the reviewer hasn't yet confirmed or rejected that. */
  awaiting: boolean;
  /** The reviewer's rejection of the latest answer, which reopened the request. */
  rejection?: RequestConfirmationRow;
}

/**
 * Every task-level "request a change" of `taskId`, oldest first. A request is tied to no row and
 * open until the agent answers it. `fixed` closes it; `accepted` leaves it awaiting the reviewer,
 * who confirms (closed) or rejects (open again, with the reviewer's note). Each request is answered
 * on its own.
 */
export function requestStates(ledger: Ledger, taskId: number): RequestState[] {
  const answers = new Map<number, RequestResolutionRow>();
  for (const r of ledger.requestResolutionsForTask(taskId)) {
    answers.set(r.requestId, r);
  }
  const verdicts = new Map<number, RequestConfirmationRow>();
  for (const c of ledger.requestConfirmationsForTask(taskId)) {
    verdicts.set(c.resolutionId, c);
  }
  return ledger.requestsForTask(taskId).map((request) => {
    const resolution = answers.get(request.id);
    const verdict = resolution === undefined ? undefined : verdicts.get(resolution.id);
    if (resolution === undefined) {
      return { request, resolution, open: true, awaiting: false };
    }
    if (verdict?.verdict === "reject") {
      return { request, resolution, open: true, awaiting: false, rejection: verdict };
    }
    return { request, resolution, open: false, awaiting: resolution.resolution === "accepted" && verdict === undefined };
  });
}

/** Open review rows plus open requests of `taskId`: everything sign-off and a final submit wait on. */
export function openItemCount(ledger: Ledger, taskId: number): number {
  return itemStates(ledger, taskId).filter((s) => s.openReason).length + requestStates(ledger, taskId).filter((q) => q.open).length;
}

/** Undecided low-priority rows of `taskId`: they block sign-off, never a final submit. */
export function lowPriorityCount(ledger: Ledger, taskId: number): number {
  return itemStates(ledger, taskId).filter((s) => needsReviewer(s) && s.lowPriority).length;
}

/** Row items plus requests of `taskId` whose answer waits on the reviewer: they block sign-off, not a final submit. */
export function awaitingItemCount(ledger: Ledger, taskId: number): number {
  return itemStates(ledger, taskId).filter((s) => s.awaiting).length + requestStates(ledger, taskId).filter((q) => q.awaiting).length;
}
