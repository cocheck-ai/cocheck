// The file route of a capture. A file written on a connector-claimed extension is captured and frozen the way a URI subject is (after-snapshot.ts):
// CoCheck reads the file bytes it already sealed in the task's store where a subject route would ask `snapshot`, asks the connector once (`diff`, or `export`
// for an export connector), and freezes the answer. The row records the connector's version and spec whatever happens, so a step never asks the connector again.
// The one exception is an answer that says "not ready, ask again" (pendingRetry): the row stays pending, the answer is kept as a try, and the next load
// asks again once the gap since the last try has passed (CAPTURE_ASK_GAPS_MS: 30 s, doubling), as many more times as the latest answer's pendingRetry
// count says, and never past MAX_CAPTURE_ASKS asks in all.
// Best effort: a failure leaves the row without a list (the page says why); it never blocks the row and never throws.
// The hook never runs this. It writes the row with the connector's identity and a pending capture; the review process reads it (settleFileCapture),
// on the hook's nudge or, when the process was not running, the first time the row is loaded. Both sides are already sealed, so there is no hurry.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileStateRow, Ledger } from "../ledger.ts";
import { readSealed } from "../seal.ts";
import { redactSecrets } from "../secret-scan.ts";
import { storeDirOf } from "../states.ts";
import { createConnectorDiff, frozenDocOf } from "./diff.ts";
import { levelOfDoc } from "./doc-level.ts";
import { freezeChanges, readFrozen } from "./frozen.ts";
import { connectorArgv, connectorById } from "./builtins.ts";
import { NO_CLAIM_NOW, NO_LIST_KEPT, oldRowClaimsFor, sidesStored } from "./old-rows.ts";
import { withTaskLocks } from "../copies.ts";
import type { InstalledManifest } from "./installed-manifests.ts";
import { startConnector } from "./runner.ts";
import { checkExportAnswer, DEFAULT_DIFF_MS, diffMsOf, EXPORT_METHOD, MANIFEST_SPEC, permittedEnvOf } from "./schema.ts";

/** What a file row freezes for an export connector: the text each side exported (null: that side does not exist). CoCheck draws it with its own text renderer. */
export const EXPORT_TEXT_FROZEN_SPEC = "cocheck.export/2";

export interface FileCaptureInput {
  home: string;
  taskId: number;
  /** The file's path (the subject). */
  subject: string;
  connector: string;
  /** The stored states (refs in the task's store); null when that side does not exist. A side not stored whole cannot be captured. */
  before: string | null;
  after: string | null;
  /** The bound on each wait for the connector (hello, then each answer); a manifest's `diffMs` replaces it for the diff or export call. */
  timeoutMs?: number;
  /** Which ask of this row this is (1 for the first). At `lastAsk` an "ask again" answer is frozen as it is, with a caveat. Default 1. */
  ask?: number;
  /** The last ask the row may have: min(MAX_CAPTURE_ASKS, asks so far + the previous answer's pendingRetry count); see lastAskOf. Default MAX_CAPTURE_ASKS. */
  lastAsk?: number;
}

/** The most times a row's connector is asked when it keeps answering "not ready, ask again" (pendingRetry); the last answer is then frozen with a caveat. */
export const MAX_CAPTURE_ASKS = 5;
/**
 * The wait before each "ask again": a pending row is asked again only once this long has passed since its last recorded try (the try's ledger time).
 * Entry n is the gap between ask n+1 and ask n+2 (30 s, then doubling); a later try than the list covers reuses the last entry. A load inside the gap
 * serves the stored answer and does not call the connector, so page loads and polls never burn the asks.
 */
export const CAPTURE_ASK_GAPS_MS: readonly number[] = Object.freeze([30_000, 60_000, 120_000, 240_000]);

/** The spacing seam of settleFileCapture: the clock (epoch ms) and the gaps. Defaults: Date.now and CAPTURE_ASK_GAPS_MS. */
export interface CaptureSpacing { now?: () => number; gapsMs?: readonly number[] }

/** The caveat a row frozen on its last ask carries (the cap, or the count the connector's own pendingRetry gave, whichever came first). */
export const ASKS_RAN_OUT = "The connector still said it was not ready when CoCheck had asked as many times as it would, so this is its last answer as it gave it.";

/**
 * The last ask a row may have after `asked` asks whose latest answer is `latest`: asks so far plus that answer's pendingRetry count ("how many more
 * times", spec v1), never past MAX_CAPTURE_ASKS. A count that is missing or not a whole number from 1 leaves only the cap.
 */
