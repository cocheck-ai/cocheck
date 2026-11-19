import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// every cell on a sheet the agent created mid-task must reach the review page. The workbooks are the
// snapshots of the live Claude Code run (S0..S3 of the casebook model): S1 adds "Scenario log" (24 cells), S3 adds
// "Sensitivity" (13 cells) and 20 more cells to "Scenario log", which already existed in S2.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);

const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(start: number) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-hook-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hook-folder-")));
  const file = path.join(folder, "casebook.xlsx");
  await copyFile(probe(start), file);
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder };
  const send = (name: string, over: Record<string, unknown> = {}) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, opts));
  const pre = (id: string) => send("claude-pre-bash.json", { tool_use_id: id, tool_input: { command: id, description: id } });
  const post = (id: string) => send("claude-post-bash.json", { tool_use_id: id, tool_input: { command: id, description: id } });
  /** One tool call whose command leaves the workbook as snapshot `n`. */
  const call = async (id: string, n: number) => {
    await pre(id);
    await copyFile(probe(n), file);
    await post(id);
  };
  const stop = async () => {
    const r = await send("claude-stop.json");
    assert.ok(r.summary, "Stop returned a round summary");
    return r.summary.taskId;
  };
  return { home, folder, file, pre, post, call, stop };
}

/**
 * The independent side: each cell of `after` that is non-blank and not identical (value and formula) at the
 * same address of `before`. Reads cells straight from the two files with the workbook reader; no diff engine,
 * no row alignment, so a shifted row would show here as several edits and a new sheet as all of its cells.
 */
async function changedCells(beforePath: string, afterPath: string): Promise<string[]> {
  const before = readWorkbookSnapshot(await readFile(beforePath));
  const after = readWorkbookSnapshot(await readFile(afterPath));
  const out: string[] = [];
  for (const sheet of after.sheets) {
    const old = before.sheets.find((s) => s.name === sheet.name)?.cells;
    for (const [addr, cell] of sheet.cells) {
      if (cell.value === null && cell.formula === undefined) continue;
      const prev = old?.get(addr);
      if (prev && JSON.stringify([prev.value, prev.formula]) === JSON.stringify([cell.value, cell.formula])) continue;
      out.push(`${sheet.name}!${addr}`);
    }
  }
  return out;
}

/** Rewrites the `nth` plain number of the named sheet to 987654, as a hand edit would; returns the cell. */
function editNumber(bytes: Uint8Array, sheet: string, nth = 0): { bytes: Uint8Array; place: string } {
  const zip = unzipSync(bytes);
  const book = strFromU8(zip["xl/workbook.xml"]!);
  const rid = new RegExp(`<sheet name="${sheet}"[^>]*r:id="([^"]+)"`).exec(book)![1]!;
  const rels = strFromU8(zip["xl/_rels/workbook.xml.rels"]!);
  const rel = [...rels.matchAll(/<Relationship [^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid}"`))!;
  const part = `xl/${/Target="([^"]+)"/.exec(rel)![1]!}`;
  const xml = strFromU8(zip[part]!);
  const plain = [...xml.matchAll(/<c r="([A-Z]+\d+)"(?: s="\d+")?><v>-?[\d.]+<\/v><\/c>/g)];
  const hit = plain[nth]!;
  const next = xml.replace(hit[0], hit[0].replace(/<v>[^<]*<\/v>/, "<v>987654</v>"));
  assert.notEqual(next, xml, "the edit changed the sheet");
  return { bytes: zipSync({ ...zip, [part]: strToU8(next) }), place: `${sheet}!${hit[1]}` };
}

// cell-level credit does not exist, so the hook's round does not list a new sheet's cells:
// the connector's change list does (the cell-by-cell coverage above belongs to the Excel connector's own tests now). What stays here is
// who made each change, read from the ledger's file states, with the same writers main credited, and the round's one whole-file row.
const fileCredits = (home: string, taskId: number): string[] => {
  const ledger = openLedger(home);
  try {
    const states = ledger.fileStatesForTask(taskId);
    const first = Math.min(...states.map((x) => x.stepId));
    return states.filter((x) => x.stepId !== first).map((x) => [...x.credited].sort().join("+"));
  } finally {
    ledger.close();
  }
};

describe("a sheet created mid-task is credited to the call that made it (file level since)", () => {
  it("a call that adds a sheet with values: its change is credited to that call", async () => {
    const t = await setup(0);
    await t.call("toolu_ADD", 1);
    const taskId = await t.stop();
    const expected = (await changedCells(probe(0), probe(1))).filter((c) => c.startsWith("Scenario log!"));
    assert.equal(expected.length, 24, "the fixture's new sheet has 24 cells");
    assert.deepEqual(fileCredits(t.home, taskId), ["toolu_ADD"]);
  });

  it("a later call writing more cells on that new sheet is credited with its own change", async () => {
    const t = await setup(0);
    await t.call("toolu_ADD", 1);
    await t.call("toolu_MORE", 3);
    const taskId = await t.stop();
    assert.deepEqual(fileCredits(t.home, taskId), ["toolu_ADD", "toolu_MORE"]);
  });

  it("rows added to a sheet that already existed keep working", async () => {
    const t = await setup(2);
    await t.call("toolu_ROWS", 3);
    const taskId = await t.stop();
    assert.deepEqual(fileCredits(t.home, taskId), ["toolu_ROWS"]);
  });

  it("a hand edit on a new sheet between calls stays unlogged", async () => {
    const t = await setup(0);
    await t.call("toolu_ADD", 1);
    const hand = editNumber(new Uint8Array(await readFile(probe(1))), "Scenario log");
    await writeFile(t.file, hand.bytes); // nobody's call: the user typed into the new sheet
    await t.pre("toolu_NEXT");
    const next = editNumber(hand.bytes, "Inputs", 5);
    await writeFile(t.file, next.bytes);
    await t.post("toolu_NEXT");
    const taskId = await t.stop();
    assert.deepEqual(fileCredits(t.home, taskId), ["toolu_ADD", "", "toolu_NEXT"]);
  });

  it("replaying S0 -> S1 and S2 -> S3 through the adapter records each change with its call", async () => {
    for (const [from, to] of [[0, 1], [2, 3]] as const) {
      const t = await setup(from);
      await t.call(`toolu_${from}${to}`, to);
      const taskId = await t.stop();
      assert.deepEqual(fileCredits(t.home, taskId), [`toolu_${from}${to}`], `S${from} -> S${to}`);
    }
  });
});
