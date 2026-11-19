import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildBigWorkbook, buildFormulaWorkbook } from "./big-workbook.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the Stop hook (the round cut) on a large change. Nothing on its path may be quadratic in rows x ops.
//  - speed: 60k changed cells, credited to a call and found as a hand edit; the budget is proportional to the 15 s budget that
//    gives 300k cells (3 s per 60k) plus a second of headroom.
//  - same answer: a few-cell scenario (an edit, a move, stale cells, a hand edit) whose rows and round results are compared with
//    test/fixtures/stop-hook-golden.json, written from the code before this item (UPDATE_GOLDEN=1 rewrites it).
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);
const GOLDEN = path.join(FIXTURES, "stop-hook-golden.json");
const CELLS = 60_000;
const STOP_BUDGET_MS = 4_000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(seed: (folder: string) => Promise<string>) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-q228r2-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-q228r2-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const book = await seed(folder);
  let clock = 1_000_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, perSession: false, now: () => clock };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    const t = Date.now();
    const r = await handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
    return { r, ms: Date.now() - t };
  };
  const input = { command: "python3 edit.py", description: "edit" };
  const pre = (id: string) => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: input });
  const post = (id: string) => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: input });
  const stop = () => send({ hook_event_name: "Stop" });
  const withLedger = <T>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  return { book, pre, post, stop, withLedger, folder, home };
}

const big = (bump: number) => buildBigWorkbook(CELLS, bump);

