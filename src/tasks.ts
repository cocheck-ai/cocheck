import { removeFrozen } from "./connector/frozen.ts";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { scanFolder } from "./formats/files/scan.ts";
import { chmod, readFile, rm } from "node:fs/promises";
import { isKeyMissing, sealLayer, sha256OfSealed, writeSealed } from "./seal.ts";
import type { Ledger, RecordReviewRowInput, RecordSnapshotInput, SnapshotRow } from "./ledger.ts";
import { CLAIMED_LAYER } from "./connector/claimed.ts";
import { SnapshotRefusal, type FormatLayer, type SnapshotMode } from "./formats/layer.ts";
import { normalizePathForCompare, pathKit } from "./paths.ts";
import { itemStates, openItemCount, requestStates } from "./items.ts";
import { pruneCopies, withTaskLocks } from "./copies.ts";
import { changedOutsideWording, outsideClass, sha256Stream } from "./fingerprint.ts";
import { hardenHomeAndSay } from "./home-perms.ts";
import { closureOf, signoffStatus } from "./signoff.ts";
import { removeRegions } from "./states.ts";
import { isSecretPath, secretLine } from "./secret-files.ts";
import { secretRuleInBytes } from "./secret-scan.ts";
import { removeDeliveryCopies } from "./region-delivery.ts";

/** A task with no agent or reviewer activity for this long is closed as expired, not signed off. */
const TASK_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** A task closed (signed off or expired) this long ago has its ledger values removed. */
/** How often a running process sweeps. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const VALUES_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Stable error code: a submit was called by a client with no open task. */
export const NO_OPEN_TASK = "NO_OPEN_TASK";
/** Stable error code: a file couldn't be snapshotted, so the call touching it didn't run. */
const SNAPSHOT_FAILED = "SNAPSHOT_FAILED";
/**
 * How long a task may sit with no agent activity (no logged CoCheck op, a submit included)
 * before the next file touch opens a new task on the folder instead of joining it.
 */
export const TASK_IDLE_ROLLOVER_MS = 4 * 60 * 60 * 1000;

/** Error code for a submit that lost its round number to another process on every retry; the agent just submits again. */
export const SEQ_COLLISION = "SEQ_COLLISION";

export class TaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

interface SubmitRowSummary {
  id: number;
  file: string;
  location: string;
  kind: string;
  status: RecordReviewRowInput["status"];
  description: string;
  ops: ExplainingOp[];
  /** For an `unlogged` row: the CoCheck op that last wrote this location, overwritten since. */
  overwroteOp?: ExplainingOp;
}

export interface ExplainingOp {
  opId: number;
  tool: string;
  intent: string;
  client: string | null;
  /** Hook-adapter ops only: the host's `tool_use_id` and how the call closed (post, failure, stop, expiry, ghost-post). */
  callId?: string;
  closedBy?: string;
  /** Hook-adapter ops only: the host's own description of the call, when the adapter recorded it. */
  description?: string;
  /** Hook-adapter ops only: the call's narration or its turn's request, shown as the reason when there is no description. */
  reasonFallback?: string;
  /** Hook-adapter ops only: whether the call was a run_in_background one, and when it opened and closed (epoch ms; no open time for a Post whose Pre was never seen). */
  background?: boolean;
  openedAt?: number;
  closedAt?: number;
  /** Hook-adapter ops only: the op's workbook is outside the watched folder (outside watching). */
  outsideFolder?: boolean;
}

interface Counts {
  rows: number;
  explained: number;
  derived: number;
  unlogged: number;
}

export interface SubmitSummary {
  taskId: number;
  round: number;
  final: boolean;
  totals: Counts;
  files: Array<Counts & { path: string; layer: string; snapshotMode: SnapshotMode }>;
  rows: SubmitRowSummary[];
  /** Present when `rows` was capped at `MAX_SUMMARY_ROWS`; the full set is in the ledger. */
  rowsOmitted?: number;
  /** Open review items on the task after this round, carried-forward ones included. */
  openItems: number;
  /** Plain-language notes, e.g. the task's folder was too big to watch. Also recorded on the round. */
  notes?: string[];
}

/**
 * `tasks/<id>/folder.json`: the folder a task watches, or why it doesn't. `folderOnly` lists the
 * files the watch baselined (at open, or as newcomers at a submit) that no CoCheck call has
 * touched since; they're kept as a fingerprint only, never a copy, and a task checks them only
 * while it's the client's current task. `changedBeforeTouch` lists files whose fingerprint had moved
 * when a CoCheck call first touched them: the next round shows one fingerprint-only row for each.
 * `warned` is set once the agent has been told the watch is off. `notes` are files the open-time scan left out one by one.
 */
interface FolderMarker {
  dir?: string;
  skipped?: string;
  notes?: string[];
  folderOnly?: string[];
  changedBeforeTouch?: string[];
  warned?: boolean;
}

/**
 * A submit's result: the round cut on the most recent of the client's open tasks, plus, when the
 * client had more than one open (a reopened older task next to its current one), `otherTasks`
 * with the rounds cut on the older ones, oldest first.
 */
type SubmitResult = SubmitSummary & { otherTasks?: SubmitSummary[] };

/** A round diffed and ready to record: nothing is written to the ledger until `record` runs. */
interface PreparedRound {
  rowCount: number;
  noteCount: number;
  record: () => SubmitSummary;
  /** Deletes the snapshot files the round took, when it is not recorded. */
  discard: () => Promise<void>;
}

/** Max review rows echoed back in a submit summary; the ledger always gets all of them. */
const MAX_SUMMARY_ROWS = 200;

/**
 * Task lifecycle for the review loop.
 *
 * Tasks are scoped to the MCP client, keyed by the `clientInfo.name` the client sent at initialize
 * (`""` when absent). Finer keys (client + file set) buy nothing for a single-user local gateway.
 * Task state is read from the ledger, never held in memory, so a restarted gateway (the user
 * coming back later in a new chat) picks up where the client left off, and two gateway processes
 * serving the same client name share its tasks.
 *
 * A task is open while its latest round isn't `final` (or it has no round yet), or once a
 * reviewer rejects one of its rows after its final round: a send-back reopens the task until its
 * next final submit. So a client can have more than one open task: a reopened older task next to
 * the one it's working in now.
 *
 * A call that touches a file joins, in order of preference:
 *
 * - the oldest open task that already holds the file, so a fix lands in the task under review;
 * - else the client's latest task, while it has no final round (its current task);
 * - else a new task.
 *
 * So a task reopened by a rejection takes back only its own files; any other file opens (or
 * joins) a newer task. A file a task holds only because its folder watch baselined it doesn't
 * count as the task's own once the task is no longer current.
 *
 * The folder watch belongs to the current task alone: a reopened older task diffs only the files
 * it touched through CoCheck, and never scans its folder for newcomers, so a hand edit or a new
 * file lands once, on the task being worked in now.
 *
 * Idle rollover: a task with no agent activity for `TASK_IDLE_ROLLOVER_MS` is rolled over by the
 * next call that touches a file: that call opens a new task with a fresh baseline taken then, so
 * nothing that changed while idle is attributed to the new task's agent. First the old task gets
 * a closing round, which picks up whatever changed outside CoCheck meanwhile as unlogged rows; it
 * keeps its rows, is no longer cut again, and is reviewed and signed off as it stands. Outside
 * changes are not activity: they never keep a task alive. A task with a reviewer's rejection or
 * request still open never rolls over, so the fix lands in the task under review.
 *
 * A submit cuts a round on every open task of the client, the reopened ones included, so
 * a fix on an older task goes back to review with the current work. A non-final submit leaves each
 * task open for round N+1. A `final` submit closes each task (only tests pass `final`: the Stop hook always submits non-final).
 *
 * Snapshots live at `<root>/tasks/<taskId>/round-<n>/<k>-<basename>`: round 0 is each file's
 * baseline, taken on its first touch in the task (before the touching call runs); round N is
 * taken by the Nth submit. `k` is the file's index within the task, which keeps two same-named
 * files apart.
 */
