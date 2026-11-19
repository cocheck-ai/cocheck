import { afterEach, describe, it } from "node:test";
import { readSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { officeClaims, workbookClaims } from "./helpers/claims.ts";

// per-step file state. A step is one ledger row written by every sweep that changed a file, in the same flush as
// its ops; its id is the key ops and states point at. Every changed file at every step has its whole bytes in the task's
// store (`tasks/<id>/states/<sha256>`), written once per hash, plus a state event (step, file, sha, previous sha,
// Pre/Post/Stop, calls open). Fixtures: the probe's casebook S0 workbook.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (name: string) => path.join(FIXTURES, "probe", name);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type Caps = { fileBytes?: number; taskBytes?: number; scanFiles?: number; scanBytes?: number };

async function setup(opts: { caps?: Caps; extra?: Record<string, string | Uint8Array>; claimed?: (file: string) => boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const file = path.join(folder, "casebook.xlsx");
  await copyFile(probe("S0.xlsx"), file);
  for (const [name, data] of Object.entries(opts.extra ?? {})) await writeFile(path.join(folder, name), data);
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const hostOpts = { perSession: false, host: "claude" as const, home, claimed: opts.claimed ?? workbookClaims, folder, ...(opts.caps ? { caps: opts.caps } : {}) };
  const send = (name: string, over: Record<string, unknown> = {}) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, hostOpts));
  /** One tool call whose command is `command` and whose effect is `act`. */
  const call = async (id: string, command: string, act: () => Promise<void>) => {
    const tool_input = { command, description: id };
    await send("claude-pre-bash.json", { tool_use_id: id, tool_input });
    await act();
    await send("claude-post-bash.json", { tool_use_id: id, tool_input });
  };
  const pre = (id: string, command: string) => send("claude-pre-bash.json", { tool_use_id: id, tool_input: { command, description: id } });
  const post = (id: string, command: string) => send("claude-post-bash.json", { tool_use_id: id, tool_input: { command, description: id } });
  const stop = async () => {
    const r = await send("claude-stop.json");
    assert.ok(r.summary, "Stop returned a round summary");
    return r.summary.taskId;
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
  return { home, folder, file, call, pre, post, stop, read, storeFiles, send };
}

/** The workbook with its first plain number cell set to `value` (the first call to it has a before value to show). */
function setFirstNumber(bytes: Uint8Array, value: number): Uint8Array {
  const zip = unzipSync(bytes);
  for (const part of Object.keys(zip).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
    const xml = strFromU8(zip[part]!);
    const hit = /<c r="[A-Z]+\d+"(?: s="\d+")?><v>-?[\d.]+<\/v><\/c>/.exec(xml)?.[0];
    if (hit === undefined) continue;
    return zipSync({ ...zip, [part]: strToU8(xml.replace(hit, hit.replace(/<v>[^<]*<\/v>/, `<v>${value}</v>`))) }, { mtime: new Date(2020, 0, 1) });
  }
  throw new Error("no plain number cell in the fixture");
}

const opsOf = (home: string, taskId: number) => {
  const l = openLedger(home);
  try {
    return l.okOpsForTask(taskId, 0, l.maxOpId()).map((o) => ({ id: o.id, args: JSON.parse(o.argsJson) as Record<string, any> }));
  } finally {
    l.close();
  }
};

// an op names the file it is credited with; it carries no cells with their before and after
// (the connector's change list says what changed). Who wrote what, and in which order, stays on the file states.
describe("two calls on one file, each credited with its own state (was: a cell carries its before and after)", () => {
  it("two calls write the same cell in one round: each op names the file, and the states chain in order to their writers", async () => {
    const t = await setup();
    const base = new Uint8Array(await readFile(t.file));
    const v1 = setFirstNumber(base, 111);
    const v2 = setFirstNumber(base, 222);
    await t.call("toolu_A", "python3 first.py", () => writeFile(t.file, v1));
    await t.call("toolu_B", "python3 second.py", () => writeFile(t.file, v2));
    const taskId = await t.stop();
    const ops = opsOf(t.home, taskId);
    for (const id of ["toolu_A", "toolu_B"]) assert.ok(ops.some((o) => o.args.tool_use_id === id && o.args.path === t.file), `${id}'s op names the file`);
    const l = openLedger(t.home);
    try {
      const states = l.fileStatesForTask(taskId).filter((x) => x.filePath === t.file && x.prevSha256 !== null);
      assert.deepEqual(states.map((x) => [...x.credited]), [["toolu_A"], ["toolu_B"]]);
      assert.equal(states[1]!.prevSha256, states[0]!.sha256, "the second call's state starts from the first's");
    } finally {
      l.close();
    }
  });

  it("an op names the file and carries no cell list", async () => {
    const t = await setup();
    const base = new Uint8Array(await readFile(t.file));
    await t.call("toolu_A", "python3 one.py", () => writeFile(t.file, setFirstNumber(base, 5)));
    const taskId = await t.stop();
    const op = opsOf(t.home, taskId).find((o) => o.args.path === t.file)!;
    assert.equal(op.args.tool_use_id, "toolu_A");
    assert.equal(op.args.hookCells, undefined);
  });
});

describe("a step is a ledger row; ops and states point at its id", () => {
  it("each changing sweep is one step; the op names the ids; states carry sha, previous sha, phase and calls open", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    const v1 = setFirstNumber(s0, 111);
    const v2 = setFirstNumber(s0, 222);
    await t.call("toolu_A", "python3 first.py", () => writeFile(t.file, v1));
    await t.call("toolu_B", "python3 second.py", () => writeFile(t.file, v2));
    await t.call("toolu_C", "echo nothing", async () => {});
    const taskId = await t.stop();
    const { steps, states } = t.read((l) => ({ steps: l.stepsForTask(taskId), states: l.fileStatesForTask(taskId) }));
    const mine = states.filter((s) => s.filePath === t.file);
    // baseline, then A's Post, then B's Post; C changed nothing and made no step.
    assert.deepEqual(mine.map((s) => [s.prevSha256 === null ? null : s.prevSha256.slice(0, 8), s.sha256.slice(0, 8), s.phase]), [
      [null, sha(s0).slice(0, 8), "Pre"],
      [sha(s0).slice(0, 8), sha(v1).slice(0, 8), "Post"],
      [sha(v1).slice(0, 8), sha(v2).slice(0, 8), "Post"],
    ]);
    assert.deepEqual(mine[1]!.callsOpen, ["toolu_A"]);
    assert.deepEqual(mine[2]!.callsOpen, ["toolu_B"]);
    assert.deepEqual(mine.map((s) => s.credited), [[], ["toolu_A"], ["toolu_B"]], "the baseline credits nobody; a Post credits the call that was open");
    assert.deepEqual(steps.map((s) => s.credited), mine.map((s) => s.credited));
    assert.equal(steps.length, new Set(states.map((s) => s.stepId)).size, "a step exists only for a sweep that changed a file");
    const ops = opsOf(t.home, taskId);
    const stepOf = (id: string) => ops.find((o) => o.args.tool_use_id === id)!.args.steps as number[];
    assert.deepEqual(stepOf("toolu_A"), [mine[1]!.stepId]);
    assert.deepEqual(stepOf("toolu_B"), [mine[2]!.stepId]);
    assert.deepEqual(stepOf("toolu_C"), []);
    assert.ok(typeof ops[0]!.args.hookOpKey === "string", "seq stays the idempotency key");
  });

  it("every state's whole bytes are in the task store, once per hash", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    const v1 = setFirstNumber(s0, 111);
    await t.call("toolu_A", "python3 a.py", () => writeFile(t.file, v1));
    await t.call("toolu_B", "python3 b.py", () => writeFile(t.file, s0)); // back to the first bytes: no new hash
    await t.call("toolu_C", "python3 c.py", () => writeFile(t.file, v1));
    await t.stop();
    assert.deepEqual(await t.storeFiles(), [sha(s0), sha(v1)].sort());
    assert.deepEqual(new Uint8Array(await readSealed(path.join(t.home, "tasks", "1", "states", sha(v1)))), v1);
  });

  it("the folder-keyed hooks/<key>/copies holds nothing once the store has the states", async () => {
    const t = await setup();
    await t.call("toolu_A", "python3 a.py", async () => writeFile(t.file, setFirstNumber(new Uint8Array(await readFile(t.file)), 7)));
    await t.stop();
    const keys = await readdir(path.join(t.home, "hooks"));
    assert.equal(keys.length, 1);
    assert.deepEqual(await readdir(path.join(t.home, "hooks", keys[0]!, "copies")), []);
  });

  it("copies the old place held move into the task store at the next event", async () => {
    const t = await setup();
    await t.call("toolu_A", "python3 a.py", async () => writeFile(t.file, setFirstNumber(new Uint8Array(await readFile(t.file)), 7)));
    const keys = await readdir(path.join(t.home, "hooks"));
    const dir = path.join(t.home, "hooks", keys[0]!);
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    const tracked = state.files[t.file];
    const legacy = path.join(dir, "copies", "41.xlsx");
    await copyFile(tracked.copy, legacy);
    await rm(tracked.copy);
    tracked.copy = legacy;
    delete tracked.size;
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
    await t.call("toolu_B", "echo hi", async () => {});
    const after = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(path.dirname(after.files[t.file].copy), path.join(t.home, "tasks", "1", "states"));
    assert.deepEqual(await readdir(path.join(dir, "copies")), []);
    assert.ok((await t.storeFiles()).includes(tracked.sha));
  });
});

