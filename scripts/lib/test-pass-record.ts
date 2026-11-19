// The full-run pass record. A full `npm test` (no tier, no filter) that ends with nothing failed, on a clean tree, writes
// `<git dir>/cocheck-test-pass/<HEAD sha>`; scripts/release.sh skips its own suite run when HEAD has one. Anything less writes nothing:
// a record for a commit that never passed in full would ship untested code. The git dir is `git rev-parse --absolute-git-dir`, the same
// call release.sh makes, so a linked worktree keeps its own records.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface GitState {
  head: string;
  clean: boolean;
  gitDir: string;
}

const git = (root: string, args: string[]): string | undefined => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout : undefined;
};

/** HEAD sha, whether `git status --porcelain` (untracked files included) is empty, and the git dir; undefined when git cannot say. */
export function captureGitState(root: string): GitState | undefined {
  const head = git(root, ["rev-parse", "HEAD"])?.trim();
  const status = git(root, ["status", "--porcelain"]);
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"])?.trim();
  if (!head || status === undefined || !gitDir) return undefined;
  return { head, clean: status.trim() === "", gitDir };
}

export interface PassInput {
  root: string;
  /** The state captured before the files ran. */
  start: GitState | undefined;
  tierArg: string | undefined;
  passThrough: string[];
  counts: Record<string, number>;
  failedFiles: string[];
  timedOutFiles: string[];
  fileCount: number;
  /** The size of the full file set (the `all` tier). */
  expectedFileCount: number;
  now?: Date;
}

export function writePassRecord(input: PassInput): { path: string } | { reason: string } {
  const { counts } = input;
  if (input.tierArg !== undefined) return { reason: "a tier was given" };
  if (input.passThrough.length > 0) return { reason: "arguments were passed to the runner (a filter or a node test flag)" };
  if (input.failedFiles.length > 0 || input.timedOutFiles.length > 0) return { reason: "a file failed or timed out" };
  if ((counts.fail ?? 0) > 0 || (counts.cancelled ?? 0) > 0) return { reason: "a test failed or was cancelled" };
  if ((counts.pass ?? 0) <= 0) return { reason: "no test passed" };
  if (input.fileCount !== input.expectedFileCount || input.fileCount <= 0) return { reason: "not every test file ran" };
  if (!input.start) return { reason: "git state was not readable at the start" };
  if (!input.start.clean) return { reason: "the tree was dirty at the start" };
  const end = captureGitState(input.root);
  if (!end) return { reason: "git state was not readable at the end" };
  if (!end.clean) return { reason: "the tree was dirty at the end" };
  if (end.head !== input.start.head || end.gitDir !== input.start.gitDir) return { reason: "HEAD moved during the run" };
  const dir = path.join(end.gitDir, "cocheck-test-pass");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, end.head);
  writeFileSync(file, `${(input.now ?? new Date()).toISOString()} pass ${counts.pass}\n`);
  return { path: file };
}
