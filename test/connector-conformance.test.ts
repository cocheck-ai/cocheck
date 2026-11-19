// The conformance cases C1-C17 as data (public-kit/conformance/cases/*.json), run by a future
// `cocheck connector test <dir>`. Tests that only validate the case files, the fixtures and the fixture connectors pass today.
// The runner tests call runCases from src/connector/conformance.ts in process.
// Checks P1-P6 are named in the case data and implemented in src/connector/conformance.ts (test/lib/diff-props.ts keeps its own, over the rail types).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES = path.join(ROOT, "public-kit", "conformance", "cases");
const FIXTURES = path.join(ROOT, "public-kit", "conformance", "fixtures");
const CONFORMANCE = "../src/connector/conformance.ts";
// C9 (precision), C15 (attribution keys), C7 (locators resolve) and C8 (payload types) belong to the older answer shape and are retired.
const RETIRED = ["C7", "C8", "C9", "C15"];
const IDS = Array.from({ length: 17 }, (_, i) => `C${i + 1}`).filter((id) => !RETIRED.includes(id));

interface Case {
  id: string;
  title: string;
  fixture: string;
  inputs: unknown;
  expect: Record<string, unknown>;
  failingFixtures?: string[];
  dangerous?: string;
}
const load = (id: string): Case => JSON.parse(readFileSync(path.join(CASES, `${id}.json`), "utf8"));
const all = () => IDS.map(load);
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Drive a fixture connector over stdio like the runner will: one JSON line in, one out. */
function callDiff(fixture: string, before: string, after: string) {
  const input = JSON.stringify({ id: 1, method: "diff", params: { before, after } }) + "\n";
  const res = spawnSync(process.execPath, [path.join(FIXTURES, fixture, "connector.mjs")], { cwd: ROOT, input, encoding: "utf8", timeout: 15000 });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split("\n")[0]) as { result?: { spec?: string; changes: unknown[] }; error?: { code: string } };
}
const states = (n: string) => ["before", "after"].map((s) => path.join("public-kit", "toy-product", "states", `${n}.${s}.json`)) as [string, string];

test("cases: exactly C1..C17 less the retired C7, C8, C9 and C15, one file each, ids and titles present", () => {
  assert.deepEqual(readdirSync(CASES).sort(), IDS.map((i) => `${i}.json`).sort());
  for (const c of all()) {
    assert.ok(IDS.includes(c.id), c.id);
    assert.ok(c.title && c.fixture && c.expect, `${c.id} needs title, fixture and expect`);
    assert.ok(existsSync(path.join(CASES, `${c.id}.json`)));
  }
});

test("cases: every case names an existing fixture whose manifest uses an argv array and no shebang", () => {
  for (const c of all()) {
    const dir = path.join(FIXTURES, c.fixture);
    const manifest = readJson(path.join(dir, "cocheck-connector.json"));
    assert.ok(Array.isArray(manifest.run) && manifest.run.length > 0 && manifest.run.every((a: unknown) => typeof a === "string"), `${c.id}: run must be an argv array`);
    assert.ok(!manifest.run[0].includes(" "), "argv[0] is one program, not a shell line");
    assert.ok(existsSync(path.join(dir, manifest.run[1])), "the script the argv names exists");
    assert.ok(!readFileSync(path.join(dir, manifest.run[1]), "utf8").startsWith("#!"), "no shebang reliance");
  }
});

test("cases: input state files exist; no case names a retired check", () => {
  for (const c of all()) {
    const pairs = Array.isArray(c.inputs) ? c.inputs : [c.inputs];
    for (const p of pairs as Array<Record<string, string> | null>) {
      if (!p || "generate" in p) continue;
      for (const f of [p.before, p.after]) assert.ok(existsSync(path.join(ROOT, f)), `${c.id}: missing ${f}`);
    }
    assert.deepEqual(JSON.stringify(c).match(/\bP\d+\b/g) ?? [], [], `${c.id} names a retired check`);
  }
});

test("cases: guarded case C5 and C12 each name a failing fixture that exists", () => {
  for (const id of ["C5", "C12"]) {
    const c = load(id);
    assert.ok(c.dangerous && c.failingFixtures && c.failingFixtures.length > 0, `${id} needs a failing fixture`);
    for (const f of c.failingFixtures) assert.ok(existsSync(path.join(FIXTURES, f, "cocheck-connector.json")), `${id}: missing ${f}`);
  }
});

