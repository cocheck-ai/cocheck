// The connector spec (public-kit/spec/README.md) is held to the code. Field names are read out of the source files that accept them, so a new field
// that the spec does not name fails here; every JSON example in the spec is parsed and run through the check its fence label names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkManifest, type Problem } from "../src/connector/schema.ts";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { parseDiffSamples, REQUIRED_SAMPLE_CLASSES } from "../src/connector/diff-samples.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SPEC = read("public-kit/spec/README.md");

/** Property names a source file reads off the named variables, plus the quoted names in the lists it loops over. Calls (`v.some(`) and `length` are not fields. */
export function fieldsRead(source: string, vars: string[]): Set<string> {
  const out = new Set<string>();
  const access = new RegExp(`\\b(?:${vars.join("|")})\\.(\\w+)\\b(?!\\()`, "g");
  for (const m of source.matchAll(access)) if (m[1] !== "length") out.add(m[1]!);
  for (const m of source.matchAll(/as Obj\)\.(\w+)/g)) out.add(m[1]!);
  for (const m of source.matchAll(/\bkeys = \[((?:"\w+",? ?)+)\]/g)) for (const q of m[1]!.matchAll(/"(\w+)"/g)) out.add(q[1]!);
  for (const m of source.matchAll(/\bof \[((?:"\w+",? ?)+)\]/g)) for (const q of m[1]!.matchAll(/"(\w+)"/g)) out.add(q[1]!);
  for (const m of source.matchAll(/(?:\.add\(|\bin json\b|"attribution" in)\s*[^)]*?"(attribution)"/g)) out.add(m[1]!);
  return out;
}

