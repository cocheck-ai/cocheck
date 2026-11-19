// `cocheck connector test` on an entry-"diff" connector sends real `diffs` requests, one per sample the connector's author ships in
// samples/samples.json, with COCHECK_TEST_SAMPLES naming that folder. A false pass is the costly side: a broken diff connector that reads `passed`
// loses its users' changes without a sign. So a sample not run, a class missing or an answer the grader cannot read is untested or failed, never
// passed. The opposite risk is pinned too: a sound connector does not fail on a sample class the standard does not require.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorTest } from "../src/connector-test-cli.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(ROOT, "public-kit/examples/toy-tracker");

const MANIFEST = { spec: "cocheck.connector/1", id: "diffs-under-test", version: "0.0.1", entry: "diff", matches: { mcpServers: ["things"], subjects: { mcp__things__update_thing: "things://thing/{thing_id}" } }, run: ["node", "connector.mjs"], credentials: [], platforms: ["darwin", "win32", "linux"] };
const W = (since: string, until: string) => ({ since, until });
const CHANGED = { class: "changed", params: { subject: "things://thing/t1", ...W("2026-11-07T14:00:00.000Z", "2026-11-07T14:00:09.000Z") } };
const NO_CHANGE = { class: "no-change", params: { subject: "things://thing/t1", ...W("2026-11-07T15:00:00.000Z", "2026-11-07T15:00:09.000Z") } };
const FAILED = { class: "failed-read", params: { subject: "things://thing/locked", ...W("2026-11-07T14:00:00.000Z", "2026-11-07T14:00:09.000Z") } };
const ALL = [CHANGED, NO_CHANGE, FAILED];

/** A sound answer for each sample, from the samples folder the test names: a change for t1 in the 14:00 window, none in the 15:00 window, an error for "locked". */
const SOUND = `
function answer(p) {
  if (!process.env.COCHECK_TEST_SAMPLES) throw new Error("no history: COCHECK_TEST_SAMPLES is not set");
  if (p.subject.endsWith("/locked")) throw new Error("no access to this thing");
  if (p.since.startsWith("2026-11-07T14")) return { spec: "cocheck.changes/1", changes: [{ id: "state", mark: "changed", label: "Status", before: "Todo", after: "Done" }] };
  return { spec: "cocheck.changes/1", changes: [] };
}`;

function connector(answerSrc: string, samples: unknown, opts: { level?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-diffs-samples-"));
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify(MANIFEST));
  const hello = { spec: "cocheck.connector/1", methods: ["diffs"], ...(opts.level === false ? {} : { level: 1 }) };
  writeFileSync(path.join(dir, "connector.mjs"), `import readline from "node:readline";
${answerSrc}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  let reply;
  try {
    if (msg.method === "hello") reply = { result: ${JSON.stringify(hello)} };
    else if (msg.method === "diffs") reply = { result: answer(msg.params) };
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) { reply = { error: { code: "bad-product-response", message: String(err.message) } }; }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\\n");
});
`);
  if (samples !== undefined) {
    mkdirSync(path.join(dir, "samples"));
    writeFileSync(path.join(dir, "samples", "samples.json"), JSON.stringify(samples));
  }
  return dir;
}

const lastLine = (s: string): string => s.trimEnd().split("\n").pop()!;

