// every-OS part. The host stop goes through fix/win-ci-hangs' endChild on the host child this
// process spawned (a tree kill on Windows is fine there: the host is our own child). Office kills stay single-pid: on fix/win-ci-hangs
// platform().process.terminate became taskkill /T /F on Windows, so the lifecycle's default stop must never call it (never /T).
// No Office and no PowerShell start here; the stubs below stand in for the host, and the processes killed are node children this file spawned.
// The Guards against: an Office kill that ends Office's whole tree (the lifecycle cases below) vs a host stop that reaches anything but our child.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { WinHost, stopHost } from "../src/office/connector/office-win.ts";
import { killOnePid, lifecycleMethods, ownedRecordPath } from "../src/office/connector/office-win-lifecycle.ts";
import { platform } from "../src/platform/index.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "office-win", "fake-host.mjs");
const excel = OFFICE_APPS.excel;

/** platform().process.terminate replaced by a recorder for the length of `use`. */
async function withTerminateSpy<T>(use: (calls: unknown[]) => Promise<T>): Promise<T> {
  const proc = platform().process as { terminate: (pid: number) => void };
  const orig = proc.terminate;
  const calls: unknown[] = [];
  proc.terminate = (pid: number) => {
    calls.push(pid);
  };
  try {
    return await use(calls);
  } finally {
    proc.terminate = orig;
  }
}

const idle = (): ChildProcess => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const exitedWithin = (child: ChildProcess, ms: number): Promise<boolean> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), ms);
        child.once("exit", () => {
          clearTimeout(t);
          resolve(true);
        });
      });

/** A host stand-in: launch proves `pid`, procInfo answers `info(pid)`. */
function stubHost(launchPid: number, info: (pid: number) => Record<string, unknown>): WinHost {
  return {
    call: async (op: string, args: Record<string, unknown> = {}) => {
      if (op === "launch") return { ok: true, pid: launchPid, startedAtMs: 1_000 };
      if (op === "procInfo") return { ok: true, ...info(Number(args.pid)) };
      return { ok: false, why: `unexpected op ${op}` };
    },
  } as unknown as WinHost;
}

