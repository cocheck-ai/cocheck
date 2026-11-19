import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import { stopIdentities, summarize } from "../src/timeline/rail/stop-status.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { buildSendBack } from "../src/timeline/rail/send-back.ts";

// Send back writes the fix prompt. The pure builder is tested on a hand-made record; the route on a real ledger and review server on a
// temp home (no real CoCheck home, no browser). Guarded against: no failed stop is left out of the prompt, and nothing in it is invented.

const TOKEN = "s".repeat(40);
const CLIENT = "claude:/work";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ---- the pure builder ------------------------------------------------------------------------------------------------------------------

const change = (id: string, file: string, rows: Array<{ location: string; text: string }>, extra: Record<string, unknown> = {}): any => ({
  id, file, kind: "modified", before: { sha256: `b${id}` }, after: { sha256: `a${id}` }, note: { text: `Changed ${file}.`, source: "rule" },
  format: rows.length === 0 ? null : { module: "xlsx", rows: rows.map((r) => ({ ...r, kind: "value", before: null, after: null })), more: 0 }, ...extra,
});
const stopOf = (c: any, extra: Record<string, unknown> = {}): any => ({ id: `chg-${c.id}`, label: path.basename(c.file), head: `Claude changed ${c.file}`, lane: "main", change: { key: c.id, file: c.file, kind: c.kind, note: c.note.text, rowNotes: [], secret: false }, ...extra });

function fixture(failures: Record<string, string>, extraStops: any[] = []) {
  const a = change("c1", "/work/budget.xlsx", [{ location: "Sheet1!B2", text: "B2 went from 10 to 12" }, { location: "Sheet1!C7", text: "C7 became a formula" }]);
  const b = change("c2", "/work/notes.txt", []);
  const c = change("c3", "/work/slides.pdf", [{ location: "page 3", text: "Page 3 text changed" }]);
  const timeline: any = { unplaced: [a, b, c], requests: [] };
  const model: any = { task: 7, folder: "/work", actors: [], stops: [stopOf(a), stopOf(b), stopOf(c), ...extraStops] };
  const ids = stopIdentities(model, timeline);
  const rows = Object.entries(failures).map(([stop, note], i) => ({ id: i + 1, taskId: 7, stopId: stop, subject: ids.get(stop)!.subject, fingerprint: ids.get(stop)!.fingerprint, status: "failed" as const, note, reviewer: "t", ts: "2026-10-12T00:00:00.000Z" }));
  return { model, timeline, summary: summarize(model, timeline, rows) };
}

