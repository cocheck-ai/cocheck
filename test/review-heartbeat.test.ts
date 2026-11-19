import { posixOnly } from "./helpers/platform.ts";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  ensureReviewProcess,
  heartbeatFilePath,
  HEARTBEAT_MAX_AGE_MS,
  lockFilePath,
  portFilePath,
  readHeartbeat,
  readPortFile,
  reviewLogPath,
  reviewProcessArgs,
  writeHeartbeat,
} from "../src/review-server.ts";

const homes: string[] = [];
const pids = new Set<number>();
const DEAD_PORT = 9;
const SANDBOX = async () => ({ errorCode: "EPERM" });

function newHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "cocheck-heartbeat-"));
  homes.push(home);
  return home;
}

/** A live process whose command line is NOT a review process, so only the heartbeat can vouch for it (ps cannot). */
function bystander(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),120000)"], { stdio: "ignore" });
  child.unref();
  pids.add(child.pid!);
  return child.pid!;
}

async function deadPid(): Promise<number> {
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => gone.once("exit", r));
  return gone.pid!;
}

function killAll(): void {
  // Also whatever a home's port file names: a spawn whose test failed before it was tracked.
  for (const home of homes) {
    const rec = readPortFile(home);
    if (rec && rec.pid !== process.pid) {
      pids.add(rec.pid);
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}
process.on("exit", killAll);

after(async () => {
  killAll();
  for (const dir of homes) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); // Windows: the killed review process lets go of its ledger a moment after the kill
  }
});

function record(home: string, pid: number, port = DEAD_PORT): void {
  writeFileSync(portFilePath(home), JSON.stringify({ pid, port }));
}

function beat(home: string, pid: number, over: Partial<{ port: number; home: string; at: number }> = {}, atNow = Date.now()): void {
  writeHeartbeat(home, over.port ?? DEAD_PORT, pid, over.at ?? atNow);
  if (over.home !== undefined) {
    const b = readHeartbeat(home)!;
    writeFileSync(heartbeatFilePath(home), JSON.stringify({ ...b, home: over.home }));
  }
}

describe("cocheck open trusts a fresh heartbeat when the sandbox blocks loopback", () => {
  it("fresh heartbeat naming this home and port, live pid: reused, nothing spawned", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid);
    assert.equal(await ensureReviewProcess(home, 1500, undefined, SANDBOX), DEAD_PORT);
    assert.equal(existsSync(reviewLogPath(home)), false, "nothing was spawned");
    assert.deepEqual(readPortFile(home), { pid, port: DEAD_PORT });
  });

  it("EACCES counts too", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid);
    assert.equal(await ensureReviewProcess(home, 1500, undefined, async () => ({ errorCode: "EACCES" })), DEAD_PORT);
  });

  it("our own pid answers signal 0 with ok (no sandbox): still alive", async () => {
    const home = newHome();
    record(home, process.pid);
    beat(home, process.pid);
    assert.equal(await ensureReviewProcess(home, 1500, undefined, SANDBOX), DEAD_PORT);
  });

  async function replaced(home: string, oldPid: number, probe = SANDBOX): Promise<void> {
    const port = await ensureReviewProcess(home, 8000, undefined, probe);
    pids.add(readPortFile(home)!.pid);
    assert.notEqual(port, DEAD_PORT);
    assert.notEqual(readPortFile(home)!.pid, oldPid, "a new process started");
  }

  it("a stale heartbeat whose pid was reused by a live process does not count", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid, { at: Date.now() - HEARTBEAT_MAX_AGE_MS - 1000 });
    await replaced(home, pid);
  });

  it("a heartbeat just inside the limit counts, just past it does not", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid, { at: Date.now() - (HEARTBEAT_MAX_AGE_MS - 3000) });
    assert.equal(await ensureReviewProcess(home, 1500, undefined, SANDBOX), DEAD_PORT);
  });

  it("a fresh heartbeat whose pid is gone (ESRCH) does not count", async () => {
    const home = newHome();
    const pid = await deadPid();
    record(home, pid);
    beat(home, pid);
    await replaced(home, pid);
  });

  it("a heartbeat naming another port does not count", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid, { port: DEAD_PORT + 1 });
    await replaced(home, pid);
  });

  it("a heartbeat naming another home does not count", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid, { home: path.join(tmpdir(), "some-other-cocheck-home") });
    await replaced(home, pid);
  });

  it("a heartbeat naming another pid than the port file does not count", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, bystander());
    await replaced(home, pid);
  });

  it("a fresh heartbeat does not excuse a refused connect (not a sandbox error)", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid);
    await replaced(home, pid, async () => ({ errorCode: "ECONNREFUSED" }));
  });

  it("a garbage heartbeat file does not count", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    writeFileSync(heartbeatFilePath(home), "{not json");
    await replaced(home, pid);
  });
});

