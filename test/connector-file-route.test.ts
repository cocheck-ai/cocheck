import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Exit (b): a real file write on a connector-claimed extension goes through the hook adapter, then the review route and the page (vm), and the
// file-subject level-3 toy and the export toy draw as sent, the way the URI-subject path draws them. Old file steps never re-ask the connector.
const ROOT = path.resolve(import.meta.dirname, "..");
const STATES = path.join(ROOT, "public-kit", "toy-product", "states");
const TOKEN = "t".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await runCleanups(cleanups); setKeyProvider(null); });

/** Installs `example` in the rig's home, writes `name` as the pair's before state, drives one hook-adapter session that rewrites it as the pair's after state. */
export async function fileSession(example: string, name: string, pair: string, installFrom = path.join(ROOT, "public-kit", "examples", example), statesDir = STATES) {
  setKeyProvider(memoryKeyProvider());
  const r: Rig = await makeRig();
  cleanups.push(() => r.cleanup());
  await mkdir(path.join(r.home, "connectors"), { recursive: true });
  await cp(installFrom, path.join(r.home, "connectors", example), { recursive: true });
  const file = path.join(r.folder, name);
  await writeFile(file, await readFile(path.join(statesDir, `${pair}.before.json`)));
  let clock = 1_700_000_000_000;
  const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
  const base = { session_id: "session-1", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const call = (event: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "python3 edit.py", description: "edit" }, ...extra });
  const send = (p: Record<string, unknown>) => handleHook(p as unknown as HookPayload, opts);
  await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "edit the notes" });
  await send(call("PreToolUse"));
  await writeFile(file, await readFile(path.join(statesDir, `${pair}.after.json`)));
  await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
  const ledger = openLedger(r.home);
  const { server, port } = await startReviewServer(ledger, TOKEN, r.home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
  cleanups.push(async () => { await new Promise<void>((res) => server.close(() => res())); ledger.close(); });
  const get = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
  const task = ledger.allTaskIds()[0]!;
  return { r, ledger, get, task, file };
}

/**
 * The served document of the one change the timeline holds for the task. The review process reads a file row's change list after the hook, so a
 * first answer can be the pending note; the page asks again, and so does this, until the frozen answer is served (at most `waitMs`).
 */
export async function servedOf(s: Awaited<ReturnType<typeof fileSession>>, waitMs = 15_000): Promise<{ doc: Record<string, any>; status: number; body: string; asks: number }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const until = Date.now() + waitMs;
  for (let asks = 1; ; asks++) {
    const timeline = JSON.parse((await s.get(`/timeline/${s.task}`)).body) as { unplaced: Array<{ id: string }>; requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string }> }> }> }> };
    const all = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((x) => x.calls.flatMap((c) => c.changes)))];
    assert.equal(all.length, 1, JSON.stringify(timeline).slice(0, 600));
    const view = await s.get(`/timeline/${s.task}/view/${encodeURIComponent(all[0]!.id)}`);
    const doc = JSON.parse(view.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (doc.pending !== true || Date.now() > until) return { doc, status: view.status, body: view.body, asks };
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("a file write on a claimed extension is captured and frozen like a subject", () => {
  it("toy-level-3 on x.level3.notes.json draws as sent at level 3 (Picture from toy-level-3, boxes), frozen at capture", async () => {
    const s = await fileSession("toy-level-3", "x.level3.notes.json", "create");
    const { doc, status, body } = await servedOf(s);
    // Frozen by the review process (no review process ran at the write, so the first load read it), never by the hook.
    const rows = s.ledger.fileStatesForTask(s.task).filter((x) => x.connector != null);
    assert.ok(rows.length > 0);
    const changed = rows.filter((x) => x.prevSha256 !== null && !x.changesSha256);
    assert.equal(changed.length, 0, "every changed connector row holds its frozen list");
    assert.equal(status, 200, body);
    assert.equal(doc.source.level, 3);
    const p = await drawn(doc);
    assert.ok(!p.details().includes("Picture from"), p.details()); // the toy sends no renderedBy, so no "Drawn by" line and never the id
    assert.equal(p.byId("stage").hidden, false);
    assert.ok(p.byId("va").descendants().some((n) => n.className.includes("hit")), "a box lands on its line");
  });
  it("toy-level-3: uninstalling the connector after capture leaves the step drawing the same (no live re-ask)", async () => {
    const s = await fileSession("toy-level-3", "x.level3.notes.json", "create");
    const first = (await servedOf(s)).body;
    assert.equal(JSON.parse(first).source.level, 3, "drawn at the connector's level before the uninstall");
    await writeFile(path.join(s.r.home, "connectors", "toy-level-3", "connector.mjs"), "process.exit(3);\n");
    assert.equal((await servedOf(s)).body, first);
  });
  it("toy-export on x.export.notes.json draws 'Made by CoCheck from toy-export's export' with the export text", async () => {
    const s = await fileSession("toy-export", "x.export.notes.json", "edit");
    const { doc, status, body } = await servedOf(s);
    assert.equal(status, 200, body);
    assert.deepEqual(doc.source, { by: "cocheck", name: "toy-export", level: doc.source.level });
    const p = await drawn(doc);
    const t = p.details() + "\n" + p.byId("bodyview").textContent;
    assert.ok(t.includes("Drawn by CoCheck from the text"), t);
    assert.ok(!/failed|Nothing changed/.test(t), t);
    assert.ok(JSON.stringify(doc).includes(": "), "the export text is what is drawn");
  });
});
