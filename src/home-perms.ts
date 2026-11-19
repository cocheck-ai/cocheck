import { renameSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "./platform/index.ts";

/** Mode of every file under the CoCheck home: owner read/write only. */
export const FILE_MODE = 0o600;
/** Mode of every directory under the CoCheck home: owner only. */
export const DIR_MODE = 0o700;

/** Rename errors that mean another handle holds the target for a moment (Windows: a reader that opened it without share-delete, a virus scanner, the indexer), not a lasting refusal. */
const BUSY_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
/** How long a busy target is waited for before the rename's error is thrown. */
export const RENAME_RETRY_MS = 2000;

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Writes `text` to `file` owner-only through a temp file in the same folder, then renames it into place, so a reader never sees half a file.
 * Windows refuses to rename over a file another process has open at that instant (EPERM), and CoCheck's own readers poll these files, so a
 * busy target is retried for up to RENAME_RETRY_MS before the error is thrown; the temp file is removed when the rename finally fails.
 */
export function writeFileAtomicSync(file: string, text: string, pid: number = process.pid): void {
  const tmp = `${file}.${pid}.tmp`;
  writeFileSync(tmp, text, { mode: FILE_MODE });
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (!BUSY_RENAME.has((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // the rename's error is the one worth reporting
        }
        throw error;
      }
      pause(wait);
    }
  }
}

/**
 * Sets 0600 on every file and 0700 on every directory under `home`: the ledger with its WAL and
 * SHM files, `review.log`, `review-port`, `review-server.json`, the token and the task folders.
 * Symlinks are left alone. Best effort: a path that vanishes or can't be changed is skipped. Gives the failure text when the platform
 * could not finish (Windows icacls), else undefined; the caller says so.
 */
function hardenHomeSync(home: string, recursive = true): string | undefined {
  return platform().fsSecurity.ownerOnly(home, recursive);
}

/** hardenHomeSync, with a failure written to stderr where the user can see it. */
export function hardenHomeAndSay(home: string, recursive = true): void {
  const failure = hardenHomeSync(home, recursive);
  if (failure !== undefined) console.error(`cocheck: could not lock down the data folder: ${failure}`);
}

export async function hardenHome(home: string): Promise<void> {
  hardenHomeAndSay(home, true);
}
