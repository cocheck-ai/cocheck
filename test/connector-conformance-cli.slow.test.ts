// The `cocheck connector test <dir>` command, end to end as a child process. The command does not exist yet (today the CLI
// prints its usage and exits 1), so each test is `todo` ("awaiting cocheck connector test"): it runs, reports failing, and passes once built.
// Uses a throwaway COCHECK_HOME; the command must not touch the real one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "cocheck.mjs");

function connectorTest(fixture: string) {
  const home = mkdtempSync(path.join(tmpdir(), "cocheck-conf-"));
  const res = spawnSync(process.execPath, [BIN, "connector", "test", path.join(ROOT, "public-kit", "conformance", "fixtures", fixture), "--cases"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, COCHECK_HOME: home, COCHECK_CONNECTOR_LIVE: "" },
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.ok(!/^usage:/m.test(out), `\`cocheck connector test\` is not a command yet (the CLI printed its usage):\n${out.slice(0, 200)}`);
  return { status: res.status, out };
}

test("cocheck connector test: the toy connector passes every case, exit 0", () => {
  const { status, out } = connectorTest("toy");
  assert.equal(status, 0, out);
  for (let i = 1; i <= 17; i++) if (![7, 8, 9, 15].includes(i)) assert.match(out, new RegExp(`\\bC${i}\\b`), `output reports C${i}`);
});

test("cocheck connector test: bad-c5-noisy exits non-zero and names C5", () => {
  const { status, out } = connectorTest("bad-c5-noisy");
  assert.notEqual(status, 0, out);
  assert.match(out, /C5\b.*fail|fail.*\bC5\b/i);
});

test("cocheck connector test: bad-c12-empty (a false clean) exits non-zero and names C12", () => {
  const { status, out } = connectorTest("bad-c12-empty");
  assert.notEqual(status, 0, out);
  assert.match(out, /C12\b.*fail|fail.*\bC12\b/i);
});

test("cocheck connector test: bad-silent-miss (a missed real edit) exits non-zero and names C6", () => {
  const { status, out } = connectorTest("bad-silent-miss");
  assert.notEqual(status, 0, out);
  assert.match(out, /C6\b.*fail|fail.*\bC6\b/i);
});