export function lastAskOf(asked: number, latest: unknown): number {
  const n = isObjLike(latest) ? latest["pendingRetry"] : undefined;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? Math.min(MAX_CAPTURE_ASKS, asked + n) : MAX_CAPTURE_ASKS;
}
const isObjLike = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export interface FileCapture { connectorVersion: string; connectorSpec: string; changesSha256?: string }

/** What a capture came to: the connector's identity, the frozen list's hash when it answered, and why not when it did not. */
export interface FileCaptureResult extends FileCapture {
  /** CoCheck's own wording of what went wrong (a category such as "it timed out"), never the connector's text. */
  failed?: string;
  /** What the connector or the runner said, secret-scanned and cut; it may quote the file, so it is kept only where the 30-day expiry blanks it. */
  failedDetail?: string;
  /** The answer said "not ready, ask again" (pendingRetry) and the cap is not reached: `changesSha256` is that answer, sealed, but the row is not finished. */
  pendingRetry?: true;
}

/** The connector's version and spec for the row, and the sha256 of what it said (or why it said nothing), or undefined when the connector is not installed or reads no file (entry diff). Never throws. */
export async function captureFileRow(i: FileCaptureInput): Promise<FileCaptureResult | undefined> {
  try {
    const installed = connectorById(i.home, i.connector);
    if (installed === undefined) return undefined;
    const m = installed.manifest as unknown as { version?: unknown; spec?: unknown; entry?: string; run?: unknown; credentials?: Array<{ name: string }> };
    if (m.entry === "diff") return undefined;
    const identity = { connectorVersion: String(m.version ?? ""), connectorSpec: String(m.spec ?? MANIFEST_SPEC) };
    try {
      const timeoutMs = i.timeoutMs ?? DEFAULT_DIFF_MS;
      if (m.entry === "export") {
        const texts = await exportSides(i, installed, m, timeoutMs);
        return { ...identity, changesSha256: (await freezeChanges(i.home, i.taskId, { spec: EXPORT_TEXT_FROZEN_SPEC, connector: i.connector, before: texts.before, after: texts.after })).sha256 };
      }
      const diff = await createConnectorDiff({ home: i.home, taskId: i.taskId, timeoutMs })({ subject: i.subject, connector: i.connector, before: { ref: i.before }, after: { ref: i.after } });
      const doc: Record<string, unknown> = frozenDocOf(diff, i.connector);
      // "not ready, ask again" keeps the row open until its last ask; on it the answer is frozen as it is, with a caveat saying so.
      const askAgain = diff.v1doc !== undefined && diff.v1doc["pendingRetry"] !== undefined;
      const last = (i.ask ?? 1) >= Math.min(MAX_CAPTURE_ASKS, i.lastAsk ?? MAX_CAPTURE_ASKS);
      if (askAgain && last) doc.caveats = [...(Array.isArray(doc.caveats) ? doc.caveats : []), ASKS_RAN_OUT];
      const sha = (await freezeChanges(i.home, i.taskId, doc)).sha256;
      return { ...identity, changesSha256: sha, ...(askAgain && !last ? { pendingRetry: true as const } : {}) };
    } catch (e) {
      return { ...identity, failed: failureCategory(e), failedDetail: failureDetail(e) };
    }
  } catch {
    return undefined;
  }
}

/** The message of a failure, first line only. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.trim();

/**
 * What went wrong, in CoCheck's own words only (it is kept for good). Built from the shape of the runner's message, never by copying its text:
 * the connector's own words can quote the file.
 */
export function failureCategory(e: unknown): string {
  const m = messageOf(e);
  const timed = /call "(hello|diff|export)" timed out after (\d+) ms/.exec(m);
  if (timed) return `it timed out (no answer to "${timed[1]}" within ${timed[2]} ms)`;
  if (/timed out/.test(m)) return "it timed out";
  const code = /exited \(code (-?\d+)\)/.exec(m);
  if (code) return `it exited with code ${code[1]}`;
  const signal = /exited \(signal ([A-Z0-9]+)\)/.exec(m);
  if (signal) return `it was ended by signal ${signal[1]}`;
  if (/\bexited\b/.test(m)) return "it exited";
  if (/answered with an error/.test(m)) return "it answered with an error";
  if (/answer was rejected|did not answer with an object|over 16 MB/.test(m)) return "its answer was rejected";
  if (/could not start|credential|closed its input|failed: /.test(m)) return "it could not start";
  if (/was stopped/.test(m)) return "it was stopped";
  return "it failed";
}