describe("the host stop uses endChild; Office kills stay single-pid", () => {
  it("stopHost goes through endChild on the child itself: the tree kill on Windows, child.kill elsewhere", async () => {
    await withTerminateSpy(async (calls) => {
      const killed: unknown[] = [];
      const child = { pid: 424242, exitCode: null, signalCode: null, kill: (s?: NodeJS.Signals) => (killed.push(s), true) };
      stopHost(child);
      if (process.platform === "win32") {
        assert.deepEqual(calls, [424242], "Windows: platform().process.terminate (taskkill /T /F) on our own child's pid");
        assert.deepEqual(killed, []);
      } else {
        assert.deepEqual(killed, ["SIGTERM"], "elsewhere: child.kill, as endChild does");
        assert.deepEqual(calls, []);
      }
    });
  });

  it("stopHost leaves a child that already ended alone", async () => {
    await withTerminateSpy(async (calls) => {
      const killed: unknown[] = [];
      stopHost({ pid: 424242, exitCode: 0, signalCode: null, kill: (s?: NodeJS.Signals) => (killed.push(s), true) });
      assert.deepEqual(calls, []);
      // endChild's plain kill on an exited child is harmless (Node ignores it); on Windows nothing reaches terminate
      if (process.platform === "win32") assert.deepEqual(killed, ["SIGTERM"]);
    });
  });

  it("close() on a host that ignores exit ends it through the default stop (no stop option): our own child, gone", async () => {
    const h = new WinHost({ command: { command: process.execPath, args: [FAKE, "stubborn"] }, exitWaitMs: 200 });
    const r = await h.hello(5_000);
    assert.equal(r.ok, true);
    const pid = h.pid!;
    assert.ok(pid > 0);
    await h.close();
    let gone = false;
    try {
      process.kill(pid, 0);
    } catch {
      gone = true;
    }
    assert.ok(gone, "the stubborn host was ended by the default stop");
  });

  it("the lifecycle's default kill ends the verified pid alone and never calls platform().process.terminate", async () => {
    const child = idle();
    try {
      await withTerminateSpy(async (calls) => {
        const life = lifecycleMethods(stubHost(child.pid!, () => ({ gone: false, image: "EXCEL", startedAtMs: 1_000, visibleWindow: false })));
        assert.equal(await life.launch(excel), child.pid);
        await life.kill(child.pid!);
        assert.deepEqual(calls, [], "never the tree kill");
        assert.ok(await exitedWithin(child, 5_000), "the verified pid itself was ended (process.kill)");
      });
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("the sweep's default kill (an orphan of a dead connector) never calls platform().process.terminate either", async () => {
    const child = idle();
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-sweep-"));
    const deadConnector = 2_147_000_001;
    try {
      writeFileSync(ownedRecordPath(dir, "excel"), JSON.stringify({ pid: child.pid, startedAtMs: 1_000, image: "EXCEL", connectorPid: deadConnector, connectorStartedAtMs: 5 }));
      await withTerminateSpy(async (calls) => {
        const life = lifecycleMethods(
          stubHost(0, (pid) => (pid === deadConnector ? { gone: true } : { gone: false, image: "EXCEL", startedAtMs: 1_000, visibleWindow: false })),
          { env: { USERPROFILE: dir } },
        );
        await life.sweepOwned(excel, dir);
        assert.deepEqual(calls, [], "never the tree kill");
        assert.ok(await exitedWithin(child, 5_000), "the orphan's pid itself was ended");
      });
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("killOnePid is process.kill of that pid alone", () => {
    const src = readFileSync(path.join(import.meta.dirname, "..", "src", "office", "connector", "office-win-lifecycle.ts"), "utf8");
    assert.match(src, /const terminate = o\.terminate \?\? killOnePid;/);
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /platform\(\)\.process\.terminate/, "no terminate call left in the lifecycle code");
    assert.equal(typeof killOnePid, "function");
  });

  it("the default WinHost (no command) is still guarded under the test bootstrap: the real powershell.exe never starts", async () => {
    assert.equal(process.env.COCHECK_TEST_NO_OFFICE, "1");
    let spawned = 0;
    const h = new WinHost({ spawnFn: (() => { spawned++; throw new Error("spawned"); }) as never });
    await assert.rejects(h.hello(1_000), /test reached the real Office bridge/);
    assert.equal(spawned, 0);
  });

  it("no test launches Office: no ProgID and no COM object creation in test code; the Windows-only files call no Office op", () => {
    const testDir = import.meta.dirname;
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mts|mjs|js|cjs|ps1)$/.test(n)) files.push(p);
      }
    };
    walk(testDir);
    // Built from parts so this file does not match itself.
    const progId = new RegExp(["Excel", "Word", "PowerPoint"].map((a) => `${a}\\.${"Application"}`).join("|"));
    const comObject = new RegExp(`-${"Com"}${"Object"}`, "i");
    // A recorded PowerShell command line fed to the hook adapter as data (PreToolUse payload); never executed.
    const ALLOWED = new Set(["host-reported-edit-open-helper.test.ts"]);
    const hits = files.filter((f) => !ALLOWED.has(path.relative(testDir, f)) && (progId.test(readFileSync(f, "utf8")) || comObject.test(readFileSync(f, "utf8"))));
    assert.deepEqual(hits.map((f) => path.relative(testDir, f)), []);
    for (const f of ["office-win-real-powershell-win32.test.ts", "pdf-batch-pages-win32.test.ts"]) {
      const src = readFileSync(path.join(testDir, f), "utf8");
      assert.doesNotMatch(src, /winOfficeDriver|lifecycleMethods|exportMethods|"launch"|"exportPdf"|"exportTargets"|"openDocuments"|"quit"|"ready"/, `${f} calls no Office op`);
    }
  });
});
