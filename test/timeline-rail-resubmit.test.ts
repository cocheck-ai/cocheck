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
import { spawnSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { SOFT_SIGNATURE } from "../src/ledger.ts";
import { defaultReviewer } from "../src/review.ts";
import { signoffStatus, verifyFile } from "../src/signoff.ts";
import { stopStates } from "../src/timeline/rail/stop-status.ts";

// Submit follows the stop statuses and records a soft sign-off. A real ledger and review server on a temp home; no real CoCheck home, no
// browser. Guarded against: no submission with a failed stop, no unacknowledged not-reviewed stop, and a soft sign-off never reads as verified.

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

const changeStops = (st: any): string[] => Object.keys(st.stops).filter((k) => k.startsWith("chg-"));

const allStops = (st: any): string[] => Object.keys(st.stops);
const rowsOf = (home: string, table: string): number => {
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"));
  try { return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n); } finally { db.close(); }
};

async function passAll(s: Setup, id: number): Promise<string[]> {
  const ids = allStops(await s.status(id));
  for (const stop of ids) assert.equal((await s.post(id, { stop, status: "passed" })).status, 200);
  return ids;
}

const REVIEW_CLI = path.join(import.meta.dirname, "..", "scripts", "review.ts");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const freshStops = (st: any): string[] => changeStops(st).filter((k) => st.stops[k].status === "not_reviewed");

describe("a task can be submitted again once new work has landed", () => {
  it("refuses a second submission with nothing new, with a plain reason, and records nothing", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    assert.equal((await s.submit(id)).status, 200);
    assert.equal((await s.status(id)).submitState, "submitted");
    const again = await s.submit(id);
    assert.equal(again.status, 409, again.body);
    const j = JSON.parse(again.body);
    assert.equal(j.code, "NOTHING_NEW");
    assert.match(j.error, /Nothing new/);
    assert.deepEqual([rowsOf(s.home, "signoffs"), rowsOf(s.home, "submissions")], [1, 1]);
  });

  it("after a new file state, the same three rules apply to the current stops, and each submission is its own record", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    assert.equal((await s.submit(id)).status, 200);
    await sleep(5);
    s.newState(id, "one\nline changed again\n");
    const st = await s.status(id);
    assert.equal(st.submitState, "new_work");
    const fresh = freshStops(st);
    assert.equal(fresh.length, 1);
    assert.equal(JSON.parse((await s.submit(id)).body).code, "ACK_REQUIRED");
    const ok = await s.submit(id, { acknowledge: fresh });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(JSON.parse(ok.body).n, 2);
    const subs = s.ledger.submissionsForTask(id);
    assert.equal(subs.length, 2);
    assert.deepEqual(subs.map((x) => x.acknowledged), [[], fresh]);
    assert.equal(s.ledger.signoffsForTask(id).length, 2);
    assert.ok(subs[0]!.covered!.length > 0 && subs[1]!.covered!.length === subs[0]!.covered!.length + 1);
    const versions = (x: (typeof subs)[number]) => x.covered!.filter((c) => c.sha256 !== null).map((c) => c.sha256);
    assert.deepEqual(versions(subs[0]!), [sha("one\nline\n"), sha("one\nline changed\n")]);
    assert.deepEqual(versions(subs[1]!), [sha("one\nline\n"), sha("one\nline changed\n"), sha("one\nline changed again\n")]);
    assert.equal(subs[1]!.covered!.find((c) => c.stop === fresh[0])!.status, "not_reviewed");
    const after = await s.status(id);
    assert.deepEqual([after.submitState, after.submitted.n, after.earlier.map((e: any) => e.n)], ["submitted", 2, [1]]);
    assert.equal(after.submitted.label, "soft sign-off, not verified");
    assert.equal((await s.submit(id)).status, 409);
  });

  it("no resubmission while a failed, non-superseded stop exists, however it is acknowledged", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    assert.equal((await s.submit(id)).status, 200);
    await sleep(5);
    s.newState(id, "one\nline changed again\n");
    const fresh = freshStops(await s.status(id));
    await s.post(id, { stop: fresh[0], status: "failed", note: "Bad again." });
    const all = allStops(await s.status(id));
    for (const body of [{}, { acknowledge: all }, { acknowledge: fresh }]) {
      const r = await s.submit(id, body);
      assert.equal(r.status, 409, r.body);
      assert.equal(JSON.parse(r.body).code, "FAILED_STOPS");
    }
    assert.equal(rowsOf(s.home, "submissions"), 1);
  });

  it("a stale acknowledgement set is refused on a resubmission too", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    assert.equal((await s.submit(id)).status, 200);
    await sleep(5);
    s.newState(id, "one\nline changed again\n");
    s.newState(id, "one\nline changed a third time\n");
    const fresh = freshStops(await s.status(id));
    assert.ok(fresh.length >= 2);
    await s.post(id, { stop: fresh[0], status: "passed" });
    const r = await s.submit(id, { acknowledge: fresh });
    assert.equal(r.status, 409, r.body);
    assert.equal(JSON.parse(r.body).code, "ACK_STALE");
    assert.equal(rowsOf(s.home, "submissions"), 1);
    assert.equal((await s.submit(id, { acknowledge: fresh.slice(1) })).status, 200);
  });

  it("the submission records the file state it was taken at", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    await s.submit(id);
    assert.equal(s.ledger.submissionsForTask(id)[0]!.stateMark, s.ledger.maxFileStateId(id));
  });

  it("a soft sign-off still does not close the task, and new work after it is seen", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    await s.submit(id);
    const { closureOf } = await import("../src/signoff.ts");
    assert.equal(closureOf(s.ledger, id), undefined);
    await sleep(5);
    s.newState(id, "one\nline changed again\n");
    assert.equal((await s.status(id)).submitState, "new_work");
  });

  it("keeps the token and origin rules on a resubmission: token, Origin and JSON are all required", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    await s.submit(id);
    s.newState(id, "one\nline changed again\n");
    const fresh = freshStops(await s.status(id));
    const bad = [
      await s.submit(id, { acknowledge: fresh }, { token: null }),
      await s.submit(id, { acknowledge: fresh }, { origin: null }),
      await s.submit(id, { acknowledge: fresh }, { origin: "http://evil.example" }),
    ];
    assert.deepEqual(bad.map((r) => r.status), [403, 403, 403]);
    assert.equal(rowsOf(s.home, "submissions"), 1);
  });
});

