// CORE_DRAWN_TYPES holds the types core draws itself plus whatever the shipped built-in manifests claim. The
// expected set is read here from the shipped connectors/*/cocheck-connector.json files, so a change to a manifest moves the expectation too (
// the first version compared to a hardcoded copy of the old list).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { BUILTIN_CONNECTORS_ROOT, builtinTypesOf, shippedBuiltinTypes } from "../src/connector/builtins.ts";
import { CORE_DRAWN_TYPES, coreDraws, stateOf, type Claimant } from "../src/connector/enabled-types.ts";

// What core draws itself, by ending (no Office format: those come from the manifests).
const CORE_OWN = [".txt", ".md", ".csv", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".heic", ".tif", ".tiff", ".bmp", ".webp"];

async function shippedManifestTypes(): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(BUILTIN_CONNECTORS_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const m = JSON.parse(await readFile(path.join(BUILTIN_CONNECTORS_ROOT, d.name, "cocheck-connector.json"), "utf8")) as { matches?: { extensions?: string[] } };
    out.push(...(m.matches?.extensions ?? []).map((e) => e.toLowerCase()));
  }
  return out;
}

describe("the types the built-ins hold come from their manifests", () => {
  it("the set is the core's own types plus every extension the shipped manifest files claim", async () => {
    const claimed = await shippedManifestTypes();
    assert.ok(claimed.length > 0, "the shipped manifests claim something");
    assert.deepEqual([...CORE_DRAWN_TYPES].sort(), [...new Set([...CORE_OWN, ...claimed])].sort());
    assert.deepEqual([...shippedBuiltinTypes()].sort(), [...new Set(claimed)].sort());
  });
  it("a manifest change moves the set: a folder claiming .zzz adds .zzz, a folder that does not read adds nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "derived-"));
    const dir = path.join(root, "toy");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "toy", version: "1.0.0", entry: "state", matches: { extensions: [".ZZZ", ".zzy"] }, run: ["node", "c.mjs"] }));
    assert.deepEqual([...builtinTypesOf([{ id: "toy", dir }, { id: "gone", dir: path.join(root, "gone") }])].sort(), [".zzy", ".zzz"]);
  });
  it("every shipped-manifest type: an installed connector claiming it alone starts disabled (served already), with or without a built-in beside it; a type no one serves goes to the installed one", async () => {
    const claimed = [...new Set(await shippedManifestTypes())];
    const types = [...claimed, ...CORE_OWN, ".foo", "x"];
    const installed: Claimant = { id: "mine", builtin: false, types: [...types, ".notes.md"] };
    const builtin: Claimant = { id: "shipped", builtin: true, types: claimed };
    for (const t of claimed) {
      assert.equal(coreDraws(t), true, t);
      assert.equal(stateOf(t, [installed], { types: {} }).enabled, undefined, `${t}: installed alone`);
      assert.equal(stateOf(t, [builtin, installed], { types: {} }).enabled, "shipped", `${t}: built-in beside`);
    }
    assert.equal(stateOf(".foo", [installed], { types: {} }).enabled, "mine");
    assert.equal(coreDraws(".notes.md"), true, "a longer ending of a served type");
    assert.equal(stateOf(".foo", [installed], { types: { ".foo": null } }).enabled, undefined);
  });
});
