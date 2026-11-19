import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// `brew install` failed with "Expected to find class Cocheck, but only found: CoCheck." Homebrew derives the class name from the file name.
const repo = path.resolve(import.meta.dirname, "..");
const file = "cocheck.rb";

// Homebrew's Formulary.class_s: capitalize the first letter, drop each "-" and capitalize the letter after it. Nothing else is lowercased or raised.
function homebrewClassName(fileName: string): string {
  const stem = fileName.replace(/\.rb$/, "");
  return stem.replace(/(^|-)([a-z0-9])/g, (_m, _dash, ch: string) => ch.toUpperCase()).replace(/-/g, "");
}

describe("Homebrew formula class name", () => {
  it("the rule maps cocheck to Cocheck and cases the dash form", () => {
    assert.equal(homebrewClassName("cocheck.rb"), "Cocheck");
    assert.equal(homebrewClassName("my-tool.rb"), "MyTool");
  });

  it("packaging/homebrew/cocheck.rb declares the class Homebrew expects, compared case-sensitively", () => {
    const src = readFileSync(path.join(repo, "packaging", "homebrew", file), "utf8");
    const m = /^class (\S+) < Formula\s*$/m.exec(src);
    assert.ok(m, "no `class X < Formula` line");
    assert.equal(m[1], homebrewClassName(file));
    assert.notEqual(m[1], "CoCheck");
  });
});