describe("every watched file, any type", () => {
  it("copies a text file and a deck at the start and keeps each change as a state credited to the call that was open", async () => {
    const deck = new Uint8Array(await readFile(path.join(FIXTURES, "ppt-table-deck.pptx")));
    const t = await setup({ extra: { "notes.txt": "one\n", "deck.pptx": deck } });
    await t.call("toolu_A", "python3 write_notes.py", () => writeFile(path.join(t.folder, "notes.txt"), "two!\n"));
    await t.call("toolu_B", "python3 edit_deck.py", () => writeFile(path.join(t.folder, "deck.pptx"), Buffer.concat([deck, Buffer.from("x")])));
    const taskId = await t.stop();
    assert.ok((await t.storeFiles()).includes(sha("one\n")), "the text file as it was at the start");
    assert.ok((await t.storeFiles()).includes(sha(deck)), "the deck as it was at the start");
    const states = t.read((l) => l.fileStatesForTask(taskId));
    const notes = states.filter((s) => s.filePath === path.join(t.folder, "notes.txt"));
    assert.deepEqual(notes.map((s) => [s.prevSha256, s.sha256]), [[null, sha("one\n")], [sha("one\n"), sha("two!\n")]]);
    assert.deepEqual(notes[1]!.callsOpen, ["toolu_A"]);
    const ops = opsOf(t.home, taskId);
    assert.ok((ops.find((o) => o.args.tool_use_id === "toolu_A")!.args.steps as number[]).includes(notes[1]!.stepId));
    assert.ok(!(ops.find((o) => o.args.tool_use_id === "toolu_B")!.args.steps as number[]).includes(notes[1]!.stepId));
  });
});

