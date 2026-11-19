import { afterEach, describe, it } from "node:test";
import { readSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { workbookClaims } from "./helpers/claims.ts";
import { handleHook, resolveAdapterHome, type HookOptions, type HookPayload, type HookResult } from "../src/hook-adapter.ts";

const ZIP_MTIME = new Date(2020, 0, 1);
const FIXTURES = path.join(import.meta.dirname, "fixtures", "hooks");

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/** A one-sheet workbook holding the given numbers, keyed by A1 address (single-letter columns). */
function book(cells: Record<string, number>): Uint8Array {
  const byRow = new Map<number, string[]>();
  for (const [addr, v] of Object.entries(cells)) {
    const row = Number(addr.slice(1));
    byRow.set(row, [...(byRow.get(row) ?? []), `<c r="${addr}"><v>${v}</v></c>`]);
  }
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r}">${cs.sort().join("")}</row>`);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
  const enc = new TextEncoder();
  return zipSync({
    "xl/workbook.xml": enc.encode(WORKBOOK_XML),
    "xl/_rels/workbook.xml.rels": enc.encode(WORKBOOK_RELS),
    "xl/worksheets/sheet1.xml": enc.encode(sheet),
  }, { mtime: ZIP_MTIME });
}

async function fixture(name: string, over: Record<string, unknown> = {}): Promise<HookPayload> {
  return { ...JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")), ...over } as HookPayload;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(initial: Record<string, number> = { A1: 1, A2: 2, A3: 3 }, extra: Partial<HookOptions> = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-hook-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hook-folder-")));
  const file = path.join(folder, "model.xlsx");
  await writeFile(file, book(initial));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, ...extra };
  const send = (name: string, over: Record<string, unknown> = {}): Promise<HookResult> =>
    fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, opts));
  const pre = (id: string, command: string, over: Record<string, unknown> = {}) =>
    send("claude-pre-bash.json", { tool_use_id: id, tool_input: { command, description: `desc ${id}` }, ...over });
  const post = (id: string, command: string, over: Record<string, unknown> = {}) =>
    send("claude-post-bash.json", { tool_use_id: id, tool_input: { command, description: `desc ${id}` }, ...over });
  const fail = (id: string, command: string, over: Record<string, unknown> = {}) =>
    send("claude-post-bash.json", { hook_event_name: "PostToolUseFailure", tool_use_id: id, tool_input: { command }, ...over });
  const stop = () => send("claude-stop.json");
  const write = (cells: Record<string, number>) => writeFile(file, book(cells));
  /** Op rows the ledger holds for the task, with args parsed. */
  const opsOf = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      return ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => ({ ...o, args: JSON.parse(o.argsJson) as Record<string, unknown> }));
    } finally {
      ledger.close();
    }
  };
  return { home, folder, file, opts, pre, post, fail, stop, write, opsOf, send };
}

const usable = (r: HookResult) => {
  assert.ok(r.summary, "Stop returned a round summary");
  return r.summary;
};


// cell-level credit does not exist. Who made each change is read from the ledger's file states
// (one per change, in order, "file:call+call", "file:" for nobody); the round does not diff, so no row is read. The expected writers are main's.
const credited = (t: { home: string }, taskId: number): string[] => {
  const l = openLedger(t.home);
  try {
    const states = l.fileStatesForTask(taskId);
    const first = Math.min(...states.map((x) => x.stepId));
    return states.filter((x) => x.stepId !== first).map((x) => `${path.basename(x.filePath)}:${[...x.credited].sort().join("+")}`);
  } finally {
    l.close();
  }
};

