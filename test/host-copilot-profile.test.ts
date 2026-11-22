import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleEvent } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { allProfiles, findProfile, profileOf } from "../src/hosts/index.ts";
import { runInstall, installStatus } from "../src/install.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the Copilot CLI profile. The events and the session file are the real 1.0.93 recording (platforms/copilot-cli/versions/1.0.93).
const REC = path.join(import.meta.dirname, "fixtures", "hosts", "copilot-1.0.93");
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const SESSION = "a192d0a1-4f6c-4619-a1fa-51d2fff6e1b0";
const CALL_1 = "call_vC1poWcr559xfqk6lqN1yyh3";
const CALL_2 = "call_vC5DbUzhHXUFFBxXla9ApsQQ";
const COMMENTARY_1 = "I’ll count the lines in `data.csv` with `wc -l data.csv`.";
const COMMENTARY_2 = "I’ll display the first two lines of `data.csv` with `head -n 2 data.csv`.";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const lines = async (file: string): Promise<Array<Record<string, any>>> => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const recorded = async (event: string) => lines(path.join(REC, "hook-payloads", `${event}.jsonl`));
/** The session file as the host had written it up to (and including) its `n`th line of the given types. */
async function sessionLines(): Promise<string[]> {
  return (await readFile(path.join(REC, "session-events.jsonl"), "utf8")).split("\n").filter(Boolean);
}

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-h007-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  const sessions = path.join(root, "session-state");
  await mkdir(home);
  await mkdir(folder);
  await mkdir(path.join(sessions, SESSION), { recursive: true });
  await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 18, 12, 0, 0);
  const opts = { perSession: false, host: "copilot" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000), sessionsDir: sessions };
  const send = (event: string, payload: Record<string, unknown>) => handleEvent(normalize("copilot", { ...payload, cwd: folder }, event), opts);
  const events = path.join(sessions, SESSION, "events.jsonl");
  /** Writes the first `n` lines of the recorded session file, as the host had written them by then. */
  const fileUpTo = async (type: string, nth: number) => {
    const all = await sessionLines();
    let seen = 0;
    const cut = all.findIndex((l) => new RegExp(`"type":"${type.replace(/\./g, "\\.")}"`).test(l) && ++seen === nth);
    await writeFile(events, all.slice(0, cut + 1).join("\n") + "\n");
  };
  const ops = (): Array<Record<string, any>> => {
    const ledger = openLedger(home);
    try {
      return ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>));
    } finally {
      ledger.close();
    }
  };
  return { root, home, folder, sessions, events, send, fileUpTo, ops };
}

describe("the Copilot profile replays the 1.0.93 recording", () => {
  it("two rows with their intentionSummary as reason and the commentary as narration, Pre and Post joined, the prompt recorded", async () => {
    const t = await setup();
    const [prompt] = await recorded("userPromptSubmitted");
    const [pre1, pre2] = await recorded("preToolUse");
    const [post1, post2] = await recorded("postToolUse");
    const [stop] = await recorded("agentStop");
    await t.send("sessionStart", (await recorded("sessionStart"))[0]);
    await t.send("userPromptSubmitted", prompt);
    // The commentary is on disk a few ms before the Pre (recorded order); the second message arrives after the first call's result.
    await t.fileUpTo("assistant.message", 1);
    await t.send("preToolUse", pre1);
    await copyFile(probe(1), path.join(t.folder, "casebook.xlsx"));
    await t.send("postToolUse", post1);
    await t.fileUpTo("assistant.message", 2);
    await t.send("preToolUse", pre2);
    await copyFile(probe(2), path.join(t.folder, "casebook.xlsx"));
    await t.send("postToolUse", post2);
    await t.fileUpTo("assistant.message", 3);
    await t.send("agentStop", { ...stop, transcriptPath: t.events });
    await t.send("sessionEnd", (await recorded("sessionEnd"))[0]);
    const ops = t.ops();
    const calls = ops.filter((o) => o.tool_name === "bash");
    assert.deepEqual(calls.map((o) => o.tool_use_id), [CALL_1, CALL_2], "the ids are the session file's toolCallIds");
    assert.deepEqual(calls.map((o) => o.description), ["Count data.csv lines", "Show first two CSV lines"]);
    assert.deepEqual(calls.map((o) => o.narration.text), [COMMENTARY_1, COMMENTARY_2]);
    assert.deepEqual(calls.map((o) => o.closedBy), ["post", "post"], "Pre and Post joined");
    assert.deepEqual(ops.flatMap((o) => o.prompts ?? []), [prompt.prompt], "the session's prompt is recorded");
  });
});

const PRE = { sessionId: SESSION, timestamp: 1, toolName: "bash" };
const toolArgs = (command: string, extra: Record<string, unknown> = {}) => ({ command, ...extra });

