import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { startReviewServer } from "../src/review-server.ts";
import { httpLocalProcess } from "../src/connector/local-process.ts";
import { captureGapsOf, NO_SUBJECT_REASON, recordNotTaken } from "../src/connector/after-gap.ts";
import { GAP_OUTCOMES } from "../src/connector/after-snapshot.ts";
import { answerObjectOf, renderCallSubject } from "../src/connector/subjects.ts";
import { checkManifest } from "../src/connector/schema.ts";
import { callSamplesCheck, runConnectorTest } from "../src/connector-test-cli.ts";
import { beforeSideOfCall } from "../src/hook-journal.ts";
import { normalize } from "../src/normalize.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// A tool named in `matches.calls` creates an item whose id exists only in the tool's answer. The review process renders the subject from the answer,
// reads the item once, and records a creation whose missing before state is the connector's declaration (before_basis 'declared'), unless the task already
// holds a state for that subject, which then is the before side.
//
// Answer shapes: no fixture in this repo holds a real MCP tool answer as a host hands it to the hook. The answers below follow the MCP CallToolResult shape (content blocks, structuredContent, isError) from the MCP
// specification; they are NOT a recorded host payload.

const CREATE = "mcp__linear__create_issue";
const UPDATE = "mcp__linear__update_issue";
const ISSUE = "0b5f3c2e-7a41-4d8e-9f10-2c6a4e8b1d33";
const SUBJECT = `linear://issue/${ISSUE}`;
const SESSION = "6e3a9f14-2b7c-4d0e-8a15-3f9b2c7d4e21";
const TOKEN = "tok-T483";
/** The hook journal's file stem for SESSION. */
const JOURNAL = createHash("sha256").update(SESSION).digest("hex").slice(0, 16);

// The stand-in connector: the state of a subject is a file named after its hash in the state folder (missing = the item does not exist).
const STAND_IN = `
import readline from "node:readline";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "hello") return process.stdout.write(JSON.stringify({ id: msg.id, result: { name: "stand-in" } }) + "\\n");
  let state = null;
  try { state = readFileSync(path.join(process.argv[2], createHash("sha256").update(msg.params.subject).digest("hex")), "utf8"); } catch {}
  process.stdout.write(JSON.stringify({ id: msg.id, result: { subject: msg.params.subject, state } }) + "\\n");
});
`;
const MANIFEST = (stateDir: string) => ({
  spec: "cocheck.connector/1", id: "linear", version: "0.0.1", entry: "state",
  matches: {
    mcpTools: [UPDATE],
    subjects: { [UPDATE]: "linear://issue/{id}" },
    calls: { [CREATE]: { subjects: [{ from: "response", template: "linear://issue/{issue.id}", created: true }] } },
  },
  run: ["node", "stand-in.mjs", stateDir],
});
/** An MCP CallToolResult that names the issue in one JSON text block. */
const textAnswer = (id: string) => ({ content: [{ type: "text", text: JSON.stringify({ issue: { id, title: "Q4 close" } }) }] });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const waitFor = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

