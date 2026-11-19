// the hook keeps claimed files whole on their own allowance, writes plain SHA-256 identities only,
// compares a prefixed value from before F1 like for like, copies a hash-only claimed file when a call names it, evicts by claim (never
// by extension, never a state whose capture is pending), and credits an app's late save to the call that named the file (app tail).
import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, TAIL_NOTE, type HookPayload } from "../src/hook-adapter.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { collectSignoff } from "../src/signoff.ts";
import { workbookClaims } from "./helpers/claims.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (name: string) => path.join(FIXTURES, "probe", name);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;
const PREFIXED = /^(xlsx|deck):/;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type Caps = { fileBytes?: number; taskBytes?: number; scanFiles?: number; scanBytes?: number; claimedFiles?: number; claimedBytes?: number };

async function setup(opts: { caps?: Caps; files?: Record<string, string | Uint8Array>; claimed?: (f: string) => boolean; perSession?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    await chmod(home, 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  for (const [rel, data] of Object.entries(opts.files ?? {})) {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), data);
  }
  const hostOpts = { perSession: opts.perSession ?? false, host: "claude" as const, home, claimed: opts.claimed ?? workbookClaims, folder, ...(opts.caps ? { caps: opts.caps } : {}) };
  const send = (name: string, over: Record<string, unknown> = {}) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, hostOpts));
  const pre = (id: string, command: string) => send("claude-pre-bash.json", { tool_use_id: id, tool_input: { command, description: id } });
  const post = (id: string, command: string) => send("claude-post-bash.json", { tool_use_id: id, tool_input: { command, description: id } });
  const call = async (id: string, command: string, act: () => Promise<void> = async () => undefined) => {
    await pre(id, command);
    await act();
    await post(id, command);
  };
  const stop = async () => {
    const r = await send("claude-stop.json");
    assert.ok(r.summary, "Stop returned a round summary");
    return r.summary.taskId as number;
  };
  const read = <T,>(fn: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return fn(l);
    } finally {
      l.close();
    }
  };
  const storeFiles = async (taskId = 1): Promise<string[]> => (await readdir(path.join(home, "tasks", String(taskId), "states")).catch(() => [] as string[])).filter((n) => !n.startsWith(".")).sort();
  const states = (taskId = 1) => read((l) => l.fileStatesForTask(taskId));
  const f = (rel: string) => path.join(folder, rel);
  return { home, folder, f, send, pre, post, call, stop, read, storeFiles, states };
}

/** Every hook state file under the home, parsed. */
async function hookStates(home: string): Promise<Array<{ file: string; state: { files: Record<string, { sha: string; kept?: string; copy: string }> } }>> {
  const out: Array<{ file: string; state: { files: Record<string, { sha: string; kept?: string; copy: string }> } }> = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name === "state.json") out.push({ file: full, state: JSON.parse(await readFile(full, "utf8")) });
    }
  };
  await walk(home);
  return out;
}

