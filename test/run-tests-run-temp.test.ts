// `npm test` (scripts/run-tests.ts) gives every test file one per-run temp folder as TMPDIR (TEMP and TMP for Windows) and removes it when the
// run ends, so a file that never cleans up, or one ended at its time limit before its after hooks ran, leaves nothing in the OS temp folder.
// About 128,000 leftovers had piled up in a dev Mac's temp folder before this.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

const LEAKY = `import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("leaves a folder in its temp folder", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "leaky-"));
  writeFileSync(path.join(process.env.T_REPORT, "leaky.json"), JSON.stringify({ tmp: tmpdir(), dir }));
});
`;
const HANGS = `import { test, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "hangs-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(path.join(process.env.T_REPORT, "hangs.json"), JSON.stringify({ tmp: tmpdir(), dir }));
test("never ends, so its after hook never runs", () => new Promise(() => setInterval(() => {}, 1000)));
`;

test("every test file gets the run's own temp folder, removed at the end with what a leaky or timed-out file left in it", { timeout: 90_000 }, async () => {
  const report = mkdtempSync(path.join(tmpdir(), "cocheck-run-temp-report-"));
  try {
    writeFileSync(path.join(report, "leaky.test.mjs"), LEAKY);
    writeFileSync(path.join(report, "hangs.test.mjs"), HANGS);
    // A nested run: the outer run's suite lock is held already, and the limit is short. NODE_TEST_CONTEXT would make the nested run skip files.
    const env: NodeJS.ProcessEnv = { ...process.env, T_REPORT: report, COCHECK_TEST_FILE_TIMEOUT_MS: "4000", COCHECK_SUITE_LOCK_HELD: "1" };
    delete env.NODE_TEST_CONTEXT;
    const runner = spawn(process.execPath, [path.join(ROOT, "scripts", "run-tests.ts"), path.join(report, "leaky.test.mjs"), path.join(report, "hangs.test.mjs")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    runner.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    runner.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const status = await new Promise<number | "hung">((resolve) => {
      const t = setTimeout(() => {
        runner.kill("SIGKILL");
        runner.stdout.destroy();
        runner.stderr.destroy();
        resolve("hung");
      }, 60_000);
      runner.on("close", (code) => {
        clearTimeout(t);
        resolve(code ?? -1);
      });
    });
    assert.notEqual(status, "hung", out);
    assert.match(out, /ℹ files_timed_out 1/, out);
    const leaky = JSON.parse(readFileSync(path.join(report, "leaky.json"), "utf8")) as { tmp: string; dir: string };
    const hangs = JSON.parse(readFileSync(path.join(report, "hangs.json"), "utf8")) as { tmp: string; dir: string };
    assert.notEqual(path.resolve(leaky.tmp), path.resolve(tmpdir()), "the file's temp folder is the run's own, not the OS one");
    assert.equal(leaky.tmp, hangs.tmp, "both files share the run's temp folder");
    assert.equal(path.dirname(path.resolve(leaky.tmp)), path.resolve(tmpdir()), "the run's folder sits in the OS temp folder");
    assert.equal(existsSync(leaky.dir), false, "the leaky file's folder is gone");
    assert.equal(existsSync(hangs.dir), false, "the timed-out file's folder is gone");
    assert.equal(existsSync(leaky.tmp), false, "the run's temp folder is gone");
    assert.match(out, /ℹ run_temp_left \d+ /, out);
  } finally {
    rmSync(report, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
