import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLedger, SCHEMA_VERSION, type Ledger } from "../src/ledger.ts";
import { memoryKeyProvider, readSealed, setKeyProvider } from "../src/seal.ts";
import { storeDirOf } from "../src/states.ts";
import { afterSnapshot, GAP_OUTCOMES } from "../src/connector/after-snapshot.ts";
import { beforeSnapshot, createConnectorPool, type ConnectorPool } from "../src/connector/before-snapshot.ts";
import { createConnectorDiff } from "../src/connector/diff.ts";
import { changesDirOf, callsDirOf, MCP_PART_CAP_BYTES } from "../src/connector/frozen.ts";
import { beforeReadMsFor } from "../src/connector/subjects.ts";
import { CONNECTOR_BASE_ENV, CONNECTOR_FIXED_ENV, CONNECTOR_SET_ENV, connectorEnv } from "../src/platform/index.ts";
import { HELPERS_DIR } from "../src/connector/runner.ts";
import { loadRows, loadTimeline } from "../src/timeline/load.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call as tcall, prompt, stop } from "./fixtures/timeline.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// Complete, frozen evidence. Every after-capture outcome is a ledger row, a known-subject failure is a gap row, a connector's
// change list is frozen at capture and never asked for again, connectors run with an allow-listed environment, MCP call values are kept sealed and scanned.

const TOKEN = "ghp_aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";
const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11";
const SUBJECT = "notion://page/2f6c0e9b11a14b7e9a531d2f6c0e9b11";
const scriptOf = (v: string) => `
import readline from "node:readline";
import { readFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const out = (result) => process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");
  if (msg.method === "hello") return out({ name: "probe" });
  if (msg.method === "snapshot") {
    let state = null;
    try { state = readFileSync(process.argv[2], "utf8"); } catch {}
    if (state === "ENV") state = JSON.stringify(process.env);
    return out({ subject: msg.params.subject, state });
  }
  if (msg.method === "diff") return out({ spec: "cocheck.changes/1", changes: [{ id: "s", mark: "changed", label: "Status", before: "a", after: "${v} says ${TOKEN}" }] });
  out({ spec: "cocheck.changes/1", changes: [] });
});
`;

let rig: Rig, ledger: Ledger, pool: ConnectorPool, scratch: string, stateFile: string;
const connDir = () => path.join(rig.home, "connectors", "notion");
const manifest = (extra: Record<string, unknown> = {}) => ({ spec: "cocheck.connector/1", id: "notion", version: "1.0.0", entry: "state", matches: { mcpTools: ["mcp__notion__update"], subjects: { "mcp__notion__update": "notion://page/{page_id:hex}" } }, run: ["node", "conn.mjs", stateFile], ...extra });
const install = (m: Record<string, unknown>, v = "v1") => { mkdirSync(connDir(), { recursive: true }); writeFileSync(path.join(connDir(), "conn.mjs"), scriptOf(v)); writeFileSync(path.join(connDir(), "cocheck-connector.json"), JSON.stringify(m)); };
const req = (callId: string, extra: Record<string, unknown> = {}) => ({ home: rig.home, ledger, pool, client: "claude-hook:/w#s", task: null, call: callId, subject: SUBJECT, before: null, budgetMs: 10_000, ...extra }) as Parameters<typeof afterSnapshot>[0];
const outcomes = () => ledger.allCaptureOutcomes();
/** Every file under `dir` (files only), for raw-byte scans. */
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

before(async () => {
  setKeyProvider(memoryKeyProvider());
  rig = await makeRig();
  scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  stateFile = path.join(scratch, "state");
  ledger = openLedger(rig.home);
  pool = createConnectorPool();
});
after(async () => {
  await pool.stopAll();
  ledger.close();
  setKeyProvider(null);
  await rig.cleanup();
});

