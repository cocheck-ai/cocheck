// the Homebrew formula installed dist/ without public-kit/, so `cocheck connector create` from a brew install died with ENOENT.
// replaced this file's source-text scanner with test/homebrew-installed-layout.slow.test.ts, which runs the real commands from a libexec
// built from the formula's install list. What stays here is the fast pin on the formula's own `test do` block: it runs the same two commands on
// the installed formula, and its lines must survive release.sh's rewrite of the url and sha256 lines.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const formulaPath = path.join(repo, "packaging", "homebrew", "cocheck.rb");

describe("Homebrew formula's test block", () => {
  it("creates a connector into testpath, asserts its manifest, runs connector test on it, and survives release.sh's rewrite", () => {
    const formula = readFileSync(formulaPath, "utf8");
    const block = /^  test do\n([\s\S]*?)^  end$/m.exec(formula);
    assert.ok(block, "no `test do` block");
    const manifest = /const MANIFEST = "([^"]+)"/.exec(readFileSync(path.join(repo, "src", "connector-create.ts"), "utf8"))![1]!;
    const create = /system bin\/"cocheck", "connector", "create", testpath\/"([^"]+)", "--id", "[^"]+"/.exec(block[1]!);
    assert.ok(create, `no \`connector create\` into testpath in:\n${block[1]}`);
    assert.ok(block[1]!.includes(`assert_path_exists testpath/"${create[1]}/${manifest}"`), `no manifest assertion in:\n${block[1]}`);
    assert.ok(
      block[1]!.includes(`assert_match(/^passed$/, shell_output("#{bin}/cocheck connector test #{testpath}/${create[1]}"))`),
      `no \`connector test\` on the created connector in:\n${block[1]}`,
    );
    // release.sh rewrites only lines starting "  url " and "  sha256 " (two-space indent); the block's lines must not match either.
    const release = readFileSync(path.join(repo, "scripts", "release.sh"), "utf8");
    assert.ok(release.includes('-e "s|^\\(  url \\).*|') && release.includes('-e "s|^  sha256 .*|'), "release.sh's formula rewrite changed; recheck this test");
    for (const line of block[1]!.split("\n")) assert.ok(!/^  (url|sha256) /.test(line), `release.sh would rewrite: ${line}`);
  });
});
