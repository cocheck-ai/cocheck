import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { memoryKeyProvider, readSealed, setKeyProvider } from "../src/seal.ts";
import { storeDirOf } from "../src/states.ts";
import { startReviewServer } from "../src/review-server.ts";
import { httpLocalProcess } from "../src/connector/local-process.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// The after side of a connector subject. Real hook runs (pre, then post) talk over HTTP to an in-process review server whose connector is a real
// child process; its state for the subject is a file the test rewrites between calls.
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
const SUBJECT = "notion://page/2f6c0e9b11a14b7e9a531d2f6c0e9b11";
const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11";
const TOKEN = "tok-T388";
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const waitFor = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

let rig: Rig, ledger: Ledger, server: http.Server, stateFile: string, scratch: string;
const rows = () => ledger.allTaskIds().flatMap((id) => ledger.fileStatesForTask(id)).filter((r) => r.connector != null);
const payload = (event: "PreToolUse" | "PostToolUse", call: string, tool = "mcp__notion__notion-update-page") => ({
  session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: event, tool_name: tool, tool_use_id: call,
  tool_input: { page_id: "2f6c0e9b-11a1-4b7e-9a53-1d2f6c0e9b11", properties: { Status: "Done" } }, ...(event === "PostToolUse" ? { tool_response: { ok: true } } : {}),
});
const drive = async (event: "PreToolUse" | "PostToolUse", call: string, local: unknown = httpLocalProcess(rig.home), tool?: string) => {
  const started = performance.now();
  const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload(event, call, tool))); })(), localProcess: local } as any);
  assert.equal(res.exitCode, 0, res.stderr);
  return { res, ms: performance.now() - started };
};
const setState = (s: string | null) => (s === null ? rmSync(stateFile, { force: true }) : writeFileSync(stateFile, s));
/** One call: pre, the agent's change to the entity, post; waits for the row count to reach `want`. */
async function call(id: string, next: string | null, want: number, ms = 4000) {
  await drive("PreToolUse", id);
  setState(next);
  await drive("PostToolUse", id);
  await waitFor(() => rows().length >= want, ms);
}

before(async () => {
  setKeyProvider(memoryKeyProvider());
  rig = await makeRig();
  scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  stateFile = path.join(scratch, "state");
  const dir = path.join(rig.home, "connectors", "notion");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "stand-in.mjs"), STAND_IN);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "notion", version: "0.0.1", entry: "state", matches: { mcpTools: ["mcp__notion__notion-update-page"], subjects: { "mcp__notion__notion-update-page": "notion://page/{page_id:hex}" } }, run: ["node", "stand-in.mjs", stateFile] }));
  ledger = openLedger(rig.home);
  const started = await startReviewServer(ledger, TOKEN, rig.home, 0, () => { server.close(); server.closeAllConnections(); });
  server = started.server;
  writeFileSync(path.join(rig.home, "review-server.json"), JSON.stringify({ port: started.port }));
  writeFileSync(path.join(rig.home, "review-token"), TOKEN);
});
after(async () => {
  if (server.listening) await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  ledger.close();
  setKeyProvider(null);
  await rig.cleanup();
});