describe("the prompt is built from the record", () => {
  it("lists every failed stop with its file, cells, what changed and the person's note", () => {
    const f = fixture({ "chg-c1": "The total is wrong.", "chg-c3": "Page 3 lost a table." });
    const out = buildSendBack(f.model, f.timeline, f.summary);
    assert.deepEqual(out.stops, ["chg-c1", "chg-c3"]);
    assert.match(out.prompt, /\/work\/budget\.xlsx/);
    assert.match(out.prompt, /Sheet1!B2/);
    assert.match(out.prompt, /Sheet1!C7/);
    assert.match(out.prompt, /B2 went from 10 to 12/);
    assert.match(out.prompt, /The total is wrong\./);
    assert.match(out.prompt, /\/work\/slides\.pdf/);
    assert.match(out.prompt, /page 3/);
    assert.match(out.prompt, /Page 3 lost a table\./);
  });

  it("leaves out nothing: every failed stop is named even with no location, and a passed or unreviewed stop is not", () => {
    const req = { id: "req-1", label: "Your request", head: "You made request 1", lane: "you", request: { text: "Fix the notes." } };
    const f = fixture({ "chg-c1": "n1", "chg-c2": "n2", "chg-c3": "n3" }, [req]);
    const out = buildSendBack(f.model, f.timeline, f.summary);
    assert.equal(out.stops.length, 3);
    for (const note of ["n1", "n2", "n3"]) assert.ok(out.prompt.includes(note), note);
    assert.ok(out.prompt.includes("/work/notes.txt"));
    assert.ok(!out.prompt.includes("Fix the notes."), "an unfailed stop stays out");
    const one = buildSendBack(f.model, f.timeline, fixture({ "chg-c2": "only this" }).summary);
    assert.deepEqual(one.stops, ["chg-c2"]);
    assert.ok(!one.prompt.includes("budget.xlsx"));
  });

  it("does not guess a location: a file with no cell rows gets its path and no cell line", () => {
    const f = fixture({ "chg-c2": "bad" });
    const out = buildSendBack(f.model, f.timeline, f.summary);
    assert.ok(out.prompt.includes("/work/notes.txt"));
    assert.ok(!/Sheet|cell|page \d/i.test(out.prompt));
  });

  it("is deterministic: the same record gives the same text", () => {
    const f = fixture({ "chg-c1": "x", "chg-c3": "y" });
    assert.equal(buildSendBack(f.model, f.timeline, f.summary).prompt, buildSendBack(f.model, f.timeline, f.summary).prompt);
  });

  it("refuses to build when nothing failed", () => {
    const f = fixture({});
    assert.throws(() => buildSendBack(f.model, f.timeline, f.summary), /no failed stop/i);
  });

  it("gives a secret file its name and the person's note and nothing from inside it", () => {
    const f = fixture({ "chg-c1": "wrong key" });
    f.timeline.unplaced[0].format.rows[0].text = "password is hunter2";
    f.model.stops[0].change.secret = true;
    f.model.stops[0].change.file = "/work/.env";
    const out = buildSendBack(f.model, f.timeline, f.summary);
    assert.ok(!out.prompt.includes("hunter2"));
    assert.ok(out.prompt.includes("wrong key"));
  });
});

// ---- the route ------------------------------------------------------------------------------------------------------------------------

interface Res { status: number; body: string }
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const ledger: Ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = (method: string, p: string, opts: { token?: string | null; origin?: string | null; json?: unknown; raw?: string; ctype?: string | null } = {}): Promise<Res> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const url = token === null ? p : `${p}?t=${token}`;
    const body = opts.raw ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (body !== undefined && opts.ctype !== null) headers["content-type"] = opts.ctype ?? "application/json";
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
  const latestText = new Map<number, string>();
  /** The agent writes one more state of the file, recorded after whatever the person did so far (a fail is replaced only by a state recorded after it). */
  const later = async (id: number): Promise<void> => {
    await new Promise((r) => setTimeout(r, 15));
    const prev = latestText.get(id)!, text = `${prev}and later\n`;
    ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [`toolu_${id}`], credited: [`toolu_${id}`], files: [{ filePath: file, sha256: sha(text), prevSha256: sha(prev), size: text.length, kept: "whole", note: "" }] });
    latestText.set(id, text);
  };
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
    latestText.set(id, t1);
    return id;
  };
  const verdict = (id: number, json: unknown) => call("POST", `/timeline/${id}/review/verdict`, { json, origin: `http://127.0.0.1:${port}` });
  const sendBack = (id: number, opts: { token?: string | null; origin?: string | null; json?: unknown; ctype?: string | null } = {}) =>
    call("POST", `/timeline/${id}/review/sendback`, { json: opts.json ?? {}, origin: opts.origin === undefined ? `http://127.0.0.1:${port}` : opts.origin, ...(opts.token === undefined ? {} : { token: opts.token }), ...(opts.ctype === undefined ? {} : { ctype: opts.ctype }) });
  const stops = async (id: number): Promise<string[]> => Object.keys(JSON.parse((await call("GET", `/timeline/${id}/review/status`)).body).stops).filter((k) => k.startsWith("chg-"));
  return { home, ledger, port, call, task, verdict, sendBack, stops, later };
}