describe("the Stop hook on a large change", () => {
  it("a change credited to a call is cut into a round within the budget", { timeout: 600_000 }, async () => {
    const t = await setup(async (f) => {
      const b = path.join(f, "big.xlsx");
      await writeFile(b, big(0));
      return b;
    });
    await t.pre("warm");
    await t.post("warm");
    await t.pre("big");
    await writeFile(t.book, big(7));
    await t.post("big");
    const stop = await t.stop();
    assert.ok(stop.r.summary, "Stop cut a round");
    assert.ok(stop.ms < STOP_BUDGET_MS, `Stop took ${stop.ms} ms for ${CELLS} credited cells, budget ${STOP_BUDGET_MS}`);
    // the round writes no row; the change is a file state credited to the call.
    const changes = t.withLedger((l) => l.fileStatesForTask(stop.r.summary!.taskId)).filter((x) => x.filePath === t.book && x.prevSha256 !== null);
    assert.deepEqual(changes.map((x) => [...x.credited]), [["big"]], "the change is credited to the call");
  });

  it("a hand edit with no call open is cut into a round within the budget", { timeout: 600_000 }, async () => {
    const t = await setup(async (f) => {
      const b = path.join(f, "big.xlsx");
      await writeFile(b, big(0));
      return b;
    });
    await t.pre("warm");
    await t.post("warm");
    await writeFile(t.book, big(7));
    const stop = await t.stop();
    assert.ok(stop.r.summary, "Stop cut a round");
    assert.ok(stop.ms < STOP_BUDGET_MS, `Stop took ${stop.ms} ms for ${CELLS} hand-edited cells, budget ${STOP_BUDGET_MS}`);
    // the round writes no row; the change is a file state credited to no call.
    const changes = t.withLedger((l) => l.fileStatesForTask(stop.r.summary!.taskId)).filter((x) => x.filePath === t.book && x.prevSha256 !== null);
    assert.deepEqual(changes.map((x) => [...x.credited]), [[]], "no call made the change");
  });

  // Both scenarios go through the same capture; the golden holds {probe, formula}.
  async function capture(kind: "probe" | "formula") {
    const t = await setup(async (f) => {
      const b = path.join(f, "small.xlsx");
      if (kind === "probe") await copyFile(probe(0), b);
      else await writeFile(b, buildFormulaWorkbook({ a: 1, b: 2, c: 3, d: 4 }));
      return b;
    });
    const step = async (id: string, change: () => Promise<void>) => {
      await t.pre(id);
      await change();
      await t.post(id);
    };
    if (kind === "probe") {
      await step("a", () => copyFile(probe(1), t.book));
    } else {
      // A1 and C1 edited; B1 recalculated (moved), D1 left stale (its input changed, its cached value did not).
      await step("a", () => writeFile(t.book, buildFormulaWorkbook({ a: 5, b: 10, c: 9, d: 4 })));
    }
    const first = await t.stop();
    if (kind === "probe") {
      await step("b", () => copyFile(probe(2), t.book));
      await copyFile(probe(3), t.book); // a hand edit, found at the Stop
    } else {
      await step("b", () => writeFile(t.book, buildFormulaWorkbook({ a: 6, b: 12, c: 9, d: 4 })));
      await writeFile(t.book, buildFormulaWorkbook({ a: 7, b: 14, c: 9, d: 4 })); // a hand edit
    }
    const second = await t.stop();
    const taskId = first.r.summary!.taskId;
    const scrub = (v: unknown) => JSON.parse(JSON.stringify(v).split(t.folder).join("<folder>").split(t.home).join("<home>"));
    return t.withLedger((l) =>
      scrub({
        // the round writes no row; who made each change is the file states' credit.
        states: l.fileStatesForTask(taskId).map((x) => ({ file: path.basename(x.filePath), start: x.prevSha256 === null, credited: [...x.credited].sort() })),
        summaries: [first.r.summary, second.r.summary].map((x) => ({ ...x, taskId: undefined })),
      }),
    );
  }

  // the round results (checks, "what moved", staleness) are not computed; the rows and the Stop summaries stay pinned.
  it("a small scenario's file-state credit and Stop summaries are unchanged", { timeout: 120_000 }, async () => {
    const got = { probe: await capture("probe"), formula: await capture("formula") };
    // one whole-file row per round (the golden was re-taken: cell rows became those rows).
    assert.ok(got.probe.states.length >= 2 && got.formula.states.length >= 2, "the scenarios have file states");
    if (process.env.UPDATE_GOLDEN === "1") await writeFile(GOLDEN, JSON.stringify(got, null, 1) + "\n");
    assert.deepEqual(got, JSON.parse(await readFile(GOLDEN, "utf8")));
  });

  it("touchFinder answers exactly what filtering with touches answers, in op order", () => {
    const layer = createXlsxLayer({ openState: async () => "closed" });
    const file = "/tmp/finder/model.xlsx";
    const other = "/tmp/finder/other.xlsx";
    const cells = (sheet: string, list: string[]) => list.map((cell) => ({ sheet, cell, hash: "h" }));
    const hook = (opId: number, p: string, hookCells: unknown[]) => ({ opId, tool: "Bash", intent: "", client: null, args: { hookAdapter: 1, path: p, hookCells } });
    const setValue = (opId: number, sheet: string, cell: string) => hook(opId, file, cells(sheet, [cell]));
    const ops = [
      hook(1, file, cells("S", ["A1", "B2", "A1"])),
      setValue(2, "S", "B2"),
      hook(3, other, cells("S", ["A1"])),
      hook(4, file, cells("T", ["A1"])),
      hook(5, file, [...cells("S", ["C3"]), ...cells("T", ["A1"])]),
      setValue(6, "S", "A1"),
    ];
    const row = (kind: string, sheet: string, cell: string, wholeFile = false) => ({
      location: `${sheet}!${cell}`, kind, before: null, after: null, derivable: false, ...(wholeFile ? { wholeFile } : {}),
      detail: { sheet, cell, kind },
    });
    const rows = [row("value", "S", "A1"), row("value", "S", "B2"), row("value", "S", "C3"), row("value", "T", "A1"), row("value", "T", "Z9"), row("value", "U", "A1"), row("structure", "S", "row inserted"), row("too large", "S", ""), row("file changed", "S", "", true)];
    const find = layer.touchFinder!(ops, file);
    for (const r of rows) {
      assert.deepEqual(find(r).map((o) => o.opId), ops.filter((o) => layer.touches(o, file, r)).map((o) => o.opId), `${r.location} ${r.kind}`);
    }
    assert.deepEqual(find(rows[0]!).map((o) => o.opId), [1, 6]);
    assert.deepEqual(find(rows[3]!).map((o) => o.opId), [4, 5]);
  });
});
