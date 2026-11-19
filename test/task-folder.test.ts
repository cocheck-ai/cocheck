import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { runHook } from "../src/hook-cli.ts";
import { runTrack } from "../src/cli.ts";
import { HOME_REFUSAL, isUnsafeTaskFolder } from "../src/platform/index.ts";
import { trackingOf } from "../src/tracking.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Tracking refuses the user's home, a filesystem root and a folder that contains the home; the sweep walk is capped.
// Every home here is a temp dir; the real home is never read.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async (prefix: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${prefix}-`)));
  dirs.push(d);
  return d;
};

describe("which folders may be a task folder", () => {
  it("refuses the home, a filesystem root and an ancestor of the home", async () => {
    const parent = await tmp("up");
    const home = path.join(parent, "users", "me");
    await mkdir(home, { recursive: true });
    assert.equal(isUnsafeTaskFolder(home, home), true, "the home itself");
    assert.equal(isUnsafeTaskFolder(home + path.sep, home), true, "the home with a trailing separator");
    assert.equal(isUnsafeTaskFolder(path.parse(home).root, home), true, "a filesystem root");
    assert.equal(isUnsafeTaskFolder(path.join(parent, "users"), home), true, "the folder holding the home");
    assert.equal(isUnsafeTaskFolder(parent, home), true, "a higher ancestor of the home");
  });

  it("accepts a project under the home and a home-adjacent sibling (refusing a real project)", async () => {
    const parent = await tmp("ok");
    const home = path.join(parent, "users", "me");
    await mkdir(path.join(home, "code", "x"), { recursive: true });
    await mkdir(path.join(parent, "users", "me2"), { recursive: true });
    await mkdir(path.join(parent, "users", "shared"), { recursive: true });
    assert.equal(isUnsafeTaskFolder(path.join(home, "code", "x"), home), false, "~/code/x");
    assert.equal(isUnsafeTaskFolder(path.join(home, "code"), home), false, "~/code");
    assert.equal(isUnsafeTaskFolder(path.join(parent, "users", "me2"), home), false, "a sibling whose name starts like the home");
    assert.equal(isUnsafeTaskFolder(path.join(parent, "users", "shared"), home), false, "a sibling of the home");
  });

  it("works on Windows-style paths through the platform layer", () => {
    const w = path.win32;
    assert.equal(isUnsafeTaskFolder("C:\\Users\\Ana", "C:\\Users\\Ana", w), true);
    assert.equal(isUnsafeTaskFolder("c:\\users\\ana\\", "C:\\Users\\Ana", w), true, "case and trailing separator");
    assert.equal(isUnsafeTaskFolder("C:\\Users", "C:\\Users\\Ana", w), true, "ancestor");
    assert.equal(isUnsafeTaskFolder("C:\\", "C:\\Users\\Ana", w), true, "drive root");
    assert.equal(isUnsafeTaskFolder("D:\\", "C:\\Users\\Ana", w), true, "another drive root");
    assert.equal(isUnsafeTaskFolder("C:\\Users\\Ana\\repo", "C:\\Users\\Ana", w), false);
    assert.equal(isUnsafeTaskFolder("C:\\Users\\Ana2", "C:\\Users\\Ana", w), false);
  });
});

describe("track start and the hook switch", () => {
  it("cocheck track start in the home or a root is refused in one plain sentence; in a project it is not", async () => {
    const home = await tmp("home");
    const project = path.join(home, "code", "x");
    await mkdir(project, { recursive: true });
    for (const cwd of [home, path.parse(home).root]) {
      const res = runTrack(["start"], home, false, cwd);
      assert.equal(res.exitCode, 1);
      assert.equal(res.stderr, `${HOME_REFUSAL}\n`);
      assert.match(res.stderr, /project folder/);
    }
    assert.equal(runTrack(["start"], home, false, project).exitCode, 0);
  });

  const start = (cocheckHome: string, userHome: string, cwd: string, session: string) =>
    runHook({
      argv: ["node", "hook.ts", "--host", "claude"],
      env: { COCHECK_HOME: cocheckHome, HOME: userHome },
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify({ session_id: session, cwd, transcript_path: "/x/c.jsonl", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "cocheck track start" } }));
      })(),
    });

  it("the hook does not switch tracking on for the home, a root or an ancestor of it, and does for a project", async () => {
    const parent = await tmp("hk");
    const home = path.join(parent, "me");
    const cocheckHome = await tmp("data");
    const project = path.join(home, "code", "x");
    await mkdir(project, { recursive: true });
    for (const [i, cwd] of [home, path.parse(home).root, parent].entries()) {
      const res = await start(cocheckHome, home, cwd, `s-bad-${i}`);
      assert.equal(trackingOf(cocheckHome, "claude", `s-bad-${i}`), undefined, `not tracked in ${cwd}`);
      assert.match(res.stderr, /project folder/);
    }
    await start(cocheckHome, home, project, "s-good");
    assert.equal(trackingOf(cocheckHome, "claude", "s-good")?.folder, project, "a project folder is tracked");
  });
});

describe("the sweep walk is capped", () => {
  it("stops listing past the entry cap and records one caveat", async () => {
    const home = await tmp("cap-home");
    const folder = await tmp("cap-folder");
    await copyFile(path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx"), path.join(folder, "casebook.xlsx"));
    for (let i = 0; i < 10; i++) await writeFile(path.join(folder, `f${i}.txt`), `${i}\n`);
    const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, caps: { walkEntries: 5 } };
    const payload = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
      ({ ...JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "hooks", name), "utf8")), cwd: folder, ...over }) as HookPayload;
    await handleHook(await payload("claude-pre-bash.json", { tool_use_id: "a", tool_input: { command: "x", description: "a" } }), opts);
    await handleHook(await payload("claude-post-bash.json", { tool_use_id: "a", tool_input: { command: "x", description: "a" } }), opts);
    const r = await handleHook(await payload("claude-stop.json", {}), opts);
    const l = openLedger(home);
    try {
      const notes = l.okOpsForTask(r.summary!.taskId, 0, l.maxOpId()).map((o) => JSON.parse(o.argsJson) as { skipped?: Array<{ folder: string; note: string }> }).flatMap((a) => a.skipped ?? []);
      const caps = notes.filter((n) => /stopped listing/.test(n.note));
      assert.equal(caps.length, 1, "the caveat is said once");
      assert.match(caps[0]!.note, /after 5 entries/);
      assert.ok(l.fileStatesForTask(r.summary!.taskId).length < 11, "the walk did not list everything");
    } finally {
      l.close();
    }
  });
});