describe("the call id and the reason", () => {
  it("arguments that differ from the file's request take a synthetic id and no borrowed reason", async () => {
    const t = await setup();
    const [pre1] = await recorded("preToolUse");
    const [post1] = await recorded("postToolUse");
    await t.fileUpTo("assistant.message", 1);
    const bare = { command: "wc -l data.csv" };
    // The session file's request carries the description; the hook's toolArgs here do not match it, so the Pre cannot take the file id.
    await t.send("preToolUse", { ...pre1, toolArgs: bare });
    await t.send("postToolUse", { ...post1, toolArgs: bare });
    const [op] = t.ops().filter((o) => o.tool_name === "bash");
    assert.match(op.tool_use_id, new RegExp(`^copilot-${SESSION}-1$`), "different arguments: a synthetic id, never the file's");
    assert.equal(op.description, "", "and no borrowed reason either");
  });

  it("a call whose input has no description still gets its intentionSummary as the reason", async () => {
    const t = await setup();
    const [pre1] = await recorded("preToolUse");
    const [post1] = await recorded("postToolUse");
    const bare = { command: "wc -l data.csv" };
    const all = (await sessionLines()).map((l) => l.replace(',"description":"Count data.csv lines"', ""));
    await writeFile(t.events, all.slice(0, all.findIndex((l) => /"type":"tool\.execution_start"/.test(l)) + 1).join("\n") + "\n");
    await t.send("preToolUse", { ...pre1, toolArgs: bare });
    await t.send("postToolUse", { ...post1, toolArgs: bare });
    const [op] = t.ops().filter((o) => o.tool_name === "bash");
    assert.equal(op.tool_use_id, CALL_1);
    assert.equal(op.description, "Count data.csv lines");
    assert.equal(op.narration.text, COMMENTARY_1);
  });

  it("the file's request wins over the toolArgs description when both exist and differ", async () => {
    const t = await setup();
    const [pre1] = await recorded("preToolUse");
    const [post1] = await recorded("postToolUse");
    const all = (await sessionLines()).map((l) => l.replace("\"intentionSummary\":\"Count data.csv lines\"", "\"intentionSummary\":\"Counting the rows of the CSV\""));
    await writeFile(t.events, all.slice(0, all.findIndex((l) => /"type":"tool\.execution_start"/.test(l)) + 1).join("\n") + "\n");
    await t.send("preToolUse", pre1);
    await t.send("postToolUse", post1);
    const [op] = t.ops().filter((o) => o.tool_name === "bash");
    assert.equal(op.tool_use_id, CALL_1);
    assert.equal(op.description, "Counting the rows of the CSV");
  });

  it("no session file: a synthetic per-session id, the Post joins it, and the row says no narration was recorded", async () => {
    const t = await setup();
    const [pre1, pre2] = await recorded("preToolUse");
    const [post1, post2] = await recorded("postToolUse");
    await t.send("preToolUse", pre1);
    await t.send("postToolUse", post1);
    await t.send("preToolUse", pre2);
    await t.send("postToolUse", post2);
    const calls = t.ops().filter((o) => o.tool_name === "bash");
    assert.deepEqual(calls.map((o) => o.tool_use_id), [`copilot-${SESSION}-1`, `copilot-${SESSION}-2`]);
    assert.deepEqual(calls.map((o) => o.closedBy), ["post", "post"]);
    assert.deepEqual(calls.map((o) => o.narration.text), ["no narration recorded", "no narration recorded"]);
  });

  it("two identical calls take the two file ids in order, not the first twice", async () => {
    const t = await setup();
    const [pre1] = await recorded("preToolUse");
    const [post1] = await recorded("postToolUse");
    // Make the second request identical to the first, as a model that runs the same command twice would.
    const all = (await sessionLines()).map((l) => l.split("head -n 2 data.csv").join("wc -l data.csv").split("Show first two CSV lines").join("Count data.csv lines"));
    await writeFile(t.events, all.slice(0, all.findIndex((l) => /call_vC5DbUzhHXUFFBxXla9ApsQQ.*tool\.execution_start|"type":"tool\.execution_start".*call_vC5/.test(l)) + 1).join("\n") + "\n");
    await t.send("preToolUse", pre1);
    await t.send("postToolUse", post1);
    await t.send("preToolUse", pre1);
    await t.send("postToolUse", post1);
    assert.deepEqual(t.ops().filter((o) => o.tool_name === "bash").map((o) => o.tool_use_id), [CALL_1, CALL_2]);
  });

  it("two identical calls open at once: each Post closes the oldest open Pre", async () => {
    const t = await setup();
    const a = { ...PRE, toolArgs: toolArgs("sleep 1") };
    await t.send("preToolUse", a);
    await t.send("preToolUse", a);
    await t.send("postToolUse", { ...a, toolResult: { resultType: "success" } });
    let done = t.ops().filter((o) => o.tool_name === "bash");
    assert.deepEqual(done.map((o) => o.tool_use_id), [`copilot-${SESSION}-1`]);
    await t.send("postToolUse", { ...a, toolResult: { resultType: "success" } });
    done = t.ops().filter((o) => o.tool_name === "bash");
    assert.deepEqual(done.map((o) => o.tool_use_id), [`copilot-${SESSION}-1`, `copilot-${SESSION}-2`]);
  });

  it("a Post never binds to another session's Pre, or to a different tool or different arguments", async () => {
    const t = await setup();
    const other = "b2b2b2b2-4f6c-4619-a1fa-51d2fff6e1b0";
    await t.send("preToolUse", { ...PRE, toolArgs: toolArgs("ls") });
    const post = { ...PRE, toolResult: { resultType: "success" } };
    await t.send("postToolUse", { ...post, sessionId: other, toolArgs: toolArgs("ls") });
    await t.send("postToolUse", { ...post, toolName: "view", toolArgs: toolArgs("ls") });
    await t.send("postToolUse", { ...post, toolArgs: toolArgs("ls -la") });
    assert.deepEqual(t.ops().filter((o) => o.tool_name === "bash"), [], "none of the three closed the call");
    await t.send("postToolUse", { ...post, toolArgs: { command: "ls" } });
    const calls = t.ops().filter((o) => o.tool_name === "bash");
    assert.deepEqual(calls.map((o) => [o.tool_use_id, o.closedBy, o.session_id]), [[`copilot-${SESSION}-1`, "post", SESSION]]);
  });

  it("arguments sent as JSON text join the call the object form opened", async () => {
    const t = await setup();
    await t.send("preToolUse", { ...PRE, toolArgs: JSON.stringify({ command: "ls", description: "List" }) });
    await t.send("postToolUse", { ...PRE, toolArgs: { description: "List", command: "ls" }, toolResult: { resultType: "success" } });
    const calls = t.ops().filter((o) => o.tool_name === "bash");
    assert.deepEqual(calls.map((o) => [o.closedBy, o.description]), [["post", "List"]]);
  });

  it("a failure event closes its call as a failure with the host's error text", async () => {
    const t = await setup();
    const a = { ...PRE, toolArgs: toolArgs("false") };
    await t.send("preToolUse", a);
    await t.send("postToolUseFailure", { ...a, error: "Exit code 1" });
    const [op] = t.ops().filter((o) => o.tool_name === "bash");
    assert.equal(op.closedBy, "failure");
    assert.equal(op.error, "Exit code 1");
  });
});

