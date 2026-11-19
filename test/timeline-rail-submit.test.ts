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
  /** Record a send-back that carries the failed stops now (only a carried fail can be replaced by a later state). */
  sendBack(id: number): Promise<Res>;
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
    sendBack(id) {
      return call("POST", `/timeline/${id}/review/sendback`, { json: {}, origin: `http://127.0.0.1:${port}` });
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

describe("the three rules", () => {
  it("every stop reviewed and passed: submit goes straight through, with no acknowledgement", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    const r = await s.submit(id);
    assert.equal(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.deepEqual([j.submitted, j.signature, j.label, j.acknowledged], [true, "soft", "soft sign-off, not verified", []]);
    const [row] = s.ledger.signoffsForTask(id);
    assert.equal(row!.signature, SOFT_SIGNATURE);
    assert.deepEqual(s.ledger.submissionsForTask(id).map((x) => x.acknowledged), [[]]);
  });

  it("a failed stop makes submit ineligible, even with an acknowledgement of everything, and records nothing", async () => {
    const s = await setup();
    const id = await s.task();
    const ids = await passAll(s, id);
    const last = changeStops(await s.status(id)).at(-1)!;
    await s.post(id, { stop: last, status: "failed", note: "Wrong." });
    for (const body of [{}, { acknowledge: ids }, { acknowledge: [last] }]) {
      const r = await s.submit(id, body);
      assert.equal(r.status, 409, r.body);
      assert.equal(JSON.parse(r.body).code, "FAILED_STOPS");
    }
    assert.deepEqual([rowsOf(s.home, "signoffs"), rowsOf(s.home, "submissions")], [0, 0]);
    assert.equal((await s.status(id)).submit.eligible, false);
  });

  it("a not-reviewed stop is refused without the acknowledgement, and recorded with it", async () => {
    const s = await setup();
    const id = await s.task();
    const ids = allStops(await s.status(id));
    await s.post(id, { stop: ids[0], status: "passed" });
    const open = ids.slice(1);
    for (const body of [{}, { acknowledge: [] }]) {
      const r = await s.submit(id, body);
      assert.equal(r.status, 409, r.body);
      assert.equal(JSON.parse(r.body).code, "ACK_REQUIRED");
    }
    assert.equal(rowsOf(s.home, "signoffs"), 0);
    const ok = await s.submit(id, { acknowledge: open });
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(s.ledger.submissionsForTask(id)[0]!.acknowledged, [...open].sort());
    assert.equal(s.ledger.signoffsForTask(id)[0]!.signature, "soft");
  });

  it("the acknowledgement is valid only for the exact not-reviewed set at submit time: a smaller, larger or stale set is a 409", async () => {
    const s = await setup();
    const id = await s.task();
    const ids = allStops(await s.status(id));
    await s.post(id, { stop: ids[0], status: "passed" });
    const open = ids.slice(1);
    assert.ok(open.length >= 2);
    for (const ack of [open.slice(1), [...open, ids[0]!], [...open, "chg-nope"], ["chg-nope"]]) {
      const r = await s.submit(id, { acknowledge: ack });
      assert.equal(r.status, 409, r.body);
      assert.equal(JSON.parse(r.body).code, "ACK_STALE");
    }
    // The set changes between the pop-up and the click: the person passes one more stop, so the old acknowledgement no longer matches.
    await s.post(id, { stop: open[0], status: "passed" });
    const stale = await s.submit(id, { acknowledge: open });
    assert.equal(stale.status, 409, stale.body);
    assert.deepEqual(JSON.parse(stale.body).notReviewed, open.slice(1));
    assert.equal(rowsOf(s.home, "signoffs"), 0);
    assert.equal((await s.submit(id, { acknowledge: open.slice(1) })).status, 200);
  });

  it("a malformed acknowledgement is a 400, and a second submission with nothing new is a 409", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    for (const ack of ["chg-1", 5, [1], { a: 1 }]) assert.equal((await s.submit(id, { acknowledge: ack })).status, 400);
    assert.equal((await s.submit(id)).status, 200);
    const again = await s.submit(id);
    assert.equal(again.status, 409);
    assert.equal(JSON.parse(again.body).code, "NOTHING_NEW", "a second submission with nothing new since is refused");
    assert.equal(rowsOf(s.home, "signoffs"), 1);
  });

  it("the status route reports what submit reads, and the submission once made", async () => {
    const s = await setup();
    const id = await s.task();
    const st = await s.status(id);
    assert.equal(st.submitted, null);
    assert.deepEqual([st.submit.eligible, st.submit.blocking, st.submit.notReviewed.length], [true, [], allStops(st).length]);
    await passAll(s, id);
    await s.submit(id);
    const after = await s.status(id);
    assert.equal(after.submitted.label, "soft sign-off, not verified");
    assert.deepEqual(after.submitted.acknowledged, []);
  });
});

