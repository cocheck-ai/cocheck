import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { startReviewServer } from "../src/review-server.ts";
import { httpLocalProcess } from "../src/connector/local-process.ts";
import { OUTCOME_REASON } from "../src/connector/after-snapshot.ts";
import { loadTimeline } from "../src/timeline/load.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// Three before facts, never merged. snapshot: a sealed ref. absent: the before-snapshot route answered 200 with `ref` exactly null (the connector said
// the item does not exist). unknown: everything else. An absent before with an after state is a created row (prevSha256 null); an unknown one records nothing
// unless an earlier row of the subject holds a sealed after.

// The stand-in connector: its state for the subject is a file (missing = the item does not exist); while the flag file exists its snapshot answer is malformed,
// so the route answers an error status (a failed read).
const STAND_IN = `
import readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "hello") return process.stdout.write(JSON.stringify({ id: msg.id, result: { name: "stand-in" } }) + "\\n");
  if (existsSync(process.argv[3])) return process.stdout.write(JSON.stringify({ id: msg.id, result: { subject: msg.params.subject, state: 5 } }) + "\\n");
  let state = null;
  try { state = readFileSync(process.argv[2], "utf8"); } catch {}
  process.stdout.write(JSON.stringify({ id: msg.id, result: { subject: msg.params.subject, state } }) + "\\n");
});
`;
const SUBJECT = "notion://page/2f6c0e9b11a14b7e9a531d2f6c0e9b11";
const SESSION = "5d2e1b63-4b7e-4f06-9a53-1d2f6c0e9b11";
const TOKEN = "tok-T471";
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const waitFor = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

let rig: Rig, ledger: Ledger, server: http.Server, port: number, stateFile: string, failFlag: string, scratch: string;
const rows = () => ledger.allTaskIds().flatMap((id) => ledger.fileStatesForTask(id)).filter((r) => r.connector != null);
const outcomeOf = (call: string) => ledger.allCaptureOutcomes().filter((o) => o.call === call).at(-1)?.outcome;
const payload = (event: "PreToolUse" | "PostToolUse", call: string) => ({
  session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: event, tool_name: "mcp__notion__notion-update-page", tool_use_id: call,
  tool_input: { page_id: "2f6c0e9b-11a1-4b7e-9a53-1d2f6c0e9b11", properties: { Status: "Done" } }, ...(event === "PostToolUse" ? { tool_response: { ok: true } } : {}),
});
const drive = async (event: "PreToolUse" | "PostToolUse", call: string) => {
  const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload(event, call))); })(), localProcess: httpLocalProcess(rig.home) } as any);
  assert.equal(res.exitCode, 0, res.stderr);
  return res;
};
const setState = (s: string | null) => (s === null ? rmSync(stateFile, { force: true }) : writeFileSync(stateFile, s));
/** One call through the hook client and the route: `beforePre` runs before the pre hook, `beforePost` (the agent's change) before the post hook; waits for the call's capture outcome. */
async function call(id: string, beforePre: () => void, beforePost: () => void) {
  beforePre();
  const pre = await drive("PreToolUse", id);
  beforePost();
  await drive("PostToolUse", id);
  await waitFor(() => outcomeOf(id) !== undefined);
  return pre.beforeSide as { state: string } | undefined;
}

before(async () => {
  setKeyProvider(memoryKeyProvider());
  rig = await makeRig();
  scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  stateFile = path.join(scratch, "state");
  failFlag = path.join(scratch, "fail");
  const dir = path.join(rig.home, "connectors", "notion");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "stand-in.mjs"), STAND_IN);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "notion", version: "0.0.1", entry: "state", matches: { mcpTools: ["mcp__notion__notion-update-page"], subjects: { "mcp__notion__notion-update-page": "notion://page/{page_id:hex}" } }, run: ["node", "stand-in.mjs", stateFile, failFlag] }));
  ledger = openLedger(rig.home);
  const started = await startReviewServer(ledger, TOKEN, rig.home, 0, () => { server.close(); server.closeAllConnections(); });
  server = started.server;
  port = started.port;
  writeFileSync(path.join(rig.home, "review-server.json"), JSON.stringify({ port }));
  writeFileSync(path.join(rig.home, "review-token"), TOKEN);
});
after(async () => {
  if (server.listening) await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  ledger.close();
  setKeyProvider(null);
  await rig.cleanup();
});

