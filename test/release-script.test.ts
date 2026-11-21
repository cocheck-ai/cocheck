// scripts/release.sh on the npm route. Every case runs the real script in a scratch package (its own package.json, lockfile, build script,
// stub public-gate) so npm ci, npm pack and the tarball install run for real with no dependencies and no network. It publishes nothing: no remote exists.
// Covers the helper check too (moved here from the deleted private-route release test, per the kept-module rule: a kept module keeps its tests).
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
// The deny list and the allow file are export-ignored (the deny list names the owner), so a public copy has neither and the gate cannot run.
const NO_LISTS = existsSync(path.join(ROOT, "scripts", "public-denylist.txt")) && existsSync(path.join(ROOT, "scripts", "public-gate-allow.txt")) ? false : "the deny list and allow file are not in a public copy";
const mac = process.platform === "darwin";
const run = (cwd: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const git = (cwd: string, ...args: string[]) => {
  const r = run(cwd, "git", args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

const BUILD = `
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
mkdirSync("dist/helpers", { recursive: true });
mkdirSync("dist/office/connector/helpers", { recursive: true });
writeFileSync("dist/hook.js", "// hook\\n");
if (process.env.STUB_NO_CLI_MAIN !== "1") writeFileSync("dist/cli-main.js", "// cli\\n");
writeFileSync("dist/build-info.json", "{}");
const mode = process.env.HELPER_MODE ?? "both";
if (process.env.FAT && mode !== "off") {
  if (mode !== "missing") copyFileSync(process.env.FAT, "dist/helpers/pdfpages");
  copyFileSync(mode === "thin" ? process.env.THIN : process.env.FAT, "dist/office/connector/helpers/cocheck-screen");
}
`;
const GATE = `
const mode = process.env.GATE_MODE ?? "clean";
if (process.argv[2] === "--git-history") process.exit(0);
console.log("gate-arg " + process.argv[2]);
if (mode === "hit") { console.log("src/x.ts:3: some-rule"); process.exit(1); }
console.log("public-gate: clean (3 files)");
`;
const BIN = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const v = process.env.STUB_VERSION ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
console.log("cocheck " + v);
`;

let fat = "";
let thin = "";
before(() => {
  if (!mac) return;
  const fx = mkdtempSync(path.join(tmpdir(), "cocheck-relfx-"));
  writeFileSync(path.join(fx, "t.c"), "int main(void){return 0;}\n");
  for (const arch of ["arm64", "x86_64"]) assert.equal(run(fx, "clang", ["-arch", arch, "t.c", "-o", arch]).status, 0, `clang ${arch}`);
  assert.equal(run(fx, "lipo", ["-create", "arm64", "x86_64", "-output", "fat"]).status, 0);
  fat = path.join(fx, "fat");
  thin = path.join(fx, "x86_64");
});

interface Scratch { dir: string; out: string; head: string; marker: string }
function scratch(opts: { hookMode?: number; extraFiles?: Record<string, string> } = {}): Scratch {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "cocheck-rel-")));
  const marker = path.join(dir, "..", `marker-${path.basename(dir)}`);
  writeFileSync(marker, "");
  const w = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  w("package.json", JSON.stringify({ name: "cocheck", version: "1.2.3", type: "module", bin: { cocheck: "bin/cocheck.mjs" }, files: ["bin/", "dist/", "scripts/hook-launch.sh", ...Object.keys(opts.extraFiles ?? {})],
    scripts: { typecheck: 'echo typecheck >> "$MARK"', test: 'echo suite >> "$MARK"', build: "node build.mjs" } }, null, 2));
  w("package-lock.json", JSON.stringify({ name: "cocheck", version: "1.2.3", lockfileVersion: 3, requires: true, packages: { "": { name: "cocheck", version: "1.2.3" } } }));
  w(".gitignore", "dist/\nnode_modules/\n");
  w("build.mjs", BUILD);
  w("bin/cocheck.mjs", BIN);
  chmodSync(path.join(dir, "bin", "cocheck.mjs"), 0o755);
  w("scripts/hook-launch.sh", "#!/bin/sh\n");
  w("scripts/public-gate.ts", GATE);
  for (const [rel, text] of Object.entries(opts.extraFiles ?? {})) w(rel, text);
  mkdirSync(path.join(dir, "packaging", "homebrew"), { recursive: true });
  copyFileSync(path.join(ROOT, "scripts", "release.sh"), path.join(dir, "scripts", "release.sh"));
  copyFileSync(path.join(ROOT, "packaging", "homebrew", "cocheck.rb"), path.join(dir, "packaging", "homebrew", "cocheck.rb"));
  chmodSync(path.join(dir, "scripts", "hook-launch.sh"), opts.hookMode ?? 0o755);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.fileMode", "true");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "scratch");
  return { dir, out: path.join(dir, "..", `out-${path.basename(dir)}`), head: git(dir, "rev-parse", "HEAD"), marker };
}
const release = (s: Scratch, version = "1.2.3", env: NodeJS.ProcessEnv = {}) => {
  const r = run(s.dir, "sh", [path.join(s.dir, "scripts", "release.sh"), version], { MARK: s.marker, COCHECK_RELEASE_OUT: s.out, FAT: fat, THIN: thin, COCHECK_RELEASE_REMOTE: "", ...env });
  return { r, text: r.stdout + r.stderr, marks: readFileSync(s.marker, "utf8").split("\n").filter(Boolean) };
};
const writeRecord = (dir: string, sha: string) => {
  const d = path.join(git(dir, "rev-parse", "--absolute-git-dir"), "cocheck-test-pass");
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, sha), "2026-11-18 pass 1\n");
};
const tags = (dir: string) => git(dir, "tag", "-l");

describe("release.sh and COCHECK_GATE_ALLOW", { skip: NO_LISTS }, () => {
  it("a permissive allow file in the caller's environment cannot excuse a planted owner name in the tarball", () => {
    const name = ["To", "mas"].join("");
    const text = `// ${name} said so\n`;
    const s = scratch({ extraFiles: { "notes.txt": text } });
    // The scratch gate is a one-line wrapper over the real gate, so the real denylist and allow logic decide.
    writeFileSync(path.join(s.dir, "scripts", "public-gate.ts"), `import ${JSON.stringify(path.join(ROOT, "scripts", "public-gate.ts"))};\n`);
    git(s.dir, "commit", "-aqm", "real gate");
    const probe = mkdtempSync(path.join(tmpdir(), "cocheck-relprobe-"));
    writeFileSync(path.join(probe, "notes.txt"), text);
    const found = run(ROOT, "node", [path.join(ROOT, "scripts", "public-gate.ts"), probe], { COCHECK_GATE_ALLOW: path.join(probe, "none") }).stdout;
    const rules = [...found.matchAll(/^notes\.txt:1: (DENY-\d+)$/gm)].map((m) => m[1]);
    assert.ok(rules.length > 0, found);
    const permissive = path.join(probe, "permissive.txt");
    writeFileSync(permissive, rules.map((r) => `notes.txt ${r} ${createHash("sha256").update(text).digest("hex")} # permissive\n`).join(""));
    const direct = run(ROOT, "node", [path.join(ROOT, "scripts", "public-gate.ts"), probe], { COCHECK_GATE_ALLOW: permissive });
    assert.equal(direct.status, 0, "the permissive file excuses the name when the gate is called directly");
    const { r, text: out } = release(s, "1.2.3", { COCHECK_GATE_ALLOW: permissive });
    assert.notEqual(r.status, 0, out);
    assert.match(out, /notes\.txt:1: DENY-\d+/);
    assert.equal(tags(s.dir), "");
  });
});

