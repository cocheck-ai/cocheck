import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { cutShortReason } from "../src/connector/claimed.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";

// an unreadable copy is a real state. Its bytes are kept, it is recorded as "could not read at this point", and its
// file-level change is credited to the calls open at that sweep. At the next readable sweep the change goes to the call
// that made it when the hash is the unreadable state's own, and jointly (labelled) when the hash moved. Never a hand edit by
// default; a change with no call open is "not from an agent call", never a person.
// the hook reads no workbook. "Unreadable" is now the generic cut-short check (connector/claimed.ts), so the
// half-written bytes are a real cut-short workbook (the first half of the file, as a writer leaves it); there is no cell-level credit,
// so a call's credit is read from the file states and from its op naming the file. The expected writers are unchanged.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (name: string) => path.join(FIXTURES, "probe", name);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Makes the check report the bytes with this sha as cut short `left` times, as a check that fails on bytes that are whole. */
const flaky = { sha: undefined as string | undefined, used: false, left: 1 };
function flakyCheck(bytes: Uint8Array): string | undefined {
  if (flaky.left > 0 && flaky.sha !== undefined && sha(bytes) === flaky.sha) {
    flaky.used = true;
    flaky.left--;
    return "transient read failure";
  }
  return cutShortReason(bytes);
}

async function setup() {
  flaky.sha = undefined;
  flaky.used = false;
  flaky.left = 1;
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const file = path.join(folder, "casebook.xlsx");
  await copyFile(probe("S0.xlsx"), file);
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const hostOpts = { perSession: false, host: "claude" as const, home, claimed: (f: string) => f.endsWith(".xlsx"), cutShort: flakyCheck, folder };
  const send = (name: string, over: Record<string, unknown> = {}) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, hostOpts));
  const input = (id: string, command: string) => ({ tool_input: { command, description: id }, tool_use_id: id });
  const pre = (id: string, command = `run ${id}`) => send("claude-pre-bash.json", input(id, command));
  const post = (id: string, command = `run ${id}`) => send("claude-post-bash.json", input(id, command));
  const call = async (id: string, act: () => Promise<void>) => {
    await pre(id);
    await act();
    await post(id);
  };
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
  const events = () => read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === file);
  const ops = () => read((l) => l.okOpsForTask(1, 0, l.maxOpId()).map((o) => ({ id: o.id, args: JSON.parse(o.argsJson) as Record<string, any> })));
  /** The call's ops credited with a readable change of the workbook (what carried the cells): naming the file, at the step of a state not cut short. */
  const cellOps = (id: string) => {
    const readable = new Set(events().filter((e) => e.prevSha256 !== null && !/could not read at this point \(/.test(e.note)).map((e) => e.stepId));
    return ops().filter((o) => o.args.tool_use_id === id && o.args.path === file && Array.isArray(o.args.steps) && o.args.steps.some((st: number) => readable.has(st)));
  };
  const storeFiles = async (): Promise<string[]> => (await readdir(path.join(home, "tasks", "1", "states")).catch(() => [] as string[])).filter((n) => !n.startsWith(".")).sort();
  const state = async () => {
    const dir = path.join(home, "hooks", (await readdir(path.join(home, "hooks")))[0]!);
    return JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
  };
  return { home, folder, file, pre, post, call, stop, read, events, ops, cellOps, storeFiles, state };
}

/** The workbook with its first plain number cell set to `value`. */
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

/** The first half of the probe workbook: what a writer that has not finished leaves on disk (no zip directory yet). */
const PARTIAL = (await readFile(probe("S0.xlsx"))).subarray(0, 2000);

describe("an unreadable copy is a real state", () => {
  it("a half-written save is stored, recorded as could-not-read, and credited to the call open at that sweep", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    await t.call("toolu_A", () => writeFile(t.file, PARTIAL));
    assert.ok((await t.storeFiles()).includes(sha(PARTIAL)), "the unreadable bytes are kept");
    const mine = t.events();
    assert.deepEqual(mine.map((s) => [s.sha256, s.phase, s.credited]), [[sha(s0), "Pre", []], [sha(PARTIAL), "Post", ["toolu_A"]]]);
    assert.deepEqual(mine[1]!.callsOpen, ["toolu_A"]);
    assert.match(mine[1]!.note, /could not read at this point/);
    const a = t.ops().find((o) => o.args.tool_use_id === "toolu_A" && o.args.path === t.file);
    assert.ok(a, "the call's op names the file");
    assert.match(String(a.args.fileNote), /could not read at this point/);
  });

  it("a file that stays unreadable is never unchanged or empty: one event, the call's op says so, Stop makes no hand edit", async () => {
    const t = await setup();
    await t.call("toolu_A", () => writeFile(t.file, PARTIAL));
    await t.call("toolu_B", async () => {});
    await t.call("toolu_C", async () => {});
    await t.stop();
    const mine = t.events();
    assert.equal(mine.length, 2, "baseline, then the unreadable state once; unchanged unreadable bytes add nothing");
    assert.match(mine[1]!.note, /could not read/);
    assert.equal((await t.state()).handEdits, undefined, "no hand-edit tracking");
    for (const id of ["toolu_B", "toolu_C"]) assert.equal(t.ops().find((o) => o.args.tool_use_id === id && o.args.path === t.file), undefined, `${id} did not touch it`);
  });
});

