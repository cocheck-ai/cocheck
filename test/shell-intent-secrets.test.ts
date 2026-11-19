import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handleEvent, handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { openLedger } from "../src/ledger.ts";
import { readRows } from "../src/timeline/load.ts";
import { redactSecrets, firstSecretRule } from "../src/secret-scan.ts";
import { trackedClaims } from "./helpers/claims.ts";

// A live Copilot run: a bash call that wrote a .env and a config.txt held its whole command, tokens included, in
// the op's `intent` column, while args_json was clean. Every text a tool call stores now passes the ledger's secret mask, for every host and
// every shell tool name. Guards against the opposite miss: a command with no secret is stored byte for byte.
const GHP = "ghp_" + "R8kQ2xLm9vT4pW7nZ3yB6hC1jD5fG0sA2eU8";
const SK = "sk-test-" + "Q7xR2mK9vL4pW8nT3zY6bH1c";
const CMD = `mkdir -p t21 && printf '%s\\n' 'API_KEY=${SK}' 'DB_PASS=hunter22' > t21/.env && printf '%s\\n' '${GHP}' > t21/config.txt && echo "AKIAIOSFODNN7EXAMPLE"`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (n: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-shsec-${n}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

async function run(host: "claude" | "codex" | "copilot", tool: string, command: string, extra: Record<string, unknown> = {}) {
  const home = await tmp("home");
  const folder = await tmp("folder");
  await mkdir(path.join(folder, "t21"), { recursive: true });
  await writeFile(path.join(folder, "readme.md"), "start\n");
  let clock = Date.parse("2026-11-02T14:00:00Z");
  const opts = { host, home, claimed: trackedClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    if (host === "copilot") {
      const ev = String(over.hook_event_name);
      const m = { Stop: "agentStop", PreToolUse: "preToolUse", PostToolUse: "postToolUse" }[ev] ?? ev;
      const body: Record<string, unknown> = { sessionId: "s1", cwd: folder, timestamp: clock };
      if (over.tool_name !== undefined) Object.assign(body, { toolName: over.tool_name, toolArgs: over.tool_input, toolCallId: over.tool_use_id });
      if (m === "postToolUse") body.toolResult = { resultType: "success", textResultForLlm: "" };
      return handleEvent(normalize("copilot", body, m), opts);
    }
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const call = (event: string, id: string, name: string, input: unknown, more: Record<string, unknown> = {}) => send({ hook_event_name: event, tool_name: name, tool_use_id: id, tool_input: input, ...more });
  await call("PreToolUse", "warm", tool, { command: "true" });
  await call("PostToolUse", "warm", tool, { command: "true" });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  await call("PreToolUse", "C1", tool, { command, description: extra.description ?? "" });
  await writeFile(path.join(folder, "t21", "out.txt"), "x\n");
  await call("PostToolUse", "C1", tool, { command, description: extra.description ?? "" });
  await send({ hook_event_name: "Stop", last_assistant_message: "done" });
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT tool, intent, args_json, error_text FROM ops").all() as Array<Record<string, string | null>>).map((o) => ({ tool: String(o.tool), intent: String(o.intent), args: String(o.args_json), err: o.error_text ?? "" }));
  } finally {
    db.close();
  }
}

describe("shell command secrets are masked in every stored column", () => {
  it("the fixture values are what the detector flags", () => {
    assert.ok(firstSecretRule(GHP) !== undefined);
    assert.ok(redactSecrets(CMD).includes("AKIAIOSFODNN7EXAMPLE"), "the documented example key stays");
    assert.ok(!redactSecrets(CMD).includes(GHP));
  });

  for (const [host, tool] of [["claude", "Bash"], ["claude", "bash"], ["codex", "shell"], ["copilot", "bash"], ["copilot", "BASH"]] as const) {
    it(`${host} ${tool}: no token in intent, args or error text; the rest of the command stays`, async () => {
      const ops = await run(host, tool, CMD, { description: `write the env, token ${GHP}` });
      const hit = ops.find((o) => o.intent.includes("mkdir"));
      assert.ok(hit, JSON.stringify(ops.map((o) => o.intent)));
      for (const t of [hit.intent, hit.args, hit.err]) assert.ok(!t.includes(GHP) && !t.includes("ghp_R8kQ") && !t.includes(SK), "no raw token");
      assert.match(hit.intent, /mkdir -p t21 && printf/);
      assert.match(hit.intent, /> t21\/config\.txt && echo "AKIAIOSFODNN7EXAMPLE"/);
    });
  }

  it("every column of a recorded op (args, intent, error text) is masked, whatever wrote it", async () => {
    const home = await tmp("ehome");
    const l = openLedger(home);
    l.recordOp({ tool: "bash", args: { note: `x ${GHP}`, nested: [{ s: `y API_KEY=${SK}` }] }, intent: `echo ${GHP}`, durationMs: 1, resultCode: "TOOL_FAILED", errorText: `boom ${GHP}` });
    l.close();
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT args_json, intent, error_text FROM ops ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
    db.close();
    assert.ok(!JSON.stringify(row).includes("ghp_R8kQ") && !JSON.stringify(row).includes(SK), JSON.stringify(row));
    assert.match(String(row.intent), /^echo \[secret withheld\]$/);
  });

  it("an old row that holds a raw token is masked when the timeline reads it (rows are never rewritten)", async () => {
    const home = await tmp("oldhome");
    const folder = path.join(await tmp("obase"), "work");
    await mkdir(folder);
    await writeFile(path.join(folder, "readme.md"), "start\n");
    const opts = { host: "claude" as const, home, claimed: trackedClaims, folder, now: () => 1_000 };
    for (const [e, extra] of [["PreToolUse", {}], ["PostToolUse", {}], ["Stop", { last_assistant_message: "ok" }]] as const) {
      await handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: e, tool_name: "Bash", tool_use_id: "a", tool_input: { command: "true" }, ...extra } as HookPayload, opts);
    }
    const l = openLedger(home);
    l.execForTest("PRAGMA foreign_keys = OFF");
    l.execForTest(`INSERT INTO ops (task_id, ts, tool, args_json, intent, duration_ms, result_code) VALUES (1, '2026-11-01T00:00:00Z', 'bash', '{}', 'echo ${GHP} > t21/config.txt', 1, 'OK')`);
    const read = readRows(l, 1);
    l.close();
    const old = read.ops.find((o) => (o.intent ?? "").startsWith("echo "));
    assert.ok(old, JSON.stringify(read.ops));
    assert.match(old.intent ?? "", /^echo \[secret withheld\] > t21\/config\.txt$/);
  });

  it("commands with no secret are stored unchanged (paths, hashes, long hex)", () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    for (const c of [
      "ls -la /Users/someone/work/report.xlsx && cat ~/notes/plan.md",
      `sha256sum data.csv # ${sha}`,
      "git log --oneline -n 5 && python3 build_workbook.py --out out/final-2026.xlsx",
      `echo "AKIAIOSFODNN7EXAMPLE"`,
    ]) assert.equal(redactSecrets(c), c, c);
  });

  it("a normal command lands in the ledger byte for byte", async () => {
    const cmd = "ls -la t21 && echo 'hello world' > t21/out.txt # e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const ops = await run("copilot", "bash", cmd);
    const hit = ops.find((o) => o.intent.startsWith("ls -la"));
    assert.ok(hit, JSON.stringify(ops.map((o) => o.intent)));
    assert.ok(hit.intent.startsWith(cmd));
  });

  it("the person's own prompt is stored as typed (out of scope)", async () => {
    const home = await tmp("phome");
    const folder = path.join(await tmp("pbase"), "work");
    await mkdir(folder);
    await writeFile(path.join(folder, "readme.md"), "start\n");
    const opts = { host: "claude" as const, home, claimed: trackedClaims, folder, now: () => 1_000 };
    await handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "UserPromptSubmit", prompt: `use ${GHP}` } as HookPayload, opts);
    await handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "a", tool_input: { command: "true" } } as HookPayload, opts);
    await handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "a", tool_input: { command: "true" } } as HookPayload, opts);
    await handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "Stop", last_assistant_message: "ok" } as HookPayload, opts);
    const l = openLedger(home);
    try {
      assert.ok(l.okOpsForTask(1, 0, l.maxOpId()).some((o) => o.argsJson.includes(GHP)));
    } finally {
      l.close();
    }
  });
});
