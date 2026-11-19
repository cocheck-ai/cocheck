import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHook as runHookRaw } from "../src/hook-cli.ts";
import { setTracking } from "../src/tracking.ts";
import { activeDir, callShell, evidenceDir, guardDir, markSessionTagged, parseTagSetting, prepareSession, rootsFile, sessionEnvLines, sessionReady, stripTag, tagCommand, tagInCommandLine, tagsInMode, writeHooksDir } from "../src/attribution/tag.ts";
import { observedOnly } from "../src/attribution/evidence.ts";
import { readEvidence, startEvidence } from "../src/attribution/evidence.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { openLedger } from "../src/ledger.ts";
import { CORPUS } from "./fixtures/command-behaviour-corpus.ts";
import { DatabaseSync } from "node:sqlite";
import { workbookClaims } from "./helpers/claims.ts";

// The per-call tag on every Claude Code Bash call. The tag is a trailing comment line set through PreToolUse updatedInput; the
// Python and Node write hooks find it in their ancestor shell's command line and record which call wrote which file; attribution uses
// those records ahead of open-call windows. Must not happen: the tag never changes what a command does or prints.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const SHELLS = ["/bin/bash", "/bin/zsh"].filter((s) => existsSync(s));
const BASH = "/bin/bash";
const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;
const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

/**
 * Runs `command` the way Claude Code 2.1.309 does (`<shell> -c "... && eval '<command>' < /dev/null && pwd -P >| <file>"`), with the
 * session's write-hook environment as SessionStart sets it: the env-file lines sourced first, the guards under `home`, `cwd`'s parent
 * registered, and the session marked tagged unless `tagged` is false. The evidence log is `<home>/attribution`.
 */
function runLikeClaude(shell: string, command: string, cwd: string, home: string, opts: { tagged?: boolean; hooksDir?: string; leaveSwitch?: boolean } = {}) {
  const lines = prepareSession(home, "sess1", [path.dirname(cwd)], Date.now(), opts.hooksDir);
  if (opts.leaveSwitch !== true) setTracking(home, "claude", "sess1", true); // the env lines load the guards only while the session is tracked
  if (opts.tagged !== false) markSessionTagged(home, "sess1");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: cwd, LANG: "C" };
  const pre = lines.split("\n").filter(Boolean).join("; ");
  const r = spawnSync(shell, ["-c", `${pre}; eval ${sq(command)} < /dev/null && pwd -P >| /dev/null`], { cwd, env, encoding: "utf8", timeout: 20_000 });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

