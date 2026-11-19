import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import * as reviewApi from "../src/review.ts";
import { insertLegacySignoff } from "./helpers/signed-fixture.ts";

// The legacy review page is gone. Old /review/<task> URLs go to the rail; the page's POST routes, writers, export and CLI verbs are
// removed; the index reads stop verdicts and submissions only; an old home with legacy rows still loads and keeps every legacy row byte for byte.
// Guard: a removed route must be a refusal (never a 200 that writes), and an old home must not lose or gain a legacy row.

const TOKEN = "r".repeat(40);
const CLIENT = "claude:/work";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const REVIEW_CLI = path.join(import.meta.dirname, "..", "scripts", "review.ts");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Res { status: number; body: string; headers: http.IncomingHttpHeaders }

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const ledger: Ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = (method: string, p: string, opts: { token?: string | null; origin?: string | null; json?: unknown; host?: string } = {}): Promise<Res> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const url = token === null ? p : `${p}${p.includes("?") ? "&" : "?"}t=${token}`;
    const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/json" }) };
    if (opts.origin !== null && opts.origin !== undefined) headers.origin = opts.origin;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      });
      req.on("error", reject);
      req.end(body);
    });
  };
  let seq = 0;
  const file = "/work/notes.txt";
  /** A task the rail can draw: two states of one file in the store, one hook call credited with both. */
  const task = async (): Promise<number> => {
    const id = ledger.openTask(CLIENT);
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    const [t0, t1] = ["one\nline\n", "one\nline changed\n"];
    for (const text of [t0, t1]) await writeFile(path.join(states, sha(text)), text);
    const callId = `toolu_${id}`;
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit the notes", clientName: CLIENT, durationMs: 1, resultCode: "OK",
      args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [file], description: "edit the notes", narration: { source: "none", text: "no narration recorded" } } });
    const add = (prev: string | null, text: string): void => {
      ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(text), prevSha256: prev === null ? null : sha(prev), size: text.length, kept: "whole", note: "" }] });
    };
    add(null, t0);
    add(t0, t1);
    return id;
  };
  const origin = `http://127.0.0.1:${port}`;
  return { home, ledger, port, call, task, origin };
}

const LEGACY_TABLES = ["rounds", "review_rows", "review_decisions", "item_resolutions", "review_requests", "request_resolutions", "request_confirmations", "task_snapshots", "round_results"];
function dump(home: string, tables: string[]): string {
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"));
  try {
    return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
  } finally {
    db.close();
  }
}

/** A home as an older build left it: a final round with a row, a reviewer's rejection, a task-level request, and a sign-off without a signature. */
async function oldHome(ledger: Ledger, home: string) {
  const work = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-work-")));
  cleanups.push(() => rm(work, { recursive: true, force: true }));
  const file = path.join(work, "notes.txt");
  await writeFile(file, "v1");
  const taskId = ledger.openTask(CLIENT);
  const dest = path.join(home, "tasks", String(taskId), "round-1", "notes.txt");
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, "v1");
  ledger.recordRound({
    taskId, seq: 1, intent: "pass", clientName: CLIENT, final: true, lastOpId: 0,
    snapshots: [{ taskId, round: 1, filePath: file, layer: "xlsx", snapshotPath: dest, mode: "copy" }],
    rows: [{ layer: "xlsx", kind: "value", before: 1, after: 2, ops: [], description: "A1 changed", detail: {}, filePath: file, location: "Sheet1!A1", status: "explained" }],
  });
  const row = ledger.reviewRowsForTask(taskId)[0]!;
  ledger.recordDecision({ rowId: row.id, decision: "reject", note: "wrong", reviewer: "Dana" });
  ledger.recordRequest({ taskId, note: "also fix B2", reviewer: "Dana" });
  insertLegacySignoff(ledger, { taskId, signer: "Dana", rounds: 1 });
  return { taskId, file };
}

