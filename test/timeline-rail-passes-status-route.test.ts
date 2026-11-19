import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";

// the status route carries the passes: a marker for each send-back and each submission recorded in the ledger, and the tag of each stop
// after a marker. Real ledger and review server on a temp home; no real CoCheck home, no browser, no model call.

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
  submit(id: number, json?: unknown, opts?: { token?: string | null; origin?: string | null }): Promise<Res>;
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
    submit(id, json = {}, opts = {}) {
      return call("POST", `/timeline/${id}/review/submit`, { json, origin: opts.origin === undefined ? `http://127.0.0.1:${port}` : opts.origin, ...(opts.token === undefined ? {} : { token: opts.token }) });
    },
    async status(id) {
      const r = await call("GET", `/timeline/${id}/review/status`);
      assert.equal(r.status, 200, r.body);
      return JSON.parse(r.body);
    },
  };
}


const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const changeStops = (st: any): string[] => Object.keys(st.stops).filter((k) => k.startsWith("chg-"));

describe("the status route's passes", () => {
  it("a send-back and the next file state: the marker is there, the new stop is a rework linked to the failed stop, and the failed stop links forward", async () => {
    const s = await setup();
    const id = await s.task();
    const before = changeStops(await s.status(id));
    const failedStop = before.at(-1)!;
    assert.equal((await s.post(id, { stop: failedStop, status: "failed", note: "Wrong total." })).status, 200);
    await sleep(5);
    assert.equal((await s.call("POST", `/timeline/${id}/review/sendback`, { json: { note: "" }, origin: `http://127.0.0.1:${s.port}` })).status, 200);
    await sleep(5);
    s.newState(id, "one\nline fixed\n");
    const st = await s.status(id);
    assert.deepEqual(st.passes.markers.map((m: any) => [m.kind, m.label, m.pass]), [["sent_back", "Sent back for review", 1]]);
    const fresh = changeStops(st).filter((k) => !before.includes(k));
    assert.equal(fresh.length, 1);
    assert.equal(st.passes.markers[0].beforeStop, fresh[0]);
    assert.deepEqual([st.passes.tags[fresh[0]!].tag, st.passes.tags[fresh[0]!].answers], ["reworks", failedStop]);
    assert.deepEqual(st.passes.answeredBy, { [failedStop]: fresh });
    assert.deepEqual(Object.keys(st.passes.tags), fresh, "no stop before the marker is tagged");
  });
  it("a submission is a marker too, and a change to a passed file after it is a warning-tagged stop", async () => {
    const s = await setup();
    const id = await s.task();
    for (const stop of Object.keys((await s.status(id)).stops)) await s.post(id, { stop, status: "passed" });
    await sleep(5);
    assert.equal((await s.call("POST", `/timeline/${id}/review/submit`, { json: {}, origin: `http://127.0.0.1:${s.port}` })).status, 200);
    await sleep(5);
    s.newState(id, "one\nline again\n");
    const st = await s.status(id);
    assert.deepEqual(st.passes.markers.map((m: any) => m.kind), ["submitted"]);
    assert.match(st.passes.markers[0].label, /^Signed off by .+, \d{4}-\d\d-\d\d: everything above this line was reviewed$/);
    const tagged = Object.values(st.passes.tags) as any[];
    assert.deepEqual(tagged.map((t) => t.tag), ["changes_passed"]);
  });
  it("no send-back and no submission: no marker and no tag", async () => {
    const s = await setup();
    const id = await s.task();
    const st = await s.status(id);
    assert.deepEqual([st.passes.markers, st.passes.tags, st.passes.answeredBy], [[], {}, {}]);
  });
});
