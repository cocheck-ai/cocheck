import { afterEach, describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";
import { workbookClaims } from "./helpers/claims.ts";

/**
 * the agent's own words on each call, and its closing claim, from the host's session file.
 *
 * Definition under test: narration is the agent's assistant text only, stored on the call and labelled as the agent's own
 * words; it never sets grouping or credit; a host or call without narration records "no narration recorded". Guard: narration never replaces, hides, merges or reorders a recorded row, and a missing, rotated, half-written or
 * reformatted file never blocks the hook. Fixtures under fixtures/narration/ are the probe run's own session
 * files, trimmed once by a one-off extractor (deleted); every user message, tool result, tool input and command output in them
 * is a sentinel, and the tests prove none of it reaches the ledger.
 */
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);
const NARR = path.join(FIXTURES, "narration");
const LABEL = "the agent's own words";
const NONE = "no narration recorded";
const SENTINELS = ["USER-TEXT-NEVER-READ", "TOOL-RESULT-NEVER-READ", "TOOL-INPUT-NEVER-READ", "THINKING-NEVER-READ"];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type Args = Record<string, any>;

async function setup(host: "claude" | "codex", extra: { outsideWatching?: boolean; withWorkbook?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  const sessions = path.join(root, "codex-sessions");
  await mkdir(folder, { recursive: true });
  await mkdir(home, { recursive: true });
  if (extra.withWorkbook !== false) await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 8, 12, 0, 0);
  const opts = { perSession: false, host, home, claimed: workbookClaims, folder, now: () => clock, sessionsDir: sessions, ...(extra.outsideWatching === undefined ? {} : { outsideWatching: extra.outsideWatching }) };
  const send = (over: Record<string, unknown>, session = "sess-1") => {
    clock += 1000;
    return handleHook({ session_id: session, cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const tick = () => (clock += 1000);
  let edits = 0;
  return {
    root,
    home,
    folder,
    sessions,
    send,
    tick,
    /** A tool call: Pre, an optional workbook change, Post. */
    async call(id: string, file: string | undefined, over: Record<string, unknown> = {}, snapshot?: number, session = "sess-1") {
      const base = { tool_name: "Bash", tool_use_id: id, tool_input: { command: "python3 edit.py", description: `step ${++edits}` }, ...(file === undefined ? {} : { transcript_path: file }), ...over };
      await send({ hook_event_name: "PreToolUse", ...base }, session);
      if (snapshot !== undefined) await copyFile(probe(snapshot), path.join(folder, "casebook.xlsx"));
      await send({ hook_event_name: "PostToolUse", ...base }, session);
    },
    ops(): Args[] {
      const ledger = openLedger(home);
      try {
        return ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Args));
      } finally {
        ledger.close();
      }
    },
    rawLedgerText(): string {
      const ledger = openLedger(home);
      try {
        return ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => o.argsJson)).join("\n");
      } finally {
        ledger.close();
      }
    },
    taskIds(): number[] {
      const ledger = openLedger(home);
      try {
        return ledger.allTaskIds();
      } finally {
        ledger.close();
      }
    },
    async state(): Promise<Args> {
      const hooks = path.join(home, "hooks");
      const [dir] = await readdir(hooks);
      return JSON.parse(await readFile(path.join(hooks, dir!, "state.json"), "utf8")) as Args;
    },
  };
}

// ---- Claude Code transcript lines -------------------------------------------------------------------------------------
const j = (o: unknown) => `${JSON.stringify(o)}\n`;
const asst = (msg: string, ...blocks: unknown[]) => j({ type: "assistant", uuid: `u-${Math.random()}`, isSidechain: false, requestId: `r-${msg}`, message: { id: msg, role: "assistant", content: blocks } });
const say = (text: string) => ({ type: "text", text });
const use = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { sentinel: "TOOL-INPUT-NEVER-READ" } });
const think = () => ({ type: "thinking", thinking: "THINKING-NEVER-READ" });
const result = (id: string) => j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "TOOL-RESULT-NEVER-READ" }] } });
const userAsk = (text = "USER-TEXT-NEVER-READ") => j({ type: "user", message: { role: "user", content: text } });
const narrationOf = (ops: Args[], id: string) => ops.filter((o) => o.tool_use_id === id).map((o) => o.narration);
const closings = (ops: Args[]) => ops.filter((o) => o.hookEvent === "Stop").map((o) => o.closing);

