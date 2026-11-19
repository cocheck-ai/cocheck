import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHook } from "../src/hook-cli.ts";
import { runHookTracked } from "./helpers/track.ts";
import { journalRecords } from "./hook-corpus.ts";

// as changed it: watched.json does not switch recording on. A session records only after it was started, in a
// watched folder or not; an unreadable registry still fails loud, for a session that records. Every home and folder here is a fresh temp dir.
const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async (prefix: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-s002-${prefix}-`)));
  cleanups.push(d);
  return d;
};
const payload = (cwd: string) => Buffer.from(JSON.stringify({ session_id: "s1", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }));
const fireWith = (run: typeof runHook) => (home: string, folder: string | undefined, env: Record<string, string> = {}) =>
  run({
    argv: ["node", "hook.ts", "--host", "claude", ...(folder === undefined ? [] : ["--folder", folder])],
    env: { COCHECK_HOME: home, ...env },
    stdin: (async function* () { yield payload(folder ?? "/"); })(),
  });
const register = (home: string, folders: string[]) => writeFile(path.join(home, "watched.json"), JSON.stringify({ version: 1, folders }));
const untouched = async (home: string) => assert.deepEqual((await readdir(home)).filter((n) => n !== "watched.json"), []);
const fire = fireWith(runHookTracked);
const fireUntracked = fireWith(runHook);

describe("the registry does not gate recording", () => {
  it("an untracked session in a registered folder or its subfolder: exit 0, nothing written", async () => {
    const home = await tmp("home");
    const root = await tmp("root");
    const proj = path.join(root, "proj");
    await mkdir(path.join(proj, "sub"), { recursive: true });
    await register(home, [proj]);
    for (const where of [proj, path.join(proj, "sub")]) {
      const res = await fireUntracked(home, where);
      assert.deepEqual([res.exitCode, res.stderr, res.stdout], [0, "", ""]);
    }
    await untouched(home);
  });

  it("a started session records inside a registered folder and outside every one", async () => {
    const home = await tmp("home");
    const root = await tmp("root");
    const proj = path.join(root, "proj");
    await mkdir(path.join(root, "elsewhere"), { recursive: true });
    await mkdir(proj, { recursive: true });
    await register(home, [proj]);
    assert.equal((await fire(home, proj)).exitCode, 0);
    const before = journalRecords(home).length;
    assert.equal((await fire(home, path.join(root, "elsewhere"))).exitCode, 0);
    assert.ok(before > 0 && journalRecords(home).length > before, "both folders recorded");
  });

  it("an empty registry changes nothing: untracked writes nothing, started records", async () => {
    const home = await tmp("home");
    const root = await tmp("root");
    await register(home, []);
    assert.equal((await fireUntracked(home, root)).exitCode, 0);
    await untouched(home);
    assert.equal((await fire(home, root)).exitCode, 0);
    assert.ok(journalRecords(home).length > 0);
  });

  it("a corrupt registry fails loud for a started session: exit 1, the event journaled with a failure marker; an untracked one is silent", async () => {
    const home = await tmp("home");
    const root = await tmp("root");
    await writeFile(path.join(home, "watched.json"), "{ not json");
    assert.deepEqual([(await fireUntracked(home, root)).exitCode, journalRecords(home).length], [0, 0]);
    const res = await fire(home, root);
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /registry/);
    assert.equal(journalRecords(home).some((r) => r.failure !== undefined || r.kind === "failure" || r.status === "failure" || JSON.stringify(r).includes("registry")), true);
  });

  it("a registry of the wrong shape fails loud too", async () => {
    const home = await tmp("home");
    const root = await tmp("root");
    await writeFile(path.join(home, "watched.json"), JSON.stringify({ version: 1, folders: "nope" }));
    assert.equal((await fire(home, root)).exitCode, 1);
  });

  it("a managed entry with no registry fails loud for a started session; unmanaged legacy wiring records", async () => {
    const home = await tmp("home");
    const root = await tmp("root");
    assert.equal((await fire(home, root, { COCHECK_MANAGED: "1" })).exitCode, 1);
    const legacy = await tmp("home");
    assert.equal((await fire(legacy, root)).exitCode, 0);
    assert.equal(journalRecords(legacy).length > 0, true);
  });
});
