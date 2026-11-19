import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { startReviewServer } from "../src/review-server.ts";
import { httpLocalProcess, type LocalProcess } from "../src/connector/local-process.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// A remote change the review process did not take shows on the page as a gap row, never as nothing. Real hook runs (pre, then post) against a real
// in-process review server and a real connector child process (the shared rig), or against no server at all. The rule: for every call whose PreToolUse journaled
// a before side for a subject, the page ends with exactly one of the recorded row or a gap row, and the real row wins.
const STAND_IN = `
import readline from "node:readline";
import { readFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "hello") return process.stdout.write(JSON.stringify({ id: msg.id, result: { name: "stand-in" } }) + "\\n");
  let state = null;
  try { state = readFileSync(process.argv[2], "utf8"); } catch {}
  process.stdout.write(JSON.stringify({ id: msg.id, result: { subject: msg.params.subject, state } }) + "\\n");
});
`;
const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11";
const TOKEN = "tok-T478";
const NOT_RUNNING = "This change wasn't recorded, because CoCheck's review page wasn't running.";
const REFUSED = "This change wasn't recorded, because CoCheck's review page refused it.";
const NO_ANSWER = "This change wasn't recorded, because CoCheck's review page didn't answer in time.";
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Home { rig: Rig; ledger: Ledger; stateFile: string; server?: http.Server }
const homes: Home[] = [];
// One state file for every home: the connector pool can outlive a review server in this process, so each home's stand-in reads the same entity.
const STATE_FILE = path.join(mkdtempSync(path.join(tmpdir(), "cocheck-")), "state");

/** A home with the notion stand-in connector installed. `server`: none (not running), or a real review server whose recorded token is right or wrong. */
async function home(server: "none" | "up" | "wrong-token"): Promise<Home> {
  const rig = await makeRig();
  const stateFile = STATE_FILE;
  const dir = path.join(rig.home, "connectors", "notion");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "stand-in.mjs"), STAND_IN);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "notion", version: "0.0.1", entry: "state", matches: { mcpTools: ["mcp__notion__notion-update-page"], subjects: { "mcp__notion__notion-update-page": "notion://page/{page_id:hex}" } }, run: ["node", "stand-in.mjs", stateFile] }));
  const ledger = openLedger(rig.home);
  const h: Home = { rig, ledger, stateFile };
  if (server !== "none") {
    const started = await startReviewServer(ledger, TOKEN, rig.home, 0, () => { h.server?.close(); h.server?.closeAllConnections(); });
    h.server = started.server;
    writeFileSync(path.join(rig.home, "review-server.json"), JSON.stringify({ port: started.port }));
    writeFileSync(path.join(rig.home, "review-token"), server === "up" ? TOKEN : "not-the-token");
  }
  homes.push(h);
  // The turn opens with the prompt, as a real one does: the calls below are its steps.
  const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify({ session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: "update the page" })); })(), localProcess: { request: async () => { throw new Error("none"); } } } as any);
  assert.equal(res.exitCode, 0, res.stderr);
  return h;
}

const payload = (h: Home, event: "PreToolUse" | "PostToolUse", call: string, tool: string) => ({
  session_id: SESSION, cwd: h.rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: event, tool_name: tool, tool_use_id: call,
  tool_input: tool === "Bash" ? { command: "ls" } : { page_id: "2f6c0e9b-11a1-4b7e-9a53-1d2f6c0e9b11", properties: { Status: "Done" } }, ...(event === "PostToolUse" ? { tool_response: { ok: true } } : {}),
});
async function drive(h: Home, event: "PreToolUse" | "PostToolUse", call: string, local: LocalProcess = httpLocalProcess(h.rig.home), tool = "mcp__notion__notion-update-page") {
  const started = performance.now();
  const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", h.rig.folder], env: { COCHECK_HOME: h.rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload(h, event, call, tool))); })(), localProcess: local } as any);
  assert.equal(res.exitCode, 0, res.stderr);
  return performance.now() - started;
}
/** One remote write: pre, the agent's change to the entity, post. Returns the post hook's wall time. */
async function remoteWrite(h: Home, call: string, next: string, local?: LocalProcess, tool?: string): Promise<number> {
  await drive(h, "PreToolUse", call, local, tool);
  writeFileSync(h.stateFile, next);
  return drive(h, "PostToolUse", call, local, tool);
}
const connectorRows = (h: Home, call: string) => h.ledger.allTaskIds().flatMap((id) => h.ledger.fileStatesForTask(id)).filter((r) => r.connector != null && r.credited.includes(call));
/** The page's gap stops, every task: the reason sentences the reviewer reads. */
async function pageGaps(h: Home): Promise<string[]> {
  const out: string[] = [];
  for (const id of h.ledger.allTaskIds()) {
    const input = await loadTimelineInput(h.ledger, h.rig.home, loadRows(h.ledger, id, "t"), { build: "t", quickLook: false, render: async () => null });
    for (const s of buildRailModel(buildTimeline(input), { connectorFor: () => true }).stops) if (s.gap !== undefined) out.push(s.gap.reason);
  }
  return out;
}
const waitFor = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await sleep(20);
};

