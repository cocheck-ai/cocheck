import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { ensureReviewProcess, portFilePath, readPortFile, reviewLogPath } from "../src/review-server.ts";

const homes: string[] = [];
const pids = new Set<number>();

function newHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "cocheck-open-sandbox-"));
  homes.push(home);
  return home;
}

/** A long-lived process whose command line matches a review process (`review-process` in the script path) but serves nothing: alive and unreachable. */
function fakeReviewProcess(home: string): number {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-fake-"));
  homes.push(dir);
  const script = path.join(dir, "review-process.js");
  // The self-exit is a backstop for a runner killed before `after` runs.
  writeFileSync(script, "setInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), 120000);\n");
  const child = spawn(process.execPath, [script], { stdio: "ignore", env: { ...process.env, COCHECK_HOME: home } });
  pids.add(child.pid!);
  child.unref();
  return child.pid!;
}

function bystander(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  pids.add(child.pid!);
  return child.pid!;
}

/** A port nothing listens on, standing in for a loopback the sandbox blocks. */
const DEAD_PORT = 9;

function killAll(): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

// Synchronous, so it also runs when a test fails or the runner exits early.
process.on("exit", killAll);

after(async () => {
  killAll();
  for (const dir of homes) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); // Windows: the killed review process lets go of its ledger a moment after the kill
  }
});

describe("cocheck open when the loopback health check cannot connect", () => {
  it("uses the pid file: a live review process is reused, no second one starts", async () => {
    const home = newHome();
    const pid = fakeReviewProcess(home);
    writeFileSync(portFilePath(home), JSON.stringify({ pid, port: DEAD_PORT }));
    assert.equal(await ensureReviewProcess(home, 1500, undefined, async () => ({ errorCode: "EPERM" })), DEAD_PORT);
    assert.deepEqual(readPortFile(home), { pid, port: DEAD_PORT }, "the port file is untouched");
    assert.equal(existsSync(reviewLogPath(home)), false, "nothing was spawned");
  });

  it("EACCES counts as the sandbox error too", async () => {
    const home = newHome();
    const pid = fakeReviewProcess(home);
    writeFileSync(portFilePath(home), JSON.stringify({ pid, port: DEAD_PORT }));
    assert.equal(await ensureReviewProcess(home, 1500, undefined, async () => ({ errorCode: "EACCES" })), DEAD_PORT);
  });

  it("a live process whose listener refuses connections is replaced (ECONNREFUSED is not the sandbox)", async () => {
    const home = newHome();
    const pid = fakeReviewProcess(home);
    writeFileSync(portFilePath(home), JSON.stringify({ pid, port: DEAD_PORT }));
    const port = await ensureReviewProcess(home);
    pids.add(readPortFile(home)!.pid);
    assert.notEqual(port, DEAD_PORT);
    assert.notEqual(readPortFile(home)!.pid, pid, "a new process started");
  });

  it("a live process whose listener accepts but never answers (wedged) is replaced", async () => {
    const home = newHome();
    const pid = fakeReviewProcess(home);
    const socks = new Set<net.Socket>();
    const wedged = net.createServer((sock) => {
      socks.add(sock);
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => wedged.listen(0, "127.0.0.1", r));
    try {
      const wport = (wedged.address() as net.AddressInfo).port;
      writeFileSync(portFilePath(home), JSON.stringify({ pid, port: wport }));
      const port = await ensureReviewProcess(home);
      pids.add(readPortFile(home)!.pid);
      assert.notEqual(port, wport);
      assert.notEqual(readPortFile(home)!.pid, pid, "a new process started");
    } finally {
      socks.forEach((x) => x.destroy());
      await new Promise<void>((r) => wedged.close(() => r()));
    }
  });

  it("a home path with spaces is matched exactly, not by prefix", async () => {
    const parent = newHome();
    const spaced = path.join(parent, "my data");
    const prefix = path.join(parent, "my");
    mkdirSync(spaced);
    mkdirSync(prefix);
    const pid = fakeReviewProcess(spaced);
    writeFileSync(portFilePath(prefix), JSON.stringify({ pid, port: DEAD_PORT }));
    const port = await ensureReviewProcess(prefix, 8000, undefined, async () => ({ errorCode: "EPERM" }));
    pids.add(readPortFile(prefix)!.pid);
    assert.notEqual(port, DEAD_PORT, "the prefix home does not adopt the spaced home's process");
    assert.notEqual(readPortFile(prefix)!.pid, pid);
  });

  it("a home path with spaces still matches itself", async () => {
    const parent = newHome();
    const spaced = path.join(parent, "my data");
    mkdirSync(spaced);
    const pid = fakeReviewProcess(spaced);
    writeFileSync(portFilePath(spaced), JSON.stringify({ pid, port: DEAD_PORT }));
    assert.equal(await ensureReviewProcess(spaced, 1500, undefined, async () => ({ errorCode: "EPERM" })), DEAD_PORT);
  });

  it("starts a new process when the recorded one is truly absent", async () => {
    const home = newHome();
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => gone.once("exit", r));
    writeFileSync(portFilePath(home), JSON.stringify({ pid: gone.pid, port: DEAD_PORT }));
    const port = await ensureReviewProcess(home);
    pids.add(readPortFile(home)!.pid);
    assert.notEqual(port, DEAD_PORT);
    assert.notEqual(readPortFile(home)!.pid, gone.pid);
  });

  it("a stale pid file whose pid belongs to another process does not count as alive", async () => {
    const home = newHome();
    const pid = bystander();
    writeFileSync(portFilePath(home), JSON.stringify({ pid, port: DEAD_PORT }));
    const port = await ensureReviewProcess(home);
    pids.add(readPortFile(home)!.pid);
    assert.notEqual(port, DEAD_PORT);
    assert.notEqual(readPortFile(home)!.pid, pid, "a new process started");
  });

  it("a live review process serving another home does not count as alive", async () => {
    const home = newHome();
    const pid = fakeReviewProcess(newHome());
    writeFileSync(portFilePath(home), JSON.stringify({ pid, port: DEAD_PORT }));
    const port = await ensureReviewProcess(home);
    pids.add(readPortFile(home)!.pid);
    assert.notEqual(port, DEAD_PORT);
    assert.notEqual(readPortFile(home)!.pid, pid, "a new process started");
  });
});
