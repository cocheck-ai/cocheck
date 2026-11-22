import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { END, readmeIsCurrent, renderAgents, START, withBlock } from "../scripts/readme-agents.ts";

const ROOT = path.join(import.meta.dirname, "..");

// The README's "Supported agents" table is generated from the harness manifests. Editing a manifest (a name, a tested version, a new harness)
// without `node scripts/readme-agents.ts --write` fails here.
describe("README supported agents", () => {
  it("matches the harness manifests", () => {
    assert.equal(readmeIsCurrent(ROOT), true, "run: node scripts/readme-agents.ts --write");
  });
  it("lists the built-ins and the kit harnesses, and no Gemini", () => {
    const block = renderAgents(ROOT);
    for (const name of ["Claude Code", "Codex", "Copilot", "Cursor", "Antigravity CLI"]) assert.match(block, new RegExp(`\\| ${name} \\|`));
    assert.doesNotMatch(block, /Gemini/);
  });
  it("notices a changed manifest in a scratch copy", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "readme-agents-"));
    try {
      await cp(path.join(ROOT, "harnesses"), path.join(dir, "harnesses"), { recursive: true });
      await cp(path.join(ROOT, "public-kit", "harness", "harnesses"), path.join(dir, "public-kit", "harness", "harnesses"), { recursive: true });
      await writeFile(path.join(dir, "README.md"), withBlock(await readFile(path.join(ROOT, "README.md"), "utf8"), renderAgents(dir)));
      assert.equal(readmeIsCurrent(dir), true);
      const file = path.join(dir, "harnesses", "codex", "cocheck-harness.json");
      await writeFile(file, (await readFile(file, "utf8")).replace('"testedVersions": [', '"testedVersions": ["9.9.9", '));
      assert.equal(readmeIsCurrent(dir), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses a README without the markers", () => {
    assert.throws(() => withBlock("no markers", `${START}\n${END}`), /no supported-agents markers/);
  });
});