describe("a later state of the same file supersedes a failed stop", () => {
  it("a failed stop replaced by a later state no longer blocks; the later state needs its own verdict, and the failure stays in history", async () => {
    const s = await setup();
    const id = await s.task();
    const [first, second] = changeStops(await s.status(id));
    for (const k of allStops(await s.status(id)).filter((k) => !k.startsWith("chg-"))) await s.post(id, { stop: k, status: "passed" });
    await s.post(id, { stop: first, status: "failed", note: "Bad first draft." });
    await s.post(id, { stop: second, status: "passed" });
    // replaced means a state recorded AFTER the verdict. Both states above were recorded before it, so the fail still stands.
    assert.deepEqual((await s.status(id)).submit.superseded, []);
    assert.equal((await s.sendBack(id)).status, 200); // the fail is carried by a send-back; the agent's next state replaces it
    await new Promise((r) => setTimeout(r, 15));
    s.newState(id, "one\nline changed again\n");
    const third = changeStops(await s.status(id)).find((k) => k !== first && k !== second)!;
    await s.post(id, { stop: third, status: "passed" });
    const st = await s.status(id);
    assert.deepEqual([st.anyFailed, st.submit.superseded, st.submit.blocking], [true, [first], []], "send-back still sees the failed stop");
    assert.equal(st.failed.length, 1);
    assert.equal(st.stops[first!].status, "failed", "the failure stays in the record");
    assert.equal(st.submit.eligible, true);
    // The superseded stop is failed, not "not reviewed", so it is not in the not-reviewed set.
    assert.deepEqual(st.submit.notReviewed, []);
    assert.equal((await s.submit(id)).status, 200);
  });

  it("the later state needs its own verdict: until it has one, submit needs the acknowledgement", async () => {
    const s = await setup();
    const id = await s.task();
    const [first] = changeStops(await s.status(id));
    await passAll(s, id);
    await s.post(id, { stop: first, status: "failed", note: "Bad." });
    assert.equal((await s.sendBack(id)).status, 200);
    await new Promise((r) => setTimeout(r, 15));
    s.newState(id, "one\nline changed again\n");
    const st = await s.status(id);
    const fresh = changeStops(st).filter((k) => st.stops[k].status === "not_reviewed");
    assert.equal(fresh.length, 1);
    assert.deepEqual([st.submit.blocking, st.submit.superseded, st.submit.notReviewed], [[], [first], fresh]);
    assert.equal(JSON.parse((await s.submit(id)).body).code, "ACK_REQUIRED");
    assert.equal((await s.submit(id, { acknowledge: fresh })).status, 200);
  });

  it("a superseded stop that was never reviewed is still not reviewed and still needs the acknowledgement", async () => {
    const s = await setup();
    const id = await s.task();
    const ids = allStops(await s.status(id));
    const [first, second] = changeStops(await s.status(id));
    for (const k of ids.filter((k) => k !== first)) await s.post(id, { stop: k, status: "passed" });
    const st = await s.status(id);
    assert.deepEqual([st.submit.superseded, st.submit.notReviewed], [[], [first]]);
    assert.equal((await s.submit(id)).status, 409);
    assert.equal((await s.submit(id, { acknowledge: [first] })).status, 200);
    void second;
  });

  it("a failed latest state blocks even when earlier states of the file are failed too", async () => {
    const s = await setup();
    const id = await s.task();
    const [first, second] = changeStops(await s.status(id));
    await passAll(s, id);
    await s.post(id, { stop: first, status: "failed", note: "a" });
    assert.equal((await s.sendBack(id)).status, 200);
    await new Promise((r) => setTimeout(r, 15));
    s.newState(id, "one\nline changed again\n"); // recorded after the fail on `first`; the fails below come after every state, so they stand
    await s.post(id, { stop: second, status: "failed", note: "b" });
    const third = changeStops(await s.status(id)).find((k) => k !== first && k !== second)!;
    await s.post(id, { stop: third, status: "failed", note: "c" });
    const st = await s.status(id);
    assert.deepEqual([st.submit.superseded, st.submit.blocking], [[first], [second, third]]);
    assert.equal((await s.submit(id)).status, 409);
  });
});

