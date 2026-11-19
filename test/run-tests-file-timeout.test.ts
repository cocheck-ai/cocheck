// A test file whose process never ends cannot hold the run: `npm test` (scripts/run-tests.ts) ends that file's whole process tree at its time
// limit, fails it with a stated reason, and goes on. Windows CI runs 44198410073 and 44230614836 hit the 30-minute job cap this way: a teardown
// threw EBUSY before closing its review server, the file's process never exited, and every later file was cancelled.
// The fixture is the shape of that hang plus the Windows half: its test passes, then it leaves a server listening and a child running whose
// working folder is the temp home and which holds the file's output pipe. After the run, the child is gone and the home deletes with no retry
// (Windows refuses to remove a folder a live process works in).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

const FIXTURE = `import { test } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
const home = process.env.T_HANG_HOME;
test("passes, then leaves a child and a server running", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: home, stdio: "inherit" });
  writeFileSync(path.join(home, "child.pid"), String(child.pid));
  await new Promise((r) => http.createServer().listen(0, "127.0.0.1", r));
});
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

test("a hanging test file is ended with its process tree at the time limit, failed with a reason, and its temp home deletes", { timeout: 90_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "cocheck-hang-home-"));
  const fixture = path.join(home, "hang.test.mjs");
  writeFileSync(fixture, FIXTURE);
  // A nested run: the outer run's suite lock is already held (COCHECK_SUITE_LOCK_HELD), and the limit is short.
  // NODE_TEST_CONTEXT is this test process's own marker; inherited, it would make the nested `node --test` skip every file.
  const env: NodeJS.ProcessEnv = { ...process.env, T_HANG_HOME: home, COCHECK_TEST_FILE_TIMEOUT_MS: "4000", COCHECK_SUITE_LOCK_HELD: "1" };
  delete env.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, [path.join(ROOT, "scripts", "run-tests.ts"), fixture], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  runner.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
  runner.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
  // Before the time limit existed, this run never ended: the bound here is what makes that a failure instead of a hang.
  const status = await new Promise<number | "hung">((resolve) => {
    const t = setTimeout(() => {
      runner.kill("SIGKILL");
      // What the runner started may still hold these pipes; let go of them so this test fails instead of hanging too.
      runner.stdout.destroy();
      runner.stderr.destroy();
      resolve("hung");
    }, 45_000);
    runner.on("close", (code) => {
      clearTimeout(t);
      resolve(code ?? -1);
    });
  });
  const pidFile = path.join(home, "child.pid");
  const childPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
  try {
    assert.notEqual(status, "hung", `the run never finished:\n${out}`);
    assert.equal(status, 1, out);
    assert.match(out, /hang\.test\.mjs: TIMED OUT after 4 s; its process tree was ended/);
    assert.match(out, /ℹ files_timed_out 1/);
    assert.match(out, /ℹ fail 1/);
    assert.ok(childPid > 0, "the fixture started its child");
    for (const until = Date.now() + 3000; alive(childPid) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(childPid), false, "the child the hanging file started is gone");
    // No retry: a live process working in the home would make this throw EBUSY on Windows.
    rmSync(home, { recursive: true, force: true });
    assert.equal(existsSync(home), false);
  } finally {
    if (childPid > 0 && alive(childPid)) process.kill(childPid, "SIGKILL");
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
