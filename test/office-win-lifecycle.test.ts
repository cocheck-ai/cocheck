// the lifecycle ops (isRunning, launch, ready, documentCount, quit, procInfo) and the Node side
// (stageRoot, kill, alive, the owned-record file and its sweep). Every case runs on every OS against the fake JSON-lines host in "office" mode
// (test/fixtures/office-win/fake-host.mjs), which answers by office-win.ps1's rules on a simulated process table. No PowerShell, no Office.
// The Guards against: killing or driving the person's own Office (launch "two new pids" and "pre-existing pid", "ready only after
// proof", the quit gate cases, kill refusing an image or start-time mismatch, the sweep's "visible window" case) vs a hidden Office of ours
// left running after a connector died (the sweep's "connector dead, no window" case, and officePdfs calling the sweep before the gate).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { officePdfs } from "../src/office/connector/office-job.ts";
import { WinHost } from "../src/office/connector/office-win.ts";
import { lifecycleMethods, ownedRecordPath, type OwnedRecord } from "../src/office/connector/office-win-lifecycle.ts";
import { fakeDriver } from "./helpers/office-fake.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "office-win", "fake-host.mjs");
const xl = OFFICE_APPS.excel;
const SELF_START = 1_700_000_000_000;

interface Proc { pid: number; image: string; startedAtMs: number; visible?: boolean; goneAtMs?: number }
interface State { procs: Proc[]; spawnOnLaunch?: Record<string, { pid: number; startOffsetMs?: number }[]>; docs?: Record<string, number>; userControl?: Record<string, boolean>; unreadable?: number[]; apps?: Record<string, unknown>; log?: Array<Record<string, unknown>> }

function rig(state: Partial<State> = {}, tz?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  const stateFile = path.join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ procs: [{ pid: process.pid, image: "node", startedAtMs: SELF_START }], ...state, ...(state.procs ? { procs: [{ pid: process.pid, image: "node", startedAtMs: SELF_START }, ...state.procs] } : {}) }));
  const spawnFn = ((cmd: string, args: string[], opts: object) => spawn(cmd, args, { ...opts, env: { ...process.env, ...(tz ? { TZ: tz } : {}) } })) as unknown as typeof spawn;
  const host = new WinHost({ command: { command: process.execPath, args: [FAKE, "office", stateFile] }, spawnFn });
  const terminated: number[] = [];
  const life = lifecycleMethods(host, { terminate: (pid) => terminated.push(pid), env: { USERPROFILE: dir } });
  const read = (): State => JSON.parse(readFileSync(stateFile, "utf8"));
  const edit = (f: (s: State) => void): void => { const s = read(); f(s); writeFileSync(stateFile, JSON.stringify(s)); };
  const comLog = (): Array<Record<string, unknown>> => (read().log ?? []).filter((e) => "com" in e);
  return { dir, host, life, terminated, read, edit, comLog };
}