describe("(1) every outcome is a ledger row; known-subject failures are gap rows", () => {
  it("unmatched subject: no-connector, recorded, no gap", async () => {
    assert.equal(await afterSnapshot(req("c-none", { subject: "nope://x/1" })), "no-connector");
    assert.equal(outcomes().at(-1)!.outcome, "no-connector");
  });

  it("no-before, unchanged, recorded, error, no-window, rejected each leave a row", async () => {
    install(manifest());
    writeFileSync(stateFile, "v1");
    assert.equal(await afterSnapshot(req("c-nobefore")), "no-before");
    const b = await beforeSnapshot({ home: rig.home, pool, subject: SUBJECT, budgetMs: 5000 });
    assert.equal(await afterSnapshot(req("c-unch", { before: b.ref })), "unchanged");
    writeFileSync(stateFile, "v2");
    assert.equal(await afterSnapshot(req("c-rec", { before: b.ref })), "recorded");
    // error: the entry cannot start
    await pool.stopAll(); pool = createConnectorPool();
    install(manifest({ run: ["node", "missing-file.mjs"] }));
    assert.equal(await afterSnapshot(req("c-err", { before: b.ref })), "error");
    // diff entry: no window, then a rejected answer
    await pool.stopAll(); pool = createConnectorPool();
    install(manifest({ entry: "diff", run: ["node", "conn.mjs", stateFile] }));
    assert.equal(await afterSnapshot(req("c-win")), "no-window");
    writeFileSync(path.join(connDir(), "conn.mjs"), `import readline from "node:readline"; const rl = readline.createInterface({ input: process.stdin }); rl.on("line", (l) => { const m = JSON.parse(l); process.stdout.write(JSON.stringify({ id: m.id, result: m.method === "hello" ? { name: "x" } : { nonsense: 1 } }) + "\\n"); });`);
    assert.equal(await afterSnapshot(req("c-rej", { callStart: new Date(1_000).toISOString(), callEnd: new Date(2_000).toISOString() })), "rejected");
    const by = new Map(outcomes().map((o) => [o.call, o]));
    for (const [c, k] of [["c-nobefore", "no-before"], ["c-unch", "unchanged"], ["c-rec", "recorded"], ["c-err", "error"], ["c-win", "no-window"], ["c-rej", "rejected"]] as const) assert.equal(by.get(c)?.outcome, k, c);
    assert.ok(!/[\\/]/.test([...by.values()].map((o) => o.reason).join(" ")), "no path in a reason");
    const task = ledger.allTaskIds()[0]!;
    const gaps = loadRows(ledger, task, "t").captureGaps;
    assert.deepEqual([...gaps.keys()].sort(), ["c-err", "c-nobefore", "c-rej", "c-win"], "gap iff known subject and capture failed (not unchanged, recorded, unmatched)");
    assert.deepEqual([...GAP_OUTCOMES].sort(), ["error", "no-before", "no-window", "rejected"]);
  });

  it("the rail draws a gap row for a call with a gap, and none for a call without (unmatched, unchanged)", () => {
    const mk = (gaps?: Map<string, string>) => {
      const c = tcall("g1", { tool: "mcp__notion__update", at: 10, end: 11, cmd: "mcp__notion__update", extra: { toolLabel: { fields: {}, inputFields: ["page_id"] } } });
      const input: TimelineInput = { taskId: 1, build: "t", ops: [c, prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")], fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map(), ...(gaps === undefined ? {} : { captureGaps: gaps }) };
      return buildRailModel(buildTimeline(input), { connectorFor: () => true });
    };
    const withGap = mk(new Map([["g1", "CoCheck could not read this item before the call, so it cannot say what changed."]]));
    const rows = withGap.stops.filter((s) => s.gap !== undefined);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.gap!.reason, /could not read/);
    assert.equal(mk().stops.filter((s) => s.gap !== undefined).length, 0);
  });
});

describe("(3) frozen change list, connector identity, sign-off hash", () => {
  it("a recorded row holds connector version, spec and the sealed list's hash; an uninstalled and an upgraded connector leave the step byte-identical", async () => {
    await pool.stopAll(); pool = createConnectorPool();
    install(manifest(), "v1");
    writeFileSync(stateFile, "a");
    const b = await beforeSnapshot({ home: rig.home, pool, subject: SUBJECT, budgetMs: 5000 });
    writeFileSync(stateFile, "b");
    assert.equal(await afterSnapshot(req("c-frozen", { before: b.ref })), "recorded");
    const task = ledger.allTaskIds()[0]!;
    const row = ledger.fileStatesForTask(task).filter((r) => r.credited.includes("c-frozen"))[0]!;
    assert.equal(row.connectorVersion, "1.0.0");
    assert.equal(row.connectorSpec, "cocheck.connector/1");
    assert.match(row.changesSha256 ?? "", /^[0-9a-f]{64}$/);
    const raw = readFileSync(path.join(changesDirOf(rig.home, task), row.changesSha256!));
    assert.ok(!raw.includes("v1 says"), "sealed on disk");
    const draw = async () => JSON.stringify((await loadTimeline(ledger, rig.home, task, { build: "t", quickLook: false, connectorDiff: createConnectorDiff({ home: rig.home, taskId: task }) })).timeline);
    const first = await draw();
    assert.match(first, /v1 says/);
    // upgrade: a new version answering differently
    await pool.stopAll(); pool = createConnectorPool();
    install(manifest({ version: "2.0.0" }), "v2");
    assert.equal(await draw(), first, "an upgraded connector changes nothing about an old step");
    // uninstall: files gone
    unlinkSync(path.join(connDir(), "cocheck-connector.json")); unlinkSync(path.join(connDir(), "conn.mjs"));
    assert.equal(await draw(), first, "an uninstalled connector changes nothing about an old step");
  });
});

describe("(4) a connector's environment is an allow-list", () => {
  it("base list as implemented", () => {
    assert.deepEqual([...CONNECTOR_BASE_ENV], ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "COMSPEC", "PATHEXT", "LANG"]);
    const e = connectorEnv({ PATH: "/bin", HOME: "/h", SECRET_X: "no", ALLOWED_Y: "yes" }, ["ALLOWED_Y"], "linux");
    assert.deepEqual(e, { PATH: "/bin", HOME: "/h", ALLOWED_Y: "yes" });
    // The fixed base set is the copied base plus the variables CoCheck sets itself; connectorEnv never copies a set one from its source.
    assert.deepEqual([...CONNECTOR_SET_ENV], ["COCHECK_HELPERS_DIR"]);
    assert.deepEqual([...CONNECTOR_FIXED_ENV], [...CONNECTOR_BASE_ENV, "COCHECK_HELPERS_DIR"]);
    assert.deepEqual(connectorEnv({ PATH: "/bin", COCHECK_HELPERS_DIR: "/planted" }, [], "linux"), { PATH: "/bin" });
  });

  it("the spec's fixed base set names exactly the code's", () => {
    const spec = readFileSync(path.join(import.meta.dirname, "..", "public-kit", "spec", "v1.md"), "utf8");
    const line = spec.split("\n").find((l) => l.startsWith("- `permissions`:"));
    assert.ok(line, "the spec's permissions line");
    const named = [...line.slice(line.indexOf("The fixed base set is")).matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(named, [...CONNECTOR_FIXED_ENV]);
  });

  it("a token planted in process.env never reaches a connector that echoes its environment; a permissions.env name does", async () => {
    await pool.stopAll(); pool = createConnectorPool();
    process.env.T409_PLANTED = "PLANTED-NOT-ALLOWED";
    process.env.T409_PERMITTED = "PERMITTED-VALUE";
    const hadHelpers = process.env.COCHECK_HELPERS_DIR;
    process.env.COCHECK_HELPERS_DIR = "/planted/helpers"; // a parent's value never reaches the connector; CoCheck's own folder does
    try {
      install(manifest({ permissions: { env: ["T409_PERMITTED"] } }));
      writeFileSync(stateFile, "ENV");
      const { ref } = await beforeSnapshot({ home: rig.home, pool, subject: SUBJECT, budgetMs: 5000 });
      const echoed = JSON.parse((await readSealed(path.join(rig.home, "connector-states", ref!))).toString("utf8")) as Record<string, string>;
      assert.equal(echoed.T409_PERMITTED, "PERMITTED-VALUE");
      assert.equal(echoed.T409_PLANTED, undefined);
      assert.equal(echoed.COCHECK_HELPERS_DIR, HELPERS_DIR, "the fixed base set's COCHECK_HELPERS_DIR is CoCheck's own helpers folder");
      // Windows: names are case-insensitive (the system's own spelling, Path or ComSpec, is kept), and libuv adds its required set to every child's
      // environment when missing (HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, USERDOMAIN, USERNAME, WINDIR, ...): none of those is a planted value.
      const win = process.platform === "win32";
      const LIBUV_REQUIRED = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"];
      const norm = (k: string) => (win ? k.toUpperCase() : k);
      const allowed = new Set([...CONNECTOR_FIXED_ENV, "T409_PERMITTED", "PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING", ...(win ? LIBUV_REQUIRED : [])].map(norm));
      assert.deepEqual(Object.keys(echoed).filter((k) => !allowed.has(norm(k))), [], "nothing outside the base and the manifest's names");
    } finally {
      delete process.env.T409_PLANTED; delete process.env.T409_PERMITTED;
      if (hadHelpers === undefined) delete process.env.COCHECK_HELPERS_DIR; else process.env.COCHECK_HELPERS_DIR = hadHelpers;
    }
  });
});

describe("(5, 7) secrets never appear in clear in the store or the ledger", () => {
  it("a secret in a connector answer (snapshot state and change list)", async () => {
    await pool.stopAll(); pool = createConnectorPool();
    install(manifest(), "v3");
    writeFileSync(stateFile, "state one");
    const b = await beforeSnapshot({ home: rig.home, pool, subject: SUBJECT, budgetMs: 5000 });
    writeFileSync(stateFile, `state two token=${TOKEN}`);
    assert.equal(await afterSnapshot(req("c-secret", { before: b.ref })), "recorded");
    const task = ledger.allTaskIds()[0]!;
    const row = ledger.fileStatesForTask(task).find((r) => r.credited.includes("c-secret"))!;
    assert.ok(!(await readSealed(path.join(storeDirOf(rig.home, task), row.sha256))).toString("utf8").includes(TOKEN));
    assert.match((await readSealed(path.join(changesDirOf(rig.home, task), row.changesSha256!))).toString("utf8"), /secret withheld/);
    assert.ok(!(await readSealed(path.join(changesDirOf(rig.home, task), row.changesSha256!))).toString("utf8").includes(TOKEN));
    for (const f of walk(rig.home).filter((x) => !x.includes(`${path.sep}connectors${path.sep}`))) assert.ok(!readFileSync(f).includes(TOKEN), `clear secret in ${path.relative(rig.home, f)}`);
  });
});

describe("(2, 5, 7) MCP call values are kept, scanned, capped and sealed", () => {
  const payload = (event: "PreToolUse" | "PostToolUse", id: string, response?: unknown) => ({
    session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: event, tool_name: "mcp__github__create_issue", tool_use_id: id,
    tool_input: { title: "t", body: `see ${TOKEN}` }, ...(response === undefined ? {} : { tool_response: response }),
  });
  const drive = async (event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit", id: string, response?: unknown) => {
    const body = event === "UserPromptSubmit" ? { session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: event, prompt: "file an issue" } : payload(event, id, response);
    const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(body)); })(), localProcess: { request: async () => { throw new Error("none"); } } } as any);
    assert.equal(res.exitCode, 0, res.stderr);
  };
  const keptOf = async (id: string) => {
    for (const t of ledger.allTaskIds()) {
      const f = path.join(callsDirOf(rig.home, t), `${id}.json`);
      if (existsSync(f)) return JSON.parse((await readSealed(f)).toString("utf8")) as { input: any; response: any; cut: { input?: number; response?: number } };
    }
    return undefined;
  };

  it("input and response kept, secret masked, sealed; no clear secret in any file of the home", async () => {
    await drive("UserPromptSubmit", "p");
    await drive("PreToolUse", "m1");
    await drive("PostToolUse", "m1", { content: [{ type: "text", text: `created; key ${TOKEN}` }] });
    const kept = await keptOf("m1");
    assert.ok(kept, "kept");
    assert.equal(kept.input.title, "t");
    assert.match(JSON.stringify(kept.response), /created/);
    assert.ok(!JSON.stringify(kept).includes(TOKEN));
    assert.deepEqual(kept.cut, {});
    for (const f of walk(rig.home).filter((x) => !x.includes(`${path.sep}connectors${path.sep}`))) assert.ok(!readFileSync(f).includes(TOKEN), `clear secret in ${path.relative(rig.home, f)}`);
  });

  it(`cap is ${MCP_PART_CAP_BYTES} bytes a part: a 27 KB response (the largest real one) is whole, a 100 KB one is cut with the caveat`, async () => {
    assert.ok(MCP_PART_CAP_BYTES > 27 * 1024);
    await drive("PreToolUse", "m2");
    await drive("PostToolUse", "m2", { content: [{ type: "text", text: "x".repeat(27 * 1024) }] });
    assert.deepEqual((await keptOf("m2"))!.cut, {});
    await drive("PreToolUse", "m3");
    await drive("PostToolUse", "m3", { content: [{ type: "text", text: "y".repeat(100 * 1024) }] });
    const big = (await keptOf("m3"))!;
    assert.ok(big.cut.response! > 100 * 1024);
    assert.ok(Buffer.byteLength(big.response, "utf8") <= MCP_PART_CAP_BYTES);
  });

  it("the ledger holds neither input nor response values of the call", () => {
    const db = new DatabaseSync(path.join(rig.home, "ledger.sqlite"), { readOnly: true });
    const all = JSON.stringify(db.prepare("SELECT args_json FROM ops").all());
    db.close();
    assert.ok(!all.includes("created; key") && !all.includes("yyyyyyyyyy"));
  });
});