describe("nothing is served under /review/", () => {
  it("/review/<task> is a 404, whatever the method or token", async () => {
    const s = await setup();
    const id = await s.task();
    for (const method of ["GET", "HEAD"]) assert.equal((await s.call(method, `/review/${id}`)).status, 404, method);
    assert.equal((await s.call("GET", "/review/9999")).status, 404);
  });

  it("the old page's sub-routes are gone, whatever the method, token or Origin: 404 or 405, nothing written", async () => {
    const s = await setup();
    const { taskId } = await oldHome(s.ledger, s.home);
    const before = dump(s.home, [...LEGACY_TABLES, "signoffs"]);
    for (const verb of ["decision", "signoff", "request", "confirm", "anything"]) {
      for (const method of ["GET", "POST", "PUT"]) {
        const r = await s.call(method, `/review/${taskId}/${verb}`, { origin: s.origin, ...(method === "GET" ? {} : { json: { rowId: 1, decision: "approve", signer: "Dana", note: "x", all: true } }) });
        assert.equal(r.status, 404, `${method} ${verb} -> ${r.status} ${r.body.slice(0, 80)}`);
      }
    }
    assert.equal((await s.call("POST", `/review/${taskId}`, { origin: s.origin, json: {} })).status, 404);
    assert.equal(dump(s.home, [...LEGACY_TABLES, "signoffs"]), before);
  });
});

