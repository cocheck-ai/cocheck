// `cocheck connector list|enable|disable|test|auth|doctor` act on the data folder the hooks and the review process use: the one
// `cocheck install --home` recorded, unless COCHECK_HOME is set. They once read only COCHECK_HOME or ~/.cocheck, a folder the installer refuses
// as a home, so an outside connector copied where the docs said never loaded and `enable` wrote a setting nothing read.
// Every folder here is a fresh temp dir; HOME points at one, so even a regression to ~/.cocheck lands in scratch, never the real home.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { main } from "../src/cli.ts";
import { ENABLED_TYPES_FILE } from "../src/connector/enabled-types.ts";

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, COCHECK_HOME: process.env.COCHECK_HOME, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT };
const dirs: string[] = [];
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (tag: string): string => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `cocheck-${tag}-`)));
  dirs.push(d);
  return d;
};

/** A user HOME whose install record names `dataHome`, which holds one installed connector claiming `.zzq`; COCHECK_HOME unset. */
function installedUser(): { userHome: string; dataHome: string } {
  const userHome = scratch("user");
  const dataHome = scratch("data");
  const dir = path.join(dataHome, "connectors", "my-connector");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "my-connector", version: "0.0.1", entry: "state", matches: { extensions: [".zzq"] }, run: ["node", "c.mjs"], credentials: [], platforms: ["darwin", "win32", "linux"] }));
  mkdirSync(path.join(userHome, ".config", "cocheck"), { recursive: true });
  writeFileSync(path.join(userHome, ".config", "cocheck", "install.json"), JSON.stringify({ home: dataHome, hookPath: "/x/hook.mjs", launcher: "/x/launch.sh", settingsFile: "/x/settings.json", hosts: [], createdDirs: [], folder: userHome, installedAt: "2026-01-01T00:00:00.000Z" }));
  process.env.HOME = userHome;
  process.env.USERPROFILE = userHome;
  delete process.env.COCHECK_HOME;
  // The test-runner guard in resolveCoCheckHome would throw before any fallback is reached; off, so a fallback lands in scratch HOME/.cocheck.
  delete process.env.NODE_TEST_CONTEXT;
  return { userHome, dataHome };
}

test("connector list and enable act on the install record's data folder when COCHECK_HOME is unset", async () => {
  const { userHome, dataHome } = installedUser();
  const listed = await main(["connector", "list"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.match(listed.stdout, /\.zzq: claimed by my-connector/);
  const enabled = await main(["connector", "enable", "my-connector", ".zzq"]);
  assert.equal(enabled.exitCode, 0, enabled.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(dataHome, ENABLED_TYPES_FILE), "utf8")).types[".zzq"], "my-connector");
  assert.equal(existsSync(path.join(userHome, ".cocheck")), false);
});

test("COCHECK_HOME, when set, still wins over the install record", async () => {
  const { dataHome } = installedUser();
  const other = scratch("other");
  process.env.COCHECK_HOME = other;
  const listed = await main(["connector", "list"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /my-connector/);
  assert.equal(existsSync(path.join(dataHome, ENABLED_TYPES_FILE)), false);
});
