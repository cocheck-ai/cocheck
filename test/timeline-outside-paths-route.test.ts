import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir, storeDirOf } from "../src/states.ts";

// GET /timeline/<task>/outside-paths. Real ledger and server in a temp home; no real Quick Look, no real model.

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const SENT = "/Users/outsider-SENTINELDIR/hidden";
const SENT2 = "/Users/other-SENTINELDIR2";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const get = (p: string, opts: { token?: string | null; headers?: Record<string, string>; host?: string; method?: string } = {}) => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const url = token === null ? p : `${p}${p.includes("?") ? "&" : "?"}t=${token}`;
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  };
  const task = async (files: Array<{ file: string; text: string }>): Promise<number> => {
    const id = ledger.openTask(CLIENT);
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    const callId = `toolu_${id}`;
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "make files", clientName: CLIENT, durationMs: 1, resultCode: "OK",
      args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: files.map((f) => f.file), description: "make files", narration: { source: "none", text: "no narration recorded" } } });
    ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK",
      args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Make some files."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
    let seq = 0;
    for (const f of files) {
      await writeSealed(path.join(states, sha(f.text)), f.text);
      ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: f.file, sha256: sha(f.text), prevSha256: null, size: f.text.length, kept: "whole", note: "" }] });
    }
    return id;
  };
  return { get, task, ledger };
}

const FILES = [
  { file: "/work/in.txt", text: "inside\n" },
  { file: `${SENT}/scratch.txt`, text: "scratch\n" },
  { file: `${SENT}/twin.txt`, text: "twin one\n" },
  { file: `${SENT2}/twin.txt`, text: "twin two\n" },
  { file: `${SENT}/.env`, text: "TOKEN=abc\n" },
  { file: `${SENT2}/renamed.txt`, text: "TOKEN=abc\n" },
];

describe("GET /timeline/<task>/outside-paths", () => {
  it("lists the real directory of each outside, non-secret file; every directory of a shared name; nothing for secrets or in-folder files", async () => {
    const s = await setup();
    const id = await s.task(FILES);
    const res = await s.get(`/timeline/${id}/outside-paths`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"]!, /^application\/json/);
    assert.equal(res.headers["cache-control"], "private, no-store");
    assert.deepEqual(JSON.parse(res.body), { "/outside/scratch.txt": [SENT], "/outside/twin.txt": [SENT, SENT2] });
    assert.ok(!res.body.includes(".env") && !res.body.includes("renamed"), "a secret file shows no path");
    assert.ok(!res.body.includes("/work"), "an in-folder file is not listed");
  });

  it("has the token, Host, Origin and method checks of every timeline route, and answers only for a real task", async () => {
    const s = await setup();
    const id = await s.task(FILES);
    const p = `/timeline/${id}/outside-paths`;
    assert.equal((await s.get(p, { token: null })).status, 403);
    assert.equal((await s.get(p, { token: "x".repeat(40) })).status, 403);
    assert.equal((await s.get(p, { headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await s.get(p, { method: "POST" })).status, 405);
    assert.ok([400, 403, 421].includes((await s.get(p, { host: "evil.example" })).status));
    assert.equal((await s.get(`/timeline/${id + 99}/outside-paths`)).status, 404);
  });

  it("no outside directory reaches the timeline body or the rail model", async () => {
    const s = await setup();
    const id = await s.task(FILES);
    const body = await s.get(`/timeline/${id}`);
    const model = await s.get(`/timeline/${id}/review/model`);
    for (const [name, text] of [["body", body.body], ["model", model.body]] as const) {
      assert.equal(body.status, 200);
      assert.ok(!text.includes("SENTINELDIR"), `${name} holds an outside directory`);
    }
    assert.ok(model.body.includes("scratch.txt"), "the outside file itself is in the model, by name");
  });
});
