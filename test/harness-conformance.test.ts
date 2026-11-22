import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHarnessCommand } from "../src/harness-cmd/index.ts";
import { checkCaseShape } from "../src/harness-cmd/test.ts";
import { extras, outsiderSafeExtra } from "../src/hosts/extras.ts";

const ROOT = path.join(import.meta.dirname, "..");
const KIT = path.join(ROOT, "public-kit", "harness");
const TOY = path.join(KIT, "examples", "toyagent");

async function harnessTest(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHarnessCommand(["test", ...args], { out: (l) => out.push(l), err: (l) => err.push(l), env: process.env });
  return { code, out, err };
}

const scratch = (): string => mkdtempSync(path.join(tmpdir(), "cocheck-harness-test-"));
const jsonFiles = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith(".json")).sort();

describe("the harness spec", () => {
  const spec = readFileSync(path.join(KIT, "spec", "v1.md"), "utf8");
  it("names every manifest field, kind, class, capability and outsider-safe extra", () => {
    const src = readFileSync(path.join(ROOT, "src", "hosts", "manifest.ts"), "utf8");
    const block = readFileSync(path.join(ROOT, "src", "hosts", "install-block.ts"), "utf8");
    const names = new Set<string>();
    // Every quoted list in the validator is a list of field names (the top level, each `only(...)`, the install members, the per-kind lists).
    for (const m of src.matchAll(/\[((?:"[A-Za-z-]+"(?:, ?)?)+)\]/g)) for (const n of m[1]!.matchAll(/"([A-Za-z-]+)"/g)) names.add(n[1]!);
    for (const table of ["KINDS", "CLASSES", "CAPS"]) {
      const body = new RegExp(`const ${table}: [^=]+= \\{([^}]*)\\}`).exec(src)?.[1] ?? "";
      for (const m of body.matchAll(/(?:"([A-Za-z-]+)"|([A-Za-z]+)):/g)) names.add((m[1] ?? m[2])!);
    }
    const iface = /export interface JsonInstallBlock \{([\s\S]*?)\n\}/.exec(block)?.[1] ?? "";
    for (const m of iface.matchAll(/^  (\w+)\??:/gm)) names.add(m[1]!);
    for (const name of Object.keys(extras())) if (outsiderSafeExtra(name)) names.add(name);
    assert.ok(names.size > 100, `read ${names.size} names from the sources`);
    for (const required of ["schema", "toolClasses", "tool-failure", "never-credited", "readsForeignHooks", "windowsCommandKey", "closingWaitMs", "whenMatches", "perAction", "editorExtra"]) assert.ok(names.has(required), `the extraction sees ${required}`);
    const missing = [...names].filter((n) => !spec.includes(`\`${n}\``));
    assert.deepEqual(missing, [], "these names are not in public-kit/harness/spec/v1.md (in backticks)");
  });
});

