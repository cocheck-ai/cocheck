import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { readRecord } from "../src/timeline/runs.ts";
import { lineOf } from "../src/timeline/describe.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a connector (mcp__*) call stores no input value except path and url fields. Not the label, and not the intent,
// args.description or the timeline line either: `command` and `description` are not copied from a connector call.
const probe = path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const SENTINELS = ["SENT-COMMAND-1", "SENT-DESC-2", "SENT-QUERY-3", "SENT-NAME-4", "SENT-BODY-5", "SENT-TITLE-6", "SENT-PATTERN-7"];
const input = {
  command: SENTINELS[0],
  description: SENTINELS[1],
  query: SENTINELS[2],
  name: SENTINELS[3],
  body: SENTINELS[4],
  title: SENTINELS[5],
  pattern: SENTINELS[6],
};

async function run(host: "claude" | "codex", tool: string, tool_input: unknown) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  await copyFile(probe, path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { perSession: false, host, home, claimed: workbookClaims, folder, outsideWatching: true, now: () => (clock += 1000) };
  const send = (over: Record<string, unknown>) => handleHook({ session_id: "s1", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  await send({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: "c1", tool_input });
  await send({ hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: "c1", tool_input });
  const ledger = openLedger(home);
  try {
    const ops = ledger.okOpsForTask(1, 0, ledger.maxOpId()).map((o) => ({ id: o.id, tool: o.tool, intent: o.intent, args_json: o.argsJson }));
    const call = [...readRecord(ops, []).calls.values()][0]!;
    return { ops, serialized: JSON.stringify(ops), line: lineOf(call) };
  } finally {
    ledger.close();
  }
}

describe("connector calls store no input value but path and url", () => {
  for (const host of ["claude", "codex"] as const) {
    it(`${host}: no sentinel in the op or the timeline line; intent is the tool name`, async () => {
      const r = await run(host, "mcp__gmail__search_threads", input);
      for (const s of SENTINELS) {
        assert.ok(!r.serialized.includes(s), `${s} stored in ${r.serialized}`);
        assert.ok(!JSON.stringify(r.line).includes(s), `${s} in the line ${JSON.stringify(r.line)}`);
      }
      assert.equal(r.ops[0]!.intent, "mcp__gmail__search_threads");
      assert.equal(r.line.text, "Used search threads from gmail");
    });

    it(`${host}: path and url fields still go through masking and URL stripping`, async () => {
      const r = await run(host, "mcp__fs__get", { ...input, url: "https://example.com/a?token=SENT-TOKEN-8#frag" });
      assert.ok(!r.serialized.includes("SENT-TOKEN-8"));
      assert.ok(!SENTINELS.some((s) => r.serialized.includes(s)));
    });
  }

  it("a non-MCP tool keeps its command and description", async () => {
    const r = await run("claude", "Bash", { command: "echo hi", description: "Say hi" });
    assert.equal(r.ops[0]!.intent, "echo hi - Say hi");
    assert.equal(r.line.text, "Say hi");
  });
});
