import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStatus, runInstall, type InstallResult } from "../src/install.ts";
import { runOpen } from "../scripts/cocheck.ts";
import { notRecordingReason } from "../src/review-server.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// a stranger can install, see and remove CoCheck. Every run uses a scratch HOME, CLAUDE_CONFIG_DIR and COCHECK_HOME under the temp
// dir; the real settings, ~/.cocheck and Keychain are never read. Nothing here starts the review server: the open path gets a stub URL.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const launcher = path.resolve(import.meta.dirname, "..", "scripts", "hook-launch.sh");

let sandbox: string;
let cfg: string;
let userHome: string;
let dataHome: string;
const settingsPath = () => path.join(cfg, "settings.json");
const backupPath = () => `${settingsPath()}.cocheck-backup`;
const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) f();
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-s009-")));
  userHome = path.join(sandbox, "home");
  cfg = path.join(userHome, ".claude");
  dataHome = path.join(sandbox, "data");
  await mkdir(userHome, { recursive: true });
  await mkdir(cfg, { recursive: true }); // Claude Code is present (an install with no --for detects hosts by their config folder)
  const folder = path.join(sandbox, "work");
  await mkdir(folder, { recursive: true });
  return folder;
}
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: cfg, ...extra });
const run = (argv: string[], extra: Partial<Parameters<typeof runInstall>[0]> = {}): Promise<InstallResult> =>
  runInstall({ argv: ["node", "install.ts", ...argv], env: env(), cwd: sandbox, hookPath, stopReview: async () => "no review process was running", ...extra });
const install = (folder: string, extra: Partial<Parameters<typeof runInstall>[0]> = {}) => run(["--home", dataHome, "--folder", folder], extra);

/** A stand-in `node` in its own dir: the script text decides what a hook run does. */
async function fakeNode(dir: string, body: string) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "node");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}
const launch = (nodeEnv: NodeJS.ProcessEnv) =>
  spawnSync("/bin/sh", [launcher, hookPath, "--host", "claude"], { input: "{}", encoding: "utf8", env: { HOME: userHome, COCHECK_HOME: dataHome, ...nodeEnv } });
const notRecording = () => path.join(dataHome, "not-recording.txt");

describe("the hook command survives a Node upgrade", () => {
  it("names no Node binary, only the launcher", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    const folder = await fresh();
    const res = await install(folder);
    assert.equal(res.exitCode, 0, res.stderr);
    const cmd = JSON.parse(await readFile(settingsPath(), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
    assert.ok(!cmd.includes(process.execPath), cmd);
    assert.doesNotMatch(cmd, /Cellar|node@|\/bin\/node/);
    assert.ok(cmd.includes(launcher) && cmd.includes("COCHECK_MANAGED=1"));
  });

  it("finds a different Node on PATH when it fires, with no reinstall", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    const bin1 = path.join(sandbox, "node-v1");
    const bin2 = path.join(sandbox, "node-v2");
    await fakeNode(bin1, 'echo v1 > "$COCHECK_HOME/ran"');
    await fakeNode(bin2, 'echo v2 > "$COCHECK_HOME/ran"');
    await mkdir(dataHome, { recursive: true });
    assert.equal(launch({ PATH: `${bin1}:/usr/bin:/bin` }).status, 0);
    assert.equal((await readFile(path.join(dataHome, "ran"), "utf8")).trim(), "v1");
    await rm(bin1, { recursive: true });
    assert.equal(launch({ PATH: `${bin2}:/usr/bin:/bin` }).status, 0);
    assert.equal((await readFile(path.join(dataHome, "ran"), "utf8")).trim(), "v2");
  });

  it("a missing Node is reported, not silent", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    const res = launch({ PATH: "/usr/bin:/bin", COCHECK_NODE_SEARCH: "/nonexistent/node" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Node was not found/);
    assert.match(await readFile(notRecording(), "utf8"), /Node was not found.*22\.18/);
  });

  it("a Node that is too old (the hook fails under it) is reported with its version, and the exit status passes through", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    const bin = path.join(sandbox, "old");
    await fakeNode(bin, 'if [ "$1" = "--version" ]; then echo v20.1.0; exit 0; fi\necho "Cannot find module node:sqlite" >&2\nexit 3');
    const res = launch({ PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(res.status, 3);
    assert.match(res.stderr, /node:sqlite/);
    const note = await readFile(notRecording(), "utf8");
    assert.match(note, /exited 3 under Node v20\.1\.0/);
    assert.match(note, /node:sqlite/);
  });

  it("the next hook that records clears the note", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    await mkdir(dataHome, { recursive: true });
    await writeFile(notRecording(), "old\nreason\n");
    const bin = path.join(sandbox, "ok");
    await fakeNode(bin, "exit 0");
    assert.equal(launch({ PATH: `${bin}:/usr/bin:/bin` }).status, 0);
    assert.equal(existsSync(notRecording()), false);
  });
});

