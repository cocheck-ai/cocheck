import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStatus, runInstall, type InstallResult } from "../src/install.ts";
import { loadOutsiderHarnesses } from "../src/hosts/index.ts";
import { posixOnly } from "./helpers/platform.ts";
import { TOY } from "./harness-toy-rig.ts";

// `cocheck install --for <key>` for a harness loaded from the person's folder: CoCheck prints the hook entries to add and edits nothing of the harness's.
// Built-in hosts keep their automatic install. Every run uses a scratch HOME and data home.
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");

let sandbox: string;
let userHome: string;
let dataHome: string;
let toyHome: string;
afterEach(async () => {
  loadOutsiderHarnesses(undefined);
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function fresh(withToy = true): Promise<string> {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-harness-inst-")));
  userHome = path.join(sandbox, "home");
  toyHome = path.join(userHome, ".toyagent");
  dataHome = path.join(sandbox, "data");
  await mkdir(path.join(userHome, ".claude"), { recursive: true });
  const folder = path.join(sandbox, "work");
  await mkdir(folder, { recursive: true });
  if (withToy) await cp(TOY, path.join(dataHome, "harnesses", "toyagent"), { recursive: true });
  return folder;
}
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex"), COPILOT_HOME: path.join(userHome, ".copilot"), TOYAGENT_HOME: toyHome });
const install = (folder: string, flags: string[]): Promise<InstallResult> =>
  runInstall({ argv: ["node", "install.ts", "--home", dataHome, "--folder", folder, ...flags], env: env(), cwd: sandbox, hookPath, stopReview: async () => "no review process was running" });

describe("install for an outsider harness", () => {
  it("prints the config path and the exact hook entries, and writes nothing of the harness's", posixOnly("the printed command is a POSIX command line"), async () => {
    const folder = await fresh();
    const r = await install(folder, ["--for", "toyagent"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const file = path.join(toyHome, "hooks.json");
    assert.ok(!existsSync(file) && !existsSync(toyHome), "the harness's config and folder are not created");
    assert.ok(r.stdout.includes(`Add these hooks to ${file}`), r.stdout);
    const start = r.stdout.indexOf("{\n", r.stdout.indexOf("Add these hooks to"));
    const printed = JSON.parse(r.stdout.slice(start, r.stdout.indexOf("\n}\n", start) + 2));
    assert.equal(printed.version, 1);
    assert.deepEqual(Object.keys(printed.hooks).sort(), ["afterTool", "beforeTool", "finished", "toolFailed", "userPrompt"]);
    for (const [event, list] of Object.entries<any[]>(printed.hooks)) {
      assert.equal(list.length, 1);
      assert.match(list[0].run, /^COCHECK_MANAGED=1 COCHECK_HOME=/);
      assert.ok(list[0].run.endsWith(`--host toyagent --event ${event}`), list[0].run);
      assert.ok(list[0].run.includes(hookPath) || list[0].run.includes("hook"), "the real hook command");
    }
    assert.ok(!existsSync(path.join(toyHome, "skills")), "no skill folder either");
    assert.ok(!/Toy Agent: hooks in/.test(r.stdout), "it is not reported as installed");
  });

  it("`all`, `both` and no --for never pick an outsider; a built-in host is still installed by editing its config", async () => {
    const folder = await fresh();
    for (const flags of [["--for", "all"], ["--for", "both"], []]) {
      const r = await install(folder, flags);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(!r.stdout.includes("Add these hooks"), `${flags.join(" ")}: nothing printed for the outsider`);
      assert.ok(!existsSync(toyHome));
    }
    const settings = JSON.parse(await readFile(path.join(userHome, ".claude", "settings.json"), "utf8"));
    assert.ok(JSON.stringify(settings).includes("COCHECK_MANAGED=1"), "Claude's settings carry CoCheck's hooks");
    assert.ok(!/toyagent/i.test(installStatus(env(), userHome).text), "status lists no outsider as installed");
  });

  it("uninstall says there is nothing of the harness's to remove", async () => {
    const folder = await fresh();
    const r = await install(folder, ["--for", "toyagent", "--uninstall"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /Toy Agent: CoCheck never edited this harness's config/);
  });

  it("a workspace-scoped config ({project} in install.path, Cursor's manifest) is named in the task folder, on install and uninstall", posixOnly("the printed command is a POSIX command line"), async () => {
    const folder = await fresh(false);
    await cp(path.join(import.meta.dirname, "..", "public-kit", "harness", "harnesses", "cursor"), path.join(dataHome, "harnesses", "cursor"), { recursive: true });
    const r = await install(folder, ["--for", "cursor"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const file = path.join(folder, ".cursor", "hooks.json");
    assert.ok(r.stdout.includes(`Add these hooks to ${file}`), r.stdout);
    assert.ok(!existsSync(path.join(folder, ".cursor")), "the harness's config is not created");
    const start = r.stdout.indexOf("{\n", r.stdout.indexOf("Add these hooks to"));
    const printed = JSON.parse(r.stdout.slice(start, r.stdout.indexOf("\n}\n", start) + 2));
    assert.ok(printed.hooks.preToolUse[0].command.endsWith("--host cursor || true"), printed.hooks.preToolUse[0].command);
    const u = await install(folder, ["--for", "cursor", "--uninstall"]);
    assert.equal(u.exitCode, 0, u.stderr);
    assert.ok(u.stdout.includes(`delete the CoCheck entries you added to ${file}`), u.stdout);
  });

  it("a manifest that did not load is named when --for asks for its key, and `cocheck status` names it", async () => {
    const folder = await fresh(false);
    await mkdir(path.join(dataHome, "harnesses", "toyagent"), { recursive: true });
    await cp(path.join(TOY, "cocheck-harness.json"), path.join(dataHome, "harnesses", "toyagent", "cocheck-harness.json"));
    const bad = JSON.parse(readFileSync(path.join(TOY, "cocheck-harness.json"), "utf8"));
    bad.events.beforeTool = "tool-pree";
    await (await import("node:fs/promises")).writeFile(path.join(dataHome, "harnesses", "toyagent", "cocheck-harness.json"), JSON.stringify(bad));
    const r = await install(folder, ["--for", "toyagent"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /toyagent\/cocheck-harness\.json: events\.beforeTool: unknown kind "tool-pree"/);
    // A built-in install in the same home still works, and its status line names the skipped manifest.
    const ok = await install(folder, ["--for", "claude"]);
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.match(installStatus(env(), userHome).text, /Harness manifest skipped: toyagent\/cocheck-harness\.json: events\.beforeTool: unknown kind "tool-pree"/);
  });
});
