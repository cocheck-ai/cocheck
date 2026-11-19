import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import type { FormatLayer } from "../src/formats/layer.ts";

// The review shell answers before the timeline is built. The build is made slow by a layer whose diff waits; the shell must not wait for it,
// and the model (built on its own request) must be the same on a cold and a warm server.

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const SLOW_MS = 1500;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const slowLayer = { name: "slow", accepts: () => true, diff: async () => { await new Promise((r) => setTimeout(r, SLOW_MS)); return []; } } as unknown as FormatLayer;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function routeSetup(layers: FormatLayer[] = []) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-rail-home-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => { throw new Error("no render"); }, quickLook: false, layers });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
  const t0 = "one\n", t1 = "two\n";
  for (const text of [t0, t1]) await writeSealed(path.join(states, sha(text)), text);
  ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Fix the notes."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
  ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: "toolu_1", closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: ["/work/notes.txt"], description: "edit the notes", narration: { source: "none", text: "none" }, outsideRefs: [] } });
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: ["toolu_1"], credited: ["toolu_1"], files: [{ filePath: "/work/notes.txt", sha256: sha(t0), prevSha256: null, size: 4, kept: "whole", note: "" }] });
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 2, phase: "Post", callsOpen: ["toolu_1"], credited: ["toolu_1"], files: [{ filePath: "/work/notes.txt", sha256: sha(t1), prevSha256: sha(t0), size: 4, kept: "whole", note: "" }] });
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 3, phase: "Post", callsOpen: ["toolu_1"], credited: ["toolu_1"], files: [{ filePath: "/elsewhere/deep/backup.txt", sha256: sha(t1), prevSha256: null, size: 4, kept: "whole", note: "" }] });
  const get = (p: string, opts: { token?: string | null; host?: string; method?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const token = opts.token === undefined ? TOKEN : opts.token;
      const url = token === null ? p : `${p}${p.includes("?") ? "&" : "?"}t=${token}`;
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  return { id, get };
}

describe("the review shell does not wait for the timeline build", () => {
  it("answers the shell fast while the build is slow, and builds on the model request", async () => {
    const { id, get } = await routeSetup([slowLayer]);
    const t0 = Date.now();
    const shell = await get(`/timeline/${id}/review`);
    const shellMs = Date.now() - t0;
    assert.equal(shell.status, 200);
    assert.equal(shell.body, renderReviewShell(id));
    assert.ok(shellMs < SLOW_MS / 2, `the shell took ${shellMs} ms against a ${SLOW_MS} ms build`);
    const t1 = Date.now();
    const model = await get(`/timeline/${id}/review/model`);
    assert.equal(model.status, 200);
    assert.ok(Date.now() - t1 >= SLOW_MS - 100, "the model request is where the build happens");
  });

  it("a warm server gives the same shell and the same model as the cold one", async () => {
    const { id, get } = await routeSetup([slowLayer]);
    const coldShell = await get(`/timeline/${id}/review`);
    const coldModel = await get(`/timeline/${id}/review/model`);
    const t = Date.now();
    const warmShell = await get(`/timeline/${id}/review`);
    const warmModel = await get(`/timeline/${id}/review/model`);
    assert.ok(Date.now() - t < SLOW_MS / 2, "the second model is served from the cache");
    assert.equal(warmShell.body, coldShell.body);
    assert.equal(warmModel.body, coldModel.body);
    assert.ok(JSON.parse(coldModel.body).stops.length >= 2);
  });

  it("a wrong token or an unknown task still gets no shell", async () => {
    const { id, get } = await routeSetup([slowLayer]);
    assert.equal((await get(`/timeline/${id}/review`, { token: "x".repeat(40) })).status, 403);
    assert.equal((await get(`/timeline/999999/review`)).status, 404);
  });
});