describe("not recording is named with its reason", () => {
  it("status says recording after a clean install", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const st = installStatus(env(), userHome);
    assert.equal(st.recording, true, st.text);
    assert.match(st.text, /^CoCheck: installed; not seen yet\. Restart Claude, then say 'start tracking'/); // no hook has fired yet
  });

  it("status and open both say 'not recording' with the launcher's reason", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    await writeFile(notRecording(), "2026-10-15T10:00:00Z\nThe hook exited 3 under Node v20.1.0\n");
    const st = installStatus(env(), userHome);
    assert.equal(st.recording, false);
    assert.match(st.text, /not recording/);
    assert.match(st.text, /exited 3 under Node v20\.1\.0/);
    const opened: string[] = [];
    const res = await runOpen({ env: env(), userHome, urlFor: async (h) => `http://127.0.0.1:1/?t=x#${h}`, open: (u) => void opened.push(u) }, undefined);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /not recording/);
    assert.match(res.stdout, /exited 3/);
    assert.equal(opened.length, 1);
  });

  it("status says why when the hook files are gone or Claude Code's settings lost the entries", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const recordFile = path.join(userHome, ".config", "cocheck", "install.json");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    await writeFile(recordFile, JSON.stringify({ ...record, hookPath: path.join(sandbox, "gone", "hook.js") }));
    assert.match(installStatus(env(), userHome).text, /hook files are missing/);
    await writeFile(recordFile, JSON.stringify(record));
    await writeFile(settingsPath(), "{}");
    assert.match(installStatus(env(), userHome).text, /no longer carry CoCheck's hook/);
  });

  it("status says why when Node is gone from PATH", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const st = installStatus(env({ PATH: "/usr/bin:/bin", COCHECK_NODE_SEARCH: "/nonexistent/node" }), userHome);
    assert.equal(st.recording, false);
    assert.match(st.text, /Node was not found/);
  });

  it("not installed: status and open refuse and say so", async () => {
    await fresh();
    assert.match(installStatus(env(), userHome).text, /not installed/);
    const res = await runOpen({ env: env(), userHome, urlFor: async () => "never", open: () => assert.fail("must not open") }, undefined);
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /not installed/);
  });
});

describe("cocheck open opens the page for the recorded home", () => {
  it("passes the installed home (not ~/.cocheck) and the task to the page, and opens its URL", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const seen: Array<[string, number | undefined]> = [];
    const opened: string[] = [];
    const urlFor = async (h: string, t: number | undefined) => (seen.push([h, t]), `http://127.0.0.1:9/x?t=secret`);
    const res = await runOpen({ env: env(), userHome, urlFor, open: (u) => void opened.push(u) }, "7");
    assert.equal(res.exitCode, 0);
    assert.deepEqual(seen, [[dataHome, 7]]);
    assert.deepEqual(opened, ["http://127.0.0.1:9/x?t=secret"]);
    assert.doesNotMatch(res.stdout, /secret/);
    assert.equal((await runOpen({ env: env(), userHome, urlFor, open: () => {} }, "07")).exitCode, 1);
  });
});

describe("a failed post-install check restores settings.json", () => {
  const failing = async () => {
    const bad = path.join(sandbox, "bad-launcher.sh");
    await writeFile(bad, "#!/bin/sh\necho boom >&2\nexit 1\n");
    return bad;
  };

  it("puts back the exact original bytes, drops this run's backup, registers nothing", async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    const original = Buffer.from('{\n    "model": "opus",\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "afplay done.wav"}]}]}\n}');
    await writeFile(settingsPath(), original);
    const res = await install(folder, { launcher: await failing() });
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /hook check failed/);
    assert.match(res.stderr, /back to how it was/);
    assert.deepEqual(await readFile(settingsPath()), original);
    assert.equal(existsSync(backupPath()), false);
    assert.equal(existsSync(path.join(dataHome, "watched.json")), false);
    assert.equal(existsSync(path.join(userHome, ".config", "cocheck", "install.json")), false);
  });

  it("an earlier backup is kept, and a settings file that did not exist does not exist afterwards", async () => {
    const folder = await fresh();
    assert.equal((await install(folder, { launcher: await failing() })).exitCode, 1);
    assert.equal(existsSync(settingsPath()), false);
    await mkdir(cfg, { recursive: true });
    await writeFile(backupPath(), "older backup");
    await writeFile(settingsPath(), "{}");
    assert.equal((await install(folder, { launcher: await failing() })).exitCode, 1);
    assert.equal(await readFile(backupPath(), "utf8"), "older backup");
    assert.equal(await readFile(settingsPath(), "utf8"), "{}");
  });

  it("a failed reinstall restores the earlier working install, entries and all", async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const working = await readFile(settingsPath());
    assert.equal((await install(folder, { launcher: await failing() })).exitCode, 1);
    assert.deepEqual(await readFile(settingsPath()), working);
  });
});

