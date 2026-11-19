import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildRuns } from "../src/timeline/runs.ts";
import { readRows } from "../src/timeline/load.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the two adapter-side findings of the first general-case session, replayed from synthetic hook payloads.
//  1. A Stop that closes a turn with nothing in it (a chat-only turn) cut a round identical to the one before: same last op, no
//     request, no closing claim.
//  2. A request's turn can end before its first step exists (an agent it launched keeps working after the Stop), so the op written
//     at that Stop says firstStep null for good. The review reads the step from the calls placed under the request.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  let id = 0;
  /** One call; `n` moves the workbook to probe snapshot `n` while it runs, undefined leaves it alone. */
  const call = async (n?: number) => {
    const callId = `c${++id}`;
    const input = { command: "python3 edit.py" };
    await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: callId, tool_input: input });
    if (n !== undefined) await copyFile(probe(n), path.join(folder, "casebook.xlsx"));
    await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: callId, tool_input: input });
    return callId;
  };
  const ask = (text: string) => send({ hook_event_name: "UserPromptSubmit", prompt: text });
  const stop = () => send({ hook_event_name: "Stop" });
  const withLedger = <T>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  const rounds = (taskId: number) => withLedger((l) => l.roundsForTask(taskId));
  return { send, call, ask, stop, withLedger, rounds, folder };
}

describe("a Stop with nothing in it cuts no round", () => {
  it("a chat-only turn after a round cuts a round of its own for its request and reply", async () => {
    const t = await setup();
    await t.call(1);
    const first = await t.stop();
    const taskId = first.summary!.taskId;
    const before = { rounds: t.rounds(taskId), ops: t.withLedger((l) => l.maxOpId()) };
    await t.ask("just talking");
    const chat = await t.stop();
    assert.notEqual(chat.summary, undefined, "the request and its reply are new ops, so the round is cut");
    assert.equal(t.rounds(taskId).length, before.rounds.length + 1);
    assert.equal(t.withLedger((l) => l.maxOpId()), before.ops + 2, "the request and the closing claim, nothing else");
  });

  it("two empty Stops in a row still add nothing", async () => {
    const t = await setup();
    await t.call(1);
    const taskId = (await t.stop()).summary!.taskId;
    await t.stop();
    await t.stop();
    assert.equal(t.rounds(taskId).length, 1);
  });

  it("a Stop that finds a hand edit still cuts its round, so the edit is shown", async () => {
    const t = await setup();
    await t.call(1);
    const taskId = (await t.stop()).summary!.taskId;
    await copyFile(probe(2), path.join(t.folder, "casebook.xlsx"));
    await t.ask("just talking");
    const out = await t.stop();
    assert.notEqual(out.summary, undefined);
    assert.equal(t.rounds(taskId).length, 2);
  });

  it("a Stop after a call cuts its round", async () => {
    const t = await setup();
    await t.call(1);
    const taskId = (await t.stop()).summary!.taskId;
    await t.ask("again");
    await t.call(2);
    await t.stop();
    assert.equal(t.rounds(taskId).length, 2);
  });
});

describe("a request's first step is set when a step follows it, even after its turn's Stop", () => {
  // The session's order of events, as the ledger saw it: a request, a call, Stop; then calls an agent made after that Stop, one of
  // which changed the file; then the wake (a second request) with a call that changed nothing, Stop.
  async function session() {
    const t = await setup();
    await t.call(1);
    await t.stop();
    await t.ask("ASK TWO");
    await t.call();
    await t.stop();
    const late1 = await t.call(2);
    const late2 = await t.call();
    await t.ask("WAKE");
    const own = await t.call();
    const taskId = (await t.stop()).summary!.taskId;
    return { t, taskId, late1, late2, own };
  }

  it("the request whose agent changed the file after the Stop points at that step; the wake that followed does not", async () => {
    const { t, taskId } = await session();
    const stamps = t.withLedger((l) => reviewModel(l, taskId).roundRequests.flatMap((r) => r.requests));
    const steps = t.withLedger((l) => l.stepsForTask(taskId));
    const changed = steps.filter((s) => s.credited.length > 0);
    assert.equal(stamps.length, 2);
    assert.equal(changed.length, 2, "the first call's step and the agent's");
    assert.equal(stamps[0]!.firstStep, changed[1]!.id, "ASK TWO: the agent's step, found after its Stop");
    assert.equal(stamps[1]!.firstStep, null, "WAKE: its only call changed nothing, and the agent's step started before it was sent");
  });

  it("the timeline puts the agent's calls under ASK TWO and the wake keeps only its own", async () => {
    const { t, taskId, late1, late2, own } = await session();
    const { ops, fileStates } = t.withLedger((l) => readRows(l, taskId));
    const { requests } = buildRuns(ops, fileStates);
    const placed = requests.map((r) => [r.texts[0], r.calls.map((c) => c.id)] as const);
    const two = placed.find(([text]) => text === "ASK TWO")!;
    const wake = placed.find(([text]) => text === "WAKE")!;
    assert.ok(two[1].includes(late1) && two[1].includes(late2));
    assert.deepEqual(wake[1], [own]);
  });
});