describe("the rail no longer links to the legacy page", () => {
  it("the shell has no 'Decisions, requests and sign-off' link and no /review/ href", () => {
    const html = renderReviewShell(7);
    assert.doesNotMatch(html, /Decisions, requests and sign-off/);
    assert.doesNotMatch(html, /href="\/review\//);
    assert.doesNotMatch(html, /id="signoff"/);
  });

  it("the script and styles do not mention it either, and the failure messages stop pointing at it", async () => {
    const js = await readFile(path.resolve(import.meta.dirname, "../src/timeline/rail/assets/review.js"), "utf8");
    const css = await readFile(path.resolve(import.meta.dirname, "../src/timeline/rail/assets/review.css"), "utf8");
    assert.doesNotMatch(js, /Decisions, requests and sign-off|'\/review\/'|"\/review\/"|\$\('signoff'\)/);
    assert.doesNotMatch(css, /\.signoff\b/);
  });
});

describe("the legacy surface is removed from the code", () => {
  it("src/review.ts exports no page, no writer, no export", () => {
    const names = Object.keys(reviewApi);
    for (const gone of ["renderReviewPage", "recordReviewerDecision", "recordReviewerRequest", "answerAwaiting", "confirmAgentAnswers", "awaitingAnswers", "exportReview", "exportPathFor", "awaitingHtml", "requestsHtml", "signoffHtml", "hookRoundsHtml", "noCellCallsHtml", "movedHtml", "checkNoticesHtml", "roundNotesHtml"]) {
      assert.ok(!names.includes(gone), `${gone} is still exported`);
    }
  });

  it("the CLI has no reject, approve or request verb: each is a usage error that writes nothing", async () => {
    const s = await setup();
    const { taskId } = await oldHome(s.ledger, s.home);
    const before = dump(s.home, [...LEGACY_TABLES, "signoffs"]);
    for (const args of [["reject", String(taskId), "1", "no"], ["approve", String(taskId), "1"], ["request", String(taskId), "do this"]]) {
      const r = spawnSync(process.execPath, [REVIEW_CLI, ...args], { env: { ...process.env, COCHECK_HOME: s.home }, encoding: "utf8" });
      assert.equal(r.status, 1, args[0]);
      assert.match(r.stderr, /usage/i);
      assert.doesNotMatch(r.stderr + r.stdout, /rejected row|approved row|filed request/);
    }
    assert.equal(dump(s.home, [...LEGACY_TABLES, "signoffs"]), before);
  });

  it("the CLI usage text names list, verify and open only", async () => {
    const r = spawnSync(process.execPath, [REVIEW_CLI], { env: { ...process.env, COCHECK_HOME: await mkdtemp(path.join(tmpdir(), "cocheck-cli-")) }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /list <task>/);
    assert.match(r.stderr, /verify <file>/);
    assert.match(r.stderr, /open \[task\]/);
    assert.doesNotMatch(r.stderr, /reject|approve|request/);
  });
});

describe("the index reads stop verdicts and submissions only", () => {
  const getIndex = async (s: Awaited<ReturnType<typeof setup>>) => {
    const r = await s.call("GET", "/");
    assert.equal(r.status, 200);
    return r.body;
  };

  it("lists a waiting task with its files and the verdicts last marked, and links to the rail", async () => {
    const s = await setup();
    const id = await s.task();
    let html = await getIndex(s);
    assert.match(html, new RegExp(`href="/timeline/${id}/review\\?t=${TOKEN}"`));
    assert.match(html, /<a class="row" href="[^"]+">\s*<span class="gl">/, "unreviewed: a row with the default status, no glyph");
    assert.doesNotMatch(html, /href="\/review\//);
    const status = JSON.parse((await s.call("GET", `/timeline/${id}/review/status`)).body);
    const stops = Object.keys(status.stops).filter((k) => k.startsWith("chg-"));
    await s.call("POST", `/timeline/${id}/review/verdict`, { origin: s.origin, json: { stop: stops[0], status: "failed", note: "bad" } });
    html = await getIndex(s);
    // The old list line "last marked: 1 failed" has no list equivalent: a marked task is a row with the In review glyph and still counted as waiting.
    assert.match(html, /class="gl rev" title="In review"/);
    assert.match(html, /1 session marked but not signed off yet/);
  });

  it("a submitted task moves to the signed-off group and no longer reads as waiting", async () => {
    const s = await setup();
    const id = await s.task();
    const status = JSON.parse((await s.call("GET", `/timeline/${id}/review/status`)).body);
    for (const stop of Object.keys(status.stops)) await s.call("POST", `/timeline/${id}/review/verdict`, { origin: s.origin, json: { stop, status: "passed" } });
    assert.equal((await s.call("POST", `/timeline/${id}/review/submit`, { origin: s.origin, json: {} })).status, 200);
    const html = await getIndex(s);
    assert.match(html, /Nothing is waiting for review\./);
    assert.match(html, /class="gl ok" title="Signed off"/);
    assert.match(html, /signed off by .* on /);
  });

  it("an expired task is listed as expired, not waiting", async () => {
    const s = await setup();
    const id = await s.task();
    s.ledger.recordExpiry(id, new Date());
    const html = await getIndex(s);
    assert.match(html, /class="gl exp" title="Expired"/);
    assert.match(html, /Nothing is waiting for review\./);
  });

  it("renders an index of 100 tasks in under 2 seconds", async () => {
    const s = await setup();
    for (let id = 1; id <= 100; id++) {
      const taskId = s.ledger.openTask(`client-${id}`);
      s.ledger.recordStep({ taskId, client: `client-${id}`, seq: id, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: `/work/book-${id}.txt`, sha256: sha(`v${id}`), prevSha256: null, size: 3, kept: "whole", note: "" }] });
    }
    const started = performance.now();
    const html = (await s.call("GET", "/")).body;
    assert.ok(performance.now() - started < 2000);
    assert.doesNotMatch(html, /Nothing is waiting/);
    assert.equal(html.match(/<a class="row"/g)?.length ?? 0, 100, "one row per task");
  });

  it("opening the index writes nothing to the legacy tables and cuts no round", async () => {
    const s = await setup();
    await s.task();
    const before = dump(s.home, LEGACY_TABLES);
    await getIndex(s);
    await s.call("GET", "/review/1");
    assert.equal(dump(s.home, LEGACY_TABLES), before);
  });
});

describe("an old home with legacy rows", () => {
  it("lists the task, loads its rail, and keeps every legacy row byte for byte", async () => {
    const s = await setup();
    const { taskId } = await oldHome(s.ledger, s.home);
    const before = dump(s.home, [...LEGACY_TABLES, "signoffs"]);
    const index = await s.call("GET", "/");
    assert.equal(index.status, 200);
    assert.match(index.body, new RegExp(`href="/timeline/${taskId}/review\\?t=${TOKEN}"`));
    assert.match(index.body, /signed off by Dana on /);
    for (const p of [`/timeline/${taskId}/review`, `/timeline/${taskId}/review/model`, `/timeline/${taskId}/review/status`, `/timeline/${taskId}`, `/timeline/${taskId}/page`]) {
      const r = await s.call("GET", p);
      assert.equal(r.status, 200, `${p} -> ${r.status} ${r.body.slice(0, 120)}`);
    }
    const model = JSON.parse((await s.call("GET", `/timeline/${taskId}/review/model`)).body);
    assert.deepEqual(model.stops.filter((st: { change?: unknown }) => st.change !== undefined), [], "no file change was recorded for an older task, and the rail says so rather than failing");
    assert.equal((await s.call("GET", `/review/${taskId}`)).status, 404);
    assert.equal(dump(s.home, [...LEGACY_TABLES, "signoffs"]), before, "reading an old home changes no legacy row");
  });

  it("new work in the rail (verdict, send back, submit) writes no legacy row", async () => {
    const s = await setup();
    await oldHome(s.ledger, s.home);
    const id = await s.task();
    const before = dump(s.home, LEGACY_TABLES);
    const status = JSON.parse((await s.call("GET", `/timeline/${id}/review/status`)).body);
    const [first, ...rest] = Object.keys(status.stops);
    assert.equal((await s.call("POST", `/timeline/${id}/review/verdict`, { origin: s.origin, json: { stop: first, status: "failed", note: "bad" } })).status, 200);
    assert.equal((await s.call("POST", `/timeline/${id}/review/sendback`, { origin: s.origin, json: { note: "and the rest" } })).status, 200);
    await s.call("POST", `/timeline/${id}/review/verdict`, { origin: s.origin, json: { stop: first, status: "passed" } });
    for (const stop of rest) await s.call("POST", `/timeline/${id}/review/verdict`, { origin: s.origin, json: { stop, status: "passed" } });
    assert.equal((await s.call("POST", `/timeline/${id}/review/submit`, { origin: s.origin, json: {} })).status, 200);
    assert.equal(dump(s.home, LEGACY_TABLES), before);
  });

  it("the CLI list reads an old home without failing and says so for a task with no recorded file change", async () => {
    const s = await setup();
    const { taskId } = await oldHome(s.ledger, s.home);
    const r = spawnSync(process.execPath, [REVIEW_CLI, "list", String(taskId)], { env: { ...process.env, COCHECK_HOME: s.home }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // There is no start stop, so a task with no request and no file change has no stop at all.
    assert.match(r.stdout, new RegExp(`task ${taskId}: 0 stops: 0 passed, 0 failed, 0 not reviewed; no file change recorded`));
    assert.match(r.stdout, /signed off by Dana \(unverified\)/);
  });
});

describe("the CLI list shows stop statuses and the submission", () => {
  it("prints each stop's status, the failed notes and, after a submit, the submission", async () => {
    const s = await setup();
    const id = await s.task();
    const status = JSON.parse((await s.call("GET", `/timeline/${id}/review/status`)).body);
    const stops = Object.keys(status.stops);
    await s.call("POST", `/timeline/${id}/review/verdict`, { origin: s.origin, json: { stop: stops[0], status: "failed", note: "The line is wrong." } });
    const run = () => spawnSync(process.execPath, [REVIEW_CLI, "list", String(id)], { env: { ...process.env, COCHECK_HOME: s.home }, encoding: "utf8" });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`task ${id}: ${stops.length} stops?: `));
    assert.match(r.stdout, /1 failed/);
    assert.match(r.stdout, /The line is wrong\./);
    assert.doesNotMatch(r.stdout, /signed off|submitted/);
    await s.call("POST", `/timeline/${id}/review/verdict`, { origin: s.origin, json: { stop: stops[0], status: "passed" } });
    for (const stop of stops.slice(1)) await s.call("POST", `/timeline/${id}/review/verdict`, { origin: s.origin, json: { stop, status: "passed" } });
    assert.equal((await s.call("POST", `/timeline/${id}/review/submit`, { origin: s.origin, json: {} })).status, 200);
    r = run();
    assert.match(r.stdout, /submitted by .* \(soft sign-off, not verified\)/);
  });
});
