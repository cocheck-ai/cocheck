// Clauses 1, 5 and 7: a closed task keeps its frozen change lists (changes/) and kept MCP calls (calls/) until the task's values expire, then removes them
// with the rest. Real hook (the kept MCP call), real capture (the connector step), real TaskStore.sweep with the closed policy, real review server routes, the page's vm drawing.
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { afterSnapshot } from "../src/connector/after-snapshot.ts";
import { beforeSnapshot, createConnectorPool } from "../src/connector/before-snapshot.ts";
import { callsDirOf, changesDirOf } from "../src/connector/frozen.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { closureOf } from "../src/signoff.ts";
import { TaskStore } from "../src/tasks.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";
import { drivePage, type PairModel } from "./helpers/connector-v1-page.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATES = path.join(ROOT, "public-kit", "toy-product", "states");
const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11", TOK = "t".repeat(40), DAY = 86_400_000;

describe("exit (d): a swept task serves its connector step and its MCP card as before; the values expiry removes them", () => {
  let rig: Rig, ledger: Ledger, server: http.Server, port = 0, task = 0, skew = 0;
  const pool = createConnectorPool();
  const get = (p: string) => new Promise<{ status: number; body: string }>((res, rej) => http.get({ host: "127.0.0.1", port, path: `${p}${p.includes("?") ? "&" : "?"}t=${TOK}` }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode ?? 0, body: b })); }).on("error", rej));
  const hook = async (body: Record<string, unknown>) => {
    const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify({ session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", ...body })); })(), localProcess: { request: async () => { throw new Error("none"); } } } as any);
    assert.equal(res.exitCode, 0, res.stderr);
  };
  before(async () => {
    setKeyProvider(memoryKeyProvider());
    rig = await makeRig(); ledger = openLedger(rig.home);
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "label it" });
    const input = { messageId: "M1", addLabelIds: ["Label_2"] };
    await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__gmail__modify_message", tool_use_id: "w1", tool_input: input });
    await hook({ hook_event_name: "PostToolUse", tool_name: "mcp__gmail__modify_message", tool_use_id: "w1", tool_input: input, tool_response: { content: [{ type: "text", text: "Label_2 added to 1 messages" }] } });
    task = ledger.allTaskIds()[0]!;
    // the connector step: a real capture of a toy-level-3 subject into the same task
    await mkdir(path.join(rig.home, "connectors"), { recursive: true });
    await cp(path.join(ROOT, "public-kit", "examples", "toy-level-3"), path.join(rig.home, "connectors", "toy-level-3"), { recursive: true });
    const file = path.join(await mkdtemp(path.join(tmpdir(), "cocheck-notes-")), "notes.json");
    const subject = pathToFileURL(file).href.replace(/^file:/, "toy-level-3:");
    await writeFile(file, await readFile(path.join(STATES, "edit.before.json")));
    const b = await beforeSnapshot({ home: rig.home, pool, subject, budgetMs: 10_000 });
    await writeFile(file, await readFile(path.join(STATES, "edit.after.json")));
    assert.equal(await afterSnapshot({ home: rig.home, ledger, pool, client: ledger.taskClient(task)!, task, call: "toolu_1", subject, before: b.ref, budgetMs: 10_000 }), "recorded");
    ({ server, port } = (await startReviewServer(ledger, TOK, rig.home, 0, undefined, { previewRenderer: async () => null, quickLook: false })) as unknown as { server: http.Server; port: number });
  });
  after(async () => { await pool.stopAll(); await new Promise<void>((r) => server.close(() => r())); ledger.close(); setKeyProvider(null); await rig.cleanup(); });

  /** What the page shows for the step and for the MCP card, from the real routes. */
  const shown = async () => {
    const model = JSON.parse((await get(`/timeline/${task}/review/model`)).body) as PairModel["model"];
    const stop = model.stops.find((s) => s.change !== undefined && s.change.file.includes("notes.json"));
    assert.ok(stop?.change, "the connector step is a stop of the model");
    const key = stop.change.key;
    const view = await get(`/timeline/${task}/view/${encodeURIComponent(key)}`);
    assert.equal(view.status, 200, view.body);
    const page = await drivePage({ model, change: stop.change }, async (k) => JSON.parse((await get(`/timeline/${task}/view/${encodeURIComponent(k)}`)).body));
    const card = await get(`/timeline/${task}/review/mcp/w1`);
    return { view: view.body, page, card };
  };

  it("sign off, sweep with the closed policy: the step draws identically, and the MCP card still shows its kept values", async () => {
    const first = await shown();
    assert.equal(first.card.status, 200, first.card.body);
    assert.ok(JSON.parse(first.card.body).intent.lines.includes("messageId: M1"));
    assert.ok(first.page.wordsList.length > 0 || first.page.boxes.length > 0 || first.page.hits.length > 0, "the page drew the step");
    const frozen = readdirSync(changesDirOf(rig.home, task)), kept = readdirSync(callsDirOf(rig.home, task));
    assert.ok(frozen.length > 0 && kept.length > 0);
    const tasks = new TaskStore(ledger, rig.home, [createXlsxLayer({ openState: async () => "closed" }), createFilesLayer()], () => Date.now() + skew);
    await tasks.submit(ledger.taskClient(task)!, "label it", true);
    await signOffForTest(ledger, task, "Dana");
    assert.equal(closureOf(ledger, task)?.kind, "signed");
    skew = 2 * DAY; // the sweep runs on a closed task: the closed policy prunes the copies
    await tasks.sweep();
    assert.equal(ledger.valuesExpiredAt(task), undefined, "its values have not expired");
    assert.deepEqual(readdirSync(changesDirOf(rig.home, task)), frozen, "the frozen lists survive the closed sweep");
    assert.deepEqual(readdirSync(callsDirOf(rig.home, task)), kept, "the kept calls survive the closed sweep");
    const second = await shown();
    assert.equal(second.view, first.view, "the served document is identical");
    assert.deepEqual(second.page, first.page, "the vm page draws it identically");
    assert.equal(second.card.status, 200);
    assert.equal(second.card.body, first.card.body, "the MCP card shows its kept values as before");
  });

  it("DANGEROUS DIRECTION: evidence is deleted when the values expire (not before, not never): changes/ and calls/ follow the values-expiry rule", async () => {
    const tasks = new TaskStore(ledger, rig.home, [createXlsxLayer({ openState: async () => "closed" }), createFilesLayer()], () => Date.now() + skew);
    skew = 20 * DAY; // signed 20 days ago: not yet 30
    await tasks.sweep();
    assert.equal(ledger.valuesExpiredAt(task), undefined);
    assert.ok(existsSync(changesDirOf(rig.home, task)) && existsSync(callsDirOf(rig.home, task)), "kept before the values expire");
    skew = 40 * DAY;
    await tasks.sweep();
    assert.notEqual(ledger.valuesExpiredAt(task), undefined);
    assert.equal(existsSync(changesDirOf(rig.home, task)), false, "removed once the values expire");
    assert.equal(existsSync(callsDirOf(rig.home, task)), false, "removed once the values expire");
  });
});
