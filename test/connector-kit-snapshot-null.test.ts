import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startConnector } from "../src/connector/runner.ts";
import { pathToFileURL } from "node:url";

// The kit's snapshot connectors answer null only when the item positively does not exist (a readable store without the item's file).
// A read they could not do (no store configured, a store folder that is not there, an unusable id, a read error) is a JSON-RPC error, never null:
// CoCheck records a null before plus a real after as "created", so a swallowed read failure would show "created" for an item that existed.
// Each case runs the real example connector through the runner CoCheck uses and calls snapshot.

const KIT = path.resolve(import.meta.dirname, "..", "public-kit", "examples");
const STATE = '{"notes":[{"id":"n1","text":"buy milk"}]}';

async function snapshotOf(example: string, subject: string, env: Record<string, string> = {}): Promise<{ state?: unknown; error?: string }> {
  // envNames [] so nothing of the test process's environment (COCHECK_TEST_STATES, TOY_VENDOR_STORE) reaches the child; `env` is all it sees.
  const handle = await startConnector({ dir: path.join(KIT, example), run: ["node", "connector.mjs"], id: `t471r2-${example}`, envNames: [], env });
  try {
    const answer = (await handle.call("snapshot", { subject }, { timeoutMs: 5000 })) as { subject: string; state: unknown };
    assert.equal(answer.subject, subject);
    return { state: answer.state };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    await handle.stop();
  }
}

const isError = (r: { state?: unknown; error?: string }, why: string) => {
  assert.ok(r.error !== undefined, `${why}: expected an error answer, got state ${JSON.stringify(r.state)}`);
  assert.match(r.error!, /answered with an error/);
};

describe("toy-vendor snapshot", () => {
  it("no store configured (neither COCHECK_TEST_STATES nor TOY_VENDOR_STORE): an error, not a null state", async () => {
    isError(await snapshotOf("toy-vendor", "toy-vendor://note/n1"), "no store");
  });
  it("a store folder that is not there: an error, not a null state", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "t471r2-"));
    isError(await snapshotOf("toy-vendor", "toy-vendor://note/n1", { TOY_VENDOR_STORE: path.join(root, "gone") }), "missing store");
  });
  it("an empty or path-like note id: an error, not a null state", async () => {
    const store = mkdtempSync(path.join(tmpdir(), "t471r2-"));
    isError(await snapshotOf("toy-vendor", "toy-vendor://note/", { TOY_VENDOR_STORE: store }), "empty id");
    isError(await snapshotOf("toy-vendor", "toy-vendor://note/sub%2Fn1", { TOY_VENDOR_STORE: store }), "id with a separator");
  });
  it("a note file that cannot be read (a folder where the file should be): an error, not a null state", async () => {
    const store = mkdtempSync(path.join(tmpdir(), "t471r2-"));
    mkdirSync(path.join(store, "n1.json"));
    isError(await snapshotOf("toy-vendor", "toy-vendor://note/n1", { TOY_VENDOR_STORE: store }), "unreadable item");
  });
  it("a missing note in a readable store stays null (a real create is still seen); a present note is its text", async () => {
    const store = mkdtempSync(path.join(tmpdir(), "t471r2-"));
    assert.deepEqual(await snapshotOf("toy-vendor", "toy-vendor://note/n1", { TOY_VENDOR_STORE: store }), { state: null });
    assert.deepEqual(await snapshotOf("toy-vendor", "toy-vendor://note/n1", { COCHECK_TEST_STATES: store }), { state: null });
    writeFileSync(path.join(store, "n1.json"), STATE);
    assert.deepEqual(await snapshotOf("toy-vendor", "toy-vendor://note/n1", { TOY_VENDOR_STORE: store }), { state: STATE });
  });
});

for (const toy of ["toy-level-1", "toy-level-3"]) {
  describe(`${toy} snapshot (the store is the folder holding the notes file)`, () => {
    const uri = (p: string) => pathToFileURL(p).href.replace(/^file:/, `${toy}:`);
    it("no file named (the subject is the root): an error, not a null state", async () => {
      isError(await snapshotOf(toy, `${toy}:///`), "no file");
    });
    it("a notes file under a folder that is not there: an error, not a null state", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "t471r2-"));
      isError(await snapshotOf(toy, uri(path.join(root, "gone", "notes.json"))), "missing store");
    });
    it("a notes path that cannot be read (a folder): an error, not a null state", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "t471r2-"));
      mkdirSync(path.join(root, "notes.json"));
      isError(await snapshotOf(toy, uri(path.join(root, "notes.json"))), "unreadable item");
    });
    it("a missing notes file in a readable folder stays null; a present one is its text", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "t471r2-"));
      const file = path.join(root, "notes.json");
      assert.deepEqual(await snapshotOf(toy, uri(file)), { state: null });
      writeFileSync(file, STATE);
      assert.deepEqual(await snapshotOf(toy, uri(file)), { state: STATE });
    });
  });
}