describe("the next readable sweep", () => {
  it("a save finished after the call closed: the change goes to the call that was open, jointly and labelled, not to a hand edit", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    const v1 = setFirstNumber(s0, 111);
    await t.call("toolu_A", () => writeFile(t.file, PARTIAL));
    await writeFile(t.file, v1); // finished later, no call open
    await t.call("toolu_B", async () => {});
    const taskId = await t.stop();
    const mine = t.events();
    assert.deepEqual(mine.map((s) => s.sha256), [sha(s0), sha(PARTIAL), sha(v1)]);
    assert.deepEqual(mine[2]!.callsOpen, []);
    assert.deepEqual(mine[2]!.credited, ["toolu_A"], "the call that made the unreadable state");
    assert.match(mine[2]!.note, /changed while unreadable, during call toolu_A and after/);
    const cells = t.cellOps("toolu_A");
    assert.equal(cells.length, 1, "call A's record names the file");
    assert.match(String(cells[0]!.args.fileNote), /changed while unreadable, during call toolu_A and after/);
    assert.equal(t.cellOps("toolu_B").length, 0, "B was not open when it moved");
    assert.equal((await t.state()).handEdits, undefined, "never a hand edit by default (no hand-edit tracking)");
    assert.ok(taskId > 0);
  });

  it("a file corrupted and repaired between sweeps leaves a visible trace", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    await t.call("toolu_A", () => writeFile(t.file, PARTIAL));
    await writeFile(t.file, s0); // repaired to the very bytes it had
    await t.call("toolu_B", async () => {});
    const mine = t.events();
    assert.deepEqual(mine.map((s) => s.sha256), [sha(s0), sha(PARTIAL), sha(s0)], "the unreadable state is on the record");
    assert.match(mine[1]!.note, /could not read at this point/);
    assert.deepEqual(mine[1]!.credited, ["toolu_A"]);
    assert.match(mine[2]!.note, /changed while unreadable, during call toolu_A and after/);
  });

  it("an unrelated call open at the next sweep shares the change with the call that made the unreadable state; neither is lost", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    const v1 = setFirstNumber(s0, 111);
    await t.call("toolu_A", () => writeFile(t.file, PARTIAL));
    await t.pre("toolu_C"); // unrelated call, still running
    await writeFile(t.file, v1);
    await t.pre("toolu_D"); // sweeps with C open
    await t.post("toolu_D");
    await t.post("toolu_C");
    const readable = t.events().find((s) => s.sha256 === sha(v1))!;
    assert.deepEqual(readable.callsOpen, ["toolu_C"]);
    assert.deepEqual([...readable.credited].sort(), ["toolu_A", "toolu_C"]);
    assert.match(readable.note, /changed while unreadable, during call toolu_A and after/);
    assert.equal(t.cellOps("toolu_A").length, 1, "A is credited with the change");
    assert.equal(t.cellOps("toolu_C").length, 1, "C was open, so it shares it");
    assert.deepEqual([...t.cellOps("toolu_A")[0]!.args.jointWith].sort(), ["toolu_A", "toolu_C"]);
  });

  it("the unreadable state's own hash read back later: the change goes to the call that made it, not to the unrelated call open", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    const v1 = setFirstNumber(s0, 111);
    flaky.sha = sha(v1); // the reader fails twice on these bytes, which are whole: at the Post of A and at the Pre of C
    flaky.left = 2;
    await t.call("toolu_A", () => writeFile(t.file, v1));
    assert.ok(flaky.used, "the reader failed once");
    assert.equal(t.events().length, 2, "the failed read is a state event");
    assert.match(t.events()[1]!.note, /could not read at this point/);
    await t.pre("toolu_C"); // unrelated call, running
    await t.pre("toolu_D"); // same bytes, now readable, with C open
    await t.post("toolu_D");
    await t.post("toolu_C");
    const readable = t.events().find((s, i) => i > 1 && s.sha256 === sha(v1))!;
    assert.ok(readable, "the readable event is recorded");
    assert.deepEqual(readable.credited, ["toolu_A"], "the call that made it, and only it");
    assert.deepEqual(readable.callsOpen, ["toolu_C"]);
    assert.doesNotMatch(readable.note, /changed while unreadable/, "the hash did not move");
    assert.equal(t.cellOps("toolu_A").length, 1);
    assert.equal(t.cellOps("toolu_C").length, 0, "C did not make it");
  });
});

describe("a change with no call open is not from an agent call", () => {
  it("an unreadable state found with no call open, and a plain edit, are both worded that way; no event says a person", async () => {
    const t = await setup();
    const s0 = new Uint8Array(await readFile(t.file));
    await t.call("toolu_A", async () => {});
    await writeFile(t.file, PARTIAL);
    await t.call("toolu_B", async () => {}); // no call open at the Pre sweep
    await writeFile(t.file, setFirstNumber(s0, 7));
    await t.call("toolu_C", async () => {});
    await t.stop();
    const mine = t.events();
    assert.deepEqual(mine.map((s) => s.credited), [[], [], []]);
    assert.match(mine[1]!.note, /could not read at this point/);
    for (const s of mine.slice(1)) assert.match(s.note, /not from an agent call/);
    for (const s of mine) assert.doesNotMatch(s.note, /person|hand edit|by hand/i);
    for (const o of t.ops()) assert.doesNotMatch(JSON.stringify(o.args), /person|by hand/i);
  });
});
