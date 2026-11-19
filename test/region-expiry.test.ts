import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";

// A region's words and place expire with the task's other values: the regions folder is deleted and every
// note_regions row reads "values expired". Guard: before the expiry point the folder and the rows are untouched. The two region
// tables are append-only except for exactly that blanking.

const DAY = 24 * 60 * 60 * 1000;
const SENTINEL = "ZQREGIONWHERE";

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-exp-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-exp-folder-")));
  const ledger = openLedger(home);
  let skew = 0;
  const tasks = new TaskStore(ledger, home, [createFilesLayer()], () => Date.now() + skew);
  return {
    home, ledger, tasks, file: (n: string) => path.join(folder, n), advance: (ms: number) => (skew = ms),
    cleanup: async () => { ledger.close(); await rm(home, { recursive: true, force: true }); await rm(folder, { recursive: true, force: true }); },
  };
}
type T = Awaited<ReturnType<typeof setup>>;

/** A signed task with a picture region (file written) and a cells region, the first linked to a failed verdict and the second to a send-back. */
async function populate(t: T): Promise<{ id: number; pic: number; cells: number; dir: string }> {
  await writeFile(t.file("a.txt"), "one\n");
  const id = await t.tasks.touch("c", t.file("a.txt"));
  await writeFile(t.file("a.txt"), "two\n");
  await t.tasks.submit("c", "intent", false);
  const dir = path.join(t.home, "tasks", String(id), "regions");
  const base = { taskId: id, changeKey: "k1", side: "after" as const, sha: "a".repeat(64), page: null };
  const pic = t.ledger.appendRegion({ ...base, kind: "picture", rect: [0.1, 0.1, 0.5, 0.5], where: `${SENTINEL} picture`, picture: true }, (rid) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, `${rid}.png`), Buffer.from("png"), { mode: 0o600 });
  });
  const cells = t.ledger.appendRegion({ ...base, kind: "cells", rect: { sheet: "S1", range: "A1", lines: [`A1: ${SENTINEL}`] }, where: `S1!A1 ${SENTINEL}`, picture: false });
  const v = t.ledger.appendStopVerdict({ taskId: id, stopId: "s1", subject: "a.txt", fingerprint: "f".repeat(64), status: "failed", note: "n", reviewer: "Dana" });
  const sb = t.ledger.appendSendBack({ taskId: id, prompt: "p", stopIds: ["s1"], reviewer: "Dana", note: "n" });
  t.ledger.linkRegions([pic], { verdictId: v });
  t.ledger.linkRegions([cells], { sendBackId: sb });
  return { id, pic, cells, dir };
}
const db = (t: T) => new DatabaseSync(path.join(t.home, "ledger.sqlite"));
const refuses = (d: DatabaseSync, sql: string) => assert.throws(() => d.exec(sql), /append-only/, sql);