describe("release.sh refusals", () => {
  it("refuses a dirty tree (tracked edit) and runs nothing", () => {
    const s = scratch();
    writeFileSync(path.join(s.dir, "bin", "cocheck.mjs"), BIN + "// edit\n");
    const { r, text, marks } = release(s);
    assert.notEqual(r.status, 0, text);
    assert.match(text, /not clean/);
    assert.deepEqual(marks, []);
    assert.equal(tags(s.dir), "");
  });

  it("refuses an untracked file too", () => {
    const s = scratch();
    writeFileSync(path.join(s.dir, "stray.txt"), "x");
    const { r, text } = release(s);
    assert.notEqual(r.status, 0, text);
    assert.match(text, /not clean/);
  });

  it("refuses unless package.json's version is X.Y.Z, and says to bump and commit first", () => {
    const s = scratch();
    const { r, text, marks } = release(s, "1.2.4");
    assert.notEqual(r.status, 0, text);
    assert.match(text, /package\.json says 1\.2\.3, not 1\.2\.4; bump the version and commit it first/);
    assert.deepEqual(marks, []);
    assert.equal(tags(s.dir), "");
  });
});

describe("release.sh and the suite record", () => {
  it("no record: typecheck and the suite both run, the tag goes on HEAD, and no commit or branch is made", () => {
    const s = scratch();
    const { r, text, marks } = release(s);
    assert.equal(r.status, 0, text);
    assert.deepEqual(marks, ["typecheck", "suite"]);
    assert.equal(git(s.dir, "rev-parse", "v1.2.3^{commit}"), s.head);
    assert.equal(git(s.dir, "rev-parse", "HEAD"), s.head);
    assert.equal(git(s.dir, "rev-list", "--count", "HEAD"), "1");
    assert.equal(git(s.dir, "branch", "--list"), "* main");
    assert.equal(git(s.dir, "ls-files", "dist"), "");
    assert.equal(git(s.dir, "status", "--porcelain"), "");
  });

  it("a record for HEAD: typecheck still runs, the suite is skipped with the sha in the message", () => {
    const s = scratch();
    writeRecord(s.dir, s.head);
    const { r, text, marks } = release(s);
    assert.equal(r.status, 0, text);
    assert.deepEqual(marks, ["typecheck"]);
    assert.ok(text.includes(`release: suite already passed on ${s.head}`), text);
  });

  it("a record for another commit does not skip the suite (the dangerous direction)", () => {
    const s = scratch();
    writeRecord(s.dir, s.head);
    writeFileSync(path.join(s.dir, "more.txt"), "x");
    git(s.dir, "add", "-A");
    git(s.dir, "commit", "-q", "-m", "two");
    const { r, text, marks } = release(s);
    assert.equal(r.status, 0, text);
    assert.deepEqual(marks, ["typecheck", "suite"]);
    assert.doesNotMatch(text, /suite already passed/);
  });

  it("COCHECK_RELEASE_CHECKS overrides, record or not", () => {
    const s = scratch();
    writeRecord(s.dir, s.head);
    const { r, text, marks } = release(s, "1.2.3", { COCHECK_RELEASE_CHECKS: 'echo override >> "$MARK"' });
    assert.equal(r.status, 0, text);
    assert.deepEqual(marks, ["override"]);
  });
});

