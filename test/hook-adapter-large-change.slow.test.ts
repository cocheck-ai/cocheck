import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildBigWorkbook } from "./big-workbook.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a workbook change of hundreds of thousands of cells must not crash the hook (no spread of a per-cell array), is credited
// to the call that made it, and leaves bounded state (past a cap per file, handEdits keeps one record per file, not one per cell).
const BIG = 300_000;
const TIME_BUDGET_MS = 60_000;
const STATE_BUDGET_BYTES = 5 * 1024 * 1024;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(cells: number) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const book = path.join(folder, "big.xlsx");
  await writeFile(book, buildBigWorkbook(cells, 0));
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    // CPU time, not wall time: this Mac's maintenance sleeps (up to 15 min) count against both Date.now() and performance.now(),
    // and the budget is for a runaway step, which spends CPU. One test file per process, so the process total is the call's.
    const cpu = () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    const t = cpu();
    const r = await handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
    return { r, ms: Math.round(cpu() - t) };
  };
  const input = { command: "python3 rewrite.py", description: "rewrite" };
  const pre = (id: string) => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: input });
  const post = (id: string) => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: input });
  const stateFiles = async () => {
    const { glob } = await import("node:fs/promises");
    const out: string[] = [];
    for await (const f of glob(path.join(home, "hooks", "**", "state.json"))) out.push(f);
    return out;
  };
  const withLedger = <T>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  return { book, pre, post, send, stateFiles, withLedger, folder, home };
}

describe("a large workbook change never crashes or hangs the hook", () => {
  it("a 300k-cell change by one call is credited to that call, with bounded state and time", { timeout: 600_000 }, async () => {
    const t = await setup(BIG);
    await t.pre("warm");
    await t.post("warm");
    await t.pre("big");
    await writeFile(t.book, buildBigWorkbook(BIG, 7));
    const post = await t.post("big");
    assert.ok(post.ms < TIME_BUDGET_MS, `Post took ${post.ms} ms, budget ${TIME_BUDGET_MS}`);
    const ops = t.withLedger((l) => l.okOpsForTask(1, 0, l.maxOpId()));
    // the call's op names the file; the change is credited to it on the file state.
    const mine = ops.filter((o) => o.argsJson.includes('"tool_use_id":"big"') && o.argsJson.includes(`"path":${JSON.stringify(t.book)}`));
    assert.ok(mine.length > 0, "the call that made the change has an op naming the file");
    const states = t.withLedger((l) => l.fileStatesForTask(1)).filter((x) => x.filePath === t.book && x.prevSha256 !== null);
    assert.deepEqual(states.map((x) => [...x.credited]), [["big"]], "the change is credited to the call");
    for (const f of await t.stateFiles()) {
      const size = (await stat(f)).size;
      assert.ok(size < STATE_BUDGET_BYTES, `state.json is ${size} bytes, budget ${STATE_BUDGET_BYTES}`);
    }
    // Next hook call after it is not slowed by the change.
    const next = await t.pre("after");
    assert.ok(next.ms < TIME_BUDGET_MS, `the next Pre took ${next.ms} ms`);
  });

  it("the same change found with no call open (a hand edit) keeps one record for the file, not one per cell", { timeout: 600_000 }, async () => {
    const t = await setup(BIG);
    await t.pre("warm");
    await t.post("warm");
    await writeFile(t.book, buildBigWorkbook(BIG, 7));
    // Found at a Pre with no call open (not at Stop: the round cut at Stop is review.ts and the layer's cost, outside this item).
    const found = await t.pre("next");
    assert.ok(found.ms < TIME_BUDGET_MS, `the Pre that found it took ${found.ms} ms`);
    for (const f of await t.stateFiles()) {
      const size = (await stat(f)).size;
      assert.ok(size < STATE_BUDGET_BYTES, `state.json is ${size} bytes, budget ${STATE_BUDGET_BYTES}`);
      // There is no hand-edit tracking, so the state holds no handEdits at all.
      const s = JSON.parse(await readFile(f, "utf8")) as { handEdits?: unknown };
      assert.equal(s.handEdits, undefined);
    }
  });

  // there is no hand-edit recording; a change no call made is a state credited to nobody.
  it("a small change found with no call open records no hand edits and is credited to nobody", async () => {
    const t = await setup(50);
    await t.pre("warm");
    await t.post("warm");
    await writeFile(t.book, buildBigWorkbook(50, 7));
    await t.pre("next");
    const [f] = await t.stateFiles();
    const s = JSON.parse(await readFile(f!, "utf8")) as { handEdits?: unknown };
    assert.equal(s.handEdits, undefined, "no hand-edit tracking");
    const states = t.withLedger((l) => l.fileStatesForTask(1)).filter((x) => x.filePath === t.book && x.prevSha256 !== null);
    assert.deepEqual(states.map((x) => [...x.credited]), [[]]);
  });
});
