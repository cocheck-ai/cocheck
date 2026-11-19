// The review process's side of an after-snapshot. After a call that wrote a connector's URI subject, the connector is asked
// for the subject's state again; the state is sealed, adopted into the session's task, and recorded as one connector row through `Ledger.recordStep`,
// credited to the call named in the request and to no other. Requests run one at a time, so call N's after is call N+1's before.
import { existsSync } from "node:fs";
import path from "node:path";
import type { Ledger } from "../ledger.ts";
import { TaskStore } from "../tasks.ts";
import { ensureStoreDir, storeDirOf } from "../states.ts";
import { adoptConnectorState, askConnector, beforeSnapshot, connectorStatesDir, installedConnectorFor, type ConnectorPool } from "./before-snapshot.ts";
import { readSealed, sha256Hex, writeSealed } from "../seal.ts";
import { checkChanges } from "./changes-v1.ts";
import { MANIFEST_SPEC } from "./schema.ts";
import { createConnectorDiff, frozenDocOf } from "./diff.ts";
import { levelOfDoc } from "./doc-level.ts";
import { canonicalJson, freezeChanges } from "./frozen.ts";
import type { CaptureOutcomeKind } from "../ledger.ts";
import { afterTaskOf, NO_SUBJECT_REASON } from "./after-gap.ts";
import { answerIsError, loadCallTemplates, renderCallSubject } from "./subjects.ts";
import { beforeSideOfCall } from "../hook-journal.ts";
import type { FileStateRow } from "../ledger.ts";

export interface AfterSnapshotRequest {
  home: string;
  ledger: Ledger;
  pool: ConnectorPool;
  /** The hook client name of the session (the key its task is found by). */
  client: string;
  /** The task the hook believed the session had; used only when it is this client's own, else the client's current task is looked up. */
  task: number | null;
  /** The tool_use_id of the call the change is credited to. */
  call: string;
  subject: string;
  /** The full MCP tool name of the call, when known; the connector is the winner for it. */
  tool?: string;
  /** The before side the pre-call hook sealed (a ref in the home-level store), or null when it was unknown. */
  before: string | null;
  /** The pre-call hook was told the item did not exist (a 200 answer with `ref` null). Only meaningful with `before: null`; the route refuses it with a ref. */
  beforeAbsent?: true;
  /** The call's start and end (ISO 8601, from the hook journal's PreToolUse and PostToolUse records). A diff-entry connector is asked for [callStart, callEnd + DIFF_GRACE_MS). */
  callStart?: string;
  callEnd?: string;
  /** The connector's manifest declares the call created the item (`matches.calls`, `created: true`). A claim only: a state this task already holds for the subject wins over it. */
  declaredCreated?: true;
  /** The hook journal's file stem of the calling session; with `declaredCreated`, the before sides it journaled are read to find a state CoCheck already read in this task. */
  journal?: string;
  budgetMs: number;
}

/** How long after the call's end a vendor's change may still be dated and count as the call's (a vendor's clock and write delay). */
export const DIFF_GRACE_MS = 5000;

export type AfterOutcome = CaptureOutcomeKind;

/** What each outcome says in plain words. A known-subject failure shows these on the rail; no path, id or raw error text is in them. */
export const OUTCOME_REASON: Record<AfterOutcome, string> = {
  recorded: "The change was captured.",
  unchanged: "The call left this item as it was.",
  "no-before": "CoCheck could not read this item before the call, so it cannot say what changed.",
  "no-connector": "No connector covers this item.",
  "no-window": "The call's start or end time was not recorded, so changes could not be matched to it.",
  rejected: "The connector's answer was not in the expected form.",
  error: "The connector could not be read after the call.",
};

/** Outcomes of a subject CoCheck knows (a connector covers it) that failed to capture: these get a gap row. `unchanged` and `no-connector` never do. */
export const GAP_OUTCOMES: readonly AfterOutcome[] = ["no-before", "no-window", "rejected", "error"];

const HEX = /^[0-9a-f]{64}$/;
/** What an export connector's row freezes instead of a change list: CoCheck draws the stored text itself. */
export const EXPORT_FROZEN_SPEC = "cocheck.export/1";

/** The connector's version and the spec identifier it was written for, from its manifest at capture. */
const identityOf = (m: unknown): { connectorVersion: string; connectorSpec: string } => ({ connectorVersion: String((m as { version?: unknown }).version ?? ""), connectorSpec: String((m as { spec?: unknown }).spec ?? MANIFEST_SPEC) });
let chain: Promise<unknown> = Promise.resolve();

/** Runs `f` after every earlier call finished, whatever their outcome. */
export function afterSnapshotSerial<T>(f: () => Promise<T>): Promise<T> {
  const run = chain.then(f, f);
  chain = run.catch(() => {});
  return run;
}

/** The task a session's after-row goes to: the request's own task when it belongs to this client, else the client's current task, else a new one opened as the file sweep opens it (`TaskStore.touch`). */
async function taskOf(req: AfterSnapshotRequest): Promise<number> {
  const store = new TaskStore(req.ledger, req.home, []);
  if (req.task !== null && req.ledger.taskClient(req.task) === req.client && store.currentTaskId(req.client) === req.task) return req.task;
  return afterTaskOf(req.ledger, req.home, req.client, req.subject);
}