describe("the profile and the normalizer", () => {
  it("maps the recorded events, declares the unrecorded ones, and takes the event from the command", () => {
    const p = profileOf("copilot");
    const kinds = Object.fromEntries(Object.entries({ userPromptSubmitted: 0, sessionStart: 0, preToolUse: 0, postToolUse: 0, postToolUseFailure: 0, agentStop: 0, sessionEnd: 0, subagentStart: 0, subagentStop: 0 }).map(([e]) => [e, normalize("copilot", { sessionId: "s" }, e).kind]));
    assert.deepEqual(kinds, { userPromptSubmitted: "prompt", sessionStart: "other", preToolUse: "tool-pre", postToolUse: "tool-post", postToolUseFailure: "tool-failure", agentStop: "stop", sessionEnd: "other", subagentStart: "other", subagentStop: "subagent-stop" });
    // both subagent events were recorded (1.0.98 and 1.140.0); subagentStop is the helper's finish, subagentStart is seen and not acted on.
    assert.deepEqual(p.unverifiedEvents, ["errorOccurred", "preCompact"]);
    assert.equal(normalize("copilot", { sessionId: "s", hook_event_name: "preToolUse" }).kind, "other", "a payload cannot name its own event");
    assert.equal(p.displayName, "Copilot");
    assert.equal(findProfile("copilot"), p);
    assert.ok(allProfiles().includes(p));
  });

  it("reads session, cwd, tool and arguments from the payload's own keys; the folder source is the payload cwd", async () => {
    const [pre] = await recorded("preToolUse");
    const ev = normalize("copilot", pre, "preToolUse");
    assert.equal(ev.session, SESSION);
    assert.equal(ev.cwd, pre.cwd);
    assert.equal(ev.toolName, "bash");
    assert.deepEqual(ev.toolInput, pre.toolArgs);
    assert.equal(ev.toolUseId, undefined, "hook stdin has no call id");
    assert.equal(profileOf("copilot").install!.folderFromPayloadCwd, true);
    const [stop] = await recorded("agentStop");
    assert.equal(normalize("copilot", stop, "agentStop").transcriptPath, stop.transcriptPath);
    assert.equal(normalize("copilot", stop, "agentStop").extra.stopHookActive, false);
  });

  it("the three leaks are in the profiles: normalize.ts names no payload key of any host", async () => {
    const src = await readFile(path.join(import.meta.dirname, "..", "src", "normalize.ts"), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    for (const key of ["tool_response", "is_error", "isError", "is_interrupt", "turn_id", "permission_mode", "stop_hook_active", "p.error", "p.model"]) assert.ok(!code.includes(key), `${key} still read in normalize.ts`);
  });

  it("failure: Copilot's failure event carries the error text; a successful post carries none", () => {
    assert.deepEqual(normalize("copilot", { sessionId: "s", error: "boom" }, "postToolUseFailure").failure, { raw: "boom", interrupted: false });
    assert.equal(normalize("copilot", { sessionId: "s", toolResult: { resultType: "success" } }, "postToolUse").failure, undefined);
  });
});
