// An outsider harness may declare `readsForeignHooks` and `foreignHookFingerprint` (Cursor runs the hooks of ~/.claude/settings.json). Its fingerprint makes another
// host's hook skip a payload only while the outsider's own CoCheck hook is installed for the payload's folder; otherwise the payload is recorded as before.
// The payloads are what Cursor 3.31.15 passed to CoCheck's Claude hook "from claude-user config" in a live run (Cursor's own hooks log), scrubbed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { journalRecords, makeRig, type Rig } from "./hook-corpus.ts";
import { findProfile, loadOutsiderHarnesses, runsOtherHostsHook } from "../src/hosts/index.ts";
import { installStatus } from "../src/install.ts";
import { matchesFingerprint } from "../src/hosts/shared.ts";

const KIT = path.resolve(import.meta.dirname, "..", "public-kit", "harness", "harnesses");
const SAMPLE = path.join(import.meta.dirname, "fixtures", "cursor", "claude-user-hook-payloads.jsonl");
const samples = (folder: string): Array<Record<string, unknown>> =>
  readFileSync(SAMPLE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l.replaceAll("<folder>", folder)).stdin);

const rigs: Rig[] = [];
afterEach(async () => {
  loadOutsiderHarnesses(undefined);
  for (const r of rigs.splice(0)) await r.cleanup();
});
const rig = async () => {
  const r = await makeRig();
  rigs.push(r);
  return r;
};

/** Writes Cursor's project hooks.json with CoCheck's entries, as a person following `cocheck install --for cursor` would. `drop`: events left out. */
function installCursor(folder: string, home: string, drop: string[] = []): string {
  loadOutsiderHarnesses(KIT);
  const install = findProfile("cursor")!.install!;
  const file = install.configFile({}, "/nonexistent-home", folder);
  mkdirSync(path.dirname(file), { recursive: true });
  const text = install.addHooks("", file, { dataHome: home, launcher: "/opt/cocheck/scripts/hook-launch.sh", hookPath: "/opt/cocheck/dist/hook.js", host: "cursor" });
  const json = JSON.parse(text);
  for (const e of drop) delete json.hooks[e];
  writeFileSync(file, JSON.stringify(json, null, 2));
  return file;
}

/** Fires every sample through the Claude hook (the claude-user registration Cursor runs) and returns the journal lines written. */
async function fireAsClaude(r: Rig): Promise<number> {
  for (const payload of samples(r.folder)) {
    const res = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder], env: { COCHECK_HOME: r.home, COCHECK_HARNESS_DIR: KIT, HOME: path.join(r.home, "user") }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() });
    assert.equal(res.exitCode, 0, res.stderr);
  }
  return journalRecords(r.home).length;
}