describe("region expiry", () => {
  it("at five weeks the regions folder is gone and every row's where and rect read 'values expired'; ids, kinds, sides, shas, links stay", async () => {
    const t = await setup();
    try {
      const { id, pic, cells, dir } = await populate(t);
      assert.ok(existsSync(dir));
      t.advance(8 * DAY);
      await t.tasks.sweep();
      t.advance(8 * DAY + 40 * DAY);
      await t.tasks.sweep();
      assert.ok(t.ledger.valuesExpiredAt(id));
      assert.equal(existsSync(dir), false);
      const d = db(t);
      const rows = d.prepare("SELECT * FROM note_regions WHERE task_id = ? ORDER BY id").all(id) as Array<Record<string, unknown>>;
      assert.deepEqual(rows.map((r) => [r.id, r.kind, r.side, r.sha, r.change_key, r.picture]), [[pic, "picture", "after", "a".repeat(64), "k1", 1], [cells, "cells", "after", "a".repeat(64), "k1", 0]]);
      for (const r of rows) assert.deepEqual([r.where_text, r.rect_json], ["values expired", "values expired"]);
      assert.equal((d.prepare("SELECT COUNT(*) AS n FROM region_links").get() as { n: number }).n, 2);
      const read = t.ledger.regionsForTask(id);
      assert.ok(read.every((r) => r.where === "values expired" && r.rect === null));
      d.close();
    } finally {
      await t.cleanup();
    }
  });

  it("a task closed 20 days ago keeps its pictures and its regions' words", async () => {
    const t = await setup();
    try {
      const { id, pic, dir } = await populate(t);
      t.advance(8 * DAY);
      await t.tasks.sweep();
      t.advance(8 * DAY + 20 * DAY);
      await t.tasks.sweep();
      assert.equal(t.ledger.valuesExpiredAt(id), undefined);
      assert.ok(existsSync(path.join(dir, `${pic}.png`)), "the picture of a signed task survives the closed-task orphan sweep");
      assert.ok(t.ledger.regionsForTask(id).every((r) => r.where.includes(SENTINEL)));
    } finally {
      await t.cleanup();
    }
  });

  it("the triggers allow exactly the blanking: any other update, any delete, any link change is refused, before and after expiry", async () => {
    const t = await setup();
    const d = db(t);
    try {
      const { id, pic } = await populate(t);
      for (const sql of [
        `UPDATE note_regions SET where_text = 'values expired' WHERE task_id = ${id}`,
        `UPDATE note_regions SET rect_json = 'values expired' WHERE task_id = ${id}`,
        `UPDATE note_regions SET where_text = 'x' WHERE task_id = ${id}`,
        `UPDATE note_regions SET picture = 0 WHERE task_id = ${id}`,
        "DELETE FROM note_regions",
        "UPDATE region_links SET verdict_id = NULL, send_back_id = 1",
        "DELETE FROM region_links",
      ]) refuses(d, sql);
      assert.throws(() => t.ledger.expireValues(id, new Date(Date.now() + 400 * DAY)), /values expire only 30 days after a task closed/);
      assert.ok(t.ledger.regionsForTask(id).every((r) => r.where.includes(SENTINEL)));
      t.advance(8 * DAY);
      await t.tasks.sweep();
      t.advance(8 * DAY + 40 * DAY);
      await t.tasks.sweep();
      refuses(d, `UPDATE note_regions SET where_text = 'x' WHERE id = ${pic}`);
      refuses(d, `UPDATE note_regions SET where_text = 'values expired', kind = 'lines' WHERE id = ${pic}`);
      refuses(d, `UPDATE note_regions SET where_text = 'values expired', picture = 0 WHERE id = ${pic}`);
      refuses(d, `UPDATE note_regions SET where_text = 'values expired', sha = '' WHERE id = ${pic}`);
      refuses(d, `UPDATE note_regions SET change_key = 'k2' WHERE id = ${pic}`);
      refuses(d, `UPDATE note_regions SET task_id = 99 WHERE id = ${pic}`);
      refuses(d, "DELETE FROM note_regions");
      refuses(d, "UPDATE region_links SET verdict_id = NULL, send_back_id = 1");
      refuses(d, "DELETE FROM region_links");
      assert.throws(() => d.exec(`INSERT INTO region_links (region_id, verdict_id, send_back_id, ts) VALUES (${pic}, 1, NULL, 'x')`), /UNIQUE/, "a region is linked once");
      assert.throws(() => d.exec("INSERT INTO region_links (region_id, verdict_id, send_back_id, ts) VALUES (999, 1, 1, 'x')"), /CHECK/, "exactly one of verdict and send-back");
    } finally {
      d.close();
      await t.cleanup();
    }
  });

  it("an expired task takes no new region: the route answers 410 and records nothing", async () => {
    const t = await setup();
    const TOKEN = "s".repeat(40);
    const { server, port } = await startReviewServer(t.ledger, TOKEN, t.home, 0, undefined, { quickLook: false });
    try {
      const { id } = await populate(t);
      t.advance(8 * DAY);
      await t.tasks.sweep();
      t.advance(8 * DAY + 40 * DAY);
      await t.tasks.sweep();
      const before = t.ledger.regionsForTask(id).length;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: `/timeline/${id}/review/region?t=${TOKEN}`, method: "POST", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject);
        req.end(JSON.stringify({ change: "k1", side: "after", kind: "lines", from: 1, to: 1 }));
      });
      assert.equal(status, 410);
      assert.equal(t.ledger.regionsForTask(id).length, before);
    } finally {
      await new Promise<void>((r) => (server as Server).close(() => r()));
      await t.cleanup();
    }
  });
});
