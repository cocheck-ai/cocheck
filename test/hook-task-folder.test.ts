import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { readFolderMarker, TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { taskFolderOf } from "../src/timeline/load.ts";

// a hook task's work folder is the folder it was started with (its client name), never the directory of an outside file. Synthetic files only.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-root-")));
  const folder = path.join(root, "work");
  const scratch = path.join(root, "scratch");
  await mkdir(folder);
  await mkdir(scratch);
  const ledger = openLedger(home);
  const tasks = new TaskStore(ledger, home, [createFilesLayer()], () => Date.now());
  cleanups.push(async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  return { home, folder, scratch, ledger, tasks };
}

describe("hook task folder", () => {
  it("write side: the first accepted file is outside the --folder, the marker gets no outside dir", async () => {
    const s = await setup();
    await writeFile(path.join(s.scratch, "outside.txt"), "x\n");
    await writeFile(path.join(s.folder, "inside.txt"), "y\n");
    const client = `claude-hook:${s.folder}`;
    const id = await s.tasks.touch(client, path.join(s.scratch, "outside.txt"));
    assert.notEqual(readFolderMarker(s.home, id).dir, s.scratch);
    await s.tasks.touch(client, path.join(s.folder, "inside.txt"));
    const dir = readFolderMarker(s.home, id).dir;
    assert.ok(dir === undefined || dir === s.folder, `marker dir ${dir}`);
    assert.equal(taskFolderOf(s.ledger, s.home, id), s.folder);
  });

  it("write side: an inside first file still reads the --folder", async () => {
    const s = await setup();
    await writeFile(path.join(s.folder, "inside.txt"), "y\n");
    const id = await s.tasks.touch(`claude-hook:${s.folder}`, path.join(s.folder, "inside.txt"));
    assert.equal(taskFolderOf(s.ledger, s.home, id), s.folder);
  });

  it("read side: for a hook task the client folder wins over a marker dir that is not that folder", async () => {
    const s = await setup();
    const id = s.ledger.openTask(`claude-hook:${s.folder}`);
    await mkdir(path.join(s.home, "tasks", String(id)), { recursive: true });
    await writeFile(path.join(s.home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: s.scratch }));
    assert.equal(taskFolderOf(s.ledger, s.home, id), s.folder);
  });

  it("non-hook task: the marker dir wins exactly as before (read and write)", async () => {
    const s = await setup();
    const id = s.ledger.openTask(`claude:${s.folder}`);
    await mkdir(path.join(s.home, "tasks", String(id)), { recursive: true });
    await writeFile(path.join(s.home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: s.scratch }));
    assert.equal(taskFolderOf(s.ledger, s.home, id), s.scratch);
    await writeFile(path.join(s.scratch, "a.txt"), "x\n");
    const id2 = await s.tasks.touch("plain-client", path.join(s.scratch, "a.txt"));
    assert.equal(readFolderMarker(s.home, id2).dir, s.scratch);
    assert.equal(taskFolderOf(s.ledger, s.home, id2), s.scratch);
  });
});
