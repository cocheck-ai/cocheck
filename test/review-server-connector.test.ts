import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, setKeyProvider, writeSealed } from "../src/seal.ts";
import { ensureStoreDir } from "../src/states.ts";
import { removeHome } from "./helpers/remove-home.ts";

// The review page body reads connector rows through the installed connector (createConnectorDiff), per row: a connector that is missing,
// failing or hanging leaves that row `unavailable` and the rest of the body loads; installing or removing a connector changes the cached body.
const ROOT = path.resolve(import.meta.dirname, "..");
const TOY = path.join(ROOT, "public-kit", "conformance", "fixtures", "toy");
const HANG = path.join(import.meta.dirname, "fixtures", "connector-diff", "hang");
const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const notes = (...n: Array<[string, string]>) => JSON.stringify({ notes: n.map(([id, text]) => ({ id, text })) });
const BEFORE = notes(["n1", "buy milk"]), AFTER = notes(["n1", "buy oat milk"]);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); setKeyProvider(null); });

async function setup(connectorId: string, connectorTimeoutMs?: number) {
  setKeyProvider(memoryKeyProvider());
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false, ...(connectorTimeoutMs === undefined ? {} : { connectorTimeoutMs }) });
  cleanups.push(async () => { await new Promise<void>((r) => (server as Server).close(() => r())); ledger.close(); await removeHome(home); });
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
  for (const body of [BEFORE, AFTER]) await writeSealed(path.join(states, sha(body)), body);
  ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Fix the notes."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
  const callId = "toolu_1";
  ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [], description: "edit", narration: { source: "none", text: "n" } } });
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: "/work/edit.notes.json", sha256: sha(AFTER), prevSha256: sha(BEFORE), size: AFTER.length, kept: "whole", note: "", connector: connectorId }] });
  const get = (p: string, inm?: string): Promise<{ status: number; body: string; etag?: string }> => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, method: "GET", headers: { host: `127.0.0.1:${port}`, ...(inm ? { "if-none-match": inm } : {}) } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), etag: res.headers.etag as string | undefined }));
    });
    req.on("error", reject); req.end();
  });
  const install = async (dir: string, as: string) => { await mkdir(path.join(home, "connectors"), { recursive: true }); await cp(dir, path.join(home, "connectors", as), { recursive: true }); };
  const remove = (as: string) => removeHome(path.join(home, "connectors", as));
  const extraRows = (n: number) => { for (let i = 0; i < n; i++) ledger.recordStep({ taskId: id, client: CLIENT, seq: 10 + i, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: `/work/more${i}.notes.json`, sha256: sha(AFTER), prevSha256: sha(BEFORE), size: AFTER.length, kept: "whole", note: "", connector: connectorId }] }); };
  // A row whose stored "after" state blob was never written (as if expired or lost).
  const missingBlobRow = () => ledger.recordStep({ taskId: id, client: CLIENT, seq: 9, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: "/work/gone.notes.json", sha256: sha("never stored"), prevSha256: sha(BEFORE), size: 5, kept: "whole", note: "", connector: connectorId }] });
  return { id, extraRows, missingBlobRow, home, get, install, remove };
}

/** The connector DiffObject of the task's one change, read off the parsed body (the generic text diff also holds the raw words, so the string is no proof). */
const diffOf = (body: string): { changes: Array<{ after?: { value?: unknown } }>; unavailable?: string } => {
  const t = JSON.parse(body);
  return t.requests[0].runs[0].calls[0].changes[0].diff;
};