describe("content that returns to bytes it was passed on reads passed again", () => {
  const stop: any = { id: "chg-c1", label: "n", lane: "main", head: "h", change: { key: "c1", file: "n.txt", kind: "modified", note: "", rowNotes: [], secret: false } };
  const identities = new Map([["chg-c1", { fingerprint: "X", subject: "file:n.txt" }]]);
  const row = (id: number, fingerprint: string, status: "passed" | "failed" | "not_reviewed") => ({ id, taskId: 1, stopId: "chg-c1", subject: "file:n.txt", fingerprint, status, note: status === "failed" ? "no" : "", reviewer: "t", ts: "t" });

  it("a verdict on other content in between does not hide the verdict on this content", () => {
    const s = stopStates([stop], identities, [row(1, "X", "passed"), row(2, "Y", "failed")]).get("chg-c1")!;
    assert.equal(s.status, "passed");
    assert.equal(s.stale, false);
    assert.deepEqual(s.history.map((h) => h.current), [true, false]);
  });

  it("the latest verdict on this content wins, and content never passed stays not reviewed", () => {
    assert.equal(stopStates([stop], identities, [row(1, "X", "passed"), row(2, "Y", "failed"), row(3, "X", "failed")]).get("chg-c1")!.status, "failed");
    const none = stopStates([stop], identities, [row(1, "Y", "passed")]).get("chg-c1")!;
    assert.deepEqual([none.status, none.stale], ["not_reviewed", true]);
  });
});

describe("only the person's own page can submit (token and origin rules)", () => {
  it("refuses no token, a wrong token, no Origin, a foreign Origin and a non-JSON body, and writes nothing", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    const bad = [
      await s.submit(id, {}, { token: null }),
      await s.submit(id, {}, { token: "x".repeat(40) }),
      await s.submit(id, {}, { origin: null }),
      await s.submit(id, {}, { origin: "http://evil.example" }),
      await s.call("POST", `/timeline/${id}/review/submit`, { headers: { "content-type": "text/plain", origin: `http://127.0.0.1:${s.port}` } }),
    ];
    assert.deepEqual(bad.map((r) => r.status), [403, 403, 403, 403, 415]);
    for (const m of ["GET", "PUT", "DELETE"]) assert.equal((await s.call(m, `/timeline/${id}/review/submit`)).status, m === "GET" ? 405 : 405);
    assert.deepEqual([rowsOf(s.home, "signoffs"), rowsOf(s.home, "submissions")], [0, 0]);
  });

  it("there is no sign-off route, and the table refuses a row with an empty signature", async () => {
    const s = await setup();
    const id = await s.task();
    for (const signature of ["soft", "", "junk", null, undefined]) {
      const r = await s.call("POST", `/review/${id}/signoff`, { json: { signer: "Dana", signature }, origin: `http://127.0.0.1:${s.port}` });
      assert.ok(r.status >= 400, r.body);
    }
    const db = new DatabaseSync(path.join(s.home, "ledger.sqlite"));
    assert.throws(() => db.prepare("INSERT INTO signoffs (task_id, signer, ts, rounds, rejections_json, files_json, left_out_json, closed_task, signature) VALUES (?, 'x', 't', 1, '[]', '[]', '[]', 0, ?)").run(id, ""), /sign-off needs a signature/);
    db.close();
    assert.equal(rowsOf(s.home, "signoffs"), 0);
  });

  it("the submissions table is append-only", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    await s.submit(id);
    const db = new DatabaseSync(path.join(s.home, "ledger.sqlite"));
    assert.throws(() => db.prepare("UPDATE submissions SET reviewer = 'x'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM submissions").run(), /append-only/);
    db.close();
  });
});

