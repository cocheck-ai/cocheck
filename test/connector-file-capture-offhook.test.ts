import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";
import { drawn } from "./helpers/made-page.ts";
import { runCleanups } from "./helpers/cleanups.ts";
import { workbookClaims } from "./helpers/claims.ts";

// File-connector capture moved off the hook onto the review process.
// (a) the hook never runs a file connector: through the real hook entry (handleHook), with a file connector installed that hangs, the PostToolUse that
//     writes one claimed file, or three, returns in under 250 ms; the rows keep the connector's identity, pending.
// (b) review process running at the write: the hook's nudge (POST /connector/file-capture) has it read and freeze the list with no page load; the page then draws it.
// (c) no review process at the write: the first load reads it once, and two concurrent loads start the connector once.
// (d) a hanging or crashing connector leaves its row drawn with a stated reason, never blank, and the other row draws while it hangs.
const ROOT = path.resolve(import.meta.dirname, "..");
const STATES = path.join(ROOT, "public-kit", "toy-product", "states");
const HOOK_LIMIT_MS = 250;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await runCleanups(cleanups); setKeyProvider(null); });

const MANIFEST = { spec: "cocheck.connector/1", id: "toy-hang", version: "0.0.1", entry: "state", matches: { extensions: [".level3.notes.json"] }, run: ["node", "connector.mjs"], credentials: [], platforms: ["darwin", "win32", "linux"] };
export const HELLO_THEN_HANG = `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "hello") process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 3, methods: ["snapshot","diff"] } }) + "\\n"); });
`;
export const NEVER_HELLO = `process.stdin.resume(); setInterval(() => {}, 1000);\n`;

async function hangSession(script: string, files: string[]) {
  setKeyProvider(memoryKeyProvider());
  const r: Rig = await makeRig();
  cleanups.push(() => r.cleanup());
  const dir = path.join(r.home, "connectors", "toy-hang");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify(MANIFEST));
  await writeFile(path.join(dir, "connector.mjs"), script);
  for (const f of files) await writeFile(path.join(r.folder, f), await readFile(path.join(STATES, "create.before.json")));
  let clock = 1_700_000_000_000;
  const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
  const base = { session_id: "session-1", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const call = (event: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "python3 edit.py", description: "edit" }, ...extra });
  const send = (p: Record<string, unknown>) => handleHook(p as unknown as HookPayload, opts);
  await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "edit the notes" });
  await send(call("PreToolUse"));
  for (const f of files) await writeFile(path.join(r.folder, f), await readFile(path.join(STATES, "create.after.json")));
  const t0 = performance.now();
  await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
  return { ms: performance.now() - t0, r };
}

describe("(a) the hook never runs a file connector", () => {
  for (const [name, script] of [["hello then hang", HELLO_THEN_HANG], ["never hello", NEVER_HELLO]] as const) {
    for (const files of [["x.level3.notes.json"], ["a.level3.notes.json", "b.level3.notes.json", "c.level3.notes.json"]]) {
      it(`${name}, ${files.length} claimed file(s): PostToolUse returns in under ${HOOK_LIMIT_MS} ms and the rows keep the connector's identity`, async () => {
        const { ms, r } = await hangSession(script, files);
        console.log(`LATENCY ${name} x${files.length}`, Math.round(ms), "ms");
        assert.ok(ms < HOOK_LIMIT_MS, `hook held ${Math.round(ms)} ms`);
        const ledger = openLedger(r.home);
        const rows = ledger.allTaskIds().flatMap((t) => ledger.fileStatesForTask(t)).filter((f) => f.phase === "Post");
        ledger.close();
        assert.equal(rows.length, files.length);
        assert.ok(rows.every((f) => f.connector === "toy-hang" && f.connectorVersion === "0.0.1" && f.connectorSpec != null && f.changesSha256 === null), JSON.stringify(rows));
      });
    }
  }
});

const TOKEN = "t".repeat(40);
const EXAMPLES = path.join(ROOT, "public-kit", "examples");