describe("a changed file never reads unchanged", () => {
  /** Whole-second mtime: it survives a round trip through utimes to the nanosecond, so a rewrite can restore it exactly. */
  const WHOLE_SECOND = 1_700_000_000;
  const pin = (file: string) => utimes(file, WHOLE_SECOND, WHOLE_SECOND);
  const big = async (file: string) => stat(file, { bigint: true });
  /**
   * Rewrites `file` in place so its size, mtime (to the nanosecond) and inode are exactly what they were; asserts that.
   * ctime cannot be set from user space, so it moves with the write. `keepCtime` then also writes the new ctime into the
   * adapter's tracked state, standing for a writer or filesystem that moved nothing the stat filter can see: only the
   * full hash is left to catch it.
   */
  const sameStat = async (t: Awaited<ReturnType<typeof setup>>, file: string, text: string, keepCtime: boolean) => {
    const before = await big(file);
    await writeFile(file, text); // in place: same inode
    await pin(file);
    const after = await big(file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs, "mtime is the same to the nanosecond");
    assert.equal(after.ino, before.ino);
    if (!keepCtime) return;
    const dir = path.join(t.home, "hooks", (await readdir(path.join(t.home, "hooks")))[0]!);
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    state.files[file].ctimeNs = String(after.ctimeNs);
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
  };

  it("a writer that keeps size, mtime and inode is caught by the full hash at Stop", async () => {
    const t = await setup({ extra: { "notes.txt": "aaaa\n" } });
    const notes = path.join(t.folder, "notes.txt");
    await pin(notes);
    await t.pre("toolu_A", "python3 quiet.py");
    await t.post("toolu_A", "python3 quiet.py");
    await sameStat(t, notes, "bbbb\n", true);
    await t.stop();
    const mine = t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === notes);
    assert.deepEqual(mine.map((s) => [s.sha256, s.phase]), [[sha("aaaa\n"), "Pre"], [sha("bbbb\n"), "Stop"]]);
  });

  it("the Pre of a call that names the file hashes it in full", async () => {
    const t = await setup({ extra: { "notes.txt": "aaaa\n" } });
    const notes = path.join(t.folder, "notes.txt");
    await pin(notes);
    await t.call("toolu_A", "echo start", async () => {});
    await sameStat(t, notes, "bbbb\n", true);
    await t.pre("toolu_B", `cat ${notes}`);
    const mine = t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === notes);
    assert.deepEqual(mine.map((s) => [s.sha256, s.phase]), [[sha("aaaa\n"), "Pre"], [sha("bbbb\n"), "Pre"]]);
    assert.deepEqual(mine[1]!.callsOpen, [], "no call was open at that sweep, so none is credited");
  });

  it("a same-stat write by a call that does not name the file is credited to that call, not left as a hand edit at Stop", async () => {
    const t = await setup({ extra: { "notes.txt": "aaaa\n" } });
    const notes = path.join(t.folder, "notes.txt");
    await pin(notes);
    await t.call("toolu_A", "python3 edit.py", () => sameStat(t, notes, "bbbb\n", false));
    await t.stop();
    const mine = t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === notes);
    assert.deepEqual(mine.map((s) => [s.sha256, s.phase, s.callsOpen]), [[sha("aaaa\n"), "Pre", []], [sha("bbbb\n"), "Post", ["toolu_A"]]]);
  });

  it("a change to the file's ctime alone (same bytes) makes no state event", async () => {
    const t = await setup({ extra: { "notes.txt": "aaaa\n" } });
    const notes = path.join(t.folder, "notes.txt");
    await t.call("toolu_A", "echo start", async () => {});
    await t.call("toolu_B", "chmod 600 notes.txt", () => chmod(notes, 0o600));
    await t.stop();
    assert.equal(t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === notes).length, 1);
  });

  it("a change found when no call is open is not credited to the call that opens next", async () => {
    const t = await setup({ extra: { "notes.txt": "aaaa\n" } });
    await t.call("toolu_A", "echo start", async () => {});
    await writeFile(path.join(t.folder, "notes.txt"), "cccc!\n");
    await t.call("toolu_B", "echo later", async () => {});
    const taskId = await t.stop();
    const change = t.read((l) => l.fileStatesForTask(taskId)).find((s) => s.sha256 === sha("cccc!\n"))!;
    assert.deepEqual(change.callsOpen, []);
    const b = opsOf(t.home, taskId).find((o) => o.args.tool_use_id === "toolu_B")!;
    assert.deepEqual(b.args.steps, [], "toolu_B was not open when the file moved");
  });
});