describe("Claude Code: the agent's words on a call", () => {
  it("a call carries the text written since the previous tool_use, labelled as the agent's own words", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, userAsk() + asst("m1", think(), say("First I will patch the sheet."), use("T1")) + result("T1") + asst("m2", say("Now checking the result."), use("T2")));
    await t.call("T1", file, {}, 1);
    await t.call("T2", file);
    const ops = t.ops();
    assert.deepEqual(narrationOf(ops, "T1")[0], { source: "agent", label: LABEL, text: "First I will patch the sheet." });
    assert.deepEqual(narrationOf(ops, "T2")[0], { source: "agent", label: LABEL, text: "Now checking the result." });
  });

  it("text before an earlier tool_use does not stick to the next call", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("ONLY-FOR-T1"), use("T1")) + result("T1") + asst("m2", use("T2")));
    await t.call("T1", file);
    await t.call("T2", file);
    const ops = t.ops();
    assert.equal(narrationOf(ops, "T1")[0].text, "ONLY-FOR-T1");
    assert.deepEqual(narrationOf(ops, "T2")[0], { source: "none", text: NONE });
  });

  it("two text lines before one tool_use are both the call's words, in order", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("Part one.")) + asst("m1", say("Part two."), use("T1")));
    await t.call("T1", file);
    assert.equal(narrationOf(t.ops(), "T1")[0].text, "Part one.\n\nPart two.");
  });

  it("parallel calls in one message: the first holds the text, the rest point to it", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    // Each content block is its own line, all with the same message id, as Claude Code writes them.
    await writeFile(file, asst("mp", say("Running three checks at once.")) + asst("mp", use("P1")) + asst("mp", use("P2")) + asst("mp", use("P3")));
    await t.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "P1", tool_input: { command: "a" }, transcript_path: file });
    await t.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "P2", tool_input: { command: "b" }, transcript_path: file });
    await t.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "P3", tool_input: { command: "c" }, transcript_path: file });
    for (const id of ["P1", "P2", "P3"]) await t.send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command: "x" }, transcript_path: file });
    const ops = t.ops();
    assert.deepEqual(narrationOf(ops, "P1")[0], { source: "agent", label: LABEL, text: "Running three checks at once." });
    assert.deepEqual(narrationOf(ops, "P2")[0], { source: "agent", label: LABEL, sameAs: "P1" });
    assert.deepEqual(narrationOf(ops, "P3")[0], { source: "agent", label: LABEL, sameAs: "P1" });
  });

  it("parallel calls where the message had no text record no narration for any of them, never a pointer to nothing", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("mq", use("Q1")) + asst("mq", use("Q2")));
    await t.call("Q1", file);
    await t.call("Q2", file);
    const ops = t.ops();
    assert.deepEqual(narrationOf(ops, "Q1")[0], { source: "none", text: NONE });
    assert.deepEqual(narrationOf(ops, "Q2")[0], { source: "none", text: NONE });
  });

  it("a call whose tool_use line is written after its Pre still gets its words at Post", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("Late line.")));
    const base = { tool_name: "Bash", tool_use_id: "L1", tool_input: { command: "x" }, transcript_path: file };
    await t.send({ hook_event_name: "PreToolUse", ...base });
    await appendFile(file, asst("m1", use("L1")));
    await t.send({ hook_event_name: "PostToolUse", ...base });
    assert.equal(narrationOf(t.ops(), "L1")[0].text, "Late line.");
  });

  it("a call with no words, no transcript_path, or a path that does not exist records \"no narration recorded\", never empty text", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", use("N1")));
    await t.call("N1", file);
    await t.call("N2", undefined);
    await t.call("N3", path.join(t.root, "missing.jsonl"));
    await t.call("N4", "relative/t.jsonl");
    await t.call("N5", path.join(t.root, "notjsonl.txt"));
    const ops = t.ops();
    for (const id of ["N1", "N2", "N3", "N4", "N5"]) assert.deepEqual(narrationOf(ops, id)[0], { source: "none", text: NONE }, id);
    assert.ok(ops.filter((o) => o.tool_use_id).every((o) => typeof o.narration?.text !== "string" || o.narration.text !== ""), "no op holds empty text");
  });

  it("never reads tool results, user text, tool inputs or thinking: none of it reaches the ledger or the state", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(
      file,
      userAsk() + asst("m1", think(), say("Visible words."), use("S1")) + result("S1") + userAsk() +
        // A tool result that quotes an assistant line must not be mistaken for one.
        j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "S1", content: `{"type":"assistant","message":{"content":[{"type":"text","text":"TOOL-RESULT-NEVER-READ"}]}}` }] } }) +
        asst("m2", use("S2")),
    );
    await t.call("S1", file);
    await t.call("S2", file);
    const ledger = t.rawLedgerText();
    const state = JSON.stringify(await t.state());
    for (const s of SENTINELS) {
      assert.ok(!ledger.includes(s), `${s} reached the ledger`);
      assert.ok(!state.includes(s), `${s} reached the state`);
    }
    assert.equal(narrationOf(t.ops(), "S1")[0].text, "Visible words.");
    // The user's line between S1 and S2 started a new turn: S2 gets nothing, and S1's words do not carry over.
    assert.deepEqual(narrationOf(t.ops(), "S2")[0], { source: "none", text: NONE });
  });

  it("sidechain (subagent) lines are not the agent's narration", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, j({ type: "assistant", isSidechain: true, message: { id: "sc", role: "assistant", content: [say("SUBAGENT-WORDS"), use("SC1")] } }) + asst("m1", say("Main words."), use("M1")));
    await t.call("M1", file);
    await t.call("SC1", file);
    const ops = t.ops();
    assert.equal(narrationOf(ops, "M1")[0].text, "Main words.");
    assert.deepEqual(narrationOf(ops, "SC1")[0], { source: "none", text: NONE });
  });

  it("long words are cut and say so", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("x".repeat(5000)), use("B1")));
    await t.call("B1", file);
    const text: string = narrationOf(t.ops(), "B1")[0].text;
    assert.ok(text.length < 2100 && text.endsWith("... (5000 characters)"), text.slice(-40));
  });
});