const allRecords = (logDir: string) =>
  existsSync(logDir)
    ? readdirSync(logDir).filter((n) => n.endsWith(".jsonl")).flatMap((n) => readFileSync(path.join(logDir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    : [];
/** The write, remove and spawn records (the per-process start records are checked on their own). */
const records = (logDir: string) => allRecords(logDir).filter((r) => r.op !== "start");

describe("setting", () => {
  it("on by default (after the fenced live run); auto and off from the flag or the environment, the flag first", () => {
    assert.equal(parseTagSetting([], {}), "on");
    assert.equal(parseTagSetting([], { COCHECK_ATTRIBUTION_TAG: "auto" }), "auto");
    assert.equal(parseTagSetting(["--attribution-tag", "auto"], {}), "auto");
    assert.equal(parseTagSetting([], { COCHECK_ATTRIBUTION_TAG: "off" }), "off");
    assert.equal(parseTagSetting([], { COCHECK_ATTRIBUTION_TAG: "on" }), "on");
    assert.equal(parseTagSetting(["--attribution-tag", "off"], { COCHECK_ATTRIBUTION_TAG: "on" }), "off");
  });
  it("auto tags only in bypassPermissions, where no allow rule is consulted", () => {
    for (const m of ["default", "plan", "acceptEdits", "auto", "dontAsk", undefined]) assert.equal(tagsInMode("auto", m), false, String(m));
    assert.equal(tagsInMode("auto", "bypassPermissions"), true);
    assert.equal(tagsInMode("on", "default"), true);
    assert.equal(tagsInMode("off", "bypassPermissions"), false);
  });
  it("only bash and zsh are tagged", () => {
    assert.equal(callShell({ SHELL: "/bin/zsh" }), existsSync("/bin/zsh") ? "/bin/zsh" : undefined);
    assert.equal(callShell({ SHELL: "/usr/bin/fish" }), undefined);
    assert.equal(callShell({}), undefined);
  });
});

describe("tagCommand", () => {
  it("appends one trailing comment line; strip and the command-line reader invert it", () => {
    const t = tagCommand("echo hi", "toolu_1", "a1b2", BASH)!;
    assert.equal(t, "echo hi\n# cocheck-call:toolu_1:a1b2");
    assert.equal(stripTag(t), "echo hi");
    assert.deepEqual(tagInCommandLine(`zsh -c eval 'echo hi\\012# cocheck-call:toolu_1:a1b2'`), { call: "toolu_1", agent: "a1b2" });
    assert.equal(tagCommand("echo hi", "toolu_1", undefined, BASH), "echo hi\n# cocheck-call:toolu_1:main");
  });
  it("leaves alone what the comment could change: an open heredoc, a trailing backslash, a parse error, odd ids, an existing tag", () => {
    for (const shell of SHELLS) {
      assert.equal(tagCommand("cat <<EOF\nbody", "t1", "a", shell), null, `${shell} open heredoc`);
      assert.equal(tagCommand("echo a \\", "t1", "a", shell), null, `${shell} backslash`);
      assert.equal(tagCommand("echo \"open", "t1", "a", shell), null, `${shell} quote`);
      assert.equal(tagCommand("if true; then echo", "t1", "a", shell), null, `${shell} if`);
      assert.notEqual(tagCommand("cat <<EOF\nbody\nEOF", "t1", "a", shell), null, `${shell} closed heredoc`);
    }
    assert.equal(tagCommand("echo", "bad id", "a", BASH), null);
    assert.equal(tagCommand("echo", "t1", "a;rm", BASH), null);
    assert.equal(tagCommand("grep '# cocheck-call:' x", "t1", "a", BASH), null);
    assert.equal(tagCommand("", "t1", "a", BASH), null);
    assert.equal(tagCommand("x".repeat(9_001), "t1", "a", BASH), null);
  });
  it("leaves a command that turns on verbose echo untagged (bash set -v prints the comment)", () => {
    for (const c of ["set -v; echo hi", "set -euv\necho hi", "set -o verbose; ls", "setopt VERBOSE; ls", "set -xv"]) assert.equal(tagCommand(c, "t1", "a", BASH), null, c);
    assert.notEqual(tagCommand("set -eu; echo hi", "t1", "a", BASH), null);
    assert.notEqual(tagCommand("echo verbose", "t1", "a", BASH), null);
    const r = spawnSync(BASH, ["-c", `eval ${sq("set -x; echo hi\n# cocheck-call:t:a")}`], { encoding: "utf8" });
    assert.ok(!(r.stdout + r.stderr).includes("cocheck-call"), "set -x never prints a comment");
  });
  it("a command that already ends in tag lines has them replaced by this call's", () => {
    assert.equal(tagCommand("echo hi\n# cocheck-call:old:x\n# cocheck-call:older:y", "t1", "a", BASH), "echo hi\n# cocheck-call:t1:a");
    assert.equal(tagCommand("echo '# cocheck-call:q:r'", "t1", "a", BASH), null, "a tag inside the command itself is left alone");
  });
  it("observedOnly: Python, Node and non-writing builtins only", () => {
    for (const c of ["python3 run.py", "cd sub && python3 -c \"print(1 > 0); x = 'a|b'\" && node build.js", "uv=1 python3.12 -u x.py", ".venv/bin/python -m pkg", "echo start; node -e 'x>1'"]) assert.equal(observedOnly(c), true, c);
    for (const c of ["python3 x.py > out.txt", "osascript save.applescript", "exec python3 build.py", "./build.sh", "soffice --convert-to xlsx a.csv", "python3 -I x.py", "python3 -Es x.py", "cp a b", "echo $(cat f)", "node `which x`", "bash run.sh", "python3 x.py | tee log", "sort -o f f", "npx tsx a.ts", "echo \"open"]) assert.equal(observedOnly(c), false, c);
  });
  it("strips only an exact trailing tag", () => {
    assert.equal(stripTag("echo '# cocheck-call:x:y'"), "echo '# cocheck-call:x:y'");
    assert.equal(stripTag("a\n# cocheck-call:x:y\nb"), "a\n# cocheck-call:x:y\nb");
  });
});

describe("behaviour identity on the shipped corpus (bash and zsh)", () => {
  for (const shell of SHELLS) {
    it(`${shell}: every command prints the same and exits the same tagged or not; the tag is never printed`, async () => {
      assert.equal(CORPUS.length, 30);
      let tagged = 0;
      const diffs: string[] = [];
      for (const [i, cmd] of CORPUS.entries()) {
        const root = await tmp(`corpus-${path.basename(shell)}-${i}`);
        const a = path.join(root, "a", "w");
        const b = path.join(root, "b", "w");
        await mkdir(a, { recursive: true });
        await mkdir(b, { recursive: true });
        const t = tagCommand(cmd, `toolu_c${i}`, "agentX", shell);
        if (t !== null) tagged++;
        const plain = runLikeClaude(shell, cmd, a, path.join(root, "hA"));
        const tag = runLikeClaude(shell, t ?? cmd, b, path.join(root, "hB"));
        const norm = (s: string, dir: string) => s.split(dir).join("<W>");
        if (norm(plain.out, a) !== norm(tag.out, b) || norm(plain.err, a) !== norm(tag.err, b) || plain.code !== tag.code) diffs.push(`#${i} ${JSON.stringify(cmd)}`);
        assert.ok(!tag.out.includes("cocheck-call") && !tag.err.includes("cocheck-call"), `tag printed by #${i}`);
        assert.deepEqual(records(evidenceDir(path.join(root, "hA"))), [], `untagged #${i} recorded nothing`);
        if (t !== null && /writeFileSync\('n\.txt'|open\('py\.txt','w'\)/.test(cmd) && (cmd.startsWith("node") || hasPython)) {
          const got = records(evidenceDir(path.join(root, "hB"))).filter((r) => r.op !== "spawn");
          assert.ok(got.length > 0 && got.every((r) => r.call === `toolu_c${i}` && r.agent === "agentX"), `#${i} records ${JSON.stringify(got)}`);
        }
      }
      assert.deepEqual(diffs, []);
      // Only the two commands that do not parse are left untagged.
      assert.equal(tagged, 28);
    });
  }
});

describe("write hooks", () => {
  it("Python and Node children of a tagged shell record their writes, renames and removes with the call and agent; reads are not recorded", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("hooks");
    await mkdir(path.join(w, "work"));
    const log = evidenceDir(path.join(w, "home"));
    const cmd = [
      `python3 -c "open('p.txt','w').write('x'); import os; os.rename('p.txt','q.txt'); open('q.txt').read()"`,
      `node -e "const fs=require('fs'); fs.writeFileSync('n.txt','y'); fs.appendFileSync('n.txt','z'); fs.readFileSync('n.txt'); fs.promises.writeFile('np.txt','z')"`,
      `node --input-type=module -e "import {writeFile} from 'node:fs/promises'; await writeFile('esm.txt','e')"`,
    ].join(" && ");
    const r = runLikeClaude(BASH, tagCommand(cmd, "toolu_W", "helper7", BASH)!, path.join(w, "work"), path.join(w, "home"));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out + r.err, "");
    const got = records(log).map((x) => `${x.via} ${x.op} ${path.basename(x.path)} ${x.call} ${x.agent}`).sort();
    assert.deepEqual(got, [
      "node write esm.txt toolu_W helper7",
      "node write n.txt toolu_W helper7",
      "node write np.txt toolu_W helper7",
      "python remove p.txt toolu_W helper7",
      "python write p.txt toolu_W helper7",
      "python write q.txt toolu_W helper7",
    ]);
  });
  it("an untracked or stopped session's python and node load no guard and leave nothing under the home; start takes effect on the next call, no restart", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("switch");
    const work = path.join(w, "work");
    await mkdir(work);
    const home = path.join(w, "home");
    const cmd = `python3 -c "open('p.txt','w').write('1')" && node -e "require('fs').writeFileSync('n.txt','1')"`;
    const sessionRuns = () => runLikeClaude(BASH, tagCommand(cmd, "toolu_S", "main", BASH)!, work, home, { leaveSwitch: true });
    const switchCall = (command: string) =>
      runHookRaw({
        argv: ["node", "hook.ts", "--host", "claude", "--folder", work],
        env: { COCHECK_HOME: home },
        stdin: (async function* () { yield Buffer.from(JSON.stringify({ session_id: "sess1", cwd: work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "sw", tool_input: { command } })); })(),
      });
    const jsonl = () => allRecords(evidenceDir(home));
    // Untracked, in a registered folder, with the session marked tagged: nothing is loaded, nothing is logged.
    const r1 = sessionRuns();
    assert.equal(r1.code, 0, r1.err);
    assert.deepEqual(jsonl(), []);
    assert.ok(existsSync(path.join(work, "p.txt")) && existsSync(path.join(work, "n.txt")), "the program's own writes still happened");
    // Start through the hook; the very next call's children are tagged.
    assert.equal((await switchCall("cocheck track start")).exitCode, 0);
    const r2 = sessionRuns();
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(jsonl().filter((x) => x.op !== "start").map((x) => `${x.via} ${x.op} ${x.call}`).sort(), ["node write toolu_S", "python write toolu_S"]);
    const logged = jsonl().length;
    // Stop: the next call's children load nothing again.
    assert.equal((await switchCall("cocheck track stop")).exitCode, 0);
    const r3 = sessionRuns();
    assert.equal(r3.code, 0, r3.err);
    assert.equal(jsonl().length, logged);
  });
  it("every hooked Python and Node child of a tagged call records a start with its interpreter; a child whose hook did not load records none", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("start");
    await mkdir(path.join(w, "work"));
    const cmd = `python3 -c "print(1)" >/dev/null && node -e "1"`;
    const r = runLikeClaude(BASH, tagCommand(cmd, "toolu_T", "helper2", BASH)!, path.join(w, "work"), path.join(w, "home"));
    assert.equal(r.code, 0, r.err);
    const got = allRecords(evidenceDir(path.join(w, "home")));
    assert.deepEqual(got.map((x) => `${x.via} ${x.op} ${x.call} ${x.agent}`).sort(), ["node start toolu_T helper2", "python start toolu_T helper2"]);
    for (const x of got) assert.ok(path.isAbsolute(x.path), x.path);
    // the hook kept out (PYTHONPATH and NODE_OPTIONS cleared): no start record, so "logged no write" is never trusted for these children
    const r2 = runLikeClaude(BASH, tagCommand(`PYTHONPATH= python3 -c "open('x.txt','w')" && NODE_OPTIONS= node -e "require('fs').writeFileSync('y.txt','1')"`, "toolu_U", "helper2", BASH)!, path.join(w, "work"), path.join(w, "home2"));
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(allRecords(evidenceDir(path.join(w, "home2"))), []);
    // untagged: nothing at all
    const r3 = runLikeClaude(BASH, `python3 -c "print(1)" >/dev/null`, path.join(w, "work"), path.join(w, "home3"));
    assert.equal(r3.code, 0, r3.err);
    assert.deepEqual(allRecords(evidenceDir(path.join(w, "home3"))), []);
  });
  it("a Python or Node child that starts another program records a spawn; starting python or node does not", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("spawn");
    await mkdir(path.join(w, "work"));
    const cmd = [
      `python3 -c "import subprocess, sys; subprocess.run(['true']); subprocess.run([sys.executable, '-c', 'pass'])"`,
      `node -e "const cp=require('child_process'); cp.execSync('true'); cp.spawnSync(process.execPath, ['-e','1'])"`,
    ].join(" && ");
    const r = runLikeClaude(BASH, tagCommand(cmd, "toolu_S", "main", BASH)!, path.join(w, "work"), path.join(w, "home"));
    assert.equal(r.code, 0, r.err);
    const got = records(evidenceDir(path.join(w, "home"))).map((x) => `${x.via} ${x.op} ${x.path}`).sort();
    assert.deepEqual(got, ["node spawn sh", "python spawn true"]);
  });
  it("a child of an inner shell (a nested session's untagged call) never takes the outer call's tag", async (t) => {
    // (`; true` keeps the inner shell alive: `bash -c "python3 ..."` alone execs python, which then is the outer call's own child.)
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("nested");
    await mkdir(path.join(w, "work"));
    const cmd = `bash -c "python3 -c \\"open('inner.txt','w').write('1')\\"; true" && python3 -c "open('outer.txt','w').write('2')"`;
    const r = runLikeClaude(BASH, tagCommand(cmd, "toolu_N", "main", BASH)!, path.join(w, "work"), path.join(w, "home"));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(records(evidenceDir(path.join(w, "home"))).map((x) => path.basename(x.path)), ["outer.txt"]);
  });
  it("writes outside the registered folders are not logged", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("roots");
    await mkdir(path.join(w, "work"));
    const outside = await tmp("outside");
    const cmd = `python3 -c "open('in.txt','w').write('1'); open('${outside}/out.txt','w').write('2')"`;
    runLikeClaude(BASH, tagCommand(cmd, "toolu_O", "main", BASH)!, path.join(w, "work"), path.join(w, "home"));
    assert.deepEqual(records(evidenceDir(path.join(w, "home"))).map((x) => path.basename(x.path)), ["in.txt"]);
  });
  it("the log files and folders are private (0600 / 0700)", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("perms");
    await mkdir(path.join(w, "work"));
    runLikeClaude(BASH, tagCommand(`python3 -c "open('a.txt','w').write('1')"`, "toolu_P", "main", BASH)!, path.join(w, "work"), path.join(w, "home"));
    const dir = evidenceDir(path.join(w, "home"));
    const log = readdirSync(dir).find((n) => n.endsWith(".jsonl"))!;
    const { statSync } = await import("node:fs");
    assert.equal(statSync(path.join(dir, log)).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
  it("with the shipped hooks gone (a Homebrew upgrade mid-session) python and node still run, silently, and log nothing", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("vanish");
    await mkdir(path.join(w, "work"));
    const shipped = path.join(w, "Cellar-hooks");
    await mkdir(shipped);
    for (const f of ["cocheck-preload.cjs", "sitecustomize.py"]) await copyFile(path.join(writeHooksDir(), f), path.join(shipped, f));
    const cmd = `python3 -c "open('a.txt','w').write('1'); print('py ok')" && node -e "require('fs').writeFileSync('b.txt','2'); console.log('node ok')"`;
    const before = runLikeClaude(BASH, tagCommand(cmd, "toolu_V1", "main", BASH)!, path.join(w, "work"), path.join(w, "home"), { hooksDir: shipped });
    assert.equal(before.out, "py ok\nnode ok\n");
    assert.equal(records(evidenceDir(path.join(w, "home"))).length, 2);
    await rm(shipped, { recursive: true, force: true });
    const after = runLikeClaude(BASH, tagCommand(cmd, "toolu_V2", "main", BASH)!, path.join(w, "work"), path.join(w, "home2"), { hooksDir: shipped });
    assert.equal(after.code, 0, after.err);
    assert.equal(after.out + after.err, "py ok\nnode ok\n");
    assert.deepEqual(records(evidenceDir(path.join(w, "home2"))), []);
  });
  it("the Node preload does not recurse into its own log write, and many writes stay one record per file", async () => {
    const w = await tmp("reentry");
    await mkdir(path.join(w, "work"));
    const log = evidenceDir(path.join(w, "home"));
    const cmd = `node -e "const fs=require('fs'); for (let i=0;i<200;i++) fs.writeFileSync('f'+(i%5)+'.txt', String(i)); console.log('ok')"`;
    const r = runLikeClaude(BASH, tagCommand(cmd, "toolu_R", "main", BASH)!, path.join(w, "work"), path.join(w, "home"));
    assert.equal(r.out, "ok\n");
    assert.equal(records(log).length, 5);
  });
  it("without a tag in any ancestor nothing is recorded; without COCHECK_WRITE_LOG the hooks are inert", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("untagged");
    await mkdir(path.join(w, "work"));
    const cmd = `python3 -c "open('a.txt','w').write('1')" && node -e "require('fs').writeFileSync('b.txt','2')"`;
    const r = runLikeClaude(BASH, cmd, path.join(w, "work"), path.join(w, "home"));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(records(evidenceDir(path.join(w, "home"))), []);
    // A tagged command in a session no Pre has marked: the hooks do not even look.
    const r2 = runLikeClaude(BASH, tagCommand(cmd, "toolu_U", "main", BASH)!, path.join(w, "work"), path.join(w, "home2"), { tagged: false });
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(records(evidenceDir(path.join(w, "home2"))), []);
  });
  it("sitecustomize chains to the user's own sitecustomize later on PYTHONPATH", async (t) => {
    if (!hasPython) return t.skip("no python3");
    const w = await tmp("chain");
    prepareSession(w, "s", [w], Date.now());
    const mine = path.join(w, "mine");
    await mkdir(mine);
    await writeFile(path.join(mine, "sitecustomize.py"), "import builtins\nbuiltins.USER_SITE_RAN = True\n");
    const r = spawnSync("python3", ["-c", "import builtins; print(getattr(builtins, 'USER_SITE_RAN', False))"], {
      env: { PATH: process.env.PATH, COCHECK_WRITE_LOG: path.join(w, "log"), COCHECK_TAG_SESSION: "s", PYTHONPATH: `${guardDir(w)}:${mine}` },
      encoding: "utf8",
    });
    assert.equal(r.stdout.trim(), "True", r.stderr);
  });
  it("the session environment lines put both hooks on every Bash call and keep what was there", async () => {
    const w = await tmp("envlines");
    const envFile = path.join(w, "env.sh");
    const home = path.join(w, "home with space");
    await writeFile(envFile, prepareSession(home, "sessA", [w], Date.now()));
    setTracking(home, "claude", "sessA", true);
    const g = guardDir(home);
    const show = `PYTHONPATH=/old NODE_OPTIONS=--trace-warnings; source ${sq(envFile)}; printf '%s\\n' "$COCHECK_WRITE_LOG" "$COCHECK_TAG_SESSION" "$PYTHONPATH" "$NODE_OPTIONS"`;
    const r = spawnSync(BASH, ["-c", show], { encoding: "utf8" });
    assert.equal(r.stdout, `${home}/attribution\nsessA\n${g}:/old\n--require "${g}/cocheck-preload.cjs" --trace-warnings\n`);
    assert.equal(sessionReady(home, "sessA"), true);
    assert.equal(sessionReady(home, "other"), false);
    // A guard that is gone (uninstall mid-session) sets nothing: no node ever exits on a missing --require.
    await rm(path.join(g, "cocheck-preload.cjs"));
    await rm(path.join(g, "sitecustomize.py"));
    const r2 = spawnSync(BASH, ["-c", show], { encoding: "utf8" });
    assert.equal(r2.stdout, `${home}/attribution\nsessA\n/old\n--trace-warnings\n`);
  });
});

