import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installRecordPath, installStatus, readInstallRecord, runInstall, type InstallResult } from "../src/install.ts";

// the install record keeps every host an earlier run installed. Scratch HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and COCHECK_HOME only.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");

let sandbox: string;
let cfg: string;
let codexHome: string;
let userHome: string;
let dataHome: string;
let stops: string[];
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-h005m-")));
  userHome = path.join(sandbox, "home");
  cfg = path.join(userHome, ".claude");
  codexHome = path.join(userHome, ".codex");
  dataHome = path.join(sandbox, "data");
  stops = [];
  await mkdir(userHome, { recursive: true });
  await mkdir(cfg, { recursive: true }); // Claude Code is present (an install with no --for detects hosts by their config folder)
  const folder = path.join(sandbox, "work");
  await mkdir(folder, { recursive: true });
  return folder;
}
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codexHome });
const run = (argv: string[]): Promise<InstallResult> =>
  runInstall({ argv: ["node", "install.ts", ...argv], env: env(), cwd: sandbox, hookPath, stopReview: async (h) => { stops.push(h); return "no review process was running"; } });
const install = (folder: string, flags: string[] = []) => run(["--home", dataHome, "--folder", folder, ...flags]);
const hostsOf = () => (readInstallRecord(userHome)?.hosts ?? []).map((h) => h.host).sort();

describe("the record unions hosts across runs", () => {
  it("install then install --for codex: both installed, record lists both", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const res = await install(folder, ["--for", "codex"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(hostsOf(), ["claude", "codex"]);
    const text = installStatus(env(), userHome).text;
    assert.match(text, /Claude Code: installed|Claude[^\n]*: installed/);
    assert.match(text, /Codex[^\n]*: installed/);
    assert.doesNotMatch(text, /Claude[^\n]*not installed/);
  });

  it("then uninstall --for codex: Claude stays installed, record kept, review process not stopped", async () => {
    const folder = await fresh();
    await install(folder);
    await install(folder, ["--for", "codex"]);
    const res = await run(["--uninstall", "--for", "codex"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(hostsOf(), ["claude"]);
    assert.deepEqual(stops, []);
    assert.match(installStatus(env(), userHome).text, /Claude[^\n]*: installed/);
    assert.match(await readFile(path.join(cfg, "settings.json"), "utf8"), /cocheck/i);
  });

  it("install then install --for none: recorded hosts unchanged", async () => {
    const folder = await fresh();
    await install(folder);
    const before = hostsOf();
    const res = await install(folder, ["--for", "none"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(hostsOf(), before);
    assert.deepEqual(before, ["claude"]);
  });

  it("reinstalling the same host replaces its entry, no duplicate", async () => {
    const folder = await fresh();
    await install(folder);
    await install(folder);
    assert.deepEqual(hostsOf(), ["claude"]);
  });
});
