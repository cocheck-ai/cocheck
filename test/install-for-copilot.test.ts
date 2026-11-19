import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { installStatus, runInstall, type InstallResult } from "../src/install.ts";

// `--for copilot`, comma lists, `both` and `all`. Every run uses a scratch HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME and COCHECK_HOME
// under the temp dir; the real ~/.claude, ~/.codex, ~/.copilot and Keychain are never read or written.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");

let sandbox: string;
let userHome: string;
let dataHome: string;
let copilotHome: string;
const hooksFile = () => path.join(copilotHome, "hooks", "cocheck.json");
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-h007-inst-")));
  userHome = path.join(sandbox, "home");
  copilotHome = path.join(userHome, ".copilot");
  dataHome = path.join(sandbox, "data");
  await mkdir(userHome, { recursive: true });
  const folder = path.join(sandbox, "work");
  await mkdir(folder, { recursive: true });
  return folder;
}
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex"), COPILOT_HOME: copilotHome });
const run = (argv: string[]): Promise<InstallResult> =>
  runInstall({ argv: ["node", "install.ts", ...argv], env: env(), cwd: sandbox, hookPath, stopReview: async () => "no review process was running" });
const install = (folder: string, flags: string[]) => run(["--home", dataHome, "--folder", folder, ...flags]);
const json = async (f: string) => JSON.parse(await readFile(f, "utf8"));
const EVENTS = ["agentStop", "postToolUse", "postToolUseFailure", "preToolUse", "subagentStop", "userPromptSubmitted"];

describe("--for copilot", () => {
  it("writes one CoCheck-owned file, one entry per event, each naming its event; preToolUse can never block the tool", posixOnly("the hook entries are `bash` commands; Windows writes a different command field"), async () => {
    const folder = await fresh();
    const r = await install(folder, ["--for", "copilot"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const file = await json(hooksFile());
    assert.equal(file.version, 1);
    assert.deepEqual(Object.keys(file.hooks).sort(), EVENTS);
    for (const [event, list] of Object.entries<any[]>(file.hooks)) {
      assert.equal(list.length, 1);
      assert.equal(list[0].type, "command");
      assert.match(list[0].bash, /^COCHECK_MANAGED=1 COCHECK_HOME=/);
      assert.match(list[0].bash, new RegExp(`--host copilot --event ${event}( \\|\\| true)?$`));
      assert.equal(/\|\| true$/.test(list[0].bash), event === "preToolUse", `${event}: only preToolUse fails open`);
    }
    assert.ok(!existsSync(path.join(userHome, ".claude", "settings.json")) && !existsSync(path.join(userHome, ".codex")), "no other host's config was created (the skill folders under ~/.claude are the skill, not a hook)");
    assert.match(r.stdout, /trust step for user-level hooks: unverified/);
    assert.ok(!/CoCheck tells Copilot/.test(r.stdout), "Copilot gets no prompt context");
    assert.match(installStatus(env(), userHome).text, /Copilot: installed/);
  });

  it("backs up an existing file of that name first and keeps the other files of the folder", async () => {
    const folder = await fresh();
    await mkdir(path.dirname(hooksFile()), { recursive: true });
    await writeFile(hooksFile(), '{"version":1,"hooks":{"sessionStart":[{"type":"command","bash":"echo mine"}]}}\n');
    await writeFile(path.join(path.dirname(hooksFile()), "mine.json"), '{"version":1,"hooks":{}}\n');
    const r = await install(folder, ["--for", "copilot"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(await readFile(`${hooksFile()}.cocheck-backup`, "utf8"), /echo mine/);
    assert.ok(existsSync(path.join(path.dirname(hooksFile()), "mine.json")));
  });

  it("uninstall removes only that file; another file of the folder stays; a same-named file that is not CoCheck's stays", async () => {
    const folder = await fresh();
    await install(folder, ["--for", "copilot"]);
    await writeFile(path.join(path.dirname(hooksFile()), "mine.json"), '{"version":1,"hooks":{}}\n');
    const r = await run(["--home", dataHome, "--uninstall", "--for", "copilot"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(!existsSync(hooksFile()));
    assert.ok(existsSync(path.join(path.dirname(hooksFile()), "mine.json")));
    await writeFile(hooksFile(), '{"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"echo not-cocheck"}]}}\n');
    const again = await run(["--home", dataHome, "--uninstall", "--for", "copilot"]);
    assert.match(again.stdout, /no hook entries to remove/);
    assert.match(await readFile(hooksFile(), "utf8"), /not-cocheck/);
  });

  it("the installed hook records a Copilot Pre through the real hook entry", async () => {
    const folder = await fresh();
    await install(folder, ["--for", "copilot"]);
    const r = await runHook({
      argv: ["node", "hook.ts", "--host", "copilot", "--event", "preToolUse"],
      env: { COCHECK_HOME: dataHome, COCHECK_MANAGED: "1", HOME: userHome },
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify({ sessionId: "s-1", cwd: folder, toolName: "bash", toolArgs: { command: "ls" } }));
      })(),
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, "");
  });
});

describe("--for lists", () => {
  it("a comma list installs exactly those hosts, in any order, once", async () => {
    const folder = await fresh();
    const r = await install(folder, ["--for", "copilot,claude,copilot"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(existsSync(hooksFile()) && existsSync(path.join(userHome, ".claude", "settings.json")));
    assert.ok(!existsSync(path.join(userHome, ".codex", "config.toml")), "Codex was not named");
  });
  it("both is claude and codex; all names every host", async () => {
    let folder = await fresh();
    let r = await install(folder, ["--for", "both"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(existsSync(path.join(userHome, ".codex", "config.toml")) && !existsSync(hooksFile()), "both leaves Copilot alone");
    await rm(sandbox, { recursive: true, force: true });
    folder = await fresh();
    r = await install(folder, ["--for", "all"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(existsSync(hooksFile()) && existsSync(path.join(userHome, ".codex", "config.toml")) && existsSync(path.join(userHome, ".claude", "settings.json")));
  });
  it("an unknown name in a list refuses before anything is written", async () => {
    const folder = await fresh();
    const r = await install(folder, ["--for", "claude,gemini"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--for must be/);
    assert.ok(!existsSync(path.join(userHome, ".claude")) && !existsSync(dataHome));
  });
  it("uninstalling one host of a list leaves the others recorded", async () => {
    const folder = await fresh();
    await install(folder, ["--for", "claude,copilot"]);
    const r = await run(["--home", dataHome, "--uninstall", "--for", "copilot"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /still installed for Claude/);
    assert.ok(existsSync(path.join(userHome, ".claude", "settings.json")));
  });
});
