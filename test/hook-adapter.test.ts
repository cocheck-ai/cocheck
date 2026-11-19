import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { workbookClaims } from "./helpers/claims.ts";
import { handleHook, namedFileMissRate, type HookPayload, type HookResult } from "../src/hook-adapter.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";

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

async function setup(initial: Record<string, number> = { A1: 1, A2: 2, A3: 3 }) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-hook-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hook-folder-")));
  const file = path.join(folder, "model.xlsx");
  await writeFile(file, book(initial));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder };
  const send = (name: string, over: Record<string, unknown> = {}): Promise<HookResult> =>
    fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, opts));
  const pre = (id: string, command: string, over: Record<string, unknown> = {}) =>
    send("claude-pre-bash.json", { tool_use_id: id, tool_input: { command, description: `desc ${id}` }, ...over });
  const post = (id: string, command: string, over: Record<string, unknown> = {}) =>
    send("claude-post-bash.json", { tool_use_id: id, tool_input: { command, description: `desc ${id}` }, ...over });
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
  /** who each change of the workbook is credited to (the ledger's file states, in order), as there is no cell-level credit. */
  const credits = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      return ledger.fileStatesForTask(taskId).filter((s) => s.prevSha256 !== null).map((s) => [...s.credited].sort());
    } finally {
      ledger.close();
    }
  };
  return { home, folder, file, opts, pre, post, stop, write, opsOf, send, credits };
}

const usable = (r: HookResult) => {
  assert.ok(r.summary, "Stop returned a round summary");
  return r.summary;
};

