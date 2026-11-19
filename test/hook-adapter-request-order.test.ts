import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { reviewModel, type RequestStamp } from "./helpers/legacy-review-model.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

const fwd = (p: string): string => p.replaceAll("\\", "/"); // a Bash command line names paths with forward slashes on every OS

// each captured request carries its submit order (the state.seq stamp, shared with steps and calls), its wall time, and the
// ledger id of the first step written after it in the same session. The hold stays: a request alone never opens a task.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(host: "claude" | "codex") {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { host, home, claimed: workbookClaims, folder, perSession: false, now: () => clock };
  const sendAs = (session: string, over: Record<string, unknown>) =>
    handleHook({ session_id: session, transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  const tick = (): number => (clock += 1000);
  const promptAs = (session: string, text: unknown) => {
    tick();
    return sendAs(session, host === "claude" ? { hook_event_name: "UserPromptSubmit", prompt: text } : { hook_event_name: "UserPromptSubmit", turn_id: "t1", model: "gpt", prompt: text });
  };
  let id = 0;
  /** One call; `n` moves the workbook to probe snapshot `n`, undefined leaves it alone. Returns the call id. */
  const callAs = async (session: string, n?: number) => {
    const call = `c${++id}`;
    const input = { command: "python3 edit.py" };
    tick();
    await sendAs(session, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: call, tool_input: input });
    if (n !== undefined) await copyFile(probe(n), path.join(folder, "casebook.xlsx"));
    tick();
    await sendAs(session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: call, tool_input: input });
    return call;
  };
  /** The two halves of a call apart, so a request can be sent while it is open. `n` is the snapshot written between Pre and Post by `write`. */
  const preAs = async (session: string, command = "python3 edit.py") => {
    const call = `c${++id}`;
    tick();
    await sendAs(session, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: call, tool_input: { command } });
    return call;
  };
  const writeSnapshot = (n: number) => copyFile(probe(n), path.join(folder, "casebook.xlsx"));
  const postAs = async (session: string, call: string) => {
    tick();
    await sendAs(session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: call, tool_input: { command: "python3 edit.py" } });
  };
  const stopAs = async (session: string) => {
    tick();
    return sendAs(session, { hook_event_name: "Stop" });
  };
  /** Everything the ledger holds for a task: every op's args with the numeric tail of its key, the steps, and the model's request stamps. */
  const read = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      const ops = ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => ({ id: o.id, args: JSON.parse(o.argsJson) as Record<string, any> }));
      // a request written at its round's first call is told its first step by a RequestFirstStep op; fold it in so the asserts read the effective value.
      const told = new Map<number, number>(ops.flatMap((o) => (o.args.hookEvent === "RequestFirstStep" ? (o.args.requests as Array<{ seq: number; firstStep: number }>).map((q) => [q.seq, q.firstStep] as [number, number]) : [])));
      for (const o of ops) if (o.args.hookEvent === "UserPromptSubmit") for (const q of o.args.requests as Array<{ seq: number; firstStep: number | null }>) if (q.firstStep === null && told.has(q.seq)) q.firstStep = told.get(q.seq)!;
      const stamps: RequestStamp[] = reviewModel(ledger, taskId).roundRequests.flatMap((r) => r.requests);
      return { ops, steps: ledger.stepsForTask(taskId), stamps };
    } finally {
      ledger.close();
    }
  };
  /** A first quiet round, so the baseline copy of the folder (itself a step) is written before the requests under test. */
  const warm = async () => {
    const first = await callAs("s1");
    await stopAs("s1");
    return first;
  };
  const maxOp = (): number => {
    const ledger = openLedger(home);
    try {
      return ledger.maxOpId();
    } finally {
      ledger.close();
    }
  };
  /** The folder's one task. A Stop after the round is already cut cuts none, so it returns no summary to read it from. */
  const onlyTask = (): number => {
    const ledger = openLedger(home);
    try {
      return ledger.allTaskIds()[0]!;
    } finally {
      ledger.close();
    }
  };
  const tail = (key: string): number => Number(/#(\d+)$/.exec(key)![1]);
  /** The start order (Pre) a call's op carries. */
  const startOf = (ops: Array<{ args: Record<string, any> }>, call: string): number => ops.find((o) => o.args.tool_use_id === call)!.args.startSeq as number;
  const stateFile = async () => {
    const { readdir } = await import("node:fs/promises");
    const hooks = path.join(home, "hooks");
    const d = (await readdir(hooks))[0]!;
    return JSON.parse(await readFile(path.join(hooks, d, "state.json"), "utf8")) as { seq: number; held: Record<string, any> };
  };
  return { onlyTask, startOf, maxOp, warm, clockNow: () => clock, promptAs, callAs, preAs, postAs, writeSnapshot, stopAs, read, tail, stateFile, home, mkdir };
}