test("C5/C12 failing fixtures really misbehave, the toy does not (false clean is caught in the data, not assumed)", () => {
  const same = states("no-change");
  assert.equal(callDiff("toy", ...same).result?.changes.length, 0);
  assert.ok((callDiff("bad-c5-noisy", ...same).result?.changes.length ?? 0) > 0, "bad-c5-noisy must report changes for identical states");
  const bad = states("malformed");
  assert.equal(callDiff("toy", ...bad).error?.code, "bad-product-response");
  const empty = callDiff("bad-c12-empty", ...bad);
  assert.ok(!empty.error && empty.result?.changes.length === 0, "bad-c12-empty answers a clean empty diff on a malformed product response");
  assert.equal(callDiff("toy", ...states("edit")).result?.changes.length, 1, "the toy still sees a real edit");
});

type Pair = { name: string; before: string; after: string; expectChanges: Array<{ kind: string; entity: string }> };
const asPairs = (c: Case) => (Array.isArray(c.inputs) ? (c.inputs as Pair[]) : []);
const MARK: Record<string, string> = { create: "added", edit: "changed", delete: "removed" };
const seen = (r: { result?: { changes: unknown[] } }) =>
  ((r.result?.changes ?? []) as Array<{ mark: string; id: string }>).map((x) => `${x.mark}:${x.id}`).sort();
const want = (p: Pair) => p.expectChanges.map((x) => `${MARK[x.kind]}:${x.entity}`).sort();

test("C3 and C6 declare exact non-empty expected changes per pair in the case data (edit, create, delete)", () => {
  for (const id of ["C3", "C6"]) {
    const pairs = asPairs(load(id));
    assert.deepEqual(pairs.map((p) => p.name), ["edit", "create", "delete"], id);
    for (const p of pairs) assert.ok(p.expectChanges.length > 0 && p.expectChanges.every((x) => x.kind && x.entity), `${id} ${p.name}: expectChanges must be non-empty`);
  }
});

test("the toy's real output matches every case's declared expected changes (proven over stdio, not assumed)", () => {
  for (const id of ["C3", "C6"]) for (const p of asPairs(load(id))) assert.deepEqual(seen(callDiff("toy", p.before, p.after)), want(p), `${id} ${p.name}`);
});

test("C6 must not: bad-silent-miss really drops the real edit, so the declared expectation catches it", () => {
  const c = load("C6");
  assert.deepEqual(c.failingFixtures, ["bad-silent-miss"]);
  const edit = asPairs(c).find((p) => p.name === "edit")!;
  assert.deepEqual(seen(callDiff("bad-silent-miss", edit.before, edit.after)), [], "it misses the edit");
  assert.notDeepEqual(seen(callDiff("bad-silent-miss", edit.before, edit.after)), want(edit), "a vacuous empty diff does not satisfy the expectation");
  for (const p of asPairs(c).filter((q) => q.name !== "edit")) assert.deepEqual(seen(callDiff("bad-silent-miss", p.before, p.after)), want(p), `${p.name} still fine, so only the edit is missed`);
});

test("every conformance fixture answers cocheck.changes/1 and declares level 1 in hello", () => {
  for (const f of ["toy", "bad-c5-noisy", "bad-leaky", "bad-silent-miss"]) assert.equal(callDiff(f, ...states("edit")).result?.spec, "cocheck.changes/1", f);
  const src = readFileSync(path.join(FIXTURES, "toy-python", "connector.py"), "utf8");
  assert.match(src, /cocheck\.changes\/1/);
  assert.doesNotMatch(src, /"anchors"/);
});