describe("the send-back route", () => {
  it("returns the prompt for the failed stops and records the exact text and stop ids in the ledger", async () => {
    const s = await setup();
    const id = await s.task();
    const [, second] = await s.stops(id);
    // Both states are of one file, so the first is replaced by the second and is not sent back; a request stop fails beside the second.
    const other = JSON.parse((await s.call("GET", `/timeline/${id}/review/status`)).body).stops;
    const req = Object.keys(other).find((k) => !k.startsWith("chg-"))!;
    await s.verdict(id, { stop: req, status: "failed", note: "First line is wrong." });
    await s.verdict(id, { stop: second, status: "failed", note: "Second is wrong too." });
    const r = await s.sendBack(id);
    assert.equal(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.deepEqual([...j.stops].sort(), [req, second].sort());
    assert.ok(j.prompt.includes("First line is wrong.") && j.prompt.includes("Second is wrong too.") && j.prompt.includes("/work/notes.txt") || j.prompt.includes("notes.txt"));
    const rows = s.ledger.sendBacksForTask(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.prompt, j.prompt);
    assert.deepEqual(rows[0]!.stopIds, j.stops);
  });

  it("reads only the stops that are failed now: a stop passed afterwards is not in the prompt", async () => {
    const s = await setup();
    const id = await s.task();
    const [first, second] = await s.stops(id);
    await s.verdict(id, { stop: first, status: "failed", note: "Old complaint." });
    await s.verdict(id, { stop: second, status: "failed", note: "Live complaint." });
    await s.verdict(id, { stop: first, status: "passed" });
    const j = JSON.parse((await s.sendBack(id)).body);
    assert.deepEqual(j.stops, [second]);
    assert.ok(!j.prompt.includes("Old complaint."));
  });

  it("only replaced fails and no note: 409 nothing to send, nothing recorded; with a note the note goes alone", async () => {
    const s = await setup();
    const id = await s.task();
    const [first] = await s.stops(id);
    await s.verdict(id, { stop: first, status: "failed", note: "Old draft." });
    assert.equal((await s.sendBack(id)).status, 200); // only a fail a send-back carried can be replaced
    await new Promise((r) => setTimeout(r, 15));
    await s.later(id); // the agent wrote a new state after the send-back: the fail is replaced, never resent
    const r = await s.sendBack(id);
    assert.equal(r.status, 409, r.body);
    assert.match(JSON.parse(r.body).error, /nothing to send back/);
    assert.equal(s.ledger.sendBacksForTask(id).length, 1, "nothing more was recorded");
    const n = await s.sendBack(id, { json: { note: "Tidy up." } });
    assert.equal(n.status, 200, n.body);
    const j = JSON.parse(n.body);
    assert.deepEqual(j.stops, []);
    assert.ok(!j.prompt.includes("Old draft.") && j.prompt.includes("Tidy up."));
  });

  it("a fail on the current state still sends, beside a replaced fail", async () => {
    const s = await setup();
    const id = await s.task();
    const [first] = await s.stops(id);
    await s.verdict(id, { stop: first, status: "failed", note: "Old draft." });
    assert.equal((await s.sendBack(id)).status, 200); // the send-back carried it
    await new Promise((r) => setTimeout(r, 15));
    await s.later(id); // a state recorded after that send-back replaces it
    const third = (await s.stops(id)).at(-1)!;
    await s.verdict(id, { stop: third, status: "failed", note: "Current is wrong." });
    const r = await s.sendBack(id);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body).stops, [third]);
  });

  it("is refused with a 4xx and records nothing when no stop is failed", async () => {
    const s = await setup();
    const id = await s.task();
    const first = (await s.stops(id)).at(-1)!; // the latest state: a fail on an older state of the file is replaced and not sent back
    await s.verdict(id, { stop: first, status: "passed" });
    const r = await s.sendBack(id);
    assert.equal(r.status, 409);
    assert.deepEqual(s.ledger.sendBacksForTask(id), []);
  });

  it("follows the token and origin rules: wrong token, foreign or missing origin, non-JSON and GET are all refused and record nothing", async () => {
    const s = await setup();
    const id = await s.task();
    const first = (await s.stops(id)).at(-1)!; // the latest state: a fail on an older state of the file is replaced and not sent back
    await s.verdict(id, { stop: first, status: "failed", note: "bad" });
    assert.equal((await s.sendBack(id, { token: "wrong" })).status, 403);
    assert.equal((await s.sendBack(id, { token: null })).status, 403);
    assert.equal((await s.sendBack(id, { origin: "http://evil.example" })).status, 403);
    assert.equal((await s.sendBack(id, { origin: null })).status, 403);
    assert.equal((await s.sendBack(id, { ctype: "text/plain" })).status, 415);
    assert.equal((await s.call("GET", `/timeline/${id}/review/sendback`)).status, 405);
    assert.equal((await s.sendBack(99999)).status, 404);
    assert.deepEqual(s.ledger.sendBacksForTask(id), []);
    assert.equal((await s.sendBack(id)).status, 200);
  });

  it("keeps the send-back table append-only in the database", async () => {
    const s = await setup();
    const id = await s.task();
    const first = (await s.stops(id)).at(-1)!; // the latest state: a fail on an older state of the file is replaced and not sent back
    await s.verdict(id, { stop: first, status: "failed", note: "bad" });
    await s.sendBack(id);
    const db = new DatabaseSync(path.join(s.home, "ledger.sqlite"));
    try {
      assert.throws(() => db.exec("UPDATE send_backs SET prompt = ''"), /append-only/);
      assert.throws(() => db.exec("DELETE FROM send_backs"), /append-only/);
    } finally {
      db.close();
    }
    assert.equal(s.ledger.sendBacksForTask(id).length, 1);
  });

  it("has no CLI or MCP path that writes a send-back: only the review server writes one", async () => {
    const { execFileSync } = await import("node:child_process");
    const hits = execFileSync("grep", ["-rlE", "sendback|send_back|SendBack|sendBack", "src"], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" }).split("\n").filter(Boolean).sort();
    assert.deepEqual(hits, ["src/ledger.ts", "src/review-server.ts", "src/timeline/rail/assets/review.js", "src/timeline/rail/page.ts", "src/timeline/rail/passes.ts", "src/timeline/rail/send-back.ts"]);
  });
});