describe("/: an unreadable workbook is a state of its own (the full rules are in hook-unreadable.test.ts)", () => {
  it("a half-written workbook is stored and recorded, credited to the call open; the next readable sweep records the whole one", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    const v1 = setFirstNumber(s0, 111);
    await t.call("toolu_A", "python3 half.py", () => writeFile(t.file, "PK not a workbook"));
    assert.deepEqual(await t.storeFiles(), [sha(s0), sha("PK not a workbook")].sort(), "the unreadable bytes are kept");
    const half = t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === t.file);
    assert.deepEqual(half.map((s) => [s.sha256, s.credited]), [[sha(s0), []], [sha("PK not a workbook"), ["toolu_A"]]]);
    await t.call("toolu_B", "python3 whole.py", () => writeFile(t.file, v1));
    const mine = t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === t.file);
    assert.deepEqual(mine.map((s) => s.sha256), [sha(s0), sha("PK not a workbook"), sha(v1)]);
    assert.deepEqual(mine[2]!.callsOpen, ["toolu_B"]);
  });
});

describe("caps are written in words", () => {
  it("above the per-file cap a file keeps its first and current state; the ones between go, with the reason", async () => {
    const t = await setup({ caps: { fileBytes: 100 }, extra: { "big.txt": "a".repeat(150) } });
    const big = path.join(t.folder, "big.txt");
    for (const [i, ch] of ["b", "c", "d"].entries()) await t.call(`toolu_${i}`, `python3 grow${i}.py`, () => writeFile(big, ch.repeat(160 + i)));
    const taskId = await t.stop();
    const names = await t.storeFiles();
    assert.ok(names.includes(sha("a".repeat(150))), "the first state stays");
    assert.ok(names.includes(sha("d".repeat(162))), "the current state stays");
    assert.ok(!names.includes(sha("b".repeat(160))) && !names.includes(sha("c".repeat(161))), "the states between are gone");
    const { states, removals } = t.read((l) => ({ states: l.fileStatesForTask(taskId).filter((s) => s.filePath === big), removals: l.stateRemovalsForTask(taskId) }));
    assert.ok(states.every((s) => /over 100 bytes/.test(s.note) && /first and current/.test(s.note)), states.map((s) => s.note).join(" | "));
    assert.deepEqual(removals.map((r) => r.sha256).sort(), [sha("b".repeat(160)), sha("c".repeat(161))].sort());
    assert.match(removals[0]!.reason, /first and current state are kept/);
  });

  it("past the per-task cap the oldest middle states drop to hashes, never a file's first or current", async () => {
    const t = await setup({ caps: { taskBytes: 1_000_000 }, extra: { "log.txt": "start\n" } });
    const log = path.join(t.folder, "log.txt");
    const base = (await stat(t.file)).size;
    // The workbook alone is ~170 KB; five 300 KB states of log.txt pass 1 MB.
    for (let i = 0; i < 5; i++) await t.call(`toolu_${i}`, `python3 log${i}.py`, () => writeFile(log, String(i).repeat(300_000)));
    const taskId = await t.stop();
    assert.ok(base < 1_000_000);
    const names = await t.storeFiles();
    assert.ok(names.includes(sha("start\n")), "first stays");
    assert.ok(names.includes(sha("4".repeat(300_000))), "current stays");
    const removals = t.read((l) => l.stateRemovalsForTask(taskId));
    assert.ok(removals.length >= 1);
    assert.match(removals[0]!.reason, /passed/);
    assert.match(removals[0]!.reason, /only their hashes are kept/);
    const total = (await Promise.all(names.map(async (n) => (await stat(path.join(t.home, "tasks", "1", "states", n))).size))).reduce((a, b) => a + b, 0);
    assert.ok(total <= 1_000_000, `store is ${total} bytes`);
  });

  it("a cap drop deletes the dropped state's cached preview and leaves a kept state's alone", async () => {
    const t = await setup({ caps: { taskBytes: 1_000_000 }, extra: { "log.txt": "start\n" } });
    const log = path.join(t.folder, "log.txt");
    const prevDir = path.join(t.home, "tasks", "1", "previews");
    const planted: string[] = [];
    for (let i = 0; i < 5; i++) {
      await t.call(`toolu_${i}`, `python3 log${i}.py`, () => writeFile(log, String(i).repeat(300_000)));
      const s = sha(String(i).repeat(300_000));
      await mkdir(prevDir, { recursive: true });
      await writeFile(path.join(prevDir, `${s}.png`), "png");
      planted.push(s);
    }
    const taskId = await t.stop();
    const removed = new Set(t.read((l) => l.stateRemovalsForTask(taskId)).map((r) => r.sha256));
    const gone = planted.filter((s) => removed.has(s));
    assert.ok(gone.length >= 1, "at least one planted state was dropped");
    for (const s of gone) assert.equal(existsSync(path.join(prevDir, `${s}.png`)), false, "a dropped state keeps no picture");
    assert.ok(existsSync(path.join(prevDir, `${sha("4".repeat(300_000))}.png`)), "the current state's picture stays");
  });

  it("past the scan caps a file is fingerprint only at the start, in words; the scan cap does not limit what the task writes", async () => {
    const t = await setup({ caps: { scanFiles: 2 }, extra: { "a.txt": "a1", "b.txt": "b1", "c.txt": "c1" } });
    const c = path.join(t.folder, "c.txt");
    await t.call("toolu_A", "python3 c.py", () => writeFile(c, "c2!"));
    const taskId = await t.stop();
    const states = t.read((l) => l.fileStatesForTask(taskId));
    const cs = states.filter((s) => s.filePath === c);
    assert.equal(cs.length, 2, "baseline and the change");
    assert.ok(cs[0]!.kept === "hash" && /not copied: the folder has more than 2 files/.test(cs[0]!.note), cs.map((s) => s.note).join(" | "));
    assert.equal(cs[1]!.kept, "whole", "the written state is kept");
    assert.ok(!(await t.storeFiles()).includes(sha("c1")), "no bytes for the start");
    assert.ok((await t.storeFiles()).includes(sha("c2!")), "bytes for the write");
    assert.notEqual(cs[0]!.sha256, cs[1]!.sha256);
    assert.ok(states.some((s) => s.filePath === t.file && s.kept === "whole"), "the workbook is still copied: the layer's own files come first");
  });
});

