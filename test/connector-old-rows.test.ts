// A file row the hook recorded with `connector = null` (rows from before connectors, every Windows/Linux Office row, Mac
// .xlsm/.pptm/.ppsx rows) whose file a built-in claims today gets a change list at load, through settleFileCapture, with today's built-in claimant.
// Only the capture tables are written: the file_states row the hook wrote is byte-identical before and after. The re-ask runs only under the task lock
// (a holder of the lock makes it wait), a live hook write on the same task during the re-ask lands beside it, a row whose stored sides are gone says
// "no change list was kept", a row with a connector already set is untouched, and the page says the list was read later than the step.
// The planted rows are real hook rows: the real hook records a .csv change while no built-in claims .csv (so connector is NULL, as on an Office row
// recorded where no built-in claimed its type), then a toy built-in claiming .csv is registered (setBuiltinConnectorsForTest; Office is never run).
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { settlePendingCaptures } from "../src/connector/file-capture.ts";
import { NO_LIST_KEPT, queueOldRows } from "../src/connector/old-rows.ts";
import { withTaskLocks } from "../src/copies.ts";
import { workbookClaims } from "./helpers/claims.ts";
import { runCleanups } from "./helpers/cleanups.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger, type FileStateRow } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { storeDirOf } from "../src/states.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VT = (globalThis as any).CoCheckViewTable;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await runCleanups(cleanups); setKeyProvider(null); setBuiltinConnectorsForTest(undefined); });

const DOC = { spec: "cocheck.changes/1", changes: [{ id: "c1", mark: "changed", label: "row 1", before: "a", after: "b" }] };

/** A toy connector: hello at level 1; each diff appends a line to calls.log and answers DOC after plan.sleepMs. */
const TOY = `import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const here = (f) => new URL("./" + f, import.meta.url);
const plan = JSON.parse(readFileSync(here("plan.json"), "utf8"));
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "hello") return process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"] } }) + "\\n");
  if (m.method === "diff") { appendFileSync(here("calls.log"), "diff\\n"); setTimeout(() => process.stdout.write(JSON.stringify({ id: m.id, result: plan.answer }) + "\\n"), plan.sleepMs ?? 0); }
});
`;

async function toyBuiltin(id: string, sleepMs = 0): Promise<string> {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "builtin-")), id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, version: "2.0.0", entry: "state", matches: { extensions: [".csv"] }, run: ["node", "connector.mjs"] }));
  await writeFile(path.join(dir, "connector.mjs"), TOY);
  await writeFile(path.join(dir, "plan.json"), JSON.stringify({ answer: DOC, sleepMs }));
  return dir;
}
const callsOf = async (dir: string): Promise<number> => (await readFile(path.join(dir, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

async function rig(): Promise<Rig> {
  setKeyProvider(memoryKeyProvider());
  const r = await makeRig();
  cleanups.push(() => r.cleanup());
  return r;
}

let clock = 1_700_000_000_000;
/** One request in which one Bash call rewrites `file` from `before` to `after`, through the real hook entry (same session: same task). */
async function writeSession(r: Rig, file: string, before: string | null, after: string, callId = "call_1"): Promise<void> {
  if (before !== null) await writeFile(path.join(r.folder, file), before);
  const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
  const base = { session_id: "session-1", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const call = (event: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: callId, tool_input: { command: "python3 edit.py", description: "edit" }, ...extra });
  const send = (p: Record<string, unknown>) => handleHook(p as unknown as HookPayload, opts);
  await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "edit the table" });
  await send(call("PreToolUse"));
  await writeFile(path.join(r.folder, file), after);
  await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
}

/** The planted row: the hook records t.csv while no built-in claims .csv, so its connector is NULL. Returns the Post row. */
async function plantNullConnectorRow(r: Rig): Promise<FileStateRow> {
  setBuiltinConnectorsForTest([]);
  await writeSession(r, "t.csv", "a,b\n1,2\n", "a,b\n1,3\n");
  const rows = postRows(r.home).filter((f) => path.basename(f.filePath) === "t.csv");
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0]!.connector, null);
  assert.equal(rows[0]!.capture, null);
  assert.notEqual(rows[0]!.prevSha256, null);
  return rows[0]!;
}

