import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStatus, runInstall, type InstallResult } from "../src/install.ts";
import { SKILL_MARKER } from "../src/skill.ts";

// one install for Claude Code, Codex and Copilot. A host is present when its config folder exists. Every HOME here is a temp dir
// and each host's folder variable is unset, so the real ~/.claude, ~/.codex, ~/.copilot and ~/.agents are never reached.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function rig(hosts: string[]) {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(sandbox);
  const userHome = path.join(sandbox, "home");
  mkdirSync(userHome);
  for (const h of hosts) mkdirSync(path.join(userHome, h));
  const folder = path.join(sandbox, "work");
  mkdirSync(folder);
  const dataHome = path.join(sandbox, "data");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: userHome };
  const run = (argv: string[]): Promise<InstallResult> =>
    runInstall({ argv: ["node", "install.ts", ...argv], env, cwd: sandbox, hookPath, platform: "darwin", stopReview: async () => "no review process was running" });
  return { userHome, folder, dataHome, env, run };
}
/** Every file under `dir` (relative path -> bytes as hex), folders listed too. */
function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      out[path.relative(base, f) + "/"] = "";
      snapshot(f, base, out);
    } else out[path.relative(base, f)] = readFileSync(f).toString("hex");
  }
  return out;
}
const skillOf = (home: string, root: string) => path.join(home, root, "skills", "cocheck", "SKILL.md");