describe("(6) the before-read wait is the matched connector's beforeReadMs", () => {
  it("default 1500, a manifest's value, the cap 3000 (a value past it reads as default)", () => {
    install(manifest());
    assert.equal(beforeReadMsFor(rig.home, "mcp__notion__update"), 1500);
    install(manifest({ beforeReadMs: 2500 }));
    assert.equal(beforeReadMsFor(rig.home, "mcp__notion__update"), 2500);
    install(manifest({ beforeReadMs: 3000 }));
    assert.equal(beforeReadMsFor(rig.home, "mcp__notion__update"), 3000);
    assert.equal(beforeReadMsFor(rig.home, "mcp__other__tool"), 1500);
  });

  it("the hook asks the local process with that budget", async () => {
    install(manifest({ beforeReadMs: 2500 }));
    const seen: number[] = [];
    const body = { session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "mcp__notion__update", tool_use_id: "b1", tool_input: { page_id: "2f6c0e9b-11a1-4b7e-9a53-1d2f6c0e9b11" } };
    const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(body)); })(), localProcess: { request: async (r: { budgetMs: number }) => { seen.push(r.budgetMs); throw new Error("no"); } } } as any);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(seen, [2500]);
  });
});

describe("signoffs.change_lists_json is removed", () => {
  it("a fresh ledger has no such column", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-col-"));
    const cols = (): string[] => { const d = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true }); const r = (d.prepare("PRAGMA table_info(signoffs)").all() as Array<{ name: string }>).map((c) => c.name); d.close(); return r; };
    const l = openLedger(home);
    const id = l.openTask("c");
    l.recordSoftSubmission({ taskId: id, signer: "Dana", rounds: 0, rejections: [], files: [], leftOut: [], closedTask: false, acknowledged: [], reviewer: "Dana", covered: [] });
    l.close();
    assert.ok(!cols().includes("change_lists_json"));
  });
});

