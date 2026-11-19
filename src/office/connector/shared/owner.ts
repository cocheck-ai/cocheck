// The single Office owner for this OS user: holds the lock, beats on a timer, and
// gives up ownership the moment a beat finds the lock taken.
import { OwnerLock, systemClock, type Clock, type LockOptions } from "./lock.ts";

export interface OwnerOptions extends LockOptions {
  heartbeatMs?: number; // default 5 s; must be well under staleMs
}

export class OfficeOwner {
  private lock: OwnerLock | null = null;
  private cancelTimer: (() => void) | null = null;
  private readonly clock: Clock;
  private readonly heartbeatMs: number;

  private readonly opts: OwnerOptions;
  constructor(opts: OwnerOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.heartbeatMs = opts.heartbeatMs ?? 5_000;
  }

  /** Try to become the owner. Safe to call again from a follower. */
  tryBecomeOwner(): boolean {
    if (this.isOwner()) return true;
    this.lock = OwnerLock.tryAcquire(this.opts);
    if (this.lock) this.schedule();
    return this.lock !== null;
  }

  isOwner(): boolean {
    if (!this.lock) return false;
    if (!this.lock.owns()) { this.stopBeating(); this.lock = null; return false; }
    return true;
  }

  private schedule(): void {
    this.cancelTimer = this.clock.after(this.heartbeatMs, () => {
      let beat = false;
      try { beat = !!this.lock && this.lock.heartbeat(); } catch { beat = false; } // a failed beat gives up ownership, never throws from the timer
      if (beat) this.schedule();
      else { this.lock = null; this.cancelTimer = null; }
    });
  }

  private stopBeating(): void { this.cancelTimer?.(); this.cancelTimer = null; }

  release(): void {
    this.stopBeating();
    this.lock?.release();
    this.lock = null;
  }
}
