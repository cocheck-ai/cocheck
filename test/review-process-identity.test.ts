// A review process is found and stopped through the Platform, on darwin (ps) and win32 (PowerShell), with injected runners. No real ps, PowerShell or signal.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { stopReviewProcess } from "../src/install.ts";
import { createWin32, platformFor, psCommandLine, type Platform } from "../src/platform/index.ts";
import { isReviewProcessFor, isReviewProcessPid, reviewProcessArgs } from "../src/review-server.ts";

const HOME = "C:\\Users\\Ana\\CoCheckData";
const OTHER = "C:\\Users\\Bob\\CoCheckData";
const ENTRY = "C:\\CoCheck\\dist\\review-process.js";
const winLine = (home: string, quoted = false) => `"C:\\node\\node.exe" "${ENTRY}" ${quoted ? `"--cocheck-home=${home}"` : `--cocheck-home=${home}`}\r\n`;

function win(commandLine: string | null, calls: Array<{ command: string; args: string[] }> = []): Platform {
  return createWin32({
    run(command, args) {
      calls.push({ command, args });
      return commandLine === null ? { status: 1, stdout: "", stderr: "x" } : { status: 0, stdout: commandLine, stderr: "" };
    },
  });
}

/** darwin Platform whose ps is a fake: `ps` output keyed by whether `-E` was asked. */
function mac(plain: string | undefined, withEnv: string | undefined, seen: string[][] = []): Platform {
  const run = ((_cmd: string, args: string[]) => {
    seen.push(args);
    const out = args.includes("-E") ? withEnv : plain;
    if (out === undefined) throw new Error("ps failed");
    return out;
  }) as unknown as typeof import("node:child_process").execFileSync;
  const d = platformFor("darwin");
  return { ...d, process: { ...d.process, commandLine: (pid, o) => psCommandLine(run, pid, o) } };
}

describe("Platform.process.commandLine", () => {
  it("win32 reads the line with Get-CimInstance by ProcessId, argv array, and trims the newline", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const line = win(winLine(HOME), calls).process.commandLine(4242);
    assert.equal(line, winLine(HOME).replace(/\r?\n$/, ""));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "powershell.exe");
    assert.deepEqual(calls[0]!.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    assert.match(calls[0]!.args[5]!, /Get-CimInstance Win32_Process -Filter 'ProcessId = 4242'\)\.CommandLine/);
  });
  it("win32 gives undefined when PowerShell fails, prints nothing, or the pid is not a positive integer (nothing injected into the script)", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    assert.equal(win(null).process.commandLine(1), undefined);
    assert.equal(win("\r\n").process.commandLine(1), undefined);
    assert.equal(win("x", calls).process.commandLine(Number("1; calc")), undefined);
    assert.equal(win("x", calls).process.commandLine(-3), undefined);
    assert.equal(calls.length, 0);
  });
  it("darwin keeps today's ps argv: -o command= -p <pid>, and -E -ww first with the environment", () => {
    const seen: string[][] = [];
    const p = mac("node review-process.js\n", "node review-process.js COCHECK_HOME=/h\n", seen);
    p.process.commandLine(77);
    p.process.commandLine(77, { withEnvironment: true });
    assert.deepEqual(seen, [["-o", "command=", "-p", "77"], ["-E", "-ww", "-o", "command=", "-p", "77"]]);
    assert.equal(mac(undefined, undefined).process.commandLine(1), undefined);
  });
  it("home identity: environment on darwin, argument on win32", () => {
    assert.equal(platformFor("darwin").process.homeIdentity, "environment");
    assert.equal(platformFor("win32").process.homeIdentity, "argument");
  });
});

