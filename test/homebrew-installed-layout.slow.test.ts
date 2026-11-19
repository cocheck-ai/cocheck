// a Homebrew install must run the two commands a new connector author runs first, `cocheck connector create` and `cocheck connector test`.
// 's guard scanned source text for "../" literals; it passed with the formula's public-kit line commented out and missed path.join(here, "..", ...).
// This test runs the real commands instead, from a scratch libexec built from exactly what packaging/homebrew/cocheck.rb's `def install` installs:
// a release tree (this checkout copied to a temp folder, then built there: the npm tarball carries the built dist/) supplies each parsed entry.
// Guards against: a check that passes because a command reads the source tree and not the install. Every path resolves inside the temp folder,
// and the mutation cases prove it: the same assembly with the public-kit entry removed, or commented out, fails the stranger flow.
// Declared limit: `npm ci --omit=dev` needs the registry, so the repo's node_modules is linked in its place (as in).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const FORMULA = readFileSync(path.join(ROOT, "packaging", "homebrew", "cocheck.rb"), "utf8");
const PUBLIC_KIT_LINE = /^\s*libexec\.install "public-kit"\s*$/m;

/** Drops a Ruby comment: the first `#` outside a double-quoted string (so `"#{x}"` stays). */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && quoted) i++;
    else if (c === '"') quoted = !quoted;
    else if (c === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

export interface InstallEntry { from: string; to: string }

/**
 * What `def install` puts into libexec, as release-relative `from` and libexec-relative `to`. Homebrew's `<dir>.install "a/b"` lands at `<dir>/b`;
 * `libexec.install "x"` lands at `libexec/x`, `(libexec/"scripts").install "scripts/h.sh"` at `libexec/scripts/h.sh`. Any other receiver fails loudly,
 * so a new install form gets modelled here rather than silently skipped.
 */
export function parseFormulaInstall(formula: string): InstallEntry[] {
  const body = /^\s*def install\b([\s\S]*?)^\s*end\s*$/m.exec(formula);
  assert.ok(body, "no `def install ... end` block in the formula");
  const entries: InstallEntry[] = [];
  for (const raw of body[1]!.split("\n")) {
    const line = stripComment(raw);
    const call = /^\s*(libexec|\(libexec\/"([^"]+)"\))\.install\s+(.*)$/.exec(line);
    if (!call) {
      assert.ok(!/\.install\b/.test(line), `an install form this test does not model: ${line.trim()}`);
      continue;
    }
    const dir = call[2] ?? "";
    const args = [...call[3]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(args.length > 0, `an install call without quoted arguments: ${line.trim()}`);
    for (const from of args) entries.push({ from, to: path.posix.join(dir, path.posix.basename(from)) });
  }
  return entries;
}

/** Builds a scratch libexec from `entries` taken out of `release`, with node_modules linked; the files a missing entry names are simply absent. */
function assemble(release: string, entries: InstallEntry[], libexec: string): void {
  mkdirSync(libexec, { recursive: true });
  for (const { from, to } of entries) {
    const src = path.join(release, from);
    assert.ok(existsSync(src), `the formula installs ${from}, which a release tree does not have`);
    mkdirSync(path.dirname(path.join(libexec, to)), { recursive: true });
    cpSync(src, path.join(libexec, to), { recursive: true });
  }
  symlinkSync(realpathSync(path.join(ROOT, "node_modules")), path.join(libexec, "node_modules"));
}

interface Flow { created: ReturnType<typeof spawnSync>; tested?: ReturnType<typeof spawnSync>; dir: string }

/** What a stranger runs first, the way the formula's launcher starts the CLI: node <libexec>/dist/cli-main.js, with COCHECK_ROOT set to libexec. */
function strangerFlow(tmp: string, libexec: string, name: string): Flow {
  const home = path.join(tmp, `home-${name}`);
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, COCHECK_NODE: process.execPath, COCHECK_ROOT: libexec };
  const cocheck = (...args: string[]) => spawnSync(process.execPath, [path.join(libexec, "dist", "cli-main.js"), ...args], { cwd: tmp, env, encoding: "utf8", timeout: 120_000 });
  const dir = path.join(tmp, `starter-${name}`);
  const created = cocheck("connector", "create", dir, "--id", "brew.test");
  if (created.status !== 0) return { created, dir };
  return { created, tested: cocheck("connector", "test", dir), dir };
}

const passes = (f: Flow) => f.created.status === 0 && existsSync(path.join(f.dir, "cocheck-connector.json")) && f.tested?.status === 0 && /^passed$/m.test(String(f.tested.stdout));
const show = (f: Flow) => `create exit ${f.created.status}:\n${f.created.stdout}${f.created.stderr}\ntest exit ${f.tested?.status}:\n${f.tested?.stdout ?? ""}${f.tested?.stderr ?? ""}`;

describe("the parser reads the formula's install list", () => {
  it("reads libexec.install and (libexec/...).install, and ignores comment lines and trailing comments", () => {
    const formula = [
      "  def install",
      '    libexec.install "dist" # libexec.install "public-kit"',
      '    # libexec.install "commented"',
      '    (libexec/"scripts").install "scripts/hook-launch.sh"',
      '    libexec.install "a.json", "b"',
      '    (bin/"cocheck").write <<~SH',
      '      exec "#{opt_libexec}/dist/cli-main.js"',
      "    SH",
      "  end",
    ].join("\n");
    assert.deepEqual(parseFormulaInstall(formula), [
      { from: "dist", to: "dist" },
      { from: "scripts/hook-launch.sh", to: "scripts/hook-launch.sh" },
      { from: "a.json", to: "a.json" },
      { from: "b", to: "b" },
    ]);
  });

  it("the real formula installs public-kit, and the line removed or commented out parses to the same list without it", () => {
    assert.match(FORMULA, PUBLIC_KIT_LINE, "the formula's public-kit line changed shape; update the mutation below");
    const real = parseFormulaInstall(FORMULA);
    assert.ok(real.some((e) => e.from === "public-kit"));
    const without = real.filter((e) => e.from !== "public-kit");
    assert.deepEqual(parseFormulaInstall(FORMULA.replace(PUBLIC_KIT_LINE, "")), without);
    assert.deepEqual(parseFormulaInstall(FORMULA.replace(PUBLIC_KIT_LINE, '    # libexec.install "public-kit"')), without);
    assert.deepEqual(parseFormulaInstall(FORMULA.replace(PUBLIC_KIT_LINE, '    libexec.install "package.json" # "public-kit"')).filter((e) => e.from === "public-kit"), []);
  });
});

describe("the formula installs only what the npm tarball carries", () => {
  it("every entry the formula installs is covered by package.json's `files` (or is package.json), and the formula takes no lockfile or src", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    const covered = (from: string) => from === "package.json" || pkg.files.some((f) => !f.startsWith("!") && (f === from || (f.endsWith("/") && (from + "/").startsWith(f)) || from.startsWith(f.endsWith("/") ? f : `${f}/`)));
    const entries = parseFormulaInstall(FORMULA);
    for (const e of entries) assert.ok(covered(e.from), `the formula installs ${e.from}, which the npm tarball does not carry (package.json files: ${pkg.files.join(", ")})`);
    assert.ok(!entries.some((e) => e.from === "package-lock.json" || e.from.startsWith("src")), "the tarball has no lockfile and no src/");
    assert.match(FORMULA, /^\s*url "https:\/\/registry\.npmjs\.org\/cocheck\/-\/cocheck-[0-9.]+\.tgz"$/m);
    assert.doesNotMatch(FORMULA, new RegExp(`using: :git|${"ano" + "nimation"}`));
  });
});

