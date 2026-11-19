import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// arrowing through versions at key-repeat speed. The client holds back a step that follows another and aborts the ask in flight.

// The client's asker lives between two marker comments in review.js; it is run as is, with fake timers and a fake fetch.
describe("client asker (key repeat)", () => {
  const src = readFileSync(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
  function build(): { asker: any; runs: Array<{ key: string; low: boolean; signal: AbortSignal; done: (v: unknown) => void }>; clock: { advance: (ms: number) => void; t: number } } {
    const body = src.slice(src.indexOf("/* asker begin */"), src.indexOf("/* asker end */"));
    const ctx = vm.createContext({ AbortController });
    vm.runInContext(`${body}; this.makeAsker = makeAsker;`, ctx);
    const clock = { t: 1000, timers: [] as Array<{ at: number; f: () => void; id: number }>, id: 0, advance(ms: number) { this.t += ms; const due = this.timers.filter((x) => x.at <= this.t); this.timers = this.timers.filter((x) => x.at > this.t); due.forEach((x) => x.f()); } };
    const T = { now: () => clock.t, set: (f: () => void, ms: number) => { const id = ++clock.id; clock.timers.push({ at: clock.t + ms, f, id }); return id; }, clear: (id: number) => { clock.timers = clock.timers.filter((x) => x.id !== id); }, Ctl: AbortController };
    const runs: Array<{ key: string; low: boolean; signal: AbortSignal; done: (v: unknown) => void }> = [];
    const run = (rc: { key: string }, signal: AbortSignal, low: boolean): Promise<unknown> => new Promise((resolve, reject) => {
      runs.push({ key: rc.key, low, signal, done: resolve });
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const asker = (ctx as any).makeAsker(run, 150, T);
    return { asker, runs, clock: clock as never };
  }

  it("a burst at key-repeat speed asks the server only for the version where the keys settle", async () => {
    const { asker, runs, clock } = build();
    const answers: string[] = [];
    for (let i = 1; i <= 8; i++) {
      void asker.ask({ key: `v${i}` }).then((v: string) => answers.push(v), () => {});
      clock.advance(30); // key repeat
    }
    assert.deepEqual(runs.map((r) => r.key), ["v1"], "only the first press went out at once; v2..v8 were held back");
    assert.ok(runs[0]!.signal.aborted, "the first press's request was aborted by the next press");
    clock.advance(200); // the keys stopped on v8
    assert.deepEqual(runs.map((r) => r.key), ["v1", "v8"]);
    runs[1]!.done("v8");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(answers, ["v8"], "the version where the keys stopped is answered, and it is the only answer");
  });

  it("a slow press goes out at once, and neighbours are asked low priority one at a time until the next ask aborts them", async () => {
    const { asker, runs, clock } = build();
    void asker.ask({ key: "v5" }).catch(() => {});
    assert.deepEqual(runs.map((r) => [r.key, r.low]), [["v5", false]]);
    runs[0]!.done("ok");
    asker.prefetch([{ key: "v6" }, { key: "v4" }], () => false);
    assert.deepEqual(runs.map((r) => [r.key, r.low]), [["v5", false], ["v6", true]]);
    runs[1]!.done("ok");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(runs.map((r) => r.key), ["v5", "v6", "v4"]);
    clock.advance(500);
    void asker.ask({ key: "v9" }).catch(() => {});
    assert.ok(runs[2]!.signal.aborted, "a real ask aborts the neighbour fetch in flight");
    assert.deepEqual(runs.map((r) => r.key), ["v5", "v6", "v4", "v9"]);
  });

  it("neighbours already held in memory are not asked again", () => {
    const { asker, runs } = build();
    asker.prefetch([{ key: "a" }, { key: "b" }], (rc: { key: string }) => rc.key === "a");
    assert.deepEqual(runs.map((r) => r.key), ["b"]);
  });
});
