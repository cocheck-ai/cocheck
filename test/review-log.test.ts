import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openLedger } from "../src/ledger.ts";
import { ensureReviewProcess, readOrCreateToken, readPortFile } from "../src/review-server.ts";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups) await c();
});

describe("the review process's stderr", () => {
  it("lands in review.log under the data directory, not on the page", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-reviewlog-home-"));
    const ledger = openLedger(home);
    ledger.openTask("log-client");
    ledger.close();
    // The index does not cut a round; the trigger is the startup sweep: it takes a lock per task under <home>/locks, and with a
    // plain file in that place the sweep fails for task 1 and the process writes "cocheck: sweep skipped task 1" to its stderr.
    await writeFile(path.join(home, "locks"), "not a folder");
    let pid = 0;
    cleanups.push(async () => {
      if (pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); // Windows: the killed review process lets go of its ledger a moment after the kill
    });
    const port = await ensureReviewProcess(home);
    pid = readPortFile(home)!.pid;
    const res = await fetch(`http://127.0.0.1:${port}/?t=${readOrCreateToken(home)}`);
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.doesNotMatch(page, /sweep skipped|ENOTDIR|locks/);
    let log = "";
    for (let i = 0; i < 60 && !/sweep skipped task 1/.test(log); i++) {
      log = await readFile(path.join(home, "review.log"), "utf8").catch(() => "");
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(log, /cocheck: sweep skipped task 1/);
  });
});