let rig: Rig, ledger: Ledger, server: http.Server, stateDir: string;
const setState = (subject: string, s: string | null) => (s === null ? rmSync(path.join(stateDir, sha(subject)), { force: true }) : writeFileSync(path.join(stateDir, sha(subject)), s));
const rowsOf = (call: string) => ledger.allTaskIds().flatMap((id) => ledger.fileStatesForTask(id)).filter((r) => r.connector != null && r.credited.includes(call));
const outcomesOf = (call: string) => ledger.allCaptureOutcomes().filter((o) => o.call === call);
const drive = async (body: Record<string, unknown>) => {
  const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify({ session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", ...body })); })(), localProcess: httpLocalProcess(rig.home) } as any);
  assert.equal(res.exitCode, 0, res.stderr);
};
/** A create call: the pre hook (nothing to read before), the tool runs (the item appears), the post hook carries the answer. */
async function createCall(call: string, response: unknown, appear?: { subject: string; state: string }) {
  const input = { title: "Q4 close", teamId: "ENG" };
  await drive({ hook_event_name: "PreToolUse", tool_name: CREATE, tool_use_id: call, tool_input: input });
  if (appear !== undefined) setState(appear.subject, appear.state);
  await drive({ hook_event_name: "PostToolUse", tool_name: CREATE, tool_use_id: call, tool_input: input, tool_response: response });
}

before(async () => {
  setKeyProvider(memoryKeyProvider());
  rig = await makeRig();
  stateDir = mkdtempSync(path.join(tmpdir(), "cocheck-states-"));
  const dir = path.join(rig.home, "connectors", "linear");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "stand-in.mjs"), STAND_IN);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify(MANIFEST(stateDir)));
  ledger = openLedger(rig.home);
  const started = await startReviewServer(ledger, TOKEN, rig.home, 0, () => { server.close(); server.closeAllConnections(); });
  server = started.server;
  writeFileSync(path.join(rig.home, "review-server.json"), JSON.stringify({ port: started.port }));
  writeFileSync(path.join(rig.home, "review-token"), TOKEN);
  await drive({ hook_event_name: "UserPromptSubmit", prompt: "file the Q4 close issue" });
});
after(async () => {
  if (server.listening) await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  ledger.close();
  setKeyProvider(null);
  await rig.cleanup();
});