describe("claimed files have their own allowance at the task's first event", () => {
  it("claimed files are kept whole past the general caps, up to the claimed caps; past those, hash only with the reason in words", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    const t = await setup({
      caps: { scanFiles: 1, scanBytes: 1024 * 1024, claimedFiles: 2 },
      files: { "a.xlsx": s0, "b.xlsx": s0, "c.xlsx": s0, "n1.txt": "one\n", "n2.txt": "two\n" },
    });
    await t.call("toolu_A", "ls");
    await t.stop();
    const first = new Map(t.states().filter((r) => r.prevSha256 === null).map((r) => [path.basename(r.filePath), r]));
    assert.equal(first.get("a.xlsx")!.kept, "whole", "the general one-file cap does not take a claimed file's place");
    assert.equal(first.get("b.xlsx")!.kept, "whole");
    assert.equal(first.get("c.xlsx")!.kept, "hash", "past the claimed file cap");
    assert.match(first.get("c.xlsx")!.note, /more than 2 files a connector reads, so only this file's hash is kept/);
    assert.equal(first.get("n1.txt")!.kept, "whole", "the general caps still apply to every other file, and claimed files never use them up");
    assert.equal(first.get("n2.txt")!.kept, "hash");
  });

  it("past the claimed byte cap a claimed file falls back to hash only, never a hard stop", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    const t = await setup({ caps: { claimedBytes: s0.length + 10 }, files: { "a.xlsx": s0, "b.xlsx": s0 } });
    await t.call("toolu_A", "ls");
    await t.stop();
    const first = new Map(t.states().filter((r) => r.prevSha256 === null).map((r) => [path.basename(r.filePath), r]));
    assert.equal(first.get("a.xlsx")!.kept, "whole");
    assert.equal(first.get("b.xlsx")!.kept, "hash");
    assert.match(first.get("b.xlsx")!.note, /of files a connector reads, so only this file's hash is kept/);
  });

  it("a claimed file whose copy fails at the start is kept as its hash, with the reason, and the task goes on", { skip: process.platform === "win32" ? "needs POSIX: a 0500 folder mode does not stop a Windows write" : process.getuid?.() === 0 ? "root ignores folder modes" : false }, async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    // Per-session tasks: the first event's copies go to the folder's holding place, which cannot be written, so every copy fails.
    const t = await setup({ files: { "a.xlsx": s0, "n.txt": "n\n" }, perSession: true });
    const key = createHash("sha256").update(`claude-hook:${t.folder}`).digest("hex").slice(0, 16);
    const copies = path.join(t.home, "hooks", key, "copies");
    await mkdir(copies, { recursive: true, mode: 0o700 });
    await chmod(copies, 0o500);
    await t.pre("toolu_A", "ls");
    await chmod(copies, 0o700);
    await t.post("toolu_A", "ls");
    // The task goes on: a later credited change opens it, with the start of the task's states.
    await t.call("toolu_B", "echo m > m.txt", () => writeFile(t.f("m.txt"), "m\n"));
    await t.stop();
    const a = t.states().find((r) => r.filePath === t.f("a.xlsx") && r.prevSha256 === null)!;
    assert.equal(a.kept, "hash");
    assert.equal(a.sha256, sha(s0), "a plain SHA-256");
    assert.match(a.note, /the copy at the start of the task failed/);
  });
});

describe("one identity in the hook", () => {
  it("no hook write produces a prefixed value: hash-only workbooks are recorded as their plain SHA-256, in the ledger and the state file", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    const t = await setup({ caps: { claimedFiles: 0, scanFiles: 0 }, files: { "a.xlsx": s0, "n.txt": "n\n" } });
    await t.call("toolu_A", "ls");
    await writeFile(t.f("a.xlsx"), await readFile(probe("S1.xlsx")));
    await t.stop();
    const rows = t.states();
    assert.ok(rows.some((r) => r.filePath === t.f("a.xlsx") && r.kept === "hash"), "a hash-only workbook was recorded");
    for (const r of rows) {
      assert.doesNotMatch(r.sha256, PREFIXED, r.filePath);
      assert.doesNotMatch(r.prevSha256 ?? "", PREFIXED, r.filePath);
    }
    assert.equal(rows.find((r) => r.filePath === t.f("a.xlsx") && r.prevSha256 === null)!.sha256, sha(s0));
    for (const { state } of await hookStates(t.home)) for (const [file, v] of Object.entries(state.files)) assert.doesNotMatch(v.sha, PREFIXED, file);
  });

});

