import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// every rail stop has a review status (not reviewed, passed, failed) with an append-only history. A real ledger and review server on a
// temp home; no real CoCheck home, no browser. Guarded against: a verdict is never lost, and never carried onto changed content.

const TOKEN = "v".repeat(40);
const CLIENT = "claude:/work";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Res { status: number; body: string }
interface Setup {
  home: string;
  ledger: Ledger;
  port: number;
  task(): Promise<number>;
  /** A later state of the same file, in a new step. */
  newState(id: number, text: string): void;
  call(method: string, p: string, opts?: { token?: string | null; origin?: string | null; json?: unknown; headers?: Record<string, string> }): Promise<Res>;
  post(id: number, json: unknown, opts?: { token?: string | null; origin?: string | null }): Promise<Res>;
  status(id: number): Promise<any>;
}

async function setup(): Promise<Setup> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  let seq = 0;
  const file = "/work/notes.txt";
  const call = (method: string, p: string, opts: { token?: string | null; origin?: string | null; json?: unknown; headers?: Record<string, string> } = {}): Promise<Res> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const url = token === null ? p : `${p}${p.includes("?") ? "&" : "?"}t=${token}`;
    const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...opts.headers };
    if (opts.origin !== null && opts.origin !== undefined) headers.origin = opts.origin;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(body);
    });
  };
  const addState = (id: number, prev: string | null, text: string): void => {
    const callId = `toolu_${id}`;
    ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(text), prevSha256: prev === null ? null : sha(prev), size: text.length, kept: "whole", note: "" }] });
  };
  const texts = new Map<number, string>();
  return {
    home,
    ledger,
    port,
    call,
    async task() {
      const id = ledger.openTask(CLIENT);
      const states = await ensureStoreDir(home, id);
      await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
      const [t0, t1] = ["one\nline\n", "one\nline changed\n"];
      for (const text of [t0, t1]) await writeFile(path.join(states, sha(text)), text);
      const callId = `toolu_${id}`;
      ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit the notes", clientName: CLIENT, durationMs: 1, resultCode: "OK",
        args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [file], description: "edit the notes", narration: { source: "none", text: "no narration recorded" } } });
      ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK",
        args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Fix the notes."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
      addState(id, null, t0);
      addState(id, t0, t1);
      texts.set(id, t1);
      return id;
    },
    newState(id, text) {
      const states = path.join(home, "tasks", String(id));
      // the stored copy is not needed to name the stop; the ledger row is what makes it a new state
      void states;
      addState(id, texts.get(id)!, text);
      texts.set(id, text);
    },
    post(id, json, opts = {}) {
      return call("POST", `/timeline/${id}/review/verdict`, { json, origin: opts.origin === undefined ? `http://127.0.0.1:${port}` : opts.origin, ...(opts.token === undefined ? {} : { token: opts.token }) });
    },
    async status(id) {
      const r = await call("GET", `/timeline/${id}/review/status`);
      assert.equal(r.status, 200, r.body);
      return JSON.parse(r.body);
    },
  };
}

const changeStops = (st: any): string[] => Object.keys(st.stops).filter((k) => k.startsWith("chg-"));

describe("every stop has a status", () => {
  it("starts every stop as not reviewed, and says so for the summary send-back and submit will read", async () => {
    const s = await setup();
    const id = await s.task();
    const st = await s.status(id);
    const ids = Object.keys(st.stops);
    assert.ok(ids.length >= 3, "a request stop and two change stops");
    for (const k of ids) assert.deepEqual([st.stops[k].status, st.stops[k].note, st.stops[k].history], ["not_reviewed", "", []]);
    assert.deepEqual([st.anyFailed, st.anyNotReviewed, st.failed], [false, true, []]);
    assert.equal(st.counts.not_reviewed, ids.length);
  });

  it("lets the person set any stop in any order, last stop first", async () => {
    const s = await setup();
    const id = await s.task();
    const [first, second] = changeStops(await s.status(id));
    assert.equal((await s.post(id, { stop: second, status: "passed" })).status, 200);
    let st = await s.status(id);
    assert.deepEqual([st.stops[first!].status, st.stops[second!].status], ["not_reviewed", "passed"]);
    assert.equal((await s.post(id, { stop: first, status: "passed" })).status, 200);
    st = await s.status(id);
    assert.deepEqual([st.stops[first!].status, st.stops[second!].status], ["passed", "passed"]);
  });

  it("refuses a fail without a note (empty, spaces, missing) and records nothing", async () => {
    const s = await setup();
    const id = await s.task();
    const [stop] = changeStops(await s.status(id));
    for (const note of [undefined, "", "   \n"]) {
      const r = await s.post(id, { stop, status: "failed", ...(note === undefined ? {} : { note }) });
      assert.equal(r.status, 400);
      assert.match(JSON.parse(r.body).error, /needs a short note/);
    }
    assert.deepEqual(s.ledger.stopVerdictsForTask(id), []);
    assert.equal((await s.status(id)).stops[stop!].status, "not_reviewed");
  });

  it("keeps a failed stop with its note, where it is, for send-back to read", async () => {
    const s = await setup();
    const id = await s.task();
    const [first, second] = changeStops(await s.status(id));
    await s.post(id, { stop: second, status: "failed", note: "  The total is wrong.  " });
    await s.post(id, { stop: first, status: "passed" });
    const st = await s.status(id);
    assert.equal(st.anyFailed, true);
    assert.equal(st.failed.length, 1);
    assert.deepEqual([st.failed[0].stop, st.failed[0].note, st.failed[0].file], [second, "The total is wrong.", "notes.txt"]);
    assert.equal(st.stops[second!].status, "failed");
  });

  it("rejects an unknown stop, an unknown status, a missing stop and an oversized note", async () => {
    const s = await setup();
    const id = await s.task();
    const [stop] = changeStops(await s.status(id));
    assert.equal((await s.post(id, { stop: "chg-nope", status: "passed" })).status, 404);
    assert.equal((await s.post(id, { stop, status: "approved" })).status, 400);
    assert.equal((await s.post(id, { status: "passed" })).status, 400);
    assert.equal((await s.post(id, { stop, status: "failed", note: "x".repeat(2001) })).status, 400);
    assert.deepEqual(s.ledger.stopVerdictsForTask(id), []);
  });
});