/**
 * Runs one capture and records its outcome in the ledger, whatever it was, a thrown error included (the outcome is then "error"). Never throws.
 * A subject with no connector is recorded against the client's current task only (no task is opened for it).
 */
export async function afterSnapshot(req: AfterSnapshotRequest): Promise<AfterOutcome> {
  let outcome: AfterOutcome;
  try {
    outcome = await captureAfter(req);
  } catch {
    outcome = "error";
  }
  try {
    let taskId: number | null = null;
    if (outcome === "no-connector") taskId = new TaskStore(req.ledger, req.home, []).currentTaskId(req.client) ?? null;
    else taskId = await taskOf(req).catch(() => null);
    req.ledger.recordCaptureOutcome({ taskId, client: req.client, call: req.call, subject: req.subject, outcome, reason: OUTCOME_REASON[outcome] });
  } catch {
    // the ledger itself is unwritable: nothing more can be said here
  }
  return outcome;
}

async function captureAfter(req: AfterSnapshotRequest): Promise<AfterOutcome> {
  const { home, ledger, subject, call } = req;
  const installed = installedConnectorFor(home, subject, req.tool);
  if (installed === undefined) return "no-connector";
  const connector = installed.manifest.id;
  if ((installed.manifest as { entry?: string }).entry === "diff") return diffEntryAfter(req, connector, installed.manifest);
  const { ref: after } = await beforeSnapshot({ home, pool: req.pool, subject, ...(req.tool !== undefined ? { tool: req.tool } : {}), budgetMs: req.budgetMs });
  const taskId = await taskOf(req);
  // prev comes only from a sealed ref: the before side the hook sealed, else the last row recorded for this subject in this task.
  const rows = ledger.fileStatesForTask(taskId).filter((r) => r.filePath === subject && r.connector != null);
  const last = rows.at(-1);
  // A declared creation stands only when this task holds and has read no state for the subject; what CoCheck read or holds is the before side instead.
  let before = req.before;
  let beforeAbsent = req.beforeAbsent === true;
  let declared = false;
  if (req.declaredCreated === true && req.before === null && !beforeAbsent) {
    const held = heldBeforeOf(req, taskId, last);
    if (held === "no-before") return "no-before";
    if (held === "declared") declared = true;
    else if (held === "absent") beforeAbsent = true;
    else if (held !== "row") before = held;
  }
  // An absent before (the connector said the item did not exist) is a known before side with no state: the row is a creation, prev null.
  const absent = beforeAbsent && before === null;
  const heldGone = req.declaredCreated === true && before === null && !absent && !declared && last?.kept === "gone";
  let prev: string | null = null;
  if (declared) {
    // the tool said it created the item, yet the item reads as missing: a failure, never a silence
    if (after === null) return "error";
  } else if (absent || heldGone) {
    if (after === null) return "unchanged";
  } else {
    if (before !== null && HEX.test(before) && existsSync(path.join(connectorStatesDir(home), before))) prev = before;
    else if (last !== undefined && last.kept !== "gone" && last.sha256 !== "") prev = last.sha256;
    // A change with no known before side is not recorded: a row would have to guess it.
    if (prev === null) return "no-before";
    if (after === null ? last?.kept === "gone" && last.prevSha256 === prev : after === prev) return "unchanged";
  }
  if (after !== null && last !== undefined && last.kept !== "gone" && last.sha256 === after && last.credited.includes(call)) return "unchanged";
  if (prev !== null) await adoptConnectorState(home, taskId, prev);
  let size = 0;
  if (after !== null) {
    await adoptConnectorState(home, taskId, after);
    size = (await readSealed(path.join(storeDirOf(home, taskId), after))).length;
  }
  // The change list is asked for once, here, and frozen. A failure to get it leaves the row without a list (the page says so); it never blocks the row.
  // A cocheck.changes/1 answer is frozen as the document (with its source); an export connector has no list to ask for, only a marker that CoCheck draws its text.
  let changesSha256: string | undefined;
  try {
    if ((installed.manifest as { entry?: string }).entry === "export") changesSha256 = (await freezeChanges(home, taskId, { spec: EXPORT_FROZEN_SPEC, connector })).sha256;
    else {
      const diff = await createConnectorDiff({ home, taskId })({ subject, connector, before: { ref: prev }, after: { ref: after } });
      changesSha256 = (await freezeChanges(home, taskId, frozenDocOf(diff, connector))).sha256;
    }
  } catch {
    changesSha256 = undefined;
  }
  const client = `${req.client}#connector-after`;
  const seq = ledger.stepsForTask(taskId).filter((s) => s.client === client).reduce((n, s) => Math.max(n, s.seq), 0) + 1;
  ledger.recordStep({
    taskId,
    client,
    seq,
    phase: "Post",
    callsOpen: [call],
    credited: [call],
    files: [{ filePath: subject, sha256: after ?? "", prevSha256: prev, size, kept: after === null ? "gone" : "whole", note: "", credited: [call], connector, ...identityOf(installed.manifest), ...(changesSha256 === undefined ? {} : { changesSha256 }), ...(declared ? { beforeBasis: "declared" as const } : {}) }],
  });
  return "recorded";
}

