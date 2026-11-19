import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { workbookClaims } from "./helpers/claims.ts";

// helpers share the main agent's session id and carry an agent_id.
// 1. The "called this round" mark is per agent. A call-less main turn keeps its request and reply when helper work is in flight
//    (a helper call of this session open at the Stop, or run during the turn); with nothing in flight it is dropped as before.
// 2. SubagentStop closes that helper's open calls (this session, this agent) and nothing else.
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const OUTSIDE = /not from an agent call/;

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
  const book = path.join(folder, "book.xlsx");
  await copyFile(probe(0), book);
  let clock = 1_000_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, perSession: false, now: () => clock };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const tool_input = { command: "python3 edit.py", description: "edit" };
  const who = (agent?: string) => (agent ? { agent_id: agent } : {});
  const pre = (id: string, agent?: string, session = "s1") => send({ session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input, ...who(agent) });
  const post = (id: string, agent?: string, session = "s1") => send({ session_id: session, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input, ...who(agent) });
  const ask = (prompt: string) => send({ hook_event_name: "UserPromptSubmit", prompt });
  const stop = (reply = "All done.") => send({ hook_event_name: "Stop", last_assistant_message: reply });
  const subStop = (agent?: string, session = "s1") => send({ session_id: session, hook_event_name: "SubagentStop", ...who(agent) });
  const read = <T,>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  const ops = () => read((l) => l.okOpsForTask(1, 0, l.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>));
  const prompts = () => ops().filter((o) => o.hookEvent === "UserPromptSubmit").flatMap((o) => o.prompts as string[]);
  const closings = () => ops().filter((o) => o.hookEvent === "Stop");
  const states = () => read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === book);
  const open = async (): Promise<string[]> => {
    const dir = path.join(home, "hooks", (await readdir(path.join(home, "hooks")))[0]!);
    return Object.keys(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).open).sort();
  };
  const write = (n: number) => copyFile(probe(n), book);
  // A first main call and Stop so a task and a stored file state exist.
  await pre("warm");
  await post("warm");
  await stop("warmed");
  return { pre, post, ask, stop, subStop, prompts, closings, ops, states, open, write };
}

describe("the called mark is per agent", () => {
  it("a call-less main turn with nothing in flight keeps its request and reply too", async () => {
    const t = await setup();
    await t.ask("just a question");
    await t.stop("An answer.");
    assert.deepEqual(t.prompts(), ["just a question"]);
    assert.equal(t.closings().length, 2, "the warm-up round's claim plus this one");
  });

  it("a call-less main turn keeps its request and reply when a helper call ran during it", async () => {
    const t = await setup();
    await t.ask("Plot in excel, not python please");
    await t.pre("toolu_H", "helper2");
    await t.post("toolu_H", "helper2");
    await t.stop("I plotted it.");
    assert.deepEqual(t.prompts(), ["Plot in excel, not python please"]);
    assert.equal(t.closings().length, 2);
  });

  it("recorded: a helper call opened before the prompt and still open at the Stop keeps the turn, with no helper event in the turn", async () => {
    const t = await setup();
    await t.pre("toolu_H", "helper2");
    await t.stop("between turns"); // the helper's call survives a main Stop and its 'ran' mark is spent here
    await t.ask("Plot in excel, not python please");
    await t.stop("I plotted it.");
    assert.deepEqual(t.prompts(), ["Plot in excel, not python please"]);
    assert.equal(t.closings().length, 3);
  });

  it("another session's open or running helper call neither adds to nor removes this session's call-less turn (it is kept once)", async () => {
    const t = await setup();
    await t.pre("toolu_O", "helperX", "s2");
    await t.pre("toolu_O2", undefined, "s2");
    await t.ask("just a question");
    await t.stop("An answer.");
    assert.deepEqual(t.prompts(), ["just a question"]);
  });

  it("a turn where the main agent made a call keeps its request and closing reply, helper calls or not", async () => {
    for (const helper of [false, true]) {
      const t = await setup();
      await t.ask("Fix the totals");
      await t.pre("toolu_M");
      await t.post("toolu_M");
      if (helper) {
        await t.pre("toolu_H", "helper2");
        await t.post("toolu_H", "helper2");
      }
      await t.stop("Fixed.");
      assert.deepEqual(t.prompts(), ["Fix the totals"], `helper=${helper}`);
      assert.equal(t.closings().length, 2, `helper=${helper}: the warm-up round's claim plus this one`);
    }
  });
});

describe("SubagentStop", () => {
  it("normalizes to its own kind, not 'other'", () => {
    assert.equal(normalize("claude", { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a" }).kind, "subagent-stop");
  });

  it("closes that helper's open calls, with an op each", async () => {
    const t = await setup();
    await t.pre("toolu_H1", "helper2");
    await t.pre("toolu_H2", "helper2");
    assert.deepEqual(await t.open(), ["toolu_H1", "toolu_H2"]);
    await t.subStop("helper2");
    assert.deepEqual(await t.open(), []);
    const ids = t.ops().map((o) => o.tool_use_id);
    assert.ok(ids.includes("toolu_H1") && ids.includes("toolu_H2"), "both calls were logged when they closed");
  });

  it("never closes the main agent's calls, another helper's, or another session's", async () => {
    const t = await setup();
    await t.pre("toolu_main");
    await t.pre("toolu_H1", "helper2");
    await t.pre("toolu_X", "helper3");
    await t.pre("toolu_other", undefined, "s2");
    await t.pre("toolu_otherH", "helper2", "s2");
    await t.subStop("helper2");
    assert.deepEqual(await t.open(), ["toolu_X", "toolu_main", "toolu_other", "toolu_otherH"]);
  });

  it("with no agent id it closes nothing (main calls carry no agent id either)", async () => {
    const t = await setup();
    await t.pre("toolu_main");
    await t.pre("toolu_H1", "helper2");
    await t.subStop();
    assert.deepEqual(await t.open(), ["toolu_H1", "toolu_main"]);
  });

  it("a helper's late Post after its SubagentStop does not log the call twice", async () => {
    const t = await setup();
    await t.pre("toolu_H1", "helper2");
    await t.subStop("helper2");
    const before = t.ops().filter((o) => o.tool_use_id === "toolu_H1").length;
    await t.post("toolu_H1", "helper2");
    assert.equal(t.ops().filter((o) => o.tool_use_id === "toolu_H1").length, before);
  });

  it("writes no round and no closing claim", async () => {
    const t = await setup();
    const before = t.closings().length;
    await t.pre("toolu_H1", "helper2");
    await t.subStop("helper2");
    assert.equal(t.closings().length, before);
  });

  it("a person's edit with no call open still reads outside", async () => {
    const t = await setup();
    await t.pre("toolu_H1", "helper2");
    await t.subStop("helper2");
    await t.write(1);
    await t.subStop("helper2");
    const last = t.states().at(-1)!;
    assert.deepEqual(last.credited, []);
    assert.match(last.note, OUTSIDE);
  });

  it("a write found while the main agent's call is still open is credited to it, not called outside", async () => {
    const t = await setup();
    await t.pre("toolu_main");
    await t.pre("toolu_H1", "helper2");
    await t.write(1);
    await t.subStop("helper2");
    const last = t.states().at(-1)!;
    assert.deepEqual(last.credited, ["toolu_main"]);
    assert.doesNotMatch(last.note, OUTSIDE);
  });
});