describe("every change in a failed stop is listed or counted", () => {
  it("counts the changes the format layer capped off (format.more) and names where they are", () => {
    const f = fixture({ "chg-c1": "bad" });
    f.timeline.unplaced[0].format = { module: "xlsx", rows: [{ location: "Sheet1!A1", kind: "value", before: null, after: null, text: "A1 went from 1 to 2" }], more: 40, moreIn: [{ place: "Sheet1", count: 40, from: 2, to: 41 }] };
    const out = buildSendBack(f.model, f.timeline, f.summary);
    assert.match(out.prompt, /40 more changes are in this file and not listed/);
    assert.match(out.prompt, /Sheet1/);
    assert.match(out.prompt, /rows 2 to 41/);
  });

  it("adds the builder's own cap and format.more into one count", () => {
    const f = fixture({ "chg-c1": "bad" });
    const rows = Array.from({ length: 30 }, (_, i) => ({ location: `Sheet1!A${i + 1}`, kind: "value", before: null, after: null, text: `A${i + 1} changed` }));
    f.timeline.unplaced[0].format = { module: "xlsx", rows, more: 10 };
    assert.match(buildSendBack(f.model, f.timeline, f.summary).prompt, /15 more changes are in this file and not listed/);
  });

  it("says so when a failed file has no format record at all, and when the record holds no change for the stop", () => {
    const f = fixture({ "chg-c2": "bad" });
    assert.match(buildSendBack(f.model, f.timeline, f.summary).prompt, /individual changes inside this file are not listed/);
    const g = fixture({ "chg-c2": "bad" });
    g.timeline.unplaced = [];
    assert.match(buildSendBack(g.model, g.timeline, g.summary).prompt, /no detail of what changed/);
  });

  it("does not repeat the location, on real xlsx format-layer output", async () => {
    const dir = path.resolve(import.meta.dirname, "fixtures");
    // core's default layers read no workbook; the send-back wording is checked on the xlsx layer's own rows
    const layer = createXlsxLayer({ openState: async () => "closed" });
    const diff = await layer.diff(path.join(dir, "value-edit-before.xlsx"), path.join(dir, "value-edit-after.xlsx"));
    assert.ok(diff.length > 0);
    const rows = diff.map((r: any) => ({ location: r.location, kind: r.kind, before: null, after: null, text: layer.describe(r) }));
    const f = fixture({ "chg-c1": "bad" });
    f.timeline.unplaced[0].format = { module: "xlsx", rows, more: 0 };
    const prompt = buildSendBack(f.model, f.timeline, f.summary).prompt;
    for (const r of rows) {
      assert.ok(prompt.includes(r.text), r.text);
      assert.ok(!prompt.includes(`${r.location}: ${r.text}`) || !r.text.startsWith(r.location), `repeated ${r.location}`);
    }
    assert.ok(!/(\w+![A-Z]+\d+): \1/.test(prompt), prompt);
  });
});

