import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { plantValueRows } from "./helpers/planted-rows.ts";

// every value a task captured is blanked on
// one schedule, the free text the person wrote included. Pinned: a task not yet at the expiry point keeps everything.

const DAY = 24 * 60 * 60 * 1000;
const S = { file: "ZQFILEVALUE", note: "ZQVERDICTNOTE", prompt: "ZQSENDBACKPROMPT", sbNote: "ZQSENDBACKNOTE", copy: "ZQCOPIEDTEXT", intent: "ZQINTENT", sticky: "ZQSTICKYNOTE" };

/**
 * Every TEXT column of every table, classified. STRUCTURAL columns hold ids, paths, kinds, statuses, hashes, times, nonces, counts or wording
 * the system itself wrote (file_states.note and the left-out reasons are system sentences about a path; signoffs.rejections_json is
 * [{round, rejections}] counts; files_json and covered_json are paths, hashes and statuses). VALUE columns hold what the task captured or the
 * person wrote: they must hold no sentinel after expiry. A column in neither list fails the sweep: a new table or column must be classified here.
 */
const STRUCTURAL: Record<string, string[]> = {
  capture_outcomes: ["ts", "client", "call_id", "subject", "outcome", "reason"],
  events: ["ts", "kind"],
  file_state_captures: ["state", "connector_version", "connector_spec", "changes_sha256", "reason", "ts"],  // reason: CoCheck's own wording (a category), never the connector's text
  file_state_capture_tries: ["changes_sha256", "ts"], // the hash of an "ask again" answer sealed in the change store (removed with the task's values), and when
  file_state_proofs: ["credit_basis", "ts"],
  file_states: ["file_path", "sha256", "prev_sha256", "phase", "calls_open_json", "credited_json", "kept", "note", "mtime_ns", "credit_basis", "connector", "connector_version", "connector_spec", "changes_sha256", "before_basis"],  // before_basis: 'declared' or NULL, structural
  follows: ["ts"],
  item_resolutions: ["resolution", "client_name", "op_ids_json", "ts"],
  ops: ["ts", "tool", "client_name", "client_version", "result_code"],
  request_confirmations: ["verdict", "reviewer", "ts"],
  request_resolutions: ["resolution", "client_name", "op_ids_json", "ts"],
  review_decisions: ["decision", "reviewer", "ts"],
  review_requests: ["reviewer", "ts"],
  review_rows: ["file_path", "layer", "location", "kind", "status"],
  round_results: ["ts"],
  rounds: ["ts", "client_name"],
  schema_version: [],
  send_back_copies: ["ts"],
  note_regions: ["change_key", "side", "kind", "sha", "ts"],
  region_links: ["ts"],
  review_notes: ["ts", "stop_id"],
  send_backs: ["stop_ids_json", "reviewer", "ts", "nonce"],
  session_coverage: ["session_id", "host", "checked_at", "status", "reason", "names_json"],
  signoffs: ["signer", "ts", "rejections_json", "files_json", "left_out_json", "signature"],
  snapshot_removals: ["ts"],
  state_removals: ["sha256", "ts", "reason"],
  steps: ["client", "phase", "ts", "calls_open_json", "credited_json"],
  stop_verdicts: ["stop_id", "subject", "fingerprint", "status", "reviewer", "ts"],
  submissions: ["acknowledged_json", "reviewer", "ts", "covered_json"],
  task_activity: ["actor", "ts"],
  task_closures: ["kind", "ts"],
  task_snapshots: ["file_path", "layer", "snapshot_path", "mode", "ts", "sha256"],
  tasks: ["created_at", "title", "client"],
  values_expired: ["ts"],
};
const VALUE: Record<string, string[]> = {
  events: ["payload_json"],
  file_state_captures: ["detail"],
  ops: ["args_json", "intent", "error_text"],
  review_decisions: ["note"],
  review_requests: ["note"],
  note_regions: ["rect_json", "where_text"],
  review_rows: ["before_json", "after_json", "ops_json", "description", "detail_json"],
  request_confirmations: ["note"],
  item_resolutions: ["intent"],
  request_resolutions: ["intent"],
  round_results: ["result_json"],
  rounds: ["intent"],
  send_back_copies: ["text"],
  send_backs: ["prompt", "note"],
  stop_verdicts: ["note"],
  review_notes: ["text"],
};

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const ledger = openLedger(home);
  let skew = 0;
  const tasks = new TaskStore(ledger, home, [createFilesLayer()], () => Date.now() + skew);
  return {
    home, ledger, tasks, file: (n: string) => path.join(folder, n), advance: (ms: number) => (skew = ms),
    cleanup: async () => { ledger.close(); await rm(home, { recursive: true, force: true }); await rm(folder, { recursive: true, force: true }); },
  };
}
type T = Awaited<ReturnType<typeof setup>>;

