import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCorpus } from "./hook-corpus.ts";

// the recorded sessions replay into a ledger equal to the golden copy written by the earlier code.
// Ids are kept (a reordered or dropped op shows); timestamps, wall-clock durations and temp paths are scrubbed.
const golden = (host: string) => readFile(path.join(import.meta.dirname, "fixtures", "hook-goldens", `golden-${host}.json`), "utf8").then((t) => JSON.parse(t));

describe("corpus replay equals the pre-change golden ledger", () => {
  for (const host of ["claude", "codex"] as const) {
    it(`${host}: every op the old code wrote is written identically`, { timeout: 120_000 }, async () => {
      const want = await golden(host);
      // there is no cell-level credit: no round diff, so the round records no review row;
      // the steps and file states (who is credited) are the record and stay byte-identical.
      assert.ok(want.ops.length >= 4 && want.file_states.length >= 1 && want.review_rows.length === 0, "the golden is not empty");
      assert.deepEqual(await runCorpus(host), want);
    });
    it(`${host}: a second replay gives the same ledger`, { timeout: 120_000 }, async () => {
      assert.deepEqual(await runCorpus(host), await runCorpus(host));
    });
  }
});
