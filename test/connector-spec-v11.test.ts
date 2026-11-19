// Connector spec v1.1, the general optional fields. Must not happen: (1) an installed connector gains a type CoCheck draws itself without the user enabling it (by a manifest that
// claims to be built-in), (2) a looksSame box over differing pixels passes level 3.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorTest } from "../src/connector-test-cli.ts";
import { checkChanges, MAX_PENDING_RETRY, PICTURE_FLAGS, STATUS_KINDS } from "../src/connector/changes-v1.ts";
import { gradeLevel } from "../src/connector/conformance.ts";
import { connectorClaimsFor } from "../src/connector/installed-match.ts";
import { checkManifest } from "../src/connector/schema.ts";
import { png } from "./helpers/png-writer.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = (): string => mkdtempSync(path.join(tmpdir(), "cocheck-"));

/** One document using every general field. */
export const ALL_FIELDS = {
  spec: "cocheck.changes/1",
  status: { kind: "hang", evidence: "no answer after 30 s" },
  pendingRetry: 3,
  pictures: [
    { id: "b1", side: "before", type: "image", src: "b.png", width: 8, height: 8, label: "p1", page: 1, pageCount: 2, renderedBy: { tool: "renderer", version: "1.2", os: "linux" }, status: { kind: "unavailable", evidence: "" } },
    { id: "a1", side: "after", type: "image", src: "a.png", width: 8, height: 8, label: "p1", page: 1, pageCount: 2, hidden: true },
  ],
  changes: [
    { id: "c1", mark: "changed", label: "p1", before: "x", after: "y", boxes: [{ picture: "a1", rect: { x: 0, y: 0, w: 4, h: 4 } }] },
    { id: "c2", mark: "described", label: "p1 reflow", causedBy: "c1", boxes: [{ picture: "a1", rect: { x: 4, y: 4, w: 4, h: 4 }, looksSame: true }] },
  ],
};

test("a document using every general field is valid at level 3, and the same document without them (an old one) still is", () => {
  assert.deepEqual(checkChanges(ALL_FIELDS, 3), []);
  const old = { spec: "cocheck.changes/1", changes: [{ id: "c", mark: "added", label: "x" }] };
  assert.deepEqual(checkChanges(old, 1), []);
  assert.deepEqual(checkManifest({ spec: "cocheck.connector/1", id: "a", version: "1", entry: "state", matches: { extensions: [".a.json"] }, run: ["node", "c.mjs"], requires: { binaries: ["git"], session: "desktop" } }), []);
  assert.deepEqual(checkManifest({ spec: "cocheck.connector/1", id: "a", version: "1", entry: "state", matches: { extensions: [".a.json"] }, run: ["node", "c.mjs"], requires: { binaries: ["git"] } }), []);
});

test("each general field rejects a wrong value, naming its path", () => {
  const bad = (patch: (d: typeof ALL_FIELDS) => void, field: string): void => {
    const d = structuredClone(ALL_FIELDS);
    patch(d);
    assert.ok(checkChanges(d, 3).some((p) => p.field === field), `${field}: ${JSON.stringify(checkChanges(d, 3))}`);
  };
  bad((d) => { (d.status as { kind: string }).kind = "slow"; }, "status.kind");
  bad((d) => { (d.status as { evidence: unknown }).evidence = 5; }, "status.evidence");
  bad((d) => { d.pendingRetry = MAX_PENDING_RETRY + 1; }, "pendingRetry");
  bad((d) => { d.pendingRetry = 0; }, "pendingRetry");
  bad((d) => { (d.pictures[0]!.renderedBy as { os: unknown }).os = ""; }, "pictures[0].renderedBy.os");
  bad((d) => { (d.pictures[0] as { page: unknown }).page = 0; }, "pictures[0].page");
  bad((d) => { (d.pictures[0] as { pageCount: unknown }).pageCount = 0; }, "pictures[0].pageCount");
  bad((d) => { (d.pictures[1] as { hidden: unknown }).hidden = false; }, "pictures[1].hidden");
  bad((d) => { (d.changes[1] as { causedBy: unknown }).causedBy = "nope"; }, "changes[1].causedBy");
  bad((d) => { (d.changes[1] as { causedBy: unknown }).causedBy = "c2"; }, "changes[1].causedBy");
  bad((d) => { (d.changes[1]!.boxes![0] as { looksSame: unknown }).looksSame = false; }, "changes[1].boxes[0].looksSame");
  assert.ok(checkManifest({ spec: "cocheck.connector/1", id: "a", version: "1", entry: "state", matches: { extensions: [".a.json"] }, run: ["node", "c.mjs"], requires: { session: "console" } }).some((p) => p.field === "requires.session"));
});

test("grep: no general field name or value names Office, Excel, Word or PowerPoint", () => {
  const names = ["status", "pendingRetry", "renderedBy", "session", "page", "pageCount", "causedBy", "looksSame", "hidden", ...STATUS_KINDS, ...PICTURE_FLAGS, "desktop", "tool", "version", "os", "evidence"];
  for (const n of names) assert.doesNotMatch(n, /office|excel|word|powerpoint/i, n);
  const spec = readFileSync(path.join(ROOT, "public-kit/spec/v1.md"), "utf8");
  const section = spec.slice(spec.indexOf("## General fields (v1.1)"), spec.indexOf("## Manifest additions"));
  assert.ok(section.length > 200);
  assert.doesNotMatch(section, /office|excel|\bword\b|powerpoint/i);
});

// ---- guarded case 1: types CoCheck draws itself (claims plus the enabled-per-type rule replaced the reserved endings) ----

function install(home: string, id: string, extensions: string[], extra: Record<string, unknown> = {}): void {
  const dir = path.join(home, "connectors", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, version: "0.0.1", entry: "state", matches: { extensions }, run: ["node", "c.mjs"], ...extra }));
}

