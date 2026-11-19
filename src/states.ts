import { plainSizeOf } from "./seal.ts";
import { readdirSync, rmdirSync, statSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { FileStateRow, Ledger } from "./ledger.ts";

/**
 * The per-task store of file states. Every state is a whole file at `<home>/tasks/<taskId>/states/<sha256>`,
 * written once per hash. The ledger's `file_states` rows say which file held which hash at which step; this module only
 * decides which stored bytes live on.
 *
 * Lifetime: the store lives across rounds. At sign-off the middle states drop and each file's first
 * and final state stay until the 30-day value expiry, then they are deleted. A task that is never signed off ends at the
 * 7-day idle expiry, which deletes the store. Size caps (per file, per task) are applied as states are written, by the
 * hook adapter, and are recorded the same way: a row in `state_removals` with the reason in words.
 */

/** Above this a file keeps its first and its current state only; the states between are hashes. */
export const STATE_FILE_CAP_BYTES = 25 * 1024 * 1024;
/** Past this the oldest middle states of a task drop to hashes. */
export const TASK_STORE_CAP_BYTES = 1024 * 1024 * 1024;
/** How long a signed task keeps each file's first and final state, from the sign-off. */
export const SIGNED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function storeDirOf(home: string, taskId: number): string {
  return path.join(home, "tasks", String(taskId), "states");
}

/** Where the rendered pictures of a task's states are cached. They hold values, so they live and die with their states. */
export function previewsDirOf(home: string, taskId: number): string {
  return path.join(home, "tasks", String(taskId), "previews");
}

/**
 * Where earlier versions kept calculated values for a task's states (sealed, `<sha>.json`). Nothing writes there any more, but a folder an
 * earlier version left holds values, so it still goes with its states.
 */
const calcDirOf = (home: string, taskId: number): string => path.join(home, "tasks", String(taskId), "calc");

/** Where the pictures the person pointed at (region notes) are kept, plain, one `<region id>.png` each. They hold values, so they live until the task's values expire. */
export function regionsDirOf(home: string, taskId: number): string {
  return path.join(home, "tasks", String(taskId), "regions");
}

/** Deletes every region picture of the task, and the folder. */
export async function removeRegions(home: string, taskId: number): Promise<void> {
  await rm(regionsDirOf(home, taskId), { recursive: true, force: true });
}

/** Deletes the cached pictures of these states (or, with no list, every cached picture of the task). */
export async function removePreviews(home: string, taskId: number, shas?: Iterable<string>): Promise<void> {
  const dir = previewsDirOf(home, taskId);
  const calc = calcDirOf(home, taskId);
  if (shas === undefined) {
    await rm(dir, { recursive: true, force: true });
    await rm(calc, { recursive: true, force: true });
    return;
  }
  const gone = new Set(shas);
  // Any calculated values an earlier version kept go with its bytes.
  for (const sha of gone) await rm(path.join(calc, `${sha}.json`), { force: true });
  try {
    // A cache file is `<sha>.png`, plus any `<sha>.png.<pid>.tmp` left by a render that was killed.
    for (const name of readdirSync(dir)) if (gone.has(name.slice(0, 64)) && /^[0-9a-f]{64}\.(png(\.\d+\.tmp)?|failed)$/.test(name)) await rm(path.join(dir, name), { force: true });
    rmdirSync(dir);
  } catch {
    // not there, or not empty
  }
}

/**
 * Makes sure the task's store folder exists and that `tasks/<id>` and `states` are both 0700. A recursive mkdir gives the
 * mode only to the last folder it creates, and `tasks/<id>` may already exist (the folder marker is written there), so each
 * level is made on its own and the two task folders are set explicitly.
 */
export async function ensureStoreDir(home: string, taskId: number): Promise<string> {
  const taskDir = path.join(home, "tasks", String(taskId));
  const states = storeDirOf(home, taskId);
  await mkdir(path.join(home, "tasks"), { recursive: true, mode: 0o700 });
  for (const dir of [taskDir, states]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  return states;
}

/** A size in words the page can show: bytes, KB or MB, whichever reads naturally. */
export function mbText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1048576) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / 1048576) * 10) / 10} MB`;
}

/**
 * Each file's first and last whole state of the task: the two a sign-off keeps. A connector row's before state (`prevSha256`) is the
 * first state of a subject whose first row is a connector row, so it stays with the after state (the page draws both sides).
 */
function endpointShas(rows: FileStateRow[]): Set<string> {
  const first = new Map<string, string>();
  const last = new Map<string, string>();
  const connectorBefore = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (!seen.has(r.filePath)) {
      seen.add(r.filePath);
      if (r.connector != null && r.prevSha256 !== null) connectorBefore.add(r.prevSha256);
    }
    if (r.kept !== "whole") continue;
    if (!first.has(r.filePath)) first.set(r.filePath, r.sha256);
    last.set(r.filePath, r.sha256);
  }
  return new Set([...first.values(), ...last.values(), ...connectorBefore]);
}

/** The hashes whose bytes are in the task's store right now (by listing the folder). */
export function storedShas(home: string, taskId: number): Map<string, number> {
  const out = new Map<string, number>();
  const dir = storeDirOf(home, taskId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    try {
      out.set(name, plainSizeOf(statSync(path.join(dir, name)).size));
    } catch {
      // gone between the listing and the stat
    }
  }
  return out;
}

async function drop(ledger: Ledger, home: string, taskId: number, shas: Iterable<string>, reason: string): Promise<void> {
  const list = [...shas];
  if (list.length === 0) return;
  // Recorded before the bytes go: a kill in between leaves bytes the record already calls gone, which a later prune removes.
  ledger.recordStateRemovals(taskId, list.map((sha256) => ({ sha256, reason })));
  for (const sha of list) await rm(path.join(storeDirOf(home, taskId), sha), { force: true });
  await removePreviews(home, taskId, list);
}

/**
 * Applies the lifetime rule to a closed task's store. `closure` is `closureOf`'s answer: signed (middle states drop at
 * once; first and final stay until `SIGNED_KEEP_MS` after the sign-off, then everything goes) or expired unsigned
 * (everything goes). An open task is never touched here. Must run inside the task's lock, like `pruneCopies`.
 */
export async function pruneStates(ledger: Ledger, taskId: number, closure: { kind: "signed" | "expired"; ts: string } | undefined, now: number): Promise<void> {
  if (!ledger.home || closure === undefined) return;
  const home = ledger.home;
  const stored = storedShas(home, taskId);
  // A cached picture is a rendered state: once its state is gone (or the task's values expire) the picture goes with it.
  const expiring = closure.kind === "expired" || now - Date.parse(closure.ts) >= SIGNED_KEEP_MS;
  if (expiring) await removePreviews(home, taskId);
  else await removePreviews(home, taskId, previewShas(home, taskId).filter((sha) => !stored.has(sha)));
  if (stored.size === 0) {
    removeEmptyStoreDir(home, taskId);
    return;
  }
  if (closure.kind === "expired") {
    await drop(ledger, home, taskId, stored.keys(), "the task was not signed off and went idle for 7 days, so its stored file states were deleted");
  } else if (now - Date.parse(closure.ts) >= SIGNED_KEEP_MS) {
    await drop(ledger, home, taskId, stored.keys(), "30 days after sign-off the stored file states were deleted; the record of what changed stays");
  } else {
    const keep = endpointShas(ledger.fileStatesForTask(taskId));
    await drop(ledger, home, taskId, [...stored.keys()].filter((sha) => !keep.has(sha)), "signed off: the states between each file's first and final state were deleted");
  }
  removeEmptyStoreDir(home, taskId);
}

function previewShas(home: string, taskId: number): string[] {
  try {
    return readdirSync(previewsDirOf(home, taskId)).flatMap((n) => (/^[0-9a-f]{64}\.(png|failed)/.test(n) ? [n.slice(0, 64)] : []));
  } catch {
    return [];
  }
}

/** Removes the task's store folder once it is empty. */
export function removeEmptyStoreDir(home: string, taskId: number): void {
  try {
    rmdirSync(storeDirOf(home, taskId));
  } catch {
    // Not empty, or already gone: nothing to do.
  }
}