setKeyProvider(memoryKeyProvider());
after(async () => {
  // Every server closes even when removing one home fails, so no listening server keeps this test process running.
  for (const h of homes) {
    if (h.server?.listening) await new Promise<void>((r) => { h.server!.close(() => r()); h.server!.closeAllConnections(); });
    h.ledger.close();
  }
  for (const h of homes) await h.rig.cleanup();
  setKeyProvider(null);
});

describe("a remote change the review process did not take is a gap row", () => {
  it("review process down, one remote write: the step shows one gap row with the plain reason, and no recorded row; the hook stays in budget", async () => {
    const h = await home("none");
    const ms = await remoteWrite(h, "toolu_down", "v2");
    assert.ok(ms < 200 + 800, `hook took ${Math.round(ms)} ms`);
    assert.deepEqual(await pageGaps(h), [NOT_RUNNING]);
    assert.equal(connectorRows(h, "toolu_down").length, 0);
  });

  it("the review process refuses the request: one gap row saying so", async () => {
    const h = await home("wrong-token");
    await remoteWrite(h, "toolu_refused", "v2");
    assert.deepEqual(await pageGaps(h), [REFUSED]);
    assert.equal(connectorRows(h, "toolu_refused").length, 0);
  });

  it("DANGEROUS DIRECTION (a gap for a recorded change): slow acceptance after the hook gave up, then the real row: the page shows the real row only", async () => {
    const h = await home("up");
    writeFileSync(h.stateFile, "v1");
    const real = httpLocalProcess(h.rig.home);
    let late: Promise<void> | undefined;
    const slow: LocalProcess = { request: real.request, afterSnapshot: (req) => (late = sleep(350).then(() => real.afterSnapshot!(req))) };
    const ms = await remoteWrite(h, "toolu_slow", "v2", slow);
    assert.ok(ms < 200 + 800, `hook took ${Math.round(ms)} ms`);
    // Between the hook giving up and the late acceptance, the page shows the gap (the change is not silently missing meanwhile).
    assert.deepEqual(await pageGaps(h), [NO_ANSWER]);
    await late;
    await waitFor(() => connectorRows(h, "toolu_slow").length >= 1);
    assert.deepEqual(connectorRows(h, "toolu_slow").map((r) => [r.prevSha256, r.sha256]), [[sha("v1"), sha("v2")]]);
    assert.deepEqual(await pageGaps(h), [], "the real row wins: no gap row beside it");
  });

  it("the review process up: the recorded row and no gap row", async () => {
    const h = await home("up");
    writeFileSync(h.stateFile, "v1");
    await remoteWrite(h, "toolu_up", "v2");
    await waitFor(() => connectorRows(h, "toolu_up").length >= 1);
    assert.equal(connectorRows(h, "toolu_up").length, 1);
    assert.deepEqual(await pageGaps(h), []);
  });

  it("two calls on the same subject with the process down: two gap rows", async () => {
    const h = await home("none");
    await remoteWrite(h, "toolu_a", "v2");
    await remoteWrite(h, "toolu_b", "v3");
    assert.deepEqual(await pageGaps(h), [NOT_RUNNING, NOT_RUNNING]);
  });

  it("allow-list: a call with no journaled before side (no subject template) gets no gap row, process down", async () => {
    const h = await home("none");
    await remoteWrite(h, "toolu_bash", "v2", undefined, "Bash");
    assert.deepEqual(await pageGaps(h), []);
  });

  it("a server outcome recorded before the hook's gap still wins (order does not decide)", async () => {
    const h = await home("none");
    await drive(h, "PreToolUse", "toolu_race");
    // The review process took the request and recorded its outcome; the hook's own gap row lands after it.
    const task = h.ledger.allTaskIds().at(-1)!;
    h.ledger.recordCaptureOutcome({ taskId: task, client: "x", call: "toolu_race", subject: "notion://page/2f6c0e9b11a14b7e9a531d2f6c0e9b11", outcome: "recorded", reason: "The change was captured." });
    writeFileSync(h.stateFile, "v2");
    await drive(h, "PostToolUse", "toolu_race");
    assert.deepEqual(await pageGaps(h), []);
  });

  it("a hanging review process: the hook still answers within its budget and writes a no-answer gap", async () => {
    const h = await home("none");
    const hang: LocalProcess = { request: async () => ({ ref: sha("v1") }), afterSnapshot: () => new Promise<void>(() => {}) };
    const ms = await remoteWrite(h, "toolu_hang", "v2", hang);
    assert.ok(ms < 200 + 800, `hook took ${Math.round(ms)} ms`);
    assert.deepEqual(await pageGaps(h), [NO_ANSWER]);
  });
});