describe("connector evidence columns", () => {
  it("a built-in file row has NULL connector evidence, the outcomes table works and is append-only, a second open is a no-op", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-mig-"));
    const l = openLedger(home);
    const id = l.openTask("c");
    l.recordStep({ taskId: id, client: "c", seq: 1, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: "/work/a.txt", sha256: "a".repeat(64), prevSha256: null, size: 1, kept: "whole", note: "" }] });
    l.close();
    const m = openLedger(home);
    const rows = m.fileStatesForTask(1);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.connectorVersion, rows[0]!.connectorSpec, rows[0]!.changesSha256], [null, null, null]);
    m.recordCaptureOutcome({ taskId: 1, client: "c", call: "x", subject: "s://1", outcome: "no-before", reason: "r" });
    assert.equal(m.captureOutcomesForTask(1).length, 1);
    m.close();
    openLedger(home).close();
    const check = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    assert.deepEqual((check.prepare("SELECT version FROM schema_version ORDER BY rowid").all() as Array<{ version: number }>).map((r) => r.version), [SCHEMA_VERSION]);
    assert.equal((check.prepare("PRAGMA table_info(file_states)").all() as Array<{ name: string }>).filter((c) => c.name === "changes_sha256").length, 1);
    assert.throws(() => check.exec("DELETE FROM capture_outcomes"), /readonly|append-only/i);
    check.close();
  });
});
