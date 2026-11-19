import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { setTracking } from "../src/tracking.ts";

// A send-back written while no session of the task is
// tracked says so on the page and in the prompt; it is still allowed and recorded. Guard: a live tracked session gets no warning.

const TOKEN = "s".repeat(40);
const SENTENCE = "CoCheck was not tracking when this was written; ask the person to start tracking before you fix it.";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const task = (session: string): number => {
    const id = ledger.openTask("claude:/work");
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "x", clientName: "claude:/work", durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: `toolu_${id}`, closedBy: "post", openedAt: 1000, closedAt: 2000, host: "claude", session_id: session, tool_name: "Bash", namedFiles: [], description: "x" } });
    return id;
  };
  const sendBack = (id: number, json: unknown): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(json);
      const req = http.request({ hostname: "127.0.0.1", port, path: `/timeline/${id}/review/sendback?t=${TOKEN}`, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", origin: `http://127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  return { home, ledger, task, sendBack };
}

describe("the send-back route says when tracking is off", () => {
  it("a stopped session: the prompt ends with the exact sentence, the answer says untracked, and the send-back is recorded", async () => {
    const s = await setup();
    const id = s.task("sess-a");
    setTracking(s.home, "claude", "sess-a", true, "/work");
    setTracking(s.home, "claude", "sess-a", false);
    const r = await s.sendBack(id, { note: "Redo the totals." });
    assert.equal(r.status, 200);
    assert.equal(r.body.untracked, true);
    assert.ok(r.body.prompt.includes("Redo the totals."));
    assert.ok(r.body.prompt.endsWith(SENTENCE), r.body.prompt);
    const rows = s.ledger.sendBacksForTask(id);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.prompt.includes(SENTENCE), "the recorded prompt carries it too");
  });

  it("a never-started session counts as not tracked", async () => {
    const s = await setup();
    const id = s.task("sess-b");
    const r = await s.sendBack(id, { note: "n" });
    assert.equal(r.body.untracked, true);
    assert.ok(r.body.prompt.includes(SENTENCE));
  });

  it("a live tracked session gets no warning and no sentence; then stopping it turns both on (repeat on both)", async () => {
    const s = await setup();
    const id = s.task("sess-c");
    setTracking(s.home, "claude", "sess-c", true, "/work");
    const live = await s.sendBack(id, { note: "Redo the totals." });
    assert.equal(live.status, 200);
    assert.notEqual(live.body.untracked, true);
    assert.ok(!live.body.prompt.includes("not tracking"));
    assert.ok(!s.ledger.sendBacksForTask(id)[0]!.prompt.includes("not tracking"));
    setTracking(s.home, "claude", "sess-c", false);
    const stopped = await s.sendBack(id, { note: "Redo the totals." });
    assert.equal(stopped.body.untracked, true);
    assert.ok(stopped.body.prompt.endsWith(SENTENCE));
    setTracking(s.home, "claude", "sess-c", true, "/work");
    const again = await s.sendBack(id, { note: "Redo the totals." });
    assert.notEqual(again.body.untracked, true);
    assert.ok(!again.body.prompt.includes("not tracking"));
    assert.equal(s.ledger.sendBacksForTask(id).length, 3);
  });

  it("one tracked session among several is enough for no warning", async () => {
    const s = await setup();
    const id = s.task("sess-d");
    s.ledger.recordOp({ taskId: id, tool: "Bash", intent: "y", clientName: "claude:/work", durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: "toolu_y", closedBy: "post", openedAt: 3000, closedAt: 4000, host: "claude", session_id: "sess-e", tool_name: "Bash", namedFiles: [], description: "y" } });
    setTracking(s.home, "claude", "sess-e", true, "/work");
    const r = await s.sendBack(id, { note: "n" });
    assert.notEqual(r.body.untracked, true);
    assert.ok(!r.body.prompt.includes("not tracking"));
  });
});

class Node_ {
  attrs: Record<string, string> = {}; listeners: Record<string, Array<(e: unknown) => void>> = {}; hidden = false; value = ""; textContent = ""; disabled = false; title = ""; className = ""; style: any = { setProperty() {} }; dataset = {}; children: Node_[] = [];
  classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  fire(k: string) { (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {} select() {} append() {} appendChild() {} remove() {} closest() { return null; } querySelector() { return null; } querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
}

async function boot(untracked: boolean) {
  const nodes = new Map<string, Node_>();
  const byId = (id: string): Node_ => { if (!nodes.has(id)) { const n = new Node_(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = new Node_(); body.getAttribute = (() => "7") as never;
  const fetchStub = async (u: string) => {
    const json = u.includes("/review/status") ? { stops: {}, passes: null, notes: [{ id: 1, text: "my note", ts: 1, regionId: null, region: null, where: "", picture: false }] } : u.includes("/review/sendback") ? { id: 4, prompt: "P", stops: [], nonce: "ab12cd", marker: "M", ...(untracked ? { untracked: true } : {}) } : u.includes("/review/model") ? { task: 7, folder: "w", actors: [], stops: [] } : {};
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(json)) };
  };
  const document = { body, getElementById: byId, createElement: () => new Node_(), createElementNS: () => new Node_(), createTextNode: () => new Node_(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: new Node_(), execCommand: () => true };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, addEventListener() {}, setInterval, clearInterval, setTimeout, fetch: fetchStub, navigator: {} };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  return { byId, settle };
}

describe("the page tells the person", () => {
  const PAGE = "Tracking is off for this task, so CoCheck did not record the agent's recent work.";
  it("an untracked answer shows one plain sentence beside Send back, and the prompt is still shown", async () => {
    const p = await boot(true);
    p.byId("sendback").fire("click");
    await p.settle();
    assert.equal(p.byId("sbmsg").textContent, PAGE);
    assert.equal(p.byId("sbtext").value, "P");
    assert.equal(p.byId("sbout").hidden, false);
  });

  it("a live tracked answer shows no tracking sentence", async () => {
    const p = await boot(false);
    p.byId("sendback").fire("click");
    await p.settle();
    assert.equal(p.byId("sbmsg").textContent, "");
    assert.equal(p.byId("sbtext").value, "P");
  });
});
