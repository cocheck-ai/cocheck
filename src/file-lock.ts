import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { platform } from "./platform/index.ts";

/** Stable error code: the lock file stayed held by a live, fresh holder past `timeoutMs`. */
export const EXCEL_LOCK_TIMEOUT = "EXCEL_LOCK_TIMEOUT";

export interface FileLockOptions {
  /** A lock older than this is taken over even if its holder pid is alive (a hung holder). */
  staleMs?: number;
  /** How often a waiter re-checks the lock file. */
  pollMs?: number;
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /**
   * While held, rewrite the lock's `ts` this often (unref'd timer), so a live holder working past
   * `staleMs` is never taken over; only a dead pid is. A hung but live holder keeps the lock until its process exits; waiters
   * time out (180s for task locks). That trade is intended. Off by default.
   */
  heartbeatMs?: number;
  /** Create the lock's directory 0700 and the lock file 0600 (the file is never briefly wider). Off by default. */
  ownerOnly?: boolean;
  /** Test seam: awaited by each heartbeat between writing its tmp file and renaming it over the lock. */
  beforeHeartbeatRename?: () => Promise<void>;
}

/** Longer than any single job a lock guards. */
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_TIMEOUT_MS = DEFAULT_STALE_MS + 60_000;

interface LockContents {
  pid: number;
  ts: number;
  nonce: string;
}

const pidAlive = (pid: number): boolean => platform().process.alive(pid);

async function readLock(lockPath: string): Promise<LockContents | null | "gone"> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockContents>;
    return typeof parsed.pid === "number" && typeof parsed.ts === "number" ? (parsed as LockContents) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "gone";
    }
    // Unparseable: a holder mid-write, or garbage. Treated as stale only once it's old enough.
    return null;
  }
}

/**
 * Rewrites the lock with a fresh `ts`, only while the file is still ours; the swap is a rename, so a
 * reader never sees a half-written lock. `released` is checked right before the rename, and the tmp
 * file is removed whenever the swap is skipped or fails, so a release never leaves a lock behind.
 */
async function refresh(lockPath: string, mine: LockContents, ownerOnly: boolean, released: () => boolean, seam?: () => Promise<void>): Promise<void> {
  const held = await readLock(lockPath);
  if (released() || held === "gone" || held?.nonce !== mine.nonce) return;
  const tmp = `${lockPath}.beat-${mine.nonce}`;
  try {
    await writeFile(tmp, JSON.stringify({ ...mine, ts: Date.now() }), ownerOnly ? { mode: 0o600 } : {});
    await seam?.();
    if (released()) {
      await unlink(tmp).catch(() => {});
      return;
    }
    await rename(tmp, lockPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Acquires the lock file at `lockPath` (created exclusively, holding `{pid, ts, nonce}`), waiting
 * while another holder has it. A lock whose pid is dead, or older than `staleMs`, is stale and
 * taken over. Returns the release function, which removes the file only if it's still ours.
 *
 * The takeover renames the stale file aside before removing it, so two waiters that both judge
 * one lock stale can't both delete it; a waiter that reads a lock, sees it stale, and renames
 * a fresh lock written in between is the remaining (narrow) race, accepted for a single-user
 * local gateway.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  mkdirSync(path.dirname(lockPath), options.ownerOnly ? { recursive: true, mode: 0o700 } : { recursive: true });
  const mine: LockContents = { pid: process.pid, ts: Date.now(), nonce: randomBytes(12).toString("hex") };
  const deadline = Date.now() + timeoutMs;
  let unparseableSince: number | undefined;
  for (;;) {
    try {
      const handle = await (options.ownerOnly ? open(lockPath, "wx", 0o600) : open(lockPath, "wx"));
      mine.ts = Date.now();
      await handle.writeFile(JSON.stringify(mine));
      await handle.close();
      let beat: NodeJS.Timeout | undefined;
      let released = false;
      let inflight: Promise<void> | undefined;
      if (options.heartbeatMs !== undefined) {
        beat = setInterval(() => {
          if (inflight || released) return;
          inflight = refresh(lockPath, mine, options.ownerOnly === true, () => released, options.beforeHeartbeatRename)
            .catch(() => {})
            .finally(() => {
              inflight = undefined;
            });
        }, options.heartbeatMs);
        beat.unref();
      }
      return async () => {
        // Stop the heartbeat and wait out one already running, so it can't rename over a lock released (or re-taken) below.
        released = true;
        if (beat) clearInterval(beat);
        await inflight;
        const held = await readLock(lockPath);
        if (held !== "gone" && held?.nonce === mine.nonce) {
          await unlink(lockPath).catch(() => {});
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const held = await readLock(lockPath);
    if (held === "gone") {
      continue;
    }
    let stale: boolean;
    if (held === null) {
      unparseableSince ??= Date.now();
      stale = Date.now() - unparseableSince > Math.min(staleMs, 5_000);
    } else {
      unparseableSince = undefined;
      stale = !pidAlive(held.pid) || Date.now() - held.ts > staleMs;
    }
    if (stale) {
      const aside = `${lockPath}.stale-${mine.nonce}`;
      try {
        await rename(lockPath, aside);
        await unlink(aside).catch(() => {});
      } catch {
        // Someone else already took it over; loop and try again.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${EXCEL_LOCK_TIMEOUT}: another CoCheck process has held ${lockPath} for too long (pid ${held?.pid ?? "?"}).`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Runs `job` while holding the lock file at `lockPath`; always releases it. */
export async function withFileLock<T>(lockPath: string, job: () => Promise<T>, options?: FileLockOptions): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await job();
  } finally {
    await release();
  }
}
