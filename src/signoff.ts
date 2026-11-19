import { sha256OfSealed } from "./seal.ts";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SOFT_SIGNATURE, SOFT_SIGNOFF_LABEL } from "./ledger.ts";
import type { LeftOutFile, Ledger, RecordSignoffInput, SignedFile, SignoffRow } from "./ledger.ts";
import { awaitingItemCount, itemStates, lowPriorityCount, needsReviewer, openItemCount } from "./items.ts";
import { normalizePathForCompare } from "./paths.ts";
import { isWatchedFolderFile, MAX_FOLDER_BYTES } from "./formats/files/scan.ts";
import { readFolderMarker, stripHookSession } from "./tasks.ts";
import { pruneCopies, withTaskLocks } from "./copies.ts";
import { newestEventAt, sessionCoverageLines } from "./coverage.ts";
import { sha256Stream } from "./fingerprint.ts";

/**
 * Sign-off: a named person's statement that a task's reviewed files are done. A human act only:
 * it exists only on the review page (the rail's Submit, a soft sign-off), never as an MCP tool or a CLI verb.
 *
 * Allowed when no item of the task is open (no unanswered rejection, no unresolved unlogged
 * change, in any round), whether or not the agent's latest submit was final: the sign-off closes
 * the task itself, so no extra "final" round trip is needed. It records that it did (`closedTask`),
 * which makes the latest round count as final without rewriting it. No open item of the same
 * client on any other task concerns one of the task's files, and every file is on disk exactly as
 * the latest round's snapshot captured it. The record keeps the signer, the time, the round count,
 * the rejections per round, the SHA-256 of every file as it is on disk, and every file of the task
 * (or its watched folder) it didn't hash, with why.
 */

/** Stable error codes for a refused sign-off. */
export const SIGNOFF_NOT_READY = "SIGNOFF_NOT_READY";
export const SIGNOFF_FILES_CHANGED = "SIGNOFF_FILES_CHANGED";
export const ALREADY_SIGNED_OFF = "ALREADY_SIGNED_OFF";
const SIGNER_REQUIRED = "SIGNER_REQUIRED";
export const SIGNOFF_BUSY = "SIGNOFF_BUSY";

export class SignoffError extends Error {
  readonly code: typeof SIGNOFF_NOT_READY | typeof SIGNOFF_FILES_CHANGED | typeof ALREADY_SIGNED_OFF | typeof SIGNER_REQUIRED | typeof SIGNOFF_BUSY;