for (const host of ["claude", "codex"] as const) {
  describe(`a request knows when it was sent`, () => {
    it("two requests then calls: submit order, time, and the first step after both", async () => {
      const t = await setup(host);
      const call0 = await t.warm();
      await t.promptAs("s1", "FIRST ASK");
      const t1 = t.clockNow();
      await t.promptAs("s1", "SECOND ASK");
      const t2 = t.clockNow();
      await t.callAs("s1", 1);
      await t.callAs("s1", 2);
      const stop = await t.stopAs("s1");
      const { ops, steps, stamps } = t.read(stop.summary!.taskId);
      // each prompt is written when it is submitted once a task is open, so the two asks are two ops, still in submit order and each once.
      assert.deepEqual(ops.filter((o) => o.args.hookEvent === "UserPromptSubmit").flatMap((o) => o.args.prompts as string[]), ["FIRST ASK", "SECOND ASK"]);
      assert.equal(stamps.length, 2);
      assert.ok(stamps[0]!.seq < stamps[1]!.seq, "submit order kept");
      assert.deepEqual(stamps.map((s) => s.at), [t1, t2]);
      assert.deepEqual(stamps.map((s) => s.session), ["s1", "s1"]);
      assert.equal(steps.length, 3, "the baseline, then one step per edit");
      assert.deepEqual(stamps.map((s) => s.firstStep), [steps[1]!.id, steps[1]!.id]);
      // Never after a call it preceded: both stamps are below every call op's own number.
      const calls = ops.filter((o) => o.args.tool_use_id !== undefined && o.args.tool_use_id !== call0).map((o) => o.args.hookOpKey as string);
      assert.ok(calls.length >= 2, `call ops found: ${calls.join(",")}`);
      for (const k of calls) assert.ok(stamps[1]!.seq < t.tail(k), `request before call ${k}`);
    });

    it("a request after a call and before the next step points at the later step, and sits after the earlier call", async () => {
      const t = await setup(host);
      await t.warm();
      await t.promptAs("s1", "ASK ONE");
      const early = await t.callAs("s1", 1);
      await t.promptAs("s1", "ASK TWO, MID-TURN");
      const late = await t.callAs("s1", 2);
      const stop = await t.stopAs("s1");
      const { ops, steps, stamps } = t.read(stop.summary!.taskId);
      assert.equal(steps.length, 3);
      assert.deepEqual(stamps.map((s) => s.firstStep), [steps[1]!.id, steps[2]!.id]);
      assert.ok(t.startOf(ops, early) < stamps[1]!.seq && stamps[1]!.seq < t.startOf(ops, late), "the second request sits between the two calls");
    });

    it("a request with no call after it is logged at its Stop: its own op, and the next round does not carry it", async () => {
      const t = await setup(host);
      await t.promptAs("s1", "JUST A QUESTION");
      assert.ok(t.maxOp() > 0, "a tracked session's first prompt opens the task and is written at once");
      const first = await t.stopAs("s1");
      const asked = t.read(first.summary!.taskId).ops.filter((o) => o.args.hookEvent === "UserPromptSubmit");
      assert.deepEqual(asked.map((o) => o.args.prompts), [["JUST A QUESTION"]], "the talked-only request has its op");
      await t.promptAs("s1", "THE REAL ASK");
      await t.callAs("s1", 1);
      const stop = await t.stopAs("s1");
      const { ops, stamps } = t.read(stop.summary!.taskId);
      const a = ops.filter((o) => o.args.hookEvent === "UserPromptSubmit").at(-1)!.args;
      assert.deepEqual(a.prompts, ["THE REAL ASK"], "the spent request is not carried into the next round");
      assert.equal(stamps.length, 2);
    });

    it("a call that changed nothing leaves firstStep null (no step exists)", async () => {
      const t = await setup(host);
      await t.warm();
      await t.promptAs("s1", "LOOK ONLY");
      await t.callAs("s1");
      const stop = await t.stopAs("s1");
      const { stamps, steps } = t.read(stop.summary!.taskId);
      assert.equal(steps.length, 1, "only the baseline, written before the request");
      assert.equal(stamps.length, 1);
      assert.equal(stamps[0]!.firstStep, null);
    });

    it("interleaved sessions in one folder: a request never points at the other session's step", async () => {
      const t = await setup(host);
      await t.warm();
      await t.promptAs("s1", "S1 ASK");
      await t.promptAs("s2", "S2 ASK");
      await t.callAs("s2", 1); // the only step: found by session s2's hook
      await t.callAs("s1"); // s1 calls, changes nothing
      await t.stopAs("s2");
      await t.stopAs("s1");
      const { ops, steps, stamps } = t.read(t.onlyTask());
      assert.equal(steps.length, 2);
      const by = (s: string) => ops.find((o) => o.args.hookEvent === "UserPromptSubmit" && o.args.session_id === s);
      assert.equal(by("s2")!.args.requests[0].firstStep, steps[1]!.id);
      assert.equal(by("s1")!.args.requests[0].firstStep, null, "s1's request does not borrow s2's step");
      assert.ok(by("s1")!.args.requests[0].seq < by("s2")!.args.requests[0].seq);
      assert.deepEqual(stamps.map((s) => s.session), ["s1", "s2"], "the model lists them in submit order");
    });

    it("a payload without prompt text is not captured: it takes no place in the order and leaves the others whole", async () => {
      const t = await setup(host);
      await t.promptAs("s1", "BEFORE");
      const before = (await t.stateFile()).seq;
      await t.promptAs("s1", undefined);
      await t.promptAs("s1", "  ");
      await t.promptAs("s1", 42);
      const state = await t.stateFile();
      assert.equal(state.seq, before, "a blank prompt draws nothing from the shared counter");
      assert.equal(state.held["s1"].prompts.length, 1);
      assert.equal(state.held["s1"].seqs.length, 1);
      assert.equal(state.held["s1"].ats.length, 1);
      assert.equal(state.held["s1"].firsts.length, 1);
      await t.promptAs("s1", "AFTER");
      await t.callAs("s1", 1);
      const stop = await t.stopAs("s1");
      const { ops, stamps } = t.read(stop.summary!.taskId);
      // each prompt is written when submitted, so BEFORE and AFTER are two ops in order.
      assert.deepEqual(ops.filter((o) => o.args.hookEvent === "UserPromptSubmit").flatMap((o) => o.args.prompts), ["BEFORE", "AFTER"]);
      assert.equal(stamps.length, 2);
      // BEFORE is written at submit, and its op key draws one value; the blank prompts drew none (asserted above).
      assert.equal(stamps[1]!.seq, stamps[0]!.seq + 2, "only the written request's op key was spent between the two real requests");
    });

    it("a call open when the request is sent sorts before it, and its step is not the request's first step", async () => {
      const t = await setup(host);
      await t.warm();
      const a = await t.preAs("s1");
      await t.promptAs("s1", "ASK WHILE A RUNS");
      await t.writeSnapshot(1);
      await t.postAs("s1", a);
      const b = await t.callAs("s1", 2);
      const stop = await t.stopAs("s1");
      const { ops, steps, stamps } = t.read(stop.summary!.taskId);
      assert.equal(steps.length, 3, "baseline, A's edit, B's edit");
      assert.ok(t.startOf(ops, a) < stamps[0]!.seq, "A started before the request, so it sorts before it though it closed after");
      assert.ok(stamps[0]!.seq < t.startOf(ops, b), "B started after");
      assert.equal(stamps[0]!.firstStep, steps[2]!.id, "A's step is skipped; B's is the first");
    });

    it("one call started before the request and one after, both closing after it: only the later call's step counts", async () => {
      const t = await setup(host);
      await t.warm();
      const a = await t.preAs("s1");
      await t.promptAs("s1", "ASK");
      const b = await t.preAs("s1");
      await t.writeSnapshot(1); // found at A's Post, with B open: it may be A's, so it is not the request's first step
      await t.postAs("s1", a);
      await t.writeSnapshot(2); // found at B's Post, B alone open and started after the request
      await t.postAs("s1", b);
      const stop = await t.stopAs("s1");
      const { ops, steps, stamps } = t.read(stop.summary!.taskId);
      assert.equal(steps.length, 3);
      assert.ok(t.startOf(ops, a) < stamps[0]!.seq && stamps[0]!.seq < t.startOf(ops, b));
      assert.equal(stamps[0]!.firstStep, steps[2]!.id);
    });

    it("a change found by no call (a hand edit between calls) is not a request's first step", async () => {
      const t = await setup(host);
      await t.warm();
      await t.promptAs("s1", "ASK");
      await t.writeSnapshot(1); // nobody's call: found at the next Pre with nothing open
      await t.callAs("s1");
      const stop = await t.stopAs("s1");
      const { steps, stamps } = t.read(stop.summary!.taskId);
      assert.equal(steps.length, 2);
      assert.equal(stamps[0]!.firstStep, null);
    });

    it("the first request of a brand-new task, with no warm-up round, points at the agent's first change, not the baseline", async () => {
      const t = await setup(host);
      await t.promptAs("s1", "THE VERY FIRST ASK");
      await t.callAs("s1", 1);
      const stop = await t.stopAs("s1");
      const { steps, stamps } = t.read(stop.summary!.taskId);
      assert.equal(steps.length, 2, "the baseline, then the agent's edit");
      assert.notEqual(stamps[0]!.firstStep, steps[0]!.id, "never the baseline copy");
      assert.equal(stamps[0]!.firstStep, steps[1]!.id);
    });

    it("a workbook outside the folder baselined while a later call is open is a starting copy too, not the first step", async () => {
      const t = await setup(host);
      await t.warm();
      const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-out-")));
      cleanups.push(() => rm(outside, { recursive: true, force: true }));
      await copyFile(probe(0), path.join(outside, "other.xlsx"));
      await t.promptAs("s1", "ASK");
      const c = await t.preAs("s1");
      const d = await t.preAs("s1", `python3 read.py ${fwd(path.join(outside, "other.xlsx"))}`); // baselined here, with c open and started after the request
      await t.writeSnapshot(1);
      await t.postAs("s1", d);
      await t.postAs("s1", c);
      const stop = await t.stopAs("s1");
      const { steps, stamps } = t.read(stop.summary!.taskId);
      assert.equal(steps.length, 3, "the folder baseline, the outside baseline, the edit");
      assert.equal(stamps[0]!.firstStep, steps[2]!.id);
    });

    it("a first request whose calls change nothing has no first step (the baseline never stands in)", async () => {
      const t = await setup(host);
      await t.promptAs("s1", "LOOK ONLY");
      await t.callAs("s1");
      const stop = await t.stopAs("s1");
      const { steps, stamps } = t.read(stop.summary!.taskId);
      assert.equal(steps.length, 1);
      assert.equal(stamps[0]!.firstStep, null);
    });

    it("more requests than are kept: the stamps stay parallel to the texts that survive", async () => {
      const t = await setup(host);
      for (let i = 1; i <= 5; i++) await t.promptAs("s1", `ASK ${i}`);
      await t.callAs("s1", 1);
      const stop = await t.stopAs("s1");
      const { ops } = t.read(stop.summary!.taskId);
      // every ask is written when submitted (a task is open from the first), so none is dropped: five asks, each once, in order, stamps parallel.
      const asks = ops.filter((o) => o.args.hookEvent === "UserPromptSubmit").map((o) => o.args);
      assert.ok(asks.every((a) => a.prompts.length === a.requests.length));
      assert.deepEqual(asks.flatMap((a) => a.prompts), ["ASK 1", "ASK 2", "ASK 3", "ASK 4", "ASK 5"]);
      const seqs = asks.flatMap((a) => a.requests.map((r: any) => r.seq));
      assert.ok(seqs.every((q: number, i: number) => i === 0 || seqs[i - 1] < q));
    });

  });
}