/** What the connector or the runner said, secret-scanned and cut, without the runner's internal process id. Expires with the task's values. */
function failureDetail(e: unknown): string | undefined {
  const m = redactSecrets(messageOf(e).replace(/\.+$/, "").replace(/^connector \S+#\S+?: /, "").replace(/^connector \S+#\S+ /, "it "));
  return m === "" ? undefined : m.slice(0, 300);
}

let serial = 0;

/** Asks an export connector for the text of each stored side, written to a private folder under the file's own name (the connector reads a file at `subject`). */
async function exportSides(i: FileCaptureInput, installed: InstalledManifest, m: { run?: unknown; credentials?: Array<{ name: string }> }, timeoutMs: number): Promise<{ before: string | null; after: string | null }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-connector-export-"));
  let handle: Awaited<ReturnType<typeof startConnector>> | undefined;
  try {
    handle = await startConnector({
      dir: path.dirname(installed.file),
      run: connectorArgv(installed),
      // One process per capture: rows read at the same time must never share one (the runner reuses a process by id, and stop() fails its other calls).
      id: `${i.connector}#file-${process.pid}-${++serial}`,
      helloTimeoutMs: Math.max(1, timeoutMs),
      envNames: permittedEnvOf(m),
      credentials: (m.credentials ?? []).map((c) => ({ name: c.name, service: `cocheck-connector:${i.connector}` })),
    });
    const ask = async (side: "before" | "after", ref: string | null): Promise<string | null> => {
      if (ref === null) return null;
      const sideDir = path.join(dir, side);
      await mkdir(sideDir, { mode: 0o700 });
      const file = path.join(sideDir, path.basename(i.subject) || "state");
      await writeFile(file, await readSealed(path.join(storeDirOf(i.home, i.taskId), ref)), { mode: 0o600 });
      const answer = await handle!.call(EXPORT_METHOD, { subject: file }, { timeoutMs: diffMsOf(installed.manifest) ?? timeoutMs });
      const bad = checkExportAnswer(answer);
      if (bad.length > 0) throw new Error(`its export answer was rejected: ${bad[0]!.field || "answer"} ${bad[0]!.fix}`);
      return (answer as { text: string | null })["text"];
    };
    return { before: await ask("before", i.before), after: await ask("after", i.after) };
  } finally {
    await handle?.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether a row with `asked` tries, the latest recorded at `latestTs`, may be asked again now. An unreadable time counts as due (the cap still bounds the asks). */
function askIsDue(latestTs: string | null, asked: number, spacing: CaptureSpacing): boolean {
  const gaps = spacing.gapsMs ?? CAPTURE_ASK_GAPS_MS;
  const last = latestTs === null ? NaN : Date.parse(latestTs);
  if (!Number.isFinite(last) || gaps.length === 0) return true;
  const gap = gaps[Math.min(asked, gaps.length) - 1]!;
  return (spacing.now ?? Date.now)() >= last + gap;
}

// One read per row at a time in this process (a nudge and a page load, or two loads, never run the connector twice); the ledger keeps the first finished answer across processes.
const inFlight = new Map<string, Promise<void>>();

/**
 * Reads one pending row's change list in the review process and freezes it: the row then holds the hash and the identity of the connector that ran,
 * or the reason it holds none. Runs once per row (concurrent calls share one run); a row already finished is left alone. Never throws.
 */
export function settleFileCapture(ledger: Ledger, home: string, row: FileStateRow, timeoutMs = 10_000, spacing: CaptureSpacing = {}): Promise<void> {
  const key = `${home}\0${row.id}`;
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  // Spaced asks: inside the gap since the last try the stored answer stands and the connector is not called. Checked before the run is registered
  // (a run that returned with no await would clear its in-flight entry before it was set).
  try {
    const tries = ledger.captureTries(row.id);
    if (tries.count > 0 && !askIsDue(tries.latestTs, tries.count, spacing)) return Promise.resolve();
  } catch {
    // unreadable tries: the run below reads them again and records why it could not
  }
  const run = (async () => {
    try {
      if (row.connector === null) {
        await settleOldRow(ledger, home, row, timeoutMs, spacing);
        return;
      }
      await askAndRecord(ledger, home, row, row.connector, timeoutMs, spacing);
    } catch (e) {
      try {
        ledger.recordFileCapture({ fileStateId: row.id, state: "failed", reason: "CoCheck could not read the change list", ...(failureDetail(e) === undefined ? {} : { detail: failureDetail(e)! }) });
      } catch {
        // the ledger is unwritable; the row stays pending and the next load tries again
      }
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}

/** Asks `connector` for one row's change list and records what it came to (frozen list, a try to ask again, or why not). Throws only on a ledger or store error. */
async function askAndRecord(ledger: Ledger, home: string, row: FileStateRow, connector: string, timeoutMs: number, spacing: CaptureSpacing): Promise<void> {
  const tries = ledger.captureTries(row.id);
  const asked = tries.count;
  // The previous answer's own count bounds the asks; an unreadable one leaves only the cap.
  const previous = tries.latest === null ? undefined : await readFrozen(home, row.taskId, tries.latest).catch(() => undefined);
  const got = await captureFileRow({ home, taskId: row.taskId, subject: row.filePath, connector, before: row.prevSha256, after: row.kept === "gone" ? null : row.sha256, timeoutMs, ask: asked + 1, lastAsk: lastAskOf(asked, previous) });
  if (got === undefined) {
    ledger.recordFileCapture({ fileStateId: row.id, state: "failed", reason: `the connector '${connector}' was not installed when CoCheck read the change, so no change list was kept` });
  } else if (got.pendingRetry === true && got.changesSha256 !== undefined) {
    // Not frozen; the row stays pending and is asked again the first time it is loaded after the gap.
    ledger.recordCaptureTry({ fileStateId: row.id, changesSha256: got.changesSha256, ts: new Date((spacing.now ?? Date.now)()).toISOString() });
  } else if (got.changesSha256 !== undefined) {
    ledger.recordFileCapture({ fileStateId: row.id, state: "captured", connectorVersion: got.connectorVersion, connectorSpec: got.connectorSpec, changesSha256: got.changesSha256 });
  } else {
    ledger.recordFileCapture({ fileStateId: row.id, state: "failed", connectorVersion: got.connectorVersion, connectorSpec: got.connectorSpec, reason: `the connector '${connector}' could not read the change: ${got.failed ?? "it gave no change list"}`, ...(got.failedDetail === undefined ? {} : { detail: got.failedDetail }) });
  }
}

/**
 * A queued row the hook recorded with no connector is read with the built-in that claims its file today, only under the task lock (a sweep,
 * a round cut or a sign-off prune of the same task waits, and the sides cannot be deleted mid-read). Under the lock the row is read again: one another
 * process finished is left alone. A row whose sides are gone, or whose type no built-in claims now, gets "no change list was kept". Only the capture tables
 * are written. A lock that cannot be had leaves the row pending (the next load tries again).
 */
async function settleOldRow(ledger: Ledger, home: string, row: FileStateRow, timeoutMs: number, spacing: CaptureSpacing): Promise<void> {
  let held = false;
  try {
    await withTaskLocks(home, [row.taskId], async () => {
      held = true;
      const fresh = ledger.fileStatesForTask(row.taskId).find((r) => r.id === row.id);
      if (fresh === undefined || fresh.connector !== null || fresh.capture !== "pending") return;
      const connector = oldRowClaimsFor(home)(fresh.filePath);
      if (connector === undefined) return void ledger.recordFileCapture({ fileStateId: fresh.id, state: "failed", reason: NO_CLAIM_NOW });
      if (!sidesStored(home, fresh)) return void ledger.recordFileCapture({ fileStateId: fresh.id, state: "failed", reason: NO_LIST_KEPT });
      await askAndRecord(ledger, home, fresh, connector, timeoutMs, spacing);
    });
  } catch (e) {
    if (held) throw e;
    // the lock was not had: the row stays pending
  }
}

/**
 * Starts (or joins) the read of every pending row of a task. Resolves when they are all finished. Never throws.
 * The rows are read one at a time, in order. A connector may serialize its own work behind a cross-process lock; run at once, the later rows would spend
 * their diffMs (CoCheck's timer runs from each start) waiting on the earlier ones. One at a time, every row gets its whole diffMs, and each still ends by its own.
 */
export function settlePendingCaptures(ledger: Ledger, home: string, taskId: number, timeoutMs = 10_000, spacing: CaptureSpacing = {}): Promise<void> {
  let rows: FileStateRow[];
  try {
    rows = ledger.pendingCapturesForTask(taskId);
  } catch {
    return Promise.resolve();
  }
  return rows.reduce<Promise<void>>((prev, r) => prev.then(() => settleFileCapture(ledger, home, r, timeoutMs, spacing)), Promise.resolve());
}
