import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStatus, runInstall, ageText } from "../src/install.ts";
import { runTrack } from "../src/cli.ts";
import { platformFor } from "../src/platform/index.ts";

// the install, status, track and uninstall lines read right on darwin and win32 (the platform injected; temp HOME only, never the real one).
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const NO_HOST_VARS = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, COPILOT_HOME: undefined };
async function rig(platform: string, hostDirs = [".claude"]) {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const userHome = path.join(sandbox, "home");
  mkdirSync(userHome);
  for (const h of hostDirs) mkdirSync(path.join(userHome, h));
  writeFileSync(path.join(userHome, ".claude", "settings.json"), "{}\n");
  const folder = path.join(sandbox, "work");
  mkdirSync(folder);
  const dataHome = path.join(sandbox, "data");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome, ...NO_HOST_VARS };
  const run = (argv: string[]) => runInstall({ argv: ["node", "install.ts", ...argv], env, cwd: sandbox, hookPath, platform, stopReview: async () => "none", hookFires: () => undefined });
  return { userHome, folder, dataHome, env, run, plat: platformFor(platform) };
}

for (const platform of ["darwin", "win32"] as const) {
  const win = platform === "win32";
  describe(`${platform}`, () => {
    it("install output: a requirement line, no measured-elsewhere timing", async () => {
      const r = await rig(platform);
      const res = await r.run(["--home", r.dataHome, "--folder", r.folder, "--for", "claude"]);
      assert.equal(res.exitCode, 0, res.stderr);
      assert.match(res.stdout, /Needs Node 22\.18 or newer/);
      assert.doesNotMatch(res.stdout, /(Mac|Windows) only/);
      assert.doesNotMatch(res.stdout, /hook-timing/);
      if (win) {
        assert.doesNotMatch(res.stdout, /457/);
        assert.match(res.stdout, /no timing has been measured on Windows/);
      } else {
        assert.match(res.stdout, /median: 457 ms, measured on a Mac/);
      }
    });

    it("status: the last hook run is an age, with the version when the line carries one; not-installed gives the install command", async () => {
      const r = await rig(platform);
      const none = installStatus(r.env, r.userHome, undefined, r.plat).text;
      assert.match(none, /Run: cocheck install --home <dir> --for <host>/);
      assert.doesNotMatch(none, /scripts\/install\.ts/);
      assert.equal((await r.run(["--home", r.dataHome, "--folder", r.folder, "--for", "claude"])).exitCode, 0);
      const j = path.join(r.dataHome, "journal");
      mkdirSync(j, { recursive: true });
      const at = new Date(Date.now() - 9 * 3_600_000 - 60_000).toISOString();
      writeFileSync(path.join(j, "s.jsonl"), `${JSON.stringify({ v: 1, k: "event", host: "claude", event: "PreToolUse", at, version: "0.1.20" })}\n`);
      const text = installStatus(r.env, r.userHome, undefined, r.plat).text;
      assert.match(text, /hooks last fired 9 h ago \(.*\), by CoCheck 0\.1\.20/);
      assert.doesNotMatch(text, /recently|not in the last 24 hours/);
      writeFileSync(path.join(j, "s.jsonl"), `${JSON.stringify({ v: 1, k: "event", host: "claude", event: "PreToolUse", at: new Date(Date.now() - 5 * 60_000).toISOString() })}\n`);
      const noVersion = installStatus(r.env, r.userHome, undefined, r.plat).text;
      assert.match(noVersion, /hooks last fired 5 min ago \([^)]*\)[^,\n]*\n/);
      assert.doesNotMatch(noVersion, /by CoCheck/);
    });

    it("track start says plainly whether the hook is installed; the hedge stays only for several hosts", async () => {
      const one = await rig(platform);
      assert.match(runTrack(["start"], one.userHome).stdout, /^CoCheck's hook is not installed/);
      assert.equal((await one.run(["--home", one.dataHome, "--folder", one.folder, "--for", "claude"])).exitCode, 0);
      const single = runTrack(["start"], one.userHome).stdout;
      assert.match(single, /^CoCheck's hook is installed for Claude\. Tracking starts/);
      assert.doesNotMatch(single, /if /);
      if (!win) {
        const many = await rig(platform, [".claude", ".codex"]);
        assert.equal((await many.run(["--home", many.dataHome, "--folder", many.folder, "--for", "claude,codex"])).exitCode, 0);
        assert.match(runTrack(["start"], many.userHome).stdout, /installed for Claude, Codex\. .*, if it runs in one of those/);
      }
    });

    it("uninstall prints the settings backup file with no date (the copy time is not the first install time)", async () => {
      const r = await rig(platform);
      assert.equal((await r.run(["--home", r.dataHome, "--folder", r.folder, "--for", "claude"])).exitCode, 0);
      const res = await r.run(["--uninstall"]);
      assert.equal(res.exitCode, 0, res.stderr);
      assert.match(res.stdout, /settings backup: .*settings\.json\.cocheck-backup, a copy of your settings made by the first install\./);
      assert.doesNotMatch(res.stdout, /settings backup:.*\d{4}-\d\d-\d\d/);
    });
  });
}

it("ageText", () => {
  assert.deepEqual([0, 5 * 60_000, 9 * 3_600_000, 47 * 3_600_000, 72 * 3_600_000].map(ageText), ["just now", "5 min ago", "9 h ago", "47 h ago", "3 days ago"]);
});
