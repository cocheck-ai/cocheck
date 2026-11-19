import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defaultTranscriptsRoot } from "../src/agent-transcripts.ts";

describe("defaultTranscriptsRoot under the test runner", () => {
  it("refuses to fall back to the real ~/.claude/projects when CLAUDE_CONFIG_DIR is unset", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      assert.throws(() => defaultTranscriptsRoot(), /CLAUDE_CONFIG_DIR/);
      process.env.CLAUDE_CONFIG_DIR = "";
      assert.throws(() => defaultTranscriptsRoot(), /CLAUDE_CONFIG_DIR/);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it("returns an explicit CLAUDE_CONFIG_DIR's projects folder", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = "/tmp/some-explicit-claude";
      assert.equal(defaultTranscriptsRoot(), path.join("/tmp/some-explicit-claude", "projects"));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it("the suite bootstrap pointed this run's config dir away from the real home", () => {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    assert.ok(dir && path.resolve(dir) !== path.join(homedir(), ".claude"), String(dir));
    assert.ok(!path.resolve(defaultTranscriptsRoot()).startsWith(path.join(homedir(), ".claude")));
  });

  it("the bootstrap overrides an explicit CLAUDE_CONFIG_DIR that is the real ~/.claude", () => {
    const run = (value: string) => spawnSync(process.execPath, ["--import", "./scripts/test-bootstrap.ts", "-e", "process.stdout.write(process.env.CLAUDE_CONFIG_DIR ?? '')"], { env: { ...process.env, CLAUDE_CONFIG_DIR: value }, encoding: "utf8" });
    const real = path.join(homedir(), ".claude");
    for (const v of [real, real + path.sep, path.join(real, "..", ".claude")]) {
      const out = run(v).stdout;
      assert.ok(out !== "" && path.resolve(out) !== real, `${v} -> ${out}`);
    }
    assert.equal(run("/tmp/some-explicit-claude").stdout, "/tmp/some-explicit-claude");
  });
});
