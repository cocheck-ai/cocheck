import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the user's request on every round, from the host's UserPromptSubmit hook. Payload shapes: Claude Code's is
// recorded (session_id, transcript_path, cwd, hook_event_name, prompt); Codex's is not, so it is assumed to carry `prompt` too.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(host: "claude" | "codex", outsideWatching = true) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const opts = { perSession: false, host, home, claimed: workbookClaims, folder, outsideWatching };
  const sendAs = (session: string, over: Record<string, unknown>) =>
    handleHook({ session_id: session, transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  const send = (over: Record<string, unknown>) => sendAs("s1", over);
  const promptAs = (session: string, text: unknown) => sendAs(session, { hook_event_name: "UserPromptSubmit", prompt: text });
  const prompt = (text: unknown) => send(host === "claude" ? { hook_event_name: "UserPromptSubmit", prompt: text } : { hook_event_name: "UserPromptSubmit", turn_id: "t1", model: "gpt", prompt: text });
  /** One tool call that moves the workbook to probe snapshot `n`. */
  let id = 0;
  const edit = async (n: number, session = "s1") => {
    const call = `c${++id}`;
    await sendAs(session, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: call, tool_input: { command: "python3 edit.py" } });
    await copyFile(probe(n), path.join(folder, "casebook.xlsx"));
    await sendAs(session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: call, tool_input: { command: "python3 edit.py" } });
  };
  const stop = async (session = "s1") => {
    const r = await sendAs(session, { hook_event_name: "Stop" });
    assert.ok(r.summary, "Stop returned a round summary");
    return r.summary.taskId;
  };
  /** A Stop that may cut no round: since a chat-only turn after a round cuts none, so there may be no summary. */
  const stopMaybe = async (session = "s1") => (await sendAs(session, { hook_event_name: "Stop" })).summary?.taskId;
  const page = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      const model = reviewModel(ledger, taskId);
      return { model, html: renderReviewPage(model) };
    } finally {
      ledger.close();
    }
  };
  /** Size of the adapter's saved state, and every prompt-bearing op the ledger holds for the task. */
  const stateBytes = async () => {
    const hooks = path.join(home, "hooks");
    let total = 0;
    for (const d of await readdir(hooks)) total += (await readFile(path.join(hooks, d, "state.json"))).length;
    return total;
  };
  const ledgerArgs = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      return ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => o.argsJson).join("\n");
    } finally {
      ledger.close();
    }
  };
  return { home, folder, prompt, promptAs, edit, stop, stopMaybe, page, send, stateBytes, ledgerArgs };
}

// these tests read the legacy page, which showed a request above the round's review rows. The round writes no row now, so the page
// has nothing to hang a request on. What stays is the hook's own record, the UserPromptSubmit op (text, order, cap, session), read here.
const promptOps = (home: string, taskId: number): Array<{ prompts: string[]; session_id: string }> => {
  const ledger = openLedger(home);
  try {
    return ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as { hookEvent?: string; prompts: string[]; session_id: string }).filter((a) => a.hookEvent === "UserPromptSubmit");
  } finally {
    ledger.close();
  }
};
const promptsOf = (home: string, taskId: number): string[] => promptOps(home, taskId).flatMap((a) => a.prompts);

for (const host of ["claude", "codex"] as const) {
  describe(`the request is recorded with the round`, () => {
    it("records the prompt the round opened with, once", async () => {
      const t = await setup(host);
      await t.prompt("Raise the discount rate to 9% and re-run the DCF");
      await t.edit(1);
      const taskId = await t.stop();
      assert.deepEqual(promptsOf(t.home, taskId), ["Raise the discount rate to 9% and re-run the DCF"]);
    });

    it("a payload with no prompt text is not captured", async () => {
      const t = await setup(host);
      await t.prompt(undefined);
      await t.prompt("   ");
      await t.edit(1);
      assert.deepEqual(promptsOf(t.home, await t.stop()), []);
    });

    it("a prompt after Stop is recorded after the earlier one, in order", async () => {
      const t = await setup(host);
      await t.prompt("ROUND-ONE-ASK");
      await t.edit(1);
      await t.stop();
      await t.prompt("ROUND-TWO-ASK");
      await t.edit(2);
      assert.deepEqual(promptsOf(t.home, await t.stop()), ["ROUND-ONE-ASK", "ROUND-TWO-ASK"]);
    });

    it("two prompts before any tool call: both are recorded, in order", async () => {
      const t = await setup(host);
      await t.prompt("FIRST-PROMPT-AAA");
      await t.prompt("SECOND-PROMPT-BBB");
      await t.edit(1);
      assert.deepEqual(promptsOf(t.home, await t.stop()), ["FIRST-PROMPT-AAA", "SECOND-PROMPT-BBB"]);
    });

    it("a very long prompt is cut: its head is kept and its tail is not", async () => {
      const t = await setup(host);
      await t.prompt(`HEAD-OF-PROMPT ${"x".repeat(200_000)} TAIL-OF-PROMPT`);
      await t.edit(1);
      const recorded = promptsOf(t.home, await t.stop());
      assert.equal(recorded.length, 1);
      assert.ok(recorded[0]!.includes("HEAD-OF-PROMPT") && !recorded[0]!.includes("TAIL-OF-PROMPT"));
    });
  });
}

