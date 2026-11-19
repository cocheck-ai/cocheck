import { describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { defaultReviewer } from "../src/review.ts";
import { startReviewServer } from "../src/review-server.ts";
import { signoffStatus } from "../src/signoff.ts";
import { insertLegacySignoff, signOffForTest } from "./helpers/signed-fixture.ts";

/** The reviewer-side decision record, written straight to the ledger (the removed legacy page was its only other writer). */
const decide = (ledger: Ledger, _taskId: number, rowId: number, decision: "approve" | "reject", note: string, reviewer: string): void => {
  ledger.recordDecision({ rowId, decision, note, reviewer });
};

const REVIEW_CLI = path.join(import.meta.dirname, "..", "scripts", "review.ts");
const TOKEN = "s".repeat(48);
const CLIENT = "claude-desktop";

/** A task whose only round is final with one decided row: ready to sign, so only the missing signature can refuse it. */
async function ready() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-s001-home-"));
  const work = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-s001-work-")));
  const file = path.join(work, "notes.txt");
  await writeFile(file, "v1");
  const ledger = openLedger(home);
  const taskId = ledger.openTask(CLIENT);
  const dest = path.join(home, "tasks", String(taskId), "round-1", "notes.txt");
  await mkdir(path.dirname(dest), { recursive: true });
  await writeSealed(dest, "v1");
  ledger.recordRound({
    taskId, seq: 1, intent: "pass", clientName: CLIENT, final: true, lastOpId: 0,
    snapshots: [{ taskId, round: 1, filePath: file, layer: "xlsx", snapshotPath: dest, mode: "copy" }],
    rows: [{ layer: "xlsx", kind: "value", before: 1, after: 2, ops: [], description: "A1 changed", detail: {}, filePath: file, location: "Sheet1!A1", status: "explained" }],
  });
  const row = ledger.reviewRowsForTask(taskId)[0]!;
  decide(ledger, taskId, row.id, "approve", "", "Dana");
  const rows = () => ledger.signoffsForTask(taskId).length;
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [REVIEW_CLI, ...args], { env: { ...process.env, COCHECK_HOME: home, ...env }, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { home, work, ledger, taskId, rows, cli, async cleanup() { ledger.close(); await rm(home, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); } };
}

function post(port: number, p: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function withServer<T>(t: Awaited<ReturnType<typeof ready>>, fn: (port: number) => Promise<T>): Promise<T> {
  const { server, port } = await startReviewServer(t.ledger, TOKEN, t.home);
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe("no path records an unsigned sign-off", () => {
  it("a raw SQL insert without a signature is refused by the table", async () => {
    const t = await ready();
    const db = new DatabaseSync(path.join(t.home, "ledger.sqlite"));
    assert.throws(() => db.exec(`INSERT INTO signoffs (task_id, signer, ts, rounds, rejections_json, files_json) VALUES (${t.taskId}, 'x', 'x', 1, '[]', '[]')`), /sign-off needs a signature/);
    db.close();
    assert.equal(t.rows(), 0);
    await t.cleanup();
  });

  it("the CLI has no sign verb, with or without COCHECK_REVIEWER", async () => {
    const t = await ready();
    for (const env of [{} as Record<string, string>, { COCHECK_REVIEWER: "Dana" }]) {
      const r = t.cli(["sign", String(t.taskId)], env);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /usage/i);
      assert.doesNotMatch(r.stderr + r.stdout, /signed off/);
    }
    assert.equal(t.rows(), 0);
    await t.cleanup();
  });

  it("the removed POST signoff route records nothing whatever the body, with an allowed Origin", async () => {
    const t = await ready();
    await withServer(t, async (port) => {
      const origin = { origin: `http://127.0.0.1:${port}` };
      for (const body of [{ signer: "Dana" }, { signer: "Dana", signature: "" }, { signer: "Dana", signature: "junk" }, {}]) {
        const r = await post(port, `/review/${t.taskId}/signoff?t=${TOKEN}`, body, origin);
        assert.equal(r.status, 404, `${r.status} ${r.body.slice(0, 80)}`);
      }
    });
    assert.equal(t.rows(), 0);
    await t.cleanup();
  });

  it("every state-changing POST of the rail needs an Origin exactly equal to an allowed host", async () => {
    const t = await ready();
    await withServer(t, async (port) => {
      const bodies: Record<string, unknown> = {
        verdict: { stop: "chg-1", status: "passed" },
        sendback: { note: "please" },
        submit: {},
      };
      const bad: Array<Record<string, string>> = [
        {},
        { origin: "null" },
        { origin: "http://evil.example" },
        { origin: `http://127.0.0.1:${port + 1}` },
        { origin: `HTTP://127.0.0.1:${port}` },
        { origin: `http://LOCALHOST:${port}` },
        { "sec-fetch-site": "cross-site" },
        { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "cross-site" },
      ];
      for (const [verb, body] of Object.entries(bodies)) {
        for (const headers of bad) {
          const r = await post(port, `/timeline/${t.taskId}/review/${verb}?t=${TOKEN}`, body, headers);
          assert.equal(r.status, 403, `${verb} ${JSON.stringify(headers)} -> ${r.status}`);
        }
        // Token and Host still refuse first.
        assert.equal((await post(port, `/timeline/${t.taskId}/review/${verb}?t=nope`, body, { origin: `http://127.0.0.1:${port}` })).status, 403);
        assert.equal((await post(port, `/timeline/${t.taskId}/review/${verb}?t=${TOKEN}`, body, { origin: `http://127.0.0.1:${port}`, host: "evil.example" })).status, 403);
        // An allowed Origin gets past the guard (the request itself may still be refused for its content).
        const ok = await post(port, `/timeline/${t.taskId}/review/${verb}?t=${TOKEN}`, body, { origin: `http://localhost:${port}` });
        assert.notEqual(ok.status, 403, `${verb}: ${ok.body.slice(0, 80)}`);
      }
      for (const headers of bad) {
        const r = await post(port, `/shutdown?t=${TOKEN}`, {}, headers);
        assert.equal(r.status, 403, `shutdown ${JSON.stringify(headers)}`);
      }
    });
    assert.equal(t.rows(), 0);
    await t.cleanup();
  });

  it("COCHECK_REVIEWER is not read", async () => {
    const t = await ready();
    const prior = process.env.COCHECK_REVIEWER;
    process.env.COCHECK_REVIEWER = "someone-else";
    try {
      assert.equal(defaultReviewer(), userInfo().username);
    } finally {
      if (prior === undefined) delete process.env.COCHECK_REVIEWER;
      else process.env.COCHECK_REVIEWER = prior;
    }
    assert.equal(t.rows(), 0);
    await t.cleanup();
  });

  it("a sign-off with no signature (an older ledger's) is left byte-identical, still closes its task, and reads as unverified", async () => {
    const t = await ready();
    const id = insertLegacySignoff(t.ledger, { taskId: t.taskId, signer: "Dana", rounds: 1 });
    const db = new DatabaseSync(path.join(t.home, "ledger.sqlite"));
    const before = JSON.stringify(db.prepare("SELECT * FROM signoffs").all());
    db.close();
    assert.equal(t.ledger.signoffsForTask(t.taskId)[0]!.signature, null);
    assert.equal(t.ledger.signoffsForTask(t.taskId)[0]!.id, id);
    assert.equal(signoffStatus(t.ledger, t.taskId).record?.signer, "Dana");
    const list = t.cli(["list", String(t.taskId)]);
    assert.match(list.stdout, /signed off by Dana \(unverified\)/);
    // Reading and reviewing still work; the row is untouched.
    const again = openLedger(t.home);
    assert.equal(again.signoffsForTask(t.taskId).length, 1);
    again.close();
    const db2 = new DatabaseSync(path.join(t.home, "ledger.sqlite"));
    assert.equal(JSON.stringify(db2.prepare("SELECT * FROM signoffs").all()), before);
    db2.close();
    await t.cleanup();
  });

  it("the test fixture is the only writer: it records a placeholder signature and the task closes", async () => {
    const t = await ready();
    const rec = await signOffForTest(t.ledger, t.taskId, "Dana");
    assert.equal(rec.signature, "test-fixture");
    assert.equal(t.rows(), 1);
    await t.cleanup();
  });
});