const schemaSrc = read("src/connector/schema.ts");
/** Fields of the manifest, of a diff answer (answer, change, anchor, range, payload) and of a snapshot answer, from schema.ts. */
export const schemaFields = (src: string): Set<string> => fieldsRead(src, ["json", "ch", "cr", "a", "r", "v", "run"]);
/** Fields of hello (read by the conformance runner and the validator) and of the diff answer read by the production diff (`subject`, `caveats`). */
export const helloFields = (src: string): Set<string> => {
  const out = new Set<string>();
  for (const m of src.matchAll(/hello\.(\w+)/g)) out.add(m[1]!);
  for (const m of src.matchAll(/for \(const k of \[("\w+"(?:, "\w+")*)\]\) if \(h\.hello/g)) for (const q of m[1]!.matchAll(/"(\w+)"/g)) out.add(q[1]!);
  return out;
};
const methodsIn = (src: string): Set<string> => new Set([...src.matchAll(/\bmethod: "(\w+)"|\.call\("(\w+)"/g)].map((m) => (m[1] ?? m[2])!));

const documented = (name: string) => SPEC.includes("`" + name + "`");

describe("connector spec: shape", () => {
  it("is labelled v1 experimental and has the fourteen sections, in order, with the shared slugs", () => {
    assert.match(SPEC, /Status: v1, experimental/);
    const headings = [...SPEC.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
    assert.deepEqual(headings, ["Manifest", "Hello", "Change-list answer", "Levels", "Export entry", "Errors", "Credentials", "Snapshot", "Diffs for diff-entry connectors", "Platforms", "Testing your connector", "One winner", "Security", "Versioning"]);
    const slugs = ["manifest", "hello", "diff-answer", "levels", "export", "errors", "credentials", "snapshot", "diffs", "platforms", "testing", "one-winner", "security", "versioning"];
    headings.forEach((h, i) => {
      const github = h.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
      const explicit = new RegExp(`<a id="${slugs[i]}"></a>\\n## ${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`).test(SPEC);
      assert.ok(github === slugs[i] || explicit, `#${slugs[i]} does not resolve for "${h}"`);
    });
  });
  it("names the v1 manifest fields, the one-winner order, per-level conformance and the older-shape refusal, and drops the old ladder", () => {
    for (const f of ["beforeReadMs", "openInProduct", "permissions"]) assert.ok(documented(f), f);
    assert.match(SPEC, /older shape/);
    for (const w of ["matches.mcpTools", "matches.subjects", "matches.mcpServers", "matches.schemes", "matches.extensions"]) assert.ok(SPEC.includes("`" + w + "`"), w);
    assert.match(SPEC, /### Conformance per level/);
    assert.match(SPEC, /level 3 passed/);
    assert.match(SPEC, /`data:text\/html,\.\.\.` address in its `src`/);
    assert.match(SPEC, /\(v1\.md\)/);
    for (const gone of ["`precision`", "`none`, `page`, `region`", "`call`, `calls`", "`writer`", "P4"]) assert.ok(!SPEC.includes(gone), `${gone} is v0 and should be gone`);
  });
});

describe("connector spec: every field the code accepts is named", () => {
  it("schema.ts fields (manifest, diff answer, snapshot answer) appear in the spec", () => {
    const fields = schemaFields(schemaSrc);
    for (const must of ["spec", "id", "version", "entry", "matches", "run", "credentials", "platforms", "requires", "extensions", "schemes", "mcpServers", "mcpTools", "subjects", "apps", "binaries", "runtimes", "name", "state"]) {
      assert.ok(fields.has(must), `the field reader no longer sees ${must}: the test's reader is stale`);
    }
    const missing = [...fields].filter((f) => !documented(f));
    assert.deepEqual(missing, [], `schema.ts reads fields the spec does not name in backticks: ${missing.join(", ")}`);
  });

  it("hello fields and methods read by the runner and the connector flows appear in the spec", () => {
    const hello = helloFields(read("src/connector/conformance.ts"));
    for (const must of ["spec", "methods"]) assert.ok(hello.has(must), `the hello reader no longer sees ${must}`);
    for (const f of hello) assert.ok(documented(f), `hello.${f} is read by the code but the spec does not name it`);
    const methods = new Set([...methodsIn(read("src/connector/before-snapshot.ts")), ...methodsIn(read("src/connector/after-snapshot.ts")), ...methodsIn(read("src/connector/diff.ts")), ...methodsIn(read("src/connector/conformance.ts"))]);
    for (const must of ["hello", "snapshot", "diff", "diffs"]) assert.ok(methods.has(must) || must === "hello", `the method reader no longer sees ${must}`);
    for (const m of methods) assert.ok(documented(m), `method ${m} is called by the code but the spec does not name it`);
    for (const f of ["subject", "caveats", "since", "until", "before", "after", "code", "message", "error", "result", "id", "params", "credentials"]) assert.ok(documented(f), `${f} is not named in the spec`);
    // the production diff reads these off the answer; they must be fields the spec names
    const diffSrc = read("src/connector/diff.ts");
    assert.match(diffSrc, /doc\.caveats/);
  });

  it("the reader sees a field that schema.ts gains (the guard is live)", () => {
    const grown = schemaSrc.replace("export function checkManifest(json: unknown): Problem[] {", "export function checkManifest(json: unknown): Problem[] {\n  void json.brandNewField;");
    const added = [...schemaFields(grown)].filter((f) => !schemaFields(schemaSrc).has(f));
    assert.deepEqual(added, ["brandNewField"]);
    assert.ok(!documented("brandNewField"));
  });

  it("every method the spec lists exists in the code, so a stranger never builds to a method that is refused", () => {
    const code = [read("src/connector/before-snapshot.ts"), read("src/connector/after-snapshot.ts"), read("src/connector/diff.ts")].join("\n");
    for (const m of ["snapshot", "diff", "diffs"]) assert.match(code, new RegExp(`"${m}"`), m);
  });
});

interface Fence { label: string; body: string }
const fences = (): Fence[] => [...SPEC.matchAll(/^```(\w+)(?: ([\w-]+))?\n([\s\S]*?)^```$/gm)].map((m) => ({ label: m[2] ? `${m[1]} ${m[2]}` : m[1]!, body: m[3]! }));
const problemLines = (ps: Problem[]) => ps.flatMap((p) => [`${p.field}: expected ${p.expected}, found ${p.found}`, `fix: ${p.fix}`]);

describe("connector spec: examples are executed", () => {
  it("every json example parses, and labelled ones pass the check their label names", () => {
    let manifests = 0, answers = 0;
    for (const f of fences()) {
      if (!f.label.startsWith("json")) continue;
      const value = JSON.parse(f.body) as unknown; // an unlabelled or malformed json fence fails here
      if (f.label === "json manifest") { manifests++; assert.deepEqual(problemLines(checkManifest(value)), [], "manifest example"); }
      else if (f.label === "json changes") { answers++; assert.deepEqual(problemLines(checkChanges(value)), [], "change list example"); assert.equal((value as { level?: number }).level, undefined, "a document carries no level"); }
      else if (f.label === "json hello") {
        const r = (value as { result: Record<string, unknown> }).result;
        assert.equal(r.spec, "cocheck.connector/1");
        assert.equal(r.level, 1);
        assert.ok(Array.isArray(r.methods));
      } else if (f.label === "json message") {
        const m = value as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
        assert.ok(Number.isInteger(m.id), "a message has a whole-number id");
        assert.ok(typeof m.method === "string" || m.result !== undefined || m.error !== undefined);
      } else if (f.label === "json samples") {
        // The samples example is read by the same parser `connector test` uses, and covers the three required classes
        const read = parseDiffSamples(value);
        assert.deepEqual(problemLines(read.problems), [], "samples example");
        assert.deepEqual([...new Set(read.samples.map((x) => x.class))].sort(), [...REQUIRED_SAMPLE_CLASSES].sort());
      } else assert.ok(["json bad-changes"].includes(f.label), `unknown fence label ${f.label}`);
    }
    assert.ok(manifests >= 1 && answers >= 2, "the spec needs a manifest example and change-list examples for a state and a diff-entry connector");
  });

  it("the deliberately bad example fails with exactly the message the spec shows", () => {
    const all = fences();
    const i = all.findIndex((f) => f.label === "json bad-changes");
    assert.ok(i >= 0, "no bad example");
    const shown = all[i + 1];
    assert.equal(shown?.label, "text rejected");
    const got = problemLines(checkChanges(JSON.parse(all[i]!.body)));
    assert.deepEqual(shown!.body.trim().split("\n"), got);
  });

  it("the manifest example with all three v1 fields is accepted, and each field is held to its rule", () => {
    const m = JSON.parse(fences().find((f) => f.label === "json manifest")!.body) as Record<string, unknown>;
    for (const f of ["beforeReadMs", "permissions"]) assert.ok(f in m, `the manifest example shows ${f}`);
    assert.ok(!("openInProduct" in m), "openInProduct is not in v1");
    assert.deepEqual(checkManifest(m), []);
    assert.equal(checkManifest({ ...m, beforeReadMs: 3001 })[0]?.field, "beforeReadMs");
    assert.equal(checkManifest({ ...m, openInProduct: {} })[0]?.field, "openInProduct");
    assert.equal(checkManifest({ ...m, permissions: { env: "X" } })[0]?.field, "permissions.env");
  });

  it("an answer in the older shape (kind, anchors, confidence) is refused with a message that says so", () => {
    const older = { changes: [{ kind: "edit", anchors: [{ entity: "n1" }], confidence: "exact", before: { type: "text", value: "a" }, after: { type: "text", value: "b" } }], caveats: [] };
    const ps = checkChanges(older);
    assert.equal(ps[0]?.field, "spec");
    assert.match(ps[0]!.fix, /older change-list shape .* no longer reads/);
  });
});

describe("connector spec: testing section states its limits and the five pairs", () => {
  const testing = SPEC.slice(SPEC.indexOf('<a id="testing"></a>'), SPEC.indexOf('<a id="one-winner"></a>'));
  it("names the commands, the three limits and each state pair", () => {
    for (const c of ["cocheck connector test <dir> [--states <dir>] [--timeout <ms>]", "cocheck connector test <dir> --cases [<casesDir>]", "cocheck connector create <dir> --id <id>", "cocheck connector doctor [<id>]"]) assert.ok(testing.includes(c), c);
    assert.match(testing, /does not deny network/);
    assert.match(testing, /C10/);
    assert.match(testing, /Memory is not measured/);
    assert.match(testing, /C13/);
    assert.match(testing, /not sandboxed/);
    for (const p of ["create", "edit", "delete", "no-change", "malformed"]) assert.match(testing, new RegExp("- `" + p + "`:"), p);
  });
  it("the five pair names are the ones the validator runs", () => {
    const src = read("src/connector/validate.ts");
    for (const p of ["create", "edit", "delete", "no-change", "malformed"]) assert.ok(src.includes(`name: "${p}"`), p);
  });
});

describe("connector spec: what the tests reject is what the spec says", () => {
  const section = (from: string, to: string) => SPEC.slice(SPEC.indexOf(from), SPEC.indexOf(to));

  it("Testing names both modes of the test command, per-level conformance and how a diff-entry connector is graded on its author's samples", () => {
    const testing = section('<a id="testing"></a>', '<a id="one-winner"></a>');
    assert.match(testing, /Mode one, the state pairs/);
    assert.match(testing, /Mode two, the conformance cases \(`--cases`\)/);
    assert.match(testing, /`<name>\.before\.json` and `<name>\.after\.json`/);
    assert.doesNotMatch(testing, /manifest and `hello` only/);
    assert.doesNotMatch(SPEC, /known gap|not exercised|does not send `diffs`/);
    assert.match(testing, /sent `diffs` from the samples you supply/);
    assert.match(testing, /`untested`, and exits 1/);
    assert.match(SPEC, /`COCHECK_TEST_SAMPLES` names the `samples` folder/);
    assert.match(testing, /always give `--states`/);
    assert.match(testing, /connectors\/<id>\//);
    assert.match(testing, /cocheck connector doctor <id>/);
    assert.match(read("public-kit/conformance/README.md"), /connector test <dir> --cases/);
  });

  it("the sentence about a v1 level-1 answer matches the live check: an unknown mark and a missing label are rejected by name", () => {
    const base = { spec: "cocheck.changes/1", level: 1, changes: [{ id: "a", mark: "added", label: "x", after: "y" }] };
    assert.deepEqual(checkChanges(base), []);
    assert.equal(checkChanges({ ...base, changes: [{ id: "a", mark: "new", label: "x" }] })[0]?.field, "changes[0].mark");
    assert.equal(checkChanges({ ...base, changes: [{ id: "a", mark: "added", after: "y" }] })[0]?.field, "changes[0].label");
  });
});
