// The suite lock: one test run at a time on a machine (parallel runs overheat it and skew timings).
// Where BSD `lockf` exists (macOS) the runner re-executes itself under `lockf -k /tmp/cocheck-suite.lock`, the same lock a hand run takes.
// Elsewhere (Linux, Windows) it takes a portable lock: an atomically created directory in the temp dir holding the owner's pid, so a lock
// left by a dead process is detected and taken over. No dependency. `COCHECK_SUITE_LOCK_HELD` marks a process already holding the lock.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const LOCKF_FILE = "/tmp/cocheck-suite.lock";
const HELD = "COCHECK_SUITE_LOCK_HELD";

function haveLockf(): boolean {
  return spawnSync("lockf", [], { stdio: "ignore" }).error === undefined;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the portable lock, waiting for a live holder, and releases it when the process exits. */
export function acquirePortableLock(dir = path.join(tmpdir(), "cocheck-suite.lock.d")): () => void {
  const pidFile = path.join(dir, "pid");
  for (let waited = false; ; ) {
    try {
      mkdirSync(dir);
      writeFileSync(pidFile, String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner = NaN;
      try {
        owner = Number(readFileSync(pidFile, "utf8"));
      } catch {
        // The holder is between mkdir and writing its pid: give it a moment, then look again.
        sleepMs(200);
        try {
          owner = Number(readFileSync(pidFile, "utf8"));
        } catch {}
      }
      if (!Number.isInteger(owner) || !alive(owner)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (!waited) console.error(`suite lock held by pid ${owner}; waiting`);
      waited = true;
      sleepMs(1000);
    }
  }
  const release = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(1));
  return release;
}

/**
 * True when an ancestor process is a `lockf` holding `file`, e.g. `lockf -k /tmp/cocheck-suite.lock npm test`. That caller cannot set
 * COCHECK_SUITE_LOCK_HELD, and the lock is not re-entrant, so taking it again would wait on ourselves forever. Reads the process
 * table with `ps`, which exists wherever `lockf` does; a failed read answers false (the old behaviour).
 */
export function ancestorHoldsLockf(file = LOCKF_FILE, start = process.pid): boolean {
  let pid = start;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    const ps = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" });
    const line = ps.status === 0 ? ps.stdout.trim() : "";
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) return false;
    const words = m[2].split(/\s+/);
    if (path.basename(words[0]) === "lockf" && words.includes(file)) return true;
    pid = Number(m[1]);
  }
  return false;
}

/** Call first in the runner. Returns when this process holds the lock; when `lockf` exists it re-runs the script under it and exits. */
export function takeSuiteLock(script: string, args: string[], lockfFile = LOCKF_FILE): void {
  if (process.env[HELD]) return;
  if (haveLockf() && ancestorHoldsLockf(lockfFile)) {
    process.env[HELD] = "1";
    return;
  }
  const env = { ...process.env, [HELD]: "1" };
  if (haveLockf()) {
    const run = spawnSync("lockf", ["-k", lockfFile, process.execPath, script, ...args], { stdio: "inherit", env });
    process.exit(run.status ?? 1);
  }
  acquirePortableLock();
  process.env[HELD] = "1";
}