describe("evidence reader", () => {
  it("reads only what was appended since the cursor, only whole lines, only paths the folder accepts", async () => {
    const home = await tmp("evhome");
    await mkdir(evidenceDir(home), { recursive: true });
    const log = path.join(evidenceDir(home), "writes-2026-10-23.jsonl");
    const rec = (call: string, p: string) => JSON.stringify({ v: 1, call, agent: "main", pid: 1, ts: 5, op: "write", path: p, via: "python" }) + "\n";
    await writeFile(log, rec("old", "/f/a.xlsx"));
    const st = startEvidence(home);
    await appendFile(log, rec("c1", "/f/a.xlsx") + rec("c2", "/elsewhere/b") + rec("c3", "/f/a.xlsx") + '{"v":1,"call":"half');
    const now = Date.parse("2026-10-23T12:00:00Z");
    readEvidence(home, st, (p) => (p.startsWith("/f/") ? p : undefined), now);
    assert.deepEqual(st.byPath, { "/f/a.xlsx": { calls: ["c1", "c3"], at: 5 } });
    await appendFile(log, `","agent":"main","pid":1,"ts":9,"op":"write","path":"/f/c.csv"}\n`);
    readEvidence(home, st, (p) => (p.startsWith("/f/") ? p : undefined), now);
    assert.deepEqual(st.byPath["/f/c.csv" as "/f/a.xlsx"], { calls: ["half"], at: 9 }, "a line half-written at the first pass is read whole at the next");
  });
});

