import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { trackedClaims } from "./helpers/claims.ts";

// Codex refused its first exec_command by policy. The rejection text names no command, so the
// Exact-command match never fired: the call stayed open, every later change was credited jointly to it, and at Stop it was stored OK.
// Rule bound: a rejection without a command settles the one open shell call of its thread that began before it. Two such candidates
// (a call still running beside the refused one) leave both open. A call with a Pre and no Post at Stop is stored as not run, never OK.

const SESSION = "01a173bf-f72a-77f1-87ec-82e7276d1799";
// The rollout line text of a refused Windows command (no command in it).
const W_X4_TEXT = 'exec_command failed: CreateProcess { message: "Rejected(\\"approval required by policy, but AskForApproval::Granular.sandbox_approval is false\\")" }';
const SCRIPT = "Rename-Item t05\\a.txt b.txt; Remove-Item t05\\delete-me.txt; Move-Item t05\\sub\\nested.txt t05\\nested.txt";

describe("a call the host refused before running closes as not run", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const rejection = (ts: number, text = W_X4_TEXT): string =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_x", output: [{ type: "input_text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" }, { type: "input_text", text: "Script error:\n" + text }] } });

  async function rig() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
    dirs.push(root);
    const home = path.join(root, "home"), folder = path.join(root, "work"), sessions = path.join(root, "sessions");
    for (const d of [home, folder, sessions]) await mkdir(d);
    let clock = new Date(2026, 10, 3, 0, 0, 0).getTime();
    let step = 1000;
    const day = path.join(sessions, "2026", "11", "03");
    mkdirSync(day, { recursive: true });
    const rollout = path.join(day, `rollout-2026-11-03T00-00-00-${SESSION}.jsonl`);
    writeFileSync(rollout, "");
    const hook = (o: Record<string, unknown>) =>
      handleHook({ session_id: SESSION, cwd: folder, model: "gpt-6.1-sol", permission_mode: "bypassPermissions", ...o } as unknown as HookPayload, { host: "codex", home, claimed: trackedClaims, folder, perSession: false, now: () => (clock += step), sessionsDir: sessions });
    const pre = (id: string, command: string) => hook({ hook_event_name: "PreToolUse", tool_use_id: id, tool_name: "Bash", tool_input: { command } });
    const post = (id: string, command: string) => hook({ hook_event_name: "PostToolUse", tool_use_id: id, tool_name: "Bash", tool_input: { command }, tool_response: "" });
    const stop = () => hook({ hook_event_name: "Stop", last_assistant_message: "done" });
    const note = (line: string) => appendFile(rollout, line + "\n");
    const state = () => {
      const l = openLedger(home);
      try {
        return {
          credited: l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null).map((s) => s.credited),
          closedBy: Object.fromEntries(l.sessionOpRows(SESSION).filter((o) => o.toolUseId !== undefined).map((o) => [o.toolUseId!, o.closedBy])),
        };
      } finally {
        l.close();
      }
    };
    const results = () => {
      const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
      try {
        const out: Record<string, string> = {};
        for (const r of db.prepare("SELECT result_code, args_json FROM ops WHERE tool != 'hook' ORDER BY id").all() as Array<{ result_code: string; args_json: string }>) {
          const id = JSON.parse(r.args_json).tool_use_id;
          if (typeof id === "string") out[id] ??= r.result_code;
        }
        return out;
      } finally {
        db.close();
      }
    };
    await writeFile(path.join(folder, "a.txt"), "seed\n");
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Rename, delete, move" });
    return { setStep: (n: number) => (step = n), folder, pre, post, stop, note, state, results, now: () => clock, write: (t: string) => writeFile(path.join(folder, "a.txt"), t) };
  }

  it("refused-script sequence: the rejected script closes as not run; the next call is credited alone", async () => {
    const r = await rig();
    await r.pre("exec-X", SCRIPT);
    await r.note(rejection(r.now()));
    await r.pre("exec-Y", "Add-Content a.txt 'more'");
    await r.write("seed\nmore\n");
    await r.post("exec-Y", "Add-Content a.txt 'more'");
    await r.stop();
    const s = r.state();
    assert.ok(s.credited.length > 0, "a.txt changed");
    assert.ok(s.credited.every((c) => c.length === 1 && c[0] === "exec-Y"), JSON.stringify(s.credited));
    assert.equal(s.closedBy["exec-X"], "refused");
    assert.equal(r.results()["exec-X"], "TOOL_NOT_RUN");
    assert.equal(r.results()["exec-Y"], "OK");
  });

  it("a call with a Pre and no Post at Stop is stored as not run, never OK", async () => {
    const r = await rig();
    await r.pre("exec-Z", "Get-Content a.txt");
    await r.stop();
    assert.equal(r.state().closedBy["exec-Z"], "stop");
    assert.equal(r.results()["exec-Z"], "TOOL_NOT_RUN");
  });

  it("must not: a long call still running keeps its credit while another call starts and closes", async () => {
    const r = await rig();
    await r.pre("exec-A", "python build_workbook.py");
    await r.pre("exec-B", "Get-Date");
    await r.write("seed\nbuilt\n");
    await r.post("exec-B", "Get-Date");
    await r.write("seed\nbuilt\nmore\n");
    await r.post("exec-A", "python build_workbook.py");
    const s = r.state();
    assert.ok(s.credited.some((c) => c.includes("exec-A")), `A kept a credit: ${JSON.stringify(s.credited)}`);
    assert.equal(s.closedBy["exec-A"], "post");
    assert.equal(r.results()["exec-A"], "OK");
  });

  it("must not: a rejection with two candidate calls open settles neither (the running one is not guessed)", async () => {
    const r = await rig();
    await r.pre("exec-A", "python build_workbook.py");
    await r.pre("exec-B", SCRIPT);
    await r.note(rejection(r.now()));
    await r.pre("exec-C", "Get-Date");
    await r.post("exec-C", "Get-Date");
    await r.post("exec-A", "python build_workbook.py");
    const s = r.state();
    assert.equal(s.closedBy["exec-A"], "post");
    assert.notEqual(s.closedBy["exec-B"], "refused");
  });

  it("must not: a rejection from before the open call began settles nothing", async () => {
    const r = await rig();
    await r.note(rejection(r.now() - 60_000));
    await r.pre("exec-A", "python build_workbook.py");
    await r.pre("exec-C", "Get-Date");
    await r.post("exec-C", "Get-Date");
    await r.post("exec-A", "python build_workbook.py");
    assert.equal(r.state().closedBy["exec-A"], "post");
    assert.equal(r.results()["exec-A"], "OK");
  });

  it("no slack: a rejection up to 1 s before the call's Pre settles nothing (a bare rejection must come after the Pre)", async () => {
    const r = await rig();
    r.setStep(0); // the clock stands still, so the Pre's time is exactly now()
    await r.note(rejection(r.now() - 500));
    await r.pre("exec-A", "python build_workbook.py");
    await r.post("exec-A", "python build_workbook.py");
    assert.equal(r.state().closedBy["exec-A"], "post");
    assert.equal(r.results()["exec-A"], "OK");
  });

  it("pinned limit: a lone open long build and an unrelated bare rejection after its Pre close the build as refused", async () => {
    // Decision: with one open shell call the text cannot tell which call it refused, and a lone open call is the only
    // candidate. The refused call's own Pre always fired in the recorded case. If the refused call's Pre never fired, the build is closed
    // wrongly; it then takes no credit for writes after the rejection. This is the declared price of settling this case.
    const r = await rig();
    await r.pre("exec-A", "python build_workbook.py");
    await r.note(rejection(r.now()));
    await r.pre("exec-C", "Get-Date");
    await r.post("exec-C", "Get-Date");
    assert.equal(r.state().closedBy["exec-A"], "refused");
  });
});
