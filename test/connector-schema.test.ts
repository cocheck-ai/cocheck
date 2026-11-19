// Hand-written checks for the connector manifest (src/connector/schema.ts) and the toy diff answers (src/connector/changes-v1.ts).
// Problem = { file, field, expected, found, fix }.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { checkManifest, type Problem } from "../src/connector/schema.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOY = path.join(ROOT, "public-kit", "conformance", "fixtures", "toy");
const STATES = path.join("public-kit", "toy-product", "states");
// Internal names that must never appear in a message (same list as connector-validator-messages.test.ts).
// Needles are built from parts so this file carries none of the banned words itself.
const BANNED = [new RegExp("Tom" + "as", "i"), new RegExp("vau" + "lt", "i"), new RegExp("1-pro" + "jects"), /\bT-\d+/, new RegExp("dri" + "ve \\d+", "i"), new RegExp("\\bqu" + "eue\\b", "i"), new RegExp("correc" + "tor", "i"), new RegExp("dangerous" + " direction", "i"), /LayerDiffRow/, /FormatRow/, /RailChange/];

const manifest = () => JSON.parse(readFileSync(path.join(TOY, "cocheck-connector.json"), "utf8"));
const fields = (ps: Problem[]) => ps.map((p) => p.field);

function toyAnswer(pair: string) {
  const [before, after] = ["before", "after"].map((s) => path.join(STATES, `${pair}.${s}.json`));
  const input = JSON.stringify({ id: 1, method: "diff", params: { before, after } }) + "\n";
  const res = spawnSync(process.execPath, [path.join(TOY, "connector.mjs")], { cwd: ROOT, input, encoding: "utf8", timeout: 15000 });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split("\n")[0]) as { result?: unknown; error?: unknown };
}

test("toy manifest gives zero problems", () => {
  assert.deepEqual(checkManifest(manifest()), []);
});

test("toy connector's real diff answers on every toy-product state pair give zero problems", () => {
  for (const pair of ["create", "edit", "delete", "no-change"]) {
    const reply = toyAnswer(pair);
    assert.ok(reply.result, `${pair} should answer with a diff`);
    assert.deepEqual(checkChanges(reply.result), [], pair);
  }
  // malformed answers with an error, not a diff: out of scope for checkChanges.
  assert.ok(toyAnswer("malformed").error);
});

test("every Problem has file, field, expected, found and one clean fix sentence", () => {
  const bad = checkManifest({ spec: "nope", entry: "x", run: "node a.mjs", credentials: [{}], platforms: "linux", requires: 3 });
  const badAns = checkChanges({ spec: "nope", changes: [{ id: "", mark: "x", label: 5 }], caveats: 3 });
  const all = [...bad, ...badAns];
  assert.ok(all.length > 8);
  for (const p of all) {
    for (const k of ["file", "field", "expected", "found", "fix"] as const) assert.equal(typeof p[k], "string", `${p.field} ${k}`);
    assert.ok(p.field && p.expected && p.found && p.fix);
    assert.ok(p.file === "cocheck-connector.json" || p.file === "<changes>");
    assert.doesNotMatch(p.fix, /[.!?]\s+\S/, `one sentence: ${p.fix}`);
    for (const b of BANNED) for (const t of [p.expected, p.found, p.fix, p.field]) assert.doesNotMatch(t, b);
  }
});

test("manifest: run as a string is rejected and names run", () => {
  const m = { ...manifest(), run: "node connector.mjs" };
  const ps = checkManifest(m);
  assert.ok(fields(ps).includes("run"), JSON.stringify(ps));
  assert.equal(ps.find((p) => p.field === "run")!.file, "cocheck-connector.json");
});

test("manifest: unknown entry is rejected and names entry", () => {
  assert.ok(fields(checkManifest({ ...manifest(), entry: "snapshot" })).includes("entry"));
});

test("manifest: other required fields, per-OS run map and credentials are checked", () => {
  assert.ok(fields(checkManifest({ ...manifest(), spec: "cocheck.connector/2" })).includes("spec"));
  for (const f of ["id", "version", "matches"]) {
    const m = manifest();
    delete m[f];
    assert.ok(fields(checkManifest(m)).includes(f), f);
  }
  assert.deepEqual(checkManifest({ ...manifest(), run: { darwin: ["node", "a.mjs"], win32: ["node.exe", "a.mjs"] }, entry: "both", credentials: [{ name: "token" }], requires: { binaries: ["git"] } }), []);
  assert.ok(fields(checkManifest({ ...manifest(), run: { darwin: "node a.mjs" } })).includes("run.darwin"));
  assert.ok(fields(checkManifest({ ...manifest(), run: ["node", 3] })).includes("run[1]"));
  assert.ok(fields(checkManifest({ ...manifest(), credentials: [{ name: "" }] })).includes("credentials[0].name"));
  assert.ok(checkManifest(null).length > 0);
});

test("manifest: unknown extra fields are accepted (open)", () => {
  assert.deepEqual(checkManifest({ ...manifest(), homepage: "https://example.com", matches: { extensions: [".x"], future: 1 } }), []);
});

test("matches must name something to handle", () => {
  for (const m of [{}, { extensions: [] }, { schemes: [], mcpTools: [] }, { future: 1 }]) {
    assert.ok(fields(checkManifest({ ...manifest(), matches: m })).includes("matches"), JSON.stringify(m));
  }
  for (const k of ["extensions", "schemes", "mcpServers", "mcpTools"]) assert.deepEqual(checkManifest({ ...manifest(), matches: { [k]: ["x"] } }), [], k);
});

test("manifest: matches.subjects is checked", () => {
  const m = (subjects: unknown, rest: object = { mcpTools: ["t"] }) => ({ ...manifest(), matches: { ...rest, subjects } });
  assert.deepEqual(checkManifest(m({ mcp__notion__notion_update_page: "notion://page/{page_id:hex}", other: "x://{a}/{b}" })), []);
  assert.ok(fields(checkManifest(m("nope"))).includes("matches.subjects"));
  assert.ok(fields(checkManifest(m({ "": "x://{a}" }))).includes("matches.subjects"));
  assert.ok(fields(checkManifest(m({ t: 3 }))).includes("matches.subjects.t"));
  assert.ok(fields(checkManifest(m({ t: "" }))).includes("matches.subjects.t"));
  assert.ok(fields(checkManifest(m({ t: "x://{page-id}" }))).includes("matches.subjects.t"));
  assert.ok(fields(checkManifest(m({ t: "x://{a:upper}" }))).includes("matches.subjects.t"));
  assert.ok(fields(checkManifest(m({ t: "x://{a" }))).includes("matches.subjects.t"));
  // subjects alone does not name anything to handle
  assert.ok(fields(checkManifest(m({ t: "x://{a}" }, {}))).includes("matches"));
});
