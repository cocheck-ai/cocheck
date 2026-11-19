import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";

// The model route answers 304 without building the rail model only while loaded.etag, live, quietMin, Excel and the AI-lines state are
// all unchanged. Any one of them moving gives a 200 with a new tag, so an AI line, Excel appearing or the quiet minutes ticking shows within one poll.

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
  cleanups.push(async () => { await new Promise<void>((r) => (server as Server).close(() => r())); ledger.close(); await rm(home, { recursive: true, force: true }); });
  const get = (p: string, inm?: string): Promise<{ status: number; etag?: string }> => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, method: "GET", headers: { host: `127.0.0.1:${port}`, ...(inm ? { "if-none-match": inm } : {}) } }, (res) => {
      res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag as string | undefined }));
    });
    req.on("error", reject); req.end();
  });
  const task = async (promptAt: number): Promise<number> => {
    const id = ledger.openTask(CLIENT);
    await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: promptAt, earlier: 0, prompts: ["Write the report."], requests: [{ seq: 1, at: promptAt, firstStep: null }] } });
    return id;
  };
  return { get, task, ledger };
}

/** First ask (200, a tag), then the same ask with the tag: returns the second status. */
async function revalidate(s: Awaited<ReturnType<typeof setup>>, id: number, between: () => Promise<void> | void): Promise<{ first: string; second: { status: number; etag?: string } }> {
  const m = `/timeline/${id}/review/model`;
  const a = await s.get(m);
  assert.equal(a.status, 200);
  assert.ok(a.etag);
  assert.equal((await s.get(m, a.etag)).status, 304, "unchanged: 304 with the tag it holds");
  await between();
  return { first: a.etag!, second: await s.get(m, a.etag) };
}

describe("the model 304 is skipped only while every input of the answer is unchanged", () => {
  it("unchanged: 304 again and again", async () => {
    const s = await setup(); const id = await s.task(Date.now());
    const a = await s.get(`/timeline/${id}/review/model`);
    for (let i = 0; i < 3; i++) assert.equal((await s.get(`/timeline/${id}/review/model`, a.etag)).status, 304);
  });
  it("a changed loaded.etag (a new op) defeats the 304", async () => {
    const s = await setup(); const id = await s.task(Date.now());
    const r = await revalidate(s, id, () => { s.ledger.recordOp({ taskId: id, tool: "hook", intent: "x", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess2", at: Date.now(), earlier: 0, prompts: ["More."], requests: [{ seq: 2, at: Date.now(), firstStep: null }] } }); });
    assert.equal(r.second.status, 200); assert.notEqual(r.second.etag, r.first);
  });
  it("a live flip (a Stop) defeats the 304", async () => {
    const s = await setup(); const id = await s.task(Date.now());
    const r = await revalidate(s, id, () => { s.ledger.recordOp({ taskId: id, tool: "hook", intent: "x", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "Stop", host: "claude", session_id: "sess", at: Date.now(), closing: { source: "agent", text: "Done." } } }); });
    assert.equal(r.second.status, 200); assert.notEqual(r.second.etag, r.first);
  });
  it("live turning false with no new op (the silence limit passes) defeats the 304", async () => {
    const s = await setup(); const id = await s.task(Date.now() - 2 * 3600 * 1000 + 800);
    const r = await revalidate(s, id, () => sleep(1000));
    assert.equal(r.second.status, 200); assert.notEqual(r.second.etag, r.first);
  });
  it("a quietMin tick with no new op defeats the 304", async () => {
    const s = await setup(); const id = await s.task(Date.now() - 16 * 60000 + 800);
    const r = await revalidate(s, id, () => sleep(1000));
    assert.equal(r.second.status, 200); assert.notEqual(r.second.etag, r.first);
  });
  it("a pending body is never cached, so never answered 304 early (the guard sits before the cache write)", () => {
    const src = readFileSync(new URL("../src/review-server.ts", import.meta.url), "utf8");
    assert.match(src, /if \(!hit\.body\.includes\('"pending":true'\)\) deps\.cache\.set\(taskId, hit\);/);
    assert.match(src, /seen\.etag === loaded\.etag && seen\.model !== undefined/);
  });
});
