import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRig, type Rig } from "./hook-corpus.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { journalSessionKey, readJournalSession } from "../src/hook-journal.ts";

// A pre-call hook never blocks on a before-snapshot.
// An acceptance test written before the build; each test is `todo` until the request path exists.
//
// Expected interface (the minimum the build must honour; nothing else is frozen here):
//  - Request: on a PreToolUse whose tool call writes a URI subject (here a Notion page, MCP tool `mcp__notion__notion-update-page`),
//    the hook calls `run.localProcess.request({ kind: "before-snapshot", subject: <uri>, budgetMs: 1500, ... })`, where `localProcess` is
//    a new optional field on `HookRun` (src/hook-cli.ts). In production it is a client of the long-lived local CoCheck process, which
//    owns the connector pool; the test passes a stand-in. The request resolves with `{ ref: string }` (a snapshot reference) or never.
//  - Budget: the hook stops waiting after 1500 ms, exits 0 with empty stdout (the call proceeds, nothing blocks or denies).
//  - Record: `HookExit.beforeSide` (new optional field) is `{ subject, state: "snapshot", ref }` when the snapshot arrived in time, and
//    `{ subject, state: "unknown", confidence: "opaque" }` when it did not (or the request failed). Never absent for a URI subject.
//  - The hook never spawns a connector (or any child process) itself.
// Must not happen: (a) the agent's call delayed past the budget (tests 1), (b) the before side silently dropped with no unknown mark (test 2).

const BUDGET_MS = 1500;
const MARGIN_MS = process.platform === "win32" ? 2500 : 500; // a Windows runner starts the hook and its data-folder lockdown slower // stated margin: hook startup, journal and ledger writes on a loaded machine
const SUBJECT = "notion://page/2f6c0e9b11a14b7e9a531d2f6c0e9b11";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const preCall = (r: Rig) => ({
  session_id: "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11",
  cwd: r.folder,
  transcript_path: "/x/claude.jsonl",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "mcp__notion__notion-update-page",
  tool_use_id: "toolu_notion_1",
  tool_input: { page_id: "2f6c0e9b-11a1-4b7e-9a53-1d2f6c0e9b11", properties: { Status: "Done" } },
});

/** A Notion stand-in manifest installed under a temp home's connectors folder (id notion). */
function installNotionStandIn(home: string, matches: unknown = { mcpTools: ["mcp__notion__notion-update-page"], subjects: { "mcp__notion__notion-update-page": "notion://page/{page_id:hex}" } }) {
  const dir = path.join(home, "connectors", "notion");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "notion", version: "0.0.1", entry: "state", matches, run: ["node", "x.mjs"] }));
}

async function drive(localProcess: unknown, payload: (r: Rig) => unknown = preCall, install: ((home: string) => void) | null = installNotionStandIn) {
  const r = await makeRig();
  rigs.push(r);
  install?.(r.home);
  const started = performance.now();
  const res: any = await runHook({
    argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder],
    env: { COCHECK_HOME: r.home },
    stdin: (async function* () { yield Buffer.from(JSON.stringify(payload(r))); })(),
    localProcess,
  } as any);
  return { res, ms: performance.now() - started };
}

/** A local-process stand-in whose connector hangs: the request never settles. */
function hangingProcess() {
  const requests: any[] = [];
  return { requests, request: (req: unknown) => { requests.push(req); return new Promise(() => {}); } };
}

