import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { creditedOps } from "./helpers/credited-ops.ts";
import { opReason } from "../src/reason.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a row's reason is the host's per-call reason, else the call's narration (a host that marks it a reason source), else the
// turn's request, else the plain label. The Codex events and rollout are the real recording (codex-0.162.0-alpha.2).
const REC = path.join(import.meta.dirname, "fixtures", "hosts", "codex-0.162.0-alpha.2");
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const COMMENTARY_1 = "I’ll read `data.csv` to inspect its columns and values.";
const COMMENTARY_2 = "I’ll write `totals.csv` with the header `a,b,c` and column sums `12,15,18`.";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Recorded {
  event: string;
  stdin: Record<string, unknown>;
}
const recorded = async (): Promise<Recorded[]> =>
  (await readFile(path.join(REC, "payloads.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => {
    const d = JSON.parse(l) as { event: string; stdin: string };
    return { event: d.event, stdin: JSON.parse(d.stdin) as Record<string, unknown> };
  });
const rolloutLines = async (): Promise<Array<{ ordinal: number; line: string }>> => {
  const dir = path.join(REC, "sessions");
  const { readdir } = await import("node:fs/promises");
  const name = (await readdir(dir)).find((f) => f.endsWith(".jsonl"))!;
  return (await readFile(path.join(dir, name), "utf8")).split("\n").filter(Boolean).map((line) => ({ ordinal: (JSON.parse(line) as { ordinal: number }).ordinal, line }));
};

async function setup(outsideWatching = true) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-h003-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-h003-folder-")));
  const rollout = path.join(home, "rollout.jsonl");
  await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "codex" as const, home, claimed: workbookClaims, folder, outsideWatching };
  const send = (payload: Record<string, unknown>) => handleHook({ ...payload, transcript_path: rollout, cwd: folder } as HookPayload, opts);
  const claude = (payload: Record<string, unknown>) => handleHook({ transcript_path: "/x/t.jsonl", cwd: folder, ...payload } as HookPayload, { ...opts, host: "claude" });
  /** The rollout as the host had written it by `upTo` (an ordinal): lines past it are not there yet. */
  const rolloutUpTo = async (upTo: number, keep: (l: string) => boolean = () => true, edit: (l: string) => string = (l) => l) =>
    writeFile(rollout, `${(await rolloutLines()).filter((l) => l.ordinal <= upTo && keep(l.line)).map((l) => edit(l.line)).join("\n")}\n`);
  /**
   * Reasons by call id, as the review page words each op (opReason): the round writes no review rows, so the calls are those the
   * file states credit with the workbook's changes, each read from its own op.
   */
  const reasons = (taskId: number): Record<string, string[]> => {
    const ledger = openLedger(home);
    try {
      const out: Record<string, string[]> = {};
      const book = path.join(folder, "casebook.xlsx");
      for (const op of creditedOps(ledger, taskId, book)) {
        if (op.intent === "" || op.callId === undefined) continue;
        out[op.callId] = [...new Set([...(out[op.callId] ?? []), String(opReason(op, book).reason)])];
      }
      return out;
    } finally {
      ledger.close();
    }
  };
  return { folder, send, claude, rolloutUpTo, reasons };
}

/** Plays the recording: each call's Pre sees the rollout as written before the call, and moves the workbook before its Post. */
async function play(t: Awaited<ReturnType<typeof setup>>, opts: { keep?: (l: string) => boolean; edit?: (l: string) => string; prompt?: string | null; noItemsAtPost?: true } = {}) {
  const events = await recorded();
  const calls = events.filter((e) => e.event === "PreToolUse").map((e) => e.stdin.tool_use_id as string);
  // Rollout ordinals: Pre of call 1 comes after its commentary (11) and before its item (14); Post 1 after its output (16); Pre 2 after commentary 2 (18); Post 2 after all.
  const upTo: Record<string, number> = opts.noItemsAtPost ? { Pre0: 11, Post0: 11, Pre1: 18, Post1: 18 } : { Pre0: 11, Post0: 16, Pre1: 18, Post1: 99 };
  let n = 0;
  let taskId: number | undefined;
  for (const e of events) {
    if (e.event === "SessionStart" || e.event === "SessionEnd") continue;
    if (e.event === "UserPromptSubmit" && opts.prompt !== undefined) {
      if (opts.prompt === null) continue;
      e.stdin.prompt = opts.prompt;
    }
    const k = calls.indexOf(e.stdin.tool_use_id as string);
    if (e.event === "PreToolUse") await t.rolloutUpTo(upTo[`Pre${k}`]!, opts.keep, opts.edit);
    if (e.event === "PostToolUse") await t.rolloutUpTo(upTo[`Post${k}`]!, opts.keep, opts.edit);
    // the harness moves the workbook at every Pre, so the recorded read (`cat data.csv`, read-only, never credited with a write) is played as a call that touches the workbook
    const stdin = e.stdin.tool_use_id === calls[0] && typeof (e.stdin.tool_input as { command?: unknown } | undefined)?.command === "string" ? { ...e.stdin, tool_input: { ...(e.stdin.tool_input as object), command: `${(e.stdin.tool_input as { command: string }).command} && touch casebook.xlsx` } } : e.stdin;
    const r = await t.send(stdin);
    if (e.event === "PreToolUse") await copyFile(probe(++n), path.join(t.folder, "casebook.xlsx"));
    if (e.event === "Stop") taskId = r.summary?.taskId;
  }
  return { calls, taskId: taskId! };
}