describe("a large folder does not make the task's own writes hash-only", () => {
  const filing = (n: number) => `filing ${n} `.repeat(25_000).slice(0, 200_000);
  const files = () => ({ "f1.txt": filing(1), "f2.txt": filing(2), "f3.txt": filing(3) });

  it("recorded shape: filings past the start cap, then a memo, a deck and a workbook are all kept whole", async () => {
    const t = await setup({ caps: { scanBytes: 400_000 }, extra: files() });
    const base = new Uint8Array(await readFile(t.file));
    const memo = path.join(t.folder, "memo.docx");
    const deck = path.join(t.folder, "deck.pptx");
    await t.call("toolu_A", "python3 memo.py", () => writeFile(memo, "memo one"));
    await t.call("toolu_B", "python3 deck.py", () => writeFile(deck, "deck one"));
    await t.call("toolu_C", "python3 book.py", () => writeFile(t.file, setFirstNumber(base, 77)));
    await t.call("toolu_D", "python3 memo.py", () => writeFile(memo, "memo two"));
    const taskId = await t.stop();
    const states = t.read((l) => l.fileStatesForTask(taskId));
    const hashOnly = states.filter((s) => s.kept === "hash");
    assert.ok(hashOnly.length >= 1, "the start cap still applies to the starting copy");
    for (const s of hashOnly) assert.match(s.note, /not copied: the folder holds more than/, "every hash-only state carries its reason");
    assert.ok(hashOnly.every((s) => s.prevSha256 === null), "only starting states are hash-only");
    for (const f of [memo, deck, t.file]) {
      const mine = states.filter((s) => s.filePath === f);
      assert.ok(mine.length >= 1, f);
      assert.ok(mine.every((s) => s.kept === "whole"), `${f}: every state is whole`);
    }
    const names = await t.storeFiles();
    for (const body of ["memo one", "memo two", "deck one"]) assert.ok(names.includes(sha(body)), body);
  });

  it("a filing that is only touched is not copied, and one that is written is", async () => {
    const t = await setup({ caps: { scanBytes: 400_000 }, extra: files() });
    const f3 = path.join(t.folder, "f3.txt");
    const bytes = await readFile(f3);
    await t.call("toolu_A", "touch f3", async () => writeFile(f3, bytes));
    const before = t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === f3 && s.kept === "hash");
    assert.equal(before.length, 1, "the start state only");
    assert.equal((await t.storeFiles()).includes(sha(bytes.toString())), false, "a rewrite with the same bytes copies nothing");
    await t.call("toolu_B", "edit f3", () => writeFile(f3, "edited"));
    const taskId = await t.stop();
    const mine = t.read((l) => l.fileStatesForTask(taskId)).filter((s) => s.filePath === f3);
    assert.deepEqual(mine.map((s) => s.kept), ["hash", "whole"]);
  });

  it("under budget pressure non-office middle states go first and an office middle state stays", async () => {
    // the order is by claim; the built-in connectors claim .docx and .pptx, so the test's claim says so too.
    const t = await setup({ caps: { taskBytes: 1_000_000 }, extra: { "log.txt": "start\n" }, claimed: officeClaims });
    const log = path.join(t.folder, "log.txt");
    const docx = path.join(t.folder, "memo.docx");
    for (const [i, c] of ["a", "b", "c"].entries()) await t.call(`toolu_d${i}`, "doc", () => writeFile(docx, c.repeat(150_000)));
    for (let i = 0; i < 4; i++) await t.call(`toolu_l${i}`, "log", () => writeFile(log, String(i).repeat(300_000)));
    const taskId = await t.stop();
    const names = await t.storeFiles();
    assert.ok(names.includes(sha("b".repeat(150_000))), "the office middle state stays");
    assert.ok(names.includes(sha("a".repeat(150_000))) && names.includes(sha("c".repeat(150_000))), "office first and current stay");
    assert.ok(!names.includes(sha("1".repeat(300_000))), "a non-office middle state went");
    const removals = t.read((l) => l.stateRemovalsForTask(taskId));
    assert.ok(removals.length >= 1 && removals.every((r) => /passed/.test(r.reason) && /files a connector reads last/.test(r.reason)));
    const total = (await Promise.all(names.map(async (n) => (await stat(path.join(t.home, "tasks", "1", "states", n))).size))).reduce((a, b) => a + b, 0);
    assert.ok(total <= 1_000_000, `store is ${total} bytes`);
  });

  it("task-written non-office files past the budget: first and current states go, largest first, and office states stay whole", async () => {
    const t = await setup({ caps: { taskBytes: 1_000_000 }, claimed: officeClaims });
    const docx = path.join(t.folder, "memo.docx");
    const pptx = path.join(t.folder, "deck.pptx");
    const bodies = [1, 2, 3, 4].map((n) => String(n).repeat(300_000 + n));
    for (const [i, b] of bodies.entries()) await t.call(`toolu_f${i}`, "pull", () => writeFile(path.join(t.folder, `data${i}.csv`), b));
    await t.call("toolu_d", "doc", () => writeFile(docx, "m".repeat(100_000)));
    await t.call("toolu_p", "deck", () => writeFile(pptx, "p".repeat(100_000)));
    const taskId = await t.stop();
    const names = await t.storeFiles();
    const total = (await Promise.all(names.map(async (n) => (await stat(path.join(t.home, "tasks", "1", "states", n))).size))).reduce((a, b) => a + b, 0);
    assert.ok(total <= 1_000_000, `store is ${total} bytes`);
    assert.ok(names.includes(sha("m".repeat(100_000))) && names.includes(sha("p".repeat(100_000))), "office states are whole");
    const removed = t.read((l) => l.stateRemovalsForTask(taskId));
    const gone = bodies.filter((b) => !names.includes(sha(b)));
    assert.ok(gone.length >= 1 && gone.length < 4, "some, not all, of the pulled files lost their bytes");
    assert.ok(gone.includes(bodies[3]!), "the largest went first");
    for (const b of gone) assert.match(removed.find((r) => r.sha256 === sha(b))?.reason ?? "", /still passed .*first or current state was deleted too/, "every dropped state has its reason");
    assert.ok(t.read((l) => l.fileStatesForTask(taskId)).some((s) => s.filePath === t.file && s.kept === "whole"));
    assert.ok((await readdir(path.join(t.home, "tasks", "1", "states"))).length > 0);
  });

  it("one file past the whole task budget is a fingerprint with the reason, never stored", async () => {
    const t = await setup({ caps: { taskBytes: 400_000 }, extra: { "log.txt": "start\n" } });
    const log = path.join(t.folder, "log.txt");
    await t.call("toolu_A", "big", () => writeFile(log, "z".repeat(500_000)));
    const taskId = await t.stop();
    const mine = t.read((l) => l.fileStatesForTask(taskId)).filter((s) => s.filePath === log);
    assert.equal(mine.at(-1)!.kept, "hash");
    assert.match(mine.at(-1)!.note, /over the .* a task keeps on disk/);
    assert.equal((await t.storeFiles()).includes(sha("z".repeat(500_000))), false);
  });
});

