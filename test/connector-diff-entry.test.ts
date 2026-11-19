import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { memoryKeyProvider, readSealed, setKeyProvider } from "../src/seal.ts";
import { changesDirOf } from "../src/connector/frozen.ts";
import { existsSync } from "node:fs";
import { storeDirOf } from "../src/states.ts";
import { startReviewServer } from "../src/review-server.ts";
import { httpLocalProcess } from "../src/connector/local-process.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// A diff-entry connector is asked `diffs({subject, since, until})` around the agent's call. The stand-in reads dated changes from a file, answers only
// those dated in [since, until) for the asked subject, and logs every request it gets.
const STAND_IN = `
import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const [, , dataFile, logFile] = process.argv;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const out = (result) => process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");
  if (msg.method === "hello") return out({ name: "stand-in" });
  appendFileSync(logFile, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
  if (msg.method !== "diffs") return process.stdout.write(JSON.stringify({ id: msg.id, error: { message: "no snapshot here" } }) + "\\n");
  const { subject, since, until } = msg.params;
  const all = JSON.parse(readFileSync(dataFile, "utf8"));
  const changes = all.filter((c) => c.subject === subject && c.at >= since && c.at < until).map((c) => c.change);
  out({ spec: "cocheck.changes/1", changes });
});
`;
const SUBJECT = "linear://issue/iss-1";
const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b22";
const TOKEN = "tok-T393";
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const waitFor = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};
const change = (label: string) => ({ id: label, mark: "changed", label, before: "Todo", after: label });

let rig: Rig, ledger: Ledger, server: http.Server, dataFile: string, logFile: string;
const rows = () => ledger.allTaskIds().flatMap((id) => ledger.fileStatesForTask(id)).filter((r) => r.connector != null);
const asked = () => (readFileSync(logFile, "utf8").trim() === "" ? [] : readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
const payload = (event: "PreToolUse" | "PostToolUse", call: string, id = "iss-1") => ({
  session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: event, tool_name: "mcp__linear__update_issue", tool_use_id: call,
  tool_input: { id, title: "Other issue iss-2 linear://issue/iss-2" }, ...(event === "PostToolUse" ? { tool_response: { ok: true } } : {}),
});
const drive = async (event: "PreToolUse" | "PostToolUse", call: string, at: number, id?: string) => {
  const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload(event, call, id))); })(), localProcess: httpLocalProcess(rig.home), journalNow: () => at } as any);
  assert.equal(res.exitCode, 0, res.stderr);
};
/** One call: pre at T0 + start, post at T0 + end (journal clock), the vendor holding `data`. */
async function call(id: string, data: unknown[], start: number, end: number, want: number, ms = 4000, subjectId?: string) {
  writeFileSync(dataFile, JSON.stringify(data));
  await drive("PreToolUse", id, T0 + start, subjectId);
  await drive("PostToolUse", id, T0 + end, subjectId);
  await waitFor(() => rows().length >= want, ms);
}

before(async () => {
  setKeyProvider(memoryKeyProvider());
  rig = await makeRig();
  const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  dataFile = path.join(scratch, "data.json");
  logFile = path.join(scratch, "log");
  writeFileSync(logFile, "");
  writeFileSync(dataFile, "[]");
  const dir = path.join(rig.home, "connectors", "linear");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "stand-in.mjs"), STAND_IN);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "linear", version: "0.0.1", entry: "diff", matches: { schemes: ["linear"], mcpTools: ["mcp__linear__update_issue"], subjects: { "mcp__linear__update_issue": "linear://issue/{id}" } }, run: ["node", "stand-in.mjs", dataFile, logFile] }));
  ledger = openLedger(rig.home);
  const started = await startReviewServer(ledger, TOKEN, rig.home, 0, () => { server.close(); server.closeAllConnections(); });
  server = started.server;
  writeFileSync(path.join(rig.home, "review-server.json"), JSON.stringify({ port: started.port }));
  writeFileSync(path.join(rig.home, "review-token"), TOKEN);
});
after(async () => {
  if (server.listening) await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  ledger.close();
  setKeyProvider(null);
  await rig.cleanup();
});

