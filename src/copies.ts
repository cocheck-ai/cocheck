import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { isKeyMissing, sha256OfSealed } from "./seal.ts";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Ledger, SnapshotRow } from "./ledger.ts";
import { readFolderMarker } from "./tasks.ts";
import { closureOf } from "./signoff.ts";
import { pruneStates } from "./states.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { acquireFileLock, type FileLockOptions } from "./file-lock.ts";

/**
 * How many file copies a task keeps. `open`: the latest copy of every file (the next round diffs
 * against it). `final`: the latest copy of each touched file, so a reviewer can still cut a round.
 * `closed`: none (signed off or expired).
 *
 * These are the round copies (diff bases). The hook adapter's per-step states live in `tasks/<id>/states/` and follow `states.ts`.
 */
type CopyPolicy = "open" | "final" | "closed";

/** Each file's most recent snapshot, in the order files joined the task. */
function latestSnapshots(snapshots: SnapshotRow[]): SnapshotRow[] {
  const byFile = new Map<string, SnapshotRow>();
  for (const s of snapshots) byFile.set(s.filePath, s);
  return [...byFile.values()];
}

/**
 * Deletes the file copies `policy` doesn't keep, and records that they are gone (the snapshot rows,
 * with their hashes, stay). A copy that can't be deleted stays recorded as kept, so a later sweep tries again.
 */
export async function pruneCopies(ledger: Ledger, taskId: number, policy: CopyPolicy, now: number = Date.now()): Promise<void> {
  // Runtime guard (not a source scan: it also catches a new call path added later). A ledger with no home has no lock to take.
  if (ledger.home && !heldTaskLocks.getStore()?.has(taskId)) {
    throw new Error(`pruneCopies(task ${taskId}) must run inside withTaskLocks: the task lock is not held.`);
  }
  // A row from before v10 has no hash, and its copy is the only proof of the file's state then: hash it before anything is deleted.
  for (const s of ledger.snapshotsForTask(taskId)) {
    if (s.sha256 === null && !s.removed && s.mode !== "missing" && s.snapshotPath !== "" && existsSync(s.snapshotPath)) {
      try {
        ledger.backfillSnapshotHash(s.id, await sha256Of(s.snapshotPath));
      } catch (error) {
        if (isKeyMissing(error)) throw error;
        // unreadable: the copy stays, below
      }
    }
  }
  const snapshots = ledger.snapshotsForTask(taskId);
  const protectedPaths = new Set<string>();
  const keep = new Set<number>();
  if (policy !== "closed") {
    let latest = latestSnapshots(snapshots);
    if (policy === "final") {
      const baselineOnly = new Set(ledger.home ? (readFolderMarker(ledger.home, taskId).folderOnly ?? []) : []);
      const touched = new Set(ledger.reviewRowsForTask(taskId).map((r) => r.filePath));
      latest = latest.filter((s) => !baselineOnly.has(s.filePath) || touched.has(s.filePath));
    }
    for (const s of latest) keep.add(s.id);
  }
  const gone: number[] = [];
  for (const s of snapshots) {
    if (s.removed || keep.has(s.id)) continue;
    // Never delete a copy whose row still has no hash: with neither, the file's earlier state would be unknown.
    if (s.sha256 === null && s.mode !== "missing" && s.snapshotPath !== "" && existsSync(s.snapshotPath)) {
      protectedPaths.add(s.snapshotPath);
      continue;
    }
    if (s.snapshotPath !== "") {
      try {
        await rm(s.snapshotPath, { force: true });
      } catch {
        continue;
      }
    }
    gone.push(s.id);
  }
  ledger.markCopiesRemoved(gone);
  if (ledger.home && policy === "closed") await removeOrphans(path.join(ledger.home, "tasks", String(taskId)), protectedPaths);
  // The per-step file states follow their own lifetime rule, not the round copies' (the round-copy rules are retired for them).
  if (policy === "closed") await pruneStates(ledger, taskId, closureOf(ledger, taskId), now);
  if (ledger.home && gone.length > 0) removeEmptyDirs(path.join(ledger.home, "tasks", String(taskId)));
}

/** A closed task keeps no file copies at all: removes whatever the ledger doesn't know of (old layouts, aborted rounds), except the folder marker. */
async function removeOrphans(taskDir: string, protectedPaths: Set<string>): Promise<void> {
  let entries;
  try {
    entries = readdirSync(taskDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(taskDir, e.name);
    if (e.isDirectory() && (e.name === "states" || e.name === "regions" || e.name === "changes" || e.name === "calls")) continue; // the per-step store: states.ts decides what lives on; the pictures the person pointed at, the frozen change lists (changes/) and the kept MCP calls (calls/) live until the values expire (tasks.ts)
    if (e.isDirectory()) {
      await removeOrphans(full, protectedPaths);
    } else if (e.name !== "folder.json" && !protectedPaths.has(full)) {
      await rm(full, { force: true }).catch(() => {});
    }
  }
}

/** Removes the empty round folders under a task folder (never the folder marker or the task folder itself). */
function removeEmptyDirs(taskDir: string): void {
  let names: string[];
  try {
    names = readdirSync(taskDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      rmdirSync(path.join(taskDir, name));
    } catch {
      // not empty
    }
  }
}

async function sha256Of(file: string): Promise<string> {
  return sha256OfSealed(file);
}

/** The task ids whose lock the running async chain holds; `pruneCopies` checks it. */
const heldTaskLocks = new AsyncLocalStorage<Set<number>>();

/**
 * Runs `job` holding one exclusive lock file per task (taken in id order, so two callers never wait
 * on each other). Cutting a round reads the task's previous copies; recording a round, a sweep and a
 * sign-off prune them; the reviewer process and the gateway each do both, so the exclusion has to
 * cross processes. The locks live in `<home>/locks/`, outside the task folders, which a closed
 * task's prune empties.
 */
export async function withTaskLocks<T>(
  home: string,
  taskIds: number[],
  job: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const releases: Array<() => Promise<void>> = [];
  const ids = [...new Set(taskIds)].sort((a, b) => a - b);
  try {
    for (const id of ids) {
      // Heartbeat: a live holder (a slow snapshot, a wait on an app lock) refreshes the lock, so staleMs only ever frees a hung or dead one.
      releases.push(
        await acquireFileLock(path.join(home, "locks", `task-${id}.lock`), {
          staleMs: 120_000,
          timeoutMs: 180_000,
          heartbeatMs: 15_000,
          ownerOnly: true,
          ...options,
        }),
      );
    }
    return await heldTaskLocks.run(new Set([...(heldTaskLocks.getStore() ?? []), ...ids]), job);
  } finally {
    for (const release of releases.reverse()) await release();
  }
}