type SettleArgs = readonly [number, string, string, boolean, number, boolean, Set<string>];

/** How many times a submit re-prepares and re-records after losing a round number before it gives up. */
const MAX_SEQ_COLLISION_RETRIES = 3;

/** Whether `error` is SQLite refusing a second round with the same (task, seq). */
function isSeqCollision(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: rounds\.task_id, rounds\.seq/.test(error.message);
}

export class TaskStore {
  readonly #ledger: Ledger;
  readonly #root: string;
  readonly #layers: FormatLayer[];
  readonly #now: () => number;

  /** `now` is the clock, in epoch ms; tests inject one to move past the idle threshold. */
  constructor(ledger: Ledger, root: string, layers: FormatLayer[], now: () => number = Date.now) {
    this.#ledger = ledger;
    this.#root = root;
    this.#layers = layers.map(sealLayer);
    this.#now = now;
  }

  /** Whether a reviewer's rejection or request on `taskId` is still unanswered. */
  #awaitsFix(taskId: number): boolean {
    return (
      itemStates(this.#ledger, taskId).some((s) => s.openReason === "rejected") ||
      requestStates(this.#ledger, taskId).some((q) => q.open)
    );
  }

  /** Whether `taskId` has been idle for the rollover threshold as of now and so rolls over on the next touch. */
  #isIdleNow(taskId: number): boolean {
    if (this.#isFinal(taskId) || this.#awaitsFix(taskId)) {
      return false;
    }
    const now = this.#now();
    const last = this.#ledger.lastActivityTs(taskId, new Date(now).toISOString());
    return last !== undefined && now - Date.parse(last) >= TASK_IDLE_ROLLOVER_MS;
  }