describe("diff-entry capture", () => {
  it("a call with no task yet: diffs is asked with the journal's call start and end plus 5 s, the answer is sealed and one row is credited to the call", async () => {
    assert.equal(ledger.allTaskIds().length, 0);
    const data = [
      { subject: SUBJECT, at: iso(T0 - 1000), change: change("before the call") },
      { subject: SUBJECT, at: iso(T0 + 1000), change: change("during") },
      { subject: SUBJECT, at: iso(T0 + 2000 + 3000), change: change("in the grace") },
      { subject: SUBJECT, at: iso(T0 + 2000 + 5000), change: change("at the grace end") },
      { subject: SUBJECT, at: iso(T0 + 2000 + 60_000), change: change("long after") },
      { subject: "linear://issue/iss-2", at: iso(T0 + 1000), change: change("another subject") },
    ];
    await call("toolu_1", data, 0, 2000, 1);
    const asks = asked().filter((a) => a.method === "diffs");
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0].params, { subject: SUBJECT, since: iso(T0), until: iso(T0 + 2000 + 5000) });
    assert.equal(rows().length, 1);
    const r = rows()[0]!;
    assert.equal(r.filePath, SUBJECT);
    assert.equal(r.connector, "linear");
    assert.deepEqual(r.credited, ["toolu_1"]);
    assert.equal(r.prevSha256, null);
    const stored = JSON.parse((await readSealed(path.join(changesDirOf(rig.home, r.taskId), r.sha256))).toString("utf8"));
    assert.deepEqual(stored.changes.map((c: any) => c.label), ["during", "in the grace"]);
    // Sealed once. Both refs (the row's after ref and its change-list ref) are that one hash, and no second copy sits under states/.
    assert.equal(r.changesSha256, r.sha256);
    assert.equal(existsSync(path.join(storeDirOf(rig.home, r.taskId), r.sha256)), false, "no second sealed copy under states/");
  });

  it("DANGEROUS DIRECTION: changes dated outside the window, or for another subject, are never recorded", async () => {
    const r = rows()[0]!;
    const text = (await readSealed(path.join(changesDirOf(rig.home, r.taskId), r.sha256))).toString("utf8");
    for (const bad of ["before the call", "at the grace end", "long after", "another subject"]) assert.ok(!text.includes(bad), bad);
    // a window with only outside changes records nothing
    const n = rows().length;
    await call("toolu_2", [{ subject: SUBJECT, at: iso(T0 + 600_000), change: change("far later") }, { subject: "linear://issue/iss-2", at: iso(T0 + 100_000), change: change("else") }], 100_000, 101_000, 99, 600);
    assert.equal(rows().length, n, "no changes in the window records nothing");
    // the subject is the call's rendered template, not another field of the tool input that names an issue
    const last = asked().filter((a) => a.method === "diffs").at(-1);
    assert.equal(last.params.subject, SUBJECT);
  });

  it("the window comes from this call's own times: a later call asks for its own window", async () => {
    await call("toolu_3", [{ subject: SUBJECT, at: iso(T0 + 200_500), change: change("second call") }], 200_000, 201_000, 2);
    const last = asked().filter((a) => a.method === "diffs").at(-1);
    assert.deepEqual(last.params, { subject: SUBJECT, since: iso(T0 + 200_000), until: iso(T0 + 201_000 + 5000) });
    assert.equal(rows().length, 2);
    assert.deepEqual(rows()[1]!.credited, ["toolu_3"]);
  });

  it("the connector is never asked for a snapshot, and the loader reads the stored answer without calling the connector again", async () => {
    assert.equal(asked().filter((a) => a.method !== "diffs").length, 0, "no snapshot request to a diff-entry connector");
    const taskId = rows()[0]!.taskId;
    const before = asked().length;
    const input = await loadTimelineInput(ledger, rig.home, loadRows(ledger, taskId, "t"), {
      build: "t", quickLook: false, render: async () => null,
      connectorDiff: async () => { throw new Error("re-pulled"); },
    });
    const ds = [...input.diffs!.values()].filter((d) => d.producer === "connector");
    assert.equal(ds.length, 2);
    assert.equal(ds[0]!.unavailable, undefined);
    assert.deepEqual(ds[0]!.changes.map((c) => c.anchors[0]!.label), ["during", "in the grace"]);
    assert.deepEqual(ds[1]!.changes.map((c) => c.anchors[0]!.label), ["second call"]);
    assert.equal(asked().length, before, "the connector was not called again");
  });
});
