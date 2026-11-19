import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildRuns } from "../src/timeline/runs.ts";
import { readRows } from "../src/timeline/load.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a turn where Claude only talked (a prompt, then a Stop with its reply, no tool call) was journaled but wrote no
// op, so the page lacked the request and its reply and the request numbers drifted. It now logs the request and its closing claim
// once a task exists. Guards against: a turn with calls still shows exactly one request, and an open turn (no Stop) invents no reply.
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
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  let id = 0;
  const call = async (n?: number) => {
    const callId = `c${++id}`;
    const input = { command: "python3 edit.py" };
    await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: callId, tool_input: input });
    if (n !== undefined) await copyFile(probe(n), path.join(folder, "book.xlsx"));
    await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: callId, tool_input: input });
  };
  const ask = (prompt: string) => send({ hook_event_name: "UserPromptSubmit", prompt });
  const stop = (reply: string) => send({ hook_event_name: "Stop", last_assistant_message: reply });
  const read = <T,>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  /** The requests the page is built from, in order: their text, reply words and call count. */
  const requests = (taskId = 1) =>
    read((l) => {
      const { ops, fileStates } = readRows(l, taskId);
      return buildRuns(ops, fileStates).requests.map((r) => ({ text: r.texts[0], replies: r.replies.map((x) => x.closing.text), calls: r.calls.length }));
    });
  const rounds = () => read((l) => l.roundsForTask(1).length);
  return { call, ask, stop, requests, rounds };
}

describe("a turn where Claude only talked shows as its own request", () => {
  it("a prompt and its reply with no call, after a worked request, is request 2 with the reply's words", async () => {
    const t = await setup();
    await t.ask("make the total row");
    await t.call(1);
    await t.stop("Added the total row.");
    await t.ask("what does the total row sum?");
    await t.stop("It sums column C, rows 2 to 9.");
    assert.deepEqual(t.requests(), [
      { text: "make the total row", replies: ["Added the total row."], calls: 1 },
      { text: "what does the total row sum?", replies: ["It sums column C, rows 2 to 9."], calls: 0 },
    ]);
  });

  it("a chat-only turn between two worked ones keeps the numbering in prompt order", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    await t.stop("did one");
    await t.ask("two, just a question");
    await t.stop("answer two");
    await t.ask("three");
    await t.call(2);
    await t.stop("did three");
    assert.deepEqual(t.requests().map((r) => r.text), ["one", "two, just a question", "three"]);
  });

  it("a normal turn with calls still shows exactly one request", async () => {
    const t = await setup();
    await t.ask("make the total row");
    await t.call(1);
    await t.call(2);
    await t.stop("Done.");
    assert.deepEqual(t.requests(), [{ text: "make the total row", replies: ["Done."], calls: 2 }]);
  });

  it("a prompt whose turn is still open invents no reply", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    await t.stop("did one");
    await t.ask("two, no stop yet");
    // the open turn's request is already there (written at submit); it has no reply and no call yet, and none is invented.
    assert.deepEqual(t.requests(), [{ text: "one", replies: ["did one"], calls: 1 }, { text: "two, no stop yet", replies: [], calls: 0 }]);
  });

  it("an empty Stop with no prompt adds no request and no round", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    await t.stop("did one");
    const before = t.rounds();
    await t.stop("again");
    assert.equal(t.rounds(), before);
    assert.equal(t.requests().length, 1);
  });

  it("a chat-only first turn is request 1: the folder's task is open from the first hook", async () => {
    const t = await setup();
    await t.ask("hello");
    await t.stop("hi");
    assert.deepEqual(t.requests(), [{ text: "hello", replies: ["hi"], calls: 0 }]);
  });
});
