import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

/**
 * recorded. A Codex subagent writes its own rollout, named by its own thread id; the hook payload for its calls carries the
 * parent's `session_id` and the helper's `agent_id`. Definition under test: a helper call's narration comes from the rollout named by
 * its `agent_id`, only when that rollout's header names the thread and the calling session; the parent's narration is unchanged.
 * Guards against: a helper call never gets the parent's sentence or another helper's.
 */
const probe = path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx");
const PARENT = "01a15049-836b-73b1-b41c-91a051fd802d";
const HELPER_A = "01a150cf-3eff-7df3-8db7-5c3d2e83012d";
const HELPER_B = "01a150cf-5336-7731-ac87-ded34b7b7348";
const STRANGER = "01a150cf-9999-7731-ac87-ded34b7b7348";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const j = (o: unknown) => `${JSON.stringify(o)}\n`;
const item = (type: string, rest: Record<string, unknown>) => j({ type: "event_msg", payload: { type: "item_completed", item: { type, ...rest } } });
const say = (text: string) => item("AgentMessage", { id: `a-${Math.random()}`, phase: "commentary", content: [{ type: "output_text", text }] });
const exec = (id: string) => item("CommandExecution", { id, command: ["/bin/zsh"] });
const header = (id: string, over: Record<string, unknown> = {}) => j({ type: "session_meta", payload: { id, session_id: PARENT, ...over } });

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  const day = path.join(root, "codex-sessions", "2026", "10", "18");
  await mkdir(folder, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(day, { recursive: true });
  await copyFile(probe, path.join(folder, "casebook.xlsx"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 18, 21, 0, 0);
  const opts = { perSession: false, host: "codex" as const, home, claimed: workbookClaims, folder, now: () => clock, codexSessions: path.join(root, "codex-sessions") };
  const rollout = (id: string, body: string) => writeFile(path.join(day, `rollout-2026-10-18T16-58-41-${id}.jsonl`), body);
  const call = async (id: string, extra: Record<string, unknown> = {}) => {
    for (const hook_event_name of ["PreToolUse", "PostToolUse"]) {
      clock += 1000;
      await handleHook({ session_id: PARENT, cwd: folder, hook_event_name, tool_name: "Bash", tool_use_id: id, tool_input: { command: "true" }, ...extra } as HookPayload, opts);
    }
  };
  const narration = (id: string) => {
    const ledger = openLedger(home);
    try {
      const ops = ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson)));
      return ops.filter((a: any) => a.tool_use_id === id).map((a: any) => a.narration)[0];
    } finally {
      ledger.close();
    }
  };
  return { rollout, call, narration };
}

describe("Codex helper narration from the helper's own rollout", () => {
  it("two helpers and a parent: each call takes its own rollout's sentence", async () => {
    const t = await setup();
    await t.rollout(PARENT, header(PARENT) + say("PARENT SENTENCE") + exec("exec-p"));
    await t.rollout(HELPER_A, header(HELPER_A, { parent_thread_id: PARENT }) + say("A SENTENCE") + exec("exec-a"));
    await t.rollout(HELPER_B, header(HELPER_B, { parent_thread_id: PARENT }) + say("B SENTENCE") + exec("exec-b"));
    await t.call("exec-p");
    await t.call("exec-a", { agent_id: HELPER_A });
    await t.call("exec-b", { agent_id: HELPER_B });
    assert.equal(t.narration("exec-p").text, "PARENT SENTENCE");
    assert.equal(t.narration("exec-a").text, "A SENTENCE");
    assert.equal(t.narration("exec-b").text, "B SENTENCE");
  });

  it("a helper whose rollout is missing gets no narration, never the parent's", async () => {
    const t = await setup();
    await t.rollout(PARENT, header(PARENT) + say("PARENT SENTENCE") + exec("exec-a"));
    await t.call("exec-a", { agent_id: HELPER_A });
    assert.equal(t.narration("exec-a").source, "none");
  });

  it("a rollout whose header names another thread or another session is not used", async () => {
    const t = await setup();
    await t.rollout(HELPER_A, header(STRANGER, { parent_thread_id: PARENT }) + say("WRONG THREAD") + exec("exec-a"));
    await t.rollout(HELPER_B, header(HELPER_B, { session_id: STRANGER, parent_thread_id: STRANGER }) + say("WRONG SESSION") + exec("exec-b"));
    await t.call("exec-a", { agent_id: HELPER_A });
    await t.call("exec-b", { agent_id: HELPER_B });
    assert.equal(t.narration("exec-a").source, "none");
    assert.equal(t.narration("exec-b").source, "none");
  });

  it("an agent_id equal to the session id is the parent, not a helper rollout", async () => {
    const t = await setup();
    await t.rollout(PARENT, header(PARENT) + say("PARENT SENTENCE") + exec("exec-a"));
    await t.call("exec-a", { agent_id: PARENT });
    assert.equal(t.narration("exec-a").source, "none");
  });
});
