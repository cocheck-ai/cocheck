import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ci.yml trigger matrix. No YAML parser is a dependency, so the job-level `if:` lines are read by shape and the
// expression subset used there is evaluated directly.
// A Windows checkout may turn line ends into CRLF (core.autocrlf); the shapes below are read with LF.
const yml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function jobIf(job: string): string | undefined {
  const m = yml.match(new RegExp(`^  ${job}:\\n((?:    .*\\n|\\n)*)`, "m"));
  assert.ok(m, `job ${job} exists`);
  return m[1].match(/^    if: (.*)$/m)?.[1];
}

function runs(job: string, event: string, jobs: string | null, repo = "owner/private-repo"): boolean {
  const expr = jobIf(job);
  if (expr === undefined) return true; // no condition: always runs
  assert.match(expr, /^[\w.\s'=!&|()\/-]+$/, "expression stays in the subset this test evaluates");
  const js = expr.replace(/github\.event_name/g, "ev").replace(/inputs\.jobs/g, "jb").replace(/github\.repository/g, "rp");
  return Boolean(new Function("ev", "jb", "rp", `return (${js});`)(event, jobs, repo));
}

test("workflow_dispatch declares the jobs choice input, default all", () => {
  assert.match(yml, /workflow_dispatch:\n    inputs:\n      jobs:\n(?:        .*\n)*?        type: choice\n/);
  assert.match(yml, /options: \[all, ubuntu, windows, macos\]/);
  assert.match(yml, /default: all/);
});

test("push and pull_request: windows runs, macos and ubuntu never do (must not: windows skipped)", () => {
  for (const ev of ["push", "pull_request"]) {
    assert.equal(runs("windows", ev, null), true, `windows on ${ev}`);
    assert.equal(runs("macos", ev, null), false, `macos on ${ev}`);
    assert.equal(runs("ubuntu", ev, null), false, `ubuntu on ${ev}`);
  }
});

test("on push and pull_request macos runs in the public repository only", () => {
  for (const ev of ["push", "pull_request"]) assert.equal(runs("macos", ev, null, "cocheck-ai/cocheck"), true, `macos on ${ev} in the public repo`);
});

test("workflow_dispatch: each choice runs exactly the named job, all runs every job", () => {
  const all = ["ubuntu", "windows", "macos"];
  for (const choice of ["all", ...all]) {
    for (const job of all) {
      assert.equal(runs(job, "workflow_dispatch", choice), choice === "all" || choice === job, `${job} on dispatch jobs=${choice}`);
    }
  }
});

test("header comment says how to run one job", () => {
  assert.match(yml.split("\nname:")[0], /gh workflow run ci\.yml .*-f jobs=macos/);
});
