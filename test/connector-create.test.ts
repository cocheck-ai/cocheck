// `cocheck connector create <dir> --id <id>` copies public-kit/scaffold/template.
// Must not happen: overwriting a contributor's existing files (covered by "refuses a folder that has files ..." tests), versus refusing a fresh or empty folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.ts";
import { runConnectorCreate } from "../src/connector-create.ts";
import { validateConnector } from "../src/connector/validate.ts";

const scratch = () => mkdtempSync(path.join(tmpdir(), "connector-create-"));

describe("connector create", () => {
  it("a missing folder gets the starter, the id filled in, and the next two commands printed", () => {
    const dir = path.join(scratch(), "mine");
    const r = runConnectorCreate([dir, "--id", "my.notes_1"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(readdirSync(dir).sort(), ["README.md", "cocheck-connector.json", "connector.mjs"]);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "cocheck-connector.json"), "utf8")).id, "my.notes_1");
    assert.match(r.stdout, /connector\.mjs/);
    assert.ok(r.stdout.includes(`cocheck connector test ${dir}`));
  });

  it("an empty existing folder is accepted", () => {
    const dir = scratch();
    assert.equal(runConnectorCreate([dir, "--id", "x"]).exitCode, 0);
    assert.ok(existsSync(path.join(dir, "connector.mjs")));
  });

  it("the fresh scaffold passes validateConnector against the kit's toy states", async () => {
    const dir = path.join(scratch(), "fresh");
    assert.equal(runConnectorCreate([dir, "--id", "fresh-one"]).exitCode, 0);
    const result = await validateConnector({ dir });
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  });

  it("must not: refuses a folder that has files, writes nothing, leaves the files as they were", () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "connector.mjs"), "my own work\n");
    const r = runConnectorCreate([dir, "--id", "x"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /Nothing was written/);
    assert.deepEqual(readdirSync(dir), ["connector.mjs"]);
    assert.equal(readFileSync(path.join(dir, "connector.mjs"), "utf8"), "my own work\n");
  });

  it("must not: a folder holding only a hidden file or a subfolder still counts as not empty", () => {
    for (const make of [(d: string) => writeFileSync(path.join(d, ".keep"), ""), (d: string) => mkdirSync(path.join(d, "sub"))]) {
      const dir = scratch();
      make(dir);
      const before = readdirSync(dir);
      assert.equal(runConnectorCreate([dir, "--id", "x"]).exitCode, 1);
      assert.deepEqual(readdirSync(dir), before);
    }
  });

  it("refuses a path that is a file, writing nothing", () => {
    const file = path.join(scratch(), "f.txt");
    writeFileSync(file, "keep\n");
    assert.equal(runConnectorCreate([file, "--id", "x"]).exitCode, 1);
    assert.equal(readFileSync(file, "utf8"), "keep\n");
  });

  it("refuses an id that fails the id rule, and creates no folder", () => {
    for (const id of ["", "-lead", ".dot", "has space", "a/b", "ünï", "a:b"]) {
      const dir = path.join(scratch(), "never");
      const r = runConnectorCreate([dir, "--id", id]);
      assert.equal(r.exitCode, 1, `id ${JSON.stringify(id)}`);
      assert.equal(existsSync(dir), false);
    }
  });

  it("refuses a missing id or a missing folder argument", () => {
    const dir = path.join(scratch(), "never");
    assert.equal(runConnectorCreate([dir]).exitCode, 1);
    assert.equal(runConnectorCreate(["--id", "x"]).exitCode, 1);
    assert.equal(existsSync(dir), false);
  });

  // A Homebrew install shipped without public-kit, so the starter folder was absent and create died with a raw ENOENT.
  it("must not: a missing starter folder is exit 1, one plain sentence naming it, and nothing written", () => {
    const template = path.join(scratch(), "no-such-template");
    const fresh = path.join(scratch(), "never");
    const empty = scratch();
    for (const dir of [fresh, empty]) {
      let r: ReturnType<typeof runConnectorCreate> | undefined;
      assert.doesNotThrow(() => { r = runConnectorCreate([dir, "--id", "x"], { template }); });
      assert.equal(r!.exitCode, 1);
      assert.equal(r!.stdout, "");
      const lines = r!.stderr.trimEnd().split("\n");
      assert.equal(lines.length, 1, r!.stderr);
      assert.ok(lines[0]!.includes(template), r!.stderr);
      assert.match(lines[0]!, /starter/);
      assert.doesNotMatch(r!.stderr, /ENOENT|\bat .+:\d+:\d+|Error:/);
      assert.equal((lines[0]!.match(/[.!?](\s|$)/g) ?? []).length, 1, `one sentence: ${r!.stderr}`);
    }
    assert.equal(existsSync(fresh), false);
    assert.deepEqual(readdirSync(empty), []);
  });

  it("is reachable as `cocheck connector create`", async () => {
    const dir = path.join(scratch(), "viacli");
    const r = await main(["connector", "create", dir, "--id", "via-cli"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(existsSync(path.join(dir, "cocheck-connector.json")));
    assert.match((await main(["--help"])).stdout + (await main(["bogus"])).stderr, /connector create <dir> --id <id>/);
  });

  // The spec says an empty file is a state that did not exist, not a broken file.
  describe("empty state files", () => {
    const toy = JSON.stringify({ notes: [{ id: "n1", text: "hello" }] });
    const ask = (before: string, after: string) => {
      const dir = path.join(scratch(), "fresh");
      assert.equal(runConnectorCreate([dir, "--id", "fresh-one"]).exitCode, 0);
      const b = path.join(dir, "x.before.json");
      const a = path.join(dir, "x.after.json");
      writeFileSync(b, before);
      writeFileSync(a, after);
      const r = spawnSync("node", [path.join(dir, "connector.mjs")], { input: JSON.stringify({ id: 1, method: "diff", params: { before: b, after: a } }) + "\n", encoding: "utf8", timeout: 10000 });
      return JSON.parse(r.stdout.trim().split("\n")[0]);
    };
    it("an empty before is an added change with no before", () => {
      const r = ask("", toy);
      assert.equal(r.error, undefined);
      assert.deepEqual(r.result.changes.map((c: any) => [c.mark, c.before, c.after]), [["added", undefined, "hello"]]);
    });
    it("an empty after is a removed change with no after", () => {
      const r = ask(toy, "  \n");
      assert.equal(r.error, undefined);
      assert.deepEqual(r.result.changes.map((c: any) => [c.mark, c.before, c.after]), [["removed", "hello", undefined]]);
    });
    it("both empty is an empty list", () => {
      const r = ask("", "");
      assert.equal(r.error, undefined);
      assert.deepEqual(r.result.changes, []);
    });
    it("must not: a non-empty file that does not parse still answers with an error", () => {
      const r = ask('{"notes": [', toy);
      assert.equal(r.result, undefined);
      assert.equal(r.error.code, "bad-product-response");
    });
  });
});
