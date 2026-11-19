import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildRuns } from "../src/timeline/runs.ts";
import { readRows, loadRows } from "../src/timeline/load.ts";
import { buildTimeline, type Timeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the prompt text reached the ledger only at Stop, so a page built mid-round showed an empty "Made request 1".
// The text is now written before the first step of its round. Guards against: a request written early must not be written
// again at Stop, whether it stands alone, is joined by a later prompt, or its session closes with the round.
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
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, perSession: false, now: () => clock };
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
  const requests = () =>
    read((l) => {
      const { ops, fileStates } = readRows(l, 1);
      return buildRuns(ops, fileStates).requests.map((r) => ({ text: r.texts[0], calls: r.calls.length }));
    });
  /** How many times each prompt text sits in the ledger's prompt ops. */
  const stored = (): Record<string, number> =>
    read((l) => {
      const out: Record<string, number> = {};
      for (const o of readRows(l, 1).ops) {
        const a = (o.args ?? JSON.parse(o.args_json ?? "{}")) as { hookEvent?: string; prompts?: string[] };
        if (a.hookEvent === "UserPromptSubmit") for (const p of a.prompts ?? []) out[p] = (out[p] ?? 0) + 1;
      }
      return out;
    });
  const railHeads = (): Array<{ title?: string; text?: string }> =>
    read((l) => {
      const tl = buildTimeline({ ...loadRows(l, 1, "test"), build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false }) as Timeline;
      return buildRailModel(tl).stops.filter((s) => s.request).map((s) => ({ title: s.title, text: s.request!.text }));
    });
  return { call, ask, stop, requests, stored, railHeads, send, folder, home, read };
}

describe("the request text is in the ledger before its round closes", () => {
  it("recorded shape: a page built after the first steps, before Stop, shows the request text", async () => {
    const t = await setup();
    await t.ask("make the total row");
    await t.call(1);
    assert.deepEqual(t.requests(), [{ text: "make the total row", calls: 1 }]);
    assert.deepEqual(t.railHeads(), [{ title: "Made request 1", text: "make the total row" }]);
  });

  it("the request is written once, mid-round and at Stop", async () => {
    const t = await setup();
    await t.ask("make the total row");
    await t.call(1);
    await t.call(2);
    await t.stop("Done.");
    assert.deepEqual(t.stored(), { "make the total row": 1 });
    assert.deepEqual(t.requests(), [{ text: "make the total row", calls: 2 }]);
  });

  it("a second prompt sent mid-round is written once too, and neither is repeated", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    await t.ask("two, sent while it works");
    await t.call(2);
    await t.stop("Done.");
    assert.deepEqual(t.stored(), { one: 1, "two, sent while it works": 1 });
    assert.deepEqual(t.requests().map((r) => r.text), ["one", "two, sent while it works"]);
  });

  it("a later round's request is not swallowed by an earlier early write", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    await t.stop("did one");
    await t.ask("two");
    await t.call(2);
    await t.stop("did two");
    assert.deepEqual(t.stored(), { one: 1, two: 1 });
    assert.deepEqual(t.requests().map((r) => r.text), ["one", "two"]);
  });

  it("a chat-only turn after an early-written round still logs once", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    await t.stop("did one");
    await t.ask("just a question");
    await t.stop("an answer");
    assert.deepEqual(t.stored(), { one: 1, "just a question": 1 });
    assert.deepEqual(t.requests().map((r) => r.text), ["one", "just a question"]);
  });
});

describe("the request is in the ledger before the first op of its round", () => {
  it("(a) ask, then a call that changes nothing: a page built before Stop shows the text", async () => {
    const t = await setup();
    await t.ask("look at the book");
    await t.call();
    assert.deepEqual(t.stored(), { "look at the book": 1 });
    assert.ok(!t.railHeads().some((h) => /not recorded/.test(h.text ?? "")));
    assert.deepEqual(t.requests().map((r) => r.text), ["look at the book"]);
  });

  it("(b) ask, then a call with a step: the text is there before Stop", async () => {
    const t = await setup();
    await t.ask("make the total row");
    await t.call(1);
    assert.deepEqual(t.railHeads(), [{ title: "Made request 1", text: "make the total row" }]);
  });

  it("(c) a call that starts (no Post yet) already has the text in the ledger", async () => {
    const t = await setup();
    await t.ask("slow job");
    await t.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "z1", tool_input: { command: "python3 slow.py" } });
    assert.deepEqual(t.stored(), { "slow job": 1 });
  });

  it("(c) a no-step round, a mid-round second prompt, then Stop: each prompt once", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call();
    await t.ask("two");
    await t.call(1);
    await t.stop("Done.");
    assert.deepEqual(t.stored(), { one: 1, two: 1 });
  });

  it("(c) a kill between the early write and Stop: the next round does not repeat it", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    // The Stop never arrives; the next turn starts.
    await t.ask("two");
    await t.call(2);
    await t.stop("did two");
    assert.deepEqual(t.stored(), { one: 1, two: 1 });
  });

  it("(c) two sessions in one folder: each prompt once", async () => {
    const t = await setup();
    await t.send({ hook_event_name: "UserPromptSubmit", prompt: "from s1" });
    await t.send({ hook_event_name: "UserPromptSubmit", prompt: "from s2", session_id: "s2" });
    await t.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "a1", tool_input: { command: "x" } });
    await t.send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "a1", tool_input: { command: "x" } });
    await t.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "y" }, session_id: "s2" });
    await t.send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "y" }, session_id: "s2" });
    await t.send({ hook_event_name: "Stop", last_assistant_message: "s1 done" });
    await t.send({ hook_event_name: "Stop", last_assistant_message: "s2 done", session_id: "s2" });
    assert.deepEqual(t.stored(), { "from s1": 1, "from s2": 1 });
  });

  it("`earlier` counts only prompts that never reached the ledger", async () => {
    const t = await setup();
    await t.ask("p1");
    await t.call();
    for (const p of ["p2", "p3", "p4", "p5"]) await t.ask(p);
    await t.call();
    await t.stop("Done.");
    const earlier = t.read((l) => readRows(l, 1).ops.flatMap((o) => {
      const a = (o.args ?? JSON.parse(o.args_json ?? "{}")) as { hookEvent?: string; earlier?: number };
      return a.hookEvent === "UserPromptSubmit" ? [a.earlier ?? 0] : [];
    }));
    // every prompt is written when it is submitted (a task is open), so none is pushed out unwritten: nothing is "earlier", and each is stored once.
    assert.equal(earlier.reduce((x, y) => x + y, 0), 0);
    assert.deepEqual(t.stored(), { p1: 1, p2: 1, p3: 1, p4: 1, p5: 1 });
  });
});

describe("a request with no recorded text says so", () => {
  const tl = (texts: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
    id: "r0", index: 0, session: "s", texts, at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: ["Request not captured."],
    runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "k1", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [], line: { text: "t", source: "agent-description", label: "l" }, agent: null }] }] }] } as unknown as Timeline);
  it("no text gives plain words, never an empty box", () => {
    const req = buildRailModel(tl([])).stops.find((s) => s.request)!;
    assert.match(req.request!.text, /not recorded/);
    assert.notEqual(req.request!.text.trim(), "");
  });
  it("a recorded text is shown as before", () => {
    const req = buildRailModel(tl([{ text: "Do it", source: "user", label: "x" }])).stops.find((s) => s.request)!;
    assert.equal(req.request!.text, "Do it");
  });
});
