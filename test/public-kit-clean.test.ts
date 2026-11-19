// public-kit/ is all an outside contributor sees, so no internal planning text may reach it.
// The scan is case-insensitive: a case variant of a banned name is still planning text. Ordinary words a spec
// needs (drive, layer, format, row, change, rail, task, plan, review) stay allowed on purpose.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public-kit");

// Banned words are joined from parts so this file carries none of them as a literal.
const P = (...parts: string[]): string => parts.join("");

// Every pattern runs with the i flag. Digit-led names use a boundary so ordinary hyphenated words stay clean.
const BANNED: Array<[string, RegExp]> = [
  [P("Tom", "as"), new RegExp(P("tom", "as"), "i")],
  [P("vau", "lt"), new RegExp(P("vau", "lt"), "i")],
  ["1-projects", /1-projects/i],
  ["T-<digits>", /(^|[^a-z0-9])t-\d+/i],
  ["drive <digits>", /drive\s+\d+/i],
  ["queue", /queue/i],
  ["corrector", /corrector/i],
  [P("dangerous", " direction"), /dangerous\s+direction/i],
  ["LayerDiffRow", /layerdiffrow/i],
  ["FormatRow", /formatrow/i],
  ["RailChange", /railchange/i],
];

// Allow-list: kit-relative path (forward slashes) -> banned labels permitted in that file. Empty: nothing is exempt.
const ALLOW: Record<string, string[]> = {};

function walk(dir: string, rel: string[] = []): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const next = [...rel, e.name];
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), next));
    else out.push(next.join("/"));
  }
  return out;
}

export function scan(root: string): string[] {
  const hits: string[] = [];
  for (const rel of walk(root)) {
    const allowed = ALLOW[rel] ?? [];
    // The path itself is public too, so it is scanned along with the content.
    const text = rel + "\n" + readFileSync(path.join(root, ...rel.split("/")), "utf8");
    for (const [label, re] of BANNED) if (re.test(text) && !allowed.includes(label)) hits.push(`${rel}: ${label}`);
  }
  return hits;
}

describe("public kit cleanliness", () => {
  it("the kit skeleton and toy product exist", () => {
    const files = walk(KIT);
    for (const f of ["README.md", "spec/README.md", "scaffold/README.md", "conformance/README.md", "toy-product/README.md", "toy-product/notes-store.mjs"]) {
      assert.ok(files.includes(f), f);
    }
    for (const c of ["create", "edit", "delete", "no-change"]) {
      assert.ok(files.includes(`toy-product/states/${c}.before.json`), c);
      assert.ok(files.includes(`toy-product/states/${c}.after.json`), c);
    }
  });

  it("the toy product's recorded pairs show what each case claims", () => {
    const read = (n: string) => JSON.parse(readFileSync(path.join(KIT, "toy-product", "states", n + ".json"), "utf8")).notes as Array<{ id: string; text: string }>;
    assert.equal(read("create.after").length, read("create.before").length + 1);
    assert.equal(read("delete.after").length, read("delete.before").length - 1);
    assert.notDeepEqual(read("edit.after"), read("edit.before"));
    assert.equal(read("edit.after").length, read("edit.before").length);
    assert.deepEqual(read("no-change.after"), read("no-change.before"));
  });

  it("the kit holds no internal name", () => {
    assert.deepEqual(scan(KIT), []);
  });

  // Guards against planning text reaching the outside reader through a case variant, without banning ordinary words a spec needs.
  it("case variants of every banned name are caught", () => {
    const samples = [P("TOM", "AS"), P("Vau", "lt"), "1-PROJECTS", "t-358", "T-1", "Drive 19", "DRIVE  7", "Queue", "CORRECTOR", P("Dangerous", " Direction"), "layerdiffrow", "FORMATROW", "railChange"];
    for (const s of samples) {
      const dir = mkdtempSync(path.join(tmpdir(), "kit-scan-"));
      writeFileSync(path.join(dir, "x.md"), `plain text ${s} more text\n`);
      assert.notEqual(scan(dir).length, 0, `missed ${s}`);
    }
  });

  it("a banned name in a file name is caught, in a nested folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kit-scan-"));
    cpSync(KIT, dir, { recursive: true });
    writeFileSync(path.join(dir, "spec", `Notes-For-${P("Tom", "as")}.md`), "clean body\n");
    assert.deepEqual(scan(dir), [`spec/Notes-For-${P("Tom", "as")}.md: ${P("Tom", "as")}`]);
  });

  it("ordinary words a spec needs stay clean", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kit-scan-"));
    writeFileSync(
      path.join(dir, "spec.md"),
      "A drive letter, a layer, a format, a row, a change, a rail, a task, a plan, a review, SHA-256, port-1, a to-do list, 5-10 items.\n",
    );
    assert.deepEqual(scan(dir), []);
  });

  it("the scan reads a copy of the real kit as clean, then fails once a banned string is planted", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kit-scan-"));
    cpSync(KIT, dir, { recursive: true });
    assert.deepEqual(scan(dir), []);
    writeFileSync(path.join(dir, "toy-product", "README.md"), `Tracked in T-358, see the ${P("Vau", "lt")}.\n`);
    assert.deepEqual(scan(dir), [`toy-product/README.md: ${P("vau", "lt")}`, "toy-product/README.md: T-<digits>"]);
  });
});