describe("the store's lifetime", () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** Two rounds on the workbook and notes.txt, every row approved; returns the task id. */
  async function twoRounds(t: Awaited<ReturnType<typeof setup>>) {
    const base = new Uint8Array(await readFile(t.file));
    const notes = path.join(t.folder, "notes.txt");
    await t.call("toolu_A", "python3 a.py", async () => {
      await writeFile(t.file, setFirstNumber(base, 111));
      await writeFile(notes, "two\n");
    });
    await t.stop();
    await t.call("toolu_B", "python3 b.py", async () => {
      await writeFile(t.file, setFirstNumber(base, 222));
      await writeFile(notes, "three\n");
    });
    const taskId = await t.stop();
    return { taskId, base, notes };
  }
  const approveAll = (home: string, taskId: number) => {
    const l = openLedger(home);
    try {
      for (const r of l.reviewRowsForTask(taskId)) l.recordDecision({ rowId: r.id, decision: "approve", note: "", reviewer: "Dana" });
    } finally {
      l.close();
    }
  };

  it("lives across rounds: a round cut and an unsigned task keep every state", async () => {
    const t = await setup({ extra: { "notes.txt": "one\n" } });
    const { base } = await twoRounds(t);
    assert.deepEqual(await t.storeFiles(), [sha(base), sha(setFirstNumber(base, 111)), sha(setFirstNumber(base, 222)), sha("one\n"), sha("two\n"), sha("three\n")].sort());
  });

  it("sign-off drops the middle states; each file's first and final stay", async () => {
    const t = await setup({ extra: { "notes.txt": "one\n" } });
    const { taskId, base } = await twoRounds(t);
    approveAll(t.home, taskId);
    const l = openLedger(t.home);
    try {
      await signOffForTest(l, taskId, "Dana");
      assert.deepEqual(await t.storeFiles(), [sha(base), sha(setFirstNumber(base, 222)), sha("one\n"), sha("three\n")].sort());
      const removed = l.stateRemovalsForTask(taskId);
      assert.deepEqual(removed.map((r) => r.sha256).sort(), [sha(setFirstNumber(base, 111)), sha("two\n")].sort());
      assert.match(removed[0]!.reason, /signed off/);
    } finally {
      l.close();
    }
  });

  it("the first and final states are deleted at the 30-day value expiry", async () => {
    const t = await setup({ extra: { "notes.txt": "one\n" } });
    const { taskId } = await twoRounds(t);
    approveAll(t.home, taskId);
    const l = openLedger(t.home);
    try {
      await signOffForTest(l, taskId, "Dana");
      const early = new TaskStore(l, t.home, [createXlsxLayer({ openState: async () => "closed" })], () => Date.now() + 29 * DAY);
      await early.sweep();
      assert.equal((await t.storeFiles()).length, 4, "kept at 29 days");
      const late = new TaskStore(l, t.home, [createXlsxLayer({ openState: async () => "closed" })], () => Date.now() + 31 * DAY);
      await late.sweep();
      assert.deepEqual(await t.storeFiles(), []);
      assert.ok(l.stateRemovalsForTask(taskId).some((r) => /30 days after sign-off/.test(r.reason)));
    } finally {
      l.close();
    }
  });

  it("an unsigned task ends at the 7-day idle expiry and loses its store", async () => {
    const t = await setup({ extra: { "notes.txt": "one\n" } });
    const { taskId } = await twoRounds(t);
    const l = openLedger(t.home);
    try {
      const six = new TaskStore(l, t.home, [createXlsxLayer({ openState: async () => "closed" })], () => Date.now() + 6 * DAY);
      await six.sweep();
      assert.equal((await t.storeFiles()).length, 6, "kept at 6 days");
      const eight = new TaskStore(l, t.home, [createXlsxLayer({ openState: async () => "closed" })], () => Date.now() + 8 * DAY);
      await eight.sweep();
      assert.equal(l.closureForTask(taskId)?.kind, "expired");
      assert.deepEqual(await t.storeFiles(), []);
      assert.ok(l.stateRemovalsForTask(taskId).some((r) => /went idle for 7 days/.test(r.reason)));
    } finally {
      l.close();
    }
  });
});