describe("a call's reason from the host's narration or the turn's request", () => {
  it("Codex rows carry their commentary as the reason, read at the Pre", async () => {
    const t = await setup();
    const { calls, taskId } = await play(t);
    const r = t.reasons(taskId);
    assert.deepEqual(r[calls[0]!], [COMMENTARY_1]);
    assert.deepEqual(r[calls[1]!], [COMMENTARY_2]);
  });

  it("the Pre's reading is enough: a Post that sees no completed item changes nothing", async () => {
    const t = await setup();
    const { calls, taskId } = await play(t, { noItemsAtPost: true });
    const r = t.reasons(taskId);
    assert.deepEqual([r[calls[0]!], r[calls[1]!]], [[COMMENTARY_1], [COMMENTARY_2]]);
  });

  it("a Codex call with no commentary gets the user's request", async () => {
    const t = await setup();
    const { calls, taskId } = await play(t, { keep: (l) => !l.includes('"phase":"commentary"') && !/"type":"AgentMessage".*"phase":"commentary"/.test(l) });
    const prompt = (await recorded()).find((e) => e.event === "UserPromptSubmit")!.stdin.prompt as string;
    const r = t.reasons(taskId);
    assert.deepEqual(r[calls[0]!], [prompt]);
    assert.deepEqual(r[calls[1]!], [prompt]);
  });

  it("with neither commentary nor a request the plain label stays", async () => {
    const t = await setup();
    const { calls, taskId } = await play(t, { keep: (l) => !l.includes('"phase":"commentary"'), prompt: null });
    assert.deepEqual(t.reasons(taskId)[calls[0]!], ["Bash call on casebook.xlsx"]);
  });

  it("narration passes through the redaction before it is a reason", async () => {
    const t = await setup(false);
    const { calls, taskId } = await play(t, { edit: (l) => l.replaceAll("to inspect its columns", "from /etc/secret-dir/data.csv, to inspect its columns") });
    const r = t.reasons(taskId)[calls[0]!]!;
    assert.equal(r.length, 1);
    assert.ok(!r[0]!.includes("/etc/secret-dir"), r[0]);
    assert.match(r[0]!, /\[outside path\]/);
  });

  it("a call never takes another session's request", async () => {
    const t = await setup();
    await t.send({ session_id: "other-session", hook_event_name: "UserPromptSubmit", turn_id: "t9", model: "m", prompt: "OTHER-SESSION-REQUEST" });
    const { calls, taskId } = await play(t, { keep: (l) => !l.includes('"phase":"commentary"'), prompt: null });
    const all = JSON.stringify(t.reasons(taskId));
    assert.ok(!all.includes("OTHER-SESSION-REQUEST"));
    assert.deepEqual(t.reasons(taskId)[calls[0]!], ["Bash call on casebook.xlsx"]);
  });

  it("Claude rows keep their description, and a Claude call without one keeps its label whatever the turn's request or narration", async () => {
    const t = await setup();
    const s = "claude-s1";
    const c = (over: Record<string, unknown>) => t.claude({ session_id: s, ...over });
    await c({ hook_event_name: "UserPromptSubmit", prompt: "CLAUDE-TURN-REQUEST" });
    await c({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "python3 edit.py", description: "Raise the growth rate" } });
    await copyFile(probe(1), path.join(t.folder, "casebook.xlsx"));
    await c({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "python3 edit.py", description: "Raise the growth rate" } });
    await c({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c2", tool_input: { command: "python3 edit.py" } });
    await copyFile(probe(2), path.join(t.folder, "casebook.xlsx"));
    await c({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "c2", tool_input: { command: "python3 edit.py" } });
    const taskId = (await c({ hook_event_name: "Stop" })).summary!.taskId;
    const r = t.reasons(taskId);
    assert.deepEqual(r.c1, ["Raise the growth rate"]);
    assert.deepEqual(r.c2, ["Bash call on casebook.xlsx"]);
  });
});
