// CLI and install hygiene from a Windows run. Every HOME is a temp dir; no real process is signalled (the platform is a fake whose terminate records).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.ts";
import { runInstall, stopReviewProcess } from "../src/install.ts";
import { createWin32, platformFor, psCommandLine, type Platform } from "../src/platform/index.ts";
import { skillText } from "../src/skill.ts";

const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");

describe("(1) help", () => {
  for (const arg of ["--help", "-h", "help"]) {
    it(`${arg} prints usage on stdout and exits 0`, async () => {
      const r = await main([arg]);
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /^usage:/);
      assert.equal(r.stderr, "");
    });
  }
  it("an unknown command still exits 1 with usage on stderr", async () => {
    const r = await main(["frobnicate"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /usage:/);
    assert.equal(r.stdout, "");
  });
});

async function rig(plat: "darwin" | "win32") {
  const sandbox = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  const userHome = path.join(sandbox, "home");
  mkdirSync(path.join(userHome, ".claude"), { recursive: true });
  writeFileSync(path.join(userHome, ".claude", "settings.json"), "{}");
  const folder = path.join(sandbox, "work");
  mkdirSync(folder);
  const dataHome = path.join(sandbox, "data");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome };
  const run = (argv: string[]) =>
    runInstall({ argv: ["node", "install.ts", ...argv], env, cwd: sandbox, hookPath, platform: plat, stopReview: async () => "no review process was running", hookFires: () => undefined });
  return { dataHome, folder, run, userHome };
}

describe("(2)(4) install and uninstall output", () => {
  it("uninstall names the backup file without a date it did not measure", async () => {
    const r = await rig("darwin");
    assert.equal((await r.run(["--home", r.dataHome, "--folder", r.folder, "--for", "claude"])).exitCode, 0);
    const out = (await r.run(["--uninstall", "--for", "claude"])).stdout;
    assert.match(out, /settings backup: /);
    assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}/);
    assert.doesNotMatch(out, /from the first install \(/);
  });
  it("uninstall lists review-port and review-token under what stays", async () => {
    const r = await rig("darwin");
    assert.equal((await r.run(["--home", r.dataHome, "--folder", r.folder, "--for", "claude"])).exitCode, 0);
    const out = (await r.run(["--uninstall", "--for", "claude"])).stdout;
    const stays = out.slice(out.indexOf("What stays"));
    assert.match(stays, /review-port/);
    assert.match(stays, /review-token/);
  });
  it("install names where the key lives: the Keychain item on darwin", async () => {
    const r = await rig("darwin");
    const out = (await r.run(["--home", r.dataHome, "--folder", r.folder, "--for", "claude"])).stdout;
    assert.match(out, /key that seals your data.*cocheck-store-key.*login Keychain/);
  });
  it("install names where the key lives: the DPAPI folder on win32", async () => {
    const r = await rig("win32");
    const out = (await r.run(["--home", r.dataHome, "--folder", r.folder, "--for", "claude"])).stdout;
    assert.match(out, /key that seals your data.*DPAPI.*AppData\\Local\\CoCheck\\secrets/);
  });
});

describe("(4) skill", () => {
  it("says it has no close action and asks what close means", () => {
    const t = skillText("cocheck");
    assert.match(t, /no close action/i);
    assert.match(t, /what.*close/i);
  });
});

describe("(3) stopReviewProcess cleanup, and the guarded case", () => {
  const FILES = ["review-server.lock", "review-server.json", "review-process-heartbeat.json", "review-port", "review-token"];
  function homeWith(pid: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    for (const f of FILES) writeFileSync(path.join(dir, f), f === "review-server.json" ? JSON.stringify({ pid, port: 4000 }) : f === "review-port" ? "4000\n" : "x");
    return dir;
  }
  function track(base: Platform, opts: { terminateThrows?: boolean; stayAlive?: boolean } = {}) {
    const terminated: number[] = [];
    let dead = false;
    const plat: Platform = {
      ...base,
      process: {
        ...base.process,
        terminate(pid) {
          if (opts.terminateThrows) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          terminated.push(pid);
          if (!opts.stayAlive) dead = true;
        },
        alive: () => !dead,
      },
    };
    return { plat, terminated };
  }
  const winLine = (home: string) => `"C:\\node\\node.exe" "C:\\CoCheck\\dist\\review-process.js" --cocheck-home=${home}\r\n`;
  const win = (line: string) => createWin32({ run: () => ({ status: 0, stdout: line, stderr: "" }) });
  const left = (home: string) => FILES.filter((f) => existsSync(path.join(home, f)));

  it("the stopped pid was CoCheck's: lock, port record and heartbeat go; review-port and review-token stay", async () => {
    const home = homeWith(41);
    const { plat, terminated } = track(win(winLine(home)));
    assert.match(await stopReviewProcess(home, plat), /^stopped the review process \(pid 41\)/);
    assert.deepEqual(terminated, [41]);
    assert.deepEqual(left(home), ["review-port", "review-token"]);
  });
  it("DANGEROUS DIRECTION: a foreign pid in review-server.json is not signalled and every file is kept", async () => {
    for (const line of ["notepad.exe", winLine("C:\\Users\\Bob\\CoCheckData")]) {
      const home = homeWith(42);
      const { plat, terminated } = track(win(line));
      assert.match(await stopReviewProcess(home, plat), /not CoCheck's/);
      assert.deepEqual(terminated, []);
      assert.deepEqual(left(home), FILES);
    }
  });
  it("a process that would not stop keeps its files", async () => {
    const home = homeWith(43);
    const refused = track(win(winLine(home)), { terminateThrows: true });
    assert.match(await stopReviewProcess(home, refused.plat), /still running/);
    assert.deepEqual(left(home), FILES);
  });
  it("a darwin review process of this home is cleaned the same way", async () => {
    const home = homeWith(44);
    const d = platformFor("darwin");
    const run = ((_c: string, _a: string[]) => `node review-process.js COCHECK_HOME=${home}`) as unknown as typeof import("node:child_process").execFileSync;
    const { plat } = track({ ...d, process: { ...d.process, commandLine: (pid, o) => psCommandLine(run, pid, o) } });
    assert.match(await stopReviewProcess(home, plat), /^stopped/);
    assert.deepEqual(left(home), ["review-port", "review-token"]);
  });
});
