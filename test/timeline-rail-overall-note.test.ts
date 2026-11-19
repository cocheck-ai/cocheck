import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import { stopIdentities, summarize } from "../src/timeline/rail/stop-status.ts";
import { buildSendBack } from "../src/timeline/rail/send-back.ts";

// Send back takes an optional overall note, usable with or without failed stops. The prompt carries it and the ledger records it
// with the send-back. Guarded against: a note must never be dropped silently, and a send-back with neither a failed stop nor a note
// must still be refused (nothing to send).

const TOKEN = "s".repeat(40);
const CLIENT = "claude:/work";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const change = (id: string, file: string): any => ({
  id, file, kind: "modified", before: { sha256: `b${id}` }, after: { sha256: `a${id}` }, note: { text: `Changed ${file}.`, source: "rule" },
  format: { module: "xlsx", rows: [{ location: "Sheet1!B2", kind: "value", before: null, after: null, text: "B2 went from 10 to 12" }], more: 0 },
});
const stopOf = (c: any): any => ({ id: `chg-${c.id}`, label: path.basename(c.file), head: `Claude changed ${c.file}`, lane: "main", change: { key: c.id, file: c.file, kind: c.kind, note: c.note.text, rowNotes: [], secret: false } });

function fixture(failures: Record<string, string>) {
  const a = change("c1", "/work/budget.xlsx");
  const b = change("c2", "/work/notes.txt");
  const timeline: any = { unplaced: [a, b], requests: [] };
  const model: any = { task: 7, folder: "/work", actors: [], stops: [stopOf(a), stopOf(b)] };
  const ids = stopIdentities(model, timeline);
  const rows = Object.entries(failures).map(([stop, note], i) => ({ id: i + 1, taskId: 7, stopId: stop, subject: ids.get(stop)!.subject, fingerprint: ids.get(stop)!.fingerprint, status: "failed" as const, note, reviewer: "t", ts: "2026-10-12T00:00:00.000Z" }));
  return { model, timeline, summary: summarize(model, timeline, rows) };
}

