// the notices name every shipped third-party piece with the licence and copyright line read from its source.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");
const notices = read("THIRD_PARTY_NOTICES.md");

describe("third-party notices", () => {
  it("each entry's copyright line matches the file it cites", () => {
    const cases: Array<[string, string, string]> = [
      ["Copyright (c) 2019 Zachary Rice", "vendor/gitleaks/LICENSE", "Gitleaks"],
      ["Copyright (c) 2017 Amit Kumar Gupta", "node_modules/fast-xml-parser/LICENSE", "fast-xml-parser"],
      ["Copyright (c) 2026 Arjun Barrett", "node_modules/fflate/LICENSE", "fflate"],
    ];
    for (const [line, src, name] of cases) {
      assert.ok(notices.includes(name), name);
      assert.ok(notices.includes(line), `${name}: ${line} missing from the notices`);
      assert.ok(read(...src.split("/")).includes(line), `${src} no longer carries: ${line}`);
    }
    assert.ok(read("node_modules", "pdfjs-dist", "legacy", "build", "pdf.min.mjs").includes("Copyright 2024 Mozilla Foundation"));
    assert.ok(notices.includes("Copyright 2024 Mozilla Foundation"));
    assert.ok(notices.includes("Apache License 2.0"));
  });
  it("package.json ships the notices and names repository, homepage and bugs", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.files.includes("THIRD_PARTY_NOTICES.md"));
    assert.ok(pkg.files.includes("dist/"));
    assert.equal(pkg.repository.url, "git+https://github.com/cocheck-ai/cocheck.git");
    assert.equal(pkg.bugs.url, "https://github.com/cocheck-ai/cocheck/issues");
    assert.match(pkg.homepage, /^https:\/\/github\.com\/cocheck-ai\/cocheck/);
    assert.equal(pkg.license, "MIT");
    assert.equal(pkg.private, undefined);
    assert.equal("author" in pkg, false, "the owner stays anonymous");
  });
  it("the formula needs macOS and its caveats name `cocheck install --home`", () => {
    const rb = read("packaging", "homebrew", "cocheck.rb");
    assert.match(rb, /^ {2}depends_on :macos$/m);
    assert.match(rb, /def caveats[\s\S]*cocheck install --home/);
  });
});
