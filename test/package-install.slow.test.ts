// Exit (e): `npm pack` the package, lay the tarball out as a global install under a temp prefix with a temp HOME, then run the INSTALLED
// `cocheck connector create` and `cocheck connector test` on the created folder. Declared limit: `npm install` itself needs the registry for the two
// dependencies, so the tarball is unpacked where `npm install -g` puts it (<prefix>/lib/node_modules/cocheck) and the repo's node_modules stands in for the
// dependency tree. Everything that is the package's own (its `files`, dist/, the relative public-kit lookups) is what ships.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

it("the packed tarball installed under a temp prefix runs `connector create` and `connector test` and they pass", { timeout: 600_000 }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cocheck-install-"));
  const home = path.join(tmp, "home"), packDir = path.join(tmp, "pack"), pkg = path.join(tmp, "prefix", "lib", "node_modules", "cocheck");
  for (const d of [home, packDir, pkg]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: path.join(tmp, "cache") };
  const run = (cmd: string, args: string[], cwd: string) => spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 300_000 });
  const packed = run("npm", ["pack", "--pack-destination", packDir], ROOT); // runs prepack (the build)
  assert.equal(packed.status, 0, packed.stderr);
  const tgz = readdirSync(packDir).find((n) => n.endsWith(".tgz"))!;
  const untar = run("tar", ["-xzf", path.join(packDir, tgz), "-C", pkg, "--strip-components=1"], tmp);
  assert.equal(untar.status, 0, untar.stderr);
  // The package as shipped passes the public gate with the committed allow file, which keeps no entry for a dist path: the generated secret-rule
  // table writes its one self-matching literal as two joined strings. Run before node_modules is linked in, so the gate sees only the package.
  const gateEnv: NodeJS.ProcessEnv = { ...env };
  delete gateEnv.COCHECK_GATE_ALLOW;
  const gate = spawnSync(process.execPath, [path.join(ROOT, "scripts", "public-gate.ts"), pkg], { cwd: ROOT, env: gateEnv, encoding: "utf8", timeout: 120_000 });
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /public-gate: clean/);
  const allowLines = readFileSync(path.join(ROOT, "scripts", "public-gate-allow.txt"), "utf8").split("\n");
  assert.deepEqual(allowLines.filter((l) => l.startsWith("dist/")), [], "no allow entry is needed or kept for a dist path");
  symlinkSync(path.join(ROOT, "node_modules"), path.join(pkg, "node_modules"));
  assert.ok(existsSync(path.join(pkg, "public-kit", "scaffold", "template")), "public-kit ships in the package");
  const cocheck = (...args: string[]) => run(process.execPath, [path.join(pkg, "bin", "cocheck.mjs"), ...args], tmp);
  const dir = path.join(tmp, "mc");
  const created = cocheck("connector", "create", dir, "--id", "mc");
  assert.equal(created.status, 0, created.stderr + created.stdout);
  console.log(`installed: cocheck connector create ${dir} --id mc\n${created.stdout}`);
  const tested = cocheck("connector", "test", dir);
  console.log(`installed: cocheck connector test ${dir}\n${tested.stdout}`);
  assert.equal(tested.status, 0, tested.stderr + tested.stdout);
  assert.match(tested.stdout, /passed/);
  // The shipped harness cases run against the installed package, in the temp layout (nothing of the person's own data home is read).
  for (const [cases, extra] of [["cases/claude", []], ["cases/codex", []], ["cases/copilot", []], ["examples/toyagent/cases", ["--manifest", path.join(pkg, "public-kit", "harness", "examples", "toyagent", "cocheck-harness.json")]]] as const) {
    const ran = cocheck("harness", "test", "--cases", path.join(pkg, "public-kit", "harness", cases), ...extra);
    console.log(`installed: cocheck harness test --cases ${cases}\n${ran.stdout}`);
    assert.equal(ran.status, 0, ran.stderr + ran.stdout);
    assert.match(ran.stdout, /cases passed/);
  }
});