/** Copies an example connector into `home`, run through a wrapper that appends one line to `starts.log` beside it each time the connector process starts. */
async function installCounted(home: string, example: string): Promise<string> {
  const dir = path.join(home, "connectors", example);
  await mkdir(path.dirname(dir), { recursive: true });
  await cp(path.join(EXAMPLES, example), dir, { recursive: true });
  await writeFile(path.join(dir, "count.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(new URL("./starts.log", import.meta.url), "start\\n");\nawait import("./connector.mjs");\n`);
  const m = JSON.parse(await readFile(path.join(dir, "cocheck-connector.json"), "utf8"));
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ ...m, run: ["node", "count.mjs"] }));
  return path.join(dir, "starts.log");
}
const startsOf = async (log: string): Promise<number> => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((l) => l === "start").length;

interface Server { get: (p: string) => Promise<{ status: number; body: string }>; close: () => Promise<void>; task: () => number }
async function serve(home: string, connectorTimeoutMs?: number): Promise<Server> {
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false, ...(connectorTimeoutMs === undefined ? {} : { connectorTimeoutMs }) });
  // What the real process records for the hook to find it (review-server.json, review-token).
  await writeFile(path.join(home, "review-server.json"), JSON.stringify({ port, pid: process.pid }));
  await writeFile(path.join(home, "review-token"), TOKEN, { mode: 0o600 });
  let closed = false;
  const close = async (): Promise<void> => { if (closed) return; closed = true; await new Promise<void>((res) => server.close(() => res())); ledger.close(); };
  cleanups.push(close);
  const get = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
  return { get, close, task: () => ledger.allTaskIds()[0]! };
}

/** One hook session that rewrites `files` (name to [before, after] bytes) in one Bash call. Returns the PostToolUse time. */
async function writeSession(r: Rig, files: Record<string, [Buffer, Buffer]>): Promise<number> {
  for (const [f, [before]] of Object.entries(files)) await writeFile(path.join(r.folder, f), before);
  let clock = 1_700_000_000_000;
  const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
  const base = { session_id: "session-1", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const call = (event: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "python3 edit.py", description: "edit" }, ...extra });
  const send = (p: Record<string, unknown>) => handleHook(p as unknown as HookPayload, opts);
  await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "edit the notes" });
  await send(call("PreToolUse"));
  for (const [f, [, after]] of Object.entries(files)) await writeFile(path.join(r.folder, f), after);
  const t0 = performance.now();
  await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
  return performance.now() - t0;
}
const pair = async (name: string): Promise<[Buffer, Buffer]> => [await readFile(path.join(STATES, `${name}.before.json`)), await readFile(path.join(STATES, `${name}.after.json`))];

async function rig(): Promise<Rig> {
  setKeyProvider(memoryKeyProvider());
  const r = await makeRig();
  cleanups.push(() => r.cleanup());
  return r;
}