test("must not: a good hello and a broken diffs answer fails (it passed on manifest and hello alone before)", async () => {
  const dir = connector(`function answer() { return { changes: "not a list" }; }`, { samples: ALL });
  const r = await runConnectorTest([dir]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.notEqual(lastLine(r.stdout), "passed", r.stdout);
  assert.doesNotMatch(r.stdout, /not exercised/);
});

test("must not: a connector that errors on every diffs request fails", async () => {
  const dir = connector(`function answer() { throw new Error("down"); }`, { samples: ALL });
  const r = await runConnectorTest([dir]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /changed/);
  assert.notEqual(lastLine(r.stdout), "passed", r.stdout);
});

for (const [label, value] of [["null", "null"], ["an empty document", "{}"], ["a nothing-changed document", '{ spec: "cocheck.changes/1", changes: [] }']] as const) {
  test(`must not: answering ${label} for the failed-read sample fails`, async () => {
    const src = SOUND.replace('throw new Error("no access to this thing")', `return ${value}`);
    const r = await runConnectorTest([connector(src, { samples: ALL })]);
    assert.equal(r.exitCode, 1, r.stdout);
    assert.match(r.stdout, /failed-read/);
    assert.match(r.stdout, /expected an error/);
    assert.notEqual(lastLine(r.stdout), "passed", r.stdout);
  });
}

test("must not: no samples at all is untested, exit 1, and says what was not tested", async () => {
  const r = await runConnectorTest([connector(SOUND, undefined)]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /^untested: /m);
  for (const c of ["changed", "no-change", "failed-read"]) assert.match(r.stdout, new RegExp(`untested: .*"${c}"`), c);
  assert.equal(lastLine(r.stdout), "untested");
});

test("must not: an empty samples list is untested, exit 1", async () => {
  const r = await runConnectorTest([connector(SOUND, { samples: [] })]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.equal(lastLine(r.stdout), "untested");
});

for (const missing of ["changed", "no-change", "failed-read"]) {
  test(`must not: samples with no "${missing}" sample are untested, exit 1, naming the class`, async () => {
    const r = await runConnectorTest([connector(SOUND, { samples: ALL.filter((s) => s.class !== missing) })]);
    assert.equal(r.exitCode, 1, r.stdout);
    assert.match(r.stdout, new RegExp(`^untested: .*"${missing}"`, "m"));
    for (const c of ["changed", "no-change", "failed-read"].filter((c) => c !== missing)) assert.doesNotMatch(r.stdout, new RegExp(`untested: .*"${c}"`), c);
    assert.equal(lastLine(r.stdout), "untested");
  });
}

test("must not: a changed sample answered with no change fails, and a no-change sample answered with a change fails", async () => {
  const none = await runConnectorTest([connector(SOUND.replace('p.since.startsWith("2026-11-07T14")', "false"), { samples: ALL })]);
  assert.equal(none.exitCode, 1, none.stdout);
  assert.match(none.stdout, /at least one change/);
  const some = await runConnectorTest([connector(SOUND.replace('p.since.startsWith("2026-11-07T14")', "true"), { samples: ALL })]);
  assert.equal(some.exitCode, 1, some.stdout);
  assert.match(some.stdout, /no change/);
});

test("must not: an answer that differs between the 5 runs fails", async () => {
  const src = SOUND.replace('after: "Done" }', 'after: "Done " + (++globalThis.n || (globalThis.n = 1)) }');
  const r = await runConnectorTest([connector(src, { samples: ALL })]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /the same answer on every one of 5 runs/);
});

test("must not: a document above the level hello declares fails", async () => {
  const src = SOUND.replace('changes: [{ id: "state"', 'pictures: [{ id: "p", kind: "text", before: "a", after: "b" }], changes: [{ id: "state"');
  const r = await runConnectorTest([connector(src, { samples: ALL })]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /expected a change document valid at level 1 or below, found .*pictures/);
});

test("must not: a samples file that cannot be read, or a sample with a bad class or params, is not a pass", async () => {
  const dir = connector(SOUND, undefined);
  mkdirSync(path.join(dir, "samples"));
  writeFileSync(path.join(dir, "samples", "samples.json"), "{ not json");
  const bad = await runConnectorTest([dir]);
  assert.equal(bad.exitCode, 1, bad.stdout);
  assert.notEqual(lastLine(bad.stdout), "passed", bad.stdout);
  const noParams = await runConnectorTest([connector(SOUND, { samples: [...ALL, { class: "changed", params: { subject: "things://thing/t1", since: "yesterday" } }] })]);
  assert.equal(noParams.exitCode, 1, noParams.stdout);
  assert.match(noParams.stdout, /samples\.json samples\[3\]/);
});

test("a sound connector passes, the connector was told where its samples are, and the output says once that the live product was not contacted", async () => {
  const r = await runConnectorTest([connector(SOUND, { samples: ALL })]);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(lastLine(r.stdout), "passed");
  assert.equal(r.stdout.match(/recorded history/g)?.length, 1, r.stdout);
  assert.equal(r.stdout.match(/live product was not contacted/g)?.length, 1, r.stdout);
});

test("opposite risk: an extra sample of a class the standard does not require is graded but does not fail a sound connector", async () => {
  const extra = { class: "moved", params: { subject: "things://thing/t1", ...W("2026-11-07T16:00:00.000Z", "2026-11-07T16:00:09.000Z") } };
  const r = await runConnectorTest([connector(SOUND, { samples: [...ALL, CHANGED, extra] })]);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(lastLine(r.stdout), "passed");
});

test("a connector answering the older shape is refused with a message naming the shape", async () => {
  const src = SOUND.replace('{ spec: "cocheck.changes/1", changes: [{ id: "state", mark: "changed", label: "Status", before: "Todo", after: "Done" }] }', '{ changes: [{ kind: "edit", anchors: [{ entity: "state" }], confidence: "exact", before: { type: "text", value: "Todo" }, after: { type: "text", value: "Done" } }], caveats: [] }').replace('return { spec: "cocheck.changes/1", changes: [] }', "return { changes: [], caveats: [] }");
  const r = await runConnectorTest([connector(src, { samples: ALL }, { level: false })]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /spec: expected "cocheck\.changes\/1"/);
});

test("the kit example diff-entry connector passes `connector test` on its own samples", async () => {
  const r = await runConnectorTest([EXAMPLE]);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.equal(lastLine(r.stdout), "passed");
  assert.match(r.stdout, /live product was not contacted/);
});