describe("copy on name", () => {
  it("a hash-only claimed file named by a call is read at its Pre: the same SHA stores its bytes under the recorded state, with no new state and no step", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    const t = await setup({ caps: { claimedFiles: 0, scanFiles: 0 }, files: { "big.xlsx": s0 } });
    await t.call("toolu_A", "ls");
    assert.ok(!(await t.storeFiles()).includes(sha(s0)), "past the allowance: no bytes yet");
    await t.pre("toolu_B", "python edit.py big.xlsx");
    assert.ok((await t.storeFiles()).includes(sha(s0)), "the bytes are stored under the recorded SHA at the Pre");
    assert.equal(t.states().filter((r) => r.filePath === t.f("big.xlsx")).length, 1, "no new state");
    await writeFile(t.f("big.xlsx"), await readFile(probe("S1.xlsx")));
    await t.post("toolu_B", "python edit.py big.xlsx");
    await t.stop();
    const rows = t.states().filter((r) => r.filePath === t.f("big.xlsx"));
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.prevSha256, sha(s0), "the change's before-side is the recorded state");
    assert.deepEqual(rows[1]!.credited, ["toolu_B"]);
    const stored = await t.storeFiles();
    assert.ok(stored.includes(sha(s0)) && stored.includes(rows[1]!.sha256), "both sides kept");
  });

  it("a different SHA at the Pre: the sweep records the change first (window rule) and no bytes are attached to the recorded state", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    const s1 = await readFile(probe("S1.xlsx"));
    const t = await setup({ caps: { claimedFiles: 0, scanFiles: 0 }, files: { "big.xlsx": s0 } });
    await t.call("toolu_A", "ls");
    // Changed between calls, then named.
    await writeFile(t.f("big.xlsx"), s1);
    await t.pre("toolu_B", "python edit.py big.xlsx");
    const rows = t.states().filter((r) => r.filePath === t.f("big.xlsx"));
    assert.equal(rows.length, 2, "the change is a state of its own, found at the Pre");
    assert.equal(rows[1]!.prevSha256, sha(s0));
    assert.equal(rows[1]!.sha256, sha(s1));
    assert.deepEqual(rows[1]!.credited, [], "no call was open: not from an agent call");
    const stored = await t.storeFiles();
    assert.ok(!stored.includes(sha(s0)), "the recorded state's bytes were never seen, so nothing is attached to it");
    assert.ok(stored.includes(sha(s1)));
    await t.post("toolu_B", "python edit.py big.xlsx");
    await t.stop();
  });

  it("an unclaimed hash-only file named by a call is not copied", async () => {
    const t = await setup({ caps: { scanFiles: 0 }, files: { "notes.txt": "one\n" } });
    await t.call("toolu_A", "ls");
    await t.call("toolu_B", "cat notes.txt");
    await t.stop();
    assert.ok(!(await t.storeFiles()).includes(sha("one\n")));
  });
});

describe("the eviction order is by claim, not by extension", () => {
  it("a claimed .foo middle state outlives an unclaimed .xlsx one under budget pressure", async () => {
    const claimed = (f: string) => f.endsWith(".foo");
    const t = await setup({ claimed, caps: { taskBytes: 700_000 }, files: { "d.foo": "f0", "w.xlsx": "w0" } });
    await t.call("toolu_A", "gen foo 1", () => writeFile(t.f("d.foo"), "1".repeat(200_000)));
    await t.call("toolu_B", "gen xlsx 1", () => writeFile(t.f("w.xlsx"), "2".repeat(200_000)));
    await t.call("toolu_C", "gen foo 2", () => writeFile(t.f("d.foo"), "3".repeat(150_000)));
    await t.call("toolu_D", "gen xlsx 2", () => writeFile(t.f("w.xlsx"), "4".repeat(150_000)));
    await t.stop();
    const names = await t.storeFiles();
    assert.ok(names.includes(sha("1".repeat(200_000))), "the claimed middle state stays");
    assert.ok(!names.includes(sha("2".repeat(200_000))), "the unclaimed middle state went first, whatever its ending");
  });

  it("a state whose capture is still pending is never evicted, neither side of it", async () => {
    const t = await setup({ caps: { taskBytes: 400_000 }, files: { "w.xlsx": "w0", "n.txt": "n0" } });
    await t.call("toolu_A", "gen 1", () => writeFile(t.f("w.xlsx"), "1".repeat(200_000)));
    await t.call("toolu_B", "gen 2", () => writeFile(t.f("w.xlsx"), "2".repeat(200_000)));
    await t.call("toolu_C", "gen 3", () => writeFile(t.f("w.xlsx"), "3".repeat(200_000)));
    await t.stop();
    const pending = t.states().filter((r) => r.capture === "pending");
    const names = await t.storeFiles();
    for (const r of pending) {
      assert.ok(names.includes(r.sha256), `pending after side ${r.sha256.slice(0, 8)} kept`);
      if (r.prevSha256 !== null && r.prevSha256 !== sha("w0")) assert.ok(names.includes(r.prevSha256), "pending before side kept");
    }
  });
});

