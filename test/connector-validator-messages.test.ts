// Acceptance test written before the build: what `cocheck connector validate <dir>` must say about the broken
// connectors a first contributor actually hits.
//
// Expected interface (src/connector/validate.ts, not built yet):
//   validateConnector({ dir, statesDir?, timeoutMs? }) -> Promise<{ ok: boolean, problems: Problem[] }>
//   Problem = { file, field, expected, found, fix }
//   - file: path relative to `dir` ("cocheck-connector.json" for a manifest problem, the script named by `run` for a
//     problem in what the connector answered, or "." when the folder has no manifest).
//   - field: JSON path inside the manifest or inside the diff answer ("changes[0].anchors[0].entity").
//   - fix: ONE sentence the contributor can act on. No internal names (see BANNED below).
//   The validator runs the connector over stdio on the toy pairs in public-kit/toy-product/states (create, edit, delete,
//   no-change, malformed) unless `statesDir` says otherwise, with `timeoutMs` (default 10000) per request.
//
// Two layers:
//   1. Fixture-proof tests (run today, must pass): each broken fixture really misbehaves when run over stdio.
//   2. Validator tests (node:test `todo` until the build): each fails today because src/connector/validate.ts does not
//      exist. Set T360_STRICT=1 to run them as real tests (red-first evidence, and the switch to flip at build time).
//
// Must not happen: the empty-diff-on-malformed fixture must be REJECTED (a false clean is the worst outcome),
// and the good toy connector must be ACCEPTED (over-rejecting a valid connector). Tests "Must not happen: ..." below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKEN = path.join(ROOT, "test/fixtures/connectors/broken");
const TOY = path.join(ROOT, "public-kit/conformance/fixtures/toy");
const STATES = path.join(ROOT, "public-kit/toy-product/states");
const state = (name: string) => path.join(STATES, name);

const TODO = false;

// Internal names that must never appear in any validator message.
// Needles are built from parts so this file carries none of the banned words itself.
const BANNED = [new RegExp("Tom" + "as", "i"), new RegExp("vau" + "lt", "i"), new RegExp("1-pro" + "jects"), /\bT-\d+/, new RegExp("dri" + "ve \\d+", "i"), new RegExp("\\bqu" + "eue\\b", "i"), new RegExp("correc" + "tor", "i"), new RegExp("dangerous" + " direction", "i"), /LayerDiffRow/, /FormatRow/, /RailChange/];
const TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";

// ---- stdio helper -----------------------------------------------------------------------------------------------

type Reply = { id: number; result?: any; error?: { code: string; message: string } };