describe("Claude Code: the read is bounded and never blocks the hook", () => {
  it("keeps a byte offset in state and reads only what was added", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("One."), use("O1")));
    await t.call("O1", file);
    const first = Buffer.byteLength(await readFile(file));
    assert.equal((await t.state()).narr["sess-1"].offset, first);
    await appendFile(file, result("O1") + asst("m2", say("Two."), use("O2")));
    await t.call("O2", file);
    const all = Buffer.byteLength(await readFile(file));
    const cursor = (await t.state()).narr["sess-1"];
    assert.equal(cursor.offset, all);
    assert.deepEqual(narrationOf(t.ops(), "O2")[0], { source: "agent", label: LABEL, text: "Two." });
    assert.equal(Object.keys(cursor.byId).length <= 64, true);
  });

  it("reads up to the last complete line: a half-written line waits for the next event", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    const whole = asst("m2", say("Second words."), use("H2"));
    const head = asst("m1", say("First words."), use("H1"));
    await writeFile(file, head + whole.slice(0, 40));
    await t.call("H1", file);
    assert.equal((await t.state()).narr["sess-1"].offset, Buffer.byteLength(head), "the offset stops at the last newline");
    assert.equal(narrationOf(t.ops(), "H1")[0].text, "First words.");
    await appendFile(file, whole.slice(40));
    await t.call("H2", file);
    assert.equal(narrationOf(t.ops(), "H2")[0].text, "Second words.");
  });

  it("a big file is not read from the start: the read is capped and the newest lines are what the call gets", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    const filler = result("F").repeat(Math.ceil((3 * 1024 * 1024) / Buffer.byteLength(result("F"))));
    await writeFile(file, asst("m0", say("OLD-WORDS"), use("F0")) + filler + asst("m1", say("Newest words."), use("G1")));
    const started = performance.now();
    await t.call("G1", file);
    const ms = performance.now() - started;
    assert.equal(narrationOf(t.ops(), "G1")[0].text, "Newest words.");
    assert.ok(!t.rawLedgerText().includes("OLD-WORDS"));
    assert.equal((await t.state()).narr["sess-1"].offset, Buffer.byteLength(await readFile(file)));
    assert.ok(ms < 3000, `the call took ${Math.round(ms)} ms with a 3 MB transcript`);
  });

  it("a single line longer than the read cap is stepped over, and the lines after it are read", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    const giant = j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "X", content: "TOOL-RESULT-NEVER-READ".repeat(40_000) }] } });
    assert.ok(Buffer.byteLength(giant) > 600_000);
    await writeFile(file, asst("m1", say("Before."), use("W1")) + giant);
    await t.call("W1", file); // the giant line is half-seen only if the read window ends inside it
    await appendFile(file, asst("m2", say("After the giant line."), use("W2")));
    await t.call("W2", file);
    assert.equal(narrationOf(t.ops(), "W2")[0].text, "After the giant line.");
  });

  it("a rotated or truncated file starts again from what is there", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("Before rotation."), use("R1")) + result("R1") + result("R1"));
    await t.call("R1", file);
    await writeFile(file, asst("m9", say("After rotation."), use("R2")));
    await t.call("R2", file);
    assert.equal(narrationOf(t.ops(), "R2")[0].text, "After rotation.");
    await truncate(file, 0);
    await t.call("R3", file);
    assert.deepEqual(narrationOf(t.ops(), "R3")[0], { source: "none", text: NONE });
  });

  it("a file deleted mid-run, garbage bytes, bad JSON, a reformatted file and a directory never throw and record no narration", async () => {
    const t = await setup("claude");
    const garbled = path.join(t.root, "g.jsonl");
    await writeFile(garbled, Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x01, 10]), Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"cut off\n'), Buffer.from("not json at all\n"), Buffer.from('{"type":"assistant","message":null}\n'), Buffer.from('{"type":"assistant","message":{"content":"a string"}}\n')]));
    const pretty = path.join(t.root, "p.jsonl");
    await writeFile(pretty, JSON.stringify({ type: "assistant", message: { id: "pm", content: [say("Pretty printed."), use("G2")] } }, null, 2) + "\n");
    const dir = path.join(t.root, "dir.jsonl");
    await mkdir(dir);
    const gone = path.join(t.root, "gone.jsonl");
    await writeFile(gone, asst("gm", say("Soon gone."), use("G4")));
    await t.call("G1", garbled);
    await t.call("G2", pretty);
    await t.call("G3", dir);
    await rm(gone);
    await t.call("G4", gone);
    const ops = t.ops();
    for (const id of ["G1", "G2", "G3", "G4"]) assert.deepEqual(narrationOf(ops, id)[0], { source: "none", text: NONE }, id);
    assert.equal(ops.filter((o) => o.closedBy === "post").length, 4, "every call still got its op");
  });

  it("a state written by an older version, or one holding a damaged cursor, is replaced, not trusted", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("Fine."), use("D1")));
    await t.call("D0", file);
    const hooks = path.join(t.home, "hooks");
    const [dir] = await readdir(hooks);
    const stateFile = path.join(hooks, dir!, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.narr["sess-1"] = { path: file, offset: "bad", pending: 7 };
    await writeFile(stateFile, JSON.stringify(state));
    await t.call("D1", file);
    assert.equal(narrationOf(t.ops(), "D1")[0].text, "Fine.");
  });
});

describe("Claude Code: the closing claim", () => {
  it("the agent's final message is captured at Stop as the round's closing claim", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, userAsk() + asst("m1", say("Patching."), use("C1")) + result("C1") + asst("m2", say("All done: B39 is now 0.043.")));
    await t.call("C1", file, {}, 1);
    const out = await t.send({ hook_event_name: "Stop", transcript_path: file });
    assert.ok(out.summary);
    assert.deepEqual(closings(t.ops()), [{ source: "agent", label: LABEL, text: "All done: B39 is now 0.043." }]);
  });

  it("the host's own last message wins when it sends one", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("Patching."), use("C1")) + asst("m2", say("From the file.")));
    await t.call("C1", file, {}, 1);
    await t.send({ hook_event_name: "Stop", transcript_path: file, last_assistant_message: "From the payload." });
    assert.deepEqual(closings(t.ops()), [{ source: "agent", label: LABEL, text: "From the payload." }]);
  });

  it("a round with no closing words, and a host with no file, records \"no narration recorded\"", async () => {
    const t = await setup("claude");
    await t.call("C1", undefined, {}, 1);
    await t.send({ hook_event_name: "Stop" });
    assert.deepEqual(closings(t.ops()), [{ source: "none", text: NONE }]);
  });

  it("one closing claim per round, and a claim is not repeated into the next round", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("Round one."), use("A1")) + asst("m2", say("Closing one.")));
    await t.call("A1", file, {}, 1);
    await t.send({ hook_event_name: "Stop", transcript_path: file });
    await appendFile(file, userAsk() + asst("m3", use("A2")));
    await t.call("A2", file, {}, 2);
    await t.send({ hook_event_name: "Stop", transcript_path: file });
    assert.deepEqual(closings(t.ops()), [
      { source: "agent", label: LABEL, text: "Closing one." },
      { source: "none", text: NONE },
    ]);
  });

  it("with outside watching off, narration and the closing claim name no path outside the task folder", async () => {
    const t = await setup("claude", { outsideWatching: false });
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say(`Copying to /somewhere/else/backup.xlsx and ~/Documents/x.xlsx, keeping ${t.folder}/casebook.xlsx.`), use("O1")));
    await t.call("O1", file);
    await t.send({ hook_event_name: "Stop", transcript_path: file, last_assistant_message: "Saved to /Users/someone/out.xlsx." });
    const ops = t.ops();
    assert.equal(narrationOf(ops, "O1")[0].text, `Copying to [outside path] and [outside path], keeping ${t.folder}/casebook.xlsx.`);
    assert.equal(closings(ops)[0].text, "Saved to [outside path].");
  });
});