/** A task with a signed version, a verdict note, a send-back with a prompt and note, and a copy of it, every one carrying a sentinel. */
async function populate(t: T): Promise<{ id: number; sb: number }> {
  await writeFile(t.file("a.txt"), `${S.file} one\n`);
  const id = await t.tasks.touch("c", t.file("a.txt"));
  await writeFile(t.file("a.txt"), `${S.file} two\n`);
  await t.tasks.submit("c", S.intent, false);
  // the round writes no value row for a text file, so the row that carries the file value (the sentinel) is planted through the ledger.
  plantValueRows(t.ledger, id, [{ file: t.file("a.txt"), before: `${S.file} one`, after: `${S.file} two` }]);
  const copy = t.ledger.snapshotsForTask(id).find((x) => x.sha256 !== null);
  t.ledger.appendStopVerdict({ taskId: id, stopId: "s1", subject: "a.txt", fingerprint: "f".repeat(64), status: "failed", note: S.note, reviewer: "Dana" });
  const sb = t.ledger.appendSendBack({ taskId: id, prompt: S.prompt, stopIds: ["s1"], reviewer: "Dana", note: S.sbNote });
  t.ledger.appendSendBackCopy(sb, S.copy);
  t.ledger.appendNote(id, S.sticky, null);
  t.ledger.recordSoftSubmission({ taskId: id, signer: "Dana", rounds: 0, rejections: [], files: [], leftOut: [], closedTask: false, acknowledged: [], reviewer: "Dana", covered: [{ stop: "s1", status: "failed", sha256: copy?.sha256 ?? null }] });
  return { id, sb };
}

