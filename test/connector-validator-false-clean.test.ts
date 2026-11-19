// The validator never passes a run it could not do, and its messages carry no absolute path or runner id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConnector } from "../src/connector/validate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOY = path.join(ROOT, "public-kit/conformance/fixtures/toy");
const STATES = path.join(ROOT, "public-kit/toy-product/states");
const NAMES = ["create", "edit", "delete", "no-change", "malformed"];

function statesWithout(skip: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "states-"));
  for (const n of NAMES) for (const side of ["before", "after"]) {
    const f = `${n}.${side}.json`;
    if (!skip.includes(f)) copyFileSync(path.join(STATES, f), path.join(dir, f));
  }
  return dir;
}
function noAbsolute(problems: { field: string; found: string }[], dirs: string[]): void {
  for (const p of problems) for (const t of [p.field, p.found]) {
    assert.doesNotMatch(t, /validate:/, t);
    for (const d of dirs) assert.ok(!t.includes(d), `absolute path in "${t}"`);
    assert.doesNotMatch(t, /(^|[\s"'])(\/|[A-Za-z]:\\)[\w.-]+[\/\\]/, t);
  }
}

test("must not: a states folder missing one pair file is never a clean connector", async () => {
  const dir = statesWithout(["edit.after.json"]);
  const r = await validateConnector({ dir: TOY, statesDir: dir, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  const missing = r.problems.filter((p) => p.field === "states");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].file, "edit.after.json");
  assert.match(missing[0].fix, /edit\.after\.json/);
  assert.ok(/^[^.!?]*(\.[\w-]+)*[^.!?]*\.$/.test(missing[0].fix), missing[0].fix);
  noAbsolute(r.problems, [dir, TOY]);
});

test("must not: a states folder that does not exist reports all five pairs and is not clean", async () => {
  const dir = path.join(os.tmpdir(), "no-such-states-folder");
  const r = await validateConnector({ dir: TOY, statesDir: dir, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.problems.filter((p) => p.field === "states").length, 5);
  noAbsolute(r.problems, [dir, TOY]);
});

test("the default toy states still pass the toy connector", async () => {
  const r = await validateConnector({ dir: TOY, timeoutMs: 3000 });
  assert.deepEqual(r.problems, []);
});

test("a hello timeout reads 'no answer to hello within <n> ms' with no runner id or path", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hello-"));
  cpSync(path.join(ROOT, "test/fixtures/connectors/broken/hang/cocheck-connector.json"), path.join(dir, "cocheck-connector.json"));
  writeFileSync(path.join(dir, "connector.mjs"), "setInterval(() => {}, 1000);\n");
  const r = await validateConnector({ dir, timeoutMs: 400 });
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.field === "hello");
  assert.ok(p, JSON.stringify(r.problems));
  assert.equal(p.found, "no answer to hello within 400 ms");
  noAbsolute(r.problems, [dir]);
});