describe("Codex: the agent's words from the session rollout", () => {
  const item = (type: string, rest: Record<string, unknown>) => j({ type: "event_msg", payload: { type: "item_completed", item: { type, ...rest } } });
  const agent = (text: string, phase = "commentary") => item("AgentMessage", { id: `a-${Math.random()}`, phase, content: [{ type: "output_text", text }] });
  const exec = (id: string) => item("CommandExecution", { id, command: ["/bin/zsh"], stdout: "TOOL-RESULT-NEVER-READ", aggregated_output: "TOOL-RESULT-NEVER-READ" });
  const started = () => j({ type: "event_msg", payload: { type: "task_started", turn_id: "t" } });
  const userMsg = () => item("UserMessage", { id: "um", content: [{ type: "text", text: "USER-TEXT-NEVER-READ" }] });
  const toolCall = (callId: string) => j({ type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name: "exec", input: "TOOL-INPUT-NEVER-READ" } });

  it("joins the ledger's exec- id to its CommandExecution item and takes the agent messages before it", async () => {
    const t = await setup("codex");
    const file = path.join(t.root, "rollout.jsonl");
    await writeFile(file, started() + userMsg() + agent("Checking the inputs first.") + toolCall("call_aaa") + exec("exec-1111") + agent("Now the edit.") + agent("Second thought.") + toolCall("call_bbb") + exec("exec-2222") + exec("exec-3333"));
    for (const id of ["exec-1111", "exec-2222", "exec-3333"]) await t.call(id, file);
    const ops = t.ops();
    assert.deepEqual(narrationOf(ops, "exec-1111")[0], { source: "agent", label: LABEL, text: "Checking the inputs first." });
    assert.deepEqual(narrationOf(ops, "exec-2222")[0], { source: "agent", label: LABEL, text: "Now the edit.\n\nSecond thought." });
    assert.deepEqual(narrationOf(ops, "exec-3333")[0], { source: "none", text: NONE });
  });

  it("the call_ id of the tool call is not the join: only the CommandExecution id is", async () => {
    const t = await setup("codex");
    const file = path.join(t.root, "rollout.jsonl");
    await writeFile(file, agent("Words.") + toolCall("exec-9999") + exec("exec-8888"));
    await t.call("exec-9999", file);
    await t.call("exec-8888", file);
    const ops = t.ops();
    assert.deepEqual(narrationOf(ops, "exec-9999")[0], { source: "none", text: NONE });
    assert.equal(narrationOf(ops, "exec-8888")[0].text, "Words.");
  });

  it("a final answer is the closing claim, not narration, and a new turn starts clean", async () => {
    const t = await setup("codex");
    const file = path.join(t.root, "rollout.jsonl");
    await writeFile(file, started() + userMsg() + agent("Working.") + exec("exec-1") + agent("Round one is finished.", "final_answer"));
    await t.call("exec-1", file, {}, 1);
    await t.send({ hook_event_name: "Stop", transcript_path: file });
    await appendFile(file, started() + userMsg() + exec("exec-2") + agent("Round two is finished.", "final_answer"));
    await t.call("exec-2", file, {}, 2);
    await t.send({ hook_event_name: "Stop", transcript_path: file });
    const ops = t.ops();
    assert.equal(narrationOf(ops, "exec-1")[0].text, "Working.");
    assert.deepEqual(narrationOf(ops, "exec-2")[0], { source: "none", text: NONE });
    assert.deepEqual(closings(ops), [
      { source: "agent", label: LABEL, text: "Round one is finished." },
      { source: "agent", label: LABEL, text: "Round two is finished." },
    ]);
  });

  it("finds the rollout under the sessions folder by session id when the payload names no path", async () => {
    const t = await setup("codex");
    const day = new Date(Date.UTC(2026, 9, 8, 13, 0, 1));
    const dir = path.join(t.sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "rollout-2026-10-08T09-00-00-0000aaaa-1111-2222-3333-444455556666.jsonl"), agent("WRONG-SESSION") + exec("exec-5"));
    await writeFile(path.join(dir, "rollout-2026-10-08T09-00-00-01a11e0a-bfd8-7050-96c4-abb9e142ff05.jsonl"), agent("Found by session id.") + exec("exec-5"));
    await t.call("exec-5", undefined, {}, undefined, "01a11e0a-bfd8-7050-96c4-abb9e142ff05");
    assert.equal(narrationOf(t.ops(), "exec-5")[0].text, "Found by session id.");
  });

  it("never reads user messages, command output or tool inputs; a missing or garbled rollout records no narration and never throws", async () => {
    const t = await setup("codex");
    const file = path.join(t.root, "rollout.jsonl");
    await writeFile(file, userMsg() + toolCall("call_x") + exec("exec-7") + "garbage {{{\n" + '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage"');
    await t.call("exec-7", file);
    await t.call("exec-8", path.join(t.root, "missing.jsonl"));
    await t.call("exec-9", undefined);
    const ops = t.ops();
    for (const id of ["exec-7", "exec-8", "exec-9"]) assert.deepEqual(narrationOf(ops, id)[0], { source: "none", text: NONE }, id);
    const ledger = t.rawLedgerText();
    for (const s of SENTINELS) assert.ok(!ledger.includes(s), s);
  });
});

