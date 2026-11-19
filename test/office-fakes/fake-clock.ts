import type { Clock } from "../../src/office/connector/shared/lock.ts";

/** Deterministic clock: time moves only through advance(). */
export class FakeClock implements Clock {
  private t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now(): number { return this.t; }
  after(ms: number, fn: () => void): () => void {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return () => { this.timers = this.timers.filter((x) => x.id !== id); };
  }
  /** Move time forward, firing due timers in order (timers they set that fall in range also fire). */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
  get pending(): number { return this.timers.length; }
}

export const settle = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };
