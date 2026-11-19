// General to every connector.
// (1) a built-in connector registered by CoCheck's code (a toy, non-Office one, through the test seam) is found by every lookup: the hook's claims on a
//     type CoCheck draws itself, the row identity, the capture and the diff; `node` runs on CoCheck's own runtime. An installed connector on a type CoCheck draws itself is not enabled for it by default.
// (2) the manifest's `diffMs` bounds the diff call (capture and `cocheck connector test`); above 60000 it is refused.
// (3) an answer with `pendingRetry` is not frozen: the next load asks again, up to 5 asks, after which the last answer is frozen with a caveat. Meanwhile the
//     page gets the pending answer's change list, marked pending, with a waiting line.
import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { builtinClaims, connectorArgv, connectorById, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { createConnectorDiff } from "../src/connector/diff.ts";
import { ASKS_RAN_OUT, CAPTURE_ASK_GAPS_MS, captureFileRow, MAX_CAPTURE_ASKS, settleFileCapture, type CaptureSpacing } from "../src/connector/file-capture.ts";
import { readFrozen } from "../src/connector/frozen.ts";
import { connectorClaimsFor, fileConnectorIdentity } from "../src/connector/installed-match.ts";
import { checkManifest } from "../src/connector/schema.ts";
import { runConnectorTest } from "../src/connector-test-cli.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger, type FileStateRow } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";
import { workbookClaims } from "./helpers/claims.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const cleanups: Array<() => Promise<void>> = [];
// Last in, first out: a server and its ledger close before the home they use is removed (Windows cannot remove an open ledger file).
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); setKeyProvider(null); setBuiltinConnectorsForTest(undefined); });

const DOC = (extra: Record<string, unknown> = {}) => ({ spec: "cocheck.changes/1", changes: [{ id: "c1", mark: "changed", label: "row 1", before: "a", after: "b" }], ...extra });
const PENDING = DOC({ pendingRetry: 2, status: { kind: "unavailable", evidence: "the product is busy" } });

/** A toy connector: answers hello at level 1, and each diff with plan[n] (the last one repeats), after `sleepMs`. Appends one line per diff to calls.log. */
const TOY = `import readline from "node:readline";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const here = (f) => new URL("./" + f, import.meta.url);
const plan = JSON.parse(readFileSync(here("plan.json"), "utf8"));
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "hello") return process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"] } }) + "\\n");
  if (m.method === "diff") {
    const n = existsSync(here("calls.log")) ? readFileSync(here("calls.log"), "utf8").split("\\n").filter(Boolean).length : 0;
    appendFileSync(here("calls.log"), "diff\\n");
    const answer = plan.answers[Math.min(n, plan.answers.length - 1)];
    setTimeout(() => process.stdout.write(JSON.stringify({ id: m.id, result: answer }) + "\\n"), plan.sleepMs ?? 0);
  }
});
`;

async function toyFolder(id: string, opts: { extensions: string[]; answers: unknown[]; sleepMs?: number; diffMs?: number; parent?: string }): Promise<string> {
  const dir = path.join(opts.parent ?? (await mkdtemp(path.join(tmpdir(), "builtin-"))), id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, version: "1.2.3", entry: "state", matches: { extensions: opts.extensions }, run: ["node", "connector.mjs"], ...(opts.diffMs === undefined ? {} : { diffMs: opts.diffMs }) }));
  await writeFile(path.join(dir, "connector.mjs"), TOY);
  await writeFile(path.join(dir, "plan.json"), JSON.stringify({ answers: opts.answers, sleepMs: opts.sleepMs ?? 0 }));
  return dir;
}
const callsOf = async (dir: string): Promise<number> => (await readFile(path.join(dir, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

async function rig(): Promise<Rig> {
  setKeyProvider(memoryKeyProvider());
  const r = await makeRig();
  cleanups.push(() => r.cleanup());
  return r;
}

/** One hook session that rewrites `file` from `before` to `after` in one Bash call, through the real hook entry. */
async function writeSession(r: Rig, file: string, before: string, after: string): Promise<void> {
  await writeFile(path.join(r.folder, file), before);
  let clock = 1_700_000_000_000;
  const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
  const base = { session_id: "session-1", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const call = (event: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "python3 edit.py", description: "edit" }, ...extra });
  const send = (p: Record<string, unknown>) => handleHook(p as unknown as HookPayload, opts);
  await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "edit the table" });
  await send(call("PreToolUse"));
  await writeFile(path.join(r.folder, file), after);
  await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
}

const postRows = (home: string): FileStateRow[] => {
  const ledger = openLedger(home);
  try {
    return ledger.allTaskIds().flatMap((t) => ledger.fileStatesForTask(t)).filter((f) => f.phase === "Post");
  } finally {
    ledger.close();
  }
};

describe("(1) built-in connectors are real", () => {
  it("a toy built-in on a type CoCheck draws itself (.csv) is found by the hook's claims, the row identity, the capture and the diff", async () => {
    const r = await rig();
    const dir = await toyFolder("toy-builtin", { extensions: [".csv"], answers: [DOC()] });
    setBuiltinConnectorsForTest([{ id: "toy-builtin", dir }]);
    assert.equal(connectorClaimsFor(r.home, builtinClaims())(path.join(r.folder, "t.csv")), "toy-builtin");
    assert.deepEqual(fileConnectorIdentity(r.home, "toy-builtin"), { connectorVersion: "1.2.3", connectorSpec: "cocheck.connector/1" });
    // the real hook records the row with the built-in's identity, pending
    await writeSession(r, "t.csv", "a,b\n1,2\n", "a,b\n1,3\n");
    const rows = postRows(r.home);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]!.connector, "toy-builtin");
    assert.equal(rows[0]!.connectorVersion, "1.2.3");
    assert.equal(rows[0]!.capture, "pending");
    // the capture and the diff run it
    const row = rows[0]!;
    const got = await captureFileRow({ home: r.home, taskId: row.taskId, subject: row.filePath, connector: "toy-builtin", before: row.prevSha256, after: row.sha256 });
    assert.ok(got?.changesSha256 !== undefined, JSON.stringify(got));
    const d = await createConnectorDiff({ home: r.home, taskId: row.taskId })({ subject: row.filePath, connector: "toy-builtin", before: { ref: row.prevSha256 }, after: { ref: row.sha256 } });
    assert.equal(d.changes.length, 1);
  });

  it("a bare `node` is CoCheck's own runtime for a built-in and an installed connector alike", async () => {
    const dir = await toyFolder("toy-builtin", { extensions: [".csv"], answers: [DOC()] });
    setBuiltinConnectorsForTest([{ id: "toy-builtin", dir }]);
    assert.deepEqual(connectorArgv(connectorById(undefined, "toy-builtin")!), [process.execPath, "connector.mjs"]);
    const home = await mkdtemp(path.join(tmpdir(), "home-"));
    await toyFolder("toy-installed", { extensions: [".toy.json"], answers: [DOC()], parent: path.join(home, "connectors") });
    assert.deepEqual(connectorArgv(connectorById(home, "toy-installed")!), [process.execPath, "connector.mjs"]);
  });

  it("an installed connector claiming a type CoCheck draws itself is not enabled for it by default, also beside a built-in, and an installed folder reusing a built-in's id is never that built-in", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "home-"));
    await toyFolder("toy-installed", { extensions: [".csv", ".toy.json"], answers: [DOC()], parent: path.join(home, "connectors") });
    await toyFolder("toy-builtin", { extensions: [".pptm"], answers: [DOC()], parent: path.join(home, "connectors") });
    const dir = await toyFolder("toy-builtin", { extensions: [".docx"], answers: [DOC()] });
    setBuiltinConnectorsForTest([{ id: "toy-builtin", dir }]);
    const of = connectorClaimsFor(home, builtinClaims());
    assert.equal(of("x.csv"), undefined);
    assert.equal(of("x.toy.json"), "toy-installed");
    assert.equal(of("x.docx"), "toy-builtin");
    assert.equal(of("x.pptm"), undefined, "the installed copy's claim under the built-in's id is dropped");
    assert.equal(connectorById(home, "toy-builtin")!.file, path.join(dir, "cocheck-connector.json"));
  });

  it("a built-in for another OS, or with no folder, is not registered and nothing throws", async () => {
    const dir = await toyFolder("toy-builtin", { extensions: [".csv"], answers: [DOC()] });
    setBuiltinConnectorsForTest([{ id: "toy-builtin", dir, platforms: ["no-such-os"] }, { id: "toy-missing", dir: path.join(dir, "..", "nowhere") }]);
    assert.deepEqual(builtinClaims(), []);
    assert.equal(connectorById(undefined, "toy-missing"), undefined);
    assert.equal(fileConnectorIdentity("/nonexistent-home", "toy-builtin"), undefined);
  });
});

describe("(2) diffMs", () => {
  const manifest = (diffMs: unknown) => ({ spec: "cocheck.connector/1", id: "a", version: "1", entry: "state", matches: { extensions: [".a.json"] }, run: ["node", "c.mjs"], diffMs });
  it("is a whole number from 1 to 60000", () => {
    assert.deepEqual(checkManifest(manifest(60000)), []);
    assert.deepEqual(checkManifest(manifest(1)), []);
    for (const bad of [60001, 0, 1.5, "100"]) assert.deepEqual(checkManifest(manifest(bad)).map((p) => p.field), ["diffMs"], String(bad));
  });

  it("bounds the capture's diff call: a 600 ms connector times out under a 300 ms default and passes with diffMs 1500", async () => {
    const r = await rig();
    const slow = await toyFolder("toy-slow", { extensions: [".csv"], answers: [DOC()], sleepMs: 600 });
    const patient = await toyFolder("toy-patient", { extensions: [".csv"], answers: [DOC()], sleepMs: 600, diffMs: 1500 });
    setBuiltinConnectorsForTest([{ id: "toy-slow", dir: slow }, { id: "toy-patient", dir: patient }]);
    await writeSession(r, "t.csv", "a\n1\n", "a\n2\n");
    const row = postRows(r.home)[0]!;
    const ask = (connector: string) => captureFileRow({ home: r.home, taskId: row.taskId, subject: row.filePath, connector, before: row.prevSha256, after: row.sha256, timeoutMs: 300 });
    const s = await ask("toy-slow");
    assert.match(s?.failed ?? "", /timed out \(no answer to "diff" within 300 ms\)/, JSON.stringify(s));
    const p = await ask("toy-patient");
    assert.ok(p?.changesSha256 !== undefined && p.failed === undefined, JSON.stringify(p));
  });

  it("`cocheck connector test` honours it: a connector 500 ms slow per answer fails under diffMs 200", async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "ct-")), "toy-level-1");
    await cp(path.join(ROOT, "public-kit", "examples", "toy-level-1"), dir, { recursive: true });
    // every line after hello is written 500 ms late
    await writeFile(path.join(dir, "slow.mjs"), `const w = process.stdout.write.bind(process.stdout); let n = 0;\nprocess.stdout.write = (c, ...a) => { if (n++ === 0) return w(c, ...a); setTimeout(() => w(c, ...a), 500); return true; };\nawait import("./connector.mjs");\n`);
    const m = JSON.parse(await readFile(path.join(dir, "cocheck-connector.json"), "utf8"));
    await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ ...m, run: ["node", "slow.mjs"], diffMs: 200 }));
    const out = await runConnectorTest([dir, "--states", path.join(ROOT, "public-kit", "toy-product", "states")]);
    assert.equal(out.exitCode, 1, out.stdout);
    assert.match(out.stdout, /within 0\.2 seconds|200 ms/, out.stdout);
  });
});

describe("(3) pendingRetry is acted on", () => {
  // These cases are about the count, not the spacing: no gap between asks (the spacing has its own cases below).
  async function settled(r: Rig, spacing: CaptureSpacing = { gapsMs: [0, 0, 0, 0] }): Promise<{ row: () => FileStateRow; settle: () => Promise<void> }> {
    const row = (): FileStateRow => postRows(r.home)[0]!;
    const settle = async (): Promise<void> => {
      const ledger = openLedger(r.home);
      // the review process's own path: only rows still pending are read (settlePendingCaptures)
      try { for (const p of ledger.pendingCapturesForTask(row().taskId)) await settleFileCapture(ledger, r.home, p, 5000, spacing); } finally { ledger.close(); }
    };
    return { row, settle };
  }

  it("two 'ask again' answers then a normal one: pending after loads 1 and 2, frozen after 3, the connector asked 3 times", async () => {
    const r = await rig();
    const dir = await toyFolder("toy-wait", { extensions: [".csv"], answers: [PENDING, PENDING, DOC()] });
    setBuiltinConnectorsForTest([{ id: "toy-wait", dir }]);
    await writeSession(r, "t.csv", "a\n1\n", "a\n2\n");
    const { row, settle } = await settled(r);
    await settle();
    assert.equal(row().capture, "pending"); assert.equal(row().captureTries, 1); assert.ok(row().captureTrySha);
    await settle();
    assert.equal(row().capture, "pending"); assert.equal(row().captureTries, 2);
    await settle();
    assert.equal(row().capture, "captured");
    assert.equal(await callsOf(dir), 3);
    const frozen = (await readFrozen(r.home, row().taskId, row().changesSha256!)) as { pendingRetry?: unknown; caveats?: unknown };
    assert.equal(frozen.pendingRetry, undefined);
    await settle();
    assert.equal(await callsOf(dir), 3, "a frozen row is never asked again");
  });

  it(`a connector that always answers 'ask again' is frozen after ${MAX_CAPTURE_ASKS} asks, with a caveat, and never asked again`, async () => {
    const r = await rig();
    const dir = await toyFolder("toy-wait", { extensions: [".csv"], answers: [PENDING] });
    setBuiltinConnectorsForTest([{ id: "toy-wait", dir }]);
    await writeSession(r, "t.csv", "a\n1\n", "a\n2\n");
    const { row, settle } = await settled(r);
    for (let i = 1; i < MAX_CAPTURE_ASKS; i++) {
      await settle();
      assert.equal(row().capture, "pending", `after ask ${i}`);
    }
    await settle();
    assert.equal(row().capture, "captured");
    assert.equal(await callsOf(dir), MAX_CAPTURE_ASKS);
    const frozen = (await readFrozen(r.home, row().taskId, row().changesSha256!)) as { caveats?: unknown; changes?: unknown[] };
    assert.deepEqual(frozen.caveats, [ASKS_RAN_OUT]);
    assert.equal(frozen.changes?.length, 1);
    await settle(); await settle();
    assert.equal(await callsOf(dir), MAX_CAPTURE_ASKS);
  });

  it("the connector's own count bounds the asks: an answer of pendingRetry 1 is asked once more, then frozen with the caveat, and never asked again", async () => {
    const r = await rig();
    const dir = await toyFolder("toy-wait", { extensions: [".csv"], answers: [DOC({ pendingRetry: 1 })] });
    setBuiltinConnectorsForTest([{ id: "toy-wait", dir }]);
    await writeSession(r, "t.csv", "a\n1\n", "a\n2\n");
    const { row, settle } = await settled(r);
    await settle();
    assert.equal(row().capture, "pending", "pendingRetry 1: one more ask is due");
    await settle();
    assert.equal(row().capture, "captured", "the one more ask was the last");
    assert.equal(await callsOf(dir), 2);
    const frozen = (await readFrozen(r.home, row().taskId, row().changesSha256!)) as { caveats?: unknown };
    assert.deepEqual(frozen.caveats, [ASKS_RAN_OUT]);
    await settle(); await settle();
    assert.equal(await callsOf(dir), 2);
  });

  it("the latest answer's count sets the asks left, still under the cap of 5: 3, then 1, means 3 asks in all", async () => {
    const r = await rig();
    const dir = await toyFolder("toy-wait", { extensions: [".csv"], answers: [DOC({ pendingRetry: 3 }), DOC({ pendingRetry: 1 }), DOC({ pendingRetry: 5 })] });
    setBuiltinConnectorsForTest([{ id: "toy-wait", dir }]);
    await writeSession(r, "t.csv", "a\n1\n", "a\n2\n");
    const { row, settle } = await settled(r);
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(row().capture, "captured");
    assert.equal(await callsOf(dir), 3);
  });

  it("the gaps double from 30 s:30, 60, 120 and 240 s between asks 1 to 5", () => {
    assert.deepEqual([...CAPTURE_ASK_GAPS_MS], [30_000, 60_000, 120_000, 240_000]);
    assert.equal(CAPTURE_ASK_GAPS_MS.length, MAX_CAPTURE_ASKS - 1);
  });

  it("asks are spaced: two loads 1 s apart ask the connector once; a load after the gap asks again; a load inside the next (doubled) gap does not", async () => {
    const r = await rig();
    const dir = await toyFolder("toy-wait", { extensions: [".csv"], answers: [PENDING] });
    setBuiltinConnectorsForTest([{ id: "toy-wait", dir }]);
    await writeSession(r, "t.csv", "a\n1\n", "a\n2\n");
    const clock = { t: Date.now() };
    const { row, settle } = await settled(r, { now: () => clock.t });
    await settle();
    assert.equal(await callsOf(dir), 1);
    clock.t += 1000;
    await settle();
    assert.equal(await callsOf(dir), 1, "a load 1 s after the first ask serves the stored answer and does not ask again");
    assert.equal(row().capture, "pending"); assert.equal(row().captureTries, 1);
    clock.t += CAPTURE_ASK_GAPS_MS[0]!;
    await settle();
    assert.equal(await callsOf(dir), 2, "a load after the 30 s gap asks again");
    assert.equal(row().captureTries, 2);
    clock.t += CAPTURE_ASK_GAPS_MS[0]! + 1000;
    await settle();
    assert.equal(await callsOf(dir), 2, "31 s later is inside the doubled 60 s gap");
    clock.t += CAPTURE_ASK_GAPS_MS[1]!;
    await settle();
    assert.equal(await callsOf(dir), 3);
  });

  it(`spaced asks still freeze at the ${MAX_CAPTURE_ASKS}th, with loads inside each gap never counting as an ask`, async () => {
    const r = await rig();
    const dir = await toyFolder("toy-wait", { extensions: [".csv"], answers: [PENDING] });
    setBuiltinConnectorsForTest([{ id: "toy-wait", dir }]);
    await writeSession(r, "t.csv", "a\n1\n", "a\n2\n");
    const clock = { t: Date.now() };
    const { row, settle } = await settled(r, { now: () => clock.t });
    await settle();
    for (let i = 1; i < MAX_CAPTURE_ASKS; i++) {
      clock.t += 1000; await settle();
      assert.equal(await callsOf(dir), i, `a load inside gap ${i} asks nothing`);
      clock.t += CAPTURE_ASK_GAPS_MS[i - 1]!; await settle();
    }
    assert.equal(row().capture, "captured");
    assert.equal(await callsOf(dir), MAX_CAPTURE_ASKS);
    const frozen = (await readFrozen(r.home, row().taskId, row().changesSha256!)) as { caveats?: unknown };
    assert.deepEqual(frozen.caveats, [ASKS_RAN_OUT]);
    clock.t += 3_600_000; await settle();
    assert.equal(await callsOf(dir), MAX_CAPTURE_ASKS);
  });

  it("while it waits the page gets the pending answer's change list, marked pending, with a waiting line", async () => {
    const r = await rig();
    const dir = await toyFolder("toy-wait", { extensions: [".csv"], answers: [PENDING] });
    setBuiltinConnectorsForTest([{ id: "toy-wait", dir }]);
    await writeSession(r, "t.csv", "a\n1\n", "a\n2\n");
    const { settle } = await settled(r);
    await settle();
    const TOKEN = "t".repeat(40);
    const ledger = openLedger(r.home);
    const { server, port } = await startReviewServer(ledger, TOKEN, r.home, 0, undefined, { previewRenderer: async () => null, quickLook: false, connectorTimeoutMs: 5000 });
    cleanups.push(async () => { await new Promise<void>((res) => server.close(() => res())); ledger.close(); });
    const get = (p: string): Promise<string> => new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }).on("error", reject);
    });
    const task = ledger.allTaskIds()[0]!;
    const timeline = JSON.parse(await get(`/timeline/${task}`)) as { unplaced: Array<{ id: string; file: string }>; requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; file: string }> }> }> }> };
    const all = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((x) => x.calls.flatMap((c) => c.changes)))];
    const id = all.find((c) => path.basename(c.file) === "t.csv")!.id;
    const doc = JSON.parse(await get(`/timeline/${task}/view/${encodeURIComponent(id)}`)) as { pending?: boolean; changes: Array<{ label: string }>; caveats: string[] };
    assert.equal(doc.pending, true, JSON.stringify(doc));
    // the page's sign that this is a connector waiting to be asked again (it then asks every 30 s, test/connector-pending-polling-page.test.ts)
    assert.equal((doc as { pendingRetry?: unknown }).pendingRetry, 2);
    assert.deepEqual(doc.changes.map((c) => c.label), ["row 1"]);
    assert.match(doc.caveats[0] ?? "", /^Waiting: the connector said it was not ready yet.*It said: the product is busy$/);
    // let the background re-ask the load started finish before the home goes away
    await new Promise((res) => setTimeout(res, 1500));
  });
});