test("must not: by default an installed connector never gets a type CoCheck draws itself, even a manifest that claims to be built-in", () => {
  const home = scratch();
  const claims: Array<[string, Record<string, unknown>]> = [
    ["plain", {}], ["says-builtin", { builtin: true, builtIn: true, source: "builtin", producer: "builtin", by: "cocheck", reserved: true }], ["says-name", { name: "CoCheck", author: "cocheck" }],
  ];
  for (const [id, extra] of claims) install(home, id, [".xlsx", ".docx", ".md", ".CSV", ".report.pdf", ".mine.json"], extra);
  const claim = connectorClaimsFor(home);
  for (const f of ["a.xlsx", "a.docx", "a.md", "a.csv", "x.report.pdf", "a.PPTX"]) assert.equal(claim(f), undefined, f);
  assert.equal(claim("x.mine.json"), "plain"); // a type nothing served goes to a claimant; the first folder by name wins the tie
});

test("a built-in connector, named by CoCheck's own code and not by a manifest, is enabled from the start for the types it claims", () => {
  const home = scratch();
  install(home, "thief", [".xlsx"]);
  const claim = connectorClaimsFor(home, [{ id: "builtin-sheets", extensions: [".xlsx", ".xlsm"] }]);
  assert.equal(claim("book.xlsx"), "builtin-sheets");
  assert.equal(claim("book.xlsm"), "builtin-sheets");
  assert.equal(claim("a.docx"), undefined);
});

// ---- guarded case 2: looksSame ----

const doc = (looksSame: boolean | undefined) => ({
  spec: "cocheck.changes/1",
  pictures: [
    { id: "b", side: "before", type: "image", src: "b.png", width: 8, height: 8, label: "p" },
    { id: "a", side: "after", type: "image", src: "a.png", width: 8, height: 8, label: "p" },
  ],
  changes: [{ id: "c", mark: "described", label: "p", boxes: [{ picture: "a", rect: { x: 0, y: 0, w: 4, h: 4 }, ...(looksSame === undefined ? {} : { looksSame }) }] }],
});
function pair(afterPaint: (x: number, y: number) => [number, number, number]): string {
  const dir = scratch();
  writeFileSync(path.join(dir, "b.png"), png(8, 8, () => [10, 20, 30]));
  writeFileSync(path.join(dir, "a.png"), png(8, 8, afterPaint));
  return dir;
}
const g = (d: unknown, dir: string) => gradeLevel([d, d], { level: 3, beforeText: "", afterText: "", dir });

test("must not: looksSame over identical pixels passes level 3 without a demotion warning", () => {
  const r = g(doc(true), pair(() => [10, 20, 30]));
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.passed, 3);
});

test("must not: a looksSame box over differing pixels fails level 3", () => {
  const r = g(doc(true), pair((x, y) => (x < 2 && y < 2 ? [200, 0, 0] : [10, 20, 30])));
  assert.equal(r.passed, 2);
  assert.match(r.failures.join("\n"), /looksSame is true but the before and after pixels under the box differ/);
});

test("looksSame is not accepted when the pixels cannot be compared (no readable pictures, or a grid box)", () => {
  const empty = scratch();
  const r = g(doc(true), empty);
  assert.match(r.failures.join("\n"), /looksSame cannot be accepted/);
  const grid = { spec: "cocheck.changes/1", pictures: [{ id: "g", side: "after", type: "grid", rows: 3, cols: 3 }], changes: [{ id: "c", mark: "described", label: "g", boxes: [{ picture: "g", cell: "A1", looksSame: true }] }] };
  assert.match(g(grid, empty).failures.join("\n"), /looksSame needs a pixel picture/);
});

test("without looksSame the default rule stands: a box over identical pixels is demoted, over differing pixels it passes", () => {
  assert.match(g(doc(undefined), pair(() => [10, 20, 30])).warnings.join("\n"), /may not point at a real change/);
  assert.equal(g(doc(undefined), pair((x, y) => (x < 2 && y < 2 ? [200, 0, 0] : [10, 20, 30]))).passed, 3);
});

// ---- requires ----

test("`cocheck connector test` reports unverified, and runs nothing, when requires.session is unmet; it grades normally when met", async () => {
  const dir = scratch();
  cpSync(path.join(ROOT, "public-kit/examples/toy-level-1"), dir, { recursive: true });
  const mf = path.join(dir, "cocheck-connector.json");
  const m = JSON.parse(readFileSync(mf, "utf8")) as Record<string, unknown>;
  writeFileSync(mf, JSON.stringify({ ...m, requires: { session: "desktop" } }));
  const saved = process.env["COCHECK_SESSION"];
  try {
    process.env["COCHECK_SESSION"] = "headless";
    const r = await runConnectorTest([dir]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /^unverified: requires\.session "desktop"/m);
    assert.doesNotMatch(r.stdout, /passed/);
    process.env["COCHECK_SESSION"] = "desktop";
    const ok = await runConnectorTest([dir]);
    assert.equal(ok.exitCode, 0, ok.stdout);
    assert.match(ok.stdout, /^level 1 passed$/m);
    // a binary that is not on PATH is unmet too
    writeFileSync(mf, JSON.stringify({ ...m, requires: { binaries: ["cocheck-no-such-binary"] } }));
    const nb = await runConnectorTest([dir]);
    assert.equal(nb.exitCode, 1);
    assert.match(nb.stdout, /^unverified: requires\.binaries "cocheck-no-such-binary"/m);
  } finally {
    if (saved === undefined) delete process.env["COCHECK_SESSION"]; else process.env["COCHECK_SESSION"] = saved;
  }
});