describe("hook adapter", () => {
  // cell-level credit does not exist. The writers these tests expect are unchanged; they are read from the file's
  // credited states instead of from cell rows.
  it("(a) a script call that names no file attributes its change to the right tool_use_id", async () => {
    const t = await setup();
    await t.pre("toolu_A", "python3 bump_prices.py");
    await t.write({ A1: 1, A2: 20, A3: 30 });
    await t.post("toolu_A", "python3 bump_prices.py");
    const summary = usable(await t.stop());
    assert.deepEqual(t.credits(summary.taskId), [["toolu_A"]]);
    const ops = t.opsOf(summary.taskId);
    const opA = ops.find((o) => o.args.tool_use_id === "toolu_A");
    assert.ok(opA, "an op carries the tool_use_id");
    assert.equal(opA.args.tool_name, "Bash");
    assert.match(opA.intent, /python3 bump_prices\.py/);
    assert.match(opA.intent, /desc toolu_A/);
    assert.equal(opA.args.path, t.file, "the op names the file it is credited with");
    const ledger = openLedger(t.home);
    assert.equal(namedFileMissRate(ledger, summary.taskId).missed, 1, "the call named no workbook, so it counts as a miss");
    ledger.close();
  });

  it("(b) a hand edit between two calls is unlogged, never attributed to a call", async () => {
    const t = await setup();
    await t.pre("toolu_1", "echo one");
    await t.write({ A1: 10, A2: 2, A3: 3 });
    await t.post("toolu_1", "echo one");
    await t.write({ A1: 10, A2: 2, A3: 99 }); // a person, by hand, between the calls
    await t.pre("toolu_2", "echo two");
    await t.write({ A1: 10, A2: 22, A3: 99 });
    await t.post("toolu_2", "echo two");
    const summary = usable(await t.stop());
    // toolu_1's change, the hand edit (nobody), toolu_2's change
    assert.deepEqual(t.credits(summary.taskId), [["toolu_1"], [], ["toolu_2"]]);
  });

  it("(b2) a hand edit a later call overwrites still shows as an unlogged change, credited to nobody", async () => {
    const t = await setup();
    await t.pre("toolu_1", "echo one");
    await t.post("toolu_1", "echo one");
    await t.write({ A1: 1, A2: 2, A3: 99 }); // by hand
    await t.pre("toolu_2", "echo two");
    await t.write({ A1: 1, A2: 2, A3: 100 });
    await t.post("toolu_2", "echo two");
    const summary = usable(await t.stop());
    assert.deepEqual(t.credits(summary.taskId), [[], ["toolu_2"]]);
  });

  it("(c) a call that changes nothing logs no rows", async () => {
    const t = await setup();
    await t.pre("toolu_N", "ls");
    await t.post("toolu_N", "ls");
    const summary = usable(await t.stop());
    assert.equal(summary.rows.length, 0);
    assert.equal(summary.totals.rows, 0);
  });

  it("(d) overlapping calls attribute their changes to all open calls jointly", async () => {
    const t = await setup();
    await t.pre("toolu_A", "slow one");
    await t.pre("toolu_B", "slow two");
    await t.write({ A1: 11, A2: 2, A3: 3 });
    await t.post("toolu_A", "slow one");
    await t.write({ A1: 11, A2: 22, A3: 3 });
    await t.post("toolu_B", "slow two");
    const summary = usable(await t.stop());
    const ops = t.opsOf(summary.taskId).filter((o) => o.args.path === t.file);
    assert.ok(ops.length >= 2);
    for (const o of ops) assert.deepEqual([...(o.args.jointWith as string[])].sort(), ["toolu_A", "toolu_B"]);
    // As main's file states credit it: the first change with both open, the second at B's Post with only B open (A's op still names B jointly).
    assert.deepEqual(t.credits(summary.taskId), [["toolu_A", "toolu_B"], ["toolu_B"]]);
  });

  it("a call that does not overlap is never joint", async () => {
    const t = await setup();
    await t.pre("toolu_A", "one");
    await t.write({ A1: 5, A2: 2, A3: 3 });
    await t.post("toolu_A", "one");
    await t.pre("toolu_B", "two");
    await t.post("toolu_B", "two");
    const summary = usable(await t.stop());
    const a = t.opsOf(summary.taskId).find((o) => o.args.tool_use_id === "toolu_A")!;
    assert.deepEqual(a.args.jointWith, ["toolu_A"]);
  });

  it("counts a call that names the workbook as a hit", async () => {
    const t = await setup();
    await t.pre("toolu_A", "python3 fix.py model.xlsx");
    await t.write({ A1: 5, A2: 2, A3: 3 });
    await t.post("toolu_A", "python3 fix.py model.xlsx");
    const summary = usable(await t.stop());
    const ledger = openLedger(t.home);
    assert.deepEqual(namedFileMissRate(ledger, summary.taskId), { changing: 1, missed: 0 });
    ledger.close();
  });

  it("Stop closes one round per turn and the page shows the net change", async () => {
    const t = await setup();
    await t.pre("toolu_1", "x");
    await t.write({ A1: 7, A2: 2, A3: 3 });
    await t.post("toolu_1", "x");
    const first = usable(await t.stop());
    await t.pre("toolu_2", "y");
    await t.write({ A1: 8, A2: 2, A3: 3 });
    await t.post("toolu_2", "y");
    const second = usable(await t.stop());
    assert.deepEqual([first.round, second.round], [1, 2]);
    const ledger = openLedger(t.home);
    const model = reviewModel(ledger, first.taskId);
    ledger.close();
    assert.ok(model);
  });

  it("works from Codex payloads (no description, string tool_response)", async () => {
    const t = await setup();
    const opts = { ...t.opts, host: "codex" as const };
    await handleHook(await fixture("codex-pre-bash.json", { cwd: t.folder }), opts);
    await t.write({ A1: 1, A2: 2, A3: 33 });
    await handleHook(await fixture("codex-post-bash.json", { cwd: t.folder }), opts);
    const r = await handleHook(await fixture("codex-stop.json", { cwd: t.folder }), opts);
    const summary = usable(r);
    assert.deepEqual(t.credits(summary.taskId), [["call_01PRE"]]);
    const op = t.opsOf(summary.taskId).find((o) => o.args.tool_use_id === "call_01PRE")!;
    assert.equal(op.args.host, "codex");
    assert.equal(op.intent, "python3 bump_prices.py");
  });

  it("the CLI refuses the default ~/.cocheck when COCHECK_HOME is unset", async () => {
    const env = { ...process.env };
    delete env.COCHECK_HOME;
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "src", "hook.ts"), "--host", "claude"], {
      input: await readFile(path.join(FIXTURES, "claude-pre-bash.json"), "utf8"),
      env,
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0);
    assert.notEqual(run.status, 2, "exit 2 would block the host's tool call");
    assert.match(run.stderr, /COCHECK_HOME/);
  });
});
