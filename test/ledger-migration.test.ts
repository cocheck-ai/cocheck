import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openLedger, SCHEMA_VERSION } from "../src/ledger.ts";

/** A home whose ledger holds only a schema_version row of `version`. */
async function seededHome(version: number): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-version-test-"));
  const seed = new DatabaseSync(path.join(home, "ledger.sqlite"));
  seed.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (${version});`);
  seed.close();
  return home;
}

function tableNames(home: string): string[] {
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    db.close();
  }
}

describe("ledger schema version", () => {
  it("starts at the current version and a new home records exactly that version", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-version-test-"));
    openLedger(home).close();
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    assert.deepEqual((db.prepare("SELECT version FROM schema_version").all() as Array<{ version: number }>).map((r) => r.version), [SCHEMA_VERSION]);
    db.close();
    await rm(home, { recursive: true, force: true });
  });

  it("reopens a home of its own version", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-version-test-"));
    openLedger(home).close();
    openLedger(home).close();
    await rm(home, { recursive: true, force: true });
  });

  for (const version of [0, 1, 2, 5, SCHEMA_VERSION - 1, SCHEMA_VERSION + 1, 19, 99]) {
    it(`refuses a ledger of version ${version} with a clear message and does not touch it`, async () => {
      const home = await seededHome(version);
      assert.throws(
        () => openLedger(home),
        (e: Error) => e.message.includes(`schema version ${version}`) && /does not migrate/.test(e.message) && e.message.includes(path.join(home, "ledger.sqlite")),
      );
      assert.deepEqual(tableNames(home), ["schema_version"], "no table was created or altered");
      await rm(home, { recursive: true, force: true });
    });
  }
});