describe("a create tool gets a before-and-after row", () => {
  it("a recorded post-call event of a create tool records a creation row whose missing before is the connector's declaration", async () => {
    await createCall("toolu_create1", textAnswer(ISSUE), { subject: SUBJECT, state: "issue v1" });
    await waitFor(() => outcomesOf("toolu_create1").length > 0);
    assert.deepEqual(outcomesOf("toolu_create1").map((o) => [o.subject, o.outcome]), [[SUBJECT, "recorded"]]);
    const rows = rowsOf("toolu_create1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.filePath, SUBJECT);
    assert.equal(rows[0]!.prevSha256, null);
    assert.equal(rows[0]!.kept, "whole");
    assert.equal(rows[0]!.beforeBasis, "declared");
  });

  it("DANGEROUS DIRECTION: a create tool whose returned item already has a held state in the task shows that state as the before side, not a creation", async () => {
    const id = "7d21a0c4-5e3b-4f9a-8c62-1b0e9d4f7a58";
    const subject = `linear://issue/${id}`;
    // An update call first gives the task a held state for the item.
    setState(subject, "held state");
    await drive({ hook_event_name: "PreToolUse", tool_name: UPDATE, tool_use_id: "toolu_update1", tool_input: { id, title: "a" } });
    setState(subject, "after update");
    await drive({ hook_event_name: "PostToolUse", tool_name: UPDATE, tool_use_id: "toolu_update1", tool_input: { id, title: "a" }, tool_response: { ok: true } });
    await waitFor(() => outcomesOf("toolu_update1").length > 0);
    assert.deepEqual(outcomesOf("toolu_update1").map((o) => o.outcome), ["recorded"]);
    const held = rowsOf("toolu_update1")[0]!.sha256;
    // The "create" tool answers with the existing item and overwrites it.
    await createCall("toolu_create2", textAnswer(id), { subject, state: "overwritten" });
    await waitFor(() => outcomesOf("toolu_create2").length > 0);
    assert.deepEqual(outcomesOf("toolu_create2").map((o) => o.outcome), ["recorded"]);
    const rows = rowsOf("toolu_create2");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.prevSha256, held, "the held state is the before side");
    assert.equal(rows[0]!.beforeBasis, null, "the declaration is not used");
  });

  it("DANGEROUS DIRECTION: an update call that left the item unchanged, then a create that names and changes it, records the read state as the before side", async () => {
    const id = "c3e8a1f0-4b2d-4e7a-9c11-5d6f7e8a9b02";
    const subject = `linear://issue/${id}`;
    setState(subject, "read state");
    await drive({ hook_event_name: "PreToolUse", tool_name: UPDATE, tool_use_id: "toolu_update_same", tool_input: { id, title: "a" } });
    await drive({ hook_event_name: "PostToolUse", tool_name: UPDATE, tool_use_id: "toolu_update_same", tool_input: { id, title: "a" }, tool_response: { ok: true } });
    await waitFor(() => outcomesOf("toolu_update_same").length > 0);
    assert.deepEqual(outcomesOf("toolu_update_same").map((o) => o.outcome), ["unchanged"]);
    assert.deepEqual(rowsOf("toolu_update_same"), [], "an unchanged call writes no state row");
    const read = beforeSideOfCall(rig.home, JOURNAL, "toolu_update_same");
    assert.equal(read?.state, "snapshot");
    await createCall("toolu_create_over", textAnswer(id), { subject, state: "overwritten" });
    await waitFor(() => outcomesOf("toolu_create_over").length > 0);
    assert.deepEqual(outcomesOf("toolu_create_over").map((o) => o.outcome), ["recorded"]);
    const rows = rowsOf("toolu_create_over");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.prevSha256, read!.ref, "the state CoCheck read is the before side");
    assert.equal(rows[0]!.beforeBasis, null, "the declaration is not used");
  });

  it("case: an earlier call read the item as absent, then a create names it: a creation resting on CoCheck's own read, before_basis NULL", async () => {
    const id = "e9f0a1b2-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
    const subject = `linear://issue/${id}`;
    setState(subject, null);
    await drive({ hook_event_name: "PreToolUse", tool_name: UPDATE, tool_use_id: "toolu_update_absent", tool_input: { id, title: "a" } });
    await drive({ hook_event_name: "PostToolUse", tool_name: UPDATE, tool_use_id: "toolu_update_absent", tool_input: { id, title: "a" }, tool_response: { ok: false } });
    await waitFor(() => outcomesOf("toolu_update_absent").length > 0);
    assert.deepEqual(outcomesOf("toolu_update_absent").map((o) => o.outcome), ["unchanged"]);
    assert.equal(beforeSideOfCall(rig.home, JOURNAL, "toolu_update_absent")?.state, "absent");
    await createCall("toolu_create_after_absent", textAnswer(id), { subject, state: "new item" });
    await waitFor(() => outcomesOf("toolu_create_after_absent").length > 0);
    assert.deepEqual(outcomesOf("toolu_create_after_absent").map((o) => o.outcome), ["recorded"]);
    const rows = rowsOf("toolu_create_after_absent");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.prevSha256, null, "a creation");
    assert.equal(rows[0]!.kept, "whole");
    assert.equal(rows[0]!.beforeBasis, null, "resting on CoCheck's own read, not the declaration");
  });

  it("the other direction: a read of a different item, and a read of the same item in another session's task, leave a true creation declared", async () => {
    const other = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const id = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
    const subject = `linear://issue/${id}`;
    // this session reads a different item, unchanged
    setState(`linear://issue/${other}`, "other item");
    await drive({ hook_event_name: "PreToolUse", tool_name: UPDATE, tool_use_id: "toolu_update_other", tool_input: { id: other, title: "a" } });
    await drive({ hook_event_name: "PostToolUse", tool_name: UPDATE, tool_use_id: "toolu_update_other", tool_input: { id: other, title: "a" }, tool_response: { ok: true } });
    await waitFor(() => outcomesOf("toolu_update_other").length > 0);
    // another session (its own task) reads this item, unchanged
    setState(subject, "seen elsewhere");
    const elsewhere = { session_id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a" };
    await drive({ ...elsewhere, hook_event_name: "UserPromptSubmit", prompt: "look at the issue" });
    await drive({ ...elsewhere, hook_event_name: "PreToolUse", tool_name: UPDATE, tool_use_id: "toolu_update_elsewhere", tool_input: { id, title: "a" } });
    await drive({ ...elsewhere, hook_event_name: "PostToolUse", tool_name: UPDATE, tool_use_id: "toolu_update_elsewhere", tool_input: { id, title: "a" }, tool_response: { ok: true } });
    await waitFor(() => outcomesOf("toolu_update_elsewhere").length > 0);
    assert.deepEqual(outcomesOf("toolu_update_elsewhere").map((o) => o.outcome), ["unchanged"]);
    await createCall("toolu_create_true", textAnswer(id), { subject, state: "created here" });
    await waitFor(() => outcomesOf("toolu_create_true").length > 0);
    assert.notEqual(outcomesOf("toolu_create_true")[0]!.taskId, outcomesOf("toolu_update_elsewhere")[0]!.taskId, "the other read is in another task");
    assert.deepEqual(outcomesOf("toolu_create_true").map((o) => o.outcome), ["recorded"]);
    const rows = rowsOf("toolu_create_true");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.prevSha256, null);
    assert.equal(rows[0]!.beforeBasis, "declared");
  });

  it("an earlier call on the item whose after-read was not taken leaves the state unknown: the create is a gap (no-before), never a declared creation", async () => {
    const id = "4b5c6d7e-8f90-4a1b-9c2d-3e4f5a6b7c8d";
    const subject = `linear://issue/${id}`;
    const client = outcomesOf("toolu_create1")[0]!.client;
    await recordNotTaken(ledger, rig.home, { client, call: "toolu_update_lost", subject, reason: "not running" });
    await createCall("toolu_create_after_lost", textAnswer(id), { subject, state: "maybe new" });
    await waitFor(() => outcomesOf("toolu_create_after_lost").length > 0);
    assert.deepEqual(outcomesOf("toolu_create_after_lost").map((o) => o.outcome), ["no-before"]);
    assert.deepEqual(rowsOf("toolu_create_after_lost"), []);
  });

  it("an answer marked isError records no subject and no row", async () => {
    await createCall("toolu_err1", { isError: true, content: [{ type: "text", text: JSON.stringify({ issue: { id: ISSUE } }) }] });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(outcomesOf("toolu_err1"), []);
    assert.deepEqual(rowsOf("toolu_err1"), []);
  });

  it("an answer that does not name the item shows as a gap for the call with the plain sentence", async () => {
    await createCall("toolu_prose1", { content: [{ type: "text", text: "Created issue ENG-42." }] });
    await waitFor(() => outcomesOf("toolu_prose1").length > 0);
    const o = outcomesOf("toolu_prose1");
    assert.equal(o.length, 1);
    assert.equal(o[0]!.reason, NO_SUBJECT_REASON);
    assert.equal(NO_SUBJECT_REASON, "This change wasn't recorded, because the tool's answer didn't name the item.");
    assert.equal(captureGapsOf(ledger.captureOutcomesForTask(o[0]!.taskId!), GAP_OUTCOMES).get("toolu_prose1"), NO_SUBJECT_REASON);
    assert.deepEqual(rowsOf("toolu_prose1"), []);
  });

  it("an answer over 1 MiB shows as a gap with the same sentence (the hook writes it; nothing is sent)", async () => {
    await createCall("toolu_big1", { content: [{ type: "text", text: JSON.stringify({ issue: { id: ISSUE }, pad: "x".repeat(1024 * 1024) }) }] });
    await waitFor(() => outcomesOf("toolu_big1").length > 0);
    const o = outcomesOf("toolu_big1");
    assert.deepEqual(o.map((x) => x.reason), [NO_SUBJECT_REASON]);
    assert.equal(captureGapsOf(ledger.captureOutcomesForTask(o[0]!.taskId!), GAP_OUTCOMES).get("toolu_big1"), NO_SUBJECT_REASON);
  });
});

