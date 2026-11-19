import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { book, makeRig, sessionFor, type Rig } from "./hook-corpus.ts";
import { newestEventAt, reconcileSession, sessionCoverageLines } from "../src/coverage.ts";
import { parkedOpsOf } from "../src/hook-adapter.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { journalDone, journalEvent, journalSessionKey, noteDegraded } from "../src/hook-journal.ts";
import { openLedger } from "../src/ledger.ts";

// per-session coverage. Everything runs in-process under a mkdtemp rig (home and folder); no real home, no host, no live service.
const SID = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11";
const rigs: Rig[] = [];
const extra: string[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of extra.splice(0)) await rm(d, { recursive: true, force: true });
});
const rig = async () => {
  const r = await makeRig();
  rigs.push(r);
  return r;
};
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), "cocheck-c001-"));
  extra.push(d);
  return d;
};
const use = (ids: string[]) => ({ type: "assistant", message: { content: ids.map((id) => ({ type: "tool_use", id, name: "Bash", input: {} })) } });
const transcript = (dir: string, ids: string[], sub: Record<string, string[]> = {}, sid = SID) =>
  (async () => {
    const file = path.join(dir, `${sid}.jsonl`);
    await writeFile(file, ids.length ? `${JSON.stringify(use(ids))}\n` : `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
    for (const [agent, agentIds] of Object.entries(sub)) {
      await mkdir(path.join(dir, sid, "subagents"), { recursive: true });
      await writeFile(path.join(dir, sid, "subagents", `agent-${agent}.jsonl`), `${JSON.stringify(use(agentIds))}\n`);
    }
    return file;
  })();

async function hook(r: Rig, payload: Record<string, unknown>, host = "claude", folder: string | null = r.folder, fault?: (step: string) => void) {
  const env = { COCHECK_HOME: r.home, HOME: r.home } as NodeJS.ProcessEnv;
  const argv = ["node", "hook.ts", "--host", host, ...(folder === null ? [] : ["--folder", folder])];
  return runHook({ argv, env, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })(), fault });
}

/** The corpus Claude session (ids call_1..call_3) plus an MCP call and a subagent call, all sent through the real hook entry. */
async function cleanSession(r: Rig, tpath: string, sid = SID) {
  const events = sessionFor("claude", r.folder).map((e) => e.payload);
  const stop = events.pop()!;
  const call = (name: string, id: string, tool: string, extraFields: Record<string, unknown> = {}) => ({ session_id: sid, cwd: r.folder, transcript_path: tpath, hook_event_name: name, tool_name: tool, tool_use_id: id, tool_input: { q: "x" }, ...extraFields });
  const more = [call("PreToolUse", "mcp_1", "mcp__docs__search"), call("PostToolUse", "mcp_1", "mcp__docs__search", { tool_response: {} }), call("PreToolUse", "sub_1", "Read", { agent_id: "a1" }), call("PostToolUse", "sub_1", "Read", { agent_id: "a1", tool_response: {} })];
  for (const [i, p] of [...events, ...more, stop].entries()) {
    if (i === events.length + more.length) await writeFile(path.join(r.folder, "model.xlsx"), book({ A1: 10, A2: 20, A3: 30 }));
    const run = await hook(r, { ...p, session_id: sid, transcript_path: tpath });
    assert.equal(run.exitCode, 0, run.stderr);
  }
}
const reconcile = (r: Rig, host = "claude", transcriptPath?: string, sid = SID) => {
  const ledger = openLedger(r.home);
  try {
    // What the hook entry passes at a Stop: the ops the adapter holds for a session that has no task yet.
    return reconcileSession({ home: r.home, ledger, host, sessionId: sid, transcriptPath, parkedOps: parkedOpsOf(r.home, host, r.folder, sid) });
  } finally {
    ledger.close();
  }
};
const rawEvent = (r: Rig, name: string, id: string, finish: boolean, tpath = "/x/t.jsonl") => {
  const bytes = Buffer.from(JSON.stringify({ session_id: SID, cwd: r.folder, transcript_path: tpath, hook_event_name: name, tool_name: "Bash", tool_use_id: id, tool_input: {} }));
  const ref = journalEvent(r.home, bytes, "claude", Date.now);
  if (finish) journalDone(ref, Date.now);
  return ref;
};

describe("session coverage", () => {
  it("3. a clean corpus session with a subagent call and an MCP call is complete, on the Stop's own reconciliation", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const ledger = openLedger(r.home);
    const row = ledger.sessionCoverage(SID);
    ledger.close();
    assert.ok(row, "the Stop wrote a coverage row");
    assert.deepEqual({ status: row.status, lost: row.lost, failed: row.failed, noEvent: row.noEvent, calls: row.calls }, { status: "complete", lost: 0, failed: 0, noEvent: 0, calls: 5 });
    assert.ok(row.ops >= 5 && row.events >= 10);
  });

  it("12. a second reconciliation of the same session changes nothing", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const a = reconcile(r, "claude", t);
    const b = reconcile(r, "claude", t);
    assert.deepEqual({ ...b, checkedAt: "" }, { ...a, checkedAt: "" });
    assert.equal(a.status, "complete");
  });

  it("1. a killed hook (an event with no done line) is lost and named; the session is lossy", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1", "call_k"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    rawEvent(r, "PostToolUse", "call_k", false, t);
    const row = reconcile(r, "claude", t);
    assert.equal(row.status, "lossy");
    assert.equal(row.lost, 1);
    assert.deepEqual(row.names.lost, ["PostToolUse call_k"]);
  });

  it("2. a failure marker is failed and named, and the session is lossy; a failure with no session id is counted as unattributed", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1", "call_f"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const fail = await hook(r, { session_id: SID, cwd: r.folder, transcript_path: t, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call_f", tool_input: {} }, "claude", null);
    assert.equal(fail.exitCode, 1);
    await hook(r, { hook_event_name: "Notification" }, "claude", null);
    const row = reconcile(r, "claude", t);
    assert.equal(row.status, "lossy");
    assert.deepEqual([row.failed, row.lost, row.names.failed], [1, 0, ["PostToolUse call_f"]]);
    assert.ok(row.unattributed >= 1);
  });

  it("5. an event that finished but left no op is lost", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1", "call_n"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    rawEvent(r, "PostToolUse", "call_n", true, t);
    const row = reconcile(r, "claude", t);
    assert.equal(row.status, "lossy");
    assert.deepEqual(row.names.lost, ["PostToolUse call_n"]);
  });

  it("4. a transcript call, subagent calls included, with no journal event is 'host sent no event'", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1", "call_denied"], { a1: ["sub_1", "sub_unseen"] });
    await cleanSession(r, t);
    const row = reconcile(r, "claude", t);
    assert.equal(row.status, "lossy");
    assert.deepEqual([row.noEvent, row.lost, row.failed], [2, 0, 0]);
    assert.deepEqual(row.names.noEvent, ["call_denied", "sub_unseen"]);
  });

  // Real line shape from a recorded run Claude transcript (assistant line, one tool_use with a "caller" field); the Skill call and
  // `cocheck track start` come before tracking began, so the host sends no event for them. Ids are the drive's own and sort AFTER "call_1".
  const driveLine = (id: string, name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { role: "assistant", type: "message", content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] } });
  const driveTranscript = async (dir: string, lines: Array<[string, string, Record<string, unknown>]>, sub: Record<string, string[]> = {}) => {
    const file = path.join(dir, `${SID}.jsonl`);
    await writeFile(file, lines.map(([id, name, input]) => JSON.stringify(driveLine(id, name, input))).join("\n") + "\n");
    for (const [agent, ids] of Object.entries(sub)) {
      await mkdir(path.join(dir, SID, "subagents"), { recursive: true });
      await writeFile(path.join(dir, SID, "subagents", `agent-${agent}.jsonl`), `${JSON.stringify(use(ids))}\n`);
    }
    return file;
  };
  const SKILL: [string, string, Record<string, unknown>] = ["toolu_01PTh9gDoaLZsBT2GeUm4B6s", "Skill", { skill: "cocheck", args: "start tracking" }];
  const START: [string, string, Record<string, unknown>] = ["toolu_01MeaL3xdd4yxu76epYUYnzb", "Bash", { command: "cocheck track start", description: "Start CoCheck tracking" }];
  const bash = (id: string): [string, string, Record<string, unknown>] => [id, "Bash", {}];

  it("the drive's shape (Skill call, track start, then normal calls) reads complete", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await driveTranscript(dir, [SKILL, START, bash("call_1"), bash("call_2"), bash("call_3"), bash("mcp_1")], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const row = reconcile(r, "claude", t);
    assert.deepEqual({ status: row.status, noEvent: row.noEvent, lost: row.lost, calls: row.calls }, { status: "complete", noEvent: 0, lost: 0, calls: 7 });
  });

  it("(guarded case): a call missing its event AFTER tracking started still makes the session lossy", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await driveTranscript(dir, [SKILL, START, bash("call_1"), bash("call_denied"), bash("call_2"), bash("call_3"), bash("mcp_1")], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const row = reconcile(r, "claude", t);
    assert.equal(row.status, "lossy");
    assert.deepEqual(row.names.noEvent, ["call_denied"]);
    assert.equal(row.noEvent, 1);
  });

  const direct = (r: Rig, t: string, parkedOps: Array<{ toolUseId?: string }>) => {
    const ledger = openLedger(r.home);
    try {
      return reconcileSession({ home: r.home, ledger, host: "claude", sessionId: SID, transcriptPath: t, parkedOps });
    } finally {
      ledger.close();
    }
  };

  it("(guarded case): main calls with no event and only a subagent call with one is lossy, all main calls named", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await driveTranscript(dir, [bash("m1"), bash("m2"), bash("m3")], { a1: ["sub_1"] });
    rawEvent(r, "PreToolUse", "sub_1", true);
    rawEvent(r, "PostToolUse", "sub_1", true);
    const row = direct(r, t, [{ toolUseId: "sub_1" }]);
    assert.equal(row.status, "lossy");
    assert.deepEqual(row.names.noEvent, ["m1", "m2", "m3"]);
  });

  it("a subagent file has its own cutoff, and one with no event counts all its calls", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await driveTranscript(dir, [SKILL, bash("m1")], { a1: ["s1", "s2"], a2: ["u1"] });
    rawEvent(r, "PreToolUse", "m1", true);
    rawEvent(r, "PostToolUse", "m1", true);
    rawEvent(r, "PreToolUse", "s2", true);
    rawEvent(r, "PostToolUse", "s2", true);
    const row = direct(r, t, [{ toolUseId: "m1" }, { toolUseId: "s2" }]);
    assert.equal(row.status, "lossy");
    assert.deepEqual(row.names.noEvent, ["u1"]);
  });

  it("transcript calls and no ledger ops with an empty journal stay 'not recorded'", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await driveTranscript(dir, [SKILL, START]);
    assert.equal(reconcile(r, "claude", t).status, "not recorded");
  });

  it("transcript calls and ledger ops but no call event at all is lossy (the answer for a ledger without call events)", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await driveTranscript(dir, [SKILL, START, bash("call_1")]);
    const row = direct(r, t, [{ toolUseId: "call_1" }]);
    assert.equal(row.status, "lossy");
    assert.equal(row.noEvent, 3);
  });

  it("15. tool calls in the transcript and an empty ledger is 'not recorded'; no calls and nothing recorded is complete with zero calls", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2"]);
    const row = reconcile(r, "claude", t);
    assert.equal(row.status, "not recorded");
    const quiet = await transcript(dir, [], {}, "quiet");
    const none = reconcile(r, "claude", quiet, "quiet");
    assert.deepEqual([none.status, none.calls, none.ops], ["complete", 0, 0]);
  });

  it("7. an op whose call is not in the transcript is 'unmatched', not lost, and does not block complete", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"]);
    await cleanSession(r, t); // sub_1 is in the ledger but not in this transcript
    const row = reconcile(r, "claude", t);
    assert.equal(row.status, "complete");
    assert.deepEqual(row.names.unmatched, ["sub_1"]);
  });

  it("10. a missing transcript, and a transcript that is a symlink, are 'not checked', never complete", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const missing = reconcile(r, "claude", path.join(dir, "nope.jsonl"));
    assert.equal(missing.status, "not checked");
    const { symlink } = await import("node:fs/promises");
    const link = path.join(dir, "link.jsonl");
    await symlink(t, link);
    assert.equal(reconcile(r, "claude", link).status, "not checked");
  });

  it("a Codex session reports 'not checked' even when its journal and ledger are clean", async () => {
    const r = await rig();
    for (const e of sessionFor("codex", r.folder)) {
      if (e.write) await writeFile(path.join(r.folder, "model.xlsx"), book(e.write));
      assert.equal((await hook(r, e.payload, "codex")).exitCode, 0);
    }
    const ledger = openLedger(r.home);
    const row = ledger.sessionCoverage(String(sessionFor("codex", r.folder)[0]!.payload.session_id));
    ledger.close();
    assert.equal(row?.status, "not checked");
    assert.equal(row?.calls, null);
  });

  it("17. a degraded journal is never complete", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    noteDegraded(r.home, "EACCES", Date.now, journalSessionKey(SID));
    assert.equal(reconcile(r, "claude", t).status, "lossy");
  });

  it("17b. a degraded write in session A makes A lossy; a clean session B that starts later is complete", async () => {
    const r = await rig();
    const dir = await tmp();
    const tA = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, tA);
    noteDegraded(r.home, "EACCES", Date.now, journalSessionKey(SID));
    const b = "22222222-3333-4444-8555-666666666666";
    await new Promise((res) => setTimeout(res, 5));
    const tB = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] }, b);
    await cleanSession(r, tB, b);
    assert.equal(reconcile(r, "claude", tA).status, "lossy");
    assert.equal(reconcile(r, "claude", tB, b).status, "complete");
    noteDegraded(r.home, "EIO", Date.now); // a failure whose bytes named no session: only sessions that began before it are hit
    // A session-less degradation flips an already-ended session B to lossy on its next reconcile: the accepted safe direction (it cannot be told apart from B).
    assert.equal(reconcile(r, "claude", tB, b).status, "lossy");
    const c = "33333333-4444-4555-8666-777777777777";
    await new Promise((res) => setTimeout(res, 5));
    await cleanSession(r, await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] }, c), c);
    assert.equal(reconcile(r, "claude", path.join(dir, `${c}.jsonl`), c).status, "complete");
  });

  it("18. S is complete at Stop#1; a Post is killed; Stop#2's reconcile throws: S ends not checked, never complete", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const ledger = openLedger(r.home);
    assert.equal(ledger.sessionCoverage(SID)?.status, "complete");
    ledger.close();
    await new Promise((res) => setTimeout(res, 5));
    rawEvent(r, "PostToolUse", "call_k", false, t);
    const stop = { session_id: SID, cwd: r.folder, transcript_path: t, hook_event_name: "Stop", last_assistant_message: "Done." };
    const run = await hook(r, stop, "claude", r.folder, (step) => { if (step === "reconcile") throw new Error("boom"); });
    assert.equal(run.exitCode, 0);
    assert.match(run.stderr, /coverage reconciliation failed/);
    const after = openLedger(r.home);
    const row = after.sessionCoverage(SID)!;
    after.close();
    assert.deepEqual([row.status, row.reason], ["not checked", "reconciliation failed"]);
  });

  it("18b. a row older than the session's newest journal event reads 'not checked (events since last check)' and shows when it was checked", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const row = reconcile(r, "claude", t);
    const rows = new Map([[SID, row]]);
    const fresh = sessionCoverageLines([SID], rows, new Map([[SID, newestEventAt(r.home, SID)]])).join("\n");
    assert.match(fresh, /session 7c1f0a52: complete .*checked \d{4}-/);
    await new Promise((res) => setTimeout(res, 5));
    rawEvent(r, "PostToolUse", "call_late", true, t);
    const stale = sessionCoverageLines([SID], rows, new Map([[SID, newestEventAt(r.home, SID)]])).join("\n");
    assert.match(stale, /not checked \(events since last check\)/);
    assert.doesNotMatch(stale, /: complete/);
  });

  it("17c. an old-format degraded line (iso and reason, no session) counts as session-less", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    await writeFile(path.join(r.home, "journal.degraded"), `${new Date(Date.now() + 1000).toISOString()} EACCES\n`);
    assert.equal(reconcile(r, "claude", t).status, "lossy");
  });

  it("13. two sessions in one folder are reconciled separately", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const other = "11111111-2222-4333-8444-555555555555";
    const t2 = await transcript(dir, ["other_1"], {}, other);
    assert.equal(reconcile(r, "claude", t).status, "complete");
    const row2 = reconcile(r, "claude", t2, other);
    assert.equal(row2.status, "not recorded", "no event or op belongs to it, whatever the folder shares");
  });

  it("sign-off lines carry the counts and name the missing calls", async () => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1", "call_denied"], { a1: ["sub_1"] });
    await cleanSession(r, t);
    const row = reconcile(r, "claude", t);
    const text = sessionCoverageLines([SID, "never-stopped"], new Map([[SID, row]])).join("\n");
    assert.match(text, /session 7c1f0a52: lossy .* 1 host sent no event; checked /);
    assert.match(text, /host sent no event: call_denied/);
    assert.match(text, /session never-st: not checked/);
  });
});

// A call the host refused as an unknown tool never ran, so the Pre that arrived for it is owed no Post and no op.
describe("a rejected unknown-tool call is not lost", () => {
  const refusal = (id: string, over: Record<string, unknown> = {}) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "<tool_use_error>Error: No such tool available: bash. Tool names are case-sensitive: call Bash instead.</tool_use_error>", ...over }] },
  });
  const withTranscript = async (extraLines: unknown[], sub = false) => {
    const r = await rig();
    const dir = await tmp();
    const t = await transcript(dir, ["call_1", "call_2", "call_3", "mcp_1", "call_bash"], { a1: ["sub_1"] });
    const lines = extraLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    if (sub) await writeFile(path.join(dir, SID, "subagents", "agent-a1.jsonl"), `${JSON.stringify(use(["sub_1"]))}\n${lines}`);
    else await writeFile(t, `${await readFile(t, "utf8")}${lines}`);
    await cleanSession(r, t);
    rawEvent(r, "PreToolUse", "call_bash", true, t);
    return reconcile(r, "claude", t);
  };

  it("the refused call's Pre, done and with no op, is not lost: in the main transcript or a helper's", async () => {
    for (const sub of [false, true]) {
      const row = await withTranscript([refusal("call_bash")], sub);
      assert.deepEqual([row.lost, row.names.lost, row.status], [0, [], "complete"], `sub=${sub}`);
    }
  });

  it("the same Pre with no refusal in the transcript is still lost", async () => {
    const row = await withTranscript([]);
    assert.deepEqual([row.lost, row.names.lost, row.status], [1, ["PreToolUse call_bash"], "lossy"]);
  });

  it("another error on that call, or the refusal words on a call that did not fail, do not excuse it", async () => {
    for (const line of [refusal("call_bash", { content: "Error: Permission denied" }), refusal("call_bash", { is_error: false }), refusal("call_bash", { content: "ls said: No such tool available: bash" })]) {
      const row = await withTranscript([line]);
      assert.equal(row.lost, 1);
    }
  });

  it("a refusal for one id excuses only that id", async () => {
    const row = await withTranscript([refusal("someone_else")]);
    assert.deepEqual(row.names.lost, ["PreToolUse call_bash"]);
  });
});
