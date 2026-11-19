import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHook, type HookExit } from "../src/hook-cli.ts";
import { runInstall } from "../src/install.ts";
import { runTrack } from "../src/cli.ts";
import { installSkill, removeSkill, SKILL_MARKER, skillRoots } from "../src/skill.ts";
import { isOpenCommand, listTracked, trackCommand, trackingOf } from "../src/tracking.ts";
import { readOpenRecords } from "../src/open-pick.ts";
import { book, dumpLedger, journalRecords, makeRig, type Rig } from "./hook-corpus.ts";

// Every session starts untracked; `cocheck track start|stop` switches it, recognised by the hook on a PreToolUse and keyed by the
// hook's session id. Every home, folder and user HOME here is a fresh temp dir; the real ~/.claude, ~/.agents and ~/.copilot are never touched.
const rigs: Rig[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const rig = async () => {
  const r = await makeRig();
  rigs.push(r);
  return r;
};
const tmp = async (prefix: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${prefix}-`)));
  dirs.push(d);
  return d;
};

const fire = (r: Rig, host: string, payload: unknown, extra: string[] = ["--folder", r.folder]): Promise<HookExit> =>
  runHook({ argv: ["node", "hook.ts", "--host", host, ...extra], env: { COCHECK_HOME: r.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() });

const claude = (r: Rig, session: string) => {
  const base = { session_id: session, cwd: r.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default" };
  return {
    prompt: (text = "Raise every price") => ({ ...base, hook_event_name: "UserPromptSubmit", prompt: text }),
    pre: (id: string, command: string) => ({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command } }),
    post: (id: string, command: string) => ({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: { stdout: "ok" } }),
  };
};

describe("the exact command the hook recognises", () => {
  it("matches only a command that begins with cocheck track start|stop|status", () => {
    assert.equal(trackCommand("cocheck track start"), "start");
    assert.equal(trackCommand("  cocheck track stop\n"), "stop");
    assert.equal(trackCommand("cocheck track status"), "status");
    assert.equal(trackCommand("node /Users/x/code/cocheck/scripts/cocheck.ts track start"), "start");
    assert.equal(trackCommand("/opt/homebrew/bin/cocheck track stop"), "stop");
    assert.equal(trackCommand("cocheck track start && echo done"), "start");
    assert.equal(trackCommand("cocheck track start\nls"), "start");
  });

  it("never matches a mention inside a string, a heredoc, an echo, a later command or a longer word", () => {
    for (const command of [
      'echo "cocheck track start"',
      "echo 'cocheck track stop' > notes.txt",
      "cat <<'EOF'\ncocheck track start\nEOF",
      'python3 -c "import os; os.system(\'cocheck track start\')"',
      "cd /tmp && cocheck track start",
      "ls; cocheck track start",
      "sudo cocheck track start",
      "cocheck track startx",
      "cocheck track start now",
      "cocheck track start $(rm -rf x)",
      "cocheck track start > /tmp/x",
      "cocheck tracker start",
      "cocheck open",
      "xcocheck track start",
      "grep -r 'cocheck track' .",
    ]) assert.equal(trackCommand(command), undefined, command);
  });
});

describe("PowerShell launcher forms and PowerShell as a shell tool", () => {
  it("accepts cocheck.cmd, cocheck.ps1, the call operator and backslash paths", () => {
    for (const [command, verb] of [
      ["cocheck.cmd track start", "start"],
      ["cocheck.ps1 track stop", "stop"],
      ["& cocheck track start", "start"],
      ['& "C:\\Users\\x\\AppData\\Local\\cocheck\\cocheck.cmd" track stop', "stop"],
      ["& 'C:\\Program Files\\CoCheck\\cocheck.ps1' track status", "status"],
      ["C:\\tools\\cocheck.cmd track start", "start"],
      [".\\cocheck.cmd track start; Write-Output ok", "start"],
      ["node C:\\src\\scripts\\cocheck.ts track start", "start"],
    ] as const) assert.equal(trackCommand(command), verb, command);
    assert.equal(isOpenCommand('& "C:\\x\\cocheck.cmd" open 3'), true);
  });

  it("never matches echo, quoted text, a later command or a longer word in the PowerShell forms", () => {
    for (const command of [
      'echo "cocheck.cmd track start"',
      "Write-Output 'cocheck track stop'",
      "& echo cocheck track start",
      'cd C:\\x; & "C:\\x\\cocheck.cmd" track start',
      "Get-Date; cocheck.ps1 track start",
      "cocheck.cmdx track start",
      "cocheck.exe track start",
      "& cocheck track start now",
      "& cocheck track startx",
      '& "C:\\x\\cocheck.cmd" track start $(Remove-Item x)',
      '"C:\\x\\notcocheck.cmd" track start',
      "@'\ncocheck track start\n'@",
    ]) assert.equal(trackCommand(command), undefined, command);
    assert.equal(isOpenCommand('echo "& cocheck open"'), false);
  });

  it("a PowerShell tool event switches tracking on and off", async () => {
    const r = await rig();
    const base = { session_id: "s-ps", cwd: r.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default" };
    const pre = (id: string, command: string) => ({ ...base, hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_use_id: id, tool_input: { command } });
    await fire(r, "claude", pre("p1", '& "C:\\x\\cocheck.cmd" track start'));
    assert.equal(trackingOf(r.home, "claude", "s-ps")?.folder, r.folder, "recording is on after start");
    await fire(r, "claude", pre("p2", "cocheck.ps1 track stop"));
    assert.equal(trackingOf(r.home, "claude", "s-ps"), undefined, "recording is off after stop");
    await fire(r, "claude", pre("p3", 'Write-Output "cocheck track start"'));
    assert.equal(trackingOf(r.home, "claude", "s-ps"), undefined, "a mention in PowerShell does not start recording");
    const copilot = (command: string) => ({ sessionId: "cop-ps", cwd: r.folder, toolName: "powershell", toolArgs: { command } });
    await fire(r, "copilot", copilot("cocheck.cmd track start"), ["--event", "preToolUse"]);
    assert.ok(trackingOf(r.home, "copilot", "cop-ps") !== undefined);
    await fire(r, "copilot", copilot("cocheck.cmd track stop"), ["--event", "preToolUse"]);
    assert.equal(trackingOf(r.home, "copilot", "cop-ps"), undefined);
  });
});

describe("a session records nothing until started, and only between start and stop", () => {
  it("untracked: no journal, no ledger, no context, watched folder or not", async () => {
    const r = await rig();
    await writeFile(path.join(r.home, "watched.json"), JSON.stringify({ version: 1, folders: [r.folder] }));
    const c = claude(r, "s-untracked");
    for (const ev of [c.prompt(), c.pre("a", "python3 bump.py"), c.post("a", "python3 bump.py")]) {
      const res = await fire(r, "claude", ev);
      assert.deepEqual([res.exitCode, res.stdout, res.stderr], [0, "", ""]);
    }
    assert.deepEqual(journalRecords(r.home), []);
    assert.equal(existsSync(path.join(r.home, "ledger.sqlite")), false);
  });

  it("start, work, stop, work more: the ledger holds only the first stretch, and stop hides nothing", async () => {
    const r = await rig();
    const c = claude(r, "s-lifecycle");
    const send = async (ev: unknown, write?: Record<string, number>) => {
      if (write) await writeFile(path.join(r.folder, "model.xlsx"), book(write));
      const res = await fire(r, "claude", ev);
      assert.equal(res.exitCode, 0, res.stderr);
      return res;
    };
    // The start call itself is never recorded, its Post neither.
    await send(c.pre("sw1", "cocheck track start"));
    assert.equal(trackingOf(r.home, "claude", "s-lifecycle")?.folder, r.folder);
    await send(c.post("sw1", "cocheck track start"));
    assert.deepEqual(journalRecords(r.home), [], "the switch call leaves nothing");
    // First stretch.
    const ctx = await send(c.prompt());
    assert.match(ctx.stdout, /CoCheck is recording this session/);
    await send(c.pre("call_1", "python3 bump.py A1"));
    await send(c.post("call_1", "python3 bump.py A1"), { A1: 10, A2: 2, A3: 3 });
    const during = journalRecords(r.home).length;
    assert.ok(during >= 3);
    // Stop: from the next call on nothing is recorded.
    await send(c.pre("sw2", "cocheck track stop"));
    await send(c.post("sw2", "cocheck track stop"));
    assert.equal(trackingOf(r.home, "claude", "s-lifecycle"), undefined);
    const after = await send(c.prompt("more"));
    assert.equal(after.stdout, "", "no context once stopped");
    await send(c.pre("call_2", "python3 bump.py A2"));
    await send(c.post("call_2", "python3 bump.py A2"), { A1: 10, A2: 20, A3: 3 });
    assert.equal(journalRecords(r.home).length, during, "the stopped session adds nothing");
    const ledger = JSON.stringify(dumpLedger(r.home, r.folder));
    assert.ok(ledger.includes("call_1"), "what was recorded stays after stop");
    assert.ok(!ledger.includes("call_2"));
    assert.ok(!JSON.stringify(journalRecords(r.home)).includes("call_2"));
    // Started again: recording resumes.
    await send(c.pre("sw3", "cocheck track start"));
    await send(c.pre("call_3", "python3 bump.py A3"));
    assert.ok(JSON.stringify(journalRecords(r.home)).includes("call_3"));
  });

  it("a command that only mentions cocheck track does not flip the switch", async () => {
    const r = await rig();
    const c = claude(r, "s-mention");
    for (const [i, command] of ['echo "cocheck track start"', "cat <<'EOF'\ncocheck track start\nEOF", "cd . && cocheck track start"].entries()) {
      await fire(r, "claude", c.pre(`m${i}`, command));
      assert.equal(trackingOf(r.home, "claude", "s-mention"), undefined, command);
    }
    assert.deepEqual(journalRecords(r.home), []);
    // And a started session is not stopped by a mention.
    await fire(r, "claude", c.pre("ok", "cocheck track start"));
    await fire(r, "claude", c.pre("m9", 'echo "cocheck track stop"'));
    assert.ok(trackingOf(r.home, "claude", "s-mention") !== undefined);
  });

  it("a second session in the same folder keeps its own switch", async () => {
    const r = await rig();
    const a = claude(r, "s-a");
    const b = claude(r, "s-b");
    await fire(r, "claude", a.pre("a1", "cocheck track start"));
    await fire(r, "claude", b.pre("b1", "python3 other.py"));
    assert.deepEqual(journalRecords(r.home), [], "session b never started");
    await fire(r, "claude", b.pre("b2", "cocheck track start"));
    await fire(r, "claude", a.pre("a2", "cocheck track stop"));
    assert.equal(trackingOf(r.home, "claude", "s-a"), undefined);
    assert.ok(trackingOf(r.home, "claude", "s-b") !== undefined);
    await fire(r, "claude", b.pre("b3", "python3 other.py"));
    await fire(r, "claude", a.pre("a3", "python3 mine.py"));
    // Compare record ids, not the JSON text: a sha256 in a record can contain "a3" by chance.
    const ids = journalRecords(r.home).flatMap((rec: { id?: string }) => (typeof rec.id === "string" ? [rec.id] : []));
    assert.deepEqual(ids, ["b3"], "b3 is recorded and the stopped session's a3 is not");
    assert.deepEqual(listTracked(r.home).map((t) => t.session), ["s-b"]);
  });

  it("the same switch works on Codex and Copilot payloads, with no restart", async () => {
    const r = await rig();
    const codex = (command: string, id: string, name = "PreToolUse") => ({ session_id: "019a-codex", cwd: r.folder, hook_event_name: name, tool_name: "Bash", tool_use_id: id, tool_input: { command } });
    await fire(r, "codex", codex("cocheck track start", "c1"), []);
    assert.ok(trackingOf(r.home, "codex", "019a-codex") !== undefined);
    await fire(r, "codex", codex("python3 bump.py", "c2"), []);
    assert.ok(journalRecords(r.home).some((rec: { id?: string }) => rec.id === "c2"));
    await fire(r, "codex", codex("cocheck track stop", "c3"), []);
    assert.equal(trackingOf(r.home, "codex", "019a-codex"), undefined);

    const copilot = (command: string) => ({ sessionId: "cop-1", cwd: r.folder, toolName: "bash", toolArgs: { command } });
    const pre = ["--event", "preToolUse"];
    await fire(r, "copilot", copilot("cocheck track start"), pre);
    assert.ok(trackingOf(r.home, "copilot", "cop-1") !== undefined);
    const before = journalRecords(r.home).length;
    await fire(r, "copilot", copilot("python3 bump.py"), pre);
    assert.ok(journalRecords(r.home).length > before, "a started Copilot session records");
    const during = journalRecords(r.home).length;
    await fire(r, "copilot", copilot("cocheck track stop"), pre);
    assert.equal(trackingOf(r.home, "copilot", "cop-1"), undefined);
    await fire(r, "copilot", copilot("python3 bump.py"), pre);
    assert.equal(journalRecords(r.home).length, during, "a stopped Copilot session records nothing");
    // The switch is keyed by host too: Codex and Copilot sessions never share a key.
    assert.equal(trackingOf(r.home, "claude", "cop-1"), undefined);
  });

  it("start makes the session's cwd its task folder when the host gives no other", async () => {
    const r = await rig();
    const c = claude(r, "s-folder");
    await fire(r, "claude", c.pre("f1", "cocheck track start"), []);
    const res = await fire(r, "claude", c.pre("f2", "python3 bump.py"), []);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(journalRecords(r.home).some((rec: { id?: string }) => rec.id === "f2"));
  });
});

describe("the CLI and the skill", () => {
  it("cocheck track never guesses a session; status lists what the hook switched", async () => {
    const r = await rig();
    const userHome = await tmp("user");
    mkdirSync(path.join(userHome, ".config", "cocheck"), { recursive: true });
    writeFileSync(path.join(userHome, ".config", "cocheck", "install.json"), JSON.stringify({ home: r.home, hookPath: "/x/hook.js", launcher: "/x/l.sh", settingsFile: "/x/s.json", backupFile: "/x/s.bak", hosts: [], folder: "/x", createdDirs: [], installedAt: "2026-10-28T00:00:00.000Z" }));
    assert.equal(runTrack(["start"], userHome).exitCode, 0);
    assert.equal(runTrack(["stop"], userHome).exitCode, 0);
    assert.equal(runTrack(["bogus"], userHome).exitCode, 1);
    assert.match(runTrack(["status"], userHome).stdout, /No session is tracked/);
    await fire(r, "claude", claude(r, "s-status").pre("x", "cocheck track start"));
    assert.match(runTrack(["status"], userHome).stdout, /1 session is tracked right now:\n {2}claude s-status/);
    assert.deepEqual(trackingOf(r.home, "claude", "s-status")?.session, "s-status", "the CLI changed no switch");
  });

  it("installSkill writes one SKILL.md named cocheck to the three skill folders; removeSkill takes out only those", async () => {
    const userHome = await tmp("user");
    const files = installSkill(userHome, "cocheck");
    assert.deepEqual(files.map((f) => path.relative(userHome, f)), skillRoots().map((root) => path.join(root, "cocheck", "SKILL.md")));
    assert.deepEqual(skillRoots().map((r) => r.replaceAll("\\", "/")), [".claude/skills", ".agents/skills", ".copilot/skills"]);
    const texts = files.map((f) => readFileSync(f, "utf8"));
    assert.equal(new Set(texts).size, 1);
    assert.match(texts[0], /^---\nname: cocheck\n/);
    for (const verb of ["track start", "track stop", "track status", "cocheck open"]) assert.ok(texts[0].includes(verb), verb);
    // A SKILL.md of the person's own, without the marker, stays.
    const mine = path.join(userHome, ".agents", "skills", "cocheck", "SKILL.md");
    writeFileSync(mine, "---\nname: cocheck\n---\nmy own\n");
    const gone = removeSkill(userHome);
    assert.equal(gone.length, 2);
    assert.equal(readFileSync(mine, "utf8"), "---\nname: cocheck\n---\nmy own\n");
    assert.ok(!SKILL_MARKER.includes("my own"));
  });

  it("cocheck install writes the skill under the given HOME, cocheck uninstall removes it", async () => {
    const userHome = await tmp("user");
    const dataHome = path.join(await tmp("data"), "home");
    const folder = await tmp("folder");
    const env = { HOME: userHome, PATH: process.env.PATH ?? "" };
    const done = (...args: string[]) => runInstall({ argv: ["node", "install.ts", ...args], env, cwd: folder, platform: "darwin", stopReview: async () => "no review process was running" });
    const installed = await done("--home", dataHome, "--folder", folder, "--for", "none");
    assert.equal(installed.exitCode, 0, installed.stderr);
    // The skill goes only to the hosts installed; `--for none` installs none (test/install-all-hosts.test.ts covers the hosts).
    for (const root of skillRoots()) assert.equal(existsSync(path.join(userHome, root, "cocheck", "SKILL.md")), false, root);
    assert.match(installed.stdout, /Every session starts untracked/);
    const removed = await done("--uninstall", "--for", "none");
    assert.equal(removed.exitCode, 0, removed.stderr);
    for (const root of skillRoots()) assert.equal(existsSync(path.join(userHome, root, "cocheck")), false, root);
  });
});

describe("the hook notes who ran `cocheck open`, even after `cocheck track stop`", () => {
  it("writes a record for the asking session once tracking is stopped, and for no mere mention", async () => {
    const r = await rig();
    const c = claude(r, "s-open");
    await fire(r, "claude", c.pre("sw1", "cocheck track start"));
    await fire(r, "claude", c.pre("sw2", "cocheck track stop"));
    assert.equal(trackingOf(r.home, "claude", "s-open"), undefined);
    await fire(r, "claude", c.pre("m1", 'echo "cocheck open"'));
    assert.deepEqual(readOpenRecords(r.home), []);
    await fire(r, "claude", c.pre("o1", "cocheck open"));
    const records = readOpenRecords(r.home);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.host, "claude");
    assert.equal(records[0]!.session, "s-open");
    assert.ok(Math.abs(records[0]!.at - Date.now()) < 10_000);
  });

  it("recognises only a command that begins with cocheck open", () => {
    for (const ok of ["cocheck open", "cocheck open 12", "node /x/scripts/cocheck.ts open", "/opt/homebrew/bin/cocheck open && echo hi"]) assert.equal(isOpenCommand(ok), true, ok);
    for (const no of ['echo "cocheck open"', "cat <<'EOF'\ncocheck open\nEOF", "ls; cocheck open", "cocheck openx", "cocheck open now", "cocheck open > /tmp/x"]) assert.equal(isOpenCommand(no), false, no);
  });

  it("a Codex helper's call belongs to its parent session (the payload's session_id)", async () => {
    const r = await rig();
    await fire(r, "codex", { session_id: "parent-thread", agent_id: "helper-thread", cwd: r.folder, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "cocheck open" } }, []);
    assert.deepEqual(readOpenRecords(r.home).map((x) => [x.host, x.session]), [["codex", "parent-thread"]]);
  });
});
