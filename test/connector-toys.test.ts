import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { afterSnapshot } from "../src/connector/after-snapshot.ts";
import { beforeSnapshot, createConnectorPool } from "../src/connector/before-snapshot.ts";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { drawn } from "./helpers/made-page.ts";
import { removeHome } from "./helpers/remove-home.ts";
import { pathToFileURL } from "node:url";

// Clause 3 on the real example connectors: capture through the real hooks' functions, serve through the real /view route, draw the served
// document in the page's vm harness, and read the source wording (and the boxes of level 3) off the page.

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


describe("the toy connectors' served documents drawn by the page", () => {
  it("toy-level-1: 'Change list from toy-level-1', cards only, tally line", async () => {
    const r = await rig("toy-level-1");
    const { doc } = await r.capture("edit");
    const p = await drawn(doc);
    const t = p.byId("bodyview").textContent;
    assert.ok(p.details().includes("Change list from toy-level-1"), p.details());
    assert.ok(p.details().includes("1 changed"));
    assert.ok(!/Change list from|1 changed/.test(t), "the source and tally lines are Details notes, not in the page flow");
    assert.ok(t.includes("buy oat milk"));
    assert.equal(p.byId("stage").hidden, true);
  });
  it("toy-level-3: 'Picture from toy-level-3' over the stage, with the state text as the picture and the change boxed", async () => {
    const r = await rig("toy-level-3");
    const { doc } = await r.capture("create");
    const p = await drawn(doc);
    assert.ok(!p.details().includes("Picture from"), p.details()); // the toy sends no renderedBy, so no "Drawn by" line and never the id
    assert.equal(p.byId("viewline").hidden, true, "the source line is a Details note, never over the stage");
    assert.equal(p.byId("stage").hidden, false);
    assert.ok(p.byId("va").textContent.includes("\"notes\""), "the stored after state is the text picture");
    assert.ok(p.byId("va").descendants().some((n) => n.className.includes("hit")), "the box lands on its line");
  });
  it("toy-export: 'Made by CoCheck from toy-export's export'", async () => {
    const r = await rig("toy-export");
    const { doc } = await r.capture("edit");
    const p = await drawn(doc);
    const t = p.details() + "\n" + p.byId("bodyview").textContent;
    assert.ok(t.includes("Drawn by CoCheck from the text"), t);
  });
});