// Adapter: two overlapping helper Bash calls, one workbook change.
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
async function adapterRig(attributionTag?: "auto" | "on" | "off") {
  const home = await tmp("home");
  const folder = await tmp("folder");
  const book = path.join(folder, "book.xlsx");
  await copyFile(probe(0), book);
  let clock = Date.parse("2026-10-23T12:00:00Z");
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock, ...(attributionTag ? { attributionTag } : {}) };
  const send = (over: Record<string, unknown>, taggedCall = false) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, { ...opts, taggedCall });
  };
  const helper = (n: number) => ({ agent_id: `helper${n}`, agent_type: "general-purpose" });
  /** A Pre; `tagged` says the CLI tagged the call (the default: both helpers run in a tagged session). */
  const pre = (id: string, n: number, input: Record<string, unknown> = { command: "python3 run.py" }, tool = "Bash", tagged = true) =>
    send({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: id, tool_input: input, ...helper(n) }, tagged);
  const post = (id: string, n: number, input: Record<string, unknown> = { command: "python3 run.py" }, tool = "Bash") =>
    send({ hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: id, tool_input: input, ...helper(n) });
  let pid = 1;
  const evidence = async (call: string, file = book, op = "write") => {
    await mkdir(evidenceDir(home), { recursive: true });
    pid++;
    // Named by today's wall-clock UTC date, as the hooks name it (the reader prunes logs older than three days by the wall clock).
    await appendFile(path.join(evidenceDir(home), `writes-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ v: 1, call, agent: "helper1", pid, ...(op === "start" ? { ppid: 1 } : {}), ts: clock, op, path: file, via: "python" }) + "\n");
  };
  const credited = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.filePath === book && s.prevSha256 !== null).map((s) => s.credited);
    } finally {
      l.close();
    }
  };
  await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  return { pre, post, evidence, credited, book, write: (n: number) => copyFile(probe(n), book) };
}

describe("attribution: positive write evidence ahead of open-call windows", () => {
  it("baseline: without evidence two overlapping helper calls share the change", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2);
    await t.write(1);
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  it("a tagged Python B that never logged a start record (its hook may not have loaded) keeps it joint", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2);
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  it("re-review: a tagged B running Python and Node with only a Python start record keeps it joint (the proof is per kind and process)", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2, { command: "python3 run.py && node build.js" });
    await t.evidence("B", "/usr/bin/python3", "start");
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  it("re-review: with a start record from each of B's processes, A's evidence credits A alone", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2, { command: "python3 run.py && node build.js" });
    await t.evidence("B", "/usr/bin/python3", "start");
    await t.evidence("B", "/opt/homebrew/bin/node", "start");
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A"]]);
  });
  it("re-review: two python3 runs in B with one start record keep it joint", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2, { command: "python3 a.py; python3 b.py" });
    await t.evidence("B", "/usr/bin/python3", "start");
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  it("a tagged B whose start record names an interpreter outside the system folders keeps it joint", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2);
    await t.evidence("B", "/tmp/venv/bin/python3", "start");
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  it("two tagged Python helpers: evidence that A's child wrote the workbook credits A alone, even at B's Post", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2);
    await t.evidence("B", "/usr/bin/python3", "start"); // B's child carried the hook
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A"]]);
  });
  it("setting off: the evidence is not read", async () => {
    const t = await adapterRig("off");
    await t.pre("A", 1);
    await t.pre("B", 2);
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  it("another open Bash call whose command names the file keeps it joint (a shell redirect leaves no record)", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2, { command: "cat x > book.xlsx" });
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2, { command: "cat x > book.xlsx" });
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  for (const cmd of ["osascript save.applescript", "exec python3 build.py", "./build.sh", "soffice --headless --convert-to xlsx in.csv"]) {
    for (const tagged of [true, false]) {
      it(`review case: B ${tagged ? "tagged" : "untagged"} runs \`${cmd}\` (writes where no hook sees): joint`, async () => {
        const t = await adapterRig();
        await t.pre("A", 1);
        await t.pre("B", 2, { command: cmd }, "Bash", tagged);
        await t.write(1);
        await t.evidence("A");
        await t.post("B", 2, { command: cmd });
        assert.deepEqual(t.credited(), [["A", "B"]]);
      });
    }
  }
  it("an untagged B (another session not in bypass mode) running Python keeps it joint", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2, { command: "python3 run.py" }, "Bash", false);
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  it("a tagged Python B whose child started another program (a spawn record) keeps it joint", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2);
    await t.write(1);
    await t.evidence("A");
    await t.evidence("B", "cp", "spawn");
    await t.post("B", 2);
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  it("a tagged B running Python with -I (no hook loads) keeps it joint", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2, { command: "python3 -I run.py" });
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2, { command: "python3 -I run.py" });
    assert.deepEqual(t.credited(), [["A", "B"]]);
  });
  // The record of a call that closed is not ignored: the write is credited to that call too (its tag names it), beside the open ones
  it("evidence naming a call that is no longer open credits that call, beside the calls open", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.post("A", 1);
    await t.pre("B", 2);
    await t.pre("C", 2);
    await t.evidence("A");
    await t.write(1);
    await t.post("C", 2);
    assert.deepEqual(t.credited(), [["A", "B", "C"]]);
  });
  it("used evidence is spent: a later change with no new record goes back to the window rule", async () => {
    const t = await adapterRig();
    await t.pre("A", 1);
    await t.pre("B", 2);
    await t.evidence("B", "/usr/bin/python3", "start");
    await t.write(1);
    await t.evidence("A");
    await t.post("B", 2);
    await t.pre("C", 2);
    await t.write(2);
    await t.post("C", 2);
    assert.deepEqual(t.credited(), [["A"], ["A", "C"]]);
  });
});