/**
 * The before side of a declared creation, from everything CoCheck knows of the subject in this task. The latest capture outcome for the subject
 * names the latest read: `recorded` (or no outcome but a row) means the last state row; `unchanged` means that call's journaled before side (its sealed ref, or
 * absent), else the last state row; any failure means CoCheck read the item but does not know its state now ("no-before", a gap). Nothing at all: "declared".
 */
function heldBeforeOf(req: AfterSnapshotRequest, taskId: number, last: FileStateRow | undefined): string | "row" | "absent" | "declared" | "no-before" {
  const latest = req.ledger.captureOutcomesForTask(taskId).filter((o) => o.subject === req.subject).at(-1);
  if (latest === undefined) return last === undefined ? "declared" : "row";
  if (latest.outcome === "recorded") return "row";
  if (latest.outcome === "unchanged") {
    let side: Record<string, string | null> | undefined;
    try {
      side = req.journal === undefined ? undefined : beforeSideOfCall(req.home, req.journal, latest.call);
    } catch {
      side = undefined;
    }
    if (side?.subject === req.subject) {
      const ref = side.ref;
      if (side.state === "snapshot" && typeof ref === "string" && HEX.test(ref) && existsSync(path.join(connectorStatesDir(req.home), ref))) return ref;
      if (side.state === "absent") return "absent";
    }
    return last === undefined ? "no-before" : "row";
  }
  return "no-before";
}

/** A diff-entry connector has no snapshot and needs no before side: it is asked for the changes it dated in the call's window, the answer is sealed as the row's after ref, and an empty answer records nothing. */
async function diffEntryAfter(req: AfterSnapshotRequest, connector: string, installed: unknown): Promise<AfterOutcome> {
  const { home, ledger, subject, call } = req;
  const start = Date.parse(req.callStart ?? ""), end = Date.parse(req.callEnd ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "no-window";
  const since = new Date(start).toISOString(), until = new Date(end + DIFF_GRACE_MS).toISOString();
  const answer = await askConnector({ home, pool: req.pool, subject, ...(req.tool !== undefined ? { tool: req.tool } : {}), budgetMs: req.budgetMs, method: "diffs", params: { subject, since, until } });
  if (checkChanges(answer).length > 0) return "rejected";
  const changes = (answer as { changes: unknown[] }).changes;
  if (changes.length === 0) return "unchanged";
  const taskId = await taskOf(req);
  const frozen = await freezeChanges(home, taskId, { ...(answer as Record<string, unknown>), source: { by: "connector", name: connector, level: levelOfDoc(answer) } });
  const bytes = frozen.bytes;
  const ref = frozen.sha256;
  const rows = ledger.fileStatesForTask(taskId).filter((r) => r.filePath === subject && r.connector != null);
  if (rows.some((r) => r.sha256 === ref && r.credited.includes(call))) return "unchanged";
  // The answer is sealed once, under changes/<ref> by freezeChanges; the row's after ref and its change-list ref are that same hash, so no second copy goes under states/.
  const client = `${req.client}#connector-after`;
  const seq = ledger.stepsForTask(taskId).filter((s) => s.client === client).reduce((n, s) => Math.max(n, s.seq), 0) + 1;
  ledger.recordStep({
    taskId, client, seq, phase: "Post", callsOpen: [call], credited: [call],
    files: [{ filePath: subject, sha256: ref, prevSha256: null, size: bytes.length, kept: "whole", note: "", credited: [call], connector, ...identityOf(installed), changesSha256: ref }],
  });
  return "recorded";
}


/**
 * The review process's side of a `matches.calls` tool: renders the subject from the tool's answer, then runs the after-read as a declared creation.
 * An answer that does not name the item records one gap row for the call (subject ""). An answer marked isError records nothing. Never throws.
 */
export async function afterCreateCall(req: Omit<AfterSnapshotRequest, "subject" | "before" | "beforeAbsent" | "declaredCreated"> & { tool: string; response: unknown }): Promise<AfterOutcome | "no-subject" | "error-answer"> {
  const { response, ...rest } = req;
  if (answerIsError(response)) return "error-answer";
  const template = loadCallTemplates(req.home).get(req.tool);
  const subject = template === undefined ? undefined : renderCallSubject(template, response);
  if (subject === undefined) {
    try {
      const taskId = await afterTaskOf(req.ledger, req.home, req.client, "").catch(() => null);
      req.ledger.recordCaptureOutcome({ taskId, client: req.client, call: req.call, subject: "", outcome: "error", reason: NO_SUBJECT_REASON });
    } catch {
      // the ledger is unwritable
    }
    return "no-subject";
  }
  return afterSnapshot({ ...rest, subject, before: null, declaredCreated: true });
}
