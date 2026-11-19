// A Python connector for the toy product passes the conformance cases offline, same answer as the Node toy.
// Must not happen: a skip that hides a failure. The test skips only when no python3/python is on PATH (reason printed); with Python present it runs and fails on any failed case.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES = path.join(ROOT, "public-kit", "conformance", "cases");
const FIXTURES = path.join(ROOT, "public-kit", "conformance", "fixtures");
const PY = path.join(FIXTURES, "toy-python");
// C9 and C15 are retired (precision ladder, attribution keys).
const IDS = Array.from({ length: 17 }, (_, i) => `C${i + 1}`).filter((id) => !["C7", "C8", "C9", "C15"].includes(id));

/** The skip rule: undefined means "run the test"; a string is the only allowed reason to skip. */
export function pythonSkipReason(pathEnv: string, sep: string = path.delimiter): string | undefined {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dirName of pathEnv.split(sep).filter((d) => d !== "")) {
    for (const name of ["python3", "python"]) for (const e of exts) if (existsSync(path.join(dirName, name + e))) return undefined;
  }
  return "no python3 or python on PATH";
}

const reason = pythonSkipReason(process.env.PATH ?? "");
if (reason !== undefined) console.log(`# SKIP polyglot runner test: ${reason}`);

test("polyglot: the Python fixture is a standard-library-only connector under public-kit", () => {
  const src = readFileSync(path.join(PY, "connector.py"), "utf8");
  const stdlib = new Set(["json", "re", "sys"]);
  for (const m of src.matchAll(/^(?:import|from)\s+([A-Za-z0-9_]+)/gm)) assert.ok(stdlib.has(m[1]!), `non-stdlib import ${m[1]}`);
  assert.deepEqual(JSON.parse(readFileSync(path.join(PY, "cocheck-connector.json"), "utf8")).run, ["python3", "connector.py"]);
});

// The existing C16 test allows one golden.json across all fixtures, so the Python fixture carries none; parity with the toy's golden is checked here.
test("polyglot: the Python answer hashes to the toy's golden for every toy state pair (same product, same answer, whatever the language)", { skip: reason }, async () => {
  const { startConnector } = await import("../src/connector/runner.ts");
  const { hashOf } = await import("../src/connector/conformance.ts");
  const golden = JSON.parse(readFileSync(path.join(FIXTURES, "toy", "golden.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(golden).sort(), ["create", "delete", "edit", "no-change"]);
  const h = await startConnector({ dir: PY, run: ["python3", "connector.py"], id: `toy-python#parity-${process.pid}`, helloTimeoutMs: 5000 });
  try {
    for (const [key, want] of Object.entries(golden)) {
      const state = (side: string) => path.join(ROOT, "public-kit", "toy-product", "states", `${key}.${side}.json`);
      assert.equal(hashOf(await h.call("diff", { before: state("before"), after: state("after") }, { timeoutMs: 15000 })), want, key);
    }
  } finally {
    await h.stop();
  }
});

test("polyglot skip rule: Python on PATH never skips; only an empty PATH does, with a reason", () => {
  const withPython = mkdtempSync(path.join(tmpdir(), "py-on-path-"));
  writeFileSync(path.join(withPython, process.platform === "win32" ? "python.exe" : "python3"), "");
  assert.equal(pythonSkipReason(withPython), undefined, "Python present must not skip");
  const withOnlyPython = mkdtempSync(path.join(tmpdir(), "py-only-"));
  writeFileSync(path.join(withOnlyPython, process.platform === "win32" ? "python.exe" : "python"), "");
  assert.equal(pythonSkipReason(withOnlyPython), undefined, "`python` alone must not skip");
  const empty = mkdtempSync(path.join(tmpdir(), "no-py-"));
  assert.match(pythonSkipReason(empty) ?? "", /no python3 or python on PATH/);
  assert.match(pythonSkipReason("") ?? "", /no python3 or python/);
  assert.notEqual(pythonSkipReason(`${empty}${path.delimiter}${withPython}`), "no python3 or python on PATH", "any PATH entry with Python counts");
});

test("polyglot: the Python connector passes C1-C17", { skip: reason }, async () => {
  const { runCases } = (await import("../src/connector/conformance.ts")) as { runCases: (o: { dir: string; casesDir: string }) => Promise<Array<{ id: string; pass: boolean; reason?: string }>> };
  const results = await runCases({ dir: PY, casesDir: CASES });
  assert.deepEqual(results.map((r) => r.id), IDS);
  assert.deepEqual(results.filter((r) => !r.pass), []);
});