// ---- the legs replayed -----------------------------------------------------------------------------------------
async function lines(file: string): Promise<string[]> {
  return (await readFile(file, "utf8")).split("\n").filter((l) => l !== "");
}

describe("real use: the legs replayed against their own session files", () => {
  it("Codex: the 26 exec- ids join to their CommandExecution items; 8 calls carry commentary, every round has its closing claim", async () => {
    const rollout = await lines(path.join(NARR, "codex-rollout.jsonl"));
    const t = await setup("codex");
    const live = path.join(t.root, "rollout.jsonl");
    await writeFile(live, "");
    const sessionId = "01a11e0a-bfd8-7050-96c4-abb9e142ff05";
    const finals: string[] = [];
    const commentary: string[] = [];
    let written = 0;
    const growTo = async (n: number) => {
      if (n > written) await appendFile(live, rollout.slice(written, n).join("\n") + "\n");
      written = Math.max(written, n);
    };
    let calls = 0;
    let callsThisRound = 0;
    const roundCalls: number[] = [];
    for (let i = 0; i < rollout.length; i++) {
      const d = JSON.parse(rollout[i]!);
      const it = d.payload?.item;
      if (it?.type === "AgentMessage") (it.phase === "final_answer" ? finals : commentary).push(it.content[0].text);
      if (it?.type === "CommandExecution") {
        // The hook's Pre runs before the item is written, its Post after.
        await t.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: it.id, tool_input: { command: "python3 x.py" }, transcript_path: live }, sessionId);
        await growTo(i + 1);
        await t.send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: it.id, tool_input: { command: "python3 x.py" }, transcript_path: live }, sessionId);
        calls++;
        callsThisRound++;
      } else if (d.payload?.type === "task_complete") {
        roundCalls.push(callsThisRound);
        callsThisRound = 0;
        await growTo(i + 1);
        await t.send({ hook_event_name: "Stop", transcript_path: live }, sessionId);
      }
    }
    assert.equal(calls, 26, "every exec- id of the run joined to one CommandExecution item");
    assert.equal(finals.length + commentary.length, 13, "13 agent messages in the rollout");
    const ops = t.ops();
    const withWords = ops.filter((o) => o.tool_use_id && o.narration?.source === "agent");
    assert.equal(withWords.length, 8);
    assert.deepEqual(withWords.map((o) => o.narration.text).sort(), [...commentary].sort(), "all 8 commentary messages are on calls, verbatim");
    assert.equal(ops.filter((o) => o.tool_use_id && o.narration?.source === "none").length, 18);
    // A round with no calls existed only as an empty cut before (no ops, no rows): the claim does not give it one.
    assert.equal(roundCalls.length, 5);
    assert.equal(roundCalls.filter((n) => n === 0).length, 1, "one round of the rollout had no calls");
    assert.deepEqual(closings(ops).map((c) => c.text), finals.filter((_, i) => roundCalls[i] !== 0), "one closing claim per round that has calls, in order");
    assert.equal(closings(ops).length, 4);
    for (const s of SENTINELS) assert.ok(!t.rawLedgerText().includes(s), s);
  });

  it("Claude Code: 15 text lines are on calls (19 calls carry narration, 4 by pointer), 3 are closing claims, one per round", async () => {
    const transcript = await lines(path.join(NARR, "claude-transcript.jsonl"));
    const ev = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "replay-claude-casebook", "events.json"), "utf8")) as { session: string; events: Array<{ at: number; type: string; id?: string; tool?: string; input?: unknown }> };
    const t = await setup("claude");
    const live = path.join(t.root, "transcript.jsonl");
    await writeFile(live, "");
    const parsed = transcript.map((l) => JSON.parse(l));
    const useLine = (id: string) => parsed.findIndex((d) => d.type === "assistant" && d.message.content.some((b: any) => b.type === "tool_use" && b.id === id));
    // A turn's prompt is a user line that follows the previous turn's closing text (or opens the file); the one after a
    // tool_use is the host's own injection (the Skill call's text).
    let afterToolUse = false;
    const promptLines = parsed.flatMap((d, i) => {
      if (d.type === "assistant") afterToolUse = d.message.content.at(-1)?.type === "tool_use";
      return d.type === "user" && typeof d.message.content === "string" && !afterToolUse ? [i] : [];
    });
    assert.equal(promptLines.length, 3, "3 turns");
    let written = 0;
    const growTo = async (n: number) => {
      if (n > written) await appendFile(live, transcript.slice(written, n).join("\n") + "\n");
      written = Math.max(written, n);
    };
    let stops = 0;
    for (const e of ev.events) {
      if (e.type === "pre") {
        await growTo(useLine(e.id!) + 1);
        await t.send({ hook_event_name: "PreToolUse", tool_name: e.tool, tool_use_id: e.id, tool_input: { command: "x" }, transcript_path: live }, ev.session);
      } else if (e.type === "post") {
        await t.send({ hook_event_name: "PostToolUse", tool_name: e.tool, tool_use_id: e.id, tool_input: { command: "x" }, transcript_path: live }, ev.session);
      } else {
        stops++;
        await growTo(promptLines[stops] ?? transcript.length);
        await t.send({ hook_event_name: "Stop", transcript_path: live }, ev.session);
      }
    }
    assert.equal(stops, 3);
    const texts = parsed.filter((d) => d.type === "assistant").flatMap((d) => d.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text as string));
    assert.equal(texts.length, 18, "18 assistant text lines in the transcript");
    const ops = t.ops();
    const calls = ops.filter((o) => o.tool_use_id);
    const held = calls.filter((o) => o.narration?.text !== undefined && o.narration.source === "agent");
    const pointers = calls.filter((o) => o.narration?.sameAs !== undefined);
    assert.equal(held.length, 15);
    assert.equal(pointers.length, 4);
    assert.ok(pointers.every((p) => held.some((h) => h.tool_use_id === p.narration.sameAs)), "every pointer names a call that holds the text");
    const claims = closings(ops).map((c) => c.text);
    assert.equal(claims.length, 3);
    assert.deepEqual([...held.map((o) => o.narration.text), ...claims].sort(), [...texts].sort(), "15 on calls plus 3 closing claims are exactly the 18 text lines");
    for (const s of SENTINELS) assert.ok(!t.rawLedgerText().includes(s), s);
  });
});