const db = (t: T) => new DatabaseSync(path.join(t.home, "ledger.sqlite"));
const tables = (d: DatabaseSync) => (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
const textColumns = (d: DatabaseSync, table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>).filter((c) => c.type === "TEXT").map((c) => c.name);

/** Where each sentinel still sits in a value column of any table. */
function sweep(t: T): string[] {
  const d = db(t);
  const hits: string[] = [];
  for (const [table, cols] of Object.entries(VALUE)) {
    for (const c of cols) {
      for (const [k, needle] of Object.entries(S)) {
        const n = (d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${c} LIKE ?`).get(`%${needle}%`) as { n: number }).n;
        if (n > 0) hits.push(`${table}.${c}:${k}`);
      }
    }
  }
  d.close();
  return hits;
}

async function expire(t: T): Promise<void> {
  t.advance(8 * DAY);
  await t.tasks.sweep();
  t.advance(40 * DAY);
  await t.tasks.sweep();
}

describe("the universe sweep", () => {
  it("every TEXT column of every table is classified, and a column the lists do not know fails", async () => {
    const t = await setup();
    try {
      const d = db(t);
      const unknown: string[] = [];
      for (const table of tables(d)) {
        for (const col of textColumns(d, table)) if (!(STRUCTURAL[table] ?? []).includes(col) && !(VALUE[table] ?? []).includes(col)) unknown.push(`${table}.${col}`);
      }
      assert.deepEqual(unknown, [], "classify every new column as structural or value in this test");
      for (const table of Object.keys({ ...STRUCTURAL, ...VALUE })) assert.ok(tables(d).includes(table), `${table} is a table`);
      for (const [table, cols] of Object.entries({ ...STRUCTURAL, ...VALUE })) for (const c of cols) assert.ok(textColumns(d, table).includes(c), `${table}.${c} is a TEXT column`);
      d.close();
    } finally {
      await t.cleanup();
    }
  });

  it("after expiry no value column of any table holds a file value, note, prompt, copied text or intent", async () => {
    const t = await setup();
    try {
      const { id } = await populate(t);
      const before = sweep(t);
      for (const k of ["file", "note", "prompt", "sbNote", "copy", "intent", "sticky"]) assert.ok(before.some((h) => h.endsWith(`:${k}`)), `${k} is in the ledger before expiry`);
      await expire(t);
      assert.ok(t.ledger.valuesExpiredAt(id));
      assert.deepEqual(sweep(t), []);
      const sb = t.ledger.sendBacksForTask(id);
      assert.equal(sb.length, 1);
      assert.equal(sb[0]!.prompt, "");
      assert.equal(sb[0]!.note, "");
      assert.match(sb[0]!.nonce ?? "", /^[a-z0-9]{6}$/);
      assert.deepEqual(sb[0]!.stopIds, ["s1"]);
      assert.equal(t.ledger.sendBackCopies(sb[0]!.id)[0]!.text, "");
      const v = t.ledger.stopVerdictsForTask(id)[0]!;
      assert.equal(v.note, "");
      assert.equal(v.status, "failed");
      assert.equal(v.stopId, "s1");
      assert.equal(v.fingerprint, "f".repeat(64));
      assert.deepEqual(t.ledger.liveNotes(id).map((n) => n.text), [""]);
      assert.equal(t.ledger.submissionsForTask(id).length, 1);
    } finally {
      await t.cleanup();
    }
  });
});

describe("the append-only triggers allow exactly the blanking", () => {
  const refuses = (d: DatabaseSync, sql: string) => assert.throws(() => d.exec(sql), /append-only/, sql);

  it("an expired task: every other UPDATE and every DELETE is refused, even next to a blanking", async () => {
    const t = await setup();
    const d = db(t);
    try {
      const { id, sb } = await populate(t);
      await expire(t);
      refuses(d, `UPDATE stop_verdicts SET note = 'x' WHERE task_id = ${id}`);
      refuses(d, `UPDATE stop_verdicts SET status = 'passed' WHERE task_id = ${id}`);
      refuses(d, `UPDATE stop_verdicts SET stop_id = '' WHERE task_id = ${id}`);
      refuses(d, `UPDATE stop_verdicts SET note = '', ts = 'x' WHERE task_id = ${id}`);
      refuses(d, `UPDATE send_backs SET prompt = 'x' WHERE task_id = ${id}`);
      refuses(d, `UPDATE send_backs SET nonce = 'aaaaaa' WHERE task_id = ${id}`);
      refuses(d, `UPDATE send_backs SET stop_ids_json = '[]' WHERE task_id = ${id}`);
      refuses(d, `UPDATE send_backs SET prompt = '', reviewer = 'x' WHERE task_id = ${id}`);
      refuses(d, `UPDATE send_back_copies SET text = 'x' WHERE send_back_id = ${sb}`);
      refuses(d, `UPDATE send_back_copies SET ts = 'x' WHERE send_back_id = ${sb}`);
      refuses(d, `UPDATE send_back_copies SET text = '', send_back_id = 999 WHERE send_back_id = ${sb}`);
      refuses(d, "DELETE FROM stop_verdicts");
      refuses(d, "DELETE FROM send_backs");
      refuses(d, "DELETE FROM send_back_copies");
    } finally {
      d.close();
      await t.cleanup();
    }
  });

  it("before the expiry point blanking is refused, as is expireValues, and every note, prompt and copy is unchanged", async () => {
    const t = await setup();
    const d = db(t);
    try {
      const { id, sb } = await populate(t);
      refuses(d, `UPDATE stop_verdicts SET note = '' WHERE task_id = ${id}`);
      refuses(d, `UPDATE send_backs SET prompt = '', note = '' WHERE task_id = ${id}`);
      refuses(d, `UPDATE send_back_copies SET text = '' WHERE send_back_id = ${sb}`);
      assert.throws(() => t.ledger.expireValues(id, new Date(Date.now() + 400 * DAY)), /values expire only 30 days after a task closed/);
      assert.equal(t.ledger.stopVerdictsForTask(id)[0]!.note, S.note);
      assert.equal(t.ledger.sendBacksForTask(id)[0]!.prompt, S.prompt);
      assert.equal(t.ledger.sendBacksForTask(id)[0]!.note, S.sbNote);
      assert.equal(t.ledger.sendBackCopies(sb)[0]!.text, S.copy);
    } finally {
      d.close();
      await t.cleanup();
    }
  });

  it("a task closed 20 days ago (not yet five weeks) keeps every note, prompt, copy and its signed version", async () => {
    const t = await setup();
    try {
      const { id, sb } = await populate(t);
      const signed = t.ledger.submissionsForTask(id)[0]!.covered![0]!.sha256;
      t.advance(8 * DAY);
      await t.tasks.sweep();
      t.advance(8 * DAY + 20 * DAY);
      await t.tasks.sweep();
      assert.equal(t.ledger.valuesExpiredAt(id), undefined);
      assert.equal(t.ledger.stopVerdictsForTask(id)[0]!.note, S.note);
      assert.equal(t.ledger.sendBacksForTask(id)[0]!.prompt, S.prompt);
      assert.equal(t.ledger.sendBackCopies(sb)[0]!.text, S.copy);
      assert.equal(t.ledger.submissionsForTask(id)[0]!.covered![0]!.sha256, signed);
    } finally {
      await t.cleanup();
    }
  });
});

describe("the page routes on an expired task", () => {
  const TOKEN = "s".repeat(40);
  it("read routes answer without error on blank notes and prompts, and the write routes refuse with 410", async () => {
    const t = await setup();
    const { server, port } = await startReviewServer(t.ledger, TOKEN, t.home, 0, undefined, { quickLook: false });
    const call = (method: string, p: string, json?: unknown): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, method, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.end(json === undefined ? undefined : JSON.stringify(json));
      });
    try {
      const { id, sb } = await populate(t);
      await expire(t);
      for (const route of ["review/status", "review"]) {
        const r = await call("GET", `/timeline/${id}/${route}`);
        assert.ok(r.status < 500, `${route}: ${r.status} ${r.text.slice(0, 200)}`);
        for (const needle of Object.values(S)) assert.ok(!r.text.includes(needle), `${route} shows ${needle}`);
      }
      const marker = `CoCheck follow-up: task ${id}, send-back ${sb}, ${t.ledger.originById(sb)!.nonce} (you can ignore this line)`;
      assert.equal((await call("POST", `/timeline/${id}/review/sendback`, { note: "new words" })).status, 410);
      assert.equal((await call("POST", `/timeline/${id}/review/sendback-copy`, { id: sb, text: `new words\n\n${marker}` })).status, 410);
      assert.equal((await call("POST", `/timeline/${id}/review/verdict`, { stop: "s1", status: "failed", note: "new words" })).status, 410);
      assert.equal(t.ledger.sendBackCopies(sb).length, 1, "no copy was added");
      assert.deepEqual(sweep(t), []);
    } finally {
      await new Promise<void>((r) => (server as Server).close(() => r()));
      await t.cleanup();
    }
  });
});