describe("a state event says whether a call was credited or only open", () => {
  it("a change found by a Post whose own Pre was never seen has calls open and credits none of them", async () => {
    const t = await setup({ extra: { "notes.txt": "aaaa\n" } });
    const notes = path.join(t.folder, "notes.txt");
    await t.pre("toolu_A", "sleep 1"); // stays open
    await writeFile(notes, "bbbb!\n");
    await t.post("toolu_ghost", "echo no pre"); // no open call of its own: the change is nobody's
    const mine = t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === notes);
    assert.equal(mine.length, 2);
    assert.deepEqual(mine[1]!.callsOpen, ["toolu_A"], "toolu_A was open at that sweep");
    assert.deepEqual(mine[1]!.credited, [], "but it is not credited with a change another call's Post found with no owner");
  });
});

describe("a symbolic link is never followed into the store", () => {
  const secretIn = async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-outside-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, "secret.txt");
    await writeFile(target, "OUTSIDE-SECRET-1\n");
    return target;
  };

  it("a link in the task folder pointing outside it never has its target bytes copied", async () => {
    const target = await secretIn();
    const t = await setup({ extra: { "notes.txt": "aaaa\n" } });
    await symlink(target, path.join(t.folder, "link.txt"));
    await t.call("toolu_A", "python3 a.py", () => writeFile(target, "OUTSIDE-SECRET-2\n"));
    await t.stop();
    const names = await t.storeFiles();
    assert.ok(!names.includes(sha("OUTSIDE-SECRET-1\n")) && !names.includes(sha("OUTSIDE-SECRET-2\n")), "no byte of the target is stored");
    assert.ok(!t.read((l) => l.fileStatesForTask(1)).some((s) => s.filePath.endsWith("link.txt")), "and the link has no state event");
  });

  it("a tracked file replaced by a link is recorded as gone, and the target is not copied", async () => {
    const target = await secretIn();
    const t = await setup({ extra: { "notes.txt": "aaaa\n" } });
    const notes = path.join(t.folder, "notes.txt");
    await t.call("toolu_A", "ln -sf secret notes.txt", async () => {
      await rm(notes);
      await symlink(target, notes);
    });
    await t.stop();
    assert.ok(!(await t.storeFiles()).includes(sha("OUTSIDE-SECRET-1\n")));
    const mine = t.read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === notes);
    assert.deepEqual(mine.map((s) => s.kept), ["whole", "gone"]);
    assert.match(mine[1]!.note, /symbolic link/);
  });
});

