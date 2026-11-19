import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSealed } from "../src/seal.ts";
import { openLedger } from "../src/ledger.ts";
import { cutShortReason } from "../src/connector/claimed.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";

// a half-written state never becomes the base a later change is compared against, for any claimed file, and the
// change is credited to the same call as on main. The guard is structural, not only OOXML: a claimed file whose bytes moved while the
// hook read them (a writer still writing) is cut short whatever its format, so a non-zip type an installed connector claims (".foo")
// gets it too. Other direction: a valid state, zip or not, still or tiny, is never refused as half-written (that would lose a real step).

const probe = (name: string) => path.join(import.meta.dirname, "fixtures", "probe", name);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setBuiltinConnectorsForTest(undefined);
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-h6-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

/** A home with an installed connector `foo-reader` claiming ".foo" (the shape of a real manifest, as test/hook-claimed.test.ts). */
async function homeWithFoo(): Promise<string> {
  const home = await tmp("home");
  const dir = path.join(home, "connectors", "foo-reader");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "foo-reader", version: "0.0.1", entry: "state", matches: { extensions: [".foo"] }, run: ["node", "c.mjs"], credentials: [], platforms: ["darwin", "win32", "linux"] }));
  return home;
}

interface Tracked { copy: string; sha: string; unreadable?: { reason: string; base: { copy: string; sha: string } | null } }

async function rig() {
  setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
  const home = await homeWithFoo();
  const folder = await tmp("folder");
  let clock = Date.parse("2026-11-17T12:00:00Z");
  /** Runs once, right after the hook has read a file's bytes for a copy (the test plays a writer that is still writing). */
  let duringRead: ((file: string) => void) | undefined;
  const hook = {
    host: "claude" as const, home, folder, perSession: false, now: () => (clock += 1000),
    fault: (step: string) => {
      if (!step.startsWith("capture-read:")) return;
      const f = duringRead;
      duringRead = undefined;
      f?.(step.slice("capture-read:".length));
    },
  };
  const send = (over: Record<string, unknown>) => handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, hook);
  const pre = (id: string, command = `run ${id}`) => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command } });
  const post = (id: string, command = `run ${id}`) => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: { stdout: "", stderr: "", interrupted: false } });
  const stop = () => send({ hook_event_name: "Stop", stop_hook_active: false });
  const tracked = async (file: string): Promise<Tracked | undefined> => {
    const hooks = path.join(home, "hooks");
    for (const key of await readdir(hooks)) {
      const state = JSON.parse(await readFile(path.join(hooks, key, "state.json"), "utf8")) as { files: Record<string, Tracked> };
      if (state.files[file]) return state.files[file];
    }
    return undefined;
  };
  const credits = (name: string): string[] => {
    const l = openLedger(home);
    try {
      return l.allTaskIds().flatMap((id) => l.fileStatesForTask(id)).filter((s) => path.basename(s.filePath) === name && s.prevSha256 !== null).map((s) => [...s.credited].sort().join("+") || "nobody");
    } finally {
      l.close();
    }
  };
  return { home, folder, pre, post, stop, tracked, credits, whileReading: (f: (file: string) => void) => { duringRead = f; } };
}

