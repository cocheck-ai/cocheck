// Clauses 1, 2 and 5: a connector's v1 answer (or an export connector's text) is captured, frozen, and reaches the page as the same cocheck.changes/1
// document Office does, plus `source`. Real capture (beforeSnapshot, afterSnapshot), real review server route /timeline/<task>/view/<key>, real example connectors.
// The page wording of the source is not drawn yet in this tree: these assert the served `source` and that the document draws as cards (and boxes) through the page's own reader.
import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { afterSnapshot } from "../src/connector/after-snapshot.ts";
import { beforeSnapshot, createConnectorPool } from "../src/connector/before-snapshot.ts";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { changesDirOf } from "../src/connector/frozen.ts";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { sceneOfBody } from "./helpers/v1-served.ts";
import { readdirSync } from "node:fs";
import { removeHome } from "./helpers/remove-home.ts";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATES = path.join(ROOT, "public-kit", "toy-product", "states");
const TOKEN = "t".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); setKeyProvider(null); });

async function rig(example: string) {
  setKeyProvider(memoryKeyProvider());
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const scratch = await mkdtemp(path.join(tmpdir(), "cocheck-notes-"));
  const ledger = openLedger(home);
  const pool = createConnectorPool();
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
  cleanups.push(async () => { await pool.stopAll(); await new Promise<void>((r) => server.close(() => r())); ledger.close(); await removeHome(home); });
  await mkdir(path.join(home, "connectors"), { recursive: true });
  await cp(path.join(ROOT, "public-kit", "examples", example), path.join(home, "connectors", example), { recursive: true });
  const file = path.join(scratch, "notes.json");
  const subject = pathToFileURL(file).href.replace(/^file:/, `${example}:`); // toy-level-1:///C:/... on Windows, not toy-level-1://C:\...
  const get = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
  /** Writes the before state, snapshots it, writes the after state, captures it, and returns the served document of the one change. */
  const capture = async (pair: string) => {
    await writeFile(file, await readFile(path.join(STATES, `${pair}.before.json`)));
    const b = await beforeSnapshot({ home, pool, subject, budgetMs: 10_000 });
    await writeFile(file, await readFile(path.join(STATES, `${pair}.after.json`)));
    const outcome = await afterSnapshot({ home, ledger, pool, client: "claude-hook:/w#s", task: null, call: "toolu_1", subject, before: b.ref, budgetMs: 10_000 });
    assert.equal(outcome, "recorded");
    const task = ledger.allCaptureOutcomes().at(-1)!.taskId!;
    const timeline = JSON.parse((await get(`/timeline/${task}`)).body) as { unplaced: Array<{ id: string }>; requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string }> }> }> }> };
    const all = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))];
    assert.equal(all.length, 1);
    const view = await get(`/timeline/${task}/view/${encodeURIComponent(all[0]!.id)}`);
    assert.equal(view.status, 200, view.body);
    const again = async (): Promise<string> => (await get(`/timeline/${task}/view/${encodeURIComponent(all[0]!.id)}`)).body;
    return { task, again, view: view.body, doc: JSON.parse(view.body) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { home, capture };
}

describe("connector rows reach the page as the shared cocheck.changes/1 shape", () => {
  it("level 1: the connector's change list is frozen and served with source by connector, level 1", async () => {
    const r = await rig("toy-level-1");
    const { task, view, doc } = await r.capture("edit");
    assert.deepEqual(checkChanges(doc), []);
    assert.deepEqual(doc.source, { by: "connector", name: "toy-level-1", level: 1 });
    assert.deepEqual(doc.changes.map((c: { mark: string; label: string; before: string; after: string }) => [c.mark, c.label, c.before, c.after]), [["changed", "Note n1", "buy milk", "buy oat milk"]]);
    assert.equal((await sceneOfBody(view)).marks.length, 0, "level 1: cards only, no boxes");
    assert.equal(readdirSync(changesDirOf(r.home, task)).length, 1, "the document is frozen (one sealed list)");
  });

  it("level 3: boxes reach the page, source by connector, level 3", async () => {
    const r = await rig("toy-level-3");
    const { view, doc } = await r.capture("create");
    assert.deepEqual(checkChanges(doc), []);
    assert.deepEqual(doc.source, { by: "connector", name: "toy-level-3", level: 3 });
    assert.equal(doc.changes[0].mark, "added");
    assert.equal(doc.changes[0].boxes.length, 1);
    const scene = await sceneOfBody(view);
    assert.ok(scene.marks.length >= 1, "the page's own reader places the box");
  });

  it("export: CoCheck draws the stored text; source by cocheck, name the connector id; nothing is asked of the connector but its text", async () => {
    const r = await rig("toy-export");
    const { doc } = await r.capture("edit");
    assert.deepEqual(checkChanges(doc), []);
    assert.deepEqual(doc.source, { by: "cocheck", name: "toy-export", level: 3 });
    assert.ok(doc.pictures.some((p: { type: string }) => p.type === "text"), "text pictures drawn by CoCheck");
    assert.ok(JSON.stringify(doc).includes("buy oat milk") || doc.changes.length > 0);
  });

  it("an uninstalled connector leaves a frozen row serving the same document", async () => {
    const r = await rig("toy-level-3");
    const first = await r.capture("edit");
    await removeHome(path.join(r.home, "connectors", "toy-level-3"));
    // the same task, asked again: the document comes from the sealed list
    assert.equal(await first.again(), first.view);
    assert.equal(JSON.parse(first.view).source.name, "toy-level-3");
  });
});