describe("the before-snapshot request path in the pre-call hook", () => {
  it("returns within the 1.5 s budget plus margin when the state connector hangs, having asked for the snapshot", async () => {
    const local = hangingProcess();
    const { res, ms } = await drive(local);
    assert.equal(local.requests.length, 1, "the hook asked the local process for a before-snapshot");
    assert.equal(local.requests[0].kind, "before-snapshot");
    assert.equal(local.requests[0].subject, SUBJECT);
    assert.equal(local.requests[0].budgetMs, BUDGET_MS);
    assert.ok(ms < BUDGET_MS + MARGIN_MS, `hook took ${Math.round(ms)} ms, over ${BUDGET_MS}+${MARGIN_MS}`);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.stdout, "", "no decision on stdout: the call proceeds");
  });

  it("records the before side unknown with confidence opaque when the budget passes (never silently dropped)", async () => {
    const { res } = await drive(hangingProcess());
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(res.beforeSide, { subject: SUBJECT, state: "unknown", confidence: "opaque" });
  });

  it("records the before side unknown/opaque when the local process fails the request", async () => {
    const { res } = await drive({ request: async () => { throw new Error("connector pool down"); } });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(res.beforeSide, { subject: SUBJECT, state: "unknown", confidence: "opaque" });
  });

  it("keeps a snapshot that arrives in time (the budget is a ceiling, not an always-unknown path)", async () => {
    const { res, ms } = await drive({ request: async () => ({ ref: "snap-1" }) });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(res.beforeSide, { subject: SUBJECT, state: "snapshot", ref: "snap-1" });
    assert.ok(ms < BUDGET_MS, "a prompt answer does not wait out the budget");
  });

  it("never spawns a connector (or any child process) itself", async () => {
    // The adapter's existing sealing reads its key through `security` (spawnSync): not a connector, and not what this test pins. An in-memory key keeps that out of the spy.
    setKeyProvider(memoryKeyProvider());
    const calls: string[] = [];
    const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
    const originals = names.map((n) => (childProcess as any)[n]);
    names.forEach((n) => { (childProcess as any)[n] = (...a: unknown[]) => { calls.push(`${n} ${String(a[0])}`); throw new Error("spawn blocked by test"); }; });
    syncBuiltinESMExports();
    let res: any;
    const local = hangingProcess();
    try {
      ({ res } = await drive(local));
    } finally {
      names.forEach((n, i) => { (childProcess as any)[n] = originals[i]; });
      syncBuiltinESMExports();
      setKeyProvider(null);
    }
    assert.equal(local.requests.length, 1, "it asked the local process instead");
    // On Windows the data-folder lockdown asks the OS who the user is (whoami) and sets the ACL (icacls): not a connector either.
    assert.deepEqual(calls.filter((c) => !/\b(whoami|icacls)(\.exe)?$/i.test(c)), []);
    assert.deepEqual(res.beforeSide, { subject: SUBJECT, state: "unknown", confidence: "opaque" });
  });

  it("persists the before side in the session's journal, readable after a fresh open", async () => {
    for (const [lp, want] of [[{ request: async () => ({ ref: "snap-9" }) }, { subject: SUBJECT, state: "snapshot", ref: "snap-9" }], [hangingProcess(), { subject: SUBJECT, state: "unknown", confidence: "opaque" }]] as const) {
      const { res } = await drive(lp);
      assert.deepEqual(res.beforeSide, want);
      const r = rigs[rigs.length - 1];
      const recs = readJournalSession(r.home, journalSessionKey(preCall(r).session_id));
      const side = recs.filter((x) => x.k === "before-side");
      assert.equal(side.length, 1);
      assert.equal(side[0].ref, "toolu_notion_1");
      assert.deepEqual(side[0].side, want);
    }
  });

  it("with no localProcess (production today) records unknown/opaque without waiting", async () => {
    const { res, ms } = await drive(undefined);
    assert.deepEqual(res.beforeSide, { subject: SUBJECT, state: "unknown", confidence: "opaque" });
    assert.ok(ms < BUDGET_MS);
  });

  it("a synchronous throw from localProcess records unknown/opaque", async () => {
    const { res } = await drive({ request: () => { throw new Error("sync"); } });
    assert.deepEqual(res.beforeSide, { subject: SUBJECT, state: "unknown", confidence: "opaque" });
  });

  it("never calls localProcess for a Write on a file path, and records no beforeSide", async () => {
    const local = hangingProcess();
    const { res } = await drive(local, (r) => ({ ...preCall(r), tool_name: "Write", tool_input: { file_path: path.join(r.folder, "a.txt"), content: "x" } }));
    assert.equal(local.requests.length, 0);
    assert.equal(res.beforeSide, undefined);
  });

  it("never calls localProcess for an MCP tool with no template, and records no beforeSide", async () => {
    const local = hangingProcess();
    const { res } = await drive(local, (r) => ({ ...preCall(r), tool_name: "mcp__notion__notion-fetch" }));
    assert.equal(local.requests.length, 0);
    assert.equal(res.beforeSide, undefined);
  });

  it("an invalid installed manifest (a problem in it) offers no template and the hook still exits 0", async () => {
    const local = hangingProcess();
    const { res, ms } = await drive(local, preCall, (home) => installNotionStandIn(home, { subjects: { "mcp__notion__notion-update-page": "notion://page/{page-id}" }, mcpTools: ["x"] }));
    assert.equal(local.requests.length, 0);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.beforeSide, undefined);
    assert.ok(ms < BUDGET_MS);
  });
});

describe("the hook's production localProcess", () => {
  it("gives unknown/opaque fast when no review process is recorded, and never starts a server or connector", async () => {
    const { res, ms } = await drive(undefined);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(res.beforeSide, { subject: SUBJECT, state: "unknown", confidence: "opaque" });
    assert.ok(ms < BUDGET_MS, "a missing review-server.json is not a wait");
  });

  it("gives unknown/opaque inside the budget when the recorded port has nothing listening", async () => {
    const { res, ms } = await drive(undefined, preCall, (home) => {
      installNotionStandIn(home);
      writeFileSync(path.join(home, "review-server.json"), JSON.stringify({ pid: 1, port: 1 }));
      writeFileSync(path.join(home, "review-token"), "t\n");
    });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(res.beforeSide, { subject: SUBJECT, state: "unknown", confidence: "opaque" });
    assert.ok(ms < BUDGET_MS + MARGIN_MS);
  });
});
