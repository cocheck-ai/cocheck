import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// every cell on a sheet the agent or the user DELETED must reach the review page. The workbooks are the
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


/** Renames sheet `from` to `to` in the workbook part only. */
function renameSheet(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const zip = unzipSync(bytes);
  const book = strFromU8(zip["xl/workbook.xml"]!);
  const next = book.replace(`<sheet name="${from}"`, `<sheet name="${to}"`);
  assert.notEqual(next, book, "the rename changed the workbook part");
  return zipSync({ ...zip, ["xl/workbook.xml"]: strToU8(next) });
}

/** Drops the named sheet from the workbook part, as deleting it in Excel would; the other sheets are untouched. */
function removeSheet(bytes: Uint8Array, sheet: string): Uint8Array {
  const zip = unzipSync(bytes);
  const book = strFromU8(zip["xl/workbook.xml"]!);
  const next = book.replace(new RegExp(`<sheet name="${sheet}"[^>]*/>`), "");
  assert.notEqual(next, book, "the sheet was dropped");
  return zipSync({ ...zip, ["xl/workbook.xml"]: strToU8(next) });
}

/** Empties the named sheet's cells, keeping the sheet. */
function emptySheet(bytes: Uint8Array, sheet: string): Uint8Array {
  const zip = unzipSync(bytes);
  const book = strFromU8(zip["xl/workbook.xml"]!);
  const rid = new RegExp(`<sheet name="${sheet}"[^>]*r:id="([^"]+)"`).exec(book)![1]!;
  const rels = strFromU8(zip["xl/_rels/workbook.xml.rels"]!);
  const rel = [...rels.matchAll(/<Relationship [^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid}"`))!;
  const part = `xl/${/Target="([^"]+)"/.exec(rel)![1]!}`;
  const xml = strFromU8(zip[part]!);
  const next = xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, "<sheetData/>");
  assert.notEqual(next, xml, "the sheet was emptied");
  return zipSync({ ...zip, [part]: strToU8(next) });
}

const layer = createXlsxLayer({ openState: async () => "closed" });
async function layerRows(before: Uint8Array, after: Uint8Array, lay = layer) {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "a.xlsx"), before);
  await writeFile(path.join(dir, "b.xlsx"), after);
  return lay.diff(path.join(dir, "a.xlsx"), path.join(dir, "b.xlsx"));
}
const bytesOf = async (n: number) => new Uint8Array(await readFile(probe(n)));
const SCENARIO = "Scenario log!";

describe("cells of a sheet removed mid-task reach the review page", () => {
  it("diffWorkbooks: a sheet only before gives one row per non-empty cell, after empty, no structure rows", async () => {
    const s1 = readWorkbookSnapshot(await readFile(probe(1)));
    const s0 = readWorkbookSnapshot(await readFile(probe(0)));
    const rows = diffWorkbooks(s1, s0).filter((r) => r.sheet === "Scenario log");
    assert.equal(rows.length, 24);
    assert.ok(rows.every((r) => r.kind !== "structure"));
  });

  it("layer: removing a sheet alone is its cells, never 'no cell did'", async () => {
    const rows = await layerRows(await bytesOf(1), removeSheet(await bytesOf(1), "Scenario log"));
    assert.equal(rows.length, 24);
    assert.ok(rows.every((r) => r.location.startsWith(SCENARIO)));
    assert.ok(rows.every((r) => r.kind !== "file changed"));
  });

  it("layer: removing a sheet plus editing another shows both", async () => {
    const edited = editNumber(removeSheet(await bytesOf(1), "Scenario log"), "Inputs", 3);
    const rows = await layerRows(await bytesOf(1), edited.bytes);
    assert.equal(rows.filter((r) => r.location.startsWith(SCENARIO)).length, 24);
    assert.equal(rows.filter((r) => r.location === edited.place).length, 1);
  });

  it("layer: a rename shows the removal and the addition", async () => {
    const rows = await layerRows(await bytesOf(1), renameSheet(await bytesOf(1), "Scenario log", "Renamed log"));
    assert.equal(rows.filter((r) => r.location.startsWith(SCENARIO)).length, 24);
    assert.equal(rows.filter((r) => r.location.startsWith("Renamed log!")).length, 24);
  });

  it("layer: removing or adding an EMPTY sheet never says 'no cell did'", async () => {
    const withEmpty = emptySheet(await bytesOf(1), "Scenario log");
    const without = removeSheet(withEmpty, "Scenario log");
    for (const [a, b] of [[withEmpty, without], [without, withEmpty]] as const) {
      const rows = await layerRows(a, b);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind, "file changed");
      const text = layer.describe(rows[0]!);
      assert.doesNotMatch(text, /no cell did/);
      assert.match(text, /sheet/);
    }
  });

  it("layer: a removed huge sheet degrades to one 'too large' row like an added one", async () => {
    const s0 = readWorkbookSnapshot(await readFile(probe(0)));
    let small = 0;
    for (const s of s0.sheets) small += s.cells.size;
    const tight = createXlsxLayer({ openState: async () => "closed" }, { maxCells: small + 5, maxUnzippedBytes: 64 * 1048576 });
    const removed = await layerRows(await bytesOf(1), await bytesOf(0), tight);
    const added = await layerRows(await bytesOf(0), await bytesOf(1), tight);
    assert.deepEqual(removed.map((r) => r.kind), ["too large"]);
    assert.deepEqual(added.map((r) => r.kind), ["too large"]);
  });

  // cell-level credit does not exist; the hook's round does not list a removed sheet's cells
  // (the layer tests above keep the reader's behaviour while the module lives). Who made each change is read from the file states, with the
  // writers main credited, and the round has one whole-file row.
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

  it("a call that deletes a sheet: its change is credited to it", async () => {
    const t = await setup(1);
    await t.call("toolu_DEL", 0);
    const taskId = await t.stop();
    assert.deepEqual(fileCredits(t.home, taskId), ["toolu_DEL"]);
  });

  it("a hand deletion between calls stays unlogged, and the next call's own edit is credited to it", async () => {
    const t = await setup(1);
    await t.pre("toolu_A");
    await t.post("toolu_A");
    const handMade = removeSheet(await bytesOf(1), "Scenario log");
    const next = editNumber(handMade, "Inputs", 5);
    await writeFile(t.file, handMade); // the user deleted the sheet by hand
    await t.pre("toolu_NEXT");
    await writeFile(t.file, next.bytes);
    await t.post("toolu_NEXT");
    const taskId = await t.stop();
    assert.deepEqual(fileCredits(t.home, taskId), ["", "toolu_NEXT"]);
  });
});
