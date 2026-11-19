import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { readSealed, memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { storeDirOf } from "../src/states.ts";
import { adoptConnectorState, connectorStatesDir } from "../src/connector/before-snapshot.ts";
import { startReviewServer } from "../src/review-server.ts";
import { checkSnapshotAnswer } from "../src/connector/schema.ts";
import { httpLocalProcess } from "../src/connector/local-process.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { makeRig } from "./hook-corpus.ts";

// The review server answers before-snapshots through a connector pool. The stand-in connector is a real child process speaking the
// line protocol; the server is a real in-process one on 127.0.0.1 (port 0). Every spawn is logged by the child itself.
const STAND_IN = `
import readline from "node:readline";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.SPAWN_LOG ?? process.argv[2], process.pid + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "hello") return process.stdout.write(JSON.stringify({ id: msg.id, result: { name: "stand-in" } }) + "\\n");
  const subject = msg.params.subject;
  if (subject.includes("hang")) return;
  if (subject.includes("die")) process.exit(3);
  const state = subject.includes("missing") ? null : subject.includes("bad") ? 5 : "state of " + subject + " \\u00e9";
  process.stdout.write(JSON.stringify({ id: msg.id, result: { subject, state } }) + "\\n");
});
`;

const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
const home = path.join(scratch, "home");
const spawnLog = path.join(scratch, "spawns.log");
let ledger: Ledger;
let server: http.Server;
let port = 0;
let shutdownCalled = 0;
const TOKEN = "tok-T387";

const spawns = (): number[] => {
  try {
    return readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const post = async (body: unknown, p = "/connector/before-snapshot?t=" + TOKEN) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const waitFor = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

before(async () => {
  setKeyProvider(memoryKeyProvider());
  mkdirSync(home, { recursive: true });
  const dir = path.join(home, "connectors", "notion");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "stand-in.mjs"), STAND_IN);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "notion", version: "0.0.1", entry: "state", matches: { schemes: ["notion"] }, run: ["node", "stand-in.mjs", spawnLog] }));
  const odd = path.join(home, "connectors", "linear");
  mkdirSync(odd, { recursive: true });
  writeFileSync(path.join(odd, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "linear", version: "0.0.1", entry: "state", matches: { mcpTools: ["mcp__linear__update"], subjects: { "mcp__linear__update": "linear://issue/{id}" } }, run: ["node", "../notion/stand-in.mjs", spawnLog] }));
  ledger = openLedger(home);
  const started = await startReviewServer(ledger, TOKEN, home, 0, () => { shutdownCalled++; server.close(); server.closeAllConnections(); });
  server = started.server;
  port = started.port;
});
after(async () => {
  if (server.listening) await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  await waitFor(() => spawns().every((p) => !alive(p)));
  ledger.close();
});

describe("checkSnapshotAnswer", () => {
  it("accepts text and null state, rejects the rest with the Problem shape", () => {
    assert.deepEqual(checkSnapshotAnswer({ subject: "notion://page/a", state: "{}" }), []);
    assert.deepEqual(checkSnapshotAnswer({ subject: "notion://page/a", state: null }), []);
    for (const bad of [null, [], { state: "x" }, { subject: "s", state: 5 }, { subject: "s", state: { a: 1 } }, { subject: "s" }, { subject: "", state: "x" }]) {
      const p = checkSnapshotAnswer(bad);
      assert.ok(p.length > 0, JSON.stringify(bad));
      assert.deepEqual(Object.keys(p[0]!).sort(), ["expected", "field", "file", "fix", "found"]);
    }
  });
});

