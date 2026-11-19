import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInstall, type InstallResult } from "../src/install.ts";

// Codex install friction. Scratch HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and data home under the temp dir; the real ~/.codex is never touched.
const reEscape = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");

let sandbox: string;
let userHome: string;
let dataHome: string;
let work: string;
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  userHome = path.join(sandbox, "home");
  dataHome = path.join(sandbox, "data");
  work = path.join(sandbox, "work");
  await mkdir(userHome, { recursive: true });
  await mkdir(work, { recursive: true });
}
const codexFile = () => path.join(userHome, ".codex", "config.toml");
const run = (argv: string[], cwd = sandbox): Promise<InstallResult> =>
  runInstall({
    argv: ["node", "install.ts", ...argv],
    env: { PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex") },
    cwd,
    hookPath,
    stopReview: async () => "no review process was running",
  });

describe("install --for codex", () => {
  it("reuses --home and --folder from an existing record", async () => {
    await fresh();
    assert.equal((await run(["--home", dataHome, "--folder", work, "--for", "codex"])).exitCode, 0);
    const again = await run(["--for", "codex"], path.join(sandbox, "elsewhere-not-a-folder"));
    assert.equal(again.exitCode, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`The install check ran in ${reEscape(work)}`));
    const watched = JSON.parse(await readFile(path.join(dataHome, "watched.json"), "utf8"));
    assert.deepEqual(JSON.stringify(watched).includes(work), true);
  });

  it("an explicit --home or --folder still wins over the record", async () => {
    await fresh();
    await run(["--home", dataHome, "--folder", work, "--for", "codex"]);
    const other = path.join(sandbox, "other");
    await mkdir(other);
    const res = await run(["--folder", other, "--for", "codex"]);
    assert.match(res.stdout, new RegExp(`The install check ran in ${reEscape(other)}`));
  });

  it("with no record, --home is still required", async () => {
    await fresh();
    const res = await run(["--for", "codex"]);
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /--home <dir> is required/);
  });

  it("a Claude-only install does not borrow the record's folder", async () => {
    await fresh();
    await run(["--home", dataHome, "--folder", work, "--for", "codex"]);
    const res = await run(["--home", dataHome, "--for", "claude"]);
    assert.match(res.stdout, new RegExp(`The install check ran in ${reEscape(sandbox)}`));
  });

  it("the install text names Codex, not a Claude Code tool call", async () => {
    await fresh();
    const res = await run(["--home", dataHome, "--folder", work, "--for", "codex"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /Hook timing: every Codex tool call/);
    assert.doesNotMatch(res.stdout, /Claude Code tool call/);
  });

  it("the install text names both hosts when both are installed", async () => {
    await fresh();
    const res = await run(["--home", dataHome, "--folder", work, "--for", "both"]);
    assert.match(res.stdout, /Hook timing: every Claude Code or Codex tool call/);
  });

  it("does not write [features] hooks = true", async () => {
    await fresh();
    await mkdir(path.dirname(codexFile()), { recursive: true });
    await writeFile(codexFile(), 'model = "m"\n');
    const res = await run(["--home", dataHome, "--folder", work, "--for", "codex"]);
    assert.equal(res.exitCode, 0, res.stderr);
    const text = await readFile(codexFile(), "utf8");
    assert.doesNotMatch(text, /features/);
    assert.doesNotMatch(text, /^hooks = /m);
    assert.match(text, /\[\[hooks\.PreToolUse\]\]/);
  });
});
