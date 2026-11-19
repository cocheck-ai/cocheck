import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { acquireFileLock, withFileLock } from "../src/file-lock.ts";

const LOCK_MODULE = pathToFileURL(path.join(import.meta.dirname, "..", "src", "file-lock.ts")).href;

// Resolves when the child prints its first stdout chunk ("held"); rejects if the child exits or errors
// first, or after timeoutMs, so a broken child fails the test instead of hanging the run.
function waitForHeld(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (fn: () => void) => { clearTimeout(timer); child.stdout!.off("data", onData); child.off("exit", onExit); child.off("error", onError); fn(); };
    const onData = () => done(resolve);
    const onExit = (code: number | null, signal: string | null) => done(() => reject(new Error(`lock child exited before printing "held" (code ${code}, signal ${signal})`)));
    const onError = (err: Error) => done(() => reject(err));
    const timer = setTimeout(() => done(() => reject(new Error(`lock child did not print "held" within ${timeoutMs}ms`))), timeoutMs);
    child.stdout!.once("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}


async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cocheck-lock-test-"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cross-process Excel lock file", () => {
  it("makes a second holder in the same process wait until the first releases", async () => {
    const dir = await tempDir();
    const lock = path.join(dir, "excel.lock");
    const order: string[] = [];
    const first = withFileLock(lock, async () => {
      order.push("a-start");
      await sleep(150);
      order.push("a-end");
    }, { pollMs: 10 });
    await sleep(20);
    const second = withFileLock(lock, async () => {
      order.push("b-start");
      order.push("b-end");
    }, { pollMs: 10 });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
    assert.equal(existsSync(lock), false, "released lock file is removed");
    await rm(dir, { recursive: true, force: true });
  });

  it("releases the lock when the job throws", async () => {
    const dir = await tempDir();
    const lock = path.join(dir, "excel.lock");
    await assert.rejects(withFileLock(lock, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(lock), false);
    await rm(dir, { recursive: true, force: true });
  });

  it("recovers a stale lock whose holder pid is dead", async () => {
    const dir = await tempDir();
    const lock = path.join(dir, "excel.lock");
    // A pid far above any real one on macOS/Linux: not alive.
    await writeFile(lock, JSON.stringify({ pid: 2 ** 30, ts: Date.now(), nonce: "dead" }));
    const release = await acquireFileLock(lock, { pollMs: 10, timeoutMs: 2000 });
    const held = JSON.parse(await readFile(lock, "utf8"));
    assert.equal(held.pid, process.pid);
    await release();
    await rm(dir, { recursive: true, force: true });
  });

  it("recovers a lock older than the stale timeout even if its pid is alive", async () => {
    const dir = await tempDir();
    const lock = path.join(dir, "excel.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, ts: Date.now() - 60_000, nonce: "old" }));
    const release = await acquireFileLock(lock, { pollMs: 10, staleMs: 30_000, timeoutMs: 2000 });
    await release();
    await rm(dir, { recursive: true, force: true });
  });

  it("times out waiting on a live, fresh lock", async () => {
    const dir = await tempDir();
    const lock = path.join(dir, "excel.lock");
    const release = await acquireFileLock(lock);
    await assert.rejects(acquireFileLock(lock, { pollMs: 10, timeoutMs: 100 }), /EXCEL_LOCK_TIMEOUT/);
    await release();
    await rm(dir, { recursive: true, force: true });
  });

  it("serializes against a holder in another process", async () => {
    const dir = await tempDir();
    const lock = path.join(dir, "excel.lock");
    const script =
      `import { acquireFileLock } from ${JSON.stringify(LOCK_MODULE)};` +
      `const release = await acquireFileLock(${JSON.stringify(lock)});` +
      `process.stdout.write("held\\n");` +
      `await new Promise((r) => setTimeout(r, 300));` +
      `await release();`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    await waitForHeld(child);
    const start = Date.now();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await withFileLock(lock, async () => {
      assert.ok(Date.now() - start >= 200, `waited for the child's lock (${Date.now() - start}ms)`);
    }, { pollMs: 10 });
    await exited;
    await rm(dir, { recursive: true, force: true });
  });
});