describe("whose prompts are recorded", () => {
  it("300 prompt-only turns keep the state small;: each is written when submitted, once", async () => {
    const t = await setup("claude");
    for (let i = 0; i < 300; i++) await t.prompt(`P${String(i).padStart(3, "0")} ${"y".repeat(7000)}`);
    assert.ok((await t.stateBytes()) < 64 * 1024, "state stays under 64 KB");
    await t.edit(1);
    const taskId = await t.stop();
    const shown = promptsOf(t.home, taskId).map((x) => x.slice(0, 4));
    assert.equal(shown.length, 300, "every prompt was written at submit, none pushed out");
    assert.equal(new Set(shown).size, 300);
    assert.ok((await t.stateBytes()) < 64 * 1024);
  });

  it("a prompt-only turn closed by Stop is written once when submitted, not carried into the next round", async () => {
    const t = await setup("claude");
    for (let i = 0; i < 5; i++) {
      await t.prompt(`STALE-${i}`);
      await t.stopMaybe();
    }
    await t.edit(1);
    const taskId = await t.stop();
    for (let i = 0; i < 5; i++) assert.equal(t.ledgerArgs(taskId).split(`STALE-${i}`).length - 1, 1, `STALE-${i} written once`);
  });

  it("prompt, Esc (no Stop), prompt, call, Stop records both prompts in order", async () => {
    const t = await setup("claude");
    await t.prompt("BEFORE-ESC");
    await t.prompt("AFTER-ESC");
    await t.edit(1);
    assert.deepEqual(promptsOf(t.home, await t.stop()), ["BEFORE-ESC", "AFTER-ESC"]);
  });

  it("two sessions in one folder: the session that called has its prompt on record", async () => {
    const t = await setup("claude");
    await t.promptAs("s1", "S1-IDLE-ASK");
    await t.promptAs("s2", "S2-WORKING-ASK");
    await t.edit(1, "s2");
    const taskId = await t.stop("s2");
    assert.ok(promptsOf(t.home, taskId).includes("S2-WORKING-ASK"));
    // a tracked session's prompt is written when submitted; with one shared task (perSession off) the idle ask is on record too. In per-session tasks it is in its own task.
  });

  it("both sessions calling: each prompt is recorded under its own session", async () => {
    const t = await setup("claude");
    await t.promptAs("sess-aaaa1111", "ASK-ONE");
    await t.promptAs("sess-bbbb2222", "ASK-TWO");
    await t.edit(1, "sess-aaaa1111");
    await t.edit(2, "sess-bbbb2222");
    const ops = promptOps(t.home, await t.stop("sess-aaaa1111"));
    assert.deepEqual(ops.map((o) => [o.session_id, o.prompts]), [["sess-aaaa1111", ["ASK-ONE"]], ["sess-bbbb2222", ["ASK-TWO"]]]);
  });
});

describe("the request is stored as typed, and sessions are capped", () => {
  it("off: a prompt with an outside path is stored verbatim", async () => {
    const t = await setup("claude", false);
    const text = "Copy casebook.xlsx to /Users/someone/Desktop/secret-plan.xlsx. Then bump the rate.";
    await t.prompt(text);
    await t.edit(1);
    const taskId = await t.stop();
    assert.deepEqual(promptsOf(t.home, taskId), [text]);
    assert.ok(t.ledgerArgs(taskId).includes("secret-plan.xlsx"));
    assert.doesNotMatch(t.ledgerArgs(taskId), /\[outside path\]/);
  });

  it("300 sessions each submitting one 8000-char prompt and never stopping keep state under 256 KB", async () => {
    const t = await setup("claude");
    for (let i = 0; i < 300; i++) {
      await t.promptAs(`sess-${i}`, "z".repeat(8000));
      await t.edit(1, `sess-${i}`);
    }
    assert.ok((await t.stateBytes()) < 256 * 1024, "state stays under 256 KB");
  });
});
