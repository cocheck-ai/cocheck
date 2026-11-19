import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { workbookClaims } from "./helpers/claims.ts";
import { handleHook, type HookOptions, type HookPayload, type HookResult } from "../src/hook-adapter.ts";

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

async function setup(initial: Record<string, number> = { A1: 1 }, extra: Partial<HookOptions> = {}) {
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
  const pre = (id: string, command: string, over: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
    send("claude-pre-bash.json", { tool_use_id: id, tool_input: { command, description: `desc ${id}`, ...input }, ...over });
  const post = (id: string, command: string, over: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
    send("claude-post-bash.json", { tool_use_id: id, tool_input: { command, description: `desc ${id}`, ...input }, ...over });
  const stop = (over: Record<string, unknown> = {}) => send("claude-stop.json", over);
  const write = (cells: Record<string, number>) => writeFile(file, book(cells));
  const opsOf = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      return ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => ({ ...o, args: JSON.parse(o.argsJson) as Record<string, unknown> }));
    } finally {
      ledger.close();
    }
  };
  return { home, folder, file, opts, pre, post, stop, write, opsOf, send };
}

const usable = (r: HookResult) => {
  assert.ok(r.summary, "Stop returned a round summary");
  return r.summary;
};
// cell-level credit does not exist. An op credited with a change names the file; who made each
// change is read from the ledger's file states (a change credited to nobody has an empty credit); the round does not diff, so no
// row is read. The expected writers are main's.
const namesFile = (o: { args: Record<string, unknown> }) => typeof o.args.path === "string";
const credited = (home: string, taskId: number): string[] => {
  const l = openLedger(home);
  try {
    const states = l.fileStatesForTask(taskId);
    const first = Math.min(...states.map((x) => x.stepId));
    return states.filter((x) => x.stepId !== first).map((x) => [...x.credited].sort().join("+"));
  } finally {
    l.close();
  }
};

describe("hook adapter", () => {
  it("(2) 10 sequential and 5 parallel calls leave zero unlogged rows", async () => {
    const t = await setup();
    const cells: Record<string, number> = { A1: 1 };
    for (let i = 1; i <= 10; i++) {
      await t.pre(`seqA${i}`, "a");
      await t.pre(`seqB${i}`, "b");
      cells[`B${i}`] = i;
      await t.write({ ...cells });
      await t.post(`seqA${i}`, "a");
      cells[`C${i}`] = i;
      await t.write({ ...cells });
      await t.post(`seqB${i}`, "b");
    }
    // five honest parallel calls: each starts, writes, and the others' Pre sweeps run while it is still open
    for (let i = 1; i <= 5; i++) {
      await t.pre(`par${i}`, "p");
      cells[`D${i}`] = i;
      await t.write({ ...cells });
    }
    for (let i = 1; i <= 5; i++) await t.post(`par${i}`, "p");
    const s = usable(await t.stop());
    assert.ok(credited(t.home, s.taskId).every((c) => c !== ""), "every change is credited to a call");
  });

  it("(2) a change found at a Pre while a call is open goes to that call; with no call open it stays unlogged", async () => {
    const t = await setup();
    await t.pre("toolu_A", "a");
    await t.write({ A1: 2 });
    await t.pre("toolu_B", "b"); // sweeps A's write while A is open
    await t.post("toolu_A", "a");
    await t.post("toolu_B", "b");
    await t.write({ A1: 2, A2: 9 }); // hand edit, no call open
    await t.pre("toolu_C", "c");
    await t.post("toolu_C", "c");
    const s = usable(await t.stop());
    // A's change, then the hand edit, which no call is credited with.
    assert.deepEqual(credited(t.home, s.taskId), ["toolu_A", ""]);
    const a = t.opsOf(s.taskId).find((o) => o.args.tool_use_id === "toolu_A" && namesFile(o));
    assert.ok(a, "A's op names the file");
  });

  it("(1) a cd into a subfolder mid-task keeps one baseline and loses nothing", async () => {
    const t = await setup();
    const sub = path.join(t.folder, "sub");
    await mkdir(sub);
    await t.pre("toolu_A", "a");
    await t.write({ A1: 2 });
    await t.post("toolu_A", "a");
    await t.pre("toolu_B", "cd sub && b", { cwd: sub });
    await t.write({ A1: 2, A2: 5 });
    await t.post("toolu_B", "cd sub && b", { cwd: sub });
    const s = usable(await t.stop());
    assert.deepEqual(credited(t.home, s.taskId), ["toolu_A", "toolu_B"]);
    assert.equal((await readdir(path.join(t.home, "hooks"))).length, 1, "one state directory");
  });

  // the unrelated open call is `sleep 1`, no longer `ls`: a read-only `ls` takes no write credit, so it would leave the background job alone in the credit
  it("(3) a background command writing after its Post is joint with an unrelated open call", async () => {
    const t = await setup();
    await t.pre("toolu_BG", "long job &", {}, { run_in_background: true });
    await t.post("toolu_BG", "long job &", {}, { run_in_background: true });
    await t.pre("toolu_U", "sleep 1");
    await t.write({ A1: 2 }); // the background job writes
    await t.post("toolu_U", "sleep 1");
    const s = usable(await t.stop());
    assert.ok(credited(t.home, s.taskId).every((c) => c !== ""), "the background job's change is credited, not left to nobody");
    const ops = t.opsOf(s.taskId).filter(namesFile);
    assert.deepEqual(ops.map((o) => String(o.args.tool_use_id)).sort(), ["toolu_BG", "toolu_U"]);
    for (const o of ops) assert.deepEqual(o.args.jointWith, ["toolu_BG", "toolu_U"]);
  });

  it("(4) a Post for a call that already expired replaces its outcome once; a repeat logs nothing more", async () => {
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_F", "slow");
    now += 11 * 60_000;
    await t.post("toolu_F", "slow");
    await t.post("toolu_F", "slow");
    const s = usable(await t.stop());
    assert.deepEqual(t.opsOf(s.taskId).filter((o) => o.args.tool_use_id === "toolu_F").map((o) => o.args.closedBy), ["expiry", "post"]);
  });

  it("(5) a flushed outbox is removed from the state even when there was no garbage", async () => {
    const t = await setup();
    await t.pre("toolu_A", "ls");
    await t.post("toolu_A", "ls"); // changes nothing: an op, no sweep garbage
    const hooks = path.join(t.home, "hooks");
    const state = JSON.parse(await readFile(path.join(hooks, (await readdir(hooks))[0]!, "state.json"), "utf8")) as { outbox: unknown[] };
    assert.deepEqual(state.outbox, []);
  });

  it("(5) dedupe survives args truncation: an op with oversized args is logged once", async () => {
    const t = await setup();
    const huge = "s".repeat(70_000); // pushes the op's args past the ledger cap, which cuts the stored JSON
    await t.pre("toolu_A", "a", { session_id: huge });
    await t.pre("toolu_B", "b", { session_id: huge });
    await t.write({ A1: 2 });
    await t.post("toolu_A", "a", { session_id: huge });
    await t.post("toolu_B", "b", { session_id: huge }); // its op comes from pending: no sweep, no garbage
    await t.pre("toolu_C", "c", { session_id: huge });
    await t.post("toolu_C", "c", { session_id: huge });
    const s = usable(await t.stop({ session_id: huge }));
    const ops = t.opsOf(s.taskId);
    for (const id of ["A", "B", "C"]) assert.equal(ops.filter((o) => o.intent.includes(`desc toolu_${id}`)).length, 1, `op for ${id}`);
  });
});