describe("install detects the hosts that are present", () => {
  it("a HOME with only ~/.copilot gets Copilot only", posixOnly("models a macOS install: the hook check runs the POSIX launcher through /bin/sh (the Windows install is covered by install-win32)"), async () => {
    const r = await rig([".copilot"]);
    const res = await r.run(["--home", r.dataHome, "--folder", r.folder]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(existsSync(path.join(r.userHome, ".copilot", "hooks", "cocheck.json")));
    assert.ok(existsSync(skillOf(r.userHome, ".copilot")));
    assert.equal(existsSync(path.join(r.userHome, ".claude")), false);
    assert.equal(existsSync(path.join(r.userHome, ".codex")), false);
    assert.equal(existsSync(path.join(r.userHome, ".agents")), false);
    assert.match(res.stdout, /Copilot[^\n]*hooks in [^\n]*cocheck\.json; skill in [^\n]*SKILL\.md/);
    assert.match(res.stdout, /Not installed \(no config folder found\): Claude, Codex/);
  });

  it("a HOME with none gets nothing and says why", async () => {
    const r = await rig([]);
    const before = snapshot(r.userHome);
    const res = await r.run(["--home", r.dataHome, "--folder", r.folder]);
    assert.equal(res.exitCode, 0, res.stderr);
    for (const k of Object.keys(snapshot(r.userHome))) assert.match(k, /^\.config\/?|^\.config\/cocheck\//, `unexpected ${k}`);
    for (const h of [".claude", ".codex", ".copilot", ".agents"]) assert.equal(existsSync(path.join(r.userHome, h)), false, h);
    assert.match(res.stdout, /No host found: none of [^\n]*\.claude[^\n]*\.codex[^\n]*\.copilot[^\n]* exists, so no hooks or skill were installed/);
  });

  it("--for narrows: all three present, --for claude touches only Claude", posixOnly("models a macOS install: the hook check runs the POSIX launcher through /bin/sh (the Windows install is covered by install-win32)"), async () => {
    const r = await rig([".claude", ".codex", ".copilot"]);
    const res = await r.run(["--home", r.dataHome, "--folder", r.folder, "--for", "claude"]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(existsSync(path.join(r.userHome, ".claude", "settings.json")));
    assert.ok(existsSync(skillOf(r.userHome, ".claude")));
    assert.equal(existsSync(path.join(r.userHome, ".codex", "config.toml")), false);
    assert.equal(existsSync(path.join(r.userHome, ".copilot", "hooks")), false);
    assert.equal(existsSync(path.join(r.userHome, ".agents")), false);
    assert.equal(existsSync(path.join(r.userHome, ".copilot", "skills")), false);
  });

  it("a SKILL.md of the person's own, without the marker, is skipped, said so, and left byte-identical", posixOnly("models a macOS install: the hook check runs the POSIX launcher through /bin/sh (the Windows install is covered by install-win32)"), async () => {
    const r = await rig([".claude"]);
    const mine = skillOf(r.userHome, ".claude");
    mkdirSync(path.dirname(mine), { recursive: true });
    writeFileSync(mine, "---\nname: cocheck\n---\nmy own\n");
    const res = await r.run(["--home", r.dataHome, "--folder", r.folder]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(readFileSync(mine, "utf8"), "---\nname: cocheck\n---\nmy own\n");
    assert.match(res.stdout, /skill NOT written, [^\n]*SKILL\.md is not CoCheck's and stays/);
    const out = await r.run(["--uninstall"]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(readFileSync(mine, "utf8"), "---\nname: cocheck\n---\nmy own\n");
  });

  it("a CoCheck-marked SKILL.md is refreshed", posixOnly("models a macOS install: the hook check runs the POSIX launcher through /bin/sh (the Windows install is covered by install-win32)"), async () => {
    const r = await rig([".claude"]);
    const file = skillOf(r.userHome, ".claude");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `old\n${SKILL_MARKER}\n`);
    assert.equal((await r.run(["--home", r.dataHome, "--folder", r.folder])).exitCode, 0);
    assert.match(readFileSync(file, "utf8"), /name: cocheck/);
  });

  it("real-use check: cold install with all three hosts, then uninstall, leaves every host file byte-identical", posixOnly("models a macOS install: the hook check runs the POSIX launcher through /bin/sh (the Windows install is covered by install-win32)"), async () => {
    const r = await rig([".claude", ".codex", ".copilot"]);
    writeFileSync(path.join(r.userHome, ".claude", "settings.json"), '{\n  "theme": "dark"\n}\n');
    writeFileSync(path.join(r.userHome, ".codex", "config.toml"), 'model = "x"\n');
    const before = snapshot(r.userHome);
    const res = await r.run(["--home", r.dataHome, "--folder", r.folder]);
    assert.equal(res.exitCode, 0, res.stderr);
    for (const root of [".claude", ".agents", ".copilot"]) assert.ok(existsSync(skillOf(r.userHome, root)), root);
    assert.ok(existsSync(path.join(r.userHome, ".claude", "settings.json.cocheck-backup")));
    const st = installStatus(r.env, r.userHome);
    for (const name of ["Claude", "Codex", "Copilot"]) assert.match(st.text, new RegExp(`${name}: installed \\([^)]*\\); hooks have not fired yet`));
    const out = await r.run(["--uninstall"]);
    assert.equal(out.exitCode, 0, out.stderr);
    const after = snapshot(r.userHome);
    // Only the settings backup (original bytes) may be new. No folder is left, ~/.config included.
    for (const k of Object.keys(after)) if (!(k in before)) assert.match(k, /cocheck-backup$/, `left behind: ${k}`);
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], k);
    assert.equal(existsSync(path.join(r.userHome, ".config")), false);
    assert.equal(existsSync(path.join(r.userHome, ".agents")), false);
    assert.equal(lstatSync(r.userHome).isDirectory(), true);
  });

  it("a ~/.config that existed before, with another file in it, survives uninstall", posixOnly("models a macOS install: the hook check runs the POSIX launcher through /bin/sh (the Windows install is covered by install-win32)"), async () => {
    const r = await rig([".claude"]);
    mkdirSync(path.join(r.userHome, ".config"));
    writeFileSync(path.join(r.userHome, ".config", "other.txt"), "mine\n");
    assert.equal((await r.run(["--home", r.dataHome, "--folder", r.folder])).exitCode, 0);
    assert.equal((await r.run(["--uninstall"])).exitCode, 0);
    assert.equal(readFileSync(path.join(r.userHome, ".config", "other.txt"), "utf8"), "mine\n");
    assert.equal(existsSync(path.join(r.userHome, ".config", "cocheck")), false);
    // and an empty ~/.config that existed before stays too
    const r2 = await rig([".claude"]);
    mkdirSync(path.join(r2.userHome, ".config"));
    assert.equal((await r2.run(["--home", r2.dataHome, "--folder", r2.folder])).exitCode, 0);
    assert.equal((await r2.run(["--uninstall"])).exitCode, 0);
    assert.equal(existsSync(path.join(r2.userHome, ".config")), true);
  });

  it("status says whether a host's hooks fired recently, from the hook journal", posixOnly("models a macOS install: the hook check runs the POSIX launcher through /bin/sh (the Windows install is covered by install-win32)"), async () => {
    const r = await rig([".copilot"]);
    assert.equal((await r.run(["--home", r.dataHome, "--folder", r.folder])).exitCode, 0);
    const j = path.join(r.dataHome, "journal");
    mkdirSync(j, { recursive: true });
    writeFileSync(path.join(j, "s.jsonl"), `${JSON.stringify({ v: 1, k: "event", host: "copilot", event: "preToolUse", at: new Date().toISOString() })}\n`);
    assert.match(installStatus(r.env, r.userHome).text, /Copilot: installed \([^)]*\); hooks last fired just now/);
    writeFileSync(path.join(j, "s.jsonl"), `${JSON.stringify({ v: 1, k: "event", host: "copilot", event: "preToolUse", at: "2020-01-01T00:00:00.000Z" })}\n`);
    assert.match(installStatus(r.env, r.userHome).text, /Copilot: installed \([^)]*\); hooks last fired \d+ days ago \(2020-01-01/);
  });
});