describe("reading the answer, in order", () => {
  it("structuredContent first, then exactly one JSON text block, then a JSON string", () => {
    assert.deepEqual(answerObjectOf({ structuredContent: { a: 1 }, content: [{ type: "text", text: JSON.stringify({ a: 2 }) }] }), { a: 1 });
    assert.deepEqual(answerObjectOf({ content: [{ type: "text", text: JSON.stringify({ a: 2 }) }] }), { a: 2 });
    assert.deepEqual(answerObjectOf([{ type: "text", text: JSON.stringify({ a: 3 }) }]), { a: 3 });
    assert.deepEqual(answerObjectOf(JSON.stringify({ a: 4 })), { a: 4 });
  });
  it("two text blocks, a non-object JSON text, prose, and isError yield nothing", () => {
    assert.equal(answerObjectOf({ content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] }), undefined);
    assert.equal(answerObjectOf({ content: [{ type: "text", text: "[1]" }] }), undefined);
    assert.equal(answerObjectOf("Created ENG-42"), undefined);
    assert.equal(answerObjectOf({ isError: true, structuredContent: { a: 1 } }), undefined);
  });
  it("a dotted path and :hex render; a missing path does not", () => {
    assert.equal(renderCallSubject("linear://issue/{issue.id}", { structuredContent: { issue: { id: "ab-12" } } }), "linear://issue/ab-12");
    assert.equal(renderCallSubject("notion://page/{page.id:hex}", { structuredContent: { page: { id: "2F6C-0e9b" } } }), "notion://page/2f6c0e9b");
    assert.equal(renderCallSubject("linear://issue/{issue.id}", { structuredContent: { issue: {} } }), undefined);
  });
});

