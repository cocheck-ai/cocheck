import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chooseOpenTask, clientFolder, writeOpenRecord, readOpenRecords, type OpenTask } from "../src/open-pick.ts";
import { runOpen } from "../src/cli.ts";
import { pickOpenChoice } from "../src/review-server.ts";
import { openLedger } from "../src/ledger.ts";
import { hookClientName } from "../src/hook-adapter.ts";

// `cocheck open` with no id picks the task of the folder it runs in. Client names are the real shape (src/hook-adapter.ts hookClientName).
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(d);
  return d;
};

const NOW = 1_800_000_000_000;
const task = (id: number, host: string, folder: string, session: string, ts: string): OpenTask => ({ id, client: hookClientName(host, folder, session), ts });
const rec = (host: string, session: string, ago = 1000) => ({ host, session, at: NOW - ago });

describe("the folder decides", () => {
  it("the older task is picked from its own cwd, whatever is newer elsewhere", async () => {
    const root = await tmp();
    const a = path.join(root, "codex");
    const b = path.join(root, "vscode");
    await mkdir(a);
    await mkdir(b);
    const tasks = [task(15, "codex", a, "019a", "2026-10-24T10:00:00Z"), task(16, "copilot", b, "d955", "2026-10-24T12:00:00Z")];
    assert.deepEqual(chooseOpenTask(tasks, a, {}, [], NOW), { task: 15 });
    assert.deepEqual(chooseOpenTask(tasks, b, {}, [], NOW), { task: 16 });
  });

  it("nested folders: the deepest task wins, and a cwd below a task folder still finds it", async () => {
    const root = await tmp();
    const inner = path.join(root, "sub");
    await mkdir(inner);
    const tasks = [task(1, "claude", inner, "s1", "2026-10-24T09:00:00Z"), task(2, "claude", root, "s2", "2026-10-24T12:00:00Z")];
    assert.deepEqual(chooseOpenTask(tasks, inner, {}, [], NOW), { task: 1 });
    assert.deepEqual(chooseOpenTask(tasks, root, {}, [], NOW), { task: 2 });
    const deeper = path.join(inner, "x");
    await mkdir(deeper);
    assert.deepEqual(chooseOpenTask(tasks, deeper, {}, [], NOW), { task: 1 });
  });

  it("one session's tasks in a folder: the newest activity", async () => {
    const root = await tmp();
    const tasks = [task(1, "claude", root, "s1", "2026-10-24T09:00:00Z"), task(2, "claude", root, "s1", "2026-10-24T11:00:00Z")];
    assert.deepEqual(chooseOpenTask(tasks, root, {}, [], NOW), { task: 2 });
  });

  it("a cwd under no task gives the list (never another folder's task)", async () => {
    const root = await tmp();
    const a = path.join(root, "a");
    const other = path.join(root, "b");
    await mkdir(a);
    await mkdir(other);
    const res = chooseOpenTask([task(1, "codex", a, "s1", "2026-10-24T09:00:00Z")], other, {}, [], NOW);
    assert.ok("list" in res);
  });

  it("a sibling folder with the same name prefix is not inside", async () => {
    const root = await tmp();
    const a = path.join(root, "work");
    const near = path.join(root, "work2");
    await mkdir(a);
    await mkdir(near);
    assert.ok("list" in chooseOpenTask([task(1, "codex", a, "s1", "2026-10-24T09:00:00Z")], near, {}, [], NOW));
  });

  it("clients with no hook folder (MCP clients) never match", () => {
    assert.equal(clientFolder("some-mcp-client"), undefined);
    assert.ok("list" in chooseOpenTask([{ id: 1, client: "some-mcp-client", ts: "x" }], "/", {}, [], NOW));
  });
});

describe("two sessions in one folder", () => {
  const two = (root: string) => [task(10, "claude", root, "sess-a", "2026-10-24T09:00:00Z"), task(11, "codex", root, "sess-b", "2026-10-24T12:00:00Z")];

  it("one fresh hook record picks that session's task, even when it is the older one", async () => {
    const root = await tmp();
    assert.deepEqual(chooseOpenTask(two(root), root, {}, [rec("claude", "sess-a")], NOW), { task: 10 });
    assert.deepEqual(chooseOpenTask(two(root), root, {}, [rec("codex", "sess-b")], NOW), { task: 11 });
  });

  it("two fresh records give the list, and so do none or a stale one", async () => {
    const root = await tmp();
    for (const records of [[rec("claude", "sess-a"), rec("codex", "sess-b")], [], [rec("claude", "sess-a", 11_000)]]) {
      const res = chooseOpenTask(two(root), root, {}, records, NOW);
      assert.ok("list" in res, JSON.stringify(records));
    }
  });

  it("a record for a session with no task there gives the list", async () => {
    const root = await tmp();
    assert.ok("list" in chooseOpenTask(two(root), root, {}, [rec("claude", "sess-zzz")], NOW));
  });

  it("CLAUDE_CODE_SESSION_ID picks the Claude session's task with no record", async () => {
    const root = await tmp();
    assert.deepEqual(chooseOpenTask(two(root), root, { CLAUDE_CODE_SESSION_ID: "sess-a" }, [], NOW), { task: 10 });
  });
});

describe("the record, the ledger and the command", () => {
  it("writeOpenRecord keeps one file per session and drops old ones", async () => {
    const home = await tmp();
    writeOpenRecord(home, "claude", "s1", NOW - 120_000);
    writeOpenRecord(home, "claude", "s2", NOW);
    writeOpenRecord(home, "claude", "s2", NOW + 1);
    assert.deepEqual(readOpenRecords(home).map((r) => r.session), ["s2"]);
  });

  it("pickOpenChoice on an empty ledger gives the list", async () => {
    const home = await tmp();
    openLedger(home).close();
    assert.ok("list" in pickOpenChoice(home, home, {}, NOW));
  });

  it("runOpen opens the list page and says why when nothing is picked; opens the task when one is; an explicit id is unchanged", async () => {
    const userHome = await tmp();
    const data = await tmp();
    const folder = await tmp();
    await mkdir(path.join(userHome, ".config", "cocheck"), { recursive: true });
    await writeFile(path.join(userHome, ".config", "cocheck", "install.json"), JSON.stringify({ home: data, hookPath: "/x/hook", launcher: "/x/launch", settingsFile: "/x/settings.json", backupFile: "/x/s.bak", hosts: [], folder: "/x", createdDirs: [], installedAt: "2026-10-28T00:00:00.000Z" }));
    const opened: string[] = [];
    const base = { env: {}, userHome, urlFor: async (_h: string, t: number | undefined) => `http://x/task/${t}?t=k`, listUrlFor: async () => "http://x/list?t=k", open: (u: string) => void opened.push(u) };
    const none = await runOpen({ ...base, choose: () => ({ list: "no task is recorded for /somewhere" }) }, undefined);
    assert.equal(none.exitCode, 0);
    assert.match(none.stdout, /task list, not a task: no task is recorded for \/somewhere/);
    assert.equal(opened.at(-1), "http://x/list?t=k");
    const one = await runOpen({ ...base, choose: () => ({ task: 15 }) }, undefined);
    assert.equal(opened.at(-1), "http://x/task/15?t=k");
    assert.doesNotMatch(one.stdout, /task list/);
    await runOpen({ ...base, choose: () => assert.fail("an id skips the choice") }, "7");
    assert.equal(opened.at(-1), "http://x/task/7?t=k");
  });
});
