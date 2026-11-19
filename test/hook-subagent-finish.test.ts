import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// SubagentStop records a finish op for a real helper (an agent type), with its last message redacted and cut. Claude Code's own
// internal agents fire SubagentStop too, with an empty agent type; they write nothing.
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  await copyFile(probe(0), path.join(folder, "book.xlsx"));
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock, outsideWatching: false };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const tool_input = { command: "python3 edit.py", description: "edit" };
  await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input });
  await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  const finishes = () => {
    const l = openLedger(home);
    try {
      return l.okOpsForTask(1, 0, l.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>).filter((o) => o.hookEvent === "SubagentStop");
    } finally {
      l.close();
    }
  };
  const calls = (tool: string) => {
    const l = openLedger(home);
    try {
      return l.okOpsForTask(1, 0, l.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>).filter((o) => o.tool_name === tool);
    } finally {
      l.close();
    }
  };
  const subStop = (over: Record<string, unknown>) => send({ hook_event_name: "SubagentStop", ...over });
  return { send, subStop, finishes, calls, folder };
}

describe("SubagentStop records the helper's finish", () => {
  it("a helper with an agent type writes one finish op with its last message", async () => {
    const t = await setup();
    await t.subStop({ agent_id: "acharts", agent_type: "charts-deck", last_assistant_message: "Charts are done." });
    const [f, ...rest] = t.finishes();
    assert.equal(rest.length, 0);
    assert.equal(f!.agent_id, "acharts");
    assert.equal(f!.agent_type, "charts-deck");
    assert.equal(f!.session_id, "s1");
    assert.equal(f!.finish.text, "Charts are done.");
    assert.equal(typeof f!.at, "number");
    assert.equal(typeof f!.seq, "number");
  });

  it("the last message is redacted like a reply: an outside path is masked, a long one is cut", async () => {
    const t = await setup();
    await t.subStop({ agent_id: "a1", agent_type: "memo-writer", last_assistant_message: "Saved to /Users/someone/secret/out.docx for you." });
    await t.subStop({ agent_id: "a2", agent_type: "memo-writer", last_assistant_message: "x".repeat(9000) });
    const [a, b] = t.finishes();
    assert.ok(!a!.finish.text.includes("/Users/someone"), a!.finish.text);
    assert.match(a!.finish.text, /\[outside path\]/);
    assert.ok(b!.finish.text.length < 4200, String(b!.finish.text.length));
    assert.match(b!.finish.text, /9000 characters/);
  });

  it("a helper with no last message still records its finish, with no text", async () => {
    const t = await setup();
    await t.subStop({ agent_id: "a1", agent_type: "memo-writer" });
    assert.deepEqual(t.finishes().map((f) => f.finish), [{}]);
  });

  it("Claude Code's own internal agents (empty agent type) and events with no agent id write nothing", async () => {
    const t = await setup();
    await t.subStop({ agent_id: "internal1", agent_type: "", last_assistant_message: "hidden" });
    await t.subStop({ agent_id: "internal2", last_assistant_message: "hidden" });
    await t.subStop({ agent_type: "memo-writer", last_assistant_message: "no id" });
    assert.deepEqual(t.finishes(), []);
  });
});

describe("a SendMessage records what it said", () => {
  it("the recipient, summary and message are in the call's label; a secret-looking message is dropped, not recorded", async () => {
    const t = await setup();
    const go = async (id: string, tool_input: Record<string, unknown>) => {
      await t.send({ hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_use_id: id, tool_input });
      await t.send({ hook_event_name: "PostToolUse", tool_name: "SendMessage", tool_use_id: id, tool_input });
      await t.send({ hook_event_name: "Stop", last_assistant_message: "sent" });
    };
    await go("m1", { to: "memo-writer", summary: "new chart", message: "Rewrite the memo around the new chart. See /Users/someone/x.xlsx." });
    await go("m2", { to: "memo-writer", message: "use ghp_Z8k2Qm4Xv7Rt1Pw9Yb3Nc6Hd5Jf0Lg8Ae2SW" });
    const [a, b] = t.calls("SendMessage");
    assert.equal(a!.toolLabel.fields.to, "memo-writer");
    assert.equal(a!.toolLabel.fields.summary, "new chart");
    assert.match(a!.toolLabel.fields.message, /^Rewrite the memo around the new chart\. See \[outside path\]/);
    assert.equal(b!.toolLabel.fields.message, undefined);
    assert.ok(b!.toolLabel.dropped.message);
  });
});