describe("after-snapshot", () => {
  it("a session with no task yet: pre, change, post records one connector row credited to that call, both sides sealed in the new task's store", async () => {
    setState("v1");
    assert.equal(ledger.allTaskIds().length, 0, "the session has no task before the call");
    await call("toolu_1", "v2", 1);
    assert.equal(rows().length, 1);
    const r = rows()[0]!;
    assert.equal(r.filePath, SUBJECT);
    assert.equal(r.connector, "notion");
    assert.equal(r.sha256, sha("v2"));
    assert.equal(r.prevSha256, sha("v1"));
    assert.deepEqual(r.credited, ["toolu_1"]);
    assert.equal(r.kept, "whole");
    const store = storeDirOf(rig.home, r.taskId);
    for (const s of ["v1", "v2"]) assert.equal((await readSealed(path.join(store, sha(s)))).toString("utf8"), s);
  });

  it("two calls chain: the second row's prev equals the first row's sha, and each is credited to its own call", async () => {
    await call("toolu_2", "v3", 2);
    const [a, b] = rows();
    assert.equal(b!.prevSha256, a!.sha256, "call 2's prev is call 1's after");
    assert.equal(b!.sha256, sha("v3"));
    assert.deepEqual(a!.credited, ["toolu_1"]);
    assert.deepEqual(b!.credited, ["toolu_2"]);
    assert.equal(a!.taskId, b!.taskId);
  });

  it("an unchanged state records nothing", async () => {
    await call("toolu_3", "v3", 99, 600);
    assert.equal(rows().length, 2);
  });

  it("DANGEROUS DIRECTION: a before side that was unknown falls back to the last row's after in this task, never a guess, and the credit is the request's call", async () => {
    await drive("PreToolUse", "toolu_4", { request: async () => { throw new Error("down"); }, afterSnapshot: httpLocalProcess(rig.home).afterSnapshot });
    setState("v4");
    await drive("PostToolUse", "toolu_4");
    await waitFor(() => rows().length >= 3);
    const r = rows()[2]!;
    assert.equal(r.prevSha256, sha("v3"), "prev is the last sealed after of this subject in this task");
    assert.deepEqual(r.credited, ["toolu_4"]);
  });

  it("DANGEROUS DIRECTION: an unknown before side with no earlier row records nothing (no guessed prev)", async () => {
    const other = await makeRig();
    const home = rig.home;
    try {
      // a second session of the same home with no row for this subject: its post must not invent a before side
      const sess = "aaaaaaaa-4b7e-4f06-9a53-1d2f6c0e9b11";
      const mk = (event: string, call: string) => ({ ...payload(event as "PreToolUse", call), session_id: sess });
      const run = async (p: unknown, local: unknown) => runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(p)); })(), localProcess: local } as any);
      await run(mk("PreToolUse", "toolu_x"), { request: async () => { throw new Error("down"); } });
      setState("v9");
      const n = rows().length;
      await run(mk("PostToolUse", "toolu_x"), httpLocalProcess(home));
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(rows().length, n, "no row for a change whose before side nobody knows");
    } finally {
      await other.cleanup();
    }
  });

  it("a vanished entity records kept gone, with the before ref as prev", async () => {
    setState("v10");
    await drive("PreToolUse", "toolu_5");
    const n = rows().length;
    setState(null);
    await drive("PostToolUse", "toolu_5");
    await waitFor(() => rows().length > n);
    const r = rows().at(-1)!;
    assert.equal(r.kept, "gone");
    assert.equal(r.prevSha256, sha("v10"));
    assert.deepEqual(r.credited, ["toolu_5"]);
  });

  it("end to end (deliberate): a row captured since schema 7 is never re-asked at load; this stand-in gave no change list at capture, so the row says none was kept, and its refs and credit come from the row", async () => {
    const taskId = rows()[0]!.taskId;
    const asked: unknown[] = [];
    const input = await loadTimelineInput(ledger, rig.home, loadRows(ledger, taskId, "t"), {
      build: "t", quickLook: false, render: async () => null,
      connectorDiff: async (row) => { asked.push(row); throw new Error("must not be asked"); },
    });
    assert.deepEqual(asked, [], "load never re-runs a connector for a stored step");
    const ds = [...input.diffs!.values()].filter((d) => d.producer === "connector" && d.after.ref === sha("v2"));
    assert.equal(ds.length, 1);
    assert.deepEqual([ds[0]!.subject, ds[0]!.before.ref], [SUBJECT, sha("v1")]);
    assert.match(ds[0]!.unavailable ?? "", /no change list was kept/);
    assert.deepEqual(rows().filter((r) => r.sha256 === sha("v2")).map((r) => r.credited), [["toolu_1"]]);
  });

  it("the hook waits at most 200 ms for the review process to accept, whatever it does", async () => {
    const hang = { request: async () => ({ ref: sha("v1") }), afterSnapshot: () => new Promise<void>(() => {}) };
    await drive("PreToolUse", "toolu_6", hang);
    const { ms } = await drive("PostToolUse", "toolu_6", hang);
    assert.ok(ms < 200 + 800, `hook took ${Math.round(ms)} ms`);
  });

  it("a call with no connector subject sends no after-snapshot", async () => {
    let sent = 0;
    const local = { request: async () => ({ ref: "x" }), afterSnapshot: async () => { sent++; } };
    await drive("PreToolUse", "toolu_7", local, "Bash");
    await drive("PostToolUse", "toolu_7", local, "Bash");
    assert.equal(sent, 0);
    assert.ok(existsSync(rig.home));
  });
});