describe("uninstall stops the review process and says what stays", () => {
  it("prints the home path and size, the Keychain item and the backup; keeps the user's own hooks and the data", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "afplay done.wav" }] }], PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo COCHECK_MANAGEDX=1 mine" }] }] } };
    await writeFile(settingsPath(), JSON.stringify(mine));
    assert.equal((await install(folder)).exitCode, 0);
    await writeFile(path.join(dataHome, "big.bin"), Buffer.alloc(3 * 1024 * 1024));
    const stopped: string[] = [];
    const res = await run(["--uninstall"], { stopReview: async (h) => (stopped.push(h), "stopped the review process (pid 1)") });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.deepEqual(stopped, [dataHome]);
    assert.match(res.stdout, /stopped the review process/);
    assert.ok(res.stdout.includes(dataHome));
    assert.match(res.stdout, /\(3 MB\)/);
    assert.match(res.stdout, /Keychain item: "cocheck-store-key"/);
    assert.ok(res.stdout.includes(backupPath()));
    assert.deepEqual(JSON.parse(await readFile(settingsPath(), "utf8")), mine);
    assert.equal(existsSync(path.join(dataHome, "big.bin")), true);
    assert.equal(installStatus(env(), userHome).record, undefined);
  });

  it("really stops a review process recorded in the home, and leaves a pid that is not a review process alone", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    const folder = await fresh();
    assert.equal((await install(folder)).exitCode, 0);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "review-process"], { stdio: "ignore", env: { ...process.env, COCHECK_HOME: dataHome } });
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "unrelated"], { stdio: "ignore" });
    cleanup.push(() => { child.kill("SIGKILL"); bystander.kill("SIGKILL"); });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    await writeFile(path.join(dataHome, "review-server.json"), JSON.stringify({ pid: child.pid, port: 1 }));
    const res = await runInstall({ argv: ["node", "install.ts", "--uninstall"], env: env(), cwd: sandbox });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`stopped the review process \\(pid ${child.pid}\\)`));
    await exited;
    await install(folder);
    await writeFile(path.join(dataHome, "review-server.json"), JSON.stringify({ pid: bystander.pid, port: 1 }));
    const second = await runInstall({ argv: ["node", "install.ts", "--uninstall"], env: env(), cwd: sandbox });
    assert.match(second.stdout, /no review process was running/);
    assert.equal(bystander.exitCode, null);
  });

  it("with nothing installed it changes nothing and says so", async () => {
    await fresh();
    const res = await run(["--uninstall"]);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /no hook entries to remove/);
    assert.equal(existsSync(settingsPath()), false);
  });
});

describe("install output states what the person agrees to", () => {
  it("names the Node requirement, the disk, the timing and the session context", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    const folder = await fresh();
    const res = await install(folder);
    assert.equal(res.exitCode, 0, res.stderr);
    for (const re of [/Needs Node 22\.18/, /1 GB per task/, /Hook timing:.*1 second/, /cocheck\.ts open/, /tells Claude.*save.*open command/]) {
      assert.match(res.stdout, re);
    }
    assert.doesNotMatch(res.stdout, /AI lines|COCHECK_BLURBS|aiLines/);
    const doc = await readFile(path.resolve(import.meta.dirname, "..", "docs", "install.md"), "utf8");
    for (const re of [/Mac only/, /Node 22\.18/, /1 GB per task/, /Hook timing/, /cocheck\.ts <command>/, /tells Claude where to save and how to open the page/]) {
      assert.match(doc, re);
    }
  });

  it("refuses off a Mac or Windows", async () => {
    const folder = await fresh();
    const res = await install(folder, { platform: "linux" });
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /Linux is not supported/);
    assert.equal(existsSync(settingsPath()), false);
  });
});