test("C13: the generator in public-kit writes the large pair and the toy diffs it to the declared change count", () => {
  const g = (load("C13").inputs as { generate: { script: string; args: string[]; writes: string[]; expectChanges: number } }).generate;
  const out = mkdtempSync(path.join(tmpdir(), "c13-"));
  try {
    const res = spawnSync(process.execPath, [path.join(ROOT, g.script), g.args[0], out], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    for (const f of g.writes) assert.ok(existsSync(path.join(out, f)), f);
    assert.equal(callDiff("toy", path.join(out, g.writes[0]), path.join(out, g.writes[1])).result?.changes.length, g.expectChanges);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("C16: one shared golden per fixture, no per-OS golden, and the toy's canonical hash equals it", async () => {
  const dir = path.join(FIXTURES, "toy");
  const golden = readJson(path.join(dir, "golden.json")) as Record<string, string>;
  for (const key of Object.keys(golden)) assert.ok(!/darwin|win32|linux|macos|windows/i.test(key), `per-OS golden key ${key}`);
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
  assert.deepEqual(walk(FIXTURES).filter((n) => /golden/i.test(n)), ["golden.json"], "exactly one golden file, not one per OS");
  const { hashOf } = (await import(pathToFileURL(path.join(dir, "canonical.mjs")).href)) as { hashOf: (v: unknown) => string };
  for (const [pair, hash] of Object.entries(golden)) {
    assert.equal(hashOf(callDiff("toy", ...states(pair)).result), hash, `toy ${pair} drifted from the golden`);
  }
  assert.ok(golden[load("C16").expect.goldenKey as string], "C16 names a golden key that exists");
});

test("live tier: documented behind COCHECK_CONNECTOR_LIVE=1 and never set in CI", () => {
  const readme = readFileSync(path.join(ROOT, "public-kit", "conformance", "README.md"), "utf8");
  assert.match(readme, /COCHECK_CONNECTOR_LIVE=1/);
  assert.match(readme, /never runs in CI/);
  const wfDir = path.join(ROOT, ".github", "workflows");
  for (const f of existsSync(wfDir) ? readdirSync(wfDir) : []) assert.ok(!readFileSync(path.join(wfDir, f), "utf8").includes("COCHECK_CONNECTOR_LIVE"), `${f} must not set the live flag`);
});

// ---- the in-process case runner ----
interface CaseResult { id: string; pass: boolean; reason?: string }
async function runCases(dir: string): Promise<CaseResult[]> {
  const mod = (await import(CONFORMANCE)) as { runCases?: (o: { dir: string; casesDir: string }) => Promise<CaseResult[]> };
  assert.equal(typeof mod.runCases, "function", "src/connector/conformance.ts must export runCases");
  return mod.runCases!({ dir, casesDir: CASES });
}

test("runner: the toy connector passes every case", async () => {
  const results = await runCases(path.join(FIXTURES, "toy"));
  assert.deepEqual(results.map((r) => r.id), IDS);
  assert.deepEqual(results.filter((r) => !r.pass), []);
});

test("runner: a C13 run leaves no folder in the OS temp folder (cocheck connector test runs on users' machines)", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "c13-leak-check-"));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = temp;
  try {
    assert.equal(tmpdir(), temp);
    const results = await runCases(path.join(FIXTURES, "toy"));
    assert.equal(results.find((r) => r.id === "C13")?.pass, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  try {
    assert.deepEqual(readdirSync(temp).filter((n) => n.startsWith("c13-")), [], "the large pair's folder is removed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runner: bad-c5-noisy fails C5 (identical states must give zero changes)", async () => {
  const failed = (await runCases(path.join(FIXTURES, "bad-c5-noisy"))).filter((r) => !r.pass).map((r) => r.id);
  assert.ok(failed.includes("C5"), `expected C5 to fail, failed: ${failed.join(",")}`);
});

test("runner: bad-silent-miss fails C6 (a silently dropped real edit is a false clean)", async () => {
  const failed = (await runCases(path.join(FIXTURES, "bad-silent-miss"))).filter((r) => !r.pass).map((r) => r.id);
  assert.ok(failed.includes("C6"), `expected C6 to fail, failed: ${failed.join(",")}`);
});

test("runner: bad-c12-empty fails C12 (a malformed product response must not give an empty diff)", async () => {
  const failed = (await runCases(path.join(FIXTURES, "bad-c12-empty"))).filter((r) => !r.pass).map((r) => r.id);
  assert.ok(failed.includes("C12"), `expected C12 to fail, failed: ${failed.join(",")}`);
});

// C14 reads the entry from the manifest and requires the method production calls (state or both -> diff, diff -> diffs).
function c14Connector(entry: string, methods: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "c14-"));
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "c14-probe", version: "0.0.1", entry, matches: { extensions: [".x"] }, run: ["node", "connector.mjs"], credentials: [], platforms: ["darwin", "win32"] }));
  writeFileSync(path.join(dir, "connector.mjs"), `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l);
  const r = m.method === "hello" ? { result: { spec: "cocheck.connector/1", methods: ${JSON.stringify(methods)}, payloads: ["text"] } } : { error: { code: "unknown-method", message: String(m.method) } };
  process.stdout.write(JSON.stringify({ id: m.id, ...r }) + "\\n"); });
`);
  return dir;
}
const c14 = async (dir: string) => (await runCases(dir)).find((r) => r.id === "C14") ?? assert.fail("no C14 result");

test("C14: an entry-diff connector naming diffs passes (it is not asked for a state method)", async () => {
  const r = await c14(c14Connector("diff", ["diffs"]));
  assert.equal(r.pass, true, r.reason ?? "");
});

test("C14: a connector naming neither diff nor diffs fails", async () => {
  const r = await c14(c14Connector("diff", ["snapshot"]));
  assert.equal(r.pass, false);
});

test("C14 must not: entry diff naming only diff (not diffs) fails, and entry state naming only state fails (a method production never calls)", async () => {
  assert.equal((await c14(c14Connector("diff", ["diff"]))).pass, false);
  assert.equal((await c14(c14Connector("state", ["state"]))).pass, false);
  assert.equal((await c14(c14Connector("both", ["state", "diffs"]))).pass, false);
});

// One process answers A, B, A exactly as fresh processes answer A and B. Must not happen: a connector that keeps state from
// one diff to the next shows the wrong change on the wrong file; bad-leaky diffs each after state against the last one it read.
test("C17: the toy answers A, B, A in one process byte for byte as fresh processes do", async () => {
  const r = (await runCases(path.join(FIXTURES, "toy"))).find((x) => x.id === "C17") ?? assert.fail("no C17 result");
  assert.equal(r.pass, true, r.reason ?? "");
});

test("C17 must not: a connector whose state leaks between diffs fails C17, naming the answer that differs", async () => {
  assert.deepEqual(load("C17").failingFixtures, ["bad-leaky"]);
  const r = (await runCases(path.join(FIXTURES, "bad-leaky"))).find((x) => x.id === "C17") ?? assert.fail("no C17 result");
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /answer 2 of A, B, A asked of one process differs from a fresh process's answer to B/);
});

test("`cocheck connector test` (states mode) fails a connector whose state leaks only across different pairs, and passes the toy", async () => {
  const { runConnectorTest } = await import("../src/connector-test-cli.ts");
  // The toy, plus a caveat naming the last different pair it was asked: the same pair asked again answers the same (P6 holds), so only A, B, A shows the leak.
  const dir = mkdtempSync(path.join(tmpdir(), "leaky-"));
  writeFileSync(path.join(dir, "cocheck-connector.json"), readFileSync(path.join(FIXTURES, "toy", "cocheck-connector.json")));
  const src = readFileSync(path.join(FIXTURES, "toy", "connector.mjs"), "utf8");
  const leaky = src
    .replace("function diff(before, after) {", "let prev, cur;\nfunction diff(before, after) {\n  if (after !== cur) { prev = cur; cur = after; }")
    .replace("return { spec: \"cocheck.changes/1\", changes };", "return { spec: \"cocheck.changes/1\", changes, caveats: prev === undefined ? [] : [`asked before about ${prev.split(/[\\\\/]/).pop()}`] };");
  assert.notEqual(leaky, src);
  assert.ok(leaky.includes("asked before about"));
  writeFileSync(path.join(dir, "connector.mjs"), leaky);
  const bad = await runConnectorTest([dir]);
  assert.equal(bad.exitCode, 1, bad.stdout);
  assert.match(bad.stdout, /answer 2 of A, B, A asked of one process differs/);
  const good = await runConnectorTest([path.join(FIXTURES, "toy")]);
  assert.doesNotMatch(good.stdout, /A, B, A/);
});