describe("cocheck harness test", () => {
  for (const key of ["claude", "codex", "copilot"]) {
    it(`passes the shipped ${key} cases, each of which credits a file`, { timeout: 300_000 }, async () => {
      const dir = path.join(KIT, "cases", key);
      const r = await harnessTest(["--cases", dir]);
      assert.equal(r.code, 0, r.out.join("\n"));
      assert.equal(r.out.filter((l) => l.startsWith("pass ")).length, jsonFiles(dir).length, r.out.join("\n"));
      for (const f of jsonFiles(dir)) {
        const c = checkCaseShape(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
        assert.equal(typeof c, "object", String(c));
        if (typeof c === "string") continue;
        assert.equal(c.harness, key);
        assert.ok(Object.values(c.expect.credit).some((x) => x.creditedTo.startsWith("call:")), `${f} credits a file`);
        assert.doesNotMatch(JSON.stringify(c), /\/Users\/|\/var\/folders|\/private\//, `${f} holds no machine path`);
      }
    });
  }

  it("passes the toy example against its own manifest", { timeout: 300_000 }, async () => {
    const r = await harnessTest(["--cases", path.join(TOY, "cases"), "--manifest", TOY]);
    assert.equal(r.code, 0, r.out.join("\n"));
    assert.match(r.out.join("\n"), /pass {2}write-notes\.json \(toyagent L2\)/);
  });

  it("passes the Cursor cases against its manifest from the kit, from a real recording", { timeout: 300_000 }, async () => {
    const dir = path.join(KIT, "harnesses", "cursor");
    const r = await harnessTest(["--cases", path.join(dir, "cases"), "--manifest", dir]);
    assert.equal(r.code, 0, r.out.join("\n"));
    assert.equal(r.out.filter((l) => l.startsWith("pass ")).length, jsonFiles(path.join(dir, "cases")).length, r.out.join("\n"));
    for (const f of jsonFiles(path.join(dir, "cases"))) assert.doesNotMatch(readFileSync(path.join(dir, "cases", f), "utf8"), /\/Users\/|\/var\/folders|\/private\//, `${f} holds no machine path`);
  });

  it("passes the Antigravity CLI cases against its manifest from the kit, from real recordings", { timeout: 300_000 }, async () => {
    const dir = path.join(KIT, "harnesses", "antigravity");
    const r = await harnessTest(["--cases", path.join(dir, "cases"), "--manifest", dir]);
    assert.equal(r.code, 0, r.out.join("\n"));
    assert.equal(r.out.filter((l) => l.startsWith("pass ")).length, jsonFiles(path.join(dir, "cases")).length, r.out.join("\n"));
    for (const f of jsonFiles(path.join(dir, "cases"))) assert.doesNotMatch(readFileSync(path.join(dir, "cases", f), "utf8"), /\/Users\/|\/var\/folders|\/private\//, `${f} holds no machine path`);
  });

  it("a harness that is not built in needs its manifest", async () => {
    const r = await harnessTest(["--cases", path.join(TOY, "cases")]);
    assert.equal(r.code, 1);
    assert.match(r.out.join("\n"), /FAIL.*not a built-in harness: pass --manifest/);
  });

  it("a manifest passed for a built-in harness's case is not used, and says so", { timeout: 300_000 }, async () => {
    const r = await harnessTest(["--cases", path.join(KIT, "cases", "claude"), "--manifest", TOY]);
    assert.equal(r.code, 0, r.out.join("\n"));
    assert.match(r.err.join("\n"), /claude is a built-in harness: its built-in profile is used, not the manifest at .*cocheck-harness\.json/);
  });

  it("a changed expected credit fails with a readable message", { timeout: 300_000 }, async () => {
    const dir = scratch();
    const c = JSON.parse(readFileSync(path.join(KIT, "cases", "claude", "shell-writes-file.json"), "utf8"));
    c.expect.credit["totals.csv"].creditedTo = "call:toolu_someone_else";
    writeFileSync(path.join(dir, "mutated.json"), JSON.stringify(c));
    const r = await harnessTest(["--cases", dir]);
    assert.equal(r.code, 1);
    assert.match(r.out.join("\n"), /FAIL {2}mutated\.json \(claude L2\): file totals\.csv: expected credit to call:toolu_someone_else, got call:toolu_01ETFzqqLkCPkAoHJsF7gBuA/);
    assert.match(r.out.join("\n"), /1 of 1 cases failed/);
  });

  it("a credit basis the harness cannot earn fails", { timeout: 300_000 }, async () => {
    const dir = scratch();
    const c = JSON.parse(readFileSync(path.join(TOY, "cases", "write-notes.json"), "utf8"));
    c.expect.credit["notes.txt"].basis = "host-reported-edit";
    writeFileSync(path.join(dir, "strong.json"), JSON.stringify(c));
    const r = await harnessTest(["--cases", dir, "--manifest", TOY]);
    assert.equal(r.code, 1);
    assert.match(r.out.join("\n"), /expected credit basis host-reported-edit, got inferred/);
  });

  it("a manifest with an event mapped to the wrong kind fails a case", { timeout: 300_000 }, async () => {
    const dir = scratch();
    const manifest = JSON.parse(readFileSync(path.join(TOY, "cocheck-harness.json"), "utf8"));
    manifest.events.afterTool = "tool-pre";
    writeFileSync(path.join(dir, "cocheck-harness.json"), JSON.stringify(manifest));
    const r = await harnessTest(["--cases", path.join(TOY, "cases"), "--manifest", dir]);
    assert.equal(r.code, 1);
    assert.match(r.out.join("\n"), /FAIL {2}write-notes\.json \(toyagent L2\): call 3 \(afterTool\): normalized event kind: expected "tool-post", got "tool-pre"/);
  });

  it("a tool missing from toolClasses is unknown and still credited by inference; listed as never-credited it is not (spec/v1.md, \"Tools\")", { timeout: 300_000 }, async () => {
    const kit = path.join(KIT, "harnesses", "antigravity");
    const helperCase = path.join(kit, "cases", "helper-writes-file.json");
    for (const [entry, credited] of [[undefined, true], [{ class: "never-credited" }, false]] as const) {
      const dir = path.join(scratch(), "antigravity");
      (await import("node:fs")).mkdirSync(dir);
      const manifest = JSON.parse(readFileSync(path.join(kit, "cocheck-harness.json"), "utf8"));
      if (entry === undefined) delete manifest.toolClasses.write_file;
      else manifest.toolClasses.write_file = entry;
      writeFileSync(path.join(dir, "cocheck-harness.json"), JSON.stringify(manifest));
      const r = await harnessTest(["--cases", helperCase, "--manifest", dir]);
      if (credited) assert.equal(r.code, 0, r.out.join("\n"));
      else assert.match(r.out.join("\n"), /FAIL {2}helper-writes-file\.json \(antigravity L1\): file helper\.txt: expected credit to call:call_11463291596007606126, but no state was recorded for it/);
    }
  });

  it("a manifest that does not load is said in plain words", async () => {
    const dir = scratch();
    const manifest = JSON.parse(readFileSync(path.join(TOY, "cocheck-harness.json"), "utf8"));
    manifest.events.afterTool = "tool-pree";
    writeFileSync(path.join(dir, "cocheck-harness.json"), JSON.stringify(manifest));
    const r = await harnessTest(["--cases", path.join(TOY, "cases"), "--manifest", dir]);
    assert.equal(r.code, 1);
    assert.match(r.out.join("\n"), /the manifest did not load: .*events\.afterTool: unknown kind "tool-pree"/);
  });

  it("an outsider manifest is held to the outsider rules (a tagged shell call is refused)", async () => {
    const dir = scratch();
    const manifest = JSON.parse(readFileSync(path.join(TOY, "cocheck-harness.json"), "utf8"));
    manifest.capabilities = { argvTag: true };
    writeFileSync(path.join(dir, "cocheck-harness.json"), JSON.stringify(manifest));
    const r = await harnessTest(["--cases", path.join(TOY, "cases"), "--manifest", dir]);
    assert.equal(r.code, 1);
    assert.match(r.out.join("\n"), /only a built-in host can tag a shell call/);
  });

  it("a case that credits no file and does not say why is refused", () => {
    const c = JSON.parse(readFileSync(path.join(TOY, "cases", "write-notes.json"), "utf8"));
    c.expect.credit = {};
    assert.match(String(checkCaseShape(c)), /holds no credited file/);
    c.description = "Level L0: a session only, so no credit is possible.";
    assert.equal(typeof checkCaseShape(c), "object");
    c.expect.credit = { "notes.txt": { creditedTo: "unattributed", basis: "inferred" } };
    c.description = "x";
    assert.match(String(checkCaseShape(c)), /holds no credited file/);
  });

  it("a case cannot write or read outside the task folder", () => {
    const c = JSON.parse(readFileSync(path.join(TOY, "cases", "write-notes.json"), "utf8"));
    c.files.writes[0].path = "../escape.txt";
    assert.match(String(checkCaseShape(c)), /files\.writes\[0\]\.path/);
    c.files.writes[0].path = "/etc/passwd";
    assert.match(String(checkCaseShape(c)), /files\.writes\[0\]\.path/);
    const d = JSON.parse(readFileSync(path.join(TOY, "cases", "write-notes.json"), "utf8"));
    d.files.before = { "../x": "y" };
    assert.match(String(checkCaseShape(d)), /files\.before/);
  });

  it("never reads or writes the data home it was started with, nor the Keychain", { timeout: 300_000 }, async () => {
    const real = scratch();
    const marker = path.join(real, "marker.txt");
    writeFileSync(marker, "keep");
    const saved = { COCHECK_HOME: process.env.COCHECK_HOME, HOME: process.env.HOME, COCHECK_HARNESS_DIR: process.env.COCHECK_HARNESS_DIR };
    process.env.COCHECK_HOME = real;
    process.env.COCHECK_HARNESS_DIR = path.join(real, "harnesses");
    try {
      const r = await harnessTest(["--cases", path.join(KIT, "cases", "claude")]);
      assert.equal(r.code, 0, r.out.join("\n"));
      assert.deepEqual(readdirSync(real), ["marker.txt"], "the started-with home holds only what it held");
      assert.equal(process.env.COCHECK_HOME, real, "the environment is put back");
      assert.equal(process.env.HOME, saved.HOME);
      assert.equal(process.env.COCHECK_HARNESS_DIR, path.join(real, "harnesses"));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("names no harness in src/harness-cmd/: its folders come from the profiles", () => {
    const dir = path.join(ROOT, "src", "harness-cmd");
    const hits: string[] = [];
    for (const f of readdirSync(dir)) {
      readFileSync(path.join(dir, f), "utf8").split("\n").forEach((l, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
        if (/\b(claude|codex|copilot|gemini)/i.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`);
      });
    }
    assert.deepEqual(hits, []);
  });

  it("asks for what it needs", async () => {
    assert.equal((await harnessTest([])).code, 1);
    assert.equal((await harnessTest(["--cases", path.join(scratch(), "nope")])).code, 1);
    const out: string[] = [];
    assert.equal(await runHarnessCommand(["bogus"], { out: () => {}, err: (l) => out.push(l), env: process.env }), 1);
    assert.match(out.join("\n"), /unknown harness command "bogus"/);
  });

  it("the package ships the harness kit", () => {
    const files = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).files as string[];
    assert.ok(files.includes("public-kit/"));
    assert.ok(!files.some((f) => f.startsWith("!public-kit/harness")), "nothing of the harness kit is excluded");
  });
});