describe("review process identity (never another process, never another home)", () => {
  it("win32: serves this home -> true, also when the OS quotes the argument", () => {
    assert.equal(isReviewProcessFor(9, HOME, win(winLine(HOME))), true);
    assert.equal(isReviewProcessFor(9, HOME, win(winLine(HOME, true))), true);
    assert.equal(isReviewProcessPid(9, win(winLine(HOME))), true);
  });
  it("win32: a different home, a home that merely extends this one, a non-review command, an unreadable line are all false", () => {
    assert.equal(isReviewProcessFor(9, HOME, win(winLine(OTHER))), false);
    assert.equal(isReviewProcessFor(9, HOME, win(winLine(`${HOME}2`))), false);
    assert.equal(isReviewProcessFor(9, HOME, win(`"C:\\Windows\\notepad.exe" --cocheck-home=${HOME}`)), false);
    assert.equal(isReviewProcessFor(9, HOME, win(`"node.exe" other.js "review-process-notes.txt" --cocheck-home=${HOME}`)), false);
    assert.equal(isReviewProcessFor(9, HOME, win(`node.exe ${ENTRY}`)), false);
    assert.equal(isReviewProcessFor(9, HOME, win(null)), false);
    assert.equal(isReviewProcessPid(9, win("notepad.exe")), false);
  });
  it("win32 never asks for another process's environment", () => {
    const asked: unknown[] = [];
    const p = win(winLine(HOME));
    const spy: Platform = { ...p, process: { ...p.process, commandLine: (pid, o) => (asked.push(o), p.process.commandLine(pid, o)) } };
    isReviewProcessFor(9, HOME, spy);
    assert.deepEqual(asked, [{ withEnvironment: false }]);
  });
  it("darwin: exact environment check kept (COCHECK_HOME must match whole), other home / non-review are false", () => {
    const home = "/Users/ana/CoCheckData";
    assert.equal(isReviewProcessFor(5, home, mac("", `node /x/review-process.js PATH=/bin COCHECK_HOME=${home} HOME=/Users/ana`)), true);
    assert.equal(isReviewProcessFor(5, home, mac("", `node /x/review-process.js COCHECK_HOME=${home}`)), true);
    assert.equal(isReviewProcessFor(5, home, mac("", `node /x/review-process.js COCHECK_HOME=${home}2 HOME=/u`)), false);
    assert.equal(isReviewProcessFor(5, home, mac("", `node /x/review-process.js COCHECK_HOME=/Users/bob/CoCheckData`)), false);
    assert.equal(isReviewProcessFor(5, home, mac("", `vim notes.txt COCHECK_HOME=${home}`)), false);
    assert.equal(isReviewProcessFor(5, home, mac("", undefined)), false);
  });
  it("review process spawn args: darwin unchanged (entry only), win32 adds the home argument last", () => {
    assert.deepEqual(reviewProcessArgs("/x/review-process.js", "/h", platformFor("darwin")), ["/x/review-process.js"]);
    assert.deepEqual(reviewProcessArgs(ENTRY, HOME, platformFor("win32")), [ENTRY, `--cocheck-home=${HOME}`]);
  });
});

describe("stopReviewProcess (uninstall message is true on both platforms)", () => {
  function homeWith(pid: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    writeFileSync(path.join(dir, "review-server.json"), JSON.stringify({ pid, port: 4000 }));
    return dir;
  }
  function track(base: Platform, opts: { aliveAfterTerminate?: boolean; terminateThrows?: boolean } = {}) {
    const terminated: number[] = [];
    let dead = false;
    const plat: Platform = {
      ...base,
      process: {
        ...base.process,
        terminate(pid) {
          if (opts.terminateThrows) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          terminated.push(pid);
          if (!opts.aliveAfterTerminate) dead = true;
        },
        alive: () => !dead,
      },
    };
    return { plat, terminated };
  }

  it("win32: serving this home -> signalled, message says stopped", async () => {
    const home = homeWith(31);
    const { plat, terminated } = track(win(winLine(home)));
    assert.match(await stopReviewProcess(home, plat), /^stopped the review process \(pid 31\)$/);
    assert.deepEqual(terminated, [31]);
  });
  it("win32: not CoCheck's, or another home's -> never signalled, reported as not CoCheck's", async () => {
    for (const line of ["notepad.exe", winLine(OTHER), null]) {
      const home = homeWith(32);
      const { plat, terminated } = track(win(line));
      assert.match(await stopReviewProcess(home, plat), /^no review process was running \(the recorded pid is not CoCheck's/);
      assert.deepEqual(terminated, []);
    }
  });
  it("darwin: not a review process, or another home's -> never signalled", async () => {
    for (const env of ["vim COCHECK_HOME=HOMEX", "node review-process.js COCHECK_HOME=/somewhere/else"]) {
      const home = homeWith(33);
      const { plat, terminated } = track(mac("", env.replace("HOMEX", home)));
      assert.match(await stopReviewProcess(home, plat), /^no review process was running \(the recorded pid is not CoCheck's/);
      assert.deepEqual(terminated, []);
    }
  });
  it("darwin: this home's review process -> stopped", async () => {
    const home = homeWith(34);
    const { plat, terminated } = track(mac("", `node review-process.js COCHECK_HOME=${home}`));
    assert.match(await stopReviewProcess(home, plat), /^stopped the review process \(pid 34\)$/);
    assert.deepEqual(terminated, [34]);
  });
  it("refused signal on a live process says still running, never 'none running'", async () => {
    const home = homeWith(35);
    const { plat } = track(win(winLine(home)), { terminateThrows: true });
    assert.match(await stopReviewProcess(home, plat), /could not stop the review process \(pid 35\); it is still running/);
  });
  it("no port file -> none running", async () => {
    assert.equal(await stopReviewProcess(mkdtempSync(path.join(tmpdir(), "cocheck-")), win(null)), "no review process was running");
  });
});