describe("POST /connector/before-snapshot", () => {
  it("returns a ref whose sealed bytes equal the connector's state (scheme match)", async () => {
    const r = await post({ subject: "notion://page/abc", budgetMs: 5000 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const state = "state of notion://page/abc é";
    const ref = createHash("sha256").update(Buffer.from(state, "utf8")).digest("hex");
    assert.deepEqual(r.json, { ref });
    assert.equal((await readSealed(path.join(connectorStatesDir(home), ref))).toString("utf8"), state);
    assert.equal(ledger.allTaskIds().length, 0, "no task exists in the ledger: the before side needs none");
    // adopt places the sealed state into a task's store, idempotently; an unknown ref throws.
    await adoptConnectorState(home, 7, ref);
    await adoptConnectorState(home, 7, ref);
    assert.equal((await readSealed(path.join(storeDirOf(home, 7), ref))).toString("utf8"), state);
    await assert.rejects(adoptConnectorState(home, 7, "0".repeat(64)));
    await assert.rejects(adoptConnectorState(home, 7, "../../etc/passwd"));
  });

  it("matches a connector through matches.subjects too", async () => {
    const r = await post({ subject: "linear://issue/9", budgetMs: 5000 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(typeof r.json.ref, "string");
  });

  it("reuses one process across requests and starts a fresh one after it died", async () => {
    const before = spawns().length;
    await post({ subject: "notion://page/one", budgetMs: 5000 });
    await post({ subject: "notion://page/two", budgetMs: 5000 });
    assert.equal(spawns().length - before <= 1, true, "at most one new spawn for two requests (one may already be pooled)");
    // The pooled process dies between requests (killed from outside): the next request starts exactly one fresh process and succeeds.
    const mark = spawns().length;
    for (const p of spawns().filter(alive)) process.kill(p, "SIGKILL");
    await waitFor(() => spawns().every((p) => !alive(p)));
    const after = await post({ subject: "notion://page/after-kill", budgetMs: 5000 });
    assert.equal(after.status, 200, JSON.stringify(after.json));
    assert.equal(spawns().length, mark + 1, "exactly one fresh process after the old one died");
    // A connector that crashes mid-request gives an error, never a ref, and the next request still works.
    const dead = await post({ subject: "notion://page/die", budgetMs: 5000 });
    assert.notEqual(dead.status, 200);
    assert.equal("ref" in dead.json, false);
    const next = await post({ subject: "notion://page/three", budgetMs: 5000 });
    assert.equal(next.status, 200, JSON.stringify(next.json));
  });

  it("answers a JSON error and never a ref: no connector, rejected answer, missing entity, bad body, wrong token", async () => {
    for (const [body, status] of [
      [{ subject: "other://x/1", budgetMs: 1000 }, 404],
      [{ subject: "notion://page/bad", budgetMs: 5000 }, 502],
      [{ subject: "notion://page/gone-missing", budgetMs: 5000 }, 200],
      [{ subject: 5, budgetMs: 1000 }, 400],
      [{ subject: "notion://page/a", budgetMs: 0 }, 400],
    ] as const) {
      const r = await post(body);
      assert.equal(r.status, status, JSON.stringify(body) + JSON.stringify(r.json));
      if (status === 200) assert.deepEqual(r.json, { ref: null });
      else {
        assert.equal(typeof r.json.error, "string");
        assert.equal("ref" in r.json, false);
      }
    }
    assert.equal((await post({ subject: "notion://page/a", budgetMs: 1000 }, "/connector/before-snapshot?t=wrong")).status, 403);
  });

  it("a hanging connector answers a timeout error within budgetMs, never a ref", async () => {
    const t0 = Date.now();
    const r = await post({ subject: "notion://page/hang", budgetMs: 600 });
    const ms = Date.now() - t0;
    assert.equal(r.status, 504, JSON.stringify(r.json));
    assert.equal("ref" in r.json, false);
    assert.ok(ms < 1500, `took ${ms} ms for a 600 ms budget`);
  });

  it("the hook client gives unknown/opaque within budget and the hook exits under 2 s when the connector hangs (must not: a stalled tool call)", async () => {
    const rig = await makeRig();
    try {
      mkdirSync(path.join(rig.home, "connectors", "notion"), { recursive: true });
      writeFileSync(path.join(rig.home, "connectors", "notion", "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "notion", version: "0.0.1", entry: "state", matches: { mcpTools: ["mcp__notion__notion-update-page"], subjects: { "mcp__notion__notion-update-page": "notion://page/{page_id:hex}" } }, run: ["node", "x.mjs"] }));
      writeFileSync(path.join(rig.home, "review-server.json"), JSON.stringify({ pid: process.pid, port }));
      writeFileSync(path.join(rig.home, "review-token"), TOKEN + "\n");
      // The server's own home holds the connector; point the hook's client at it with a task, and ask for a subject that hangs.
      const payload = { session_id: "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11", cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "mcp__notion__notion-update-page", tool_use_id: "t1", tool_input: { page_id: "ffff0000ffff0000ffff0000ffff0000" } };
      const local = httpLocalProcess(rig.home);
      // Stand-in for a hanging subject: the hook renders the hex page id, so ask the server directly for the hanging subject through the same client.
      const t0 = Date.now();
      const direct = await local.request({ kind: "before-snapshot", subject: "notion://page/hang", budgetMs: 1500 }).then(() => "ref", () => "rejected");
      assert.equal(direct, "rejected");
      assert.ok(Date.now() - t0 < 1500 + 400, "the client gives up by the budget");
      const started = Date.now();
      const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })(), localProcess: { request: (req: any) => local.request({ ...req as any, subject: "notion://page/hang" }) } } as any);
      assert.ok(Date.now() - started < 2000, `hook took ${Date.now() - started} ms`);
      assert.equal(res.exitCode, 0, res.stderr);
      assert.deepEqual(res.beforeSide, { subject: "notion://page/ffff0000ffff0000ffff0000ffff0000", state: "unknown", confidence: "opaque" });
    } finally {
      await rig.cleanup();
    }
  });

  it("stops every pooled child when the server shuts down through /shutdown", async () => {
    await post({ subject: "notion://page/alive", budgetMs: 5000 });
    await post({ subject: "linear://issue/1", budgetMs: 5000 });
    const pids = spawns();
    const running = pids.filter(alive);
    assert.ok(running.length >= 2, "notion and linear processes are running");
    const res = await fetch(`http://127.0.0.1:${port}/shutdown?t=${TOKEN}`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(res.status, 200);
    await waitFor(() => shutdownCalled > 0 && pids.every((p) => !alive(p)), 5000);
    assert.equal(shutdownCalled, 1);
    assert.deepEqual(pids.filter(alive), [], "no child outlives /shutdown");
  });
});
