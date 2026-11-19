import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInstall } from "../src/install.ts";

// --home is the folder CoCheck sets the modes of, recursively. Every run uses a temp HOME; nothing of the real machine is reachable.
let sandbox: string;
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-home-guard-")));
  const home = path.join(sandbox, "home");
  const cfg = path.join(home, ".claude");
  const work = path.join(home, "work");
  await mkdir(cfg, { recursive: true });
  await mkdir(work, { recursive: true });
  return { home, cfg, work };
}
const install = (s: Awaited<ReturnType<typeof fresh>>, dataHome: string, folder = s.work) =>
  runInstall({
    argv: ["node", "install.ts", "--home", dataHome, "--folder", folder],
    env: { PATH: process.env.PATH, HOME: s.home, CLAUDE_CONFIG_DIR: s.cfg } as NodeJS.ProcessEnv,
    cwd: sandbox,
    hookPath: path.resolve(import.meta.dirname, "..", "src", "hook.ts"),
    build: () => { throw new Error("build must not run"); },
  });

describe("install refuses a --home that holds the person's files", () => {
  it("refuses the user's home folder", async () => {
    const s = await fresh();
    const r = await install(s, s.home);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /--home/);
    assert.equal(existsSync(path.join(s.home, "ledger.sqlite")), false);
  });

  it("refuses a folder that contains the user's home folder", async () => {
    const s = await fresh();
    assert.notEqual((await install(s, sandbox)).exitCode, 0);
  });

  it("refuses the watched folder and one that contains it", async () => {
    const s = await fresh();
    const outer = path.join(sandbox, "outer");
    const inner = path.join(outer, "watched");
    await mkdir(path.join(s.work, "sub"), { recursive: true });
    await mkdir(inner, { recursive: true });
    assert.notEqual((await install(s, s.work)).exitCode, 0);
    assert.notEqual((await install(s, outer, inner)).exitCode, 0);
  });

  it("sees through a symlink and a trailing slash", async () => {
    const s = await fresh();
    const link = path.join(sandbox, "link");
    await symlink(s.home, link);
    assert.notEqual((await install(s, link)).exitCode, 0);
    assert.notEqual((await install(s, `${s.home}/`)).exitCode, 0);
  });

  it("still installs into a folder of its own, including one that already holds a CoCheck home", async () => {
    const s = await fresh();
    const data = path.join(sandbox, "cocheck-data");
    const first = await install(s, data);
    assert.equal(first.exitCode, 0, first.stderr);
    const again = await install(s, data);
    assert.equal(again.exitCode, 0, again.stderr);
  });
});