// Sends hello then diff, waits for each answer up to `timeoutMs`, always kills the child. `raw` keeps all stdout.
async function runOverStdio(dir: string, before: string, after: string, timeoutMs = 3000) {
  const child = spawn("node", ["connector.mjs"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let raw = "";
  let buf = "";
  const waiting = new Map<number, (r: Reply | null) => void>();
  child.stdout.on("data", (d) => {
    raw += d;
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const r = JSON.parse(line) as Reply;
        waiting.get(r.id)?.(r);
      } catch { /* ignore non-JSON */ }
    }
  });
  child.stderr.resume();
  const ask = (id: number, method: string, params?: unknown) =>
    new Promise<Reply | null>((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    const hello = await ask(1, "hello");
    const diff = await ask(2, "diff", { before, after });
    return { hello, diff, raw };
  } finally {
    child.kill();
  }
}

// ---- 1. fixture-proof tests (run today) -------------------------------------------------------------------------

test("fixture no-manifest: the folder has a script and no cocheck-connector.json", () => {
  const dir = path.join(BROKEN, "no-manifest");
  assert.ok(existsSync(path.join(dir, "connector.mjs")));
  assert.ok(!existsSync(path.join(dir, "cocheck-connector.json")));
});

test("fixture leaked-token: the answer prints a credential-shaped token", async () => {
  const { raw } = await runOverStdio(path.join(BROKEN, "leaked-token"), state("edit.before.json"), state("edit.after.json"));
  assert.ok(raw.includes(TOKEN));
});

test("fixture empty-diff-on-malformed: a malformed state gets an empty diff, not an error", async () => {
  const { diff } = await runOverStdio(path.join(BROKEN, "empty-diff-on-malformed"), state("malformed.before.json"), state("malformed.after.json"));
  assert.equal(diff!.error, undefined);
  assert.deepEqual(diff!.result.changes, []);
});

test("fixture hang: hello is answered and a diff request is never answered", async () => {
  const { hello, diff } = await runOverStdio(path.join(BROKEN, "hang"), state("edit.before.json"), state("edit.after.json"), 800);
  assert.ok(hello?.result);
  assert.equal(diff, null);
});

test("good-connector guard fixture: the toy connector answers an edit with one exact edit change and no-change with none", async () => {
  const e = await runOverStdio(TOY, state("edit.before.json"), state("edit.after.json"));
  assert.equal(e.diff!.result.changes.length, 1);
  const n = await runOverStdio(TOY, state("no-change.before.json"), state("no-change.after.json"));
  assert.deepEqual(n.diff!.result.changes, []);
});

// ---- 2. validator tests (todo until the build) ------------------------------------------------------------------

type Problem = { file: string; field: string; expected: string; found: string; fix: string };

async function validate(dir: string): Promise<{ ok: boolean; problems: Problem[] }> {
  // Dynamic import: with the module missing, this rejects and the test fails for "missing module", not at load time.
  const spec = "../src/connector/validate.ts"; // variable specifier: tsc must not fail on the module that does not exist yet
  const mod = await import(spec);
  return mod.validateConnector({ dir, timeoutMs: 1500 });
}

// What each broken fixture must produce: the file, the field path, and what the fix sentence must point at.
const CASES: { name: string; file: string; field: RegExp; fixMentions: RegExp }[] = [
  { name: "no-manifest", file: ".", field: /^cocheck-connector\.json$/, fixMentions: /cocheck-connector\.json/ },
  { name: "leaked-token", file: "connector.mjs", field: /^caveats\[0\]$/, fixMentions: /token|secret|credential/i },
  { name: "empty-diff-on-malformed", file: "connector.mjs", field: /^(error|changes)$/, fixMentions: /error/i },
  { name: "hang", file: "connector.mjs", field: /^diff$/, fixMentions: /answer|respond|reply/i },
];

// One sentence: ends with a full stop, and no other sentence break. A break is . ! or ? followed by whitespace; dots
// inside file names and versions (cocheck-connector.json, 1.2) are not breaks.
export function isOneSentence(fix: string): boolean {
  const t = fix.trim();
  if (!/[.]$/.test(t)) return false;
  return !/[.!?](\s|$)/.test(t.slice(0, -1) + " ") && !/[!?]/.test(t);
}

// The shared assertion: every problem in a result is checked for banned names and the token; the matching problem
// for the case is checked for file, field, fix keyword and one sentence.
function assertMessages(c: { name: string; file: string; field: RegExp; fixMentions: RegExp }, problems: Problem[]) {
  const p = problems.find((x) => x.file === c.file && c.field.test(x.field));
  assert.ok(p, `no problem with file ${c.file} and field ${c.field}; got ${JSON.stringify(problems)}`);
  assert.match(p.fix, c.fixMentions);
  assert.ok(isOneSentence(p.fix), `fix is not one sentence: ${p.fix}`);
  for (const q of problems) {
    for (const text of [q.file, q.field, q.expected, q.found, q.fix]) {
      for (const re of BANNED) assert.doesNotMatch(String(text), re, `internal name ${re} in "${text}"`);
      assert.ok(!String(text).includes(TOKEN), "message repeats the leaked token");
    }
  }
}

// ---- 2a. self-check (run today): the assertion helper accepts a correct message per fixture and rejects bad ones ----

const GOOD: Record<string, Problem> = {
  "no-manifest": { file: ".", field: "cocheck-connector.json", expected: "a cocheck-connector.json file", found: "no manifest", fix: "Add a cocheck-connector.json file to the folder." },
  "leaked-token": { file: "connector.mjs", field: "caveats[0]", expected: "no credentials in the answer", found: "a credential-shaped string", fix: "Remove the token from the caveat text." },
  "empty-diff-on-malformed": { file: "connector.mjs", field: "error", expected: "an error for a malformed state", found: "an empty list of changes", fix: "Answer a malformed state with an error instead of an empty diff." },
  "hang": { file: "connector.mjs", field: "diff", expected: "an answer within 1.5 seconds", found: "no answer", fix: "Answer every diff request before the timeout." },
};

for (const c of CASES) {
  test(`self-check: the canned correct message for ${c.name} passes the assertion helper`, () => {
    assertMessages(c, [GOOD[c.name]]);
  });
}

test("self-check: the sentence check accepts dots inside file names and versions and rejects two sentences", () => {
  assert.ok(isOneSentence("Add a cocheck-connector.json file to the folder."));
  assert.ok(isOneSentence("Set spec to cocheck.connector/1 in connector.mjs for version 1.2."));
  assert.ok(!isOneSentence("Add the file. Then run it again."));
  assert.ok(!isOneSentence("Add the file! Then run it again."));
  assert.ok(!isOneSentence("Add the file"));
});

test("self-check: canned bad messages fail the assertion helper", () => {
  const c = CASES[0];
  const good = GOOD[c.name];
  const bad: Problem[] = [
    { ...good, fix: "Something went wrong." },
    { ...good, field: "name" },
    { ...good, fix: "Add a cocheck-connector.json file. Then run validate again." },
    { ...good, fix: "Add a cocheck-connector.json file as in T-" + "358." },
    { ...good, found: "see the " + "vault" },
  ];
  for (const b of bad) assert.throws(() => assertMessages(c, [b]), `should have failed: ${JSON.stringify(b)}`);
});

// ---- 2b. validator tests (todo until the build) ----

for (const c of CASES) {
  test(`validator rejects ${c.name} with file, field path and one fix sentence`, { todo: TODO }, async () => {
    const r = await validate(path.join(BROKEN, c.name));
    assert.equal(r.ok, false);
    assertMessages(c, r.problems);
  });
}

test("validator never repeats the leaked token it found", { todo: TODO }, async () => {
  const r = await validate(path.join(BROKEN, "leaked-token"));
  assert.ok(r.problems.length > 0);
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("validator hang case returns within the timeout instead of waiting forever", { todo: TODO, timeout: 15000 }, async () => {
  const t0 = Date.now();
  const r = await validate(path.join(BROKEN, "hang"));
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 10000);
});

test("must not: an empty diff for a malformed state is rejected, never accepted as a false clean", { todo: TODO }, async () => {
  const r = await validate(path.join(BROKEN, "empty-diff-on-malformed"));
  assert.equal(r.ok, false, "a connector that answers an empty diff on a malformed state was accepted");
  assert.ok(r.problems.some((p) => /malformed|error|empty/i.test(`${p.expected} ${p.found} ${p.fix}`)));
});

test("must not: the good toy connector is accepted with no problems (no over-rejection)", { todo: TODO }, async () => {
  const r = await validate(TOY);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});