describe("replay of the Codex Work leg (live run)", () => {
  it("the request sits before the leg's first call, with its time and the first step after it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
    const ws = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-ws-")));
    cleanups.push(async () => {
      for (const d of [home, folder, ws]) await rm(d, { recursive: true, force: true });
    });
    await mkdir(path.join(ws, "outputs"));
    await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
    await copyFile(probe(0), path.join(ws, "outputs", "casebook.xlsx"));
    let clock = 5_000_000;
    const opts = { host: "codex" as const, home, claimed: workbookClaims, folder, perSession: false, now: () => clock };
    const send = (event: string, over: Record<string, unknown>) => handleHook({ session_id: "cx", cwd: folder, hook_event_name: event, ...over } as HookPayload, opts);
    const leg = JSON.parse(await readFile(path.join(FIXTURES, "hooks", "codex-work-leg.json"), "utf8")) as { calls: Array<{ id: string; command: string }> };
    clock += 1000;
    const sentAt = clock;
    await send("UserPromptSubmit", { turn_id: "t1", model: "gpt", prompt: "Raise the growth rate and report" });
    for (const [i, c] of leg.calls.entries()) {
      const command = c.command.replaceAll("{FOLDER}", folder);
      clock += 1000;
      await send("PreToolUse", { tool_name: "Bash", tool_use_id: c.id, tool_input: { command }, cwd: ws });
      if (i === 8) await copyFile(probe(1), path.join(ws, "outputs", "casebook.xlsx"));
      clock += 1000;
      await send("PostToolUse", { tool_name: "Bash", tool_use_id: c.id, tool_input: { command }, cwd: ws });
    }
    clock += 1000;
    const stop = await send("Stop", {});
    const ledger = openLedger(home);
    try {
      const taskId = stop.summary!.taskId;
      const ops = ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>);
      const stamp = { ...ops.find((a) => a.hookEvent === "UserPromptSubmit")!.requests[0] };
      // the first step is told by a RequestFirstStep op once it exists.
      const told = ops.find((a) => a.hookEvent === "RequestFirstStep")?.requests.find((q: any) => q.seq === stamp.seq);
      if (stamp.firstStep === null && told) stamp.firstStep = told.firstStep;
      const callSeqs = ops.filter((a) => a.tool_use_id !== undefined).map((a) => a.startSeq as number);
      assert.equal(callSeqs.length, leg.calls.length);
      assert.ok(stamp.seq < Math.min(...callSeqs), "before every call of the leg");
      assert.equal(stamp.at, sentAt);
      const steps = ledger.stepsForTask(taskId);
      assert.equal(steps.length, 3, "the folder's baseline, the outputs workbook's baseline at its first Pre, then the leg's change");
      assert.ok(stamp.firstStep !== steps[0]!.id && stamp.firstStep !== steps[1]!.id, "never a baseline copy");
      assert.equal(stamp.firstStep, steps[2]!.id);
    } finally {
      ledger.close();
    }
  });
});