describe("Windows Office lifecycle", () => {
  it("stageRoot is %USERPROFILE%\\AppData\\Local\\CoCheck\\stage", async () => {
    const r = rig();
    assert.equal(r.life.stageRoot(), path.join(r.dir, "AppData", "Local", "CoCheck", "stage"));
    await r.host.close();
  });

  it("isRunning answers whether any process of the app's image runs", async () => {
    const r = rig({ procs: [{ pid: 7001, image: "WINWORD", startedAtMs: 5 }] });
    assert.equal(await r.life.isRunning(OFFICE_APPS.word), true);
    assert.equal(await r.life.isRunning(xl), false);
    await r.host.close();
  });

  it("launch, ours: exactly one new pid started after the launch began gives the pid; the owned record is written beside the lock", async () => {
    const r = rig({ spawnOnLaunch: { excel: [{ pid: 8001 }] } });
    await r.life.sweepOwned(xl, r.dir);
    assert.equal(await r.life.launch(xl), 8001);
    const rec = JSON.parse(readFileSync(ownedRecordPath(r.dir, "excel"), "utf8")) as OwnedRecord;
    const started = r.read().procs.find((p) => p.pid === 8001)!.startedAtMs;
    assert.deepEqual(rec, { pid: 8001, startedAtMs: started, image: "EXCEL", connectorPid: process.pid, connectorStartedAtMs: SELF_START });
    assert.deepEqual(r.comLog(), []);
    await r.host.close();
  });

  it("launch, none: no new pid gives null and the host releases the object", async () => {
    const r = rig();
    await r.life.sweepOwned(xl, r.dir);
    assert.equal(await r.life.launch(xl), null);
    assert.deepEqual(r.comLog(), [{ com: "released", app: "excel" }]);
    assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
    await r.host.close();
  });

  it("launch, two new pids: not ours; the object is released and nothing more is sent to it (ready refuses, no property set)", async () => {
    const r = rig({ spawnOnLaunch: { excel: [{ pid: 8001 }, { pid: 8002 }] } });
    await r.life.sweepOwned(xl, r.dir);
    assert.equal(await r.life.launch(xl), "not-ours");
    assert.equal(await r.life.ready(xl, Date.now() + 2_000), false);
    assert.deepEqual(r.comLog(), [{ com: "released", app: "excel" }]);
    assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
    await r.life.kill(8001);
    await r.life.kill(8002);
    assert.deepEqual(r.terminated, [], "a not-ours pid is never killed");
    await r.host.close();
  });

  it("launch, pre-existing pid: a new pid whose start time is before the launch began is not ours", async () => {
    const r = rig({ spawnOnLaunch: { excel: [{ pid: 8001, startOffsetMs: -5_000 }] } });
    assert.equal(await r.life.launch(xl), "not-ours");
    assert.equal(await r.life.ready(xl, Date.now() + 2_000), false);
    assert.deepEqual(r.comLog(), [{ com: "released", app: "excel" }]);
    await r.host.close();
  });

  it("ready only after proof: refused before launch; after a proven launch it hides the app, turns alerts off and force-disables macros", async () => {
    const r = rig({ spawnOnLaunch: { excel: [{ pid: 8001 }], powerpoint: [{ pid: 8101 }] } });
    assert.equal(await r.life.ready(xl, Date.now() + 2_000), false);
    assert.deepEqual(r.comLog(), []);
    assert.equal(await r.life.launch(xl), 8001);
    assert.equal(await r.life.ready(xl, Date.now() + 2_000), true);
    assert.deepEqual(r.comLog(), [{ com: "set", app: "excel", props: { Visible: false, DisplayAlerts: false, AutomationSecurity: 3 } }]);
    // PowerPoint's Application is not made invisible
    assert.equal(await r.life.launch(OFFICE_APPS.powerpoint), 8101);
    assert.equal(await r.life.ready(OFFICE_APPS.powerpoint, Date.now() + 2_000), true);
    assert.deepEqual(r.comLog().at(-1), { com: "set", app: "powerpoint", props: { DisplayAlerts: 1, AutomationSecurity: 3 } });
    await r.host.close();
  });

  it("documentCount answers the open documents of the launched app, null when not launched", async () => {
    const r = rig({ spawnOnLaunch: { excel: [{ pid: 8001 }] }, docs: { excel: 2 } });
    assert.equal(await r.life.documentCount(xl, 2_000), null);
    await r.life.launch(xl);
    assert.equal(await r.life.documentCount(xl, 2_000), 2);
    await r.host.close();
  });

  for (const gate of ["documents open", "UserControl true"] as const) {
    it(`quit gate, ${gate}: refused, the record is dropped and the app is never killed afterwards`, async () => {
      const r = rig({ spawnOnLaunch: { excel: [{ pid: 8001 }] }, ...(gate === "documents open" ? { docs: { excel: 1 } } : { userControl: { excel: true } }) });
      await r.life.sweepOwned(xl, r.dir);
      await r.life.launch(xl);
      await r.life.quit(xl, 2_000);
      assert.equal(r.comLog().some((e) => e.com === "quit"), false);
      assert.equal(r.read().procs.some((p) => p.pid === 8001), true);
      assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
      await r.life.kill(8001);
      assert.deepEqual(r.terminated, [], "an app the person took over is never killed");
      await r.host.close();
    });
  }

  it("quit with no documents and no UserControl quits, and the record is removed", async () => {
    const r = rig({ spawnOnLaunch: { excel: [{ pid: 8001 }] } });
    await r.life.sweepOwned(xl, r.dir);
    await r.life.launch(xl);
    assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), true);
    await r.life.quit(xl, 2_000);
    assert.equal(r.comLog().at(-1)?.com, "quit");
    assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
    await r.host.close();
  });

  it("kill checks image and start time through procInfo, terminates only a match, and removes the record", async () => {
    const r = rig({ spawnOnLaunch: { excel: [{ pid: 8001 }] } });
    await r.life.sweepOwned(xl, r.dir);
    await r.life.launch(xl);
    const started = r.read().procs.find((p) => p.pid === 8001)!.startedAtMs;
    await r.life.kill(8001, "KILL", started + 60_000);
    assert.deepEqual(r.terminated, [], "start-time mismatch refused");
    r.edit((s) => { s.procs.find((p) => p.pid === 8001)!.image = "notepad"; });
    await r.life.kill(8001, "KILL", started);
    assert.deepEqual(r.terminated, [], "image mismatch refused");
    r.edit((s) => { s.procs.find((p) => p.pid === 8001)!.image = "EXCEL"; s.unreadable = [8001]; });
    await r.life.kill(8001);
    assert.deepEqual(r.terminated, [], "an unreadable pid is refused");
    r.edit((s) => { s.unreadable = []; });
    assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), true);
    await r.life.kill(8001, "TERM");
    assert.deepEqual(r.terminated, [8001]);
    assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
    await r.host.close();
  });

  it("kill refuses a pid this driver never launched", async () => {
    const r = rig({ procs: [{ pid: 9001, image: "EXCEL", startedAtMs: 5 }] });
    await r.life.kill(9001, "KILL", 5);
    assert.deepEqual(r.terminated, []);
    await r.host.close();
  });

  describe("sweep (a second connector, run under another TZ)", () => {
    const record = (dir: string, rec: Partial<OwnedRecord> = {}): void =>
      writeFileSync(ownedRecordPath(dir, "excel"), JSON.stringify({ pid: 8001, startedAtMs: 1_700_000_100_000, image: "EXCEL", connectorPid: 990100, connectorStartedAtMs: 1_700_000_050_000, ...rec }));
    const office = (visible = false): Proc => ({ pid: 8001, image: "EXCEL", startedAtMs: 1_700_000_100_000, visible });

    it("connector dead, pid matches, no visible window: the hidden Office is killed and the record deleted", async () => {
      const r = rig({ procs: [office()] }, "Asia/Tokyo");
      record(r.dir);
      await r.life.sweepOwned(xl, r.dir);
      assert.deepEqual(r.terminated, [8001]);
      assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
      await r.host.close();
    });

    it("the terminated Office stays in the process table for a moment: the sweep waits for it, so the gate does not see it as running", async () => {
      const r = rig({ procs: [office()] }, "Asia/Tokyo");
      const life = lifecycleMethods(r.host, { terminate: (pid) => { r.terminated.push(pid); r.edit((s) => { for (const p of s.procs) if (p.pid === pid) p.goneAtMs = Date.now() + 400; }); }, env: { USERPROFILE: r.dir }, pollMs: 50 });
      record(r.dir);
      await life.sweepOwned(xl, r.dir);
      assert.deepEqual(r.terminated, [8001]);
      assert.equal(await life.isRunning(xl), false, "the gate must not answer pending for a process this sweep just ended");
      await r.host.close();
    });

    it("connector dead, pid matches, visible window: left alone, the record deleted", async () => {
      const r = rig({ procs: [office(true)] }, "Asia/Tokyo");
      record(r.dir);
      await r.life.sweepOwned(xl, r.dir);
      assert.deepEqual(r.terminated, []);
      assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
      await r.host.close();
    });

    it("start time or image mismatch: the record is deleted, nothing killed", async () => {
      for (const p of [{ ...office(), startedAtMs: 1_700_000_900_000 }, { ...office(), image: "notepad" }]) {
        const r = rig({ procs: [p] }, "Asia/Tokyo");
        record(r.dir);
        await r.life.sweepOwned(xl, r.dir);
        assert.deepEqual(r.terminated, []);
        assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
        await r.host.close();
      }
    });

    it("pid gone: the record is deleted, nothing killed", async () => {
      const r = rig({}, "Asia/Tokyo");
      record(r.dir);
      await r.life.sweepOwned(xl, r.dir);
      assert.deepEqual(r.terminated, []);
      assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), false);
      await r.host.close();
    });

    it("connector alive (same pid and start time), or its liveness unreadable: record and Office left alone", async () => {
      for (const extra of [{ procs: [office(), { pid: 990100, image: "node", startedAtMs: 1_700_000_050_000 }] }, { procs: [office(), { pid: 990100, image: "node", startedAtMs: 1_700_000_050_000 }], unreadable: [990100] }]) {
        const r = rig(extra, "Asia/Tokyo");
        record(r.dir);
        await r.life.sweepOwned(xl, r.dir);
        assert.deepEqual(r.terminated, []);
        assert.equal(existsSync(ownedRecordPath(r.dir, "excel")), true);
        await r.host.close();
      }
    });

    it("a connector pid reused by a process with another start time counts as dead", async () => {
      const r = rig({ procs: [office(), { pid: 990100, image: "node", startedAtMs: 1_700_000_999_000 }] }, "Asia/Tokyo");
      record(r.dir);
      await r.life.sweepOwned(xl, r.dir);
      assert.deepEqual(r.terminated, [8001]);
      await r.host.close();
    });
  });

  it("officePdfs calls the driver's sweepOwned under the lock, with the lock's folder, before the isRunning gate", async () => {
    const f = fakeDriver({ running: true });
    const order: string[] = [];
    const isRunning = f.driver.isRunning.bind(f.driver);
    f.driver.isRunning = async (app) => { order.push("isRunning"); return isRunning(app); };
    const lockPath = path.join(f.stageRoot, "office.lock");
    f.driver.sweepOwned = async (app, lockDir) => { order.push(`sweep ${app.key} ${lockDir} ${existsSync(lockPath)}`); };
    const j = await officePdfs(xl, [{ side: "after", file: import.meta.filename, name: "a.xlsx" }], { driver: f.driver, lockPath, deadline: Date.now() + 5_000, pollMs: 5 });
    assert.equal(j.pending, true);
    assert.deepEqual(order, [`sweep excel ${f.stageRoot} true`, "isRunning"]);
  });
});