describe("H6: a half-written claimed file is never a diff base, and its change goes to the call that made it", () => {
  it("xlsx: a truncated workbook planted mid-run is kept and credited to the open call; the last whole state stays the base", async () => {
    const t = await rig();
    const file = path.join(t.folder, "model.xlsx");
    await copyFile(probe("S0.xlsx"), file);
    const original = await readFile(file);
    await t.pre("toolu_A");
    await t.post("toolu_A");
    await t.pre("toolu_B");
    const partial = original.subarray(0, Math.floor(original.length / 2));
    await writeFile(file, partial);
    await t.post("toolu_B");
    const half = (await t.tracked(file))!;
    assert.ok(half.unreadable, "the truncated workbook is cut short");
    assert.ok(Buffer.compare(await readSealed(half.copy), partial) === 0, "its bytes are kept as a state of their own");
    assert.ok(Buffer.compare(await readSealed(half.unreadable.base!.copy), original) === 0, "the last whole bytes stay the base");
    await writeFile(file, original);
    await t.pre("toolu_C");
    await t.post("toolu_C");
    await t.stop();
    assert.equal((await t.tracked(file))!.unreadable, undefined, "whole again");
    // Main's answer for this sequence: both the cut-short state and its repair go to the call that left the file cut short.
    assert.deepEqual(t.credits("model.xlsx"), ["toolu_B", "toolu_B"]);
  });

  it(".foo (non-zip, an installed connector's type): bytes that move while the hook reads them are cut short and never the base", async () => {
    const t = await rig();
    const file = path.join(t.folder, "data.foo");
    await writeFile(file, "header v1\nrow 1\n");
    await t.pre("toolu_A");
    await t.post("toolu_A");
    await t.pre("toolu_B");
    await writeFile(file, "header v2\nrow 1\n");
    // The writer appends while the hook is reading: what the hook read is not the file's state.
    t.whileReading((f) => appendFileSync(f, "row 2\n"));
    await t.post("toolu_B");
    const mid = (await t.tracked(file))!;
    assert.ok(mid.unreadable, "a state read while it moved is cut short");
    assert.match(mid.unreadable.reason, /while it was being read/);
    assert.equal(await readSealed(mid.unreadable.base!.copy).then((b) => b.toString()), "header v1\nrow 1\n", "the last whole state stays the base");
    // The next sweep reads the finished file: whole, and the change is the writer's call's.
    await t.pre("toolu_C");
    const done = (await t.tracked(file))!;
    assert.equal(done.unreadable, undefined, "the finished file is whole");
    assert.equal(await readSealed(done.copy).then((b) => b.toString()), "header v2\nrow 1\nrow 2\n");
    await t.post("toolu_C");
    await t.stop();
    assert.deepEqual(t.credits("data.foo"), ["toolu_B", "toolu_B"]);
  });

  it("xlsx: a workbook that moves while the hook reads it is cut short too (the same structural guard, any format)", async () => {
    const t = await rig();
    const file = path.join(t.folder, "model.xlsx");
    await copyFile(probe("S0.xlsx"), file);
    await t.pre("toolu_A");
    await t.post("toolu_A");
    await t.pre("toolu_B");
    await copyFile(probe("S1.xlsx"), file);
    t.whileReading((f) => appendFileSync(f, Buffer.from([0])));
    await t.post("toolu_B");
    const mid = (await t.tracked(file))!;
    assert.ok(mid.unreadable, "a workbook read while it moved is cut short");
    assert.match(mid.unreadable.reason, /while it was being read/);
  });
});

describe("H6, other direction: a valid state is never refused as half-written", () => {
  it(".foo: a still file is whole and a 3-byte file is whole, each credited to its call", async () => {
    const t = await rig();
    const file = path.join(t.folder, "data.foo");
    await writeFile(file, "header v1\n");
    await t.pre("toolu_A");
    await writeFile(file, "header v2\nrow\n");
    await t.post("toolu_A");
    assert.equal((await t.tracked(file))!.unreadable, undefined, "a still file is never refused");
    await t.pre("toolu_B");
    await writeFile(file, "abc");
    await t.post("toolu_B");
    assert.equal((await t.tracked(file))!.unreadable, undefined, "a tiny non-zip file is a valid state");
    await t.stop();
    assert.deepEqual(t.credits("data.foo"), ["toolu_A", "toolu_B"]);
  });

  it("cutShortReason: whole zips and short non-zip bytes pass; a zip cut inside its 4-byte header, or before its directory, is cut short", async () => {
    const whole = await readFile(probe("S0.xlsx"));
    assert.equal(cutShortReason(whole), undefined);
    for (const b of [Buffer.from("a"), Buffer.from("ab"), Buffer.from("abc"), Buffer.from("P"), Buffer.from("PKx")]) assert.equal(cutShortReason(b), undefined, JSON.stringify(b.toString("latin1")));
    for (const b of [Buffer.from("PK"), Buffer.from([0x50, 0x4b, 0x03]), whole.subarray(0, 4), whole.subarray(0, whole.length - 10)]) assert.ok(cutShortReason(b), `cut short: ${b.length} bytes`);
  });
});
