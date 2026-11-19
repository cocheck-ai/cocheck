// The claims rule replaces the reserved endings and their warning. What stays of this file: `cocheck connector doctor` says, once
// per type, when an installed connector claims a type it is not enabled for (a note, never a failure, and the exit code is unchanged), and how to
// switch; `cocheck connector test` keeps finding its folder wherever it sits among the options; the spec README states the claim rule.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorDoctor } from "../src/connector-doctor.ts";
import { runConnectorTest } from "../src/connector-test-cli.ts";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { connectorClaimsFor } from "../src/connector/installed-match.ts";
import { ENABLED_TYPES_FILE } from "../src/connector/enabled-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
afterEach(() => setBuiltinConnectorsForTest(undefined));

function home(list: Array<{ id: string; matches: Record<string, unknown> }>): string {
  const h = mkdtempSync(path.join(tmpdir(), "home-"));
  for (const c of list) {
    mkdirSync(path.join(h, "connectors", c.id), { recursive: true });
    writeFileSync(path.join(h, "connectors", c.id, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: c.id, version: "1", entry: "state", matches: c.matches, run: ["node", "x.mjs"] }));
  }
  return h;
}

/** A copy of the toy level-1 connector whose manifest claims `extensions`. */
function toy(extensions: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "toy-"));
  cpSync(path.join(ROOT, "public-kit/examples/toy-level-1"), dir, { recursive: true });
  const file = path.join(dir, "cocheck-connector.json");
  const m = JSON.parse(readFileSync(file, "utf8")) as { matches: { extensions: string[] } };
  m.matches.extensions = extensions;
  writeFileSync(file, JSON.stringify(m));
  return dir;
}

const notes = (stdout: string): string[] => stdout.split("\n").filter((l) => /is not enabled for it/.test(l));

test("`cocheck connector doctor` notes once per type an installed connector claims but is not enabled for, and the exit code is unchanged", async () => {
  const quiet = home([{ id: "notes", matches: { extensions: [".notes.json", ".mdx"] } }]);
  const q = await runConnectorDoctor([], { home: quiet, store: { get: () => null } });
  const h = home([{ id: "notes", matches: { extensions: [".notes.json", ".mdx", ".md", ".notes.md", ".csv"] } }]);
  const r = await runConnectorDoctor([], { home: h, store: { get: () => null } });
  // A connector that claims .md and .csv is told it is not used for them, and how to switch.
  assert.deepEqual(notes(r.stdout), [
    `note: "notes" claims .csv but is not enabled for it (enabled: none); \`cocheck connector enable notes .csv\` switches it`,
    `note: "notes" claims .md but is not enabled for it (enabled: none); \`cocheck connector enable notes .md\` switches it`,
    `note: "notes" claims .notes.md but is not enabled for it (enabled: none); \`cocheck connector enable notes .notes.md\` switches it`,
  ]);
  assert.equal(r.exitCode, q.exitCode);
  assert.deepEqual(notes(q.stdout), []);
  assert.equal(notes((await runConnectorDoctor(["notes"], { home: h, store: { get: () => null } })).stdout).length, 3);
  // Each note agrees with the matcher: the file on that type is not the connector's; once enabled it is, and the note goes.
  for (const ext of [".csv", ".md", ".notes.md"]) assert.equal(connectorClaimsFor(h)(`/w/a${ext}`), undefined, ext);
  writeFileSync(path.join(h, ENABLED_TYPES_FILE), JSON.stringify({ types: { ".md": "notes" } }));
  assert.equal(connectorClaimsFor(h)("/w/a.md"), "notes");
  assert.equal(notes((await runConnectorDoctor([], { home: h, store: { get: () => null } })).stdout).length, 2);
});

test("`cocheck connector doctor` prints the warning for an unusable setting file, and the exit code is unchanged", async () => {
  const h = home([{ id: "notes", matches: { extensions: [".notes.json"] } }]);
  const before = await runConnectorDoctor([], { home: h, store: { get: () => null } });
  writeFileSync(path.join(h, ENABLED_TYPES_FILE), "{ nope");
  const r = await runConnectorDoctor([], { home: h, store: { get: () => null } });
  assert.match(r.stdout, /warning: .*connector-types\.json is not valid/);
  assert.equal(r.exitCode, before.exitCode);
});

test("`cocheck connector test` prints no reserved-ending warning any more", async () => {
  const r = await runConnectorTest([toy([".level1.notes.json", ".notes.md", ".txt"])], { home: home([]) });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /CoCheck reads|reserved/);
});

test("the warnings use the folder wherever it sits among the options", async () => {
  const dir = toy([".level1.notes.json"]);
  const h = home([{ id: "other", matches: { extensions: [".level1.notes.json"] } }]);
  const after = await runConnectorTest([dir, "--timeout", "5000"], { home: h });
  const before = await runConnectorTest(["--timeout", "5000", dir], { home: h });
  const warnings = (s: string): string[] => s.split("\n").filter((l) => l.startsWith("warning:"));
  assert.equal(warnings(after.stdout).length, 1, after.stdout);
  assert.deepEqual(warnings(before.stdout), warnings(after.stdout));
  assert.equal(before.stdout, after.stdout);
});

test("the spec README states the claim rule and names no reserved endings", () => {
  const spec = readFileSync(path.join(ROOT, "public-kit/spec/README.md"), "utf8");
  const line = spec.split("\n").find((l) => l.includes("`extensions`:"));
  assert.ok(line, "the README's extensions line");
  assert.doesNotMatch(line, /reserved/);
  assert.match(line, /cocheck connector enable/);
});