describe("the review page says when CoCheck is not recording", () => {
  it("the shell carries a one-line banner with the escaped reason, and none when recording", async () => {
    await fresh();
    assert.equal(notRecordingReason(dataHome), undefined);
    await mkdir(dataHome, { recursive: true });
    await writeFile(notRecording(), '2026-10-15T10:00:00Z\nThe hook exited 3 <b>"x"</b>\n');
    const reason = notRecordingReason(dataHome);
    assert.equal(reason, 'The hook exited 3 <b>"x"</b>');
    const html = renderReviewShell(5, reason);
    assert.match(html, /CoCheck is not recording: The hook exited 3 &#60;b&#62;&#34;x&#34;&#60;\/b&#62;/);
    assert.doesNotMatch(html, /<b>"x"/);
    assert.doesNotMatch(renderReviewShell(5), /not recording/);
  });
});

describe("only the exact command shapes CoCheck wrote count as CoCheck's", () => {
  const bare = "echo COCHECK_MANAGED=1 is my own note";
  const prefixed = "COCHECK_MANAGED=1 COCHECK_HOME=/mine /usr/local/bin/my-own-hook";
  const mine = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: bare }, { type: "command", command: prefixed }] }] } };
  const userCommands = (s: any) => (s.hooks.PreToolUse as any[]).flatMap((g) => g.hooks.map((h: any) => h.command)).filter((c: string) => c === bare || c === prefixed);

  it("a user entry containing the marker text survives install, a failed install's rollback and uninstall", async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    await writeFile(settingsPath(), JSON.stringify(mine));
    const bad = path.join(sandbox, "bad-launcher.sh");
    await writeFile(bad, "#!/bin/sh\nexit 1\n");
    assert.equal((await install(folder, { launcher: bad })).exitCode, 1);
    assert.deepEqual(JSON.parse(await readFile(settingsPath(), "utf8")), mine);
    assert.equal((await install(folder)).exitCode, 0);
    assert.deepEqual(userCommands(JSON.parse(await readFile(settingsPath(), "utf8"))), [bare, prefixed]);
    assert.equal((await run(["--uninstall"])).exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(settingsPath(), "utf8")), mine);
  });

  it("the changed-during-install rollback also leaves the user entry alone", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    const folder = await fresh();
    await mkdir(cfg, { recursive: true });
    await writeFile(settingsPath(), JSON.stringify(mine));
    // The launcher check rewrites settings.json mid-install (adds a user Stop hook), so the byte-exact restore does not apply and the strip path runs.
    const meddled = { hooks: { ...mine.hooks, Stop: [{ hooks: [{ type: "command", command: "afplay done.wav" }] }] } };
    const meddling = path.join(sandbox, "meddling-launcher.sh");
    await writeFile(meddling, `#!/bin/sh\ncat > '${settingsPath()}' <<'EOF2'\n${JSON.stringify(meddled)}\nEOF2\nexit 1\n`);
    const res = await install(folder, { launcher: meddling });
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /only CoCheck's own entries were removed/);
    assert.deepEqual(JSON.parse(await readFile(settingsPath(), "utf8")), meddled);
  });

});

describe("the launcher's last-resort Node is the one the installer resolved", () => {
  it("the installer records its Node in the data home and leaves the hook command string unchanged", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    const folder = await fresh();
    const res = await install(folder);
    assert.equal(res.exitCode, 0, res.stderr);
    const recorded = (await readFile(path.join(dataHome, "installed-node.txt"), "utf8")).trim();
    const onPath = spawnSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8", env: { PATH: process.env.PATH } }).stdout.trim();
    assert.equal(recorded, onPath);
    const cmd = JSON.parse(await readFile(settingsPath(), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
    assert.ok(!cmd.includes("installed-node") && !cmd.includes(recorded), cmd);
  });

  it("a hook run with PATH=/usr/bin:/bin finds the recorded Node", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    const node = await fakeNode(path.join(sandbox, "nvm-node"), 'echo recorded > "$COCHECK_HOME/ran"');
    await mkdir(dataHome, { recursive: true });
    await writeFile(path.join(dataHome, "installed-node.txt"), `${node}\n`);
    const res = launch({ PATH: "/usr/bin:/bin", COCHECK_NODE_SEARCH: "/nonexistent/node" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal((await readFile(path.join(dataHome, "ran"), "utf8")).trim(), "recorded");
  });

  it("PATH still wins over the recorded Node", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    const recorded = await fakeNode(path.join(sandbox, "old-node"), 'echo recorded > "$COCHECK_HOME/ran"');
    await fakeNode(path.join(sandbox, "path-node"), 'echo path > "$COCHECK_HOME/ran"');
    await mkdir(dataHome, { recursive: true });
    await writeFile(path.join(dataHome, "installed-node.txt"), `${recorded}\n`);
    assert.equal(launch({ PATH: `${path.join(sandbox, "path-node")}:/usr/bin:/bin` }).status, 0);
    assert.equal((await readFile(path.join(dataHome, "ran"), "utf8")).trim(), "path");
  });

  it("a recorded Node that was removed falls through to the Node-not-found behaviour", posixOnly("asserts the POSIX hook-launch.sh launcher, a PATH of /usr/bin:/bin and macOS Keychain wording; the Windows launcher is hook-launch.mjs"), async () => {
    await fresh();
    await mkdir(dataHome, { recursive: true });
    await writeFile(path.join(dataHome, "installed-node.txt"), `${path.join(sandbox, "gone", "node")}\n`);
    const res = launch({ PATH: "/usr/bin:/bin", COCHECK_NODE_SEARCH: "/nonexistent/node" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Node was not found/);
    assert.match(await readFile(notRecording(), "utf8"), /Node was not found.*22\.18/);
  });
});
