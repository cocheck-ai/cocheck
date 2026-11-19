import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a helper's words just before a call reach that call, read from the helper's own transcript (subagents/agent-<id>.jsonl, every
// line a sidechain line), as the main session's words reach the main session's calls. The main transcript's sidechain lines stay unread.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const j = (o: unknown) => `${JSON.stringify(o)}\n`;
const asst = (msg: string, side: boolean, ...blocks: unknown[]) => j({ type: "assistant", isSidechain: side, message: { id: msg, role: "assistant", content: blocks } });
const say = (text: string) => ({ type: "text", text });
const use = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { sentinel: "TOOL-INPUT-NEVER-READ" } });
const NONE = { source: "none", text: "no narration recorded" };

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  await mkdir(folder, { recursive: true });
  await mkdir(home, { recursive: true });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 8, 12, 0, 0);
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "sess-1", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const main = path.join(root, "t.jsonl");
  const sub = path.join(root, "sess-1", "subagents");
  await mkdir(sub, { recursive: true });
  return {
    main,
    sub,
    async call(id: string, over: Record<string, unknown> = {}) {
      const base = { tool_name: "Bash", tool_use_id: id, tool_input: { command: "python3 edit.py", description: id }, transcript_path: main, ...over };
      await send({ hook_event_name: "PreToolUse", ...base });
      await send({ hook_event_name: "PostToolUse", ...base });
    },
    narration(id: string) {
      const ledger = openLedger(home);
      try {
        return ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>)).filter((o) => o.tool_use_id === id).map((o) => o.narration)[0];
      } finally {
        ledger.close();
      }
    },
  };
}

describe("a helper's words reach its call", () => {
  it("the helper's own transcript supplies the words of its call; the main one's sidechain lines stay unread", async () => {
    const t = await setup();
    await writeFile(t.main, asst("m0", true, say("MAIN-SIDECHAIN-NEVER-READ"), use("H0")) + asst("m1", false, say("Main words."), use("M1")));
    await writeFile(path.join(t.sub, "agent-ag1.jsonl"), asst("a1", true, say("Writing the memo now."), use("H1")) + j({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "H1", content: "TOOL-RESULT-NEVER-READ" }] } }) + asst("a2", true, say("Now the deck."), use("H2")));
    await t.call("M1");
    await t.call("H1", { agent_id: "ag1", agent_type: "general-purpose" });
    await t.call("H2", { agent_id: "ag1", agent_type: "general-purpose" });
    assert.deepEqual(t.narration("M1"), { source: "agent", label: "the agent's own words", text: "Main words." });
    assert.deepEqual(t.narration("H1"), { source: "agent", label: "the agent's own words", text: "Writing the memo now." });
    assert.deepEqual(t.narration("H2"), { source: "agent", label: "the agent's own words", text: "Now the deck." });
  });
  it("a helper with no transcript file records no narration", async () => {
    const t = await setup();
    await writeFile(t.main, asst("m1", false, say("Main words."), use("M1")));
    await t.call("H9", { agent_id: "ghost", agent_type: "general-purpose" });
    assert.deepEqual(t.narration("H9"), NONE);
  });
});