describe("the prompt carries the overall note", () => {
  it("puts the note in the prompt alongside the failed stops", () => {
    const f = fixture({ "chg-c1": "The total is wrong." });
    const out = buildSendBack(f.model, f.timeline, f.summary, "Also keep the sheet names as they were.");
    assert.deepEqual(out.stops, ["chg-c1"]);
    assert.match(out.prompt, /The total is wrong\./);
    assert.match(out.prompt, /Also keep the sheet names as they were\./);
  });

  it("builds a prompt from the note alone when no stop failed, listing no stop", () => {
    const f = fixture({});
    const out = buildSendBack(f.model, f.timeline, f.summary, "Please redo the whole summary tab.");
    assert.deepEqual(out.stops, []);
    assert.match(out.prompt, /Please redo the whole summary tab\./);
    assert.match(out.prompt, /task 7/);
    assert.doesNotMatch(out.prompt, /steps? failed/);
  });

  it("trims the note, and a blank note counts as none", () => {
    const f = fixture({ "chg-c1": "bad" });
    assert.equal(buildSendBack(f.model, f.timeline, f.summary, "   ").prompt, buildSendBack(f.model, f.timeline, f.summary).prompt);
    assert.match(buildSendBack(f.model, f.timeline, f.summary, "  keep it short  ").prompt, /keep it short(?! )/);
  });

  it("still refuses when there is neither a failed stop nor a note", () => {
    const f = fixture({});
    assert.throws(() => buildSendBack(f.model, f.timeline, f.summary), /nothing to send back/i);
    assert.throws(() => buildSendBack(f.model, f.timeline, f.summary, "  "), /nothing to send back/i);
  });

  it("is deterministic with a note", () => {
    const f = fixture({ "chg-c1": "x" });
    assert.equal(buildSendBack(f.model, f.timeline, f.summary, "n").prompt, buildSendBack(f.model, f.timeline, f.summary, "n").prompt);
  });
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const ledger: Ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = (method: string, p: string, opts: { token?: string | null; origin?: string | null; json?: unknown; raw?: string } = {}): Promise<{ status: number; body: string }> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const url = token === null ? p : `${p}?t=${token}`;
    const body = opts.raw ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (body !== undefined) headers["content-type"] = "application/json";
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
  let seq = 0;
  const file = "/work/notes.txt";
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
  const verdict = (id: number, json: unknown) => call("POST", `/timeline/${id}/review/verdict`, { json, origin: `http://127.0.0.1:${port}` });
  const sendBack = (id: number, json: unknown = {}, extra: { token?: string | null; origin?: string | null; raw?: string } = {}) =>
    call("POST", `/timeline/${id}/review/sendback`, { json, origin: extra.origin === undefined ? `http://127.0.0.1:${port}` : extra.origin, ...(extra.token === undefined ? {} : { token: extra.token }), ...(extra.raw === undefined ? {} : { raw: extra.raw }) });
  const stops = async (id: number): Promise<string[]> => Object.keys(JSON.parse((await call("GET", `/timeline/${id}/review/status`)).body).stops).filter((k) => k.startsWith("chg-"));
  return { home, ledger, port, call, task, verdict, sendBack, stops };
}

describe("the send-back route with an overall note", () => {
  it("with failed stops: the prompt carries the note and the ledger records it with the send-back", async () => {
    const s = await setup();
    const id = await s.task();
    const first = (await s.stops(id)).at(-1)!; // the latest state: a fail on an older state of the file is replaced and not sent back
    await s.verdict(id, { stop: first, status: "failed", note: "First line is wrong." });
    const r = await s.sendBack(id, { note: "  Also check the totals row.  " });
    assert.equal(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.deepEqual(j.stops, [first]);
    assert.match(j.prompt, /First line is wrong\./);
    assert.match(j.prompt, /Also check the totals row\./);
    const rows = s.ledger.sendBacksForTask(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.note, "Also check the totals row.");
    assert.equal(rows[0]!.prompt, j.prompt);
    assert.deepEqual(rows[0]!.stopIds, [first]);
  });

  it("with no failed stop: a note alone is a send-back, with no stop ids", async () => {
    const s = await setup();
    const id = await s.task();
    const first = (await s.stops(id)).at(-1)!; // the latest state: a fail on an older state of the file is replaced and not sent back
    await s.verdict(id, { stop: first, status: "passed" });
    const r = await s.sendBack(id, { note: "Please add a totals row." });
    assert.equal(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.deepEqual(j.stops, []);
    assert.match(j.prompt, /Please add a totals row\./);
    const rows = s.ledger.sendBacksForTask(id);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.stopIds, []);
    assert.equal(rows[0]!.note, "Please add a totals row.");
  });

  it("without a note the send-back records an empty note, as before", async () => {
    const s = await setup();
    const id = await s.task();
    const first = (await s.stops(id)).at(-1)!; // the latest state: a fail on an older state of the file is replaced and not sent back
    await s.verdict(id, { stop: first, status: "failed", note: "bad" });
    assert.equal((await s.sendBack(id, {})).status, 200);
    assert.equal(s.ledger.sendBacksForTask(id)[0]!.note, "");
  });

  it("refuses with 409 and records nothing when there is no failed stop and no note (or only blanks)", async () => {
    const s = await setup();
    const id = await s.task();
    for (const body of [{}, { note: "" }, { note: "   \n " }]) {
      const r = await s.sendBack(id, body);
      assert.equal(r.status, 409, r.body);
    }
    assert.deepEqual(s.ledger.sendBacksForTask(id), []);
  });

  it("refuses a note that is not text or is too long, and records nothing", async () => {
    const s = await setup();
    const id = await s.task();
    const first = (await s.stops(id)).at(-1)!; // the latest state: a fail on an older state of the file is replaced and not sent back
    await s.verdict(id, { stop: first, status: "failed", note: "bad" });
    for (const note of [5, null, ["a"], { a: 1 }, true]) assert.equal((await s.sendBack(id, { note })).status, 400, JSON.stringify(note));
    assert.equal((await s.sendBack(id, { note: "x".repeat(2001) })).status, 400);
    assert.equal((await s.sendBack(id, {}, { raw: "{not json" })).status, 400);
    assert.deepEqual(s.ledger.sendBacksForTask(id), []);
    assert.equal((await s.sendBack(id, { note: "x".repeat(2000) })).status, 200);
  });

  it("keeps the token and origin rules for a note-only send-back: wrong token, foreign or missing origin refused", async () => {
    const s = await setup();
    const id = await s.task();
    assert.equal((await s.sendBack(id, { note: "n" }, { token: "wrong" })).status, 403);
    assert.equal((await s.sendBack(id, { note: "n" }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await s.sendBack(id, { note: "n" }, { origin: null })).status, 403);
    assert.deepEqual(s.ledger.sendBacksForTask(id), []);
  });

  it("stays append-only with the note column", async () => {
    const s = await setup();
    const id = await s.task();
    await s.sendBack(id, { note: "n" });
    const db = new DatabaseSync(path.join(s.home, "ledger.sqlite"));
    try {
      assert.throws(() => db.exec("UPDATE send_backs SET note = ''"), /append-only/);
    } finally {
      db.close();
    }
  });

});

describe("the page", () => {
  // the whole-task #sbnote and #notepanel are retired; a whole-task note is a sticky note with no spot, and Send back carries every live note by itself
  it("has a sticky-note field in the bar, no whole-task panel, and the script sends the send-back with no id list", async () => {
    const html = renderReviewShell(1);
    assert.match(html, /<textarea[^>]*id="nnote"[^>]*maxlength="2000"/);
    assert.doesNotMatch(html, /id="sbnote"|id="notepanel"/);
    const js = await readFile(path.resolve(import.meta.dirname, "../src/timeline/rail/assets/review.js"), "utf8");
    const sb = js.slice(js.indexOf("Send back panel:"), js.indexOf("Submit panel:"));
    // Send-back choice: the body is {} with nothing to pick, else only the notes choice; never an id list.
    assert.match(sb, /postSendBack\(\{\}\)/);
    assert.match(sb, /postSendBack\(\{ notes: notes \}\)/);
    assert.match(sb, /body: JSON\.stringify\(body\)/);
    assert.ok(!/innerHTML/.test(sb));
  });

  it("lets Send back be pressed with a note and no failed stop", async () => {
    const js = await readFile(path.resolve(import.meta.dirname, "../src/timeline/rail/assets/review.js"), "utf8");
    const fn = js.slice(js.indexOf("function paintSendBack"), js.indexOf("function clearPrompt"));
    assert.match(fn, /var can = liveFails\(\) > 0 \|\| NOTES\.length > 0/);
    assert.match(fn, /disabled = !can/);
  });
});
