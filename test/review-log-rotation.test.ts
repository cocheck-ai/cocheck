import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { appendReviewLog, installReviewLogWriter } from "../src/review-server.ts";

const CAP = 2048;

describe("review.log rotation during a process's life", () => {
  it("rotates when appends pass the cap, without a restart", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-rotate-home-"));
    try {
      const log = path.join(home, "review.log");
      const line = "x".repeat(99) + "\n";
      for (let i = 0; i < (CAP / line.length) * 3; i++) {
        appendReviewLog(home, line, CAP);
      }
      assert.ok(existsSync(`${log}.1`), "review.log.1 exists");
      assert.ok(statSync(log).size < 2 * CAP, "review.log is under 2x the cap");
      assert.ok(statSync(`${log}.1`).size < 2 * CAP, "review.log.1 is under 2x the cap");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("routes a stream's writes through the size-checked append", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-rotate-stream-"));
    try {
      const stream = { write: (() => true) as (chunk: string | Uint8Array) => boolean };
      installReviewLogWriter(stream, home, CAP);
      const line = "y".repeat(99) + "\n";
      for (let i = 0; i < (CAP / line.length) * 3; i++) {
        stream.write(line);
      }
      const log = path.join(home, "review.log");
      assert.ok(existsSync(`${log}.1`), "review.log.1 exists");
      assert.ok(statSync(log).size < 2 * CAP, "review.log is under 2x the cap");
      assert.match(await readFile(log, "utf8"), /^y+\n/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