describe("the matches.calls manifest block", () => {
  const base = (calls: unknown, subjects?: unknown) => ({ spec: "cocheck.connector/1", id: "x", version: "0.1.0", entry: "state", matches: { schemes: ["linear"], ...(subjects !== undefined ? { subjects } : {}), calls }, run: ["node", "c.mjs"] });
  const ok = { from: "response", template: "linear://issue/{issue.id}", created: true };
  it("a valid block, with unknown keys inside a tool's object, has no problem", () => {
    assert.deepEqual(checkManifest(base({ [CREATE]: { subjects: [ok], later: 1 } })), []);
  });
  it("from other than response, a missing or false created, a tool also in subjects, [] in a path, and more than one subject are problems that say not supported yet", () => {
    const p1 = checkManifest(base({ [CREATE]: { subjects: [{ ...ok, from: "input" }] } }));
    assert.match(p1.map((p) => p.fix).join(" "), /supported yet/);
    for (const created of [undefined, false]) assert.match(checkManifest(base({ [CREATE]: { subjects: [{ ...ok, created }] } })).map((p) => p.fix).join(" "), /supported yet/);
    assert.match(checkManifest(base({ [CREATE]: { subjects: [ok] } }, { [CREATE]: "linear://issue/{id}" })).map((p) => p.fix).join(" "), /not supported yet/);
    assert.equal(checkManifest(base({ [CREATE]: { subjects: [{ ...ok, template: "linear://issue/{issues[0].id}" }] } })).length, 1);
    assert.match(checkManifest(base({ [CREATE]: { subjects: [ok, ok] } })).map((p) => p.fix).join(" "), /not supported yet/);
  });
});

