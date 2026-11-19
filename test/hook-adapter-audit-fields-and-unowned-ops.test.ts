import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { workbookClaims } from "./helpers/claims.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { spawnSync } from "node:child_process";
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
  const stop = () => send("claude-stop.json");
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
const cellsOf = (o: { args: Record<string, unknown> }) => ((o.args.hookCells as Array<{ cell: string }> | undefined) ?? []).map((c) => c.cell);
const closedBy = (ops: Array<{ args: Record<string, unknown> }>, id: string) => ops.filter((o) => o.args.tool_use_id === id).map((o) => o.args.closedBy);

const pageOf = (home: string, taskId: number): string => {
  const ledger = openLedger(home);
  try {
    return renderReviewPage(reviewModel(ledger, taskId));
  } finally {
    ledger.close();
  }
};


function sbook(b1: string): Uint8Array {
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>${b1}</t></is></c></row></sheetData></worksheet>`;
  const enc = new TextEncoder();
  return zipSync({
    "xl/workbook.xml": enc.encode(WORKBOOK_XML),
    "xl/_rels/workbook.xml.rels": enc.encode(WORKBOOK_RELS),
    "xl/worksheets/sheet1.xml": enc.encode(sheet),
  }, { mtime: ZIP_MTIME });
}

const modelOf = (home: string, taskId: number) => {
  const ledger = openLedger(home);
  try {
    return reviewModel(ledger, taskId);
  } finally {
    ledger.close();
  }
};

describe("hook adapter: audit fields survive the 64 KB args cap (6)", () => {
  it("(6) a call whose outside-change strings are huge still shows its closedBy in the drill-down", async () => {
    const t = await setup();
    await writeFile(t.file, sbook("x"));
    await t.pre("toolu_SEED", "s");
    await t.post("toolu_SEED", "s");
    await writeFile(t.file, sbook("H".repeat(32700))); // hand edit
    await t.pre("toolu_BIG", "big");
    await writeFile(t.file, sbook("W".repeat(32700)));
    await t.post("toolu_BIG", "big");
    const s = usable(await t.stop());
    const big = t.opsOf(s.taskId).filter((o) => o.args.tool_use_id === "toolu_BIG");
    assert.ok(big.length > 0, "the call has an op that is readable (not replaced by a truncation stand-in)");
    assert.deepEqual(big.map((o) => o.args.closedBy), ["post"]);
    assert.ok(big.every((o) => o.argsJson.length < 64 * 1024), "outside-change strings are bounded");
    assert.match(pageOf(t.home, s.taskId), /toolu_BIG[^<]*closed by post/);
  });

  it("(6) an op already truncated by the cap is still listed, from its preview", async () => {
    const t = await setup();
    await t.pre("toolu_A", "a");
    await t.post("toolu_A", "a");
    const ledger = openLedger(t.home);
    const taskId = ledger.allTaskIds()[0]!;
    ledger.recordOp({
      taskId, tool: "Bash", intent: "huge",
      args: { hookAdapter: 1, tool_use_id: "toolu_HUGE", closedBy: "expiry", background: true, openedAt: 1_700_000_000_000, closedAt: 1_700_000_600_000, jointWith: ["toolu_HUGE"], junk: "j".repeat(70_000) },
      clientName: "claude", durationMs: 0, resultCode: "OK",
    });
    ledger.close();
    const s = usable(await t.stop());
    const op = t.opsOf(s.taskId).find((o) => o.argsJson.includes("toolu_HUGE"))!;
    assert.equal(op.args._truncated, true, "the op really was truncated");
    const model = modelOf(t.home, s.taskId);
    assert.ok(model.noCellCalls.flatMap((r) => r.calls).some((c) => c.id === "toolu_HUGE" && c.closedBy === "expiry" && c.background === true));
    assert.match(pageOf(t.home, s.taskId), /toolu_HUGE[^<]*closed by expiry/);
    const out = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "scripts", "hook-calls.ts"), t.home], { encoding: "utf8" });
    assert.match(out.stdout, /toolu_HUGE/);
  });
});

describe("hook adapter: ops that own no row are listed (7)", () => {
  it("(7) ghost-post, cell-less post and expiry with no cells record their closedBy and name no file", async () => {
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_N", "ls");
    await t.post("toolu_N", "ls"); // changes nothing
    await t.post("toolu_G", "g"); // no Pre
    await t.pre("toolu_E", "e");
    now += 11 * 60_000;
    await t.pre("toolu_K", "k"); // expires E
    await t.write({ A1: 2 });
    await t.post("toolu_K", "k");
    const s = usable(await t.stop());
    // the legacy page's "calls with no cells" list read review rows, which the round does not write. What stays is the record the page
    // read: each op's closedBy, and which call owns the file's change.
    const ops = t.opsOf(s.taskId);
    for (const [id, how] of [["toolu_N", "post"], ["toolu_G", "ghost-post"], ["toolu_E", "expiry"]]) {
      assert.deepEqual(closedBy(ops, id), [how], id);
    }
    assert.deepEqual(ops.filter((o) => o.args.tool_use_id === "toolu_K" && typeof o.args.path === "string").length > 0, true, "the call with the change names the file");
    assert.ok(!ops.some((o) => (o.args.tool_use_id === "toolu_N" || o.args.tool_use_id === "toolu_G" || o.args.tool_use_id === "toolu_E") && typeof o.args.path === "string"), "the others name no file");
  });
});

describe("hook adapter: background flag and open time (8)", () => {
  it("(8) every op records background and the open time; the ghost-post has no open time", async () => {
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_BG", "job &", {}, { run_in_background: true });
    now += 5_000;
    await t.post("toolu_BG", "job &", {}, { run_in_background: true });
    await t.pre("toolu_P", "p");
    now += 5_000;
    await t.post("toolu_P", "p");
    await t.post("toolu_G", "g");
    now += 5_000;
    const s = usable(await t.stop());
    const ops = t.opsOf(s.taskId);
    const of = (id: string) => ops.find((o) => o.args.tool_use_id === id)!.args;
    assert.equal(of("toolu_BG").background, true);
    assert.equal(of("toolu_BG").openedAt, 1_000_000);
    assert.equal(of("toolu_BG").closedAt, 1_015_000);
    assert.notEqual(of("toolu_P").background, true);
    assert.equal(of("toolu_P").openedAt, 1_005_000);
    assert.equal(of("toolu_P").closedAt, 1_010_000);
    assert.notEqual(of("toolu_G").background, true);
    assert.equal(of("toolu_G").openedAt, undefined);
  });

  it("(8) the drill-down and hook-calls.ts show background and the times", async () => {
    let now = Date.UTC(2026, 9, 7, 12, 0, 0);
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_BG", "job &", {}, { run_in_background: true });
    await t.post("toolu_BG", "job &", {}, { run_in_background: true });
    now += 60_000;
    await t.write({ A1: 2 });
    await t.pre("toolu_S", "s");
    await t.post("toolu_S", "s");
    const s = usable(await t.stop());
    assert.match(pageOf(t.home, s.taskId), /toolu_BG[^<]*closed by stop[^<]*background[^<]*2026-10-07 12:00:00/);
    const out = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "scripts", "hook-calls.ts"), t.home], { encoding: "utf8" });
    assert.match(out.stdout, /toolu_BG\tstop\tbackground\t.*2026-10-07T12:00:00.*2026-10-07T12:01:00/);
  });
});
