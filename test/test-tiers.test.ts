import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverTests, selectTestArgs, tierArithmetic, SLOW_SUFFIX } from "../scripts/lib/test-tiers.ts";
import { acquirePortableLock, ancestorHoldsLockf } from "../scripts/lib/suite-lock.ts";

describe("test tiers", () => {
  it("the fast and slow sets together are exactly the full set, and every slow file is named by its suffix", () => {
    const t = discoverTests();
    assert.ok(t.slow.length > 0 && t.fast.length > 0);
    assert.ok(t.slow.every((f) => f.endsWith(SLOW_SUFFIX)));
    assert.ok(t.fast.every((f) => !f.endsWith(SLOW_SUFFIX)));
    assert.deepEqual([...t.fast, ...t.slow].sort(), t.all);
    assert.match(tierArithmetic(t), /^test files: fast \d+ \+ slow \d+ = \d+; full set \d+$/);
  });

  it("the arithmetic refuses a file that sits in neither tier", () => {
    assert.throws(() => tierArithmetic({ all: ["a.test.ts", "b.test.ts"], fast: ["a.test.ts"], slow: [] }), /do not add up/);
  });
});

describe("portable suite lock", () => {
  it("takes a free lock, and takes over a lock whose owner is dead", () => {
    const base = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    try {
      const dir = path.join(base, "lock.d");
      mkdirSync(dir);
      writeFileSync(path.join(dir, "pid"), "2147483646"); // no such process
      const release = acquirePortableLock(dir);
      assert.equal(existsSync(dir), true);
      release();
      assert.equal(existsSync(dir), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("waits while a live process holds the lock", () => {
    const base = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    try {
      const dir = path.join(base, "lock.d");
      const holder = path.resolve(import.meta.dirname, "..", "scripts", "lib", "suite-lock.ts");
      const code = `import { acquirePortableLock } from ${JSON.stringify(pathToFileURL(holder).href)}; acquirePortableLock(${JSON.stringify(dir)}); setTimeout(() => {}, 2500);`;
      const contender = `import { acquirePortableLock } from ${JSON.stringify(pathToFileURL(holder).href)}; const t = Date.now(); acquirePortableLock(${JSON.stringify(dir)}); console.log(Date.now() - t);`;
      const h = spawnSync(process.execPath, ["-e", `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["--input-type=module","-e",${JSON.stringify(code)}],{stdio:"inherit"});setTimeout(()=>{const r=require("node:child_process").spawnSync(process.execPath,["--input-type=module","-e",${JSON.stringify(contender)}],{encoding:"utf8"});console.log(r.stdout.trim());},600);`], { encoding: "utf8" });
      assert.ok(Number(h.stdout.trim().split("\n").pop()) >= 1000, `contender should have waited, got: ${h.stdout}${h.stderr}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// macOS-only: BSD `lockf` is the lock the runner and a hand run share.
describe("suite lock is skipped when the caller already holds it (macOS lockf)", { skip: spawnSync("lockf", [], { stdio: "ignore" }).error !== undefined && "needs lockf" }, () => {
  it("takeSuiteLock returns at once under `lockf -k <file>` instead of waiting on itself", () => {
    const base = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    try {
      const lockFile = path.join(base, "suite.lock");
      const holder = path.resolve(import.meta.dirname, "..", "scripts", "lib", "suite-lock.ts");
      const child = path.join(base, "child.ts");
      writeFileSync(child, `import { takeSuiteLock } from ${JSON.stringify(pathToFileURL(holder).href)}; takeSuiteLock(process.argv[1], [], ${JSON.stringify(lockFile)}); console.log("ran");`);
      // The short -t bounds the outer wait; the spawn timeout bounds a hang if the fix is missing.
      const run = spawnSync("lockf", ["-t", "5", "-k", lockFile, "sh", "-c", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(child)}`], { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", env: { ...process.env, COCHECK_SUITE_LOCK_HELD: "" } });
      assert.equal(run.stdout.trim(), "ran", `stderr: ${run.stderr} signal: ${run.signal}`);
    } finally {
      spawnSync("pkill", ["-9", "-f", base]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a lockf on a different file does not count as holding the lock", () => {
    assert.equal(ancestorHoldsLockf("/nonexistent/other.lock"), false);
  });
});

describe("runner file selection", () => {
  const tierFiles = ["test/a.test.ts", "test/b.test.ts", "test/c.slow.test.ts"];
  it("named files run alone, never plus the tier list (a targeted run must not become the full suite)", () => {
    assert.deepEqual(selectTestArgs(["test/b.test.ts"], tierFiles), ["test/b.test.ts"]);
    assert.deepEqual(selectTestArgs(["--test-name-pattern=x", "test/a.test.ts", "test/b.test.ts"], tierFiles), ["--test-name-pattern=x", "test/a.test.ts", "test/b.test.ts"]);
  });
  it("no named file runs the explicit tier list, never an empty list (node discovery would run connector fixtures)", () => {
    assert.deepEqual(selectTestArgs([], tierFiles), tierFiles);
    assert.deepEqual(selectTestArgs(["--test-reporter=tap"], tierFiles), ["--test-reporter=tap", ...tierFiles]);
    assert.ok(selectTestArgs([], tierFiles).length > 0);
  });
});
