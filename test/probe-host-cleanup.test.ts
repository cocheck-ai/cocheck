import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// Runs the probe test file with TMPDIR pointed at a private dir, then checks it left no cocheck-probe-test-* dir behind.
describe("probe-host tests clean up", () => {
  it("no cocheck-probe-test-* dir remains after test/probe-host-scratch-hygiene.test.ts runs", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "h006-cleanup-"));
    try {
      const file = path.resolve(import.meta.dirname, "probe-host-scratch-hygiene.test.ts");
      const boot = path.resolve(import.meta.dirname, "../scripts/test-bootstrap.ts");
      // NODE_TEST_CONTEXT makes a nested --test run a no-op; drop it so the inner file really runs.
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(boot).href, "--test", "--test-reporter=spec", "--test-concurrency=1", file], {
        env,
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000));
      assert.ok(Number(/ℹ pass (\d+)/.exec(r.stdout)?.[1] ?? 0) >= 10, "inner run did not execute the tests");
      assert.deepEqual((await readdir(tmp)).filter((n) => n.startsWith("cocheck-probe-test-")), []);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
