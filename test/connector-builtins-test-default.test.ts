// Tests get no built-in connectors unless a test asks. The test bootstrap (scripts/test-bootstrap.ts) sets COCHECK_TEST_NO_BUILTIN_CONNECTORS=1,
// which child processes inherit; a test opts in with setBuiltinConnectorsForTest (this process) or by dropping the variable from a child's env.
// With the variable unset (production) the production list is registered as before.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import * as builtins from "../src/connector/builtins.ts";

const MODULE = path.join(import.meta.dirname, "..", "src", "connector", "builtins.ts");
const PRODUCTION_IDS = ["microsoft-excel", "microsoft-word", "microsoft-powerpoint"];

/** The built-in ids a fresh child process (no bootstrap preload) registers under `env`. */
function childIds(env: NodeJS.ProcessEnv): string[] {
  const code = `const m = await import(${JSON.stringify(pathToFileURL(MODULE).href)}); console.log(JSON.stringify(m.builtinConnectorList().map((b) => b.id)));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" })) as string[];
}

afterEach(() => builtins.setBuiltinConnectorsForTest(undefined));

describe("tests get no built-in connectors unless a test asks", () => {
  it("the bootstrap sets the variable, and this process registers no built-in", () => {
    assert.equal(process.env.COCHECK_TEST_NO_BUILTIN_CONNECTORS, "1");
    assert.deepEqual(builtins.builtinConnectorList(), []);
    assert.deepEqual(builtins.readBuiltinManifests(), []);
    assert.deepEqual(builtins.builtinClaims(), []);
  });

  it("a child process inherits it and registers no built-in", () => {
    assert.deepEqual(childIds(process.env), []);
  });

  it("production: with the variable unset the production list is registered, unchanged", () => {
    const env = { ...process.env };
    delete env.COCHECK_TEST_NO_BUILTIN_CONNECTORS;
    assert.deepEqual(childIds(env), PRODUCTION_IDS);
  });

  it("a test asks: setBuiltinConnectorsForTest with the production list registers it in this process", () => {
    assert.deepEqual(builtins.PRODUCTION_BUILTIN_CONNECTORS.map((b) => b.id), PRODUCTION_IDS);
    builtins.setBuiltinConnectorsForTest(builtins.PRODUCTION_BUILTIN_CONNECTORS);
    assert.deepEqual(builtins.builtinConnectorList().map((b) => b.id), PRODUCTION_IDS);
    builtins.setBuiltinConnectorsForTest(undefined);
    assert.deepEqual(builtins.builtinConnectorList(), []);
  });
});