/** The task's changes by file name, and each one's served /view document. */
async function changes(s: Server): Promise<{ task: number; ids: Map<string, string> }> {
  const task = s.task();
  const timeline = JSON.parse((await s.get(`/timeline/${task}`)).body) as { unplaced: Array<{ id: string; file: string }>; requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; file: string }> }> }> }> };
  const all = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((x) => x.calls.flatMap((c) => c.changes)))];
  return { task, ids: new Map(all.map((c) => [path.basename(c.file), c.id])) };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function view(s: Server, task: number, id: string): Promise<Record<string, any>> {
  const v = await s.get(`/timeline/${task}/view/${encodeURIComponent(id)}`);
  assert.equal(v.status, 200, v.body);
  return JSON.parse(v.body);
}
/** Asks for the view the way the page does (waitForPicture), until it is no longer pending. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function settledView(s: Server, file: string, waitMs = 20_000): Promise<Record<string, any>> {
  const until = Date.now() + waitMs;
  for (;;) {
    const { task, ids } = await changes(s);
    const doc = await view(s, task, ids.get(file)!);
    if (doc.pending !== true) return doc;
    assert.ok(Date.now() < until, `${file} still pending after ${waitMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const pageText = (p: Awaited<ReturnType<typeof drawn>>): string => p.byId("bodyview").textContent + "\n" + p.details();
async function waitFor(what: string, test: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await test())) { assert.ok(Date.now() < until, `timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); }
}
function rowsOf(home: string) {
  const ledger = openLedger(home);
  try { return ledger.allTaskIds().flatMap((t) => ledger.fileStatesForTask(t)).filter((f) => f.phase === "Post" && f.connector != null); } finally { ledger.close(); }
}

describe("(b) review process running at the write: the nudge has it read the list, then the page draws it", () => {
  it("toy-level-3 and toy-export: frozen in the background with no page load, the hook stays fast, and both draw as sent", async () => {
    const r = await rig();
    const l3 = await installCounted(r.home, "toy-level-3");
    const ex = await installCounted(r.home, "toy-export");
    const s = await serve(r.home);
    const ms = await writeSession(r, { "x.level3.notes.json": await pair("create"), "x.export.notes.json": await pair("edit") });
    console.log("LATENCY hook with review process", Math.round(ms), "ms");
    assert.ok(ms < HOOK_LIMIT_MS, `hook held ${Math.round(ms)} ms`);
    // No route of the page has been asked: only the hook's nudge can have started these reads.
    await waitFor("both rows captured by the review process", () => { const rows = rowsOf(r.home); return rows.length === 2 && rows.every((x) => x.capture === "captured" && x.changesSha256 !== null); });
    const rows = rowsOf(r.home);
    assert.deepEqual(rows.map((x) => [path.basename(x.filePath), x.connectorVersion, x.connectorSpec]).sort(), [["x.export.notes.json", "0.0.1", "cocheck.connector/1"], ["x.level3.notes.json", "0.0.1", "cocheck.connector/1"]]);
    const d3 = await settledView(s, "x.level3.notes.json");
    assert.equal(d3.source.level, 3);
    const p3 = await drawn(d3);
    assert.ok(!p3.details().includes("Picture from"), p3.details()); // the toy sends no renderedBy, so no "Drawn by" line and never the id
    assert.equal(p3.byId("stage").hidden, false);
    assert.ok(p3.byId("va").descendants().some((n) => n.className.includes("hit")), "a box lands on its line");
    const de = await settledView(s, "x.export.notes.json");
    assert.deepEqual(de.source, { by: "cocheck", name: "toy-export", level: de.source.level });
    const t = pageText(await drawn(de));
    assert.ok(t.includes("Drawn by CoCheck from the text"), t);
    assert.ok(!/failed|Nothing changed/.test(t), t);
    assert.equal(await startsOf(l3), 1, "toy-level-3 started once");
    assert.equal(await startsOf(ex), 1, "toy-export started once");
  });
});

describe("(c) no review process at the write: the first load reads it, once", () => {
  it("the rows stay pending until the process starts; then two concurrent loads start the connector once and the step draws", async () => {
    const r = await rig();
    const l3 = await installCounted(r.home, "toy-level-3");
    await writeSession(r, { "x.level3.notes.json": await pair("create") });
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual(rowsOf(r.home).map((x) => x.capture), ["pending"], "nothing read the row while no process ran");
    assert.equal(await startsOf(l3), 0, "the hook never started the connector");
    const s = await serve(r.home);
    const [a, b] = await Promise.all([settledView(s, "x.level3.notes.json"), settledView(s, "x.level3.notes.json")]);
    assert.deepEqual(a, b);
    assert.equal(a.source.level, 3);
    const p = await drawn(a);
    assert.ok(!p.details().includes("Picture from"), p.details()); // the toy sends no renderedBy, so no "Drawn by" line and never the id
    assert.equal(await startsOf(l3), 1, "two concurrent loads ran the connector once");
    assert.deepEqual(rowsOf(r.home).map((x) => x.capture), ["captured"]);
    // A restart reads the frozen answer and never asks the connector again.
    await s.close();
    const again = await serve(r.home);
    assert.deepEqual(await settledView(again, "x.level3.notes.json"), a);
    assert.equal(await startsOf(l3), 1);
  });
});

describe("(d) a hanging or crashing connector in the background", () => {
  const CRASH = `process.exit(3);\n`;
  for (const [name, script, reason] of [["hangs after hello", HELLO_THEN_HANG, /timed out/], ["never says hello", NEVER_HELLO, /hello|timed out|start/i], ["crashes at start", CRASH, /exit|start|closed|ended/i]] as const) {
    it(`${name}: its row shows "reading the change list", then a stated reason; the other row draws meanwhile`, async () => {
      const r = await rig();
      const dir = path.join(r.home, "connectors", "toy-hang");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify(MANIFEST));
      await writeFile(path.join(dir, "connector.mjs"), script);
      await installCounted(r.home, "toy-export");
      const s = await serve(r.home, 1500);
      const ms = await writeSession(r, { "x.level3.notes.json": await pair("create"), "x.export.notes.json": await pair("edit") });
      assert.ok(ms < HOOK_LIMIT_MS, `hook held ${Math.round(ms)} ms`);
      // While the bad connector is being waited for, the page says its list is being read (when it is still pending), and the other row draws.
      const { task, ids } = await changes(s);
      const first = await view(s, task, ids.get("x.level3.notes.json")!);
      if (first.pending === true) { const t0 = pageText(await drawn(first, { quietTimers: true })); assert.ok(t0.includes("Reading the change list"), t0); }
      const de = await settledView(s, "x.export.notes.json");
      assert.ok(pageText(await drawn(de)).includes("Drawn by CoCheck from the text"));
      if (name === "hangs after hello") assert.equal(rowsOf(r.home).find((x) => x.filePath.endsWith("x.level3.notes.json"))!.capture, "pending", "the other row did not wait for the hung one");
      const bad = await settledView(s, "x.level3.notes.json");
      const t = pageText(await drawn(bad));
      console.log(`REASON ${name}:`, t);
      assert.ok(t.trim() !== "" && t.includes("toy-hang") && t.includes("could not read the change"), t);
      assert.match(t, reason);
      assert.ok(!t.includes("Reading the change list"), t);
      // The failed card says why in CoCheck's words, never "Nothing changed", and draws no "Change list from" line.
      assert.ok(t.startsWith("No change list: the connector 'toy-hang' could not read the change: it "), t);
      assert.ok(!t.includes("Nothing changed") && !t.includes("Change list from"), t);
      const row = rowsOf(r.home).find((x) => x.filePath.endsWith("x.level3.notes.json"))!;
      assert.equal(row.capture, "failed");
      assert.ok(row.captureReason && row.captureReason.length > 0);
      assert.equal(row.connectorVersion, "0.0.1");
      // Recorded once: a later load does not retry it.
      const again = await settledView(s, "x.level3.notes.json");
      assert.deepEqual(again, bad);
    });
  }
});

describe("file_state_captures", () => {
  it("a row written without a pending capture reads as never captured that way, the table is append-only, one finished answer per row", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { DatabaseSync } = await import("node:sqlite");
    const { SCHEMA_VERSION } = await import("../src/ledger.ts");
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-mig-"));
    const l = openLedger(home);
    const id = l.openTask("c");
    l.recordStep({ taskId: id, client: "c", seq: 1, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: "/work/a.level3.notes.json", sha256: "a".repeat(64), prevSha256: null, size: 1, kept: "whole", note: "", connector: "toy-level-3", connectorVersion: "0.0.1", connectorSpec: "cocheck.connector/1" }] });
    l.close();
    const m = openLedger(home);
    const [old] = m.fileStatesForTask(id);
    assert.deepEqual([old!.capture, old!.connectorVersion, old!.changesSha256], [null, "0.0.1", null]);
    assert.equal(m.pendingCapturesForTask(id).length, 0, "an old row is never read again");
    m.recordStep({ taskId: id, client: "c", seq: 2, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: "/work/a.level3.notes.json", sha256: "b".repeat(64), prevSha256: "a".repeat(64), size: 1, kept: "whole", note: "", connector: "toy-level-3", connectorVersion: "0.0.1", connectorSpec: "cocheck.connector/1", capturePending: true }] });
    const [pending] = m.pendingCapturesForTask(id);
    assert.ok(pending);
    assert.equal(m.recordFileCapture({ fileStateId: pending.id, state: "captured", connectorVersion: "0.0.2", connectorSpec: "cocheck.connector/1", changesSha256: "c".repeat(64) }), true);
    assert.equal(m.recordFileCapture({ fileStateId: pending.id, state: "failed", reason: "late" }), false, "the first finished answer stays");
    const row = m.fileStatesForTask(id).find((r) => r.id === pending.id)!;
    assert.deepEqual([row.capture, row.connectorVersion, row.changesSha256], ["captured", "0.0.2", "c".repeat(64)]);
    m.close();
    const check = new DatabaseSync(path.join(home, "ledger.sqlite"));
    assert.deepEqual((check.prepare("SELECT version FROM schema_version ORDER BY rowid").all() as Array<{ version: number }>).map((r) => r.version), [SCHEMA_VERSION]);
    assert.throws(() => check.exec("DELETE FROM file_state_captures"), /append-only/);
    assert.throws(() => check.exec("UPDATE file_state_captures SET state = 'failed'"), /append-only/);
    check.close();
  });
});

describe("review fixes", () => {
  it("three rows on one export connector and three on one state connector, read at once: every one is captured (no shared process)", async () => {
    const r = await rig();
    await installCounted(r.home, "toy-level-3");
    await installCounted(r.home, "toy-export");
    await serve(r.home);
    const files: Record<string, [Buffer, Buffer]> = {};
    for (const n of ["a", "b", "c"]) { files[`${n}.export.notes.json`] = await pair("edit"); files[`${n}.level3.notes.json`] = await pair("create"); }
    await writeSession(r, files);
    await waitFor("six rows finished", () => { const rows = rowsOf(r.home); return rows.length === 6 && rows.every((x) => x.capture !== "pending"); });
    const got = rowsOf(r.home).map((x) => [path.basename(x.filePath), x.capture, x.captureDetail ?? null]);
    assert.ok(got.every((g) => g[1] === "captured"), JSON.stringify(got));
  });

  it("a connector error quoting the file: the kept reason is CoCheck's category only; what it said is secret-scanned and blanked by the 30-day expiry", async () => {
    const SENTINEL = "ZQFILEVALUE", KEY = "AKIAQ3VZ7KXN2PL4WRT6"; // AWS-shaped (the scanner allowlists AWS's documented ...EXAMPLE key);
    const ECHO = `import readline from "node:readline"; import { readFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "hello") process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["snapshot","diff"] } }) + "\\n");
  else if (m.method === "diff") process.stdout.write(JSON.stringify({ id: m.id, error: { message: "could not parse near: " + readFileSync(m.params.after, "utf8").replace(/\\s+/g, " ").slice(0, 120) + " (aws_access_key_id=${KEY})" } }) + "\\n"); });
`;
    const r = await rig();
    const dir = path.join(r.home, "connectors", "echo");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ ...MANIFEST, id: "echo" }));
    await writeFile(path.join(dir, "connector.mjs"), ECHO);
    const before = await readFile(path.join(STATES, "create.before.json"));
    await writeSession(r, { "x.level3.notes.json": [before, Buffer.from(JSON.stringify({ note: SENTINEL }))] });
    const { settlePendingCaptures } = await import("../src/connector/file-capture.ts");
    const ledger = openLedger(r.home);
    try {
      const task = ledger.allTaskIds().at(-1)!;
      await settlePendingCaptures(ledger, r.home, task, 3000);
      const row = ledger.fileStatesForTask(task).find((x) => x.phase === "Post" && x.connector === "echo")!;
      assert.equal(row.capture, "failed");
      assert.equal(row.captureReason, "the connector 'echo' could not read the change: it answered with an error");
      assert.ok(row.captureDetail?.includes(SENTINEL), "what it said is kept until expiry");
      assert.ok(!row.captureDetail?.includes(KEY), `secret-scanned: ${row.captureDetail}`);
      ledger.recordExpiry(task, new Date(Date.now() - 40 * 86_400_000));
      ledger.expireValues(task, new Date());
      const after = ledger.fileStatesForTask(task).find((x) => x.id === row.id)!;
      assert.equal(after.captureReason, row.captureReason, "the category still shows");
      assert.equal(after.captureDetail, null);
    } finally {
      ledger.close();
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(r.home, "ledger.sqlite"), { readOnly: true });
    const all = JSON.stringify(db.prepare("SELECT * FROM file_state_captures").all());
    db.close();
    assert.ok(!all.includes(SENTINEL) && !all.includes(KEY), all);
  });
});
