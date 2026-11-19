#!/usr/bin/env node
/**
 * The standalone review process: serves the review page for `$COCHECK_HOME`'s ledger (see
 * `review-server.ts`) and keeps running after whatever started it exits. Single-instance: a
 * second start finds the live one through `review-server.lock` / `review-server.json` in the
 * data directory and exits 0 without binding. Stops on SIGTERM/SIGINT, or when its port file
 * is removed or points elsewhere.
 */
import path from "node:path";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform } from "./platform/index.ts";
import { hardenHomeAndSay, writeFileAtomicSync } from "./home-perms.ts";
import { openLedger, resolveCoCheckHome } from "./ledger.ts";
import { TaskStore } from "./tasks.ts";
import {
  lockFilePath,
  portFilePath,
  preferredPortFilePath,
  readOrCreateToken,
  readPortFile,
  readPreferredPort,
  HEARTBEAT_INTERVAL_MS,
  heartbeatFilePath,
  heartbeatShowsLive,
  installReviewLogWriter,
  reviewHealthy,
  startReviewServer,
  writeHeartbeat,
} from "./review-server.ts";

const alive = (pid: number): boolean => platform().process.alive(pid);

/** A lock with no live review process behind it is reclaimed once it is this old (a start takes well under a second). */
const STALE_LOCK_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Takes the start lock, or returns false because a live instance holds it (or is starting). */
async function acquireLock(home: string): Promise<boolean> {
  const lock = lockFilePath(home);
  for (let attempt = 0; attempt < 140; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      writeFileSync(lock, String(process.pid));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const recorded = readPortFile(home);
    if (recorded && (await reviewHealthy(recorded.port, home))) {
      return false;
    }
    let holder = NaN;
    try {
      holder = Number(readFileSync(lock, "utf8"));
    } catch {
      // released between the open and the read
    }
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      // released between the read and the stat
    }
    // A holder that is this home's live review process (the port file names it and its heartbeat is fresh) keeps the lock however long
    // it has held it: it is serving, only too busy to answer the health request in time. Taking its lock started a second process that
    // crashed renaming over the port file the first one was reading (Windows EPERM).
    if (recorded && recorded.pid === holder && heartbeatShowsLive(home, recorded)) {
      return false;
    }
    // A dead holder is stale at once; a live one only if it has held the lock for a while without
    // becoming this home's live review process (its pid was reused by something unrelated, or it stopped beating).
    if ((Number.isInteger(holder) && holder > 0 && !alive(holder)) || ageMs > STALE_LOCK_MS) {
      rmSync(lock, { force: true });
    } else {
      await sleep(50);
    }
  }
  return false;
}

async function main(): Promise<void> {
  // Everything this process creates under the home is owner-only.
  process.umask(0o077);
  const home = resolveCoCheckHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Before any data file is read: a Windows home can hold files with an empty ACL, and the token read below would fail on them.
  hardenHomeAndSay(home, true);
  // stderr goes to review.log through a size-checked writer, so the log rotates while this process lives.
  installReviewLogWriter(process.stderr, home);
  const token = readOrCreateToken(home);
  if (!(await acquireLock(home))) {
    return;
  }
  // The lock is ours: a stale port file (nothing answered above) is overwritten below.
  const ledger = openLedger(home);
  new TaskStore(ledger, home, []).startSweeps();
  let preferred = 0;
  try {
    preferred = readPreferredPort(home);
  } catch {
    // first start: no port recorded yet
  }
  let stopFn = () => {};
  const { server, port, viewPort } = await startReviewServer(ledger, token, home, preferred, () => stopFn());
  if (preferred === 0) {
    writeFileSync(preferredPortFilePath(home), `${port}\n`);
  }
  // The connector view origin's port, recorded beside review-port (it is a fresh port each run, so this is informational).
  writeFileSync(path.join(home, "review-view-port"), `${viewPort}\n`);
  const portFile = portFilePath(home);
  writeFileAtomicSync(portFile, JSON.stringify({ pid: process.pid, port }));
  let stopping = false;
  // The heartbeat lets a sandboxed `cocheck open` (no loopback, no ps) tell this process is alive.
  const beat = () => {
    if (stopping || readPortFile(home)?.pid !== process.pid) {
      return;
    }
    try {
      writeHeartbeat(home, port);
    } catch {
      // a missed beat only makes the next caller fall back to the old path
    }
  };
  beat();
  setInterval(beat, HEARTBEAT_INTERVAL_MS).unref();

  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    // A file Windows will not let go of (EPERM, a lock held elsewhere) must not crash the stop: log it and finish closing.
    const tryRemove = (file: string) => {
      try {
        rmSync(file, { force: true });
      } catch (error) {
        console.error(`cocheck: review process could not remove ${file}: ${(error as Error).message}`);
      }
    };
    if (readPortFile(home)?.pid === process.pid) {
      tryRemove(portFile);
      tryRemove(heartbeatFilePath(home));
    }
    tryRemove(lockFilePath(home));
    server.closeAllConnections();
    server.close(() => {
      ledger.close();
      process.exit(0);
    });
  };
  stopFn = stop;
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Orphan guard: if the data directory is wiped or another instance took over, step down.
  setInterval(() => {
    if (readPortFile(home)?.pid !== process.pid) {
      stop();
    }
  }, 2000).unref();
}

main().catch((error) => {
  console.error("cocheck review: fatal error", error);
  process.exit(1);
});
