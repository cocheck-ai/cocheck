// One owner per OS user: an O_EXCL lockfile plus a heartbeat. No BSD lockf, no pid
// liveness probe (a stale heartbeat is the only takeover signal, so it is portable).
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface Clock {
  now(): number;
  /** Run fn once after ms; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};

interface LockBody { pid: number; token: string; beat: number }

export interface LockOptions {
  path: string;
  clock?: Clock;
  staleMs?: number; // a heartbeat older than this is abandoned (default 15 s)
  pid?: number;
}

export class OwnerLock {
  readonly token = randomUUID();
  private held = false;
  private readonly o: Required<LockOptions>;
  private constructor(o: Required<LockOptions>) { this.o = o; }

  /** Returns the lock if this process now owns it, else null. */
  static tryAcquire(opts: LockOptions): OwnerLock | null {
    const o = { clock: systemClock, staleMs: 15_000, pid: process.pid, ...opts } as Required<LockOptions>;
    const lock = new OwnerLock(o);
    if (lock.create()) return lock;
    const cur = readBody(o.path);
    // An unreadable body is treated as stale only if it is also absent of a recent beat: be conservative and keep it.
    if (cur && o.clock.now() - cur.beat > o.staleMs) {
      // Move the stale file aside, then race for O_EXCL. Declared limit: a fresh lock written between
      // our read and our rename can be moved aside (the window is two syscalls).
      const aside = `${o.path}.stale.${lock.token}`;
      try { renameSync(o.path, aside); } catch { return null; }
      try { unlinkSync(aside); } catch { /* leave it */ }
      if (lock.create()) return lock;
    }
    return null;
  }

  private body(): LockBody { return { pid: this.o.pid, token: this.token, beat: this.o.clock.now() }; }

  private create(): boolean {
    let fd: number;
    try { fd = openSync(this.o.path, "wx", 0o600); } catch { return false; }
    try { writeFileSync(fd, JSON.stringify(this.body())); } finally { closeSync(fd); }
    this.held = true;
    return true;
  }

  /** Refresh the heartbeat. Returns false (and drops ownership) if the file is no longer ours. */
  heartbeat(): boolean {
    if (!this.held) return false;
    const cur = readBody(this.o.path);
    if (!cur || cur.token !== this.token) { this.held = false; return false; }
    writeFileSync(this.o.path, JSON.stringify(this.body()), { mode: 0o600 });
    return true;
  }

  /** True while the file still carries our token and a fresh beat. */
  owns(): boolean {
    if (!this.held) return false;
    const cur = readBody(this.o.path);
    if (!cur || cur.token !== this.token) { this.held = false; return false; }
    return this.o.clock.now() - cur.beat <= this.o.staleMs;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    const cur = readBody(this.o.path);
    if (cur && cur.token === this.token) { try { unlinkSync(this.o.path); } catch { /* gone */ } }
  }
}

function readBody(path: string): LockBody | null {
  try {
    const b = JSON.parse(readFileSync(path, "utf8")) as LockBody;
    return typeof b.token === "string" && typeof b.beat === "number" ? b : null;
  } catch { return null; }
}
