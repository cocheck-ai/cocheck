import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { wakeText } from "./fixtures/timeline.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Through the real adapter: hook events in the shapes of a real session (the replay driver's sequence), synthetic folder.
// (e) a wake turn with no call still leaves its wake; (f) a background Agent launcher is never an open writer, a background Bash still is.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

async function session() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-q220a-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-q220a-folder-")));
  const tx = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-q220a-tx-")));
  cleanups.push(async () => {
    for (const d of [home, folder, tx]) await rm(d, { recursive: true, force: true });
  });
  await mkdir(path.join(tx, "sess", "subagents"), { recursive: true });
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000) };
  const hook = (o: Record<string, unknown>) => handleHook({ session_id: "sess", cwd: folder, transcript_path: path.join(tx, "sess.jsonl"), ...o } as HookPayload, opts);
  let n = 0;
  let v = 0;
  const F = (f: string) => path.join(folder, f);
  const tool = async (name: string, ti: Record<string, unknown>, who: Record<string, unknown> = {}, effect?: () => Promise<void>) => {
    const id = "toolu_" + String(++n).padStart(4, "0");
    const p = { tool_name: name, tool_use_id: id, tool_input: ti, ...who };
    await hook({ hook_event_name: "PreToolUse", ...p });
    if (effect) await effect();
    await hook({ hook_event_name: "PostToolUse", ...p, tool_response: {} });
    return id;
  };
  const edit = (file: string, who: Record<string, unknown> = {}) => tool("Edit", { file_path: F(file), old_string: "a", new_string: "b" }, who, () => writeFile(F(file), `version ${++v} of ${file}\nline two\n`));
  const launcher = (description: string) => tool("Agent", { description, prompt: "p", run_in_background: true, subagent_type: "general-purpose" });
  const meta = (agent: string, tu: string) => writeFile(path.join(tx, "sess", "subagents", `agent-${agent}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: tu }));
  const model = () => {
    const ledger = openLedger(home);
    try {
      const loaded = loadRows(ledger, 1, "test");
      return buildRailModel(buildTimeline({ ...loaded, build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false }));
    } finally {
      ledger.close();
    }
  };
  const start = async (...files: string[]) => {
    for (const f of files) await writeFile(F(f), "start\n");
  };
  const ops = () => {
    const ledger = openLedger(home);
    try {
      return ledger.okOpsForTask(1, 0, ledger.maxOpId()).map((o) => o.argsJson);
    } finally {
      ledger.close();
    }
  };
  return { hook, tool, edit, launcher, meta, model, start, ops, file: F };
}
const A = { agent_id: "af9e2f578472e9c01", agent_type: "general-purpose" };
const B = { agent_id: "b7c1d3e5a9f2468ab", agent_type: "general-purpose" };
const wake = (tu: string, title: string) => wakeText({ toolUseId: tu, summary: `Agent "${title}" finished`, result: "The research is complete. ".repeat(40) });

describe("(e) a wake turn with no call", () => {
  it("a read-only agent's wake, answered in text only, is a stop and the lane merges there", async () => {
    const t = await session();
    await t.start("a.txt");
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "Check the notes." });
    const L = await t.launcher("Research");
    await t.meta(A.agent_id, L);
    await t.tool("Read", { file_path: path.join("a.txt") }, A);
    await t.hook({ hook_event_name: "Stop", last_assistant_message: "A helper is running." });
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: wake(L, "Research") });
    await t.hook({ hook_event_name: "Stop", last_assistant_message: "Research done." });
    const m = t.model();
    const wakeStop = m.stops.find((s) => s.head.startsWith("Helper 1 finished"));
    assert.ok(wakeStop, "no wake stop: " + JSON.stringify(m.stops.map((s) => s.head)));
    assert.equal(m.actors.find((a) => a.id === "agent:1")?.mergeId, wakeStop.id);
    assert.equal(m.stops.filter((s) => s.request).length, 1);
  });

  it("an ordinary typed request whose turn has no call is recorded too, and counts in the numbering", async () => {
    const t = await session();
    await t.start("a.txt");
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "Just a question, no tools." });
    await t.hook({ hook_event_name: "Stop", last_assistant_message: "Answer." });
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "Check the notes." });
    await t.edit("a.txt");
    await t.hook({ hook_event_name: "Stop", last_assistant_message: "Done." });
    const heads = t.model().stops.filter((s) => s.request).map((s) => s.head);
    assert.deepEqual(heads, ["You made request 1", "You made request 2"]);
    assert.ok(JSON.stringify(t.model()).includes("Just a question"));
  });
});

describe("(f) a background launcher is not an open writer", () => {
  it("helper B's own Edit lands on B's lane, not on Claude's line", async () => {
    const t = await session();
    await t.start("a.txt", "b.txt", "c.txt");
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "Update the notes." });
    await t.edit("a.txt");
    const T1 = await t.launcher("Research");
    const T2 = await t.launcher("Rewrite the summary file");
    await t.meta(A.agent_id, T1);
    await t.meta(B.agent_id, T2);
    await t.tool("Read", { file_path: "a.txt" }, A);
    await t.edit("b.txt", B);
    await t.edit("c.txt");
    await t.hook({ hook_event_name: "Stop", last_assistant_message: "Two helpers are running." });
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: wake(T2, "Rewrite the summary file") });
    await t.hook({ hook_event_name: "Stop", last_assistant_message: "Rewrite done." });
    const m = t.model();
    const bChange = m.stops.find((s) => s.change?.file === "b.txt")!;
    assert.ok(bChange, "no change stop for b.txt");
    assert.ok(bChange.lane?.startsWith("agent:"), `b.txt is on ${bChange.lane}, head: ${bChange.head}`);
    assert.ok(!m.stops.some((s) => s.head === "Claude changed b.txt"));
    assert.equal(m.stops.find((s) => s.change?.file === "c.txt")!.lane, "claude");
  });

  it("a background Bash still gets credit for a file written after its Post", async () => {
    const t = await session();
    await t.start("a.txt");
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "Run the job." });
    const p = { tool_name: "Bash", tool_use_id: "toolu_BASH", tool_input: { command: "sleep 9 && echo x > a.txt", run_in_background: true } };
    await t.hook({ hook_event_name: "PreToolUse", ...p });
    await t.hook({ hook_event_name: "PostToolUse", ...p, tool_response: {} });
    await writeFile(t.file("a.txt"), "written by the job\nline two\n");
    await t.tool("Read", { file_path: "a.txt" }); // the next call's Post finds the write; the job is still open
    await t.hook({ hook_event_name: "Stop", last_assistant_message: "Started." });
    const ops = t.ops();
    const bash = ops.find((o) => o.includes("toolu_BASH"));
    assert.ok(bash, "no op for the Bash job");
    assert.ok(/"steps":\[\d/.test(bash), "the job got no step credit: " + bash.slice(0, 400));
  });
});