describe("old homes and the other surfaces", () => {
  it("a v15 submission (no mark, no covered list) loads unchanged and reads as submitted with nothing new", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    await s.submit(id);
    const db = new DatabaseSync(path.join(s.home, "ledger.sqlite"));
    db.exec("DROP TRIGGER submissions_no_update");
    db.exec("UPDATE submissions SET state_mark = NULL, covered_json = NULL");
    db.close();
    const reopened = openLedger(s.home);
    try {
      const [sub] = reopened.submissionsForTask(id);
      assert.deepEqual([sub!.stateMark, sub!.covered], [null, null]);
      assert.equal(reopened.newWorkSince(id, sub!), false);
      assert.equal(reopened.submissionsForTask(id).length, 1);
    } finally {
      reopened.close();
    }
  });

  it("the index shows the latest submission as current with earlier ones in history, labelled soft sign-off, not verified", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    await s.submit(id);
    await sleep(5);
    s.newState(id, "one\nline changed again\n");
    await s.submit(id, { acknowledge: freshStops(await s.status(id)) });
    const r = await s.call("GET", "/");
    assert.match(r.body, /class="gl ok" title="Signed off"/);
    assert.match(r.body, /1 earlier sign-off/);
    assert.equal((r.body.match(/class="gl ok"/g) ?? []).length, 1, "one signed-off row, no separate verified group");
    s.newState(id, "one\nline changed a third time\n");
    assert.match((await s.call("GET", "/")).body, /new work since, not yet signed off again/);
  });

  it("a task with new work since its latest submission is in the waiting list, and the page does not say nothing is waiting", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    await s.submit(id);
    const quiet = (await s.call("GET", "/")).body;
    assert.match(quiet, /Nothing is waiting for review/, "nothing new: still not waiting");
    await sleep(5);
    s.newState(id, "one\nline changed again\n");
    const body = (await s.call("GET", "/")).body;
    assert.doesNotMatch(body, /Nothing is waiting for review/);
    // One card now carries what the waiting line and the signed-off line said apart: the work since, and the sign-off it follows.
    assert.match(body, new RegExp(`href="/timeline/${id}/review\\?t=[^"]+"[^]*new work since, not yet signed off again`));
    assert.match(body, /signed off by .* on /, "its sign-off line stays on the card");
    // submitting again takes it back out of the waiting list
    await s.submit(id, { acknowledge: freshStops(await s.status(id)) });
    assert.match((await s.call("GET", "/")).body, /Nothing is waiting for review/);
  });

  it("the CLI list shows the latest, the earlier ones and the new-work note", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    await s.submit(id);
    await sleep(5);
    s.newState(id, "one\nline changed again\n");
    await s.submit(id, { acknowledge: freshStops(await s.status(id)) });
    s.newState(id, "one\nline changed a third time\n");
    const list = spawnSync(process.execPath, [REVIEW_CLI, "list", String(id)], { env: { ...process.env, COCHECK_HOME: s.home }, encoding: "utf8" });
    assert.match(list.stdout, /submitted by .* \(soft sign-off, not verified\)/);
    assert.match(list.stdout, /earlier submissions: 1/);
    assert.match(list.stdout, /new work since that submission/);
  });

  it("verify names a file version from either submission as soft sign-off, not verified, never as signed off", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-surf-"));
    const work = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-work-")));
    const file = path.join(work, "notes.txt");
    const ledger = openLedger(home);
    const taskId = ledger.openTask(CLIENT);
    const base = { taskId, signer: "Dana", rounds: 0, rejections: [], leftOut: [], closedTask: false, acknowledged: [], reviewer: "Dana" };
    ledger.recordSoftSubmission({ ...base, files: [{ path: file, sha256: sha("v1") }] });
    ledger.recordSoftSubmission({ ...base, files: [{ path: file, sha256: sha("v2") }] });
    ledger.close();
    cleanups.push(async () => { await rm(home, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); });
    for (const text of ["v1", "v2"]) {
      await writeFile(file, text);
      const verify = spawnSync(process.execPath, [REVIEW_CLI, "verify", file], { env: { ...process.env, COCHECK_HOME: home }, encoding: "utf8" });
      assert.equal(verify.status, 1);
      assert.match(verify.stdout, /soft sign-off, not verified/);
      assert.doesNotMatch(verify.stdout, /^signed off by/m);
    }
  });
});

describe("the submit area says which state it is in", () => {
  it("has the three state wordings in the page script", async () => {
    const js = await readFile(path.join(import.meta.dirname, "..", "src", "timeline", "rail", "assets", "review.js"), "utf8");
    for (const needle of ["Signed off. You can still add to it.", "New or changed since you signed off.", "Sign off again"]) assert.ok(js.includes(needle), needle);
  });
});
