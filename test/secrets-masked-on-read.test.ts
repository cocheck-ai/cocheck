import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { loadRows, commandOfCall } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { trackedClaims } from "./helpers/claims.ts";

// Secret mask on read: rows written before masking at the ledger hold raw values in args_json (description, narration, error, tool_input).
// Every reader goes through loadRows, so the timeline body, the rail model (file-step panel included) and Show command all get masked text.
// The probe row: a GitHub token in the description and in the command.
const GHP = "ghp_" + "R8kQ2xLm9vT4pW7nZ3yB6hC1jD5fG0sA2eU8";
const RAW = "ghp_R8kQ";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c(); // the last opened closes first: Windows will not delete a database that is still open
});

async function setup(): Promise<{ l: Ledger; folder: string }> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-r2sec-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const folder = path.join(home, "work");
  await mkdir(folder);
  await writeFile(path.join(folder, "readme.md"), "start\n");
  const opts = { host: "claude" as const, home, claimed: trackedClaims, folder, now: () => 1_000 };
  for (const [e, extra] of [["PreToolUse", {}], ["PostToolUse", {}], ["Stop", { last_assistant_message: "ok" }]] as const)
    await handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: e, tool_name: "Bash", tool_use_id: "a", tool_input: { command: "true" }, ...extra } as HookPayload, opts);
  const l = openLedger(home);
  cleanups.push(async () => l.close());
  l.execForTest("PRAGMA foreign_keys = OFF");
  return { l, folder };
}
const sq = (s: string): string => s.replace(/'/g, "''");
function oldRow(l: Ledger, args: Record<string, unknown>, intent: string): void {
  l.execForTest(`INSERT INTO ops (task_id, ts, tool, args_json, intent, duration_ms, result_code) VALUES (1, '2026-11-01T00:00:00Z', 'Bash', '${sq(JSON.stringify(args))}', '${sq(intent)}', 1, 'OK')`);
}
const callArgs = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({ hookAdapter: 1, tool_use_id: id, closedBy: "post", openedAt: 1100, closedAt: 1200, startSeq: 5, host: "claude", session_id: "s1", tool_name: "Bash", ...extra });
const timelineOf = (l: Ledger, folder: string, loaded: ReturnType<typeof loadRows>) =>
  buildTimeline({ taskId: 1, build: "b", folder, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, ops: loaded.ops, fileStates: loaded.fileStates } as never);

describe("old rows are masked at the one read every consumer goes through", () => {
  it("the reviewer's probe: token in description, command and tool_input", async () => {
    const { l, folder } = await setup();
    const description = `export token ${GHP} for the push`;
    const command = `git push https://${GHP}@github.com/x/y`;
    oldRow(l, callArgs("old1", { description, tool_input: { command, description } }), `${command} - ${description}`);
    const loaded = loadRows(l, 1, "b");
    assert.ok(!JSON.stringify(loaded.ops).includes(RAW), "ops read as masked");
    const t = timelineOf(l, folder, loaded);
    assert.ok(!JSON.stringify(t).includes(RAW), "timeline body");
    assert.ok(!JSON.stringify(buildRailModel(t)).includes(RAW), "rail model");
    const cmd = commandOfCall(loaded, "old1");
    assert.ok(!JSON.stringify(cmd).includes(RAW), "Show command");
    // The suffix cut still works after masking: the command alone, without the description.
    assert.equal(cmd?.command, "git push https://[secret withheld]@github.com/x/y");
  });
  it("narration and error text of an old row are masked", async () => {
    const { l, folder } = await setup();
    oldRow(l, callArgs("old2", { closedBy: "failure", error: `fatal: bad token ${GHP}\nsecond line`, narration: { source: "agent", text: `pushing with ${GHP}` }, tool_input: { command: "git push" } }), "git push");
    const loaded = loadRows(l, 1, "b");
    const t = timelineOf(l, folder, loaded);
    assert.ok(!JSON.stringify(t).includes(RAW));
    assert.ok(!JSON.stringify(buildRailModel(t)).includes(RAW));
  });
});

describe("secrets never survive the read path", () => {
  it("a row with no secret is read byte for byte, and a typed prompt stays as typed", async () => {
    const { l } = await setup();
    const plain = callArgs("old3", { description: "list files", tool_input: { command: "ls -la" } });
    oldRow(l, plain, "ls -la - list files");
    const prompt = { hookAdapter: 1, hookEvent: "UserPromptSubmit", session_id: "s1", prompts: [`use ${GHP} for this`] };
    oldRow(l, prompt, "prompt");
    const ops = loadRows(l, 1, "b").ops;
    assert.equal(ops.find((o) => o.args_json === JSON.stringify(plain))?.args_json, JSON.stringify(plain));
    assert.ok(ops.some((o) => o.args_json === JSON.stringify(prompt)), "prompt row unchanged");
  });
  it("an oversize call stores only a masked head, and no raw token reaches the row", async () => {
    const { l } = await setup();
    const big = `${"x".repeat(3000)} ${GHP}\n`.repeat(2) + "y".repeat(200_000) + GHP;
    const head = `token ${GHP} then`;
    const id = l.recordOp({ taskId: 1, tool: "Write", args: { hookAdapter: 1, tool_use_id: "big", description: head, tool_input: { content: big } }, intent: "write", durationMs: 1, resultCode: "OK" });
    const rows = l.okOpsForTask(1, id - 1, id);
    const stored = rows[0]!.argsJson;
    assert.ok(stored.includes('"_truncated":true'));
    assert.ok(!stored.includes(RAW));
    assert.ok(stored.includes("[secret withheld]"), "the head's token is masked in the preview");
  });
});