  /** Whether `taskId` was rolled over: a later task of its client opened after it sat idle for the threshold. */
  #isRolledOver(taskId: number, client: string): boolean {
    const next = this.#ledger.tasksForClient(client).find((id) => id > taskId);
    const openedAt = next === undefined ? undefined : this.#ledger.taskCreatedAt(next);
    if (openedAt === undefined || this.#isFinal(taskId) || this.#awaitsFix(taskId)) {
      return false;
    }
    const last = this.#ledger.lastActivityTs(taskId, openedAt);
    return last !== undefined && Date.parse(openedAt) - Date.parse(last) >= TASK_IDLE_ROLLOVER_MS;
  }

  /** Cuts the closing round on a task about to be rolled over, so its files' state as of now is recorded on it. */
  async #closeOut(client: string, taskId: number): Promise<void> {
    if (this.#ledger.snapshotsForTask(taskId).length === 0) {
      return;
    }
    const ownedElsewhere = new Set([...this.openTaskIds(client).filter((id) => id !== taskId).flatMap((id) => [...this.#ownFiles(id)]), ...this.#sessionFiles(client)]);
    const args = [
      taskId,
      client,
      "Closing round: the task was idle, and the next file touch opened a new task",
      false,
      this.#ledger.maxOpId(),
      true,
      ownedElsewhere,
    ] as const;
    await this.#settleRound(await this.#prepareRound(...args), args);
  }

  /** Files other sessions' open tasks in the same folder hold through CoCheck: those tasks' to report, as a task of the same client's is. */
  #sessionFiles(client: string): Set<string> {
    const out = new Set<string>();
    for (const id of this.#ledger.tasksForFamily(stripHookSession(client))) {
      if (this.#ledger.taskClient(id) === client || !this.#isOpen(id)) continue;
      for (const f of this.#ownFiles(id)) out.add(f);
    }
    return out;
  }

  /**
   * The layer a stored snapshot is read with: the one of that name, else the claimed layer when this store holds it (from the
   * hook, `snapshots.layer` is opaque, so a row an older hook wrote under a format name is read as a claimed file).
   */
  #layerNamed(name: string): FormatLayer | undefined {
    return this.#layers.find((l) => l.name === name) ?? this.#layers.find((l) => l.name === CLAIMED_LAYER);
  }

  /** `client`'s current task: its latest task while that has no final round, else undefined. */
  currentTaskId(client: string): number | undefined {
    const taskId = this.#ledger.latestTaskForClient(client);
    if (taskId === undefined || this.#isFinal(taskId)) {
      return undefined;
    }
    return taskId;
  }

  /** `client`'s open tasks, oldest first. */
  openTaskIds(client: string): number[] {
    return this.#ledger.maybeOpenTasksForClient(client).filter((taskId) => this.#isOpen(taskId) && !this.#isRolledOver(taskId, client));
  }

  /** Whether the task's latest round is final, by the agent's submit or by a sign-off that closed it. */
  #isFinal(taskId: number): boolean {
    if (this.#ledger.closureForTask(taskId)) return true;
    const last = this.#ledger.roundsForTask(taskId).at(-1);
    return !!last && (last.final || this.#ledger.signoffsForTask(taskId).some((s) => s.closedTask && s.rounds === last.seq));
  }

  #isOpen(taskId: number): boolean {
    if (closureOf(this.#ledger, taskId)) return false;
    const last = this.#ledger.roundsForTask(taskId).at(-1);
    if (!last || !this.#isFinal(taskId)) {
      return true;
    }
    // A rejection stamped with a higher op watermark than the final round was made after it. At
    // the same watermark (no op logged in between) it still was if it's unanswered, since a final
    // round is only recorded with no rejection open, or if it's stamped later than the round.
    const rejected = itemStates(this.#ledger, taskId).some((s) => {
      const d = s.decision;
      if (d?.decision !== "reject" || d.afterOpId < last.lastOpId) {
        return false;
      }
      return d.afterOpId > last.lastOpId || s.openReason === "rejected" || d.ts > last.ts;
    });
    // A task-level request is treated the same way: filed after the final round, or still unanswered.
    // A reviewer's rejection of the agent's answer reopens it like a row rejection: the task stays
    // open until a round is cut after the verdict (the fix, its resolve and the submit all log ops).
    const openRequests = new Set(requestStates(this.#ledger, taskId).filter((q) => q.open).map((q) => q.request.id));
    const rejectedAnswer = this.#ledger.requestConfirmationsForTask(taskId).some((c) => {
      if (c.verdict !== "reject" || c.afterOpId < last.lastOpId) {
        return false;
      }
      return c.afterOpId > last.lastOpId || openRequests.has(c.requestId) || c.ts > last.ts;
    });
    return (
      rejected ||
      rejectedAnswer ||
      requestStates(this.#ledger, taskId).some(
        ({ request: q, open }) => q.afterOpId >= last.lastOpId && (q.afterOpId > last.lastOpId || open || q.ts > last.ts),
      )
    );
  }

  #openItemCount(taskId: number): number {
    return openItemCount(this.#ledger, taskId);
  }

  /**
   * Joins the task `filePath` belongs to (see the class comment), opening one if needed, and, if
   * the file is new to the task, takes its baseline snapshot. Returns the task id. Throws a `TaskError` if the snapshot fails
   * (`SNAPSHOT_FAILED`) or the layer refuses it (the refusal's own code, e.g.
   * `UNSAVED_CHANGES_OPEN`); the task stays open but the file isn't recorded as joined, so the
   * next touch retries it.
   */
  async touch(client: string, filePath: string, baseline?: TouchBaseline): Promise<number> {
    // The earliest point after a reopen that the agent's own write can't have happened yet: every write goes through a touch first.
    for (const id of this.openTaskIds(client)) await this.#rebuildBaseline(id);
    const taskId = await this.#touch(client, filePath, baseline);
    this.#ledger.recordActivity(taskId, "agent", new Date(this.#now()));
    return taskId;
  }

  async #touch(client: string, filePath: string, baseline?: TouchBaseline): Promise<number> {
    const key = normalizePathForCompare(filePath);
    const latest = this.#ledger.latestTaskForClient(client);
    const idle = latest !== undefined && this.#isIdleNow(latest) ? latest : undefined;
    const current = idle === undefined ? this.currentTaskId(client) : undefined;
    const holder = this.openTaskIds(client).find(
      (id) =>
        id !== idle &&
        this.#ledger.snapshotsForTask(id).some((s) => s.filePath === key) &&
        (id === current || !this.#readMarker(id).folderOnly?.includes(key)),
    );
    if (holder !== undefined) {
      await this.#baselineFromFingerprint(holder, key);
      this.#markTouched(holder, key);
      return holder;
    }
    if (idle !== undefined) {
      await this.#closeOut(client, idle);
    }
    const taskId = current ?? this.#ledger.openTask(client, new Date(this.#now()));
    const layer = this.#layers.find((l) => l.accepts(filePath));
    if (!layer) {
      return taskId;
    }
    const known = this.#ledger.snapshotsForTask(taskId);
    const index = new Set(known.map((s) => s.filePath)).size;
    const dest = this.#snapshotPath(taskId, 0, index, key);
    // A task opened after the file's first change takes its baseline from the state before that change (a plain copy of those bytes, or "missing" for a file the change created).
    if (baseline !== undefined && "missing" in baseline) {
      this.#ledger.recordSnapshot({ taskId, round: 0, filePath: key, layer: layer.name, snapshotPath: "", mode: "missing", sha256: null });
    } else {
      const source = baseline?.source ?? key;
      const mode = await this.#snapshot(layer, source, dest, key);
      this.#ledger.recordSnapshot({ taskId, round: 0, filePath: key, layer: layer.name, snapshotPath: mode === "fingerprint" ? "" : dest, mode, sha256: await this.#hash(dest, mode, source) });
    }
    if (known.length === 0) {
      // A hook task watches the folder it was started with (its client name), never the directory of whichever file came first.
      await this.#snapshotFolderAtOpen(taskId, hookFolderOf(client) ?? path.dirname(key));
    }
    return taskId;
  }

  /**
   * The first CoCheck touch of a file the watch only fingerprinted: its baseline is the copy taken now
   * (never earlier). A fingerprint that moved since the task opened is remembered, so the next round
   * shows one fingerprint-only row for it, and the copy then holds what the file is at this touch.
   */
  async #baselineFromFingerprint(taskId: number, key: string): Promise<void> {
    const prev = latestPerFile(this.#ledger.snapshotsForTask(taskId)).find((s) => s.filePath === key);
    if (!prev || prev.mode !== "fingerprint") return;
    const layer = this.#layerNamed(prev.layer);
    if (!layer) return;
    const rounds = this.#ledger.roundsForTask(taskId);
    const round = rounds.at(-1)?.seq ?? 0;
    const index = new Set(this.#ledger.snapshotsForTask(taskId).map((s) => s.filePath)).size;
    const dest = this.#snapshotPath(taskId, round, index, `${process.pid}-${process.hrtime.bigint()}-${path.basename(key)}`);
    const moved = !(await sameAsStored(key, prev.sha256));
    const mode = await this.#snapshot(layer, key, dest);
    this.#ledger.recordSnapshot({ taskId, round, filePath: key, layer: layer.name, snapshotPath: mode === "fingerprint" ? "" : dest, mode, sha256: await this.#hash(dest, mode, key) });
    if (moved) {
      const marker = this.#readMarker(taskId);
      this.#writeMarker(taskId, { ...marker, changedBeforeTouch: [...new Set([...(marker.changedBeforeTouch ?? []), key])] });
    }
  }

  /**
   * The plain warning the agent's first call gets when the folder watch is off for this task (folder
   * too big, or unreadable): once per task, then undefined. A call that finds the watch on gets nothing.
   */
  takeWatchWarning(taskId: number): string | undefined {
    const marker = this.#readMarker(taskId);
    if (!marker.skipped || marker.warned) return undefined;
    this.#writeMarker(taskId, { ...marker, warned: true });
    return `CoCheck is not watching this folder for changes outside CoCheck: ${marker.skipped}`;
  }

  /**
   * Cuts a round on every open task of `client` (see the class comment for which, and for what a
   * `final` submit does when a task has open items). Every task is snapshotted and diffed before
   * any round is recorded, so a snapshot failure records nothing.
   */
  async submit(client: string, intent: string, final: boolean): Promise<SubmitResult> {
    const taskIds = this.openTaskIds(client);
    if (taskIds.length === 0) {
      throw new TaskError(NO_OPEN_TASK, "no open task for this client; touch a file first.");
    }
    for (const id of taskIds) this.#ledger.recordActivity(id, "agent", new Date(this.#now()));
    // Held from the first snapshot to the prune: a reviewer's cut in another process reads the copies this round supersedes.
    const summaries = await withTaskLocks(this.#root, taskIds, async () => {
      const lastOpId = this.#ledger.maxOpId();
      const currentTaskId = this.currentTaskId(client);
      const own = new Map(taskIds.map((id) => [id, this.#ownFiles(id)]));
      const prepared: Array<() => Promise<SubmitSummary>> = [];
      for (const taskId of taskIds) {
        const sessionFiles = this.#sessionFiles(client);
        const ownedElsewhere = new Set([...taskIds.filter((id) => id !== taskId).flatMap((id) => [...own.get(id)!]), ...sessionFiles]);
        const args = [taskId, client, intent, final, lastOpId, taskId === currentTaskId, ownedElsewhere] as const;
        const round = await this.#prepareRound(...args);
        prepared.push(() => this.#settleRound(round, args));
      }
      const done: SubmitSummary[] = [];
      for (const record of prepared) {
        done.push(await record());
      }
      return done;
    });
    const current = summaries.at(-1)!;
    return summaries.length > 1 ? { ...current, otherTasks: summaries.slice(0, -1) } : current;
  }

  /**
   * Snapshots every file in `taskId` again, diffs each against its previous snapshot through its
   * layer, and classifies every row; returns the function that records the round. Rows are:
   *
   * - `explained` when the latest successful op logged in this task since the previous round that
   *   touched the row's location also explains it (the location holds what the op wrote);
   * - `unlogged` when that latest op doesn't explain it: something overwrote CoCheck's write, and
   *   the row names the op it overwrote (`detail.overwroteOp`);
   * - else `derived` when the layer marks it derivable, else `unlogged`.
   *
   * A derived row needs a visible cause: if a file's round has derived rows but no explained or
   * unlogged row, whatever moved them is something the layer can't see (a spreadsheet: a defined name or an
   * external link edited), so they're all `unlogged` with `detail.noVisibleCause`.
   *
   * A file whose new snapshot has the same bytes as its previous one is never handed to its layer:
   * it has no rows. A `wholeFile` row (e.g. a workbook too large to compare cell by cell) is always
   * `unlogged`, naming in `detail.wroteFile` any op that wrote the file, since none can be checked.
   *
   * Only the client's `current` task runs the folder watch (see the class comment); any other
   * leaves out the files only its folder watch baselined. A file the watch holds that another open
   * task (`ownedElsewhere`) touched through CoCheck is that task's to report: here it's only
   * snapshotted, so the baseline keeps up, and never diffed.
   */
  async #prepareRound(
    taskId: number,
    client: string,
    intent: string,
    final: boolean,
    lastOpId: number,
    current: boolean,
    ownedElsewhere: Set<string>,
    actor?: "reviewer",
  ): Promise<PreparedRound> {
    await this.#rebuildBaseline(taskId);
    const priorRounds = this.#ledger.roundsForTask(taskId);
    const seq = priorRounds.length + 1;

    const marker = this.#readMarker(taskId);
    const folderOnly = new Set(marker.folderOnly ?? []);
    const allSnapshots = this.#ledger.snapshotsForTask(taskId);
    let latest = latestPerFile(allSnapshots);
    const notes: string[] = [];
    if (current) {
      this.#addFolderNewcomers(marker, taskId, latest, folderOnly, notes);
    } else {
      latest = latest.filter((s) => !folderOnly.has(s.filePath));
    }
    const snapshots: RecordSnapshotInput[] = [];
    const rows: RecordReviewRowInput[] = [];
    const files: SubmitSummary["files"] = [];
    const dropAfterRound: string[] = [];
    const changedBefore = new Set(marker.changedBeforeTouch ?? []);
    // the files the hook's file-state chain tracks for this task; their outside changes are the chain's states, not rows here.
    const chained = new Set(this.#ledger.fileStatesForTask(taskId).map((f) => normalizePathForCompare(f.filePath)));
    const reportedBefore: string[] = [];
    for (const [index, prev] of latest.entries()) {
      const layer = this.#layerNamed(prev.layer);
      if (!layer) {
        throw new Error(`no layer named "${prev.layer}" for ${prev.filePath}`);
      }
      // Unique per attempt: a round cut concurrently under the same seq must not share its files.
      if (folderOnly.has(prev.filePath) && prev.mode === "fingerprint") {
        // Never a copy. A moved fingerprint is one unlogged row; the new fingerprint becomes the baseline.
        const now = existsSync(prev.filePath) ? await sha256Stream(prev.filePath) : null;
        const unmoved = await sameAsStored(prev.filePath, prev.sha256, now);
        // Like for like: a value stored with the legacy fingerprint is compared by that function before the plain SHA-256 becomes the baseline, so a change is never re-based away.
        snapshots.push({ taskId, round: seq, filePath: prev.filePath, layer: layer.name, snapshotPath: "", mode: now === null ? "missing" : "fingerprint", sha256: now });
        // a file the hook's file-state chain tracks gets no row here; the chain's own outside state is what the page shows and the sign-off gate reads.
        const mine = ownedElsewhere.has(prev.filePath) || unmoved || chained.has(normalizePathForCompare(prev.filePath)) ? [] : [changedOutsideRow(prev.filePath, layer.name, prev.sha256, now)];
        if (ownedElsewhere.has(prev.filePath)) continue;
        rows.push(...mine);
        files.push({ path: prev.filePath, layer: layer.name, snapshotMode: now === null ? "missing" : "fingerprint", rows: mine.length, explained: 0, derived: 0, unlogged: mine.length });
        continue;
      }
      const dest = this.#snapshotPath(taskId, seq, index, `${process.pid}-${process.hrtime.bigint()}-${path.basename(prev.filePath)}`);
      const mode = folderOnly.has(prev.filePath)
        ? await this.#copySnapshot(prev.filePath, dest)
        : await this.#snapshot(layer, prev.filePath, dest);
      if (mode === "fingerprint" || prev.mode === "fingerprint") {
        // A secret now (its bytes were not copied) or before (no copy to compare with): never a diff of its bytes. A moved fingerprint is
        // one row naming the file and nothing of what is in it; the fingerprint, or a copy of the file once it holds no secret, is the next baseline.
        const now = existsSync(prev.filePath) ? await sha256Stream(prev.filePath) : null;
        const unmoved = await sameAsStored(prev.filePath, prev.sha256, now);
        if (mode === "copy" && folderOnly.has(prev.filePath)) dropAfterRound.push(dest);
        snapshots.push({ taskId, round: seq, filePath: prev.filePath, layer: layer.name, snapshotPath: mode === "copy" && !folderOnly.has(prev.filePath) ? dest : "", mode: mode === "copy" && folderOnly.has(prev.filePath) ? "fingerprint" : mode, sha256: mode === "copy" && !folderOnly.has(prev.filePath) ? await this.#hash(dest, mode) : mode === "missing" ? null : now });
        if (ownedElsewhere.has(prev.filePath)) continue;
        const mine = unmoved || (now === null && prev.mode === "missing") ? [] : [secretChangeRow(prev.filePath, layer.name, prev.sha256, now)];
        rows.push(...mine);
        files.push({ path: prev.filePath, layer: layer.name, snapshotMode: mode, rows: mine.length, explained: 0, derived: 0, unlogged: mine.length });
        continue;
      }
      if (folderOnly.has(prev.filePath)) {
        // Held by the watch only (a newcomer, or a baseline from before fingerprints): the copy serves this round's diff, then goes; only the fingerprint is kept.
        dropAfterRound.push(dest);
        snapshots.push({ taskId, round: seq, filePath: prev.filePath, layer: layer.name, snapshotPath: "", mode: mode === "copy" ? "fingerprint" : mode, sha256: mode === "copy" ? await sha256Stream(prev.filePath) : null });
      } else {
        snapshots.push({ taskId, round: seq, filePath: prev.filePath, layer: layer.name, snapshotPath: dest, mode, sha256: await this.#hash(dest, mode) });
      }
      if (folderOnly.has(prev.filePath) && ownedElsewhere.has(prev.filePath)) {
        continue;
      }
      if (changedBefore.has(prev.filePath) && !folderOnly.has(prev.filePath) && chained.has(normalizePathForCompare(prev.filePath))) {
        // the chain holds the change before the touch; no row here.
        changedBefore.delete(prev.filePath);
      } else if (changedBefore.has(prev.filePath) && !folderOnly.has(prev.filePath)) {
        // The file's fingerprint had moved when CoCheck first touched it: one fingerprint-only row; the baseline copy is from that touch.
        changedBefore.delete(prev.filePath);
        rows.push(changedOutsideRow(prev.filePath, layer.name, null, null));
        reportedBefore.push(prev.filePath);
      }
      // No round diff is computed: the hook's file-state chain says who changed what. The round keeps each file's copy as its baseline and records no row of its own.
      files.push({ path: prev.filePath, layer: layer.name, snapshotMode: mode, rows: 0, explained: 0, derived: 0, unlogged: 0 });
    }

    await Promise.all(dropAfterRound.map((f) => rm(f, { force: true })));
    // A final round closes the task; 
    const closes = final;
    return {
      rowCount: rows.length,
      noteCount: notes.length,
      record: () => {
        if (current || reportedBefore.length > 0) {
          const fresh = this.#readMarker(taskId);
          const still = (fresh.changedBeforeTouch ?? marker.changedBeforeTouch ?? []).filter((f) => !reportedBefore.includes(f));
          this.#writeMarker(taskId, { ...marker, ...(current ? { folderOnly: [...folderOnly] } : {}), changedBeforeTouch: still, warned: fresh.warned ?? marker.warned });
        }
        return this.#recordRound(taskId, client, intent, closes, lastOpId, seq, snapshots, rows, files, notes, actor);
      },
      discard: async () => {
        await Promise.all(snapshots.map((s) => rm(s.snapshotPath, { force: true })));
      },
    };
  }

  /**
   * Records `round`, or, when a reviewer's page open (another process) took its round number
   * first, re-prepares against the round that now stands and settles again, once: a reviewer round
   * still without an agent summary and nothing new since takes the summary; otherwise the agent's
   * new rows are cut at the next seq.
   */
  async #settleRound(round: PreparedRound, args: SettleArgs, retries = 0): Promise<SubmitSummary> {
    const [taskId, client, intent, final] = args;
    // A reviewer's page open already cut this round: with nothing new since, the agent's
    // summary goes onto it rather than onto a duplicate, empty round.
    const open = this.#unsummarizedReviewerRound(taskId);
    if (open && !final && round.rowCount === 0 && round.noteCount === 0) {
      await round.discard();
      return this.#summarizeReviewerRound(taskId, client, intent, open.seq);
    }
    let recorded: SubmitSummary;
    try {
      recorded = round.record();
    } catch (error) {
      await round.discard();
      if (!isSeqCollision(error)) {
        throw error;
      }
      if (retries >= MAX_SEQ_COLLISION_RETRIES) {
        throw new TaskError(
          SEQ_COLLISION,
          `task ${taskId}: another process kept recording rounds at the same moment, so this round was not recorded (${error instanceof Error ? error.message : String(error)}). Nothing was lost: end your turn again to record the round.`,
        );
      }
      return this.#settleRound(await this.#prepareRound(...args), args, retries + 1);
    }
    await this.#afterCut(recorded);
    return recorded;
  }

  /**
   * After a round is recorded: deletes the copies the task no longer needs. A failure leaves the
   * copies in place for a later sweep and never fails the submit. (The round's checks and "what moved"
   * are not computed or stored here.)
   */
  async #afterCut(summary: SubmitSummary): Promise<void> {
    try {
      await pruneCopies(this.#ledger, summary.taskId, summary.final ? "final" : "open");
    } catch (error) {
      console.error(`cocheck: could not trim the file copies of task ${summary.taskId}`, error);
    }
  }

  /**
   * Housekeeping, run when a process starts (and so on the first start of a new build over an
   * existing home): closes tasks idle for 7 days as expired, deletes the file copies each
   * task no longer needs (c, d, h), removes the ledger values of tasks closed over 30 days ago (i),
   * and sets owner-only modes under the home (f). A task that fails is skipped, never the sweep.
   */
  async sweep(): Promise<void> {
    const now = this.#now();
    for (const taskId of this.#ledger.allTaskIds()) {
      let closedAt: string | undefined;
      try {
        // Everything that picks the policy is read under the lock: a reopen or a round landing while sweep waits must change what it prunes.
        await withTaskLocks(this.#root, [taskId], async () => {
          let closed = closureOf(this.#ledger, taskId);
          if (!closed) {
            const last = this.#ledger.lastActivity(taskId);
            if (last !== undefined && now - Date.parse(last) >= TASK_EXPIRY_MS) {
              this.#ledger.recordExpiry(taskId, new Date(now));
              closed = closureOf(this.#ledger, taskId);
            }
          }
          // A reopened task is live again: open-policy pruning, until it is signed or expires again.
          const reopened = signoffStatus(this.#ledger, taskId).reopened === true;
          await pruneCopies(this.#ledger, taskId, closed ? "closed" : !reopened && this.#isFinal(taskId) ? "final" : "open", now);
          closedAt = closed?.ts;
        });
        if (closedAt !== undefined && now - Date.parse(closedAt) >= VALUES_EXPIRY_MS && !this.#ledger.valuesExpiredAt(taskId)) {
          this.#ledger.expireValues(taskId, new Date(now));
        }
        // The pictures the person pointed at hold values too. Checked on every sweep of an expired task, so a stop between the blanking and the delete is finished next time.
        if (this.#ledger.valuesExpiredAt(taskId)) {
          removeDeliveryCopies(this.#root, taskId);
          await removeRegions(this.#root, taskId);
          await removeFrozen(this.#root, taskId);
        }
      } catch (error) {
        console.error(`cocheck: sweep skipped task ${taskId}`, error);
      }
    }
    hardenHomeAndSay(this.#root);
  }

  /**
   * Sweeps now and then every hour while this process runs, so a task that goes idle expires without
   * a restart. The timer is unref'd, so it never keeps the process alive. Returns the stop function.
   */
  startSweeps(schedule: (fn: () => void, ms: number) => NodeJS.Timeout = setInterval): () => void {
    const run = () => {
      this.sweep().catch((error) => console.error("cocheck: sweep failed", error));
    };
    run();
    const timer = schedule(run, SWEEP_EVERY_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * A task reopened after sign-off has no file copies (sign-off deleted them), but the next round
   * diffs against the latest one. Takes a fresh copy of every file whose latest copy is gone, from
   * what is on disk now, as a new snapshot of the signed round. Called before any agent write
   * (`touch`, which every write goes through) and again when a round is cut. A copy whose hash
   * differs from the signed one is noticed by `#prepareRound`, which writes the one fingerprint
   * row; a copy that matches adds nothing, so the round diffs normally.
   */
  async #rebuildBaseline(taskId: number): Promise<void> {
    const status = signoffStatus(this.#ledger, taskId);
    const seq = this.#ledger.roundsForTask(taskId).at(-1)?.seq;
    if (!status.reopened || seq === undefined) return;
    const folderOnly = new Set(this.#readMarker(taskId).folderOnly ?? []);
    for (const [index, prev] of latestPerFile(this.#ledger.snapshotsForTask(taskId)).entries()) {
      if (!prev.removed || prev.mode === "missing" || prev.sha256 === null) continue;
      const layer = this.#layerNamed(prev.layer);
      if (!layer) continue;
      const dest = this.#snapshotPath(taskId, seq, index, `${process.pid}-${process.hrtime.bigint()}-reopen-${path.basename(prev.filePath)}`);
      if (folderOnly.has(prev.filePath)) {
        const now = existsSync(prev.filePath) ? await sha256Stream(prev.filePath) : null;
        this.#ledger.recordSnapshot({ taskId, round: seq, filePath: prev.filePath, layer: layer.name, snapshotPath: "", mode: now === null ? "missing" : "fingerprint", sha256: now });
        continue;
      }
      const mode = await this.#snapshot(layer, prev.filePath, dest);
      this.#ledger.recordSnapshot({ taskId, round: seq, filePath: prev.filePath, layer: layer.name, snapshotPath: mode === "fingerprint" ? "" : dest, mode, sha256: await this.#hash(dest, mode, prev.filePath) });
    }
  }

  /** SHA-256 of the copy just taken; null when there is no file (a missing snapshot). A secret's ("fingerprint", nothing copied) is the source's fingerprint. */
  async #hash(dest: string, mode: SnapshotMode, source?: string): Promise<string | null> {
    if (mode === "fingerprint") return source !== undefined && existsSync(source) ? sha256Stream(source) : null;
    return mode === "missing" || !existsSync(dest) ? null : sha256Of(dest);
  }

  /** The latest round of `taskId` if a reviewer's page open cut it and no agent summary is on it yet. */
  #unsummarizedReviewerRound(taskId: number): { seq: number } | undefined {
    const last = this.#ledger.roundsForTask(taskId).at(-1);
    if (!last || this.#ledger.roundActorsForTask(taskId).get(last.seq) !== "reviewer") {
      return undefined;
    }
    return this.#ledger.summarizedRoundsForTask(taskId).has(last.seq) ? undefined : { seq: last.seq };
  }

  /** Attaches the agent's `intent` to the reviewer-cut round `seq` and reports that round's rows. */
  #summarizeReviewerRound(taskId: number, client: string, intent: string, seq: number): SubmitSummary {
    this.#ledger.recordRoundSummary({ taskId, round: seq, intent, clientName: client });
    const rows = this.#ledger.reviewRowsForTask(taskId).filter((r) => r.roundSeq === seq);
    const totals: Counts = { rows: 0, explained: 0, derived: 0, unlogged: 0 };
    const byFile = new Map<string, SubmitSummary["files"][number]>();
    for (const r of rows) {
      const file = byFile.get(r.filePath) ?? { path: r.filePath, layer: r.layer, snapshotMode: "copy" as SnapshotMode, rows: 0, explained: 0, derived: 0, unlogged: 0 };
      byFile.set(r.filePath, file);
      for (const c of [totals, file]) {
        c.rows += 1;
        c[r.status] += 1;
      }
    }
    const summary: SubmitSummary = {
      taskId,
      round: seq,
      final: false,
      totals,
      files: [...byFile.values()],
      rows: rows.slice(0, MAX_SUMMARY_ROWS).map((r) => ({
        id: r.id,
        file: r.filePath,
        location: r.location,
        kind: r.kind,
        status: r.status,
        description: r.description,
        ops: r.ops as ExplainingOp[],
        ...overwroteOf(r.detail),
      })),
      openItems: this.#openItemCount(taskId),
    };
    if (rows.length > MAX_SUMMARY_ROWS) {
      summary.rowsOmitted = rows.length - MAX_SUMMARY_ROWS;
    }
    return summary;
  }

  /**
   * A reviewer opened the page (or the index): if any file of `taskId` changed since its last
   * round, cuts a non-final round through the same diff and classification as `submit`, recorded
   * as opened by the reviewer under the task's own client. Returns the round's summary, or
   * undefined when nothing changed (no round is cut, so two opens in a row cut one), the task is
   * closed (a round on it would reopen it) or has no files yet. Uses only the bytes on disk and
   * never drives Excel: the caller's spreadsheet layer decides how an open workbook is read.
   *
   * Nothing calls this in production (the page and the index cut no round on open); it stays until the round engine is retired.
   */
  async cutReviewerRound(taskId: number): Promise<SubmitSummary | undefined> {
    return withTaskLocks(this.#root, [taskId], () => this.#cutReviewerRound(taskId));
  }

  async #cutReviewerRound(taskId: number): Promise<SubmitSummary | undefined> {
    const client = this.#ledger.taskClient(taskId);
    if (client === undefined || !this.#isOpen(taskId) || this.#ledger.snapshotsForTask(taskId).length === 0) {
      return undefined;
    }
    const clientKey = client ?? "";
    if (this.#isRolledOver(taskId, clientKey)) {
      return undefined;
    }
    const taskIds = this.openTaskIds(clientKey);
    const ownedElsewhere = new Set([...taskIds.filter((id) => id !== taskId).flatMap((id) => [...this.#ownFiles(id)]), ...this.#sessionFiles(clientKey)]);
    const round = await this.#prepareRound(
      taskId,
      clientKey,
      "Round cut when a reviewer opened the review page: files changed since the last round",
      false,
      this.#ledger.maxOpId(),
      this.currentTaskId(clientKey) === taskId,
      ownedElsewhere,
      "reviewer",
    );
    if (round.rowCount === 0) {
      await round.discard();
      return undefined;
    }
    try {
      const summary = round.record();
      await this.#afterCut(summary);
      this.#ledger.recordActivity(taskId, "reviewer", new Date(this.#now()));
      return summary;
    } catch (error) {
      // Another process cut the same round number first; theirs stands.
      await round.discard();
      if (this.#ledger.roundsForTask(taskId).length > 0) {
        return undefined;
      }
      throw error;
    }
  }

  #recordRound(
    taskId: number,
    client: string,
    intent: string,
    final: boolean,
    lastOpId: number,
    seq: number,
    snapshots: RecordSnapshotInput[],
    rows: RecordReviewRowInput[],
    files: SubmitSummary["files"],
    notes: string[],
    actor?: "reviewer",
  ): SubmitSummary {
    const { rowIds } = this.#ledger.recordRound({
      taskId,
      seq,
      intent,
      clientName: client,
      final,
      lastOpId,
      snapshots,
      rows,
      notes,
      actor,
    });

    const totals: Counts = { rows: 0, explained: 0, derived: 0, unlogged: 0 };
    for (const f of files) {
      totals.rows += f.rows;
      totals.explained += f.explained;
      totals.derived += f.derived;
      totals.unlogged += f.unlogged;
    }
    const summaryRows = rows.slice(0, MAX_SUMMARY_ROWS).map((r, i) => ({
      id: rowIds[i]!,
      file: r.filePath,
      location: r.location,
      kind: r.kind,
      status: r.status,
      description: r.description,
      ops: r.ops as ExplainingOp[],
      ...overwroteOf(r.detail),
    }));
    const summary: SubmitSummary = {
      taskId,
      round: seq,
      final,
      totals,
      files,
      rows: summaryRows,
      openItems: this.#openItemCount(taskId),
    };
    if (notes.length > 0) {
      summary.notes = notes;
    }
    if (rows.length > MAX_SUMMARY_ROWS) {
      summary.rowsOmitted = rows.length - MAX_SUMMARY_ROWS;
    }
    return summary;
  }

  #folderMarkerPath(taskId: number): string {
    return path.join(this.#root, "tasks", String(taskId), "folder.json");
  }

  /** The task's folder marker; `{}` when it has none (no folder watch, or a pre-watch task). */
  #readMarker(taskId: number): FolderMarker {
    return readFolderMarker(this.#root, taskId);
  }

  #writeMarker(taskId: number, marker: FolderMarker): void {
    try {
      mkdirSync(path.dirname(this.#folderMarkerPath(taskId)), { recursive: true });
      writeFileSync(this.#folderMarkerPath(taskId), JSON.stringify(marker));
    } catch {
      // without a marker the folder simply isn't rescanned for new files
    }
  }

  /** The files of `taskId` that a CoCheck call touched: every file it holds but the folder-only ones. */
  #ownFiles(taskId: number): Set<string> {
    const folderOnly = new Set(this.#readMarker(taskId).folderOnly ?? []);
    return new Set(this.#ledger.snapshotsForTask(taskId).map((s) => s.filePath).filter((f) => !folderOnly.has(f)));
  }

  /** A CoCheck call touched `filePath` in `taskId`: it's the task's own file from now on. */
  #markTouched(taskId: number, filePath: string): void {
    const marker = this.#readMarker(taskId);
    if (marker.folderOnly?.includes(filePath)) {
      this.#writeMarker(taskId, { ...marker, folderOnly: marker.folderOnly.filter((f) => f !== filePath) });
    }
  }

  /**
   * Folder watch, open side: baseline every watched file in the folder of the task's first file
   * (non-recursive, capped), workbooks included, by byte copy: a file no CoCheck call touched is
   * never opened or checked through Excel. The choice (folder, or why it was skipped) is written
   * to a marker so a later submit can tell "created since open" from "never watched". Never
   * throws: a folder that can't be watched is a note, not a failed op.
   */
  async #snapshotFolderAtOpen(taskId: number, dir: string): Promise<void> {
    const marker: FolderMarker = { dir, folderOnly: [] };
    try {
      const scan = scanFolder(dir);
      if (!scan.ok) {
        marker.skipped = scan.note;
      } else {
        if (scan.notes.length > 0) {
          marker.notes = scan.notes;
        }
        const have = new Set(this.#ledger.snapshotsForTask(taskId).map((s) => s.filePath));
        let index = have.size;
        for (const file of scan.files) {
          const layer = this.#layers.find((l) => l.accepts(file));
          if (!layer || have.has(file)) {
            continue;
          }
          index++;
          // A file no CoCheck call has touched is a fingerprint, never a copy.
          this.#ledger.recordSnapshot({ taskId, round: 0, filePath: file, layer: layer.name, snapshotPath: "", mode: "fingerprint", sha256: await sha256Stream(file) });
          marker.folderOnly!.push(file);
        }
      }
    } catch (error) {
      marker.skipped = `folder ${dir} could not be watched: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.#writeMarker(taskId, marker);
  }

  /**
   * Folder watch, submit side: a watched file in the folder that the task has no snapshot of was
   * created since the task opened. It joins `latest` with an empty ("missing") previous snapshot,
   * so its diff is a "new file" row and later rounds diff it normally, and joins `folderOnly`.
   * Why anything wasn't watched goes into `notes`.
   */
  #addFolderNewcomers(marker: FolderMarker, taskId: number, latest: SnapshotRow[], folderOnly: Set<string>, notes: string[]): void {
    const add = (note: string) => {
      if (!notes.includes(note)) notes.push(note);
    };
    if (marker.skipped) {
      add(marker.skipped);
      return;
    }
    if (!marker.dir) {
      return;
    }
    const scan = scanFolder(marker.dir);
    if (!scan.ok) {
      add(scan.note);
      return;
    }
    for (const note of [...(marker.notes ?? []), ...scan.notes]) {
      add(note);
    }
    const have = new Set(latest.map((s) => s.filePath));
    for (const file of scan.files) {
      const layer = this.#layers.find((l) => l.accepts(file));
      if (layer && !have.has(file)) {
        latest.push({ id: 0, taskId, round: 0, filePath: file, layer: layer.name, snapshotPath: "", mode: "missing", sha256: null, removed: false });
        folderOnly.add(file);
      }
    }
  }

  #snapshotPath(taskId: number, round: number, index: number, filePath: string): string {
    return path.join(this.#root, "tasks", String(taskId), `round-${round}`, `${index}-${path.basename(filePath)}`);
  }

  /** A plain byte copy of `filePath`, for files only the folder watch holds. */
  async #copySnapshot(filePath: string, dest: string): Promise<SnapshotMode> {
    try {
      if (!existsSync(filePath)) {
        return "missing";
      }
      if (await holdsSecret(filePath, filePath)) return "fingerprint";
      await retryVanishedDir(filePath, async () => {
        await writeSealed(dest, await readFile(filePath));
      });
      await chmod(dest, 0o600);
      return "copy";
    } catch (error) {
      if (isKeyMissing(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError(SNAPSHOT_FAILED, `${filePath}: ${message}`);
    }
  }

  /** A copy of `filePath` through its layer, or "fingerprint" with nothing written when the file holds a secret (`name` is the tracked path, for its name). */
  async #snapshot(layer: FormatLayer, filePath: string, dest: string, name = filePath): Promise<SnapshotMode> {
    try {
      if (existsSync(filePath) && (await holdsSecret(name, filePath))) return "fingerprint";
      const mode = await retryVanishedDir(filePath, () => layer.snapshot(filePath, dest));
      if (mode !== "missing") await chmod(dest, 0o600).catch(() => {});
      return mode;
    } catch (error) {
      if (error instanceof SnapshotRefusal) {
        throw new TaskError(error.code, error.message);
      }
      if (isKeyMissing(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError(SNAPSHOT_FAILED, `${filePath}: ${message}`);
    }
  }
}

/**
 * Runs `copy`, trying again when it fails with ENOENT while `source` still exists. Another process cutting a
 * round clears the empty round folders and can remove the one this copy just made, between its mkdir
 * and its write; the next try makes it again.
 */
async function retryVanishedDir<T>(source: string, copy: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await copy();
    } catch (error) {
      if (attempt >= 5 || (error as NodeJS.ErrnoException)?.code !== "ENOENT" || !existsSync(source)) throw error;
    }
  }
}

/** Where a touched file's baseline comes from when the file already changed: a plain copy of its earlier bytes, or nothing (it did not exist). */
type TouchBaseline = { source: string } | { missing: true };

/** The hook adapter names a task's client `<host>-hook:<folder>` (src/hook-adapter.ts); this prefix is not part of the folder. */
export const HOOK_PREFIX = /^[A-Za-z0-9_-]+-hook:/;

/** Separates the folder from the session id in a hook client name (`<host>-hook:<folder>?session=<id>`). */
export const HOOK_SESSION_MARK = "?session=";

/** A hook client name without its session suffix (the folder-keyed form); other strings pass through. */
export function stripHookSession(client: string): string {
  const at = client.lastIndexOf(HOOK_SESSION_MARK);
  return at > 0 && HOOK_PREFIX.test(client) && !client.slice(at + HOOK_SESSION_MARK.length).includes("/") ? client.slice(0, at) : client;
}

/** The absolute folder a hook-adapter client was started with, or null for any other client (or a hook name without an absolute folder). */
export function hookFolderOf(client: string | null | undefined): string | null {
  if (!client || !HOOK_PREFIX.test(client)) return null;
  const dir = pathKit().trimEnd(stripHookSession(client).replace(HOOK_PREFIX, ""));
  return pathKit().isAbs(dir) ? dir : null;
}

/** `tasks/<id>/folder.json` under `root`; `{}` when there is none (no folder watch, or a pre-watch task). */
export function readFolderMarker(root: string, taskId: number): FolderMarker {
  try {
    return JSON.parse(readFileSync(path.join(root, "tasks", String(taskId), "folder.json"), "utf8")) as FolderMarker;
  } catch {
    return {};
  }
}

/** SHA-256 of the plaintext inside a stored (sealed) copy. */
async function sha256Of(filePath: string): Promise<string> {
  return sha256OfSealed(filePath);
}

/** Each file's most recent snapshot, in the order files joined the task. */
function latestPerFile(snapshots: SnapshotRow[]): SnapshotRow[] {
  const byFile = new Map<string, SnapshotRow>();
  for (const s of snapshots) {
    byFile.set(s.filePath, s);
  }
  return [...byFile.values()];
}

/** Kind of the one row a fingerprint-only file gets when it moved while CoCheck wasn't touching it. */
const CHANGED_OUTSIDE_KIND = "changed outside CoCheck";
const DELETED_OUTSIDE_KIND = "deleted outside CoCheck";

/** The row for a fingerprint-only file that changed: no before or after, since neither was kept. Marked low priority, not flagged, when `RESAVE_FALLBACK` is on. */
/**
 * Whether CoCheck must not copy a file's bytes: a secret by its name (`name`, the tracked path), or text at `bytesAt` in which a gitleaks
 * rule finds a secret (`secretRuleInBytes`). Every round copy goes through this check, so a secret's bytes never reach a round folder or a diff.
 */
async function holdsSecret(name: string, bytesAt: string): Promise<boolean> {
  if (isSecretPath(path.basename(name))) return true;
  try {
    return secretRuleInBytes(await readFile(bytesAt)) !== undefined;
  } catch {
    return false;
  }
}

/** A file that holds a secret (now, or at its last snapshot) and changed: one row with fingerprints only, never a value from inside it. */
function secretChangeRow(filePath: string, layer: string, was: string | null, now: string | null): RecordReviewRowInput {
  const deleted = now === null && was !== null;
  return {
    filePath,
    layer,
    location: "file",
    kind: deleted ? DELETED_OUTSIDE_KIND : CHANGED_OUTSIDE_KIND,
    status: "unlogged",
    before: null,
    after: null,
    ops: [],
    description: `${secretLine(path.basename(filePath))}; it looks like it holds a secret, so only its fingerprint is kept`,
    detail: { kind: deleted ? DELETED_OUTSIDE_KIND : CHANGED_OUTSIDE_KIND, fingerprint: was, now, secret: true },
  };
}

/**
 * Whether `file` now is what the stored fingerprint `stored` (a plain SHA-256) recorded; `now` is the file's SHA-256 when the caller has it.
 * A file that is gone matches only a missing record.
 */
async function sameAsStored(file: string, stored: string | null, now?: string | null): Promise<boolean> {
  if (!existsSync(file)) return stored === null;
  if (stored === null) return false;
  return (now ?? (await sha256Stream(file))) === stored;
}

function changedOutsideRow(filePath: string, layer: string, was: string | null, now: string | null, deleted = now === null && was !== null): RecordReviewRowInput {
  const cls = outsideClass(filePath, deleted);
  return {
    filePath,
    layer,
    location: "file",
    kind: deleted ? DELETED_OUTSIDE_KIND : CHANGED_OUTSIDE_KIND,
    status: "unlogged",
    before: null,
    after: null,
    ops: [],
    description: changedOutsideWording(cls),
    detail: { kind: deleted ? DELETED_OUTSIDE_KIND : CHANGED_OUTSIDE_KIND, fingerprint: was, now },
  };
}

function overwroteOf(detail: unknown): { overwroteOp?: ExplainingOp } {
  const op = (detail as { overwroteOp?: ExplainingOp } | null)?.overwroteOp;
  return op ? { overwroteOp: op } : {};
}

/** What a hook-adapter op records about its call. */
interface HookCallInfo {
  callId: string;
  closedBy?: string;
  background: boolean;
  openedAt?: number;
  closedAt?: number;
}

/**
 * The call fields of a hook-adapter op's parsed args. When the ledger cut oversized args to a stand-in
 * (`{_truncated, preview}`), they are read back from the preview, where the adapter put them first.
 */
export function hookCallOf(args: Record<string, unknown>): HookCallInfo | undefined {
  if (args._truncated === true && typeof args.preview === "string") {
    const p = args.preview;
    if (!/"hookAdapter":1[,}]/.test(p)) return undefined;
    const str = (k: string) => {
      const m = new RegExp(`"${k}":("(?:[^"\\\\]|\\\\.)*")`).exec(p);
      if (!m) return undefined;
      try {
        return JSON.parse(m[1]!) as string;
      } catch {
        return undefined;
      }
    };
    const num = (k: string) => {
      const m = new RegExp(`"${k}":(\\d+)`).exec(p);
      return m ? Number(m[1]) : undefined;
    };
    const callId = str("tool_use_id");
    if (callId === undefined) return undefined;
    const closedBy = str("closedBy");
    const openedAt = num("openedAt");
    const closedAt = num("closedAt");
    return { callId, ...(closedBy !== undefined ? { closedBy } : {}), background: /"background":true/.test(p), ...(openedAt !== undefined ? { openedAt } : {}), ...(closedAt !== undefined ? { closedAt } : {}) };
  }
  if (args.hookAdapter !== 1 || typeof args.tool_use_id !== "string") return undefined;
  return {
    callId: args.tool_use_id,
    ...(typeof args.closedBy === "string" ? { closedBy: args.closedBy } : {}),
    background: args.background === true,
    ...(typeof args.openedAt === "number" ? { openedAt: args.openedAt } : {}),
    ...(typeof args.closedAt === "number" ? { closedAt: args.closedAt } : {}),
  };
}