// ---- must not ----------------------------------------------------------------------------------------------
describe("narration never replaces, hides, merges or reorders a recorded row", () => {
  /** A leg: sequential edits, a parallel pair, an unchanged call and a second round, with or without a transcript to read. */
  async function leg(withTranscript: boolean) {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(
      file,
      userAsk() + asst("m1", say("Round one edit."), use("E1")) + result("E1") + asst("m2", say("Two at once."), use("E2")) + asst("m2", use("E3")) + result("E2") + result("E3") + asst("m3", say("Looking."), use("E4")) + asst("m4", say("Done with round one.")) + userAsk() + asst("m5", say("Round two."), use("E5")),
    );
    const tp = withTranscript ? file : undefined;
    const base = (id: string) => ({ tool_name: "Bash", tool_use_id: id, tool_input: { command: `python3 ${id}.py`, description: `call ${id}` }, ...(tp ? { transcript_path: tp } : {}) });
    const pre = (id: string) => t.send({ hook_event_name: "PreToolUse", ...base(id) });
    const post = (id: string) => t.send({ hook_event_name: "PostToolUse", ...base(id) });
    const put = (n: number) => copyFile(probe(n), path.join(t.folder, "casebook.xlsx"));
    await pre("E1");
    await put(1);
    await post("E1");
    await pre("E2");
    await pre("E3");
    await put(2);
    await post("E2");
    await post("E3");
    await pre("E4");
    await post("E4");
    await t.send({ hook_event_name: "Stop", ...(tp ? { transcript_path: tp } : {}) });
    await pre("E5");
    await put(3);
    await post("E5");
    await t.send({ hook_event_name: "Stop", ...(tp ? { transcript_path: tp } : {}) });
    const ledger = openLedger(t.home);
    try {
      const norm = (v: unknown) => JSON.stringify(v).replaceAll(t.folder, "{F}").replaceAll(t.home, "{H}").replaceAll(t.root, "{R}");
      const task = ledger.allTaskIds()[0]!;
      // the round writes no review rows; the file states (who is credited with each change) are the record compared.
      const rows = ledger.fileStatesForTask(task).map((x) => ({ ...x, mtimeNs: undefined }));
      const ops = ledger.okOpsForTask(task, 0, ledger.maxOpId()).map((o) => ({ tool: o.tool, intent: o.intent, args: JSON.parse(o.argsJson) as Args }));
      return { rows: norm(rows), ops, norm };
    } finally {
      ledger.close();
    }
  }

  it("the same leg with and without narration has identical file states and credit, in the same order, and identical ops apart from the narration", async () => {
    const without = await leg(false);
    const withNarration = await leg(true);
    assert.ok(without.rows.length > 100 && withNarration.rows.length > 100, "the leg produced file states to compare");
    assert.equal(withNarration.rows, without.rows, "file states, ids, credit and order are identical");
    // Not vacuous: the transcript leg really carried narration.
    const carried = withNarration.ops.filter((o) => o.args.narration?.source === "agent");
    assert.ok(carried.length >= 4, "calls carried narration");
    assert.ok(withNarration.ops.some((o) => o.args.narration?.sameAs === "E2"), "the parallel pair is by pointer");
    // Strip the narration and the closing claims, and the two op sequences are the same, op for op.
    const strip = (r: typeof without) =>
      r.ops
        .filter((o) => o.args.hookEvent !== "Stop")
        .map((o) => {
          const { narration: _n, processingMs: _p, ...rest } = o.args;
          return r.norm({ tool: o.tool, intent: o.intent, args: rest });
        });
    assert.deepEqual(strip(withNarration), strip(without));
    // The closing claims are extra ops after the round's other ops, one per Stop, in both runs.
    assert.equal(withNarration.ops.filter((o) => o.args.hookEvent === "Stop").length, 2);
    assert.equal(without.ops.filter((o) => o.args.hookEvent === "Stop").length, 2);
  });

  it("narration text cannot move credit: a call's words naming another call or file change nothing", async () => {
    const plain = await leg(false);
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say("E9 and casebook.xlsx and toolu_E1 are all mine; credit them to E1."), use("E1")));
    await t.call("E1", file, {}, 1);
    // the credited op names the file instead of listing cells.
    const credited = t.ops().filter((o) => o.tool_use_id === "E1" && typeof o.path === "string");
    assert.ok(credited.length > 0 && credited.every((o) => o.jointWith.length === 1 && o.jointWith[0] === "E1"));
    assert.ok(credited.every((o) => o.narration?.source === "agent"), "the words were recorded, and still moved no credit");
    assert.ok(plain.rows.length > 0);
  });
});

