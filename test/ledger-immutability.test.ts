import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openLedger, SCHEMA_VERSION } from "../src/ledger.ts";

describe("ledger", () => {
  let home: string;

  before(async () => {
    home = await mkdtemp(path.join(tmpdir(), "cocheck-ledger-test-"));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("rejects UPDATE and DELETE on tasks, ops, and events via triggers", () => {
    const ledger = openLedger(home);
    const opId = ledger.recordOp({
      tool: "cocheck_echo_write",
      args: { text: "x" },
      intent: "seed a row to mutate",
      clientName: "test",
      clientVersion: "0.0.0",
      durationMs: 1,
      resultCode: "OK",
    });

    const db = new DatabaseSync(path.join(home, "ledger.sqlite"));

    assert.throws(() => {
      db.prepare("UPDATE ops SET result_code = 'TAMPERED' WHERE id = ?").run(opId);
    }, /append-only/);
    assert.throws(() => {
      db.prepare("DELETE FROM ops WHERE id = ?").run(opId);
    }, /append-only/);

    db.prepare("INSERT INTO tasks (created_at, title, client) VALUES (?, ?, ?)").run(
      new Date().toISOString(),
      "seed task",
      "test",
    );
    const task = db.prepare("SELECT id FROM tasks LIMIT 1").get() as { id: number };
    assert.throws(() => {
      db.prepare("UPDATE tasks SET title = 'tampered' WHERE id = ?").run(task.id);
    }, /append-only/);
    assert.throws(() => {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    }, /append-only/);

    db.prepare("INSERT INTO events (ts, op_id, kind, payload_json) VALUES (?, ?, ?, ?)").run(
      new Date().toISOString(),
      opId,
      "seed",
      "{}",
    );
    const event = db.prepare("SELECT id FROM events LIMIT 1").get() as { id: number };
    assert.throws(() => {
      db.prepare("UPDATE events SET kind = 'tampered' WHERE id = ?").run(event.id);
    }, /append-only/);
    assert.throws(() => {
      db.prepare("DELETE FROM events WHERE id = ?").run(event.id);
    }, /append-only/);

    db.close();
    ledger.close();
  });

  it("rejects INSERT OR REPLACE / REPLACE INTO against an existing primary key on tasks, ops, and events", async () => {
    const replaceHome = await mkdtemp(path.join(tmpdir(), "cocheck-replace-test-"));
    const ledger = openLedger(replaceHome);

    ledger.execForTest(
      `INSERT INTO tasks (id, created_at, title, client) VALUES (1, '2020-01-01T00:00:00.000Z', 'original', 'test')`,
    );
    assert.throws(() => {
      ledger.execForTest(
        `INSERT OR REPLACE INTO tasks (id, created_at, title, client) VALUES (1, '2020-01-01T00:00:00.000Z', 'tampered', 'test')`,
      );
    }, /append-only/);

    const opId = ledger.recordOp({
      tool: "cocheck_echo_write",
      args: { text: "x" },
      intent: "seed an op row to replace-attack",
      clientName: "test",
      clientVersion: "0.0.0",
      durationMs: 1,
      resultCode: "OK",
    });
    assert.throws(() => {
      ledger.execForTest(
        `REPLACE INTO ops
          (id, task_id, ts, tool, args_json, intent, client_name, client_version, duration_ms, result_code, error_text)
         VALUES (${opId}, NULL, '2020-01-01T00:00:00.000Z', 'tampered', '{}', 'tampered', NULL, NULL, 1, 'TAMPERED', NULL)`,
      );
    }, /append-only/);

    ledger.execForTest(
      `INSERT INTO events (id, ts, op_id, kind, payload_json) VALUES (1, '2020-01-01T00:00:00.000Z', ${opId}, 'seed', '{}')`,
    );
    assert.throws(() => {
      ledger.execForTest(
        `INSERT OR REPLACE INTO events (id, ts, op_id, kind, payload_json) VALUES (1, '2020-01-01T00:00:00.000Z', ${opId}, 'tampered', '{}')`,
      );
    }, /append-only/);

    ledger.close();
    await rm(replaceHome, { recursive: true, force: true });
  });

  it("rejects INSERT ... ON CONFLICT(<pk>) DO UPDATE (upsert) against an existing primary key on tasks, ops, and events, leaving the original row unchanged", async () => {
    const upsertHome = await mkdtemp(path.join(tmpdir(), "cocheck-upsert-test-"));
    const ledger = openLedger(upsertHome);
    const db = new DatabaseSync(path.join(upsertHome, "ledger.sqlite"));

    ledger.execForTest(
      `INSERT INTO tasks (id, created_at, title, client) VALUES (1, '2020-01-01T00:00:00.000Z', 'original', 'test')`,
    );
    assert.throws(() => {
      ledger.execForTest(
        `INSERT INTO tasks (id, created_at, title, client) VALUES (1, '2020-01-01T00:00:00.000Z', 'tampered', 'test')
         ON CONFLICT(id) DO UPDATE SET title = 'tampered'`,
      );
    }, /append-only/);
    const task = db.prepare("SELECT * FROM tasks WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(task.title, "original");

    const opId = ledger.recordOp({
      tool: "cocheck_echo_write",
      args: { text: "x" },
      intent: "seed an op row to upsert-attack",
      clientName: "test",
      clientVersion: "0.0.0",
      durationMs: 1,
      resultCode: "OK",
    });
    assert.throws(() => {
      ledger.execForTest(
        `INSERT INTO ops
          (id, task_id, ts, tool, args_json, intent, client_name, client_version, duration_ms, result_code, error_text)
         VALUES (${opId}, NULL, '2020-01-01T00:00:00.000Z', 'tampered', '{}', 'tampered', NULL, NULL, 1, 'TAMPERED', NULL)
         ON CONFLICT(id) DO UPDATE SET result_code = 'TAMPERED'`,
      );
    }, /append-only/);
    const opRow = db.prepare("SELECT * FROM ops WHERE id = ?").get(opId) as Record<
      string,
      unknown
    >;
    assert.equal(opRow.result_code, "OK");
    assert.equal(opRow.tool, "cocheck_echo_write");

    ledger.execForTest(
      `INSERT INTO events (id, ts, op_id, kind, payload_json) VALUES (1, '2020-01-01T00:00:00.000Z', ${opId}, 'seed', '{}')`,
    );
    assert.throws(() => {
      ledger.execForTest(
        `INSERT INTO events (id, ts, op_id, kind, payload_json) VALUES (1, '2020-01-01T00:00:00.000Z', ${opId}, 'tampered', '{}')
         ON CONFLICT(id) DO UPDATE SET kind = 'tampered'`,
      );
    }, /append-only/);
    const event = db.prepare("SELECT * FROM events WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    assert.equal(event.kind, "seed");

    db.close();
    ledger.close();
    await rm(upsertHome, { recursive: true, force: true });
  });

  it("respects COCHECK_HOME for the ledger location", async () => {
    const customHome = await mkdtemp(path.join(tmpdir(), "cocheck-custom-home-"));
    const ledger = openLedger(customHome);
    ledger.close();
    const db = new DatabaseSync(path.join(customHome, "ledger.sqlite"));
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as {
      version: number;
    };
    assert.equal(row.version, SCHEMA_VERSION);
    db.close();
    await rm(customHome, { recursive: true, force: true });
  });
});