describe("hook adapter: credit by file state", () => {
  it("an unmatched Pre never claims a hand edit made after it expired", async () => {
    // while the unmatched call is still open it does share what a Pre sweep finds.
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_F", "false"); // denied or interrupted: no Post ever comes
    now += 11 * 60_000; // expired
    await t.write({ A1: 1, A2: 2, A3: 99 }); // hand
    await t.pre("toolu_G", "ls");
    await t.post("toolu_G", "ls");
    const s = usable(await t.stop());
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:"]);
  });

  it("a Post whose Pre was never seen credits nothing", async () => {
    const t = await setup();
    await t.pre("toolu_X", "x");
    await t.post("toolu_X", "x");
    await t.write({ A1: 1, A2: 2, A3: 99 }); // hand
    await t.post("toolu_B", "python"); // its Pre was dropped
    const s = usable(await t.stop());
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:"]);
  });

  it("a hand edit found at Stop with a call still open is unlogged", async () => {
    const t = await setup();
    await t.pre("toolu_A", "bg");
    await t.write({ A1: 5, A2: 2, A3: 3 });
    const s = usable(await t.stop());
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:"]);
  });

  it("PostToolUseFailure closes the call and credits what the call changed", async () => {
    const t = await setup();
    await t.pre("toolu_F", "boom");
    await t.write({ A1: 11, A2: 2, A3: 3 });
    await t.fail("toolu_F", "boom");
    await t.write({ A1: 11, A2: 2, A3: 99 }); // hand, after the failure
    await t.pre("toolu_G", "ls");
    await t.post("toolu_G", "ls");
    const s = usable(await t.stop());
    // The failed call's change and the hand edit after it: one whole-file row, unlogged because of the hand edit.
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:toolu_F", "model.xlsx:"]);
  });

  it("two sessions in one folder share state and never credit each other's write to one call", async () => {
    const t = await setup();
    await t.pre("toolu_A", "x", { session_id: "S1" });
    await t.pre("toolu_B", "y", { session_id: "S2" });
    await t.write({ A1: 5, A2: 2, A3: 3 }); // session 2's call writes
    await t.post("toolu_B", "y", { session_id: "S2" });
    await t.post("toolu_A", "x", { session_id: "S1" });
    const s = usable(await t.stop());
    const ops = t.opsOf(s.taskId).filter((o) => o.args.path === t.file);
    assert.ok(ops.length >= 1);
    for (const o of ops) assert.deepEqual(o.args.jointWith, ["toolu_A", "toolu_B"]);
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:toolu_A+toolu_B"]);
  });

  it("a kill between the sweep and the state save loses nothing and credits nothing twice", async () => {
    const faults = new Set<string>();
    const t = await setup(undefined, { fault: (step: string) => { if (faults.has(step)) throw new Error(`killed at ${step}`); } });
    await t.pre("toolu_A", "x");
    await t.write({ A1: 9, A2: 2, A3: 3 });
    faults.add("after-sweep");
    await assert.rejects(t.post("toolu_A", "x"), /killed at after-sweep/);
    faults.clear();
    await t.post("toolu_A", "x"); // the host retries or the next event arrives: no ENOENT wedge
    await t.pre("toolu_B", "y");
    await t.write({ A1: 9, A2: 2, A3: 8 });
    await t.post("toolu_B", "y");
    const s = usable(await t.stop());
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:toolu_A", "model.xlsx:toolu_B"]);
  });

  it("a kill after the state save, before the op is logged, is made good by the next event", async () => {
    const faults = new Set<string>();
    const t = await setup(undefined, { fault: (step: string) => { if (faults.has(step)) throw new Error(`killed at ${step}`); } });
    await t.pre("toolu_A", "x");
    await t.write({ A1: 9, A2: 2, A3: 3 });
    faults.add("after-save");
    await assert.rejects(t.post("toolu_A", "x"), /killed at after-save/);
    faults.clear();
    await t.pre("toolu_B", "y");
    await t.post("toolu_B", "y");
    const s = usable(await t.stop());
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:toolu_A"]);
    assert.ok(t.opsOf(s.taskId).some((o) => o.args.tool_use_id === "toolu_A" && o.args.path === t.file), "A's op names the file");
  });

  it("a workbook a call creates is credited to that call as new", async () => {
    const t = await setup();
    await t.pre("toolu_A", "mk");
    await writeFile(path.join(t.folder, "new.xlsx"), book({ A1: 1, B1: 2 }));
    await t.post("toolu_A", "mk");
    await t.pre("toolu_B", "edit");
    await writeFile(path.join(t.folder, "new.xlsx"), book({ A1: 1, B1: 3 }));
    await t.post("toolu_B", "edit");
    const s = usable(await t.stop());
    assert.deepEqual(credited(t, s.taskId), ["new.xlsx:toolu_A", "new.xlsx:toolu_B"]);
  });

  it("a deleted workbook and a renamed workbook each show as a row", async () => {
    const t = await setup();
    await writeFile(path.join(t.folder, "other.xlsx"), book({ A1: 4 }));
    await t.pre("toolu_A", "rm");
    await rm(path.join(t.folder, "other.xlsx"));
    await rename(t.file, path.join(t.folder, "renamed.xlsx"));
    await t.post("toolu_A", "rm");
    const s = usable(await t.stop());
    // the round writes no row; each of the three files has a file state (the deleted one, the renamed-away one and the new name).
    const l = openLedger(t.home);
    const files = new Set(l.fileStatesForTask(s.taskId).map((x) => path.basename(x.filePath)));
    l.close();
    assert.ok(files.has("other.xlsx"), "the deleted workbook has a state");
    assert.ok(files.has("model.xlsx"), "the renamed-away workbook has a state");
    assert.ok(files.has("renamed.xlsx"), "the new name has a state");
  });

  it("a half-written workbook is a state of its own: the last readable copy stays the diff base, and the next sweep reads it again", async () => {
    const t = await setup();
    const original = await readFile(t.file);
    const tracked = async () => {
      const hooks = path.join(t.home, "hooks");
      const key = (await readdir(hooks))[0]!;
      const state = JSON.parse(await readFile(path.join(hooks, key, "state.json"), "utf8")) as { files: Record<string, { copy: string; unreadable?: { base: { copy: string } } }> };
      return state.files[t.file]!;
    };
    await t.pre("toolu_A", "x");
    // a real cut-short save (the workbook's first bytes, no zip directory), which the generic check finds.
    const partial = original.subarray(0, Math.floor(original.length / 2));
    await writeFile(t.file, partial);
    await t.post("toolu_A", "x");
    const half = await tracked();
    assert.ok(Buffer.compare(await readSealed(half.copy), partial) === 0, "the unreadable bytes are kept as a state");
    assert.ok(Buffer.compare(await readSealed(half.unreadable!.base.copy), original) === 0, "the last good bytes are still the diff base");
    await t.write({ A1: 1, A2: 2, A3: 30 });
    await t.pre("toolu_B", "y");
    const whole = await tracked();
    assert.equal(whole.unreadable, undefined, "readable again");
    assert.ok(Buffer.compare(await readSealed(whole.copy), await readFile(t.file)) === 0, "the next sweep refreshed it");
    await t.post("toolu_B", "y");
    const s = usable(await t.stop());
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:toolu_A", "model.xlsx:toolu_A"]);
  });

  it("COCHECK_HOME refuses a symlink to ~/.cocheck and any path inside it", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hook-home-link-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const def = path.join(root, ".cocheck");
    await mkdir(path.join(def, "probe"), { recursive: true });
    await symlink(def, path.join(root, "link"));
    await symlink(path.join(def, "probe"), path.join(root, "link-inside"));
    for (const home of [def, path.join(def, "probe"), path.join(def, "new"), path.join(root, "link"), path.join(root, "link", "x"), path.join(root, "link-inside")]) {
      assert.throws(() => resolveAdapterHome({ COCHECK_HOME: home }, def), /refuses/, home);
    }
    assert.equal(resolveAdapterHome({ COCHECK_HOME: path.join(root, "elsewhere") }, def), path.join(root, "elsewhere"));
  });

  it("the cell maps to the second call when the second call overwrote the first", async () => {
    const t = await setup();
    await t.pre("toolu_1", "one");
    await t.write({ A1: 10, A2: 2, A3: 3 });
    await t.post("toolu_1", "one");
    await t.pre("toolu_2", "two");
    await t.write({ A1: 20, A2: 22, A3: 3 });
    await t.post("toolu_2", "two");
    const s = usable(await t.stop());
    const ids = new Map(t.opsOf(s.taskId).filter((o) => o.args.path === t.file).map((o) => [String(o.args.tool_use_id), o.id]));
    assert.deepEqual(credited(t, s.taskId), ["model.xlsx:toolu_1", "model.xlsx:toolu_2"]);
    assert.ok(ids.has("toolu_2"), "the second call's op names the file");
  });

  it("a call that changes nothing has zero cells in its own op, even beside a call that did", async () => {
    const t = await setup();
    await t.pre("toolu_1", "one");
    await t.write({ A1: 10, A2: 2, A3: 3 });
    await t.post("toolu_1", "one");
    await t.pre("toolu_N", "ls");
    await t.post("toolu_N", "ls");
    const s = usable(await t.stop());
    const n = t.opsOf(s.taskId).filter((o) => o.args.tool_use_id === "toolu_N");
    assert.ok(n.length >= 1);
    for (const o of n) assert.equal(o.args.path, undefined, "its op names no file");
  });

  it("a call open more than 10 minutes expires and no longer shares later changes", async () => {
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_F", "hung");
    now += 11 * 60_000;
    await t.pre("toolu_G", "y");
    await t.write({ A1: 7, A2: 2, A3: 3 });
    await t.post("toolu_G", "y");
    const s = usable(await t.stop());
    const g = t.opsOf(s.taskId).find((o) => o.args.tool_use_id === "toolu_G" && o.args.path === t.file)!;
    assert.deepEqual(g.args.jointWith, ["toolu_G"]);
  });
});