/** A one-shot server answering every request with `status` and `body`, and a home pointing the hook client at it. */
async function answering(status: number, body: string): Promise<{ home: string; close: () => Promise<void> }> {
  const s = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); }); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const home = mkdtempSync(path.join(scratch, "home-"));
  writeFileSync(path.join(home, "review-server.json"), JSON.stringify({ port: (s.address() as { port: number }).port }));
  writeFileSync(path.join(home, "review-token"), "t");
  return { home, close: () => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }) };
}

describe("the hook client tells absent from unknown", () => {
  it("a 200 whose ref is exactly null resolves as absent ({ref: null})", async () => {
    const srv = await answering(200, JSON.stringify({ ref: null }));
    try {
      assert.deepEqual(await httpLocalProcess(srv.home).request({ kind: "before-snapshot", subject: SUBJECT, budgetMs: 2000 }), { ref: null });
    } finally {
      await srv.close();
    }
  });

  it("DANGEROUS DIRECTION: every other answer without a ref still rejects (no ref key, empty or non-string ref, an error status with ref null, malformed JSON)", async () => {
    for (const [status, body] of [[200, "{}"], [200, JSON.stringify({ ref: "" })], [200, JSON.stringify({ ref: 0 })], [200, JSON.stringify({ ref: false })], [200, "null"], [200, "not json"], [500, JSON.stringify({ ref: null })], [404, JSON.stringify({ ref: null })], [502, JSON.stringify({ error: "x" })]] as const) {
      const srv = await answering(status, body);
      try {
        await assert.rejects(httpLocalProcess(srv.home).request({ kind: "before-snapshot", subject: SUBJECT, budgetMs: 2000 }), `${status} ${body} must reject`);
      } finally {
        await srv.close();
      }
    }
  });
});

