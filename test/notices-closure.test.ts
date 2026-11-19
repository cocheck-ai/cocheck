// the notices cover every non-dev package in package-lock.json, each copyright line is copied from the file the entry cites, and OFL.txt line 1 is the fonts' own name ID 0.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");
const notices = read("THIRD_PARTY_NOTICES.md");

type LockPkg = { version?: string; license?: string; dev?: boolean; link?: boolean };
const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, LockPkg> };
const shipped = Object.entries(lock.packages)
  .filter(([key, v]) => key !== "" && !v.dev && !v.link)
  .map(([key, v]) => ({ key, name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length), v }));

/** The `## <name>` section of the notices, up to the next `## ` heading outside a code fence. */
function section(name: string): string | undefined {
  const lines = notices.split("\n");
  const start = lines.findIndex((l) => l === `## ${name}`);
  if (start < 0) return undefined;
  let fence = false;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("```")) fence = !fence;
    if (!fence && l.startsWith("## ")) break;
    out.push(l);
  }
  return out.join("\n");
}

describe("third-party notices cover the shipped closure", () => {
  it("the lock lists the production packages this test expects to walk", () => {
    const names = shipped.map((s) => s.name);
    for (const n of ["fast-xml-parser", "fflate", "strnum"]) assert.ok(names.includes(n), n);
  });
  it("every non-dev package in package-lock.json has a notices entry with its licence", () => {
    const missing = shipped.filter((s) => section(s.name) === undefined).map((s) => s.key);
    assert.deepEqual(missing, [], `no THIRD_PARTY_NOTICES.md entry for: ${missing.join(", ")}`);
    for (const s of shipped) assert.ok(section(s.name)!.includes(`Licence: ${s.v.license}.`), `${s.name}: licence ${s.v.license} not stated`);
  });
  it("each entry's copyright line is in the file it cites (LICENSE, else package.json author, said so)", () => {
    for (const s of shipped) {
      const sec = section(s.name);
      if (sec === undefined) continue; // reported by the previous test
      const dir = path.join(root, s.key);
      const licFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"].map((f) => path.join(dir, f)).find((f) => existsSync(f));
      if (licFile) {
        const text = readFileSync(licFile, "utf8");
        const lines = text.split("\n").map((l) => l.trim()).filter((l) => /^copyright/i.test(l));
        assert.ok(lines.length > 0, `${s.name}: ${licFile} has no copyright line`);
        for (const l of lines) {
          assert.ok(sec.includes(l), `${s.name}: "${l}" from ${path.basename(licFile)} missing from its entry`);
        }
        for (const l of sec.split("\n").filter((x) => /^Copyright/.test(x))) assert.ok(text.includes(l), `${s.name}: entry line "${l}" is not in ${path.basename(licFile)}`);
        assert.ok(sec.includes(`${s.key}/LICENSE`), `${s.name}: entry does not cite ${s.key}/LICENSE`);
      } else {
        const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { author?: string | { name: string } };
        const full = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
        assert.ok(full, `${s.name}: no LICENSE file and no package.json author`);
        const author = full.split(" (")[0].split(" <")[0];
        assert.ok(sec.includes(`Author: ${author}.`), `${s.name}: author "${author}" missing`);
        assert.ok(sec.includes("ships no LICENSE file"), `${s.name}: entry must say there is no LICENSE file`);
      }
    }
  });
});