  constructor(code: SignoffError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Max signer-name length kept. */
const MAX_SIGNER_CHARS = 200;

/** Max left-out files listed one by one in a record; the rest are counted in one entry. */
const MAX_LEFT_OUT = 500;

/** Max folders named by the "and N more" summary entry. */
const MAX_SUMMARY_FOLDERS = 50;

interface SignoffStatus {
  /** The latest sign-off of the task's latest round, if any. */
  record?: SignoffRow;
  /** Set when an item of the task opened again after `record` (a rejection after sign-off). */
  reopened?: boolean;
  /**
   * Why the task can't be signed off yet, in plain words; empty when it can (or already is).
   * From the ledger only: the files-on-disk check runs when someone actually signs.
   */
  blockers: string[];
}

/**
 * The sign-off that stands for `taskId`'s latest round, and whether an item of the task is open
 * again since (a rejection after sign-off). The one place "reopened" is decided.
 */
function standingSignoff(ledger: Ledger, taskId: number): { record?: SignoffRow; open: number; awaiting: number; reopened: boolean } {
  const latest = ledger.roundsForTask(taskId).at(-1);
  const open = openItemCount(ledger, taskId);
  const awaiting = awaitingItemCount(ledger, taskId);
  const record = latest ? ledger.signoffsForTask(taskId).findLast((s) => s.rounds === latest.seq) : undefined;
  return { record, open, awaiting, reopened: !!record && (open > 0 || awaiting > 0) };
}

/**
 * How `taskId` is closed right now, if it is: signed off (the latest round's sign-off stands and
 * no item is open again) or expired. A task reopened by a rejection after sign-off is not closed
 * until it is signed or expires again, so `ts` is always the latest close. The one definition that
 * `signoffStatus`, the sweep and `TaskStore.#isOpen` share.
 */
export function closureOf(ledger: Ledger, taskId: number): { kind: "signed" | "expired"; ts: string } | undefined {
  const expired = ledger.closureForTask(taskId);
  const { record, reopened } = standingSignoff(ledger, taskId);
  // A task reopened and then resolved without a new round is closed again under its original
  // sign-off, from the moment it was last worked on; one never reopened keeps the sign-off time.
  // Expiry is terminal: only a sign-off recorded after it can close the task as signed again.
  // A soft sign-off records the submission but does not close the task: nothing is pruned or expired on the strength of an unverified signature.
  const signed = record && !reopened && record.signature !== SOFT_SIGNATURE ? { kind: "signed" as const, ts: ledger.reopenedWorkSince(taskId, record.ts) ?? record.ts } : undefined;
  if (record && !reopened && expired && Date.parse(expired.ts) > Date.parse(record.ts)) return { kind: "expired", ts: expired.ts };
  return signed ?? (expired ? { kind: "expired", ts: expired.ts } : undefined);
}

/** Whether `taskId` can be signed off now, judged from the ledger alone. */
export function signoffStatus(ledger: Ledger, taskId: number): SignoffStatus {
  if (ledger.roundsForTask(taskId).length === 0) {
    return { blockers: ["Nothing has been submitted for review yet."] };
  }
  const { record, open, awaiting, reopened } = standingSignoff(ledger, taskId);
  if (record) {
    const blockers = [...(open > 0 ? [openText(open)] : []), ...(awaiting > 0 ? [awaitingText(awaiting)] : [])];
    return reopened ? { record, reopened: true, blockers } : { record, blockers: [] };
  }
  const blockers: string[] = [];
  if (open > 0) {
    blockers.push(openText(open));
  }
  if (awaiting > 0) {
    blockers.push(awaitingText(awaiting));
  }
  const low = lowPriorityCount(ledger, taskId);
  if (low > 0) {
    blockers.push(`${low.toLocaleString("en-US")} low-priority ${low === 1 ? "change needs" : "changes need"} a decision.`);
  }
  for (const b of elsewhereBlockers(ledger, taskId)) blockers.push(b);
  return { blockers };
}

function awaitingText(awaiting: number): string {
  return `${awaiting.toLocaleString("en-US")} awaiting your confirmation.`;
}

function openText(open: number): string {
  return `${open.toLocaleString("en-US")} ${open === 1 ? "item still needs" : "items still need"} a decision.`;
}

/**
 * A file can't be signed off while it has an open question anywhere: one blocker per other task of
 * the same client (or, for hook tasks, the same folder, whatever the session) with open items on files of `taskId`.
 */
function elsewhereBlockers(ledger: Ledger, taskId: number): string[] {
  const client = ledger.taskClient(taskId);
  if (client == null) {
    return [];
  }
  const files = new Set(ledger.snapshotsForTask(taskId).map((s) => s.filePath));
  const blockers: string[] = [];
  for (const other of ledger.tasksForFamily(stripHookSession(client))) {
    if (other === taskId) continue;
    const onFiles = itemStates(ledger, other).filter((s) => needsReviewer(s) && files.has(s.row.filePath));
    if (onFiles.length === 0) continue;
    const paths = [...new Set(onFiles.map((s) => s.row.filePath))].join(", ");
    blockers.push(
      `Task ${other} has ${onFiles.length.toLocaleString("en-US")} open ${onFiles.length === 1 ? "item" : "items"} on ${paths}; ` +
        "a file can't be signed off while it has an open question anywhere.",
    );
  }
  return blockers;
}

/** The record a sign-off of `taskId` would append, minus the signature. */
export function signoffInput(ledger: Ledger, taskId: number, who: string, seq: number, files: SignedFile[], leftOut: LeftOutFile[]): RecordSignoffInput {
  const rounds = ledger.roundsForTask(taskId);
  const rejectionsByRound = new Map(rounds.map((r) => [r.seq, 0]));
  const roundOfRow = new Map(ledger.reviewRowsForTask(taskId).map((r) => [r.id, r.roundSeq]));
  for (const d of ledger.decisionsForTask(taskId)) {
    const round = roundOfRow.get(d.rowId);
    if (d.decision === "reject" && round !== undefined) {
      rejectionsByRound.set(round, (rejectionsByRound.get(round) ?? 0) + 1);
    }
  }
  const rejections = [...rejectionsByRound].map(([round, n]) => ({ round, rejections: n }));
  return { taskId, signer: who, rounds: seq, rejections, files, leftOut, closedTask: !rounds.at(-1)!.final };
}

/**
 * Every check a sign-off makes before its write, and what it would record: the signer name, the
 * latest round, the hashed files and the left-out files. Writes nothing. Throws a `SignoffError` on refusal.
 */
export async function collectSignoff(ledger: Ledger, taskId: number, signer: string): Promise<{ who: string; seq: number; files: SignedFile[]; leftOut: LeftOutFile[] }> {
  const who = signer.trim().slice(0, MAX_SIGNER_CHARS);
  if (!who) {
    throw new SignoffError(SIGNER_REQUIRED, "Sign-off needs the signer's name.");
  }
  refuseUnlessReady(taskId, signoffStatus(ledger, taskId));
  const seq = ledger.roundsForTask(taskId).at(-1)!.seq;
  const files: SignedFile[] = [];
  const changed: string[] = [];
  const deleted: LeftOutFile[] = [];
  const latest = ledger.snapshotsForTask(taskId).filter((s) => s.round === seq);
  const untouched = await untouchedWatchedFiles(ledger, taskId);
  const untouchedLatest: string[] = [];
  const unverified: string[] = [];
  for (const snap of latest) {
    const onDisk = existsSync(snap.filePath);
    if (snap.mode === "missing") {
      // Deleted in review: there is nothing to hash, and it must still be gone.
      if (onDisk) {
        changed.push(`${snap.filePath} was deleted when the agent submitted, and is back on disk now.`);
      }
      deleted.push({ path: snap.filePath, reason: "deleted in review", deleted: true });
      continue;
    }
    if (!onDisk) {
      changed.push(`${snap.filePath} is no longer on disk.`);
      continue;
    }
    const sha256 = await sha256Stream(snap.filePath);
    // The hash taken with the snapshot; a row from before it was stored falls back to hashing the copy.
    // A fingerprint-only snapshot stored the file's SHA-256.
    const signed = snap.mode === "fingerprint" ? snap.sha256 ?? undefined : snap.sha256 ?? (existsSync(snap.snapshotPath) ? await sha256OfSealed(snap.snapshotPath) : undefined);
    if (signed === undefined) {
      // A row whose copy is gone: its state at the last submit is unknown, so it is neither signed nor called changed.
      unverified.push(snap.filePath);
      continue;
    }
    if (signed !== sha256) {
      changed.push(`${snap.filePath} changed after the agent's last submit.`);
      continue;
    }
    if (untouched.has(snap.filePath)) {
      untouchedLatest.push(snap.filePath);
      continue;
    }
    files.push({ path: snap.filePath, sha256 });
  }
  if (changed.length > 0) {
    throw new SignoffError(
      SIGNOFF_FILES_CHANGED,
      `Task ${taskId} can't be signed off: ${changed.join(" ")} What you reviewed isn't what's on disk; ask the agent to submit again so the change is reviewed.`,
    );
  }
  const leftOut = [...deleted, ...unverified.map((p): LeftOutFile => ({ path: p, reason: "its state at the agent's last submit was not recorded (the copy is gone), so it could not be checked and is not signed." })), ...leftOutFiles(ledger, taskId, new Set(latest.map((s) => s.filePath).filter((p) => !untouchedLatest.includes(p))), untouchedLatest)];

  return { who, seq, files, leftOut };
}

/** Deletes every file copy of a signed-off task, logging rather than failing. */
export async function pruneSignedCopies(ledger: Ledger, taskId: number): Promise<void> {
  try {
    const prune = () => pruneCopies(ledger, taskId, "closed");
    await (ledger.home ? withTaskLocks(ledger.home, [taskId], prune) : prune());
  } catch (error) {
    console.error(`cocheck: could not delete the file copies of signed-off task ${taskId}`, error);
  }
}

/** SQLite's "database is locked" (SQLITE_BUSY, code 5) after the busy timeout ran out. */
export function isBusy(error: unknown): boolean {
  const e = error as { errcode?: number; message?: string };
  return e?.errcode === 5 || e?.errcode === 6 || /database (table )?is locked/i.test(e?.message ?? "");
}

export function refuseUnlessReady(taskId: number, status: SignoffStatus): void {
  if (status.record) {
    const r = status.record;
    throw new SignoffError(ALREADY_SIGNED_OFF, `Task ${taskId} was already signed off by ${r.signer} on ${formatLocalTime(r.ts)}.`);
  }
  if (status.blockers.length > 0) {
    throw new SignoffError(SIGNOFF_NOT_READY, `Task ${taskId} can't be signed off yet: ${status.blockers.join(" ")}`);
  }
}

/**
 * Every file of `taskId` the sign-off doesn't hash, with why: a file an earlier round held that
 * the latest round didn't capture, and every file in the task's watched folder the latest round
 * doesn't hold (a scratch file, one over the size cap, a folder over its caps, or a file added
 * after the last submit).
 */
function leftOutFiles(ledger: Ledger, taskId: number, latest: Set<string>, untouched: string[]): LeftOutFile[] {
  const out: LeftOutFile[] = [];
  const seen = new Set(latest);
  const add = (p: string, reason: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push({ path: p, reason });
    }
  };
  for (const p of untouched) {
    add(p, "not touched by this task: only the folder watch held it, and it has no change, logged operation or review row here.");
  }
  for (const s of ledger.snapshotsForTask(taskId)) {
    add(s.filePath, "only the folder watch held it, and it was not captured at the agent's last submit, so its latest state was never reviewed.");
  }
  const marker = ledger.home ? readFolderMarker(ledger.home, taskId) : {};
  if (marker.dir) {
    let names: string[] = [];
    try {
      names = readdirSync(marker.dir).sort();
    } catch {
      // the folder is gone: nothing in it to leave out
    }
    for (const name of names) {
      const full = path.join(marker.dir, name).normalize("NFC");
      if (seen.has(full)) continue;
      let size: number;
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      if (!isWatchedFolderFile(full)) {
        add(full, name.endsWith(".cocheck-review.html") ? "CoCheck's own review export; the folder watch ignores it." : "an editor scratch file; the folder watch ignores these.");
      } else if (marker.skipped) {
        add(full, marker.skipped);
      } else if (size > MAX_FOLDER_BYTES) {
        add(full, `it is ${mb(size)} (limit ${mb(MAX_FOLDER_BYTES)} per file); changes to it were not watched.`);
      } else {
        add(full, "added to the folder after the agent's last submit, so it was never reviewed.");
      }
    }
  }
  if (out.length > MAX_LEFT_OUT) {
    const more = out.length - MAX_LEFT_OUT;
    const folders = [...new Set(out.slice(MAX_LEFT_OUT).map((l) => path.dirname(l.path)))].slice(0, MAX_SUMMARY_FOLDERS);
    return [
      ...out.slice(0, MAX_LEFT_OUT),
      { path: marker.dir ?? "", reason: `and ${more.toLocaleString("en-US")} more files left out, not listed.`, count: more, folders },
    ];
  }
  return out;
}

/**
 * The files the folder watch baselined that the task never touched: no CoCheck call (the marker
 * still lists them as folder-only, so no logged op), no review row in any round, and the same
 * bytes in every snapshot. Anything else, an unlogged hand edit included, is the task's file.
 */
async function untouchedWatchedFiles(ledger: Ledger, taskId: number): Promise<Set<string>> {
  const folderOnly = ledger.home ? (readFolderMarker(ledger.home, taskId).folderOnly ?? []) : [];
  const untouched = new Set<string>();
  if (folderOnly.length === 0) {
    return untouched;
  }
  const withRows = new Set(ledger.reviewRowsForTask(taskId).map((r) => r.filePath));
  const snapshots = ledger.snapshotsForTask(taskId);
  for (const file of folderOnly) {
    if (withRows.has(file)) continue;
    const mine = snapshots.filter((s) => s.filePath === file);
    if (mine.length === 0) continue;
    const hashes = new Set<string>();
    let unreadable = false;
    for (const s of mine) {
      if (s.mode === "missing") {
        unreadable = true;
        break;
      }
      // A row with neither hash nor copy says nothing either way; the file has no review row, so it is untouched unless another snapshot shows otherwise.
      const hash = s.sha256 ?? (existsSync(s.snapshotPath) ? await sha256OfSealed(s.snapshotPath) : undefined);
      if (hash !== undefined) hashes.add(hash);
    }
    if (!unreadable && hashes.size <= 1) {
      untouched.add(file);
    }
  }
  return untouched;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1048576)} MB`;
}

/** How many files a record left out: the listed ones plus those the "and N more" entry stands for; deletions aren't left out. */
function leftOutCount(record: SignoffRow): number {
  return (record.leftOut ?? []).reduce((n, l) => n + (l.deleted ? 0 : (l.count ?? 1)), 0);
}

/** The files a record shows as deleted in review. */
function deletedFiles(record: SignoffRow): string[] {
  return (record.leftOut ?? []).filter((l) => l.deleted).map((l) => l.path);
}

/** Plain-words coverage of a record: "hashed 2 files, left out 1: ..." lines for the CLI and verify. */
/** `sessions`: the hook sessions' reconciliation lines (sessionCoverageLines), appended after the file coverage. */
export function coverageLines(record: SignoffRow, sessions: string[] = []): string[] {
  return [...fileCoverageLines(record), ...sessions];
}

function fileCoverageLines(record: SignoffRow): string[] {
  const hashed = `hashed ${record.files.length.toLocaleString("en-US")} ${record.files.length === 1 ? "file" : "files"}`;
  if (record.leftOut === null) {
    return [`${hashed}; which files it left out wasn't recorded (signed before coverage was kept).`];
  }
  const deleted = deletedFiles(record);
  const deletedLines = deleted.map((p) => `deleted in review: ${p}`);
  const n = leftOutCount(record);
  if (n === 0) {
    return [`${hashed}, left out none${deleted.length ? `, deleted ${deleted.length.toLocaleString("en-US")}` : ""}.`, ...deletedLines];
  }
  return [
    `${hashed}, left out ${n.toLocaleString("en-US")}${deleted.length ? `, deleted ${deleted.length.toLocaleString("en-US")}` : ""}:`,
    ...deletedLines,
    ...record.leftOut.filter((l) => !l.deleted).map((l) => `left out: ${l.path} (${l.reason})`),
  ];
}

