// `cocheck connector test <dir>` through runConnectorTest. Must not happen: a broken connector reported as passed (false clean) versus a
// correct one failed on its own states. Tests named "guarded case" cover both.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorTest } from "../src/connector-test-cli.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.join(ROOT, "public-kit/conformance/fixtures");
const BROKEN = path.join(ROOT, "test/fixtures/connectors/broken");
const STATES = path.join(ROOT, "public-kit/toy-product/states");

test("must not: the toy connector passes on its own states, exit 0", async () => {
  const r = await runConnectorTest([path.join(KIT, "toy")]);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^passed$/m);
});

test("the toy-python connector passes", async (t) => {
  const r = await runConnectorTest([path.join(KIT, "toy-python")]);
  if (/does not answer|no valid answer|ENOENT/.test(r.stdout) && r.exitCode !== 0) return t.skip("python3 not available");
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
});

test("must not: bad-silent-miss (drops edits) fails with its message and a spec anchor", async () => {
  const r = await runConnectorTest([path.join(KIT, "bad-silent-miss")]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /changes: expected a change marked "changed" for the edit pair, found an empty list of changes\. Report a change with mark "changed"/);
  assert.match(r.stdout, /see spec #diff-answer/);
  assert.match(r.stdout, /^\d+ problems?$/m);
  assert.doesNotMatch(r.stdout, /^passed$/m);
});

test("a B fixture (empty diff on a malformed state) fails and points at #errors", async () => {
  const r = await runConnectorTest([path.join(BROKEN, "empty-diff-on-malformed")]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /expected an error for a malformed state, found an empty list of changes/);
  assert.match(r.stdout, /see spec #errors/);
});

test("a leaked token fails and points at #credentials", async () => {
  const r = await runConnectorTest([path.join(BROKEN, "leaked-token")]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /see spec #credentials/);
});

test("must not: a 50%-flaky connector fails the same-answer check (five runs)", async () => {
  const r = await runConnectorTest([path.join(BROKEN, "flaky-p6")]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /level 1 checks to hold on the .* pair, found a second run of the same pair gave a different document/);
  assert.doesNotMatch(r.stdout, /^passed$/m);
});

test("a missing manifest fails with #manifest", async () => {
  const r = await runConnectorTest([path.join(BROKEN, "no-manifest")]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /see spec #manifest/);
});

test("must not: a missing --states dir exits 1 with a message, never a pass", async () => {
  const r = await runConnectorTest([path.join(KIT, "toy"), "--states", path.join(tmpdir(), "no-such-states-dir")]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /states folder .* does not exist/);
  assert.doesNotMatch(r.stdout + r.stderr, /passed/);
});

test("must not: a states dir with a missing pair fails, never a pass", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "states-"));
  try {
    cpSync(STATES, dir, { recursive: true });
    rmSync(path.join(dir, "delete.after.json"));
    const r = await runConnectorTest([path.join(KIT, "toy"), "--states", dir]);
    assert.equal(r.exitCode, 1, r.stdout);
    assert.match(r.stdout, /delete: expected delete\.before\.json and delete\.after\.json, found a missing state file/);
    assert.doesNotMatch(r.stdout, /^passed$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty states dir fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "empty-"));
  try {
    const r = await runConnectorTest([path.join(KIT, "toy"), "--states", dir]);
    assert.equal(r.exitCode, 1);
    assert.doesNotMatch(r.stdout, /^passed$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry-diff connector with no samples is untested and exits 1; a manifest-and-hello pass alone does not count", async () => {
  const r = await runConnectorTest([path.join(ROOT, "test/fixtures/connectors/entry-diff")]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /not exercised/);
  assert.doesNotMatch(r.stdout, /^passed$/m);
  assert.match(r.stdout, /^untested$/m);
});

test("bad arguments exit 1 with usage", async () => {
  for (const args of [[], ["x", "--timeout", "abc"], ["x", "--bogus"]]) {
    const r = await runConnectorTest(args);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /usage: cocheck connector test/);
  }
});
