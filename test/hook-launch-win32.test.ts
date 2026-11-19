// the Node hook launcher and the win32 hook command. The launcher runs on the Mac here; the win32 command is pure string work.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { platformFor } from "../src/platform/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "scripts", "hook-launch.mjs");
const win = platformFor("win32");
const darwin = platformFor("darwin");
const spec = { dataHome: "C:\\Users\\me\\CoCheck Data", launcher: "C:\\Program Files\\CoCheck\\scripts\\hook-launch.mjs", hookPath: "C:\\Program Files\\CoCheck\\dist\\hook.js", host: "claude" };

describe("win32 hookCommand", () => {
  it("builds a Node-direct command with no shell and no env prefix", () => {
    assert.equal(
      win.hookCommand.build(spec),
      'node "C:\\Program Files\\CoCheck\\scripts\\hook-launch.mjs" COCHECK_MANAGED=1 --home "C:\\Users\\me\\CoCheck Data" "C:\\Program Files\\CoCheck\\dist\\hook.js" --host claude',
    );
    const pinned = win.hookCommand.build({ ...spec, node: "C:\\Program Files\\nodejs\\node.exe" });
    assert.ok(pinned.includes(' --node "C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\CoCheck\\dist\\hook.js"'));
    assert.ok(!/\/bin\/sh|'/.test(win.hookCommand.build(spec)));
  });

  it("round trips with and without a pinned Node, and marks its own commands", () => {
    for (const s of [spec, { ...spec, node: "D:\\n\\node.exe", host: "codex" }]) {
      const c = win.hookCommand.build(s);
      assert.deepEqual(win.hookCommand.parse(c), s);
      assert.equal(win.hookCommand.isMarked(c), true);
    }
    assert.equal(win.hookCommand.isMarked(`${win.hookCommand.build(spec)} --event x`), true);
  });

  it("refuses commands it did not write (the a foreign command read as CoCheck's)", () => {
    const c = win.hookCommand.build(spec);
    assert.equal(win.hookCommand.parse(`${c} & del *`), undefined);
    assert.equal(win.hookCommand.parse(`${c} --event x`), undefined);
    assert.equal(win.hookCommand.parse(`echo COCHECK_MANAGED=1 & del *`), undefined);
    assert.equal(win.hookCommand.parse(darwin.hookCommand.build({ ...spec, launcher: "/l.sh", hookPath: "/h.js", dataHome: "/d" })), undefined);
    assert.equal(win.hookCommand.isMarked("echo COCHECK_MANAGED=1"), false);
  });

  it("refuses a path that cmd or PowerShell would still expand inside double quotes", () => {
    for (const bad of ['C:\\a"b', "C:\\100%", "C:\\$env", "C:\\a`b", "C:\\a!b", "C:\\a^b"]) {
      assert.throws(() => win.hookCommand.build({ ...spec, dataHome: bad }), /cannot put this path/);
    }
  });

});

describe("darwin command bytes are unchanged (Codex trust is not reset)", () => {
  it("pins the exact bytes", () => {
    assert.equal(
      darwin.hookCommand.build({ dataHome: "/h", launcher: "/l/hook-launch.sh", hookPath: "/d/hook.js", host: "codex", node: "/n/node" }),
      "COCHECK_MANAGED=1 COCHECK_HOME='/h' COCHECK_NODE='/n/node' /bin/sh '/l/hook-launch.sh' '/d/hook.js' --host codex",
    );
  });
});

describe("hook-launch.mjs contract", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  const hook = (name: string, body: string): string => {
    const p = path.join(scratch, name);
    writeFileSync(p, body);
    return p;
  };
  const run = (home: string, hookPath: string, input: string, extra: string[] = []) =>
    spawnSync(process.execPath, [launcher, "COCHECK_MANAGED=1", "--home", home, ...extra, hookPath, "--host", "claude"], { input, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  const echo = hook("echo.mjs", 'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(0, "utf8") + "|" + process.argv.slice(2).join(",") + "|" + process.env.COCHECK_HOME + "|" + process.env.COCHECK_MANAGED);');
  const fail = hook("fail.mjs", 'process.stderr.write("boom reason\\n"); process.exit(3);');
  const quiet = hook("quiet.mjs", "");

  it("passes stdin, args and env to the hook and its stdout back, exit 0", () => {
    const home = path.join(scratch, "h1");
    const r = run(home, echo, "payload");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `payload|--host,claude|${home}|1`);
    assert.equal(existsSync(path.join(home, "not-recording.txt")), false);
  });

  it("non-zero exit: same status, stderr kept, not-recording.txt with the shell launcher's wording", () => {
    const home = path.join(scratch, "h2");
    const r = run(home, fail, "");
    assert.equal(r.status, 3);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /boom reason/);
    const text = readFileSync(path.join(home, "not-recording.txt"), "utf8");
    assert.match(text, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\nThe hook exited 3 under Node v\d+\.\d+\.\d+ \(CoCheck needs 22\.18 or newer\): boom reason\n\n?$/);
  });

  it("the next successful hook deletes the file, and a quiet hook writes nothing to stdout (UserPromptSubmit-only text unchanged)", () => {
    const home = path.join(scratch, "h3");
    run(home, fail, "");
    assert.equal(existsSync(path.join(home, "not-recording.txt")), true);
    const r = run(home, quiet, "{}");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    assert.equal(existsSync(path.join(home, "not-recording.txt")), false);
  });

  it("a pinned --node that does not exist falls back to the running Node", () => {
    const r = run(path.join(scratch, "h4"), echo, "x", ["--node", path.join(scratch, "no-such-node")]);
    assert.equal(r.status, 0, r.stderr);
  });
});
