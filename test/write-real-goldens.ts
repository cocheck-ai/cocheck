// One-shot writer for the real-recording goldens (test/fixtures/hook-goldens/golden-real-*.json), the ledger dumps that
// test/hook-real-recordings-replay.test.ts compares against. Run it only to capture today's output on purpose:
//   node --import ./scripts/test-bootstrap.ts test/write-real-goldens.ts
// A later change that must leave the ledgers as they are runs it again into a scratch copy and diffs the files; the test itself never writes.
import { writeFileSync } from "node:fs";
import { goldenPath, RECORDINGS, replayRecording } from "./hook-real-recordings.ts";

// Names on the command line capture only those goldens; with none, every golden is rewritten.
const only = process.argv.slice(2);
for (const rec of RECORDINGS.filter((r) => only.length === 0 || only.includes(r.name))) {
  const { dump, events } = await replayRecording(rec);
  writeFileSync(goldenPath(rec), `${JSON.stringify(dump, null, 1)}\n`);
  console.log(`${rec.name}: ${events} events, ${dump.ops!.length} ops, ${dump.file_states!.length} file states, ${dump.steps!.length} steps`);
}