describe("history is appended, never overwritten", () => {
  it("keeps every change of mind in order, and the current status is the latest", async () => {
    const s = await setup();
    const id = await s.task();
    const [stop] = changeStops(await s.status(id));
    await s.post(id, { stop, status: "passed" });
    await s.post(id, { stop, status: "failed", note: "Wrong after all." });
    await s.post(id, { stop, status: "not_reviewed" });
    await s.post(id, { stop, status: "passed" });
    const state = (await s.status(id)).stops[stop!];
    assert.equal(state.status, "passed");
    // History lists verdicts that took effect (sent back or submitted) plus the current one; a change of mind that was
    // never sent leaves no row. The ledger still holds every row, oldest first.
    assert.deepEqual(state.history.map((h: any) => [h.status, h.note, h.current]), [["passed", "", true]]);
    const ids = s.ledger.stopVerdictsForTask(id).map((v) => v.id);
    assert.equal(ids.length, 4);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  });

  it("is append-only in the database itself: an UPDATE or a DELETE of a verdict is refused", async () => {
    const s = await setup();
    const id = await s.task();
    const [stop] = changeStops(await s.status(id));
    await s.post(id, { stop, status: "failed", note: "keep me" });
    const db = new DatabaseSync(path.join(s.home, "ledger.sqlite"));
    try {
      assert.throws(() => db.exec("UPDATE stop_verdicts SET status = 'passed'"), /append-only/);
      assert.throws(() => db.exec("UPDATE stop_verdicts SET note = ''"), /append-only/);
      assert.throws(() => db.exec("DELETE FROM stop_verdicts"), /append-only/);
    } finally {
      db.close();
    }
    assert.equal(s.ledger.stopVerdictsForTask(id).length, 1);
  });
});

describe("changed content resets the stop and keeps the earlier verdict", () => {
  it("reads not reviewed when the verdict was given on other content of the same stop, and the row stays in the history", async () => {
    const s = await setup();
    const id = await s.task();
    const [stop] = changeStops(await s.status(id));
    s.ledger.appendStopVerdict({ taskId: id, stopId: stop!, subject: "file:notes.txt", fingerprint: "an-older-content", status: "passed", note: "", reviewer: "dana" });
    const state = (await s.status(id)).stops[stop!];
    assert.equal(state.status, "not_reviewed");
    assert.equal(state.stale, true);
    assert.deepEqual(state.history, [], "a verdict that was never sent or submitted is not listed");
    assert.equal(s.ledger.stopVerdictsForTask(id).length, 1, "the ledger row stays");
    assert.equal((await s.status(id)).anyNotReviewed, true);
  });

  // A later verdict given on other content no longer hides the verdict on today's content.
  it("a verdict on current content is current, and a later verdict on other content does not hide it", async () => {
    const s = await setup();
    const id = await s.task();
    const [stop] = changeStops(await s.status(id));
    await s.post(id, { stop, status: "passed" });
    assert.equal((await s.status(id)).stops[stop!].status, "passed");
    const real = s.ledger.stopVerdictsForTask(id)[0]!;
    assert.match(real.fingerprint, /^[0-9a-f]{64}$/);
    s.ledger.appendStopVerdict({ ...real, fingerprint: "changed", status: "failed", note: "on other content" });
    const after = (await s.status(id)).stops[stop!];
    assert.equal(after.status, "passed");
    assert.deepEqual(after.history.map((h: any) => h.current), [true], "the unsent verdict on other content is not listed");
  });

  it("a new state of the same file is a new stop that is not reviewed, and shows the earlier verdicts in its history", async () => {
    const s = await setup();
    const id = await s.task();
    const before = changeStops(await s.status(id));
    await s.post(id, { stop: before[1], status: "passed" });
    await s.post(id, { stop: before[0], status: "failed", note: "Bad first draft." });
    s.newState(id, "one\nline changed again\n");
    const st = await s.status(id);
    const fresh = changeStops(st).filter((k) => !before.includes(k));
    assert.equal(fresh.length, 1, "the new state is one new stop");
    const state = st.stops[fresh[0]!];
    assert.equal(state.status, "not_reviewed");
    assert.deepEqual(state.history, [], "unsent verdicts on the earlier states are not listed");
    assert.equal(st.stops[before[1]!].status, "passed", "the earlier stop keeps its own verdict");
    assert.equal(st.anyFailed, true);
    assert.equal(st.anyNotReviewed, true);
  });
});