describe("connector test: samples/calls.json", () => {
  const manifest = MANIFEST("/nowhere");
  it("a sample that renders its expected subject passes; a wrong one is a problem", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-kit-"));
    mkdirSync(path.join(dir, "samples"));
    writeFileSync(path.join(dir, "samples", "calls.json"), JSON.stringify([{ tool: CREATE, response: textAnswer(ISSUE), expect: SUBJECT }]));
    assert.deepEqual(callSamplesCheck(dir, manifest), { problems: [], untested: [] });
    writeFileSync(path.join(dir, "samples", "calls.json"), JSON.stringify([{ tool: CREATE, response: textAnswer(ISSUE), expect: "linear://issue/other" }]));
    assert.equal(callSamplesCheck(dir, manifest).problems.length, 1);
  });
  it("connector test: a malformed or wrong sample points at the spec's \"Items a tool creates\" section, not #diffs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-kit-"));
    mkdirSync(path.join(dir, "samples"));
    writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ ...MANIFEST("/nowhere"), entry: "diff", run: ["node", "c.mjs"] }));
    for (const samples of [{ not: "a list" }, [{ tool: CREATE }], [{ tool: CREATE, response: textAnswer(ISSUE), expect: "linear://issue/other" }]]) {
      writeFileSync(path.join(dir, "samples", "calls.json"), JSON.stringify(samples));
      const r = await runConnectorTest([dir]);
      assert.equal(r.exitCode, 1);
      const lines = r.stdout.split("\n");
      const at = lines.findIndex((l) => l.startsWith("samples/calls.json"));
      assert.ok(at >= 0, r.stdout);
      assert.equal(lines[at + 1], "see spec #items-a-tool-creates", r.stdout);
      assert.doesNotMatch(r.stdout, /#diffs/);
    }
  });

  it("a named tool with no sample is untested, never passed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-kit-"));
    const r = callSamplesCheck(dir, manifest);
    assert.deepEqual(r.problems, []);
    assert.equal(r.untested.length, 1);
    assert.match(r.untested[0]!, /no sample for mcp__linear__create_issue/);
  });
});

// Recorded from Claude Code: test/fixtures/claude-code-mcp-post-payloads.recorded.jsonl holds three PostToolUse payloads Claude Code handed a post-call hook
// for an MCP tool (session id, cwd and transcript path replaced before the copy). The text answer arrives as a content-block list, the structured answer as a
// JSON string, the prose answer as a content-block list. These three are the only recorded shapes in this file.
describe("recorded Claude Code post-call payloads", () => {
  const recorded = readFileSync(path.join(import.meta.dirname, "fixtures", "claude-code-mcp-post-payloads.recorded.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  const byTool = (t: string) => recorded.find((p) => p.tool_name === t)!;
  const TEMPLATE = "linear://issue/{issue.id}";
  it("the text-JSON and the structured answer render the subject through the normalizer; the prose answer does not", () => {
    assert.equal(recorded.length, 3);
    assert.equal(typeof byTool("mcp__probe__create_structured").tool_response, "string", "Claude Code hands the structured answer over as a JSON string");
    for (const t of ["mcp__probe__create_text", "mcp__probe__create_structured"]) {
      const ev = normalize("claude", byTool(t));
      assert.equal(ev.kind, "tool-post");
      assert.equal(renderCallSubject(TEMPLATE, ev.toolResponse), "linear://issue/abc-123", t);
    }
    assert.equal(renderCallSubject(TEMPLATE, normalize("claude", byTool("mcp__probe__create_prose")).toolResponse), undefined);
  });
  it("through the post-call path, the recorded prose answer produces the gap sentence and the text answer a row", async () => {
    // The recorded payloads, sent as this rig's session and folder and as the rig's create tool; every other field is as recorded.
    const asRig = (p: Record<string, unknown>) => ({ ...p, session_id: SESSION, cwd: rig.folder, tool_name: CREATE });
    const prose = byTool("mcp__probe__create_prose");
    await drive(asRig(prose));
    await waitFor(() => outcomesOf(prose.tool_use_id as string).length > 0);
    assert.deepEqual(outcomesOf(prose.tool_use_id as string).map((o) => [o.subject, o.reason]), [["", NO_SUBJECT_REASON]]);
    const text = byTool("mcp__probe__create_text");
    setState("linear://issue/abc-123", "recorded item");
    await drive(asRig(text));
    await waitFor(() => outcomesOf(text.tool_use_id as string).length > 0);
    assert.deepEqual(outcomesOf(text.tool_use_id as string).map((o) => [o.subject, o.outcome]), [["linear://issue/abc-123", "recorded"]]);
  });
});