describe("a scratch install built from the formula's install list runs connector create and connector test", { timeout: 900_000 }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cocheck-brew-"));
  const release = path.join(tmp, "release");

  before(() => {
    // The release tree: this checkout's own files (no dist, node_modules, tests or git), built in place as release.sh builds before `npm pack`.
    const skip = new Set(["node_modules", "dist", "test", ".git"]);
    cpSync(ROOT, release, { recursive: true, filter: (src) => path.dirname(src) !== ROOT || !skip.has(path.basename(src)) });
    symlinkSync(realpathSync(path.join(ROOT, "node_modules")), path.join(release, "node_modules"));
    const env = { ...process.env, PATH: `${path.join(release, "node_modules", ".bin")}${path.delimiter}${process.env.PATH}` };
    const built = spawnSync(process.execPath, [path.join(release, "scripts", "build.mjs")], { cwd: release, env, encoding: "utf8", timeout: 600_000 });
    assert.equal(built.status, 0, `the release build failed:\n${built.stdout}${built.stderr}`);
    assert.ok(existsSync(path.join(release, "dist", "cli-main.js")), "the build made no dist/cli-main.js");
  });

  it("the formula's install list: create exits 0 and writes the manifest, test passes", () => {
    const libexec = path.join(tmp, "libexec");
    assemble(release, parseFormulaInstall(FORMULA), libexec);
    const flow = strangerFlow(tmp, libexec, "formula");
    console.log(show(flow));
    assert.ok(passes(flow), show(flow));
    assert.match(String(flow.created.stdout), /Created connector "brew\.test"/);
  });

  // the published helpers are in the install, core's dist resolves them there, and an outside connector loads one
  // through COCHECK_HELPERS_DIR, run by the installed CoCheck. The toy refuses to start without a spec.mjs in that folder, so a checkout path fails it.
  it("the install carries public-kit/helpers, the runner names the installed copy, and the helpers toy passes `connector test` there", () => {
    const libexec = path.join(tmp, "libexec");
    if (!existsSync(libexec)) assemble(release, parseFormulaInstall(FORMULA), libexec);
    for (const f of ["png.mjs", "png.d.mts", "pdf.mjs", "pdf.d.mts", "pdf-text.mjs", "pdf-text.d.mts", "pdf-text-layout.mjs", "pdf-text-layout.d.mts", "spec.mjs", "spec.d.mts"]) assert.ok(existsSync(path.join(libexec, "public-kit", "helpers", f)), f);
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `const r = await import(${JSON.stringify(pathToFileURL(path.join(libexec, "dist", "connector", "runner.js")).href)}); const p = await import(${JSON.stringify(pathToFileURL(path.join(libexec, "dist", "connector", "png-pixels.js")).href)}); const k = await import(r.HELPERS_DIR + "/png.mjs"); console.log(JSON.stringify({ dir: r.HELPERS_DIR, same: p.decodePng === k.decodePng }));`], { encoding: "utf8", timeout: 60_000 });
    assert.equal(probe.status, 0, probe.stderr);
    const got = JSON.parse(probe.stdout.trim()) as { dir: string; same: boolean };
    assert.equal(realpathSync(got.dir), realpathSync(path.join(libexec, "public-kit", "helpers")));
    assert.equal(got.same, true, "dist's decoder is not the installed kit helper");
    const home = path.join(tmp, "home-helpers");
    mkdirSync(home, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, COCHECK_NODE: process.execPath, COCHECK_ROOT: libexec };
    const tested = spawnSync(process.execPath, [path.join(libexec, "dist", "cli-main.js"), "connector", "test", path.join(libexec, "public-kit", "examples", "toy-helpers")], { cwd: tmp, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(tested.status, 0, `${tested.stdout}${tested.stderr}`);
    assert.match(String(tested.stdout), /^passed$/m);
  });

  it("mutation: the formula with its public-kit line removed fails the same flow", () => {
    const libexec = path.join(tmp, "libexec-removed");
    assemble(release, parseFormulaInstall(FORMULA.replace(PUBLIC_KIT_LINE, "")), libexec);
    assert.ok(!existsSync(path.join(libexec, "public-kit")));
    const flow = strangerFlow(tmp, libexec, "removed");
    assert.ok(!passes(flow), `passed without public-kit, so it reads something outside the scratch install:\n${show(flow)}`);
  });

  it("mutation: the formula with its public-kit line commented out fails the same flow", () => {
    const libexec = path.join(tmp, "libexec-commented");
    assemble(release, parseFormulaInstall(FORMULA.replace(PUBLIC_KIT_LINE, '    # libexec.install "public-kit"')), libexec);
    assert.ok(!existsSync(path.join(libexec, "public-kit")));
    const flow = strangerFlow(tmp, libexec, "commented");
    assert.ok(!passes(flow), `passed without public-kit, so it reads something outside the scratch install:\n${show(flow)}`);
  });
});