interface VerifyResult {
  /** True when some sign-off recorded exactly these bytes. */
  match: boolean;
  message: string;
}

/**
 * Whether the file at `filePath` is, byte for byte, a file someone signed off. One of: signed off
 * (a SHA-256 match, so a signed-off file copied or sent elsewhere still verifies), changed since
 * a sign-off recorded this same path, left out of a sign-off (with why), or never part of one.
 */
export async function verifyFile(ledger: Ledger, filePath: string): Promise<VerifyResult> {
  const key = normalizePathForCompare(filePath);
  const sha256 = await sha256Stream(key);
  const candidates = ledger.signoffsForFile(key, sha256);
  const byHash = candidates.filter((s) => s.files.some((f) => f.sha256 === sha256));
  const hit = byHash.find((s) => s.files.some((f) => f.sha256 === sha256 && f.path === key)) ?? byHash.at(-1);
  if (hit) {
    const signed = hit.files.find((f) => f.sha256 === sha256 && f.path === key) ?? hit.files.find((f) => f.sha256 === sha256)!;
    const as = signed.path === key ? "" : ` (as ${signed.path})`;
    const sessions = ledger.sessionIdsForTask(hit.taskId);
    const rows = new Map(sessions.flatMap((sid) => { const r = ledger.sessionCoverage(sid); return r === null ? [] : [[sid, r] as const]; }));
    const coverage = [...(hit.leftOut?.length === 0 ? [] : fileCoverageLines(hit)), ...sessionCoverageLines(sessions, rows, new Map(ledger.home === undefined ? [] : sessions.map((sid) => [sid, newestEventAt(ledger.home!, sid)] as const)))].map((l) => `  ${l}`);
    if (hit.signature === SOFT_SIGNATURE) {
      // A soft sign-off is not a verified one: the bytes match a submission, but verify does not answer "signed off" (exit 1).
      return { match: false, message: [`${SOFT_SIGNOFF_LABEL}: submitted by ${hit.signer} on ${formatLocalTime(hit.ts)} in task ${hit.taskId}${as}`, ...coverage].join("\n") };
    }
    return {
      match: true,
      message: [`signed off by ${hit.signer} on ${formatLocalTime(hit.ts)} in task ${hit.taskId}${as}`, ...coverage].join("\n"),
    };
  }
  const samePath = candidates.findLast((s) => s.files.some((f) => f.path === key));
  if (samePath) {
    return { match: false, message: `changed since ${samePath.signer} signed it off on ${formatLocalTime(samePath.ts)} in task ${samePath.taskId}` };
  }
  const leftOutOf = candidates.findLast((s) => s.leftOut?.some((l) => l.path === key && !l.deleted));
  if (leftOutOf) {
    const reason = leftOutOf.leftOut!.find((l) => l.path === key && !l.deleted)!.reason;
    return { match: false, message: `left out of ${leftOutOf.signer}'s sign-off on ${formatLocalTime(leftOutOf.ts)}: ${reason}` };
  }
  const dir = path.dirname(key);
  const inSummary = candidates.findLast((s) => s.leftOut?.some((l) => l.count !== undefined && l.folders?.includes(dir)));
  if (inSummary) {
    return { match: false, message: `left out of ${inSummary.signer}'s sign-off on ${formatLocalTime(inSummary.ts)} (not individually listed): it is in ${dir}, where more files were left out than the record lists.` };
  }
  return { match: false, message: "never part of a sign-off" };
}

/** An ISO timestamp as the host's local time in words, e.g. "29 Sep 2026, 00:10 EDT". */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} ${part("timeZoneName")}`;
}