describe("the after-snapshot route's beforeAbsent field", () => {
  const post = (body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const text = JSON.stringify(body);
      const r = http.request({ hostname: "127.0.0.1", port, path: `/connector/after-snapshot?t=${TOKEN}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      r.on("error", reject);
      r.end(text);
    });
  const base = { client: "claude:route-probe", task: null, call: "toolu_route", subject: "notion://page/00000000000000000000000000000000" };

  it("DANGEROUS DIRECTION: beforeAbsent true with a non-null before is refused as malformed; a non-boolean beforeAbsent is refused", async () => {
    assert.equal(await post({ ...base, before: sha("x"), beforeAbsent: true }), 400);
    assert.equal(await post({ ...base, before: null, beforeAbsent: "true" }), 400);
    assert.equal(await post({ ...base, before: null, beforeAbsent: 1 }), 400);
  });

  it("beforeAbsent true with before null is accepted", async () => {
    assert.equal(await post({ ...base, before: null, beforeAbsent: true }), 202);
  });
});

describe("end to end: creation, deletion, re-creation, a failed before read, an unknown before", () => {
  const ids = { create: "toolu_c1", del: "toolu_d1", recreate: "toolu_c2", del2: "toolu_d2", failed: "toolu_f1", unknown: "toolu_u1" };

  it("an absent before and an absent after records nothing (the session's first call: it also opens the task, so every later call is placed on the page)", async () => {
    const id = "toolu_n1";
    const n = rows().length;
    const side = await call(id, () => setState(null), () => {});
    assert.equal(side?.state, "absent");
    assert.equal(rows().length, n);
    assert.notEqual(outcomeOf(id), "recorded");
    assert.notEqual(outcomeOf(id), "no-before");
  });

  it("first creation: the before side is absent and one row with prevSha256 null is credited to the call", async () => {
    setState(null);
    const side = await call(ids.create, () => {}, () => setState("v1"));
    assert.equal(outcomeOf(ids.create), "recorded", "a created item is recorded, not dropped as no-before");
    assert.equal(side?.state, "absent");
    const mine = rows().filter((r) => r.credited.includes(ids.create));
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.prevSha256, null);
    assert.equal(mine[0]!.sha256, sha("v1"));
    assert.equal(mine[0]!.kept, "whole");
    assert.deepEqual(mine[0]!.credited, [ids.create]);
  });

  it("deletion: a gone row whose prev is the created state", async () => {
    const side = await call(ids.del, () => {}, () => setState(null));
    assert.equal(side?.state, "snapshot");
    const r = rows().filter((x) => x.credited.includes(ids.del));
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kept, "gone");
    assert.equal(r[0]!.prevSha256, sha("v1"));
  });

  it("re-creation after a gone row: an absent before and an existing after record a created row", async () => {
    const side = await call(ids.recreate, () => {}, () => setState("v2"));
    assert.equal(outcomeOf(ids.recreate), "recorded");
    assert.equal(side?.state, "absent");
    const r = rows().filter((x) => x.credited.includes(ids.recreate));
    assert.equal(r.length, 1);
    assert.equal(r[0]!.prevSha256, null);
    assert.equal(r[0]!.sha256, sha("v2"));
    assert.equal(r[0]!.kept, "whole");
  });

  it("DANGEROUS DIRECTION: a failed before read (the route answers an error) is unknown, never absent: after a gone row it records nothing", async () => {
    await call(ids.del2, () => {}, () => setState(null));
    assert.equal(rows().filter((x) => x.credited.includes(ids.del2))[0]?.kept, "gone");
    const n = rows().length;
    // The item exists again (made outside the agent), but CoCheck cannot read it before the call.
    const side = await call(ids.failed, () => { setState("v3"); writeFileSync(failFlag, "1"); }, () => { rmSync(failFlag, { force: true }); setState("v4"); });
    assert.equal(side?.state, "unknown");
    assert.equal(outcomeOf(ids.failed), "no-before");
    assert.equal(rows().length, n, "no created row for an item whose before read failed");
  });

  it("DANGEROUS DIRECTION: an unknown before (no review process recorded at pre time) records nothing", async () => {
    const tok = path.join(rig.home, "review-token");
    const n = rows().length;
    const side = await call(ids.unknown, () => { setState(null); renameSync(tok, `${tok}.off`); }, () => { renameSync(`${tok}.off`, tok); setState("v5"); });
    assert.equal(side?.state, "unknown");
    assert.equal(outcomeOf(ids.unknown), "no-before");
    assert.equal(rows().length, n);
    assert.ok(existsSync(tok));
  });

  it("the loaded timeline shows each created row as a created step, and the could-not-read gap only on the unknown calls", async () => {
    const taskId = rows()[0]!.taskId;
    const { timeline } = await loadTimeline(ledger, rig.home, taskId, { build: "t", quickLook: false });
    const calls = new Map<string, { changes: Array<{ kind: string }>; captureGap?: { reason: string } }>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v === null || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if (typeof o.id === "string" && Array.isArray(o.changes) && "outcome" in o) calls.set(o.id, o as never);
      Object.values(o).forEach(walk);
    };
    walk(timeline);
    for (const id of [ids.create, ids.recreate]) {
      assert.deepEqual(calls.get(id)?.changes.map((c) => c.kind), ["created"], `${id} shows a created step`);
      assert.equal(calls.get(id)?.captureGap, undefined, `${id} has no gap`);
    }
    for (const id of [ids.del, ids.del2]) assert.deepEqual(calls.get(id)?.changes.map((c) => c.kind), ["deleted"]);
    for (const id of [ids.failed, ids.unknown]) {
      assert.equal(calls.get(id)?.captureGap?.reason, OUTCOME_REASON["no-before"], `${id} shows the could-not-read gap`);
      assert.deepEqual(calls.get(id)?.changes, []);
    }
    assert.equal(timeline.unplaced.length, 0, "every row is placed under its call");
    for (const id of [ids.create, ids.del, ids.recreate, ids.del2, "toolu_n1"]) assert.equal(calls.get(id)?.captureGap, undefined, `${id} has no gap`);
  });
});
