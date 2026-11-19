// a full, clean, green `npm test` leaves a record keyed to HEAD's sha in the git dir; scripts/release.sh skips its 30-minute rerun when HEAD has one.
// The dangerous direction is a record for a commit that never passed in full: a dirty tree, a tier, a filter, any failure, or a HEAD that moved
// during the run must each write nothing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureGitState, writePassRecord, type PassInput } from "../scripts/lib/test-pass-record.ts";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
function repo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "cocheck-passrec-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}
const recordDir = (dir: string) => path.join(git(dir, "rev-parse", "--absolute-git-dir"), "cocheck-test-pass");
const records = (dir: string) => (existsSync(recordDir(dir)) ? readdirSync(recordDir(dir)) : []);
const good = (dir: string, over: Partial<PassInput> = {}): PassInput => ({
  root: dir,
  start: captureGitState(dir),
  tierArg: undefined,
  passThrough: [],
  counts: { tests: 10, pass: 10, fail: 0, cancelled: 0 },
  failedFiles: [],
  timedOutFiles: [],
  fileCount: 5,
  expectedFileCount: 5,
  now: new Date("2026-11-18T10:00:00Z"),
  ...over,
});

describe("the full-run pass record", () => {
  it("a full clean green run writes <git-dir>/cocheck-test-pass/<HEAD sha> with the date and pass count", () => {
    const dir = repo();
    const result = writePassRecord(good(dir));
    assert.ok("path" in result, JSON.stringify(result));
    const sha = git(dir, "rev-parse", "HEAD");
    assert.equal(result.path, path.join(recordDir(dir), sha));
    assert.deepEqual(records(dir), [sha]);
    const text = readFileSync(result.path, "utf8");
    assert.match(text, /2026-11-18T10:00:00/);
    assert.match(text, /pass 10/);
  });

  it("in a linked worktree the record lands in that worktree's git dir, keyed to that worktree's HEAD", () => {
    const dir = repo();
    const wt = path.join(dir, "..", `wt-${path.basename(dir)}`);
    git(dir, "worktree", "add", "-q", "-b", "side", wt);
    writeFileSync(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "two");
    const result = writePassRecord(good(wt));
    assert.ok("path" in result, JSON.stringify(result));
    assert.deepEqual(records(wt), [git(wt, "rev-parse", "HEAD")]);
    assert.deepEqual(records(dir), []);
  });

  const refusals: Array<[string, (dir: string) => Partial<PassInput> | undefined]> = [
    ["a tier run", () => ({ tierArg: "--tier=fast" })],
    ["a run with an explicit --tier=all", () => ({ tierArg: "--tier=all" })],
    ["a file filter", () => ({ passThrough: ["test/a.test.ts"] })],
    ["a node test flag", () => ({ passThrough: ["--test-name-pattern=x"] })],
    ["a failing test", () => ({ counts: { tests: 10, pass: 9, fail: 1, cancelled: 0 } })],
    ["a cancelled test", () => ({ counts: { tests: 10, pass: 9, fail: 0, cancelled: 1 } })],
    ["a failing file", () => ({ failedFiles: ["test/a.test.ts"] })],
    ["a timed-out file", () => ({ timedOutFiles: ["test/a.test.ts"] })],
    ["fewer files than the full set", () => ({ fileCount: 4 })],
    ["no passing test", () => ({ counts: { tests: 0, pass: 0, fail: 0, cancelled: 0 } })],
    ["no git state at the start", () => ({ start: undefined })],
  ];
  for (const [label, over] of refusals) {
    it(`${label} writes nothing`, () => {
      const dir = repo();
      const result = writePassRecord(good(dir, over(dir)));
      assert.ok("reason" in result, JSON.stringify(result));
      assert.deepEqual(records(dir), []);
    });
  }

  it("a tree dirty at the start writes nothing, even if cleaned before the end", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    const start = captureGitState(dir);
    git(dir, "checkout", "--", "a.txt");
    const result = writePassRecord(good(dir, { start }));
    assert.ok("reason" in result, JSON.stringify(result));
    assert.deepEqual(records(dir), []);
  });

  it("a tree dirty at the end (a tracked edit, or an untracked file) writes nothing", () => {
    for (const make of [(d: string) => writeFileSync(path.join(d, "a.txt"), "x\n"), (d: string) => writeFileSync(path.join(d, "new.txt"), "x\n")]) {
      const dir = repo();
      const input = good(dir);
      make(dir);
      const result = writePassRecord(input);
      assert.ok("reason" in result, JSON.stringify(result));
      assert.deepEqual(records(dir), []);
    }
  });

  it("a HEAD that moved during the run writes nothing (neither the old nor the new sha)", () => {
    const dir = repo();
    const input = good(dir);
    writeFileSync(path.join(dir, "b.txt"), "b\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "two");
    const result = writePassRecord(input);
    assert.ok("reason" in result, JSON.stringify(result));
    assert.deepEqual(records(dir), []);
  });

  it("scripts/run-tests.ts hands the record the tier argument, the pass-through arguments and the full file count", () => {
    const src = readFileSync(path.join(import.meta.dirname, "..", "scripts", "run-tests.ts"), "utf8");
    const call = /writePassRecord\(\{[\s\S]*?\}\)/.exec(src)?.[0] ?? "";
    for (const part of ["tierArg", "passThrough", "failedFiles", "timedOutFiles", "expectedFileCount: tiers.all.length", "start: startState"]) assert.ok(call.includes(part), `run-tests.ts's writePassRecord call lacks ${part}`);
    assert.ok(src.indexOf("captureGitState") < src.indexOf("runFiles(files"), "the start state must be captured before the files run");
  });
});