describe("only the person sets statuses", () => {
  it("keeps the token and origin rules: no token, wrong token, no Origin, foreign Origin and cross-site fetch are all refused, and nothing is written", async () => {
    const s = await setup();
    const id = await s.task();
    const [stop] = changeStops(await s.status(id));
    const own = `http://127.0.0.1:${s.port}`;
    const body = { stop, status: "passed" };
    assert.equal((await s.post(id, body, { token: null })).status, 403);
    assert.equal((await s.post(id, body, { token: "w".repeat(40) })).status, 403);
    assert.equal((await s.post(id, body, { origin: null })).status, 403);
    assert.equal((await s.post(id, body, { origin: "http://evil.example" })).status, 403);
    assert.equal((await s.post(id, body, { origin: "null" })).status, 403);
    const cross = await s.call("POST", `/timeline/${id}/review/verdict`, { json: body, origin: own, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(cross.status, 403);
    const plain = await s.call("POST", `/timeline/${id}/review/verdict`, { origin: own, headers: { "content-type": "text/plain" } });
    assert.equal(plain.status, 415);
    assert.equal((await s.call("POST", `/timeline/${id}/review/verdict`, { json: body, origin: own, headers: { host: "evil.example" } })).status, 403);
    assert.deepEqual(s.ledger.stopVerdictsForTask(id), []);
    assert.equal((await s.post(id, body)).status, 200, "the page's own request still works");
  });

  it("answers a GET, PUT or DELETE on the verdict route with 405 and writes nothing", async () => {
    const s = await setup();
    const id = await s.task();
    for (const m of ["GET", "PUT", "DELETE"]) assert.equal((await s.call(m, `/timeline/${id}/review/verdict`, { origin: `http://127.0.0.1:${s.port}` })).status, 405);
    assert.deepEqual(s.ledger.stopVerdictsForTask(id), []);
  });

  it("has no CLI, MCP, hook or agent path: only the ledger, the review server and the rail page script touch verdicts", async () => {
    const root = new URL("../src/", import.meta.url);
    const hits: string[] = [];
    const walk = async (dir: URL): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
        if (e.isDirectory()) await walk(u);
        else if (/\.(ts|js|mjs)$/.test(e.name) && /stop_verdicts|appendStopVerdict|stopVerdictsForTask|review\/verdict/.test(await readFile(u, "utf8"))) hits.push(path.relative(fileURLToPath(root), fileURLToPath(u)).replaceAll("\\", "/"));
      }
    };
    await walk(root);
    assert.deepEqual(hits.sort(), ["ledger.ts", "review-server.ts", "timeline/rail/assets/review.js"]);
  });

  it("the status route is read-only: the same token and a GET change nothing", async () => {
    const s = await setup();
    const id = await s.task();
    await s.status(id);
    await s.status(id);
    assert.deepEqual(s.ledger.stopVerdictsForTask(id), []);
    assert.equal((await s.call("GET", `/timeline/${id}/review/status`, { token: null })).status, 403);
  });
});

describe("the rail page carries the controls", () => {
  it("has the status, pass, fail, note and history elements in the static shell, no reset, and still no inline script", () => {
    const html = renderReviewShell(7);
    for (const id of ["vstat", "pbpass", "pbfail", "vnote", "vfailgo", "vhist"]) assert.match(html, new RegExp(`id="${id}"`));
    // "Mark not reviewed" is gone; pressing the chosen verdict again, or Undo, clears it.
    assert.doesNotMatch(html, /id="vreset"|Mark not reviewed/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  });
});
