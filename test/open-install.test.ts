import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInstall, type InstallResult } from "../src/install.ts";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { homePage, listedReviewTasks } from "../src/review-server.ts";
import type { Ledger } from "../src/ledger.ts";

/** The newest listed task (highest id on a tie), or undefined when none is listed. */
function latestReviewTask(ledger: Ledger): number | undefined {
  let best: { id: number; ts: string } | undefined;
  for (const t of listedReviewTasks(ledger)) if (best === undefined || t.ts >= best.ts) best = t;
  return best?.id;
}

// the installer rebuilds a stale dist, and `cocheck open` with no task lands on the latest task. Every path is a scratch dir
// under the temp dir; the install gets stub build and hook paths, and nothing here starts the review server or a browser.
const hookSource = path.resolve(import.meta.dirname, "..", "src", "hook.ts");

let sandbox = "";
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = "";
});

async function scratch(): Promise<string> {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-s012-")));
  return sandbox;
}

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);

async function install(root: string, hookPath: string, build: () => void): Promise<InstallResult> {
  const home = path.join(root, "home");
  const folder = path.join(root, "work");
  await mkdir(home, { recursive: true });
  await mkdir(folder, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") } as NodeJS.ProcessEnv;
  return runInstall({ argv: ["node", "install.ts", "--home", path.join(root, "data"), "--folder", folder, "--for", "claude"], env, cwd: root, hookPath, build });
}

describe("install rebuilds a stale dist", () => {
  it("rebuilds when a source file is newer than dist/hook.js", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "tree", "dist"), { recursive: true });
    await mkdir(path.join(root, "tree", "src", "deep"), { recursive: true });
    const hook = path.join(root, "tree", "dist", "hook.js");
    await writeFile(hook, `import ${JSON.stringify(pathToFileURL(hookSource).href)};\n`);
    await writeFile(path.join(root, "tree", "src", "deep", "a.ts"), "x");
    await utimes(hook, at(100), at(100));
    await utimes(path.join(root, "tree", "src", "deep", "a.ts"), at(10), at(10));
    let built = 0;
    const res = await install(root, hook, () => void built++);
    assert.equal(built, 1, res.stderr);
  });

  it("does not rebuild when dist is newer than every source file", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "tree", "dist"), { recursive: true });
    await mkdir(path.join(root, "tree", "src"), { recursive: true });
    const hook = path.join(root, "tree", "dist", "hook.js");
    await writeFile(hook, `import ${JSON.stringify(pathToFileURL(hookSource).href)};\n`);
    await writeFile(path.join(root, "tree", "src", "a.ts"), "x");
    await utimes(path.join(root, "tree", "src", "a.ts"), at(100), at(100));
    await utimes(hook, at(10), at(10));
    const res = await install(root, hook, () => assert.fail("must not build a fresh dist"));
    assert.equal(res.exitCode, 0, res.stderr);
  });

  it("does nothing, and does not fail, when there is no src/ next to dist (packaged build)", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "pkg", "dist"), { recursive: true });
    const hook = path.join(root, "pkg", "dist", "hook.js");
    await writeFile(hook, `import ${JSON.stringify(pathToFileURL(hookSource).href)};\n`);
    await utimes(hook, at(1000), at(1000));
    const res = await install(root, hook, () => assert.fail("no src tree, so nothing can be stale"));
    assert.equal(res.exitCode, 0, res.stderr);
  });
});

describe("cocheck open with no task", () => {
  async function ledgerWithTasks() {
    const root = await scratch();
    const home = path.join(root, "data");
    const folder = path.join(root, "work");
    await mkdir(folder, { recursive: true });
    const ledger = openLedger(home);
    const tasks = new TaskStore(ledger, home, [createFilesLayer()]);
    return { home, folder, ledger, tasks };
  }

  it("picks the latest task; with none recorded it picks nothing", async () => {
    const t = await ledgerWithTasks();
    assert.equal(latestReviewTask(t.ledger), undefined);
    const a = path.join(t.folder, "a.txt");
    const b = path.join(t.folder, "b.txt");
    await writeFile(a, "one\n");
    await writeFile(b, "one\n");
    const first = await t.tasks.touch("c1", a);
    await writeFile(a, "two\n");
    await t.tasks.submit("c1", "edit", false);
    const second = await t.tasks.touch("c2", b);
    await writeFile(b, "two\n");
    await t.tasks.submit("c2", "edit", false);
    assert.notEqual(first, second);
    assert.equal(latestReviewTask(t.ledger), second);
    t.ledger.close();
  });

  it("the index carries the page styles", async () => {
    const t = await ledgerWithTasks();
    const html = homePage(t.ledger, "tok");
    assert.match(html, /<style>[^<]*--fs-body:[^<]*body\{font:var\(--fs-body\)\/var\(--lh-body\) var\(--font\)/);
    t.ledger.close();
  });
});
