import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { acquireFileLock } from "../src/file-lock.ts";
import { STATE_LOCK_OPTIONS } from "../src/hook-adapter.ts";

// The per-folder state lock is held for the whole hook. A hook past staleMs is still alive, so its lock must be refreshed, not taken over.
describe("the per-folder state lock", () => {
  it("heartbeats well inside staleMs", () => {
    assert.ok(typeof STATE_LOCK_OPTIONS.heartbeatMs === "number");
    assert.ok(STATE_LOCK_OPTIONS.heartbeatMs * 2 <= STATE_LOCK_OPTIONS.staleMs);
  });

  it("is not taken from a live, heartbeating holder after staleMs (same ratios, scaled down)", async () => {
    const scale = 300 / STATE_LOCK_OPTIONS.staleMs;
    const options = { ...STATE_LOCK_OPTIONS, staleMs: 300, heartbeatMs: Math.max(10, STATE_LOCK_OPTIONS.heartbeatMs * scale), timeoutMs: 1000, pollMs: 10 };
    const lock = path.join(await mkdtemp(path.join(tmpdir(), "cocheck-state-lock-")), "state.lock");
    const release = await acquireFileLock(lock, options);
    await assert.rejects(acquireFileLock(lock, options), /EXCEL_LOCK_TIMEOUT/);
    await release();
    await (await acquireFileLock(lock, options))();
  });
});