describe("a soft sign-off never reads as verified, on every surface", () => {
  const REVIEW_CLI = path.join(import.meta.dirname, "..", "scripts", "review.ts");
  async function signed() {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-surf-"));
    const work = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-work-")));
    const file = path.join(work, "notes.txt");
    await writeFile(file, "v1");
    const ledger = openLedger(home);
    const taskId = ledger.openTask(CLIENT);
    const dest = path.join(home, "tasks", String(taskId), "round-1", "notes.txt");
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, "v1");
    ledger.recordRound({ taskId, seq: 1, intent: "pass", clientName: CLIENT, final: true, lastOpId: 0, snapshots: [{ taskId, round: 1, filePath: file, layer: "xlsx", snapshotPath: dest, mode: "copy" }],
      rows: [{ layer: "xlsx", kind: "value", before: 1, after: 2, ops: [], description: "A1 changed", detail: {}, filePath: file, location: "Sheet1!A1", status: "explained", }] });
    ledger.recordSoftSubmission({ taskId, signer: "Dana", rounds: 1, rejections: [], files: [{ path: file, sha256: sha("v1") }], leftOut: [], closedTask: false, acknowledged: [], reviewer: "Dana" });
    cleanups.push(async () => { ledger.close(); await rm(home, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); });
    return { home, work, file, ledger, taskId };
  }

  it("the CLI list and verify say soft sign-off, not verified; the index says signed off in the rail's words", async () => {
    const t = await signed();
    const { server, port } = await startReviewServer(t.ledger, TOKEN, t.home, 0, undefined, { quickLook: false });
    cleanups.push(async () => { await new Promise<void>((r) => (server as Server).close(() => r())); });
    const index = await new Promise<string>((resolve, reject) => http.get({ hostname: "127.0.0.1", port, path: `/?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve(b)); }).on("error", reject));
    assert.match(index, /class="gl ok" title="Signed off"/);
    assert.match(index, /signed off by Dana on /);
    assert.doesNotMatch(index, /soft|verified|submit/i);
    const list = spawnSync(process.execPath, [REVIEW_CLI, "list", String(t.taskId)], { env: { ...process.env, COCHECK_HOME: t.home }, encoding: "utf8" });
    assert.match(list.stdout, /submitted by Dana \(soft sign-off, not verified\)/);
    const verify = spawnSync(process.execPath, [REVIEW_CLI, "verify", t.file], { env: { ...process.env, COCHECK_HOME: t.home }, encoding: "utf8" });
    assert.equal(verify.status, 1, "a soft sign-off does not answer verify with a match");
    assert.match(verify.stdout + verify.stderr, /soft sign-off, not verified/);
    assert.doesNotMatch(verify.stdout, /^signed off by/m);
    const direct = await verifyFile(t.ledger, t.file);
    assert.equal(direct.match, false);
  });

  it("it does not close the task, so nothing is pruned or expired on an unverified signature", async () => {
    const t = await signed();
    assert.equal(signoffStatus(t.ledger, t.taskId).record?.signature, "soft");
    const { closureOf } = await import("../src/signoff.ts");
    assert.equal(closureOf(t.ledger, t.taskId), undefined);
  });
});

describe("the rail page carries Submit", () => {
  it("has the button and the acknowledgement pop-up in the static shell, without the soft sign-off wording", () => {
    const html = renderReviewShell(1);
    for (const needle of ['id="submit"', 'id="subdlg"', 'id="subgo"']) assert.ok(html.includes(needle), needle);
    // "soft sign-off" is jargon the page no longer shows; the record and the CLI still carry it.
    assert.ok(!/soft sign-off/i.test(html));
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "still no inline script");
  });
});