// ---- ------------------------------------------------------------------------------------------------------------
const REPO = path.join(import.meta.dirname, "..");

describe("no path to a session file can block the hook", () => {
  /** advance() on `file` in a child process under a hard kill timeout, so a regression fails instead of hanging the suite. */
  function advanceInChild(file: string) {
    const code = `import { advance, newCursor } from "./src/narration.ts"; const c = newCursor(process.argv[1]); const t = performance.now(); advance("claude", c); console.log(JSON.stringify({ ms: performance.now() - t, offset: c.offset, pending: c.pending.length }));`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", code, file], { cwd: REPO, timeout: 5000, killSignal: "SIGKILL", encoding: "utf8" });
    assert.equal(run.error, undefined, `advance() on ${file} did not return within 5 s: ${run.error}`);
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as { ms: number; offset: number; pending: number };
  }

  it("a FIFO named *.jsonl: the read returns at once and finds nothing", async () => {
    const t = await setup("claude");
    const fifo = path.join(t.root, "pipe.jsonl");
    execFileSync("mkfifo", [fifo]);
    const r = advanceInChild(fifo);
    assert.ok(r.ms < 150, `took ${r.ms} ms`);
    assert.deepEqual([r.offset, r.pending], [0, 0]);
  });

  it("a payload whose transcript_path is a FIFO: the hook returns and records no narration", async () => {
    const t = await setup("claude");
    const fifo = path.join(t.root, "pipe.jsonl");
    execFileSync("mkfifo", [fifo]);
    // The hook runs in a child under a hard timeout: a hang in openSync cannot be interrupted from inside this process.
    const code = `import { handleHook } from "./src/hook-adapter.ts"; const [home, folder, fifo] = process.argv.slice(1); const opts = { perSession: false, host: "claude", home, folder, claimed: (f) => /\\.xls[xm]$/i.test(f) }; const base = { session_id: "s", cwd: folder, tool_name: "Bash", tool_use_id: "F1", tool_input: { command: "x" }, transcript_path: fifo }; const t = performance.now(); await handleHook({ ...base, hook_event_name: "PreToolUse" }, opts); await handleHook({ ...base, hook_event_name: "PostToolUse" }, opts); await handleHook({ session_id: "s", cwd: folder, hook_event_name: "Stop", transcript_path: fifo }, opts); console.log(performance.now() - t);`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", code, t.home, t.folder, fifo], { cwd: REPO, timeout: 20000, killSignal: "SIGKILL", encoding: "utf8" });
    assert.equal(run.error, undefined, `the hook did not return: ${run.error}`);
    assert.equal(run.status, 0, run.stderr);
    const ops = t.ops();
    assert.deepEqual(narrationOf(ops, "F1")[0], { source: "none", text: NONE });
    assert.deepEqual(closings(ops), [{ source: "none", text: NONE }]);
  });

  it("a directory, an unreadable file and a 200 MB single line each return within 150 ms with no narration recorded", async (ctx) => {
    const t = await setup("claude");
    const dir = path.join(t.root, "dir.jsonl");
    await mkdir(dir);
    const locked = path.join(t.root, "locked.jsonl");
    await writeFile(locked, asst("lm", say("Locked words."), use("U2")));
    await chmod(locked, 0o000);
    cleanups.unshift(() => chmod(locked, 0o600).catch(() => {}));
    const huge = path.join(t.root, "huge.jsonl");
    const chunk = Buffer.alloc(1024 * 1024, "a");
    await writeFile(huge, "");
    for (let i = 0; i < 200; i++) await appendFile(huge, chunk);
    const cases: Array<[string, string]> = [["U1", dir], ["U2", locked], ["U3", huge]];
    for (const [id, file] of cases) {
      if (file === locked && process.getuid?.() === 0) {
        ctx.diagnostic("running as root: the unreadable-file case is skipped");
        continue;
      }
      const r = advanceInChild(file);
      assert.ok(r.ms < 150, `${path.basename(file)} took ${r.ms} ms`);
      const started = performance.now();
      await t.call(id, file);
      assert.ok(performance.now() - started < 5000);
      assert.deepEqual(narrationOf(t.ops(), id)[0], { source: "none", text: NONE }, id);
    }
  });
});

describe("a Stop writes a closing claim only for a round that exists", () => {
  it("a lone Stop (a chat-only turn) logs its request and one claim; the round it cuts has no rows and the outbox is empty", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, userAsk() + asst("m1", say("Just chatting.")));
    await t.send({ hook_event_name: "UserPromptSubmit", prompt: "hello" });
    // (The Stop hook itself cuts an empty round in a watched folder, as it did before; the claim must not put a row in it.)
    const out = await t.send({ hook_event_name: "Stop", transcript_path: file, last_assistant_message: "Just chatting." });
    assert.deepEqual(out.summary?.rows, []);
    assert.equal(closings(t.ops()).length, 1);
    assert.deepEqual((await t.state()).outbox, []);
  });

  it("a Stop after sign-off opens nothing", async () => {
    const t = await setup("claude");
    await t.call("S1", undefined, {}, 1);
    await t.send({ hook_event_name: "Stop", last_assistant_message: "Done." });
    const [taskId] = t.taskIds();
    const l = openLedger(t.home);
    try {
      await signOffForTest(l, taskId!, "Dana");
    } finally {
      l.close();
    }
    const before = t.ops().length;
    await t.send({ hook_event_name: "Stop", last_assistant_message: "Anything else?" });
    assert.deepEqual(t.taskIds(), [taskId]);
    assert.equal(t.ops().length, before);
    assert.deepEqual((await t.state()).outbox, [], "no claim waits in the outbox to open a task later");
    assert.equal(closings(t.ops()).length, 1);
  });

  it("a Stop that cuts a real round still gets exactly one closing claim", async () => {
    const t = await setup("claude");
    await t.send({ hook_event_name: "UserPromptSubmit", prompt: "do it" });
    await t.call("R1", undefined, {}, 1);
    await t.send({ hook_event_name: "Stop", last_assistant_message: "Did it." });
    assert.deepEqual(closings(t.ops()), [{ source: "agent", label: LABEL, text: "Did it." }]);
  });

  it("a session that only chatted writes no claim of its own beside another session's round", async () => {
    const t = await setup("claude");
    await t.call("R1", undefined, {}, 1, "sess-a");
    await t.send({ hook_event_name: "Stop", last_assistant_message: "Round done." }, "sess-a");
    await t.send({ hook_event_name: "Stop", last_assistant_message: "Chat only." }, "sess-b");
    assert.deepEqual(closings(t.ops()).map((c) => c.text), ["Round done."]);
  });
});

