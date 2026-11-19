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

// a prompt is written when it is submitted (once a task exists), so a live review page shows the request before the first call and before Stop.
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

describe("the request text is in the ledger from UserPromptSubmit", () => {
  it("a later round's request shows before its first call and before Stop", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    await t.stop("did one");
    await t.ask("two");
    assert.deepEqual(t.railHeads().map((h) => h.text), ["one", "two"]);
  });

  it("a prompt written at submit is not written again by the first call or by Stop", async () => {
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

  it("a chat-only turn is written once, at submit, and its reply still lands at Stop", async () => {
    const t = await setup();
    await t.ask("one");
    await t.call(1);
    await t.stop("did one");
    await t.ask("just a question");
    await t.stop("just an answer");
    assert.deepEqual(t.stored(), { one: 1, "just a question": 1 });
  });

  it("a tracked session's first prompt opens the task and writes the request (the hook gate keeps an untracked one out: hook-first-prompt)", async () => {
    const t = await setup();
    await t.ask("one");
    assert.deepEqual(t.stored(), { one: 1 });
    assert.deepEqual(t.railHeads().map((h) => h.text), ["one"]);
  });
});