describe("hook CLI: the Pre output, the Post record and SessionStart", () => {
  async function cliRig(started = true) {
    const home = await tmp("clihome");
    const folder = await tmp("clifolder");
    await copyFile(probe(0), path.join(folder, "book.xlsx"));
    if (started) prepareSession(home, "s1", [folder], Date.now());
    const run = (payload: unknown, env: NodeJS.ProcessEnv = {}, argv: string[] = []) =>
      runHook({
        argv: ["node", "hook.ts", "--host", "claude", "--folder", folder, ...argv],
        env: { COCHECK_HOME: home, SHELL: BASH, ...env },
        stdin: (async function* () {
          yield Buffer.from(JSON.stringify(payload));
        })(),
      });
    return { home, folder, run };
  }
  const pre = (folder: string, mode: string, command = "python3 run.py") => ({
    session_id: "s1", cwd: folder, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_X", agent_id: "ag1", permission_mode: mode,
    tool_input: { command, description: "run it", timeout: 5000 },
  });

  it("bypassPermissions: updatedInput is the whole input with the tagged command, and no permission decision", async () => {
    const r = await cliRig();
    const res = await r.run(pre(r.folder, "bypassPermissions"));
    assert.equal(res.exitCode, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "python3 run.py\n# cocheck-call:toolu_X:ag1", description: "run it", timeout: 5000 } } });
  });
  it("the default tags in every mode; auto in a mode that consults allow rules prints nothing; off prints nothing", async () => {
    const r = await cliRig();
    assert.match((await r.run(pre(r.folder, "default"))).stdout, /cocheck-call:toolu_X:ag1/);
    assert.match((await r.run({ ...pre(r.folder, "dontAsk"), tool_use_id: "toolu_D" })).stdout, /cocheck-call:toolu_D:ag1/);
    assert.equal((await r.run({ ...pre(r.folder, "default"), tool_use_id: "toolu_A" }, { COCHECK_ATTRIBUTION_TAG: "auto" })).stdout, "");
    assert.match((await r.run({ ...pre(r.folder, "default"), tool_use_id: "toolu_Y" }, { COCHECK_ATTRIBUTION_TAG: "on" })).stdout, /cocheck-call:toolu_Y:ag1/);
    assert.equal((await r.run({ ...pre(r.folder, "bypassPermissions"), tool_use_id: "toolu_Z" }, {}, ["--attribution-tag", "off"])).stdout, "");
  });
  it("the Post's tagged command is recorded without the tag", async () => {
    const r = await cliRig();
    await r.run(pre(r.folder, "bypassPermissions"));
    // A session's task opens at its first change, so the call writes a file for its op to reach the ledger.
    await writeFile(path.join(r.folder, "out.txt"), "x");
    // As the tagged call's Python child would log it (a tagged Python that logged no write is credited with nothing)
    await appendFile(path.join(evidenceDir(r.home), `writes-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ v: 1, call: "toolu_X", agent: "ag1", pid: 1, ts: Date.now(), op: "write", path: path.join(r.folder, "out.txt"), via: "python" }) + "\n");
    const res = await r.run({ ...pre(r.folder, "bypassPermissions"), hook_event_name: "PostToolUse", tool_input: { command: "python3 run.py\n# cocheck-call:toolu_X:ag1", description: "run it" }, tool_response: {} });
    assert.equal(res.exitCode, 0, res.stderr);
    const db = new DatabaseSync(path.join(r.home, "ledger.sqlite"), { readOnly: true });
    try {
      const dump = JSON.stringify(db.prepare("SELECT * FROM ops").all());
      assert.ok(dump.includes("python3 run.py"), "the op holds the command");
      assert.ok(!dump.includes("cocheck-call"), "no op holds the tag");
    } finally {
      db.close();
    }
  });
  it("SessionStart appends the write hooks' environment to CLAUDE_ENV_FILE and records nothing", async () => {
    const r = await cliRig();
    const envFile = path.join(r.home, "session-env.sh");
    const res = await r.run({ session_id: "s1", cwd: r.folder, hook_event_name: "SessionStart", source: "startup", permission_mode: "bypassPermissions" }, { CLAUDE_ENV_FILE: envFile });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(await readFile(envFile, "utf8"), sessionEnvLines(r.home, "s1"));
    assert.deepEqual(JSON.parse(await readFile(rootsFile(r.home), "utf8")), [r.folder]);
    assert.equal(existsSync(path.join(r.home, "journal")), false);
    // The documented SessionStart payload has no permission_mode: auto still sets the (inert until tagged) environment; off sets nothing.
    const noMode = path.join(r.home, "nomode-env.sh");
    await r.run({ session_id: "s3", cwd: r.folder, hook_event_name: "SessionStart", source: "startup" }, { CLAUDE_ENV_FILE: noMode });
    assert.equal(await readFile(noMode, "utf8"), sessionEnvLines(r.home, "s3"));
    const off = path.join(r.home, "off-env.sh");
    await r.run({ session_id: "s2", cwd: r.folder, hook_event_name: "SessionStart" }, { CLAUDE_ENV_FILE: off }, ["--attribution-tag", "off"]);
    assert.equal(existsSync(off), false, "off sets nothing");
  });
  it("a session whose SessionStart never ran (an install from before per-call tags) is not tagged", async () => {
    const r = await cliRig(false);
    assert.equal((await r.run(pre(r.folder, "bypassPermissions"))).stdout, "");
  });
  it("a Pre that tags marks its session, so the hooks start looking", async () => {
    const r = await cliRig();
    assert.equal(existsSync(path.join(activeDir(r.home), "s1")), false);
    await r.run(pre(r.folder, "bypassPermissions"));
    assert.equal(existsSync(path.join(activeDir(r.home), "s1")), true);
  });
});
