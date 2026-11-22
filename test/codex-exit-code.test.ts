import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { workbookClaims } from "./helpers/claims.ts";

/**
 * a recorded Codex run: 8 calls ended with a nonzero exit code and were recorded OK. The rollout's CommandExecution item for the call
 * (id equals the hook's tool_use_id) carries `exit_code` / `status`; a nonzero code is a failed call. Items in test/fixtures/codex-exit-items.jsonl
 * are trimmed from recorded rollouts (session 01a17452 main: exit 128 and exit 0; helper 01a17458-92e9: exit 1 and exit 0), paths rewritten.
 * Must not happen: a call with exit 0, no exit code, or no item for its id is never failed; text alone never matches.
 */
const probe = path.join(import.meta.dirname, "fixtures", "probe");
const MAIN = "01a17452-a2b8-7ae1-9da5-108107e2af07";
const HELPER = "01a17458-92e9-7292-865b-2862bd73a925";
const FAIL128 = "exec-b93aa140-38eb-45ef-a256-45dfc8cacd48";
const OK_MAIN = "exec-e122e861-15e7-435d-9d4d-0850332d1d6a";
const FAIL1 = "exec-e8dac862-d391-4cf6-bdc3-aee487883241";
const OK_HELPER = "exec-44d6b051-2b52-4d7d-9623-ac447ea082bf";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const fixtureLines = async (): Promise<Array<{ fixture: string; payload: { item: Record<string, any> } }>> =>
  (await readFile(path.join(import.meta.dirname, "fixtures", "codex-exit-items.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
const rolloutLine = (d: unknown) => `${JSON.stringify(d)}\n`;

async function setup(edit: (items: Record<string, Record<string, any>>) => void = () => {}, only?: { main?: string[]; helper?: string[] }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  const day = path.join(root, "codex-sessions", "2026", "10", "25");
  await mkdir(folder, { recursive: true });
  await mkdir(day, { recursive: true });
  await copyFile(path.join(probe, "S0.xlsx"), path.join(folder, "model.xlsx"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const all = await fixtureLines();
  const items: Record<string, Record<string, any>> = Object.fromEntries(all.map((d) => [d.payload.item.id, d]));
  edit(items);
  const body = (ids: string[]) => ids.filter((id) => items[id] !== undefined).map((id) => rolloutLine(items[id])).join("");
  const header = (id: string, extra: Record<string, unknown>) => rolloutLine({ type: "session_meta", payload: { id, session_id: MAIN, ...extra } });
  const mainRollout = path.join(day, `rollout-2026-10-25T14-28-55-${MAIN}.jsonl`);
  await writeFile(mainRollout, header(MAIN, {}) + body(only?.main ?? [FAIL128, OK_MAIN]));
  await writeFile(path.join(day, `rollout-2026-10-25T14-35-24-${HELPER}.jsonl`), header(HELPER, { parent_thread_id: MAIN }) + body(only?.helper ?? [FAIL1, OK_HELPER]));
  let clock = Date.UTC(2026, 9, 25, 18, 0, 0);
  const opts = { perSession: false, host: "codex" as const, home, claimed: workbookClaims, folder, now: () => clock, sessionsDir: path.join(root, "codex-sessions") };
  const call = async (id: string, extra: Record<string, unknown> = {}, command = "true", write?: string) => {
    for (const hook_event_name of ["PreToolUse", "PostToolUse"]) {
      clock += 1000;
      if (hook_event_name === "PostToolUse" && write !== undefined) await copyFile(path.join(probe, write), path.join(folder, "model.xlsx"));
      await handleHook({ session_id: MAIN, cwd: folder, hook_event_name, tool_name: "Bash", tool_use_id: id, tool_input: { command }, ...(hook_event_name === "PostToolUse" ? { tool_response: "" } : {}), ...extra } as HookPayload, opts);
    }
  };
  const row = (id: string) => {
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    try {
      const rows = (db.prepare("SELECT id, result_code, error_text, args_json FROM ops WHERE tool != 'hook' ORDER BY id").all() as Array<Record<string, any>>).map((r) => ({ ...r, args: JSON.parse(r.args_json) }) as Record<string, any>);
      return rows.filter((r) => r.args.tool_use_id === id);
    } finally {
      db.close();
    }
  };
  const lateItem = (id: string) => appendFile(mainRollout, rolloutLine(items[id]));
  const failedOnPage = (id: string, withRollout = false) => {
    const ledger = openLedger(home);
    try {
      const rows = withRollout ? loadRows(ledger, 1, "test", { transcriptsRoot: path.join(root, "no-transcripts"), sessionsDir: path.join(root, "codex-sessions") }) : loadRows(ledger, 1, "test");
      const t = buildTimeline({ ...rows, build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false });
      const c = t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls)).find((x) => x.id === id);
      return c?.outcome;
    } finally {
      ledger.close();
    }
  };
  return { call, row, failedOnPage, lateItem };
}

describe("a Codex call with a nonzero exit code is failed", () => {
  it("exit 128 (main) and exit 1 (helper) are TOOL_FAILED naming the code; exit 0 stays OK", async () => {
    const t = await setup();
    await t.call(FAIL128);
    await t.call(FAIL1, { agent_id: HELPER });
    await t.call(OK_MAIN);
    await t.call(OK_HELPER, { agent_id: HELPER });
    const [a] = t.row(FAIL128);
    assert.notEqual(a!.result_code, "OK");
    assert.match(a!.error_text, /code 128/);
    assert.equal(a!.args.closedBy, "failure");
    assert.match(a!.args.error, /fatal: not a git repository/);
    const [b] = t.row(FAIL1);
    assert.notEqual(b!.result_code, "OK");
    assert.match(b!.error_text, /code 1\b/);
    for (const id of [OK_MAIN, OK_HELPER]) {
      const [r] = t.row(id);
      assert.equal(r!.result_code, "OK");
      assert.equal(r!.error_text, null);
      assert.equal(r!.args.closedBy, "post");
    }
  });
  it("the page marks the failed call and not the exit-0 one", async () => {
    const t = await setup();
    await t.call(FAIL128);
    await t.call(OK_MAIN);
    assert.ok(JSON.stringify(t.failedOnPage(FAIL128)).match(/fail/i), JSON.stringify(t.failedOnPage(FAIL128)));
    assert.ok(!JSON.stringify(t.failedOnPage(OK_MAIN)).match(/fail/i), JSON.stringify(t.failedOnPage(OK_MAIN)));
  });
  it("a status of failed with no exit code is failed, said plainly", async () => {
    const t = await setup((items) => delete items[FAIL128]!.payload.item.exit_code);
    await t.call(FAIL128);
    const [a] = t.row(FAIL128);
    assert.notEqual(a!.result_code, "OK");
    assert.match(a!.error_text, /no exit code/);
  });
  it("a failed call keeps the file changes it made credited, as an exit-0 call does", async () => {
    const failed = await setup();
    await failed.call(FAIL128, {}, "true", "S1.xlsx");
    const ok = await setup();
    await ok.call(OK_MAIN, {}, "true", "S1.xlsx");
    const f = failed.row(FAIL128).flatMap((r) => r.args.steps as number[]);
    const o = ok.row(OK_MAIN).flatMap((r) => r.args.steps as number[]);
    assert.ok(o.length > 0, "baseline: the exit-0 call credited the change");
    assert.deepEqual(f.length, o.length);
    assert.deepEqual(failed.row(FAIL128).map((r) => r.args.namedFiles), ok.row(OK_MAIN).map((r) => r.args.namedFiles));
  });
});

describe("must not: never failed without the rollout saying so for that call id", () => {
  it("exit 0 with a failed status, a missing exit code on a completed item, and a non-integer code are not failed", async () => {
    const t = await setup((items) => {
      items[OK_MAIN]!.payload.item.status = "failed"; // exit_code stays 0
      delete items[OK_HELPER]!.payload.item.exit_code; // status "completed", no code
      items[FAIL128]!.payload.item.exit_code = "128"; // not a number
      items[FAIL128]!.payload.item.status = "completed";
    });
    await t.call(OK_MAIN);
    await t.call(OK_HELPER, { agent_id: HELPER });
    await t.call(FAIL128);
    for (const id of [OK_MAIN, OK_HELPER, FAIL128]) {
      const [r] = t.row(id);
      assert.equal(r!.result_code, "OK", id);
      assert.equal(r!.args.closedBy, "post", id);
    }
  });
  it("no matching rollout item: a call whose id is not in the rollout is OK, whatever its command text", async () => {
    const t = await setup(() => {}, { main: [FAIL128] });
    const command = (await fixtureLines())[0]!.payload.item.command[2] as string;
    await t.call("exec-not-in-rollout", {}, command);
    await t.call(OK_MAIN); // item absent from the rollout too
    for (const id of ["exec-not-in-rollout", OK_MAIN]) assert.equal(t.row(id)[0]!.result_code, "OK", id);
  });
  it("no rollout file at all, and a helper call whose helper rollout is missing: OK", async () => {
    const t = await setup(() => {}, { helper: [] });
    await t.call(FAIL1, { agent_id: "01a17458-0000-7292-865b-2862bd73a925" });
    assert.equal(t.row(FAIL1)[0]!.result_code, "OK");
  });
  it("a failed item of the parent is not read for a helper call with the same id", async () => {
    const t = await setup(() => {}, { main: [FAIL128], helper: [] });
    await t.call(FAIL128, { agent_id: HELPER });
    assert.equal(t.row(FAIL128)[0]!.result_code, "OK");
  });
});

describe("the rollout item is written after the Post", () => {
  it("the record says OK, and the timeline marks the call failed once it reads the item", async () => {
    const t = await setup(() => {}, { main: [] });
    await t.call(FAIL128);
    assert.equal(t.row(FAIL128)[0]!.result_code, "OK");
    assert.ok(!JSON.stringify(t.failedOnPage(FAIL128, true)).match(/fail/i), "no item yet: not failed");
    await t.lateItem(FAIL128);
    assert.equal(t.failedOnPage(FAIL128, true), "failed");
    assert.notEqual(t.failedOnPage(FAIL128), "failed", "the stored record is not rewritten");
  });
  it("must not: a late exit-0 item, or an item of another call id, leaves the call not failed", async () => {
    const t = await setup(() => {}, { main: [] });
    await t.call(OK_MAIN);
    await t.call("exec-other");
    await t.lateItem(OK_MAIN);
    await t.lateItem(FAIL128);
    assert.notEqual(t.failedOnPage(OK_MAIN, true), "failed");
    assert.notEqual(t.failedOnPage("exec-other", true), "failed");
  });
  it("a late failure keeps the file changes the call made credited", async () => {
    const t = await setup(() => {}, { main: [] });
    await t.call(FAIL128, {}, "true", "S1.xlsx");
    const before = t.row(FAIL128).flatMap((r) => r.args.steps as number[]);
    assert.ok(before.length > 0);
    await t.lateItem(FAIL128);
    assert.equal(t.failedOnPage(FAIL128, true), "failed");
    assert.deepEqual(t.row(FAIL128).flatMap((r) => r.args.steps as number[]), before);
  });
});
