// public-kit/GUIDE.md is the one page a stranger follows. It is held to the code three ways: every json block is validated, the program and the commands in it
// are run exactly as written (in a temp HOME, against the toy states and the kit's toy connectors), and each failure it lists is reproduced and must print the
// words the guide quotes. The guarded case is a guide that sends a stranger into a failure it does not mention (the "listed failures" test) or one that
// carries internals (the "one page, no internals" test).
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { checkManifest } from "../src/connector/schema.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.join(ROOT, "public-kit");
const GUIDE = readFileSync(path.join(KIT, "GUIDE.md"), "utf8");
const CLI = path.join(ROOT, "src", "cli-main.ts");

interface Fence { label: string; body: string }
const fences: Fence[] = [...GUIDE.matchAll(/^```(\w+)(?: ([\w-]+))?\n([\s\S]*?)^```$/gm)].map((m) => ({ label: m[2] ? `${m[1]} ${m[2]}` : m[1]!, body: m[3]! }));
const fence = (label: string, n = 0): string => fences.filter((f) => f.label === label)[n]!.body;
const prose = GUIDE.replace(/^```[\s\S]*?^```$/gm, "");

/** The commands the guide tells a stranger to type: the `text` block and the inline ones that start with `cocheck`. */
const commands = [...new Set([...fence("text").split("\n"), ...[...prose.matchAll(/`(cocheck [^`]+)`/g)].map((m) => m[1]!)].map((c) => c.trim()).filter((c) => c.startsWith("cocheck ")))];
const TEST_CMD = "cocheck connector test ./my-connector --states ./states";
const CREATE_CMD = "cocheck connector create my-connector --id my-connector";

/** A temp HOME and CoCheck home with the guide's own files laid out as the guide says: my-connector/{manifest, program} and states/ (the kit's toy pairs). */
function workspace(): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = mkdtempSync(path.join(tmpdir(), "guide-"));
  const home = path.join(cwd, "home");
  mkdirSync(home);
  mkdirSync(path.join(cwd, "my-connector"));
  writeFileSync(path.join(cwd, "my-connector", "cocheck-connector.json"), fence("json manifest"));
  writeFileSync(path.join(cwd, "my-connector", "connector.mjs"), fence("js"));
  cpSync(path.join(KIT, "toy-product", "states"), path.join(cwd, "states"), { recursive: true });
  return { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, COCHECK_HOME: path.join(home, ".cocheck") } };
}
/** Runs a command line from the guide through the shell, with `cocheck` standing for this checkout's CLI entry. Never installs anything. */
function run(cmd: string, cwd: string, env: NodeJS.ProcessEnv): { code: number; out: string } {
  assert.ok(cmd.startsWith("cocheck connector "), cmd); // the guide never tells a stranger to install or touch anything else
  const line = `node ${JSON.stringify(CLI)} ${cmd.slice("cocheck ".length)}`;
  try {
    return { code: 0, out: execSync(line, { cwd, env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}
const send = (dir: string, entry: string, messages: unknown[]): unknown[] => {
  const r = spawnSync("node", [entry], { cwd: dir, input: messages.map((m) => JSON.stringify(m)).join("\n") + "\n", encoding: "utf8", timeout: 20_000 });
  return r.stdout.trim().split("\n").map((l) => JSON.parse(l) as unknown);
};

describe("guide: one page, no internals", () => {
  it("is about 190 lines at most and carries nothing from src/ or the build plan", () => {
    assert.ok(GUIDE.trimEnd().split("\n").length <= 190, `the guide is ${GUIDE.trimEnd().split("\n").length} lines`);
    for (const bad of [/\bsrc\//, /\bT-\d+/i, /\bphase\b/i, /\bgolden\b/i, /\brail\b/i, new RegExp("\\bl" + "ead\\b", "i"), new RegExp("qu" + "eue", "i"), new RegExp("vau" + "lt", "i"), /—|–/, /checkChanges|checkManifest/]) assert.ok(!bad.test(GUIDE), `the guide matches ${bad}`);
  });
  it("points to the spec for levels 2 and 3 only, and names the three levels once", () => {
    assert.match(GUIDE, /level 2 adds pictures and level 3 puts boxes/);
    assert.match(GUIDE, /spec\/v1\.md/);
    assert.ok(existsSync(path.join(KIT, "spec", "v1.md")) && existsSync(path.join(KIT, "spec", "README.md")));
    assert.ok(!/"pictures"|"boxes"/.test(GUIDE), "level 2 and 3 fields are not taught in the guide");
  });
});

describe("guide: every json block is validated", () => {
  it("the manifest passes checkManifest, entry state", () => {
    const m = JSON.parse(fence("json manifest")) as Record<string, unknown>;
    assert.deepEqual(checkManifest(m), []);
    assert.equal(m.entry, "state");
  });
  it("every json block parses and is a known kind: hello, changes (checked as a level 1 document) or a message", () => {
    let blocks = 0;
    for (const f of fences.filter((x) => x.label.startsWith("json") && x.label !== "json manifest" && x.label !== "json vendor-manifest")) {
      blocks++;
      const v = JSON.parse(f.body) as { id?: number; method?: string; result?: Record<string, unknown> };
      assert.ok(Number.isInteger(v.id), `${f.label}: a message has a whole-number id`);
      if (f.label === "json hello") { assert.equal(v.result!.spec, "cocheck.connector/1"); assert.equal(v.result!.level, 1); assert.deepEqual(v.result!.methods, ["diff"]); }
      else if (f.label === "json changes") { assert.deepEqual(checkChanges(v.result), []); assert.equal((v.result as { level?: number }).level, undefined, "a document carries no level"); }
      else if (f.label === "json message") assert.ok(typeof v.method === "string" || v.result !== undefined, "a message is a request or a result");
      else assert.fail(`unknown json block ${f.label}`);
    }
    assert.ok(blocks >= 5);
  });
  it("the program the guide prints answers its own blocks: hello, then diff over the toy edit pair, byte for byte", () => {
    const { cwd } = workspace();
    const hello = JSON.parse(fence("json message", 0));
    const diff = JSON.parse(fence("json message", 1)) as { params: { before: string; after: string } };
    diff.params = { before: path.join(cwd, "states", "edit.before.json"), after: path.join(cwd, "states", "edit.after.json") };
    const [h, d] = send(path.join(cwd, "my-connector"), "connector.mjs", [hello, diff]);
    assert.deepEqual(h, JSON.parse(fence("json hello")));
    assert.deepEqual(d, JSON.parse(fence("json changes")));
  });
  it("the export reply the guide shows is what the kit's toy export connector prints for a state, and checks as a valid export answer", () => {
    const dir = path.join(KIT, "examples", "toy-export");
    const asked = JSON.parse(fence("json message", 2)) as { id: number; method: string; params: { subject: string } };
    assert.equal(asked.method, "export");
    const [r] = send(dir, "connector.mjs", [{ ...asked, params: { subject: path.join(KIT, "toy-product", "states", "edit.before.json") } }]);
    assert.deepEqual(r, JSON.parse(fence("json message", 3)));
  });
});

describe("guide: the commands run as written, in a temp HOME", () => {
  it("names exactly the test command and the create shortcut", () => {
    assert.deepEqual(commands.sort(), [CREATE_CMD, TEST_CMD].sort());
  });
  it("the guide's own manifest and program pass the test command: level 1 passed, exit 0", () => {
    const { cwd, env } = workspace();
    const r = run(TEST_CMD, cwd, env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^level 1 passed\npassed\n$/);
    assert.deepEqual(readdirSync(env.HOME!).filter((n) => n !== ".cocheck"), []); // nothing was installed or written to the home
  });
  it("the kit's level 1 example passes the same command", () => {
    const { cwd, env } = workspace();
    cpSync(path.join(KIT, "examples", "toy-level-1"), path.join(cwd, "my-connector"), { recursive: true });
    const r = run(TEST_CMD, cwd, env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /level 1 passed\npassed/);
  });
  it("the kit's export example passes the same command: the no-protocol option", () => {
    const { cwd, env } = workspace();
    cpSync(path.join(KIT, "examples", "toy-export"), path.join(cwd, "my-connector"), { recursive: true });
    const r = run(TEST_CMD, cwd, env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /export: CoCheck draws the difference/);
    assert.match(r.out, /\npassed\n$/);
    const m = JSON.parse(readFileSync(path.join(cwd, "my-connector", "cocheck-connector.json"), "utf8")) as { entry: string };
    assert.equal(m.entry, "export"); // the guide says to set "entry": "export"
  });
  it("the create shortcut writes a starter that passes the test command", () => {
    const { cwd, env } = workspace();
    const fresh = mkdtempSync(path.join(tmpdir(), "guide-create-"));
    const c = run(CREATE_CMD, fresh, env);
    assert.equal(c.code, 0, c.out);
    cpSync(path.join(cwd, "states"), path.join(fresh, "states"), { recursive: true });
    const r = run(TEST_CMD, fresh, env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /level 1 passed/);
  });
});

describe("guide: the failures it lists are real, with the words it quotes", () => {
  const rows = [...GUIDE.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]!);
  const mutate = (file: string, from: string | RegExp, to: string) => (cwd: string) => {
    const p = path.join(cwd, "my-connector", file);
    const before = readFileSync(p, "utf8");
    const after = before.replace(from, to);
    assert.notEqual(after, before, `mutation of ${file} changed nothing`);
    writeFileSync(p, after);
  };
  const cases: Array<{ quoted: string; setup: (cwd: string) => void }> = [
    { quoted: "found a missing state file", setup: (cwd) => void rmSync(path.join(cwd, "states", "delete.before.json")) },
    { quoted: "found an error", setup: (cwd) => { for (const n of ["create", "edit", "delete", "no-change"]) for (const s of ["before", "after"]) writeFileSync(path.join(cwd, "states", `${n}.${s}.json`), '{"x":1}\n'); } },
    { quoted: "an error for a malformed state", setup: mutate("connector.mjs", "const state = JSON.parse(text);", "let state; try { state = JSON.parse(text); } catch { return new Map(); }") },
    { quoted: "a different answer when the before and after states are swapped", setup: mutate("connector.mjs", "return { spec: \"cocheck.changes/1\", changes };", "return { spec: \"cocheck.changes/1\", changes: changes.map((c) => ({ id: \"n1\", mark: c.mark, label: \"Note\", ...(c.mark !== \"added\" ? { before: \"a\" } : {}), ...(c.mark !== \"removed\" ? { after: \"b\" } : {}) })) };") },
    { quoted: "an answer when one side is an empty file", setup: mutate("connector.mjs", "  if (text.trim() === \"\") return new Map();\n", "") },
    { quoted: "expected one of \"added\", \"removed\"", setup: mutate("connector.mjs", 'mark: "added"', 'mark: "new"') },
    { quoted: "run: expected a non-empty list of strings", setup: mutate("cocheck-connector.json", '["node", "connector.mjs"]', '"node connector.mjs"') },
  ];
  it("the table lists exactly the failures reproduced here", () => {
    assert.equal(rows.length, cases.length);
    for (const c of cases) assert.ok(GUIDE.includes(c.quoted.replace(/"/g, '"')), `the guide does not quote ${c.quoted}`);
  });
  for (const c of cases) {
    it(`reproduces and prints: ${c.quoted}`, () => {
      const { cwd, env } = workspace();
      c.setup(cwd);
      const r = run(TEST_CMD, cwd, env);
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.includes(c.quoted), `output was: ${r.out}`);
      assert.ok(!/level 1 passed|^passed$/m.test(r.out), "a failing run never says passed");
    });
  }
  it("leaving out --states on a product that is not the toy fails, which is why the guide says to always pass it", () => {
    assert.match(GUIDE, /Always pass `--states`/);
    const { cwd, env } = workspace();
    mutate("connector.mjs", "state.notes.map((n) => [n.id, n.text])", "state.items.map((n) => [n.id, n.text])")(cwd);
    const r = run("cocheck connector test ./my-connector", cwd, env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /found an error/);
  });
});

describe("guide: the MCP vendor section", () => {
  it("its manifest passes checkManifest and carries a subjects template; the kit's toy-vendor passes the test command, which asks snapshot on the template's URI", () => {
    const m = JSON.parse(fence("json vendor-manifest")) as { matches: { subjects?: Record<string, string> } };
    assert.deepEqual(checkManifest(m), []);
    assert.ok(Object.keys(m.matches.subjects ?? {}).length > 0);
    for (const w of ["subjects", "snapshot", "COCHECK_TEST_STATES", "connectors/<id>/"]) assert.ok(GUIDE.includes(w), w);
    const { cwd, env } = workspace();
    cpSync(path.join(KIT, "examples", "toy-vendor"), path.join(cwd, "my-connector"), { recursive: true });
    const r = run(TEST_CMD, cwd, env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /level 1 passed\npassed/);
  });
});

describe("guide: every field it names is exercised", () => {
  it("each required manifest field is required by the check, and each change field is checked by name", () => {
    const m = JSON.parse(fence("json manifest")) as Record<string, unknown>;
    for (const f of ["spec", "id", "version", "entry", "matches", "run"]) {
      const { [f]: _gone, ...rest } = m;
      assert.ok(checkManifest(rest).some((p) => p.field === f), `manifest without ${f} is accepted`);
    }
    const doc = JSON.parse(fence("json changes")).result as { changes: Array<Record<string, unknown>> };
    for (const f of ["id", "mark", "label"]) {
      const { [f]: _gone, ...rest } = doc.changes[0]!;
      assert.ok(checkChanges({ ...doc, changes: [rest] }).some((p) => p.field === `changes[0].${f}`), `a change without ${f} is accepted`);
    }
    assert.ok(checkChanges({ ...doc, changes: [{ ...doc.changes[0]!, id: "x" }, { ...doc.changes[0]!, id: "x" }] }).length > 0, "a repeated id is accepted");
    for (const mark of ["added", "removed", "changed", "moved", "described"]) assert.deepEqual(checkChanges({ ...doc, changes: [{ id: "a", mark, label: "x" }] }), [], mark);
  });
  it("every word the guide puts in backticks is one this file knows about", () => {
    const known = new Set([...["mcpServers", "subjects", "a different answer when the before and after states are swapped", "an answer when one side is an empty file", "snapshot", "\"methods\": [\"snapshot\", \"diff\"]", '"issues": [{ "text": "the total no longer adds up", "where": "Note n2" }]', '"more": 3', '"nothingChanged": true', "permissions.env", "my-vendor://note/edit.before", "COCHECK_TEST_STATES", "<note_id>.json", "edit.before.json", "examples/toy-vendor", "connectors/<id>/", "$COCHECK_HOME", "~/.cocheck", '"entry": "diff"', '"methods": ["diffs"]', "diffs", "since", "until", "samples", "samples.json", "failed-read", "COCHECK_TEST_SAMPLES", "untested", "examples/toy-tracker", "create_issue", "matches.calls", "\"my-vendor://note/{note.id}\"", "samples/calls.json"],"error", "code", "message", "result", '"level": 1', "cocheck", "states", "my-connector", "cocheck-connector.json", "connector.mjs", "my-connector/connector.mjs", "create", "edit", "delete", "no-change", "malformed", "<name>.before.json", "<name>.after.json", ".json", "id", "entry", "state", "export", "matches", "schemes", "run", "level", "methods", "hello", "diff", "before", "after", "mark", "label", "changes", "added", "removed", "changed", "moved", "described", "cocheck.changes/1", "readState", "null", "--states", "spec/v1.md", "spec/README.md", ".", "_", "-", "text", "subject", "params", '"changes": []', "level 1 passed", "passed", "standard error", '"entry": "export"', '"methods": ["export"]', "my-notes", "stdout", "extensions", "found an error", "found a missing state file", "an error for a malformed state", "neither side present", "P1", "P2", "level: expected 1, 2 or 3, found missing", 'expected one of "added", "removed"', "run: expected a non-empty list of strings", "create`, `edit`, `delete", "neither side present` (with `P1`, `P2`", "cocheck connector test ./my-connector --states ./states", "cocheck connector create my-connector --id my-connector", '{"id": 2, "error": {"code": "bad-product-response", "message": "what went wrong"}}']);
    const words = [...prose.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const unknown = words.filter((w) => !known.has(w));
    assert.deepEqual(unknown, [], `backticked words the guide names that no test covers: ${unknown.join(" | ")}`);
  });
});
