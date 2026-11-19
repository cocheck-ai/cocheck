import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { macOnly } from "./helpers/platform.ts";

// The full suite once popped "keychain not found" dialogs, because a child process with its own env (a temp HOME, no test markers)
// reached the real /usr/bin/security. The recorder below stands in for that binary (COCHECK_REAL_SECURITY_PATH) and for a PATH lookup, so a
// regression fails this test instead of touching the Keychain.

const SEAL = path.resolve(import.meta.dirname, "..", "src", "seal.ts");
const CHILD = `
import { setKeyProvider, writeSealed } from ${JSON.stringify(SEAL)};
setKeyProvider(null);
try { await writeSealed(process.argv[1], Buffer.from("x")); console.log("WROTE"); } catch (e) { console.log(e.code ?? String(e)); }
`;
const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});

async function rig() {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-s006-"));
  cleanups.push(dir);
  const log = path.join(dir, "calls.log");
  const recorder = path.join(dir, "bin", "security");
  await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(recorder)));
  await writeFile(recorder, `#!/bin/sh\necho "$0 $*" >> '${log}'\nexit 1\n`);
  await chmod(recorder, 0o755);
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim() : "");
  const run = (env: Record<string, string>) => {
    const target = path.join(dir, "sealed");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD, target], {
      encoding: "utf8",
      env: { PATH: path.dirname(recorder), COCHECK_REAL_SECURITY_PATH: recorder, ...env },
    });
    return { out: r.stdout.trim(), err: r.stderr, wrote: existsSync(target) };
  };
  return { dir, recorder, calls, run };
}

describe("the real `security` is never spawned from a test child", macOnly("the macOS `security` tool and Keychain"), () => {
  it("a clean env with a temp HOME and no markers raises KEY_MISSING and records no call", async () => {
    const t = await rig();
    const r = t.run({ HOME: t.dir, COCHECK_HOME: path.join(t.dir, "home") });
    assert.equal(r.out, "KEY_MISSING", r.err);
    assert.equal(r.wrote, false);
    assert.equal(await t.calls(), "");
  });

  it("no HOME at all is refused too", async () => {
    const t = await rig();
    const r = t.run({ COCHECK_HOME: path.join(t.dir, "home") });
    assert.equal(r.out, "KEY_MISSING", r.err);
    assert.equal(await t.calls(), "");
  });

  it("a test marker refuses even with the account's real HOME", async () => {
    const t = await rig();
    const r = t.run({ HOME: userInfo().homedir, COCHECK_TEST_NO_OFFICE: "1", COCHECK_HOME: path.join(t.dir, "home") });
    assert.equal(r.out, "KEY_MISSING", r.err);
    assert.equal(await t.calls(), "");
  });

  it("the real tool is still used for the account's real HOME with no marker (the recorder sees the call)", async () => {
    const t = await rig();
    t.run({ HOME: userInfo().homedir, COCHECK_HOME: path.join(t.dir, "home") });
    assert.match(await t.calls(), /find-generic-password/);
  });

  it("a stand-in named by COCHECK_SECURITY_BIN is used in a clean env with a temp HOME", async () => {
    const t = await rig();
    const bin = process.env.COCHECK_SECURITY_BIN;
    assert.ok(bin, "the bootstrap sets COCHECK_SECURITY_BIN");
    // The stand-in is a shell script that needs the base tools to keep the key; the recorder stays first on PATH, so a lookup of `security` by name still reaches it.
    const r = t.run({ HOME: t.dir, COCHECK_SECURITY_BIN: bin, COCHECK_HOME: path.join(t.dir, "home"), PATH: `${path.dirname(t.recorder)}:/usr/bin:/bin` });
    assert.equal(r.out, "WROTE", r.err);
    assert.equal(await t.calls(), "");
  });

  it("the installer's self-check passes in production mode (no markers, real HOME) and never reaches the Keychain (canary: it goes red if the check's hook ever needs a key)", async () => {
    const t = await rig();
    const hook = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
    const code = `import { hookFires } from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "src", "install.ts"))};
console.log("RESULT:" + String(hookFires(${JSON.stringify(path.resolve(import.meta.dirname, "..", "scripts", "hook-launch.sh"))}, ${JSON.stringify(hook)}, { PATH: ${JSON.stringify(`${path.dirname(t.recorder)}:${path.dirname(process.execPath)}:/usr/bin:/bin`)} })));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { PATH: `${path.dirname(t.recorder)}:${path.dirname(process.execPath)}:/usr/bin:/bin`, COCHECK_REAL_SECURITY_PATH: t.recorder, HOME: userInfo().homedir },
    });
    assert.match(r.stdout, /RESULT:undefined/, `${r.stdout}${r.stderr}`);
    assert.equal(await t.calls(), "");
  });
});