// A second `cocheck open` on Windows started a second review process beside a live one that was too busy to answer /health within a
// second; that process took the live one's start lock and crashed renaming over review-server.json (EPERM). A busy process with a fresh
// heartbeat is waited for, and its lock is never taken.
describe("a live review process that is too busy to answer in time", () => {
  const TIMEOUT = async () => ({});

  it("a health probe that times out while the heartbeat is fresh: waited for, its port used, nothing spawned", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid);
    assert.equal(await ensureReviewProcess(home, 1500, undefined, TIMEOUT), DEAD_PORT);
    assert.equal(existsSync(reviewLogPath(home)), false, "nothing was spawned");
    assert.deepEqual(readPortFile(home), { pid, port: DEAD_PORT });
  });

  it("one that answers on a later probe is used as it is", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid);
    let probes = 0;
    const late = async () => (++probes < 3 ? {} : { health: { build: "same", builtAt: Number.MAX_SAFE_INTEGER } });
    assert.equal(await ensureReviewProcess(home, 5000, undefined, late), DEAD_PORT);
    assert.equal(probes, 3);
    assert.equal(existsSync(reviewLogPath(home)), false, "nothing was spawned");
  });

  it("a timeout with a stale heartbeat still starts a new process (a wedged or dead one is replaced)", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid, { at: Date.now() - HEARTBEAT_MAX_AGE_MS - 1000 });
    const port = await ensureReviewProcess(home, 8000, undefined, TIMEOUT);
    pids.add(readPortFile(home)!.pid);
    assert.notEqual(port, DEAD_PORT);
    assert.notEqual(readPortFile(home)!.pid, pid, "a new process started");
  });

  it("a review process started beside it leaves its start lock alone, however old, and exits 0 without taking over", async () => {
    const home = newHome();
    const pid = bystander();
    record(home, pid);
    beat(home, pid);
    writeFileSync(lockFilePath(home), String(pid));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFilePath(home), old, old);
    const entry = path.join(import.meta.dirname, "..", "src", "review-process.ts");
    const child = spawn(process.execPath, reviewProcessArgs(entry, home), { stdio: "ignore", env: { ...process.env, COCHECK_HOME: home } });
    pids.add(child.pid!);
    const code = await new Promise<number | null | "running">((resolve) => {
      const t = setTimeout(() => resolve("running"), 10_000);
      child.once("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    assert.equal(code, 0, "the second start exits 0");
    assert.deepEqual(readPortFile(home), { pid, port: DEAD_PORT }, "the port file still names the live process");
    assert.equal(readFileSync(lockFilePath(home), "utf8"), String(pid), "the lock is still the live process's");
  });
});

describe("the heartbeat file", () => {
  it("writeHeartbeat is atomic: no temp file is left and the record round-trips", () => {
    const home = newHome();
    writeHeartbeat(home, 4321, 77, 1234);
    const b = readHeartbeat(home)!;
    assert.equal(b.pid, 77);
    assert.equal(b.port, 4321);
    assert.equal(b.at, 1234);
    assert.deepEqual(readdirSync(home).filter((f) => f.endsWith(".tmp")), []);
  });

  it("a real review process writes it at start and removes it when it stops", posixOnly("SIGTERM is a hard kill on Windows, so the shutdown handler that removes the heartbeat file never runs"), async () => {
    const home = newHome();
    const port = await ensureReviewProcess(home);
    const rec = readPortFile(home)!;
    pids.add(rec.pid);
    const b = readHeartbeat(home)!;
    assert.equal(b.pid, rec.pid);
    assert.equal(b.port, port);
    assert.ok(Date.now() - b.at < HEARTBEAT_MAX_AGE_MS);
    process.kill(rec.pid, "SIGTERM");
    for (let i = 0; i < 100 && existsSync(heartbeatFilePath(home)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(existsSync(heartbeatFilePath(home)), false);
  });
});