describe("release.sh on a good release", () => {
  const s = scratch();
  const { r, text } = release(s);
  const tarball = path.join(s.out, "cocheck-1.2.3.tgz");
  it("packs the tarball and the package checks pass, the gate runs on the unpacked package", () => {
    assert.equal(r.status, 0, text);
    assert.ok(existsSync(tarball));
    assert.match(text, /gate-arg .*unpacked[^/]*\/package\s/);
    assert.match(text, /public-gate: clean \(3 files\)/);
  });
  it("writes the formula: npm registry url, the packed file's sha256, MIT, the public homepage, the tap in the header", () => {
    const formula = readFileSync(path.join(s.out, "cocheck.rb"), "utf8");
    const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    assert.match(formula, /^  url "https:\/\/registry\.npmjs\.org\/cocheck\/-\/cocheck-1\.2\.3\.tgz"$/m);
    assert.ok(formula.includes(`sha256 "${sha}"`), formula);
    assert.match(formula, /^  license "MIT"$/m);
    assert.match(formula, /^  homepage "https:\/\/github\.com\/cocheck-ai\/cocheck"$/m);
    assert.match(formula.split("\n").slice(0, 4).join("\n"), /cocheck-ai\/homebrew-tap/);
    assert.doesNotMatch(formula, new RegExp(`${"ano" + "nimation"}|using: :git|revision`));
  });
  it("prints the tag push, `npm publish` of that exact tarball, and the tap copy; it ran none of them", () => {
    assert.ok(text.includes(`npm publish ${tarball}`), text);
    assert.match(text, /git -C .* push \S+ v1\.2\.3/);
    assert.match(text, /cocheck-ai\/homebrew-tap/);
    assert.match(text, /Formula\/cocheck\.rb/);
    assert.match(text, /~\/code\/cocheck-ai\/homebrew-tap/);
    assert.match(text, /gh pr create --repo cocheck-ai\/homebrew-tap/);
    assert.doesNotMatch(text, /git clone|push origin HEAD/);
    assert.equal(run(s.dir, "git", ["remote"]).stdout.trim(), "");
  });
});