describe("outside-watching-off redaction masks paths, not prose", () => {
  async function words(text: string): Promise<string> {
    const t = await setup("claude", { outsideWatching: false });
    const file = path.join(t.root, "t.jsonl");
    await writeFile(file, asst("m1", say(text), use("W1")));
    await t.call("W1", file);
    return narrationOf(t.ops(), "W1")[0].text as string;
  }
  const prose = ["It touched ~100 cells.", "Compare a / b and and/or km/h.", "Read https://example.com/a/b and http://host:8080/x/y?z=1 for details.", "Roughly 3/4 done, ~ half.", "Ratio is 1 / 2."];
  for (const text of prose) {
    it(`leaves prose intact: ${text}`, async () => {
      assert.equal(await words(text), text);
    });
  }
  it("still masks absolute and home paths, with trailing punctuation kept", async () => {
    assert.equal(await words("Wrote /tmp/out.xlsx, then ~/Desktop/x.csv; and ~root/.ssh/k."), "Wrote [outside path], then [outside path]; and [outside path].");
    assert.equal(await words("(see /etc/hosts)"), "(see [outside path])");
  });
});

describe("a real user line ends the previous turn's pending words", () => {
  it("text from an interrupted turn does not become the next turn's first call's words", async () => {
    const t = await setup("claude");
    const file = path.join(t.root, "t.jsonl");
    // Turn 1 wrote text and was interrupted before any tool_use; turn 2's first call has no words of its own.
    await writeFile(file, userAsk("first ask") + asst("m1", say("INTERRUPTED-TURN-TEXT")) + userAsk("second ask") + asst("m2", use("N1")));
    await t.call("N1", file);
    assert.deepEqual(narrationOf(t.ops(), "N1")[0], { source: "none", text: NONE });
  });
});

describe("the Codex fallback matches the whole rollout name", () => {
  const item = (type: string, rest: Record<string, unknown>) => j({ type: "event_msg", payload: { type: "item_completed", item: { type, ...rest } } });
  const agent = (text: string) => item("AgentMessage", { id: `a-${Math.random()}`, phase: "commentary", content: [{ type: "output_text", text }] });
  const exec = (id: string) => item("CommandExecution", { id, command: ["/bin/zsh"] });
  const ID = "01a11e0a-bfd8-7050-96c4-abb9e142ff05";
  async function dayDir(t: Awaited<ReturnType<typeof setup>>) {
    const day = new Date(Date.UTC(2026, 9, 8, 13, 0, 1));
    const dir = path.join(t.sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    await mkdir(dir, { recursive: true });
    return dir;
  }
  it("a rollout whose name merely ends in the session id is not the session's file", async () => {
    const t = await setup("codex");
    const dir = await dayDir(t);
    await writeFile(path.join(dir, `rollout-2026-10-08T09-00-00-9999-${ID}.jsonl`), agent("LOOKALIKE") + exec("exec-9"));
    await writeFile(path.join(dir, `rollout-2026-10-08T09-00-00-x${ID}.jsonl`), agent("LOOKALIKE-2") + exec("exec-9"));
    await writeFile(path.join(dir, `notrollout-2026-10-08T09-00-00-${ID}.jsonl`), agent("LOOKALIKE-3") + exec("exec-9"));
    await t.call("exec-9", undefined, {}, undefined, ID);
    assert.deepEqual(narrationOf(t.ops(), "exec-9")[0], { source: "none", text: NONE });
  });
  it("the exact rollout-<timestamp>-<session>.jsonl name is found even with lookalikes beside it", async () => {
    const t = await setup("codex");
    const dir = await dayDir(t);
    await writeFile(path.join(dir, `rollout-2026-10-08T09-00-00-9999-${ID}.jsonl`), agent("LOOKALIKE") + exec("exec-9"));
    await writeFile(path.join(dir, `rollout-2026-10-08T09-00-00-${ID}.jsonl`), agent("The real one.") + exec("exec-9"));
    await t.call("exec-9", undefined, {}, undefined, ID);
    assert.equal(narrationOf(t.ops(), "exec-9")[0].text, "The real one.");
  });
  it("a session id that is not a full uuid finds nothing by name", async () => {
    const t = await setup("codex");
    const dir = await dayDir(t);
    await writeFile(path.join(dir, "rollout-2026-10-08T09-00-00-sess-1.jsonl"), agent("SHORT") + exec("exec-9"));
    await t.call("exec-9", undefined, {}, undefined, "sess-1");
    assert.deepEqual(narrationOf(t.ops(), "exec-9")[0], { source: "none", text: NONE });
  });
});