const withLedger = <T>(home: string, f: (l: ReturnType<typeof openLedger>) => T): T => { const l = openLedger(home); try { return f(l); } finally { l.close(); } };
const postRows = (home: string): FileStateRow[] => withLedger(home, (l) => l.allTaskIds().flatMap((t) => l.fileStatesForTask(t)).filter((f) => f.phase === "Post"));
const rowById = (home: string, id: number): FileStateRow => postRows(home).find((f) => f.id === id)!;
/** Every file_states row exactly as stored (all columns), and every capture-table row. */
function dump(home: string): { fileStates: string; captures: number } {
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
  try {
    return { fileStates: JSON.stringify(db.prepare("SELECT * FROM file_states ORDER BY id").all()), captures: Number((db.prepare("SELECT COUNT(*) AS n FROM file_state_captures").get() as { n: number }).n) };
  } finally {
    db.close();
  }
}
/** What the review process does at load: queue the old rows, then read every pending row one at a time. */
const loadAndSettle = async (home: string, taskId: number): Promise<void> => {
  const ledger = openLedger(home);
  try {
    queueOldRows(ledger, home, taskId);
    await settlePendingCaptures(ledger, home, taskId, 5000);
  } finally {
    ledger.close();
  }
};

describe("old rows get a change list from today's built-in, at load", () => {
  it("a planted null-connector row is captured once, into the capture tables only: its file_states row is byte-identical before and after", async () => {
    const r = await rig();
    const row = await plantNullConnectorRow(r);
    const dir = await toyBuiltin("toy-today");
    setBuiltinConnectorsForTest([{ id: "toy-today", dir }]);
    const before = dump(r.home);
    await loadAndSettle(r.home, row.taskId);
    const got = rowById(r.home, row.id);
    assert.equal(got.capture, "captured", JSON.stringify(got));
    assert.equal(got.connectorVersion, "2.0.0");
    assert.notEqual(got.changesSha256, null);
    assert.equal(got.connector, null, "the hook's connector column stays NULL");
    assert.equal(await callsOf(dir), 1, "one ask: the task's starting copy of t.csv (no before, nobody credited) is not a change and is not asked");
    // a second load asks nothing again and writes nothing more
    const mid = dump(r.home);
    await loadAndSettle(r.home, row.taskId);
    assert.equal(await callsOf(dir), 1, "captured once");
    const after = dump(r.home);
    assert.equal(after.fileStates, before.fileStates, "file_states is byte-identical");
    assert.equal(after.captures, mid.captures);
    assert.equal(mid.captures - before.captures, 2, "one pending row, one captured row");
  });

  it("the page draws the old row from the capture and says the list was read later than the step (view-table READ_LATER, generic wording)", async () => {
    const r = await rig();
    const row = await plantNullConnectorRow(r);
    const dir = await toyBuiltin("toy-today");
    setBuiltinConnectorsForTest([{ id: "toy-today", dir }]);
    assert.doesNotMatch(VT.READ_LATER, /Excel|Word|PowerPoint|workbook|worksheet|slide|Office/);
    const TOKEN = "t".repeat(40);
    const ledger = openLedger(r.home);
    const { server, port } = await startReviewServer(ledger, TOKEN, r.home, 0, undefined, { previewRenderer: async () => null, quickLook: false, connectorTimeoutMs: 5000 });
    cleanups.push(async () => { await new Promise<void>((res) => server.close(() => res())); ledger.close(); });
    const get = (p: string): Promise<string> => new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }).on("error", reject);
    });
    const task = row.taskId;
    type T = { unplaced: Array<{ id: string; file: string }>; requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; file: string }> }> }> }> };
    const idOf = (t: T): string => [...t.unplaced, ...t.requests.flatMap((q) => q.runs.flatMap((x) => x.calls.flatMap((c) => c.changes)))].find((c) => path.basename(c.file) === "t.csv")!.id;
    // the first load queues the row and reads it in the background; the page polls until it is no longer pending
    let doc: { pending?: boolean; readLater?: boolean; changes: Array<{ label: string }>; caveats: string[]; source?: { name: string } } = { changes: [], caveats: [] };
    for (let i = 0; i < 60; i++) {
      const id = idOf(JSON.parse(await get(`/timeline/${task}`)) as T);
      doc = JSON.parse(await get(`/timeline/${task}/view/${encodeURIComponent(id)}`));
      if (doc.pending !== true && doc.readLater === true) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(doc.readLater, true, JSON.stringify(doc));
    assert.deepEqual(doc.changes.map((c) => c.label), ["row 1"]);
    assert.equal(doc.source?.name, "toy-today");
    assert.equal(VT.sceneOf(doc).caveats[0], VT.READ_LATER);
    assert.equal(await callsOf(dir), 1);
  });

  it("the re-ask runs only under the task lock: a holder makes it wait, a live hook write on the same task during the re-ask lands beside it, and the SQLite write lock the hook waits on is never held long enough to expire a 50 ms busy_timeout", async () => {
    const r = await rig();
    const row = await plantNullConnectorRow(r);
    const dir = await toyBuiltin("toy-today", 600);
    setBuiltinConnectorsForTest([{ id: "toy-today", dir }]);
    const fileStatesBefore = dump(r.home).fileStates;
    // another holder of the task lock (a round cut, a sweep, a sign-off prune) holds it: the re-ask does not run
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let holding!: () => void;
    const isHeld = new Promise<void>((res) => { holding = res; });
    const holder = withTaskLocks(r.home, [row.taskId], async () => { holding(); await held; });
    await isHeld;
    const settling = loadAndSettle(r.home, row.taskId);
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(await callsOf(dir), 0, "the connector is not asked while another process holds the task lock");
    assert.equal(rowById(r.home, row.id).capture, "pending");
    release();
    await holder;
    // now the re-ask holds the lock and the toy sleeps 600 ms: the real hook writes another change on the same task meanwhile
    for (let i = 0; i < 50 && (await callsOf(dir)) === 0; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(await callsOf(dir), 1, "the re-ask is running");
    // The hook serializes on SQLite's write lock (busy_timeout 2 s), not the task lock. The re-ask never holds that write lock across the connector call:
    // it writes only through recordFileCapture's one short IMMEDIATE transaction. A probe writer with a 50 ms busy_timeout (40x shorter than the hook's)
    // takes the write lock every 10 ms for the whole re-ask, its final write included, and never times out.
    let done = false, probes = 0;
    const busy: string[] = [];
    const probing = (async () => {
      while (!done) {
        const db = new DatabaseSync(path.join(r.home, "ledger.sqlite"));
        try {
          db.exec("PRAGMA busy_timeout = 50");
          db.exec("BEGIN IMMEDIATE");
          db.exec("ROLLBACK");
          probes++;
        } catch (e) {
          busy.push((e as Error).message);
        } finally {
          db.close();
        }
        await new Promise((res) => setTimeout(res, 10));
      }
    })();
    await writeSession(r, "u.txt", "x\n", "y\n", "call_2");
    await settling;
    done = true;
    await probing;
    assert.deepEqual(busy, [], "a 50 ms busy_timeout never expired during the re-ask");
    assert.ok(probes >= 10, `the probe ran through the re-ask (${probes} probes)`);
    const rows = postRows(r.home);
    const u = rows.find((f) => path.basename(f.filePath) === "u.txt");
    assert.ok(u !== undefined, "the hook's write landed");
    assert.equal(u.taskId, row.taskId, "on the same task");
    assert.equal(rowById(r.home, row.id).capture, "captured", "the re-ask landed");
    // the old rows are untouched: every file_states row that existed before is the same, byte for byte
    const db = new DatabaseSync(path.join(r.home, "ledger.sqlite"), { readOnly: true });
    try {
      const old = JSON.parse(fileStatesBefore) as Array<{ id: number }>;
      const now = db.prepare(`SELECT * FROM file_states WHERE id <= ? ORDER BY id`).all(Math.max(...old.map((o) => o.id)));
      assert.equal(JSON.stringify(now), fileStatesBefore);
    } finally {
      db.close();
    }
  });

  it("a row whose stored sides are gone shows \"no change list was kept\" and the connector is never asked", async () => {
    const r = await rig();
    const row = await plantNullConnectorRow(r);
    const dir = await toyBuiltin("toy-today");
    setBuiltinConnectorsForTest([{ id: "toy-today", dir }]);
    // the before copy leaves the store (moved aside: the way a prune leaves the row with no stored side)
    const store = storeDirOf(r.home, row.taskId);
    await rename(path.join(store, row.prevSha256!), path.join(store, `${row.prevSha256!}.moved-aside`));
    await loadAndSettle(r.home, row.taskId);
    const got = rowById(r.home, row.id);
    assert.equal(got.capture, "failed");
    assert.equal(got.captureReason, NO_LIST_KEPT);
    assert.match(got.captureReason ?? "", /^no change list was kept/);
    assert.equal(await callsOf(dir), 0);
  });

  it("a row with a connector already set is untouched", async () => {
    const r = await rig();
    const dir = await toyBuiltin("toy-today");
    setBuiltinConnectorsForTest([{ id: "toy-today", dir }]);
    await writeSession(r, "t.csv", "a,b\n1,2\n", "a,b\n1,3\n");
    const row = postRows(r.home).find((f) => path.basename(f.filePath) === "t.csv")!;
    assert.equal(row.connector, "toy-today");
    assert.equal(row.capture, "pending");
    const l0 = openLedger(r.home);
    try { await settlePendingCaptures(l0, r.home, row.taskId, 5000); } finally { l0.close(); }
    assert.equal(rowById(r.home, row.id).capture, "captured");
    const before = dump(r.home);
    const calls = await callsOf(dir);
    const queued = withLedger(r.home, (l) => queueOldRows(l, r.home, row.taskId));
    await loadAndSettle(r.home, row.taskId);
    assert.equal(queued, 0);
    assert.deepEqual(dump(r.home), before, "no capture row and no file_states change");
    assert.equal(await callsOf(dir), calls);
  });
});
