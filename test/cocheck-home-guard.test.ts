import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCoCheckHome } from "../src/ledger.ts";

describe("resolveCoCheckHome under the test runner", () => {
  it("refuses to fall back to the default ~/.cocheck when COCHECK_HOME is unset", () => {
    const saved = process.env.COCHECK_HOME;
    try {
      delete process.env.COCHECK_HOME;
      assert.throws(() => resolveCoCheckHome(), /COCHECK_HOME/);
      process.env.COCHECK_HOME = "";
      assert.throws(() => resolveCoCheckHome(), /COCHECK_HOME/);
    } finally {
      if (saved === undefined) delete process.env.COCHECK_HOME;
      else process.env.COCHECK_HOME = saved;
    }
  });

  it("returns an explicit COCHECK_HOME unchanged", () => {
    const saved = process.env.COCHECK_HOME;
    try {
      process.env.COCHECK_HOME = "/tmp/some-explicit-home";
      assert.equal(resolveCoCheckHome(), "/tmp/some-explicit-home");
    } finally {
      if (saved === undefined) delete process.env.COCHECK_HOME;
      else process.env.COCHECK_HOME = saved;
    }
  });

  it("the suite bootstrap gave this run a temp COCHECK_HOME", () => {
    assert.ok(process.env.COCHECK_HOME && !process.env.COCHECK_HOME.endsWith(".cocheck"), String(process.env.COCHECK_HOME));
  });
});