describe("the app tail", () => {
  const SAVE = `osascript -e 'tell application "Microsoft Excel" to save workbook "book.xlsx"'`;

  it("an app's save found after the call's Post, with no call open, is credited to the call that named the file, basis named, with the side text", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    const t = await setup({ files: { "book.xlsx": s0 } });
    await t.call("toolu_A", "ls");
    await t.call("toolu_X", SAVE);
    // Excel saves after the call ended.
    await writeFile(t.f("book.xlsx"), await readFile(probe("S1.xlsx")));
    await t.stop();
    const change = t.states().filter((r) => r.filePath === t.f("book.xlsx"))[1]!;
    assert.deepEqual(change.credited, ["toolu_X"]);
    assert.equal(change.creditBasis, "named");
    assert.ok(change.note.includes(TAIL_NOTE), change.note);
  });

  it("the tail ends at the session's next call: a save found at that call's Post is its own, and one found later with nothing open is outside", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    const t = await setup({ files: { "book.xlsx": s0 } });
    await t.call("toolu_A", "ls");
    await t.call("toolu_X", SAVE);
    await t.call("toolu_Y", "sleep 1");
    await writeFile(t.f("book.xlsx"), await readFile(probe("S1.xlsx")));
    await t.stop();
    const change = t.states().filter((r) => r.filePath === t.f("book.xlsx"))[1]!;
    assert.deepEqual(change.credited, [], "the tail ended when the next call opened");
  });

  it("no tail for a command that does not name the file, nor for one that cannot run on after its result", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    for (const command of [`osascript -e 'tell application "Microsoft Excel" to save workbook "other.xlsx"'`, "python save.py book.xlsx"]) {
      const t = await setup({ files: { "book.xlsx": s0 } });
      await t.call("toolu_A", "ls");
      await t.call("toolu_X", command);
      await writeFile(t.f("book.xlsx"), await readFile(probe("S1.xlsx")));
      await t.stop();
      const change = t.states().filter((r) => r.filePath === t.f("book.xlsx"))[1]!;
      assert.deepEqual(change.credited, [], command);
    }
  });

  it("with another call open, the tail joins the candidates (joint), never takes the credit alone", async () => {
    const s0 = await readFile(probe("S0.xlsx"));
    const t = await setup({ files: { "book.xlsx": s0 } });
    await t.call("toolu_A", "ls");
    await t.call("toolu_X", SAVE);
    // Another session's call is open when the save is found (the same session's next call would end the tail).
    await t.send("claude-pre-bash.json", { session_id: "other-session", tool_use_id: "toolu_O", tool_input: { command: "make", description: "o" } });
    await writeFile(t.f("book.xlsx"), await readFile(probe("S1.xlsx")));
    await t.send("claude-post-bash.json", { session_id: "other-session", tool_use_id: "toolu_O", tool_input: { command: "make", description: "o" } });
    await t.stop();
    const change = t.states().filter((r) => r.filePath === t.f("book.xlsx"))[1]!;
    assert.deepEqual(change.credited, ["toolu_O", "toolu_X"]);
  });
});

describe("sign-off compares like for like", () => {
  async function task() {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-so-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-so-folder-")));
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    });
    const ledger = openLedger(home);
    cleanups.push(async () => ledger.close());
    const tasks = new TaskStore(ledger, home, [createFilesLayer()]);
    const f = (n: string) => path.join(folder, n);
    await writeFile(f("a.txt"), "one\n");
    await writeFile(f("w.xlsx"), await readFile(probe("S0.xlsx")));
    const id = await tasks.touch("c", f("a.txt"));
    await tasks.submit("c", "final", true);
    return { ledger, f, id };
  }

  it("a workbook's plain SHA-256 fingerprint snapshot that still matches signs (no false 'changed')", async () => {
    const { ledger, f, id } = await task();
    const seq = ledger.roundsForTask(id).at(-1)!.seq;
    const snaps = ledger.snapshotsForTask(id).filter((s) => s.round === seq && s.filePath === f("w.xlsx"));
    // What the TaskStore writes after F1: the plain SHA-256.
    if (snaps.length === 0) ledger.recordSnapshot({ taskId: id, round: seq, filePath: f("w.xlsx"), layer: "files", snapshotPath: "", mode: "fingerprint", sha256: sha(await readFile(f("w.xlsx"))) });
    else assert.fail("the files layer took a snapshot of the workbook; plant the value another way");
    const got = await collectSignoff(ledger, id, "Dana");
    assert.ok(got);
    // An edit after the submit is caught.
    await writeFile(f("w.xlsx"), await readFile(probe("S1.xlsx")));
    await assert.rejects(() => collectSignoff(ledger, id, "Dana"), /changed after the agent's last submit/);
  });

});
