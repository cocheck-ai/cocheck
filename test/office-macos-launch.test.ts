// the Mac driver's launch proof with no screen helper (whole-second start times from `ps`). The launch's own clock has milliseconds and `ps` is floored, so a launch in
// the SAME second as `since` must still read as ours; before this, "Excel is open" was answered in 990 ms and a hidden Excel was left running. All process and clock reads are
// fakes (LaunchPrims): nothing here starts or reaches an app. macOS-only by name (it imports the Mac driver); the logic is pure.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { macOfficeDriver, startedByLaunch, type LaunchPrims } from "../src/office/connector/office-macos.ts";

process.env.COCHECK_ALLOW_REAL_OFFICE = "1"; // the guard() call only; every read below is a fake

/** A fake world: a clock the fake sleep advances, the app's pid appearing after `open`, and a start time read as the kernel/ps would give it. */
function world(o: { exact: boolean; startedAtOpen: (nowMs: number) => number; clockStart: number; person?: number }) {
  let now = o.clockStart;
  let opened = false, quit = 0;
  const prims: LaunchPrims = {
    pids: async () => (o.person !== undefined ? [o.person] : opened ? [4242] : []),
    startedAtExact: async (pid) => (!o.exact ? null : pid === process.pid ? 1 : o.startedAtOpen(now)),
    startedAt: async (pid) => Math.floor(o.startedAtOpen(now) / 1000) * 1000 + (pid === 0 ? 1 : 0),
    open: async () => { opened = true; return true; },
    now: () => now,
    sleep: async (ms) => { now += ms + 7; }, // a timer fires a few ms late: `since` then sits a few ms past the second boundary
  };
  return { driver: macOfficeDriver(prims), quits: () => quit, time: () => now };
}

describe("startedByLaunch", () => {
  it("exact start times compare as they are; whole-second ones compare second to second", () => {
    assert.equal(startedByLaunch(1_000.5, 1_000.9, true), false);
    assert.equal(startedByLaunch(1_001, 1_000.9, true), true);
    assert.equal(startedByLaunch(5_000, 5_400, false), true, "same second: ours");
    assert.equal(startedByLaunch(4_000, 5_400, false), false, "an earlier second: the person's");
    assert.equal(startedByLaunch(null, 5_400, false), false, "unreadable: not proof");
    assert.equal(startedByLaunch(null, 5_400, true), false);
  });
});

describe("macOfficeDriver.launch with no helper", () => {
  const app = OFFICE_APPS.excel;
  it("a launch in the same second as the launch's own clock is OURS: the pid is returned (so the app is later quit), never not-ours", async () => {
    // the app starts at once after `open`: its ps start time is the floored second of that moment, which is the second `since` was taken in
    const w = world({ exact: false, clockStart: 1_700_000_000_300, startedAtOpen: (n) => n });
    assert.equal(await w.driver.launch(app), 4242);
  });
  it("a process the person started in an earlier second is not ours, even with no helper", async () => {
    const w = world({ exact: false, clockStart: 1_700_000_000_300, startedAtOpen: (n) => n - 5_000 });
    assert.equal(await w.driver.launch(app), "not-ours");
  });
  it("an app already running at the gate is the person's, with or without the helper", async () => {
    assert.equal(await world({ exact: false, clockStart: 1_700_000_000_300, startedAtOpen: (n) => n, person: 99 }).driver.launch(app), "not-ours");
    assert.equal(await world({ exact: true, clockStart: 1_700_000_000_300, startedAtOpen: (n) => n, person: 99 }).driver.launch(app), "not-ours");
  });
  it("with the helper, the exact comparison still holds: a start before the launch's clock is not ours, one after it is", async () => {
    assert.equal(await world({ exact: true, clockStart: 1_700_000_000_300, startedAtOpen: (n) => n + 20 }).driver.launch(app), 4242);
    assert.equal(await world({ exact: true, clockStart: 1_700_000_000_300, startedAtOpen: (n) => n - 5 }).driver.launch(app), "not-ours");
  });
});