describe("an outsider's foreign-hook fingerprint", () => {
  it("the Cursor manifest loads as an outsider with readsForeignHooks and a fingerprint every sample matches", () => {
    const errors = loadOutsiderHarnesses(KIT);
    assert.deepEqual(errors, []);
    const cursor = findProfile("cursor")!;
    assert.equal(cursor.trust, "outsider");
    assert.equal(cursor.capabilities.readsForeignHooks, true);
    const fp = cursor.foreignHookFingerprint!;
    const live = samples("/work");
    assert.ok(live.length >= 5);
    for (const p of live) assert.equal(matchesFingerprint(fp, p), true, String(p.hook_event_name));
    // Claude Code's own payloads, Copilot's runs of Claude hooks and Cursor's own recording: only Cursor's carry the marker
    const lines = (f: string) => readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const claude = lines("platforms/claude-code/versions/2.1.302/payloads.jsonl").map((r) => JSON.parse(r.stdin));
    const copilot = lines("platforms/copilot-cli/versions/1.0.98/hook-calls-pascal.jsonl").map((r) => r.stdin);
    assert.ok(claude.length > 0 && copilot.length > 0);
    for (const p of [...claude, ...copilot]) assert.equal(matchesFingerprint(fp, p), false);
    const own = lines("public-kit/harness/harnesses/cursor/recordings/payloads.jsonl").map((r) => JSON.parse(r.stdin));
    for (const p of own) assert.equal(matchesFingerprint(fp, p), true, "Cursor's own payload has the same shape (its own hook is never skipped: it reads foreign hooks)");
  });

  it("a Cursor payload reaching the Claude hook is skipped when Cursor's CoCheck hook is installed for that folder", async () => {
    const r = await rig();
    installCursor(r.folder, r.home);
    assert.equal(await fireAsClaude(r), 0, "nothing journaled under the Claude hook");
  });

  it("the same payloads are recorded when Cursor's hook is not installed", async () => {
    const r = await rig();
    assert.ok((await fireAsClaude(r)) > 0, "recorded as before");
  });

  it("are recorded when Cursor's hook is installed only in another folder, or with an event missing", async () => {
    const r = await rig();
    const other = mkdtempSync(path.join(tmpdir(), "cocheck-other-"));
    installCursor(other, r.home);
    assert.ok((await fireAsClaude(r)) > 0, "another folder's install does not count");
    const r2 = await rig();
    installCursor(r2.folder, r2.home, ["stop"]);
    assert.ok((await fireAsClaude(r2)) > 0, "a config that no longer carries every event is not installed");
  });

  it("a fingerprint from an uninstalled outsider has no effect; built-in fingerprints are unchanged", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-toy-"));
    const cursorManifest = JSON.parse(readFileSync(path.join(KIT, "cursor", "cocheck-harness.json"), "utf8"));
    // a toy outsider whose fingerprint matches every Claude Code payload
    const toy = { ...cursorManifest, key: "toyreader", displayName: "Toy", chip: "T", foreignHookFingerprint: { present: ["session_id"], strings: [], absent: [] }, install: { ...cursorManifest.install, hostFlag: "toyreader", path: "{project}/.toy/hooks.json" } };
    mkdirSync(path.join(dir, "toyreader"));
    writeFileSync(path.join(dir, "toyreader", "cocheck-harness.json"), JSON.stringify(toy));
    assert.deepEqual(loadOutsiderHarnesses(dir), []);
    const folder = mkdtempSync(path.join(tmpdir(), "cocheck-f-"));
    const claudeCode = { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "/x.jsonl", cwd: folder, workspace_roots: [folder], permission_mode: "default", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "ls" } };
    const where = { env: {}, userHome: "/nonexistent-home" };
    assert.equal(runsOtherHostsHook("claude", claudeCode, where), false, "uninstalled: no effect");
    assert.equal(runsOtherHostsHook("claude", claudeCode), false, "no install context: an outsider never decides");
    // Copilot's built-in fingerprint still decides on shape alone, with or without the install context
    const copilotRun = { hook_event_name: "PreToolUse", session_id: "s", timestamp: "2026-10-24T22:02:21.589Z", cwd: "/w", tool_name: "Bash", tool_input: {} };
    assert.equal(runsOtherHostsHook("claude", copilotRun), true);
    assert.equal(runsOtherHostsHook("claude", copilotRun, where), true);
  });

  it("cocheck status lists the fingerprint in force: the Claude hook skips payloads from Cursor", async () => {
    const r = await rig();
    const userHome = path.join(r.home, "user");
    mkdirSync(path.join(userHome, ".config", "cocheck"), { recursive: true });
    const record = { home: r.home, hookPath: "/opt/cocheck/dist/hook.js", launcher: "/opt/cocheck/scripts/hook-launch.sh", settingsFile: path.join(userHome, ".claude", "settings.json"), backupFile: "", hosts: [], folder: r.folder, createdDirs: [], installedAt: "2026-11-22T00:00:00.000Z" };
    writeFileSync(path.join(userHome, ".config", "cocheck", "install.json"), JSON.stringify(record));
    const env = { COCHECK_HARNESS_DIR: KIT, PATH: process.env.PATH };
    assert.doesNotMatch(installStatus(env, userHome, () => undefined as never).text, /skips payloads from/);
    const file = installCursor(r.folder, r.home);
    assert.match(installStatus(env, userHome, () => undefined as never).text, new RegExp(`  Claude hook skips payloads from Cursor \\(its CoCheck hook is in ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\n`));
  });
});