describe("the task's store is private", () => {
  it("tasks/<id> and its states folder are 0700 and the stored files 0600", async () => {
    const t = await setup();
    await t.call("toolu_A", "python3 a.py", async () => writeFile(t.file, setFirstNumber(new Uint8Array(await readFile(t.file)), 7)));
    const mode = async (p: string) => (await stat(p)).mode & 0o777;
    assert.equal((await mode(path.join(t.home, "tasks", "1"))).toString(8), "700");
    assert.equal((await mode(path.join(t.home, "tasks", "1", "states"))).toString(8), "700");
    for (const n of await t.storeFiles()) assert.equal((await mode(path.join(t.home, "tasks", "1", "states", n))).toString(8), "600");
  });
});

describe("a state whose bytes came back is not reported deleted", () => {
  it("a middle state dropped and then written again (A to B to C to B) is stored and not in the removals", async () => {
    const t = await setup({ caps: { fileBytes: 100 }, extra: { "big.txt": "a".repeat(150) } });
    const big = path.join(t.folder, "big.txt");
    const [b, c] = ["b".repeat(160), "c".repeat(161)];
    for (const [i, text] of [b, c, b].entries()) await t.call(`toolu_${i}`, `python3 step${i}.py`, () => writeFile(big, text));
    const taskId = await t.stop();
    assert.ok((await t.storeFiles()).includes(sha(b)), "the bytes are back");
    const removals = t.read((l) => l.stateRemovalsForTask(taskId));
    assert.deepEqual(removals.map((r) => r.sha256), [sha(c)], "only the state that is really gone is reported");
  });
});