describe("release.sh package checks fail the release (no tag)", () => {
  const fails = (label: string, s: Scratch, env: NodeJS.ProcessEnv, expected: RegExp) =>
    it(label, () => {
      const { r, text } = release(s, "1.2.3", env);
      assert.notEqual(r.status, 0, text);
      assert.match(text, expected);
      assert.equal(tags(s.dir), "", "a failed release must not tag");
    });
  fails("the gate reports a hit: exit 1, the hit line shown", scratch(), { GATE_MODE: "hit" }, /src\/x\.ts:3: some-rule/);
  it("a missing public-gate script fails with a message naming it", () => {
    const s = scratch();
    git(s.dir, "rm", "-q", "scripts/public-gate.ts");
    git(s.dir, "commit", "-q", "-m", "no gate");
    const { r, text } = release(s);
    assert.notEqual(r.status, 0, text);
    assert.match(text, /scripts\/public-gate\.ts is missing/);
    assert.equal(tags(s.dir), "");
  });
  it("a tarball with a src/ entry fails", () => {
    const s = scratch({ extraFiles: { "src/leak.ts": "x" } });
    const { r, text } = release(s);
    assert.notEqual(r.status, 0, text);
    assert.match(text, /src\//);
    assert.equal(tags(s.dir), "");
  });
  it("a hook launcher without its exec bit fails", () => {
    const s = scratch({ hookMode: 0o644 });
    const { r, text } = release(s);
    assert.notEqual(r.status, 0, text);
    assert.match(text, /hook-launch\.sh.*executable/);
    assert.equal(tags(s.dir), "");
  });
  it("a tarball missing dist/cli-main.js fails", () => {
    const s = scratch();
    const { r, text } = release(s, "1.2.3", { STUB_NO_CLI_MAIN: "1" });
    assert.notEqual(r.status, 0, text);
    assert.match(text, /dist\/cli-main\.js/);
    assert.equal(tags(s.dir), "");
  });
  it("an installed cocheck that prints another version fails", () => {
    const s = scratch();
    const { r, text } = release(s, "1.2.3", { STUB_VERSION: "9.9.9" });
    assert.notEqual(r.status, 0, text);
    assert.match(text, /prints/);
    assert.equal(tags(s.dir), "");
  });
});

describe("release.sh needs both native helpers as universal binaries", { skip: !mac && "the native helpers are macOS-only" }, () => {
  it("both helpers universal: the release passes", () => {
    const s = scratch();
    const { r, text } = release(s);
    assert.equal(r.status, 0, text);
  });
  for (const [label, mode, expected] of [
    ["a missing helper", "missing", /native helpers incomplete.*pdfpages \(missing\)/],
    ["a single-architecture helper", "thin", /native helpers incomplete.*cocheck-screen \(no arm64\)/],
  ] as const) {
    it(`${label}: fails with one naming line and no tag`, () => {
      const s = scratch();
      const { r, text } = release(s, "1.2.3", { HELPER_MODE: mode });
      assert.notEqual(r.status, 0, text);
      const lines = text.split("\n").filter((l) => /native helpers incomplete/.test(l));
      assert.equal(lines.length, 1, text);
      assert.match(lines[0]!, expected);
      assert.equal(tags(s.dir), "");
    });
  }
});

describe("release.sh judges the whole history before anything runs", { skip: NO_LISTS }, () => {
  // The scratch gate is a wrapper over the real gate, so the real denylist decides. Planted words are built at run time to keep this file gate-clean.
  const realGate = (s: Scratch) => {
    writeFileSync(path.join(s.dir, "scripts", "public-gate.ts"), `import ${JSON.stringify(path.join(ROOT, "scripts", "public-gate.ts"))};\n`);
    git(s.dir, "commit", "-aqm", "use the real gate");
  };
  const commitAs = (dir: string, name: string, message: string, email = "bot@example.com") => {
    writeFileSync(path.join(dir, "extra.txt"), message + name + "\n");
    git(dir, "add", "-A");
    git(dir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", message);
  };
  const refused = (s: Scratch, field: string) => {
    const { r, text, marks } = release(s);
    assert.notEqual(r.status, 0, text);
    assert.match(text, new RegExp(`^[0-9a-f]{8} ${field}: DENY-\\d+$`, "m"));
    assert.match(text, /run the release from the public checkout, not the private repo/);
    assert.equal(text.includes("git -C"), false, "nothing is printed for pushing");
    assert.deepEqual(marks, [], "refused before typecheck, the suite or the build");
    assert.equal(tags(s.dir), "");
    assert.equal(existsSync(s.out), false, "refused before packing");
  };

  it("an owner-named author in an old commit refuses, and names the commit and field but not the name", () => {
    const owner = ["To", "mas"].join("");
    const s = scratch();
    realGate(s);
    commitAs(s.dir, `${owner} Someone`, "ordinary message");
    commitAs(s.dir, "release-bot", "later commit by the bot");
    refused(s, "author-name");
    const { text } = release(s);
    assert.equal(text.includes(owner), false, "the matched text is never printed");
  });

  it("an owner-named committer email refuses", () => {
    const s = scratch();
    realGate(s);
    writeFileSync(path.join(s.dir, "extra.txt"), "x\n");
    git(s.dir, "add", "-A");
    const r = run(s.dir, "git", ["commit", "-q", "-m", "ordinary"], { GIT_COMMITTER_EMAIL: `${["tor", "terola"].join("")}@example.com`, GIT_COMMITTER_NAME: "bot", GIT_AUTHOR_NAME: "bot", GIT_AUTHOR_EMAIL: "bot@example.com" });
    assert.equal(r.status, 0, r.stderr);
    refused(s, "committer-email");
  });

  it("a commit message with a queue id refuses", () => {
    const s = scratch();
    realGate(s);
    commitAs(s.dir, "release-bot", ["T", "123"].join("-") + " fix the thing");
    refused(s, "message");
  });

  // A gate that cannot run says nothing about the commits. Node exits 1 on an uncaught error (a missing import, a bad file), the same code
  // the gate uses for hits, so only hit lines on stdout may make it a verdict on the history.
  const crashed = (gate: string) => {
    const s = scratch();
    writeFileSync(path.join(s.dir, "scripts", "public-gate.ts"), gate);
    git(s.dir, "commit", "-aqm", "a gate that cannot run");
    const { r, text, marks } = release(s);
    assert.notEqual(r.status, 0, text);
    assert.equal(/history holds commits/.test(text), false, `a crash is not reported as refused commits:\n${text}`);
    assert.match(text, /the public gate could not run on the history \(exit [12];/);
    assert.match(text, /not a verdict on the commits/);
    assert.deepEqual(marks, [], "stopped before typecheck, the suite or the build");
    assert.equal(tags(s.dir), "");
    assert.equal(existsSync(s.out), false, "stopped before packing");
  };

  it("a gate that throws as it loads (node's exit 1, no hit lines) is reported as a crash, not as refused commits", () => {
    crashed(`throw new Error("Cannot find package 'fflate'");\n`);
  });

  it("a gate that says it cannot run (exit 2) is reported as a crash", () => {
    crashed(`console.error("public-gate: cannot run: denylist has no patterns"); process.exit(2);\n`);
  });

  it("a bot-only history passes the check and the release is cut", () => {
    const s = scratch();
    realGate(s);
    commitAs(s.dir, "release-bot", "export a snapshot");
    const { r, text } = release(s);
    assert.equal(r.status, 0, text);
    assert.equal(text.includes("public checkout"), false);
    assert.equal(tags(s.dir), "v1.2.3");
  });
});