describe("review body reads connector rows through the installed connector", () => {
  it("an installed connector's changes are on the body", async () => {
    const s = await setup("toy-notes");
    await s.install(TOY, "toy-notes");
    const r = await s.get(`/timeline/${s.id}`);
    assert.equal(r.status, 200);
    const d = diffOf(r.body);
    assert.equal(d.unavailable, undefined);
    assert.deepEqual(d.changes.map((c) => c.after?.value), ["buy oat milk"]);
  });

  it("a connector that is not installed leaves that row unavailable and the body still loads", async () => {
    const s = await setup("toy-notes");
    const r = await s.get(`/timeline/${s.id}`);
    assert.equal(r.status, 200);
    assert.match(diffOf(r.body).unavailable ?? "", /toy-notes.*not installed/);
    assert.ok(JSON.parse(r.body).requests.length > 0, "the rest of the page is there");
  });

  it("a hanging connector cannot stall the body; its row is unavailable", async () => {
    const s = await setup("fx-hang", 500);
    await s.install(HANG, "fx-hang");
    const t0 = Date.now();
    const r = await s.get(`/timeline/${s.id}`);
    assert.ok(Date.now() - t0 < 8000, "returned promptly");
    assert.equal(r.status, 200);
    assert.match(diffOf(r.body).unavailable ?? "", /fx-hang.*timed out/);
    assert.ok(JSON.parse(r.body).requests.length > 0);
  });

  it("installing or removing a connector changes the cached body", async () => {
    const s = await setup("toy-notes");
    const a = await s.get(`/timeline/${s.id}`);
    assert.match(diffOf(a.body).unavailable ?? "", /not installed/);
    await s.install(TOY, "toy-notes");
    const b = await s.get(`/timeline/${s.id}`);
    assert.equal(diffOf(b.body).unavailable, undefined, "a stale page after install is the bug");
    assert.equal(diffOf(b.body).changes.length, 1);
    await s.remove("toy-notes");
    const c = await s.get(`/timeline/${s.id}`);
    assert.match(diffOf(c.body).unavailable ?? "", /not installed/, "removed: the row is unavailable again");
  });

  it("the JSON route's ETag moves with the installed connectors: the old tag gets a 200 with the new body, the current tag a 304", async () => {
    const s = await setup("toy-notes");
    const a = await s.get(`/timeline/${s.id}`);
    assert.ok(a.etag);
    assert.equal((await s.get(`/timeline/${s.id}`, a.etag)).status, 304, "unchanged: 304");
    await s.install(TOY, "toy-notes");
    const b = await s.get(`/timeline/${s.id}`, a.etag);
    assert.equal(b.status, 200, "a 304 here would be the stale page after install");
    assert.notEqual(b.etag, a.etag);
    assert.equal(diffOf(b.body).unavailable, undefined);
    assert.equal((await s.get(`/timeline/${s.id}`, b.etag)).status, 304);
  });

  it("three rows on a hanging connector cost one wait, and all three are unavailable", async () => {
    const s = await setup("fx-hang", 1500);
    s.extraRows(2);
    await s.install(HANG, "fx-hang");
    const t0 = Date.now();
    const r = await s.get(`/timeline/${s.id}`);
    assert.ok(Date.now() - t0 < 2 * 1500, "one timeout, not three");
    assert.equal(r.status, 200);
    const diffs: Array<{ unavailable?: string }> = [];
    const walk = (x: unknown): void => { if (Array.isArray(x)) x.forEach(walk); else if (x !== null && typeof x === "object") { const o = x as Record<string, unknown>; if (o.spec === "cocheck.diff/1") diffs.push(o as { unavailable?: string }); else Object.values(o).forEach(walk); } };
    walk(JSON.parse(r.body));
    assert.equal(diffs.length, 3);
    for (const d of diffs) assert.match(d.unavailable ?? "", /fx-hang.*(timed out|did not)/);
  });

  it("a row with a missing state blob is that row's alone; the healthy connector still draws the good rows, from one warm start", async () => {
    const s = await setup("toy-notes");
    s.missingBlobRow(); // recorded before the second good row, so a connector marked down at the bad row would fail it
    s.extraRows(1);
    await s.install(TOY, "toy-notes");
    const log = path.join(s.home, "starts.log");
    const file = path.join(s.home, "connectors", "toy-notes", "connector.mjs");
    await writeFile(file, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, "s\\n");\n` + (await readFile(file, "utf8")));
    const r = await s.get(`/timeline/${s.id}`);
    assert.equal(r.status, 200);
    const diffs: Array<{ unavailable?: string; changes?: unknown[] }> = [];
    const walk = (x: unknown): void => { if (Array.isArray(x)) x.forEach(walk); else if (x !== null && typeof x === "object") { const o = x as Record<string, unknown>; if (o.spec === "cocheck.diff/1") diffs.push(o as { unavailable?: string }); else Object.values(o).forEach(walk); } };
    walk(JSON.parse(r.body));
    assert.equal(diffs.length, 3);
    assert.equal(diffs.filter((d) => d.unavailable !== undefined).length, 1, "only the missing-blob row is unavailable");
    assert.equal(diffs.filter((d) => d.unavailable === undefined && (d.changes?.length ?? 0) === 1).length, 2, "both good rows drawn");
    // One warm process per connector serves both good rows (it was one start per row before).
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1, "one warm connector start serves both good rows");
  });
});