describe("the page clears the prompt", () => {
  it("hides and empties the prompt box whenever the failed set may have changed", async () => {
    const { readFile } = await import("node:fs/promises");
    const js = await readFile(path.resolve(import.meta.dirname, "../src/timeline/rail/assets/review.js"), "utf8");
    const fn = js.slice(js.indexOf("function noteFailed"), js.indexOf("function noteFailed") + 300);
    assert.match(fn, /clearPrompt\(\)/);
    assert.match(js, /function clearPrompt\(force\)[^\n]*sbout[^\n]*hidden = true[^\n]*sbtext[^\n]*value = ''/);
  });
});

describe("the page", () => {
  it("has a Send back button and an editable prompt box, filled by textContent or value and never innerHTML", async () => {
    const html = renderReviewShell(1);
    assert.match(html, /id="sendback"/);
    assert.doesNotMatch(html, /<textarea[^>]*id="sbtext"[^>]*readonly/);
    assert.match(html, /id="sbcopy"/);
    const { readFile } = await import("node:fs/promises");
    const js = await readFile(path.resolve(import.meta.dirname, "../src/timeline/rail/assets/review.js"), "utf8");
    const sb = js.slice(js.indexOf("Send back panel:"));
    assert.ok(sb.length > 100, "the script carries a block");
    assert.ok(!/innerHTML/.test(sb));
    assert.match(sb, /review\/sendback/);
    assert.match(sb, /\.value = j\.prompt|textContent = j\.prompt/);
  });
});

describe("an unsent fail is never superseded", () => {
  it("verdict, then a new agent state, then Send back still carries the fail (the lost-fail path)", async () => {
    const s = await setup();
    const id = await s.task();
    const [first] = await s.stops(id);
    await s.verdict(id, { stop: first, status: "failed", note: "Unsent complaint." });
    await new Promise((r) => setTimeout(r, 15));
    await s.later(id); // the agent writes a state between the verdict and the send-back
    const r = await s.sendBack(id);
    assert.equal(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.deepEqual(j.stops, [first]);
    assert.ok(j.prompt.includes("Unsent complaint."));
  });

  it("send-back, then a new state: the old fail is superseded and never resent", async () => {
    const s = await setup();
    const id = await s.task();
    const [first] = await s.stops(id);
    await s.verdict(id, { stop: first, status: "failed", note: "Complaint." });
    assert.equal((await s.sendBack(id)).status, 200);
    await new Promise((r) => setTimeout(r, 15));
    await s.later(id);
    const again = await s.sendBack(id);
    assert.equal(again.status, 409, again.body);
    const st = JSON.parse((await s.call("GET", `/timeline/${id}/review/status`)).body);
    assert.deepEqual([st.submit.superseded, st.submit.blocking], [[first], []]);
  });

  it("an unsent fail blocks Submit even with a newer state of the file", async () => {
    const s = await setup();
    const id = await s.task();
    const [first] = await s.stops(id);
    await s.verdict(id, { stop: first, status: "failed", note: "Unsent complaint." });
    await new Promise((r) => setTimeout(r, 15));
    await s.later(id);
    const st = JSON.parse((await s.call("GET", `/timeline/${id}/review/status`)).body);
    assert.deepEqual([st.submit.superseded, st.submit.blocking, st.submit.eligible], [[], [first], false]);
  });
});
