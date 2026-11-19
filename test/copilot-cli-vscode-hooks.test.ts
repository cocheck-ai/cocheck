import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { runHook, type HookExit } from "../src/hook-cli.ts";
import { DatabaseSync } from "node:sqlite";
import { setTracking } from "../src/tracking.ts";
import { installStatus, runInstall, type InstallResult } from "../src/install.ts";

// Copilot CLI and VS Code helpers. The events are the real probe records (platforms/copilot-cli/versions/1.0.98 and
// platforms/copilot-vscode/versions/1.140.0); only the scratch paths in them are swapped for a temp folder. Every home, folder and
// COPILOT_HOME here is a fresh temp dir: the real ~/.copilot and ~/CoCheckData are never touched.
const PLATFORMS = path.join(import.meta.dirname, "..", "platforms");
const CLI_RUN = path.join(PLATFORMS, "copilot-cli", "versions", "1.0.98", "hook-calls-camel.jsonl");
const VSCODE_RUN = path.join(PLATFORMS, "copilot-vscode", "versions", "1.140.0", "hook-calls-vscode.jsonl");

interface Rec {
  event: string;
  stdin: Record<string, any>;
}
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async (prefix: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${prefix}-`)));
  dirs.push(d);
  return d;
};

/** The records of a probe file, `n` lines of it, with the probe's scratch folder replaced by `folder`. */
function records(file: string, folder: string, n: number): Rec[] {
  const text = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, n).join("\n");
  const swapped = text.split("<scratch>/ws").join(folder).split("/Users/<user>/Desktop/vscode-probe").join(folder);
  return swapped.split("\n").map((l) => {
    const d = JSON.parse(l);
    return { event: d.event_arg, stdin: d.stdin };
  });
}

async function rig() {
  const root = await tmp("rig");
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  const copilotHome = path.join(root, "copilot");
  await mkdir(home);
  await mkdir(folder);
  await mkdir(path.join(copilotHome, "session-state"), { recursive: true });
  process.env.COPILOT_HOME = copilotHome;
  const fire = (rec: Rec, host = "copilot", at?: number): Promise<HookExit> =>
    runHook({ argv: ["node", "hook.ts", "--host", host, "--event", rec.event], env: { COCHECK_HOME: home }, ...(at === undefined ? {} : { journalNow: () => at }), stdin: (async function* () { yield Buffer.from(JSON.stringify(rec.stdin)); })() });
  /** The file the call writes, as the host would have written it by its Post (the records hold the patch or the command). */
  const apply = async (rec: Rec) => {
    if (rec.event !== "postToolUse") return;
    const args = rec.stdin.toolArgs;
    const patch = typeof args === "string" ? /\*\*\* Add File: (\S+)\n\+(.*)\n/.exec(args) : undefined;
    const shell = typeof args?.command === "string" ? /printf '(\w+)' > (\S+)/.exec(args.command) : undefined;
    if (patch) await writeFile(path.isAbsolute(patch[1]!) ? patch[1]! : path.join(folder, patch[1]!), patch[2]! + "\n");
    else if (shell) await writeFile(path.join(folder, shell[2]!), shell[1]!);
  };
  const ops = (): Array<Record<string, any>> => {
    const ledger = openLedger(home);
    try {
      return ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>));
    } finally {
      ledger.close();
    }
  };
  /** Who each file's change was credited to, by file name: an agent id, or "main" for a call with none; "tool:<name>" when a launcher call was credited (never right). */
  const owners = (): Record<string, string[]> => {
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    try {
      const calls = new Map(ops().filter((o) => typeof o.tool_use_id === "string").map((o) => [o.tool_use_id as string, o] as const));
      const out: Record<string, Set<string>> = {};
      for (const row of db.prepare("SELECT s.credited_json AS c, f.file_path AS p FROM file_states f JOIN steps s ON s.id = f.step_id").all() as Array<{ c: string; p: string }>) {
        const set = (out[path.basename(row.p)] ??= new Set());
        for (const id of JSON.parse(row.c) as string[]) {
          const call = calls.get(id);
          set.add(call === undefined ? `unknown:${id}` : call.tool_name === "task" ? `tool:task` : (call.agent_id ?? "main"));
        }
      }
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
    } finally {
      db.close();
    }
  };
  const run = async (recs: Rec[], tamper: (rec: Rec) => Rec = (x) => x, at?: number) => {
    const exits: Array<{ event: string; exit: HookExit }> = [];
    for (const rec of recs) {
      await apply(rec);
      exits.push({ event: rec.event, exit: await fire(tamper(rec), "copilot", at) });
    }
    return exits;
  };
  return { root, home, folder, copilotHome, fire, apply, ops, owners, run };
}

const CLI = { main: "3456c946-0d3c-4981-9ba5-5bdcae9c5916", writer: "d80fa121-d6f0-4c03-8d52-79eba1a94783", builtin: "6c6209db-802c-478d-8584-b9e914b0c085" };
const VS = { main: "412734f1-b271-4477-9465-1b5ded4e0d6f", writer: "451ac4e2-6ae0-4c14-9460-2086e1f44254", builtin: "0eb5c35c-961e-49d1-9630-2bc2e3458fee" };
const neverBlocks = (exits: Array<{ event: string; exit: HookExit }>) => {
  for (const { event, exit } of exits) {
    assert.ok(exit.exitCode === 0 || exit.exitCode === 1, `${event}: exit ${exit.exitCode} (2 would block the host's call)`);
    assert.equal(exit.stdout, "", `${event}: the hook prints no decision`);
  }
};

describe("Copilot CLI helpers are credited from agentId on their inner calls", () => {
  it("each helper's write is the helper's own, the main line's stays the main line's, no launcher call is credited, the finish is recorded", async () => {
    const r = await rig();
    const recs = records(CLI_RUN, r.folder, 31);
    setTracking(r.home, "copilot", CLI.main, true, r.folder);
    neverBlocks(await r.run(recs));
    assert.deepEqual(r.owners(), { "a.txt": ["main"], "sub1.txt": [CLI.writer], "sub2.txt": [CLI.builtin] });
    const ops = r.ops();
    const inner = ops.filter((o) => o.agent_id !== undefined && o.tool_name !== undefined);
    assert.deepEqual([...new Set(inner.map((o) => `${o.agent_type}:${o.session_id}`))].sort(), [`general-purpose:${CLI.main}`, `writer:${CLI.main}`], "a helper's calls belong to the main session, not to the helper's own session id");
    assert.ok(inner.every((o) => typeof o.launch_tool_use_id === "string"), "each helper call names the task call that launched it");
    const finishes = ops.filter((o) => o.hookEvent === "SubagentStop").map((o) => [o.agent_id, o.agent_type, o.finish.text]);
    assert.deepEqual(finishes, [[CLI.writer, "writer", "done"], [CLI.builtin, "general-purpose", "Created `sub2.txt` containing exactly `builtin`."]]);
    assert.equal(ops.filter((o) => o.hookEvent === "Stop").length >= 0, true);
  });

  it("a failing shell command (success resultType, exit code in the text) is a failed call; a zero exit is not", async () => {
    const r = await rig();
    setTracking(r.home, "copilot", CLI.main, true, r.folder);
    await r.run(records(CLI_RUN, r.folder, 31));
    const bash = r.ops().filter((o) => o.tool_name === "bash");
    assert.equal(bash.length, 1);
    assert.equal(bash[0]!.closedBy, "failure");
    assert.match(bash[0]!.error, /exit code 1/);
  });

  it("no exit-code marker in the text is unknown, not a failure and not a success claim", async () => {
    const r = await rig();
    setTracking(r.home, "copilot", CLI.main, true, r.folder);
    const recs = records(CLI_RUN, r.folder, 9).filter((x) => x.event !== "sessionStart");
    // the failing ls, with its marker removed from the text
    await r.run(recs, (rec) => (rec.event === "postToolUse" && rec.stdin.toolName === "bash" ? { ...rec, stdin: { ...rec.stdin, toolResult: { ...rec.stdin.toolResult, textResultForLlm: "ls: /nonexistent_dir_t147: No such file or directory" } } } : rec));
    const bash = r.ops().filter((o) => o.tool_name === "bash");
    assert.equal(bash[0]!.closedBy, "post");
    assert.equal(bash[0]!.error, undefined);
  });
});

describe("VS Code helpers run under their own session id", () => {
  it("tracked parent: each helper's write is credited to that helper (linked by the launch prompt, live)", async () => {
    const r = await rig();
    setTracking(r.home, "copilot", VS.main, true, r.folder);
    neverBlocks(await r.run(records(VSCODE_RUN, r.folder, 36)));
    assert.deepEqual(r.owners(), { "a.txt": ["main"], "sub1.txt": [VS.writer], "sub2.txt": [VS.builtin] });
    const finishes = r.ops().filter((o) => o.hookEvent === "SubagentStop").map((o) => [o.agent_id, o.agent_type]);
    assert.deepEqual(finishes, [[VS.writer, "writer"], [VS.builtin, "general-purpose"]]);
    assert.ok(r.ops().every((o) => o.session_id === undefined || o.session_id === VS.main), "nothing is recorded under a helper's own session id");
    assert.equal(existsSync(path.join(r.home, "copilot-held")) ? readdirSync(path.join(r.home, "copilot-held")).length : 0, 0);
  });

  it("tracked parent, no prompt match: the helper's calls are held, then credited to the helper when its subagentStop links it", async () => {
    const r = await rig();
    setTracking(r.home, "copilot", VS.main, true, r.folder);
    const exits = await r.run(records(VSCODE_RUN, r.folder, 36), (rec) => (rec.event === "userPromptSubmitted" && rec.stdin.sessionId !== VS.main ? { ...rec, stdin: { ...rec.stdin, prompt: "something else" } } : rec));
    neverBlocks(exits);
    assert.deepEqual(r.owners(), { "a.txt": ["main"], "sub1.txt": [VS.writer], "sub2.txt": [VS.builtin] });
    const inner = r.ops().filter((o) => o.agent_id !== undefined && o.tool_name !== undefined);
    assert.deepEqual(inner.map((o) => [o.tool_name, o.agent_id, o.session_id]), [["apply_patch", VS.writer, VS.main], ["bash", VS.builtin, VS.main]], "held calls were recorded once each, in order");
    assert.equal(readdirSync(path.join(r.home, "copilot-held")).length, 0, "nothing stays held");
  });

  it("untracked parent: the helper's calls are not recorded and nothing is held or kept (guarded case)", async () => {
    const r = await rig();
    neverBlocks(await r.run(records(VSCODE_RUN, r.folder, 36)));
    assert.deepEqual(readdirSync(r.home), [], "an untracked session leaves nothing in the data home");
  });

  it("a held call whose parent never links it is deleted after the bound and never recorded", async () => {
    const r = await rig();
    setTracking(r.home, "copilot", VS.main, true, r.folder);
    const recs = records(VSCODE_RUN, r.folder, 36);
    // up to the helper's first write, then the parent stops tracking: the launch is dropped at the next event, the held call goes with it
    await r.run(recs.slice(0, 15), (rec) => (rec.event === "userPromptSubmitted" && rec.stdin.sessionId !== VS.main ? { ...rec, stdin: { ...rec.stdin, prompt: "something else" } } : rec));
    assert.equal(readdirSync(path.join(r.home, "copilot-held")).length, 1, "the helper's Pre is held");
    setTracking(r.home, "copilot", VS.main, false);
    await r.run(recs.slice(15));
    assert.deepEqual(r.ops().filter((o) => o.agent_id !== undefined && o.tool_name === "apply_patch"), []);
    assert.equal(readdirSync(path.join(r.home, "copilot-held")).length, 0);
  });
});



describe("hooks that Copilot also runs from a repo .claude/settings.json record nothing (no call twice)", () => {
  const GH = path.join(PLATFORMS, "copilot-cli", "versions", "1.0.98", "hook-calls-gh.jsonl");
  const CL = path.join(PLATFORMS, "copilot-cli", "versions", "1.0.98", "hook-calls-cl.jsonl");
  /** Only the events CoCheck installs for each host (a Claude install has no PermissionRequest entry, nor SessionStart/End). */
  const COPILOT_EVENTS = new Set(["userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "subagentStop"]);
  const CLAUDE_EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop"]);

  it("the same Copilot session through both registrations is recorded once, as Copilot", async () => {
    const r = await rig();
    const gh = records(GH, r.folder, 99).filter((x) => COPILOT_EVENTS.has(x.event));
    const cl = records(CL, r.folder, 99).filter((x) => CLAUDE_EVENTS.has(x.event));
    const session = gh[0]!.stdin.sessionId;
    // what `cocheck track start` does in each registration: both switches are on, so only the guard stands between the two hooks and a double record
    setTracking(r.home, "copilot", session, true, r.folder);
    setTracking(r.home, "claude", session, true, r.folder);
    const exits: Array<{ event: string; exit: HookExit }> = [];
    for (let i = 0; i < Math.max(gh.length, cl.length); i++) {
      for (const [rec, host] of [[gh[i], "copilot"], [cl[i], "claude"]] as const) {
        if (rec === undefined) continue;
        await r.apply(rec);
        exits.push({ event: `${host}:${rec.event}`, exit: await r.fire(rec, host) });
      }
    }
    neverBlocks(exits);
    const ops = r.ops();
    assert.ok(ops.length > 0);
    assert.deepEqual([...new Set(ops.map((o) => o.host))], ["copilot"], "nothing is recorded under another host");
    const calls = ops.filter((o) => typeof o.tool_use_id === "string");
    assert.equal(new Set(calls.map((o) => o.tool_use_id)).size, calls.length, "no call twice");
    assert.equal(calls.filter((o) => o.tool_name === "bash").length, 2, "the two shell calls of the run, once each");
  });

  it("a claude-host run that Copilot started is told apart from Claude Code's own payloads by shape, never by absence of fields alone", async () => {
    const { copilotRunsOtherHostsHook } = await import("../src/hosts/copilot.ts");
    const claudeCode = { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "/x.jsonl", cwd: "/w", permission_mode: "default", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "ls" } };
    assert.equal(copilotRunsOtherHostsHook(claudeCode), false);
    assert.equal(copilotRunsOtherHostsHook({ hook_event_name: "Stop", session_id: "s", transcript_path: "/x.jsonl", stop_hook_active: false }), false, "a Claude Code Stop has no timestamp");
    assert.equal(copilotRunsOtherHostsHook({ hook_event_name: "PreToolUse", session_id: "s", timestamp: "2026-10-24T22:02:21.589Z", cwd: "/w", tool_name: "Bash", tool_input: {} }), true);
  });
});

describe("install at user scope for Copilot CLI and VS Code", () => {
  /** Every entry under `dir` with its bytes (a folder as "dir"), to compare before and after. */
  function snapshot(dir: string, base = dir): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(base, full);
      if (lstatSync(full).isDirectory()) Object.assign(out, { [rel]: "dir" }, snapshot(full, base));
      else out[rel] = readFileSync(full).toString("hex");
    }
    return out;
  }
  async function setup() {
    const root = await tmp("inst");
    const userHome = path.join(root, "home");
    const copilotHome = path.join(userHome, ".copilot");
    const dataHome = path.join(root, "data");
    const folder = path.join(root, "work");
    await mkdir(userHome, { recursive: true });
    await mkdir(folder, { recursive: true });
    const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex"), COPILOT_HOME: copilotHome });
    const run = (argv: string[]): Promise<InstallResult> =>
      runInstall({ argv: ["node", "install.ts", ...argv], env: env(), cwd: root, hookPath: path.resolve(import.meta.dirname, "..", "src", "hook.ts"), stopReview: async () => "no review process was running" });
    return { root, userHome, copilotHome, dataHome, folder, env, run };
  }

  it("installs the helper's stop event, never writes a repo .claude/settings.json, and never blocks (no exit 2 in any entry)", async () => {
    const t = await setup();
    const r = await t.run(["--home", t.dataHome, "--folder", t.folder, "--for", "copilot,claude"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const file = JSON.parse(readFileSync(path.join(t.copilotHome, "hooks", "cocheck.json"), "utf8"));
    assert.ok(file.hooks.subagentStop?.[0]?.bash.includes("--host copilot --event subagentStop"));
    assert.deepEqual(Object.keys(file.hooks).filter((e) => e.startsWith("subagent")), ["subagentStop"], "subagentStart carries nothing the helper's first call does not: not installed");
    for (const list of Object.values<any[]>(file.hooks)) for (const entry of list) assert.ok(!/exit 2|permissionDecision|"deny"/.test(JSON.stringify(entry)), "no entry exits 2 or denies");
    assert.equal(existsSync(path.join(t.folder, ".claude")), false, "no repo-scope Claude settings in the task folder");
    assert.equal(existsSync(path.join(t.root, ".claude")), false, "nor in the folder the installer ran from");
  });

  it("the cocheck skill (the 'save in the folder' words) lands in ~/.copilot/skills, and says where to put the files", async () => {
    const t = await setup();
    await t.run(["--home", t.dataHome, "--folder", t.folder, "--for", "copilot"]);
    const skill = readFileSync(path.join(t.copilotHome, "skills", "cocheck", "SKILL.md"), "utf8");
    assert.match(skill, /Put the files for this work inside that folder/);
  });

  it("names the sandbox grant in the install output and in status, and leaves the person's Copilot settings alone", async () => {
    const t = await setup();
    await mkdir(t.copilotHome, { recursive: true });
    const settings = JSON.stringify({ sandbox: { userPolicy: { filesystem: { readwritePaths: ["/somewhere"] } } } }, null, 2) + "\n";
    await writeFile(path.join(t.copilotHome, "settings.json"), settings);
    const r = await t.run(["--home", t.dataHome, "--folder", t.folder, "--for", "copilot"]);
    assert.match(r.stdout, /sandbox\.userPolicy\.filesystem\.readwritePaths/);
    assert.ok(r.stdout.includes(t.dataHome), "the data folder is named");
    const status = installStatus(t.env(), t.userHome).text;
    assert.match(status, /sandbox\.userPolicy\.filesystem\.readwritePaths/);
    assert.ok(status.includes(t.dataHome));
    assert.equal(readFileSync(path.join(t.copilotHome, "settings.json"), "utf8"), settings, "settings.json is byte-identical after the install");
  });

  it("uninstall leaves a ~/.copilot with the person's own hooks file, settings and skills exactly as it found it (guarded case)", async () => {
    const t = await setup();
    await mkdir(path.join(t.copilotHome, "hooks"), { recursive: true });
    await mkdir(path.join(t.copilotHome, "skills", "mine"), { recursive: true });
    await writeFile(path.join(t.copilotHome, "hooks", "mine.json"), '{"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"echo hi"}]}}\n');
    await writeFile(path.join(t.copilotHome, "settings.json"), '{"trustedFolders":["/a"],"sandbox":{"enabled":false}}\n');
    await writeFile(path.join(t.copilotHome, "skills", "mine", "SKILL.md"), "# mine\n");
    const before = snapshot(t.copilotHome);
    assert.equal((await t.run(["--home", t.dataHome, "--folder", t.folder, "--for", "copilot"])).exitCode, 0);
    assert.notDeepEqual(snapshot(t.copilotHome), before, "the install did write something");
    const gone = await t.run(["--home", t.dataHome, "--uninstall", "--for", "copilot"]);
    assert.equal(gone.exitCode, 0, gone.stderr);
    const after = snapshot(t.copilotHome);
    assert.deepEqual(Object.keys(after).filter((k) => !(k in before)), [], "nothing of CoCheck's is left behind, backups included");
    for (const [key, value] of Object.entries(before)) assert.equal(after[key], value, `${key} changed`);
  });

  it("uninstall from a ~/.copilot that did not exist leaves no file and no CoCheck folder in it", async () => {
    const t = await setup();
    await t.run(["--home", t.dataHome, "--folder", t.folder, "--for", "copilot"]);
    await t.run(["--home", t.dataHome, "--uninstall", "--for", "copilot"]);
    const left = existsSync(t.copilotHome) ? Object.keys(snapshot(t.copilotHome)) : [];
    assert.deepEqual(left, []);
  });
});

describe("the double-fire guard decides on payload shape alone", () => {
  const V = (host: string, ...p: string[]) => path.join(PLATFORMS, host, "versions", ...p);
  /** Every real payload of a host's probe: [event name, payload]. The probe files store stdin as text (Claude, Codex 0.162) or as an object (Codex 0.164). */
  function payloads(file: string): Array<{ event: string; payload: Record<string, any> }> {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
      const d = JSON.parse(l);
      const payload = typeof d.stdin === "string" ? JSON.parse(d.stdin) : d.stdin;
      return { event: String(payload.hook_event_name ?? d.event ?? d.probe_event), payload };
    });
  }
  const SOURCES: Array<[string, string, string]> = [
    ["claude", V("claude-code", "2.1.302", "payloads.jsonl"), "claude"],
    ["codex", V("codex", "0.162.0-alpha.2", "payloads.jsonl"), "codex"],
    ["codex", V("codex", "0.164.0-alpha.11.1", "hook-calls-run2.jsonl"), "codex"],
  ];

  it("real Claude Code and Codex payloads record the same with a clean env, COPILOT_CLI=1 and COPILOT_PROJECT_DIR set", async () => {
    for (const [host, file] of SOURCES) {
      const results: string[] = [];
      for (const env of [{}, { COPILOT_CLI: "1" }, { COPILOT_PROJECT_DIR: "/somewhere/proj" }]) {
        const r = await rig();
        const events = payloads(file);
        for (const sid of new Set(events.map((e) => e.payload.session_id).filter((x) => typeof x === "string"))) setTracking(r.home, host, sid as string, true, r.folder);
        for (const { event, payload } of events) {
          const text = JSON.stringify(payload);
          const swapped = typeof payload.cwd === "string" ? text.split(JSON.stringify(payload.cwd).slice(1, -1)).join(r.folder) : text;
          const exit = await runHook({ argv: ["node", "hook.ts", "--host", host, ...(host === "claude" ? ["--folder", r.folder] : [])], env: { COCHECK_HOME: r.home, ...env }, stdin: (async function* () { yield Buffer.from(swapped); })() });
          assert.ok(exit.exitCode === 0 || exit.exitCode === 1, `${host} ${event}`);
        }
        const ops = r.ops().map((o) => [o.hookOpKey?.replace(/#\d+$/, ""), o.tool_name, o.closedBy, o.hookEvent].join("|"));
        results.push(JSON.stringify(ops));
        assert.ok(ops.length > 0, `${host} ${file}: the run records something under this env`);
      }
      assert.equal(results[1], results[0], `${host} ${path.basename(file)}: COPILOT_CLI=1 changes what is recorded`);
      assert.equal(results[2], results[0], `${host} ${path.basename(file)}: COPILOT_PROJECT_DIR changes what is recorded`);
    }
  });
});

describe("uninstall removes only folders the install created", () => {
  async function snap(dir: string, base = dir): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (lstatSync(full).isDirectory()) Object.assign(out, { [path.relative(base, full)]: "dir" }, await snap(full, base));
      else out[path.relative(base, full)] = readFileSync(full).toString("hex");
    }
    return out;
  }
  it("pre-existing EMPTY ~/.copilot/hooks, ~/.copilot/skills, ~/.claude/skills and ~/.agents/skills survive install then uninstall", async () => {
    const root = await tmp("empty");
    const userHome = path.join(root, "home");
    const dataHome = path.join(root, "data");
    const folder = path.join(root, "work");
    for (const d of [".copilot/hooks", ".copilot/skills", ".claude/skills", ".agents/skills"]) await mkdir(path.join(userHome, d), { recursive: true });
    await mkdir(folder);
    const env = { PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex"), COPILOT_HOME: path.join(userHome, ".copilot") };
    const go = (argv: string[]) => runInstall({ argv: ["node", "install.ts", ...argv], env, cwd: root, hookPath: path.resolve(import.meta.dirname, "..", "src", "hook.ts"), stopReview: async () => "no review process was running" });
    const tree = async () => ({ c: await snap(path.join(userHome, ".copilot")), l: await snap(path.join(userHome, ".claude")), a: await snap(path.join(userHome, ".agents")) });
    const before = await tree();
    assert.equal((await go(["--home", dataHome, "--folder", folder, "--for", "copilot"])).exitCode, 0);
    assert.notDeepEqual(await tree(), before);
    assert.equal((await go(["--home", dataHome, "--uninstall", "--for", "copilot"])).exitCode, 0);
    assert.deepEqual(await tree(), before);
  });
});

describe("held calls past their bound are never replayed and are deleted at the next hook run of any host", () => {
  const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
  const lateMs = 16 * 60_000;
  const noMatch = (rec: Rec): Rec => (rec.event === "userPromptSubmitted" && rec.stdin.sessionId !== VS.main ? { ...rec, stdin: { ...rec.stdin, prompt: "something else" } } : rec);

  it("a subagentStop after the bound replays nothing and the held file is gone", async () => {
    const r = await rig();
    setTracking(r.home, "copilot", VS.main, true, r.folder);
    const recs = records(VSCODE_RUN, r.folder, 36);
    await r.run(recs.slice(0, 15), noMatch, T0);
    assert.equal(readdirSync(path.join(r.home, "copilot-held")).length, 1, "the helper's Pre is held");
    const stop = recs.findIndex((x) => x.event === "subagentStop");
    await r.run(recs.slice(15, stop), noMatch, T0);
    await r.run(recs.slice(stop, stop + 1), noMatch, T0 + lateMs);
    assert.deepEqual(r.ops().filter((o) => o.agent_id !== undefined && o.tool_name !== undefined), [], "no held call is replayed");
    assert.deepEqual(readdirSync(path.join(r.home, "copilot-held")), []);
  });

  it("any host's hook run deletes a held file past its bound", async () => {
    const r = await rig();
    setTracking(r.home, "copilot", VS.main, true, r.folder);
    await r.run(records(VSCODE_RUN, r.folder, 15), noMatch, T0);
    assert.equal(readdirSync(path.join(r.home, "copilot-held")).length, 1);
    await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder], env: { COCHECK_HOME: r.home }, journalNow: () => T0 + lateMs, stdin: (async function* () { yield Buffer.from(JSON.stringify({ session_id: "unrelated", hook_event_name: "Stop", cwd: r.folder })); })() });
    assert.deepEqual(readdirSync(path.join(r.home, "copilot-held")), []);
  });
});

// Two helpers launched at once (Copilot CLI 1.0.103, a recorded run). The records are that run's hook inputs, trimmed (see the README
// beside the file): the main session launched the memo writer (call -1) and the deck builder (call -2) in one batch; each helper's first
// prompt is its `task` prompt word for word. The adapter's synthetic call ids are `copilot-<main>-<n>`, and the Pres are fired in file order.
describe("parallel Copilot helpers link to their own launch", () => {
  const D22 = path.join(PLATFORMS, "copilot-cli", "versions", "1.0.103", "concurrent-tasks.jsonl");
  const MAIN22 = "7da11a92-9e1e-42c6-9644-b650dd6ef7ae";
  const MEMO = "9d57f700-7a86-4620-a27d-aede74d1207b";
  const DECK = "de581cc6-5862-43c5-9937-929b78c16e9c";
  const LAUNCH_MEMO = `copilot-${MAIN22}-1`;
  const LAUNCH_DECK = `copilot-${MAIN22}-2`;
  // the record index right after whose Pre each file appears on disk (the trimmed records hold no file contents)
  const WRITES: Record<number, string> = { 38: "us_economy_stability_memo.docx", 45: "make_deck.py", 48: "us_economy_stability_brief.pptx" };

  async function setup() {
    const r = await rig();
    setTracking(r.home, "copilot", MAIN22, true, r.folder);
    return r;
  }
  const load = (folder: string): Rec[] => records(D22, folder, 999);
  /** Fires records in order; `after` names a file to write once the record at that index has fired. */
  async function play(r: Awaited<ReturnType<typeof rig>>, recs: Rec[], writes: Record<number, string> = WRITES, index = (i: number) => i) {
    const exits: Array<{ event: string; exit: HookExit }> = [];
    for (const [i, rec] of recs.entries()) {
      exits.push({ event: rec.event, exit: await r.fire(rec, "copilot", typeof rec.stdin.timestamp === "number" ? rec.stdin.timestamp : undefined) });
      const w = writes[index(i)];
      if (w !== undefined) await writeFile(path.join(r.folder, w), `stand-in ${w} ${i}\n`);
    }
    return exits;
  }
  const helperCalls = (r: Awaited<ReturnType<typeof rig>>) => r.ops().filter((o) => o.agent_id !== undefined && typeof o.tool_name === "string");

  it("the full replay: every helper call names its own launch, and the memo docx is credited to the memo writer's call alone", async () => {
    const r = await setup();
    neverBlocks(await play(r, load(r.folder)));
    const calls = helperCalls(r);
    assert.ok(calls.length >= 20);
    for (const c of calls) assert.equal(c.launch_tool_use_id, c.agent_id === MEMO ? LAUNCH_MEMO : LAUNCH_DECK, `${c.tool_name} of ${c.agent_id} names the other helper's launch`);
    const owners = r.owners();
    assert.deepEqual(owners["us_economy_stability_memo.docx"], [MEMO]);
    assert.ok(!Object.values(owners).flat().some((o) => o === "tool:task" || o.endsWith(LAUNCH_MEMO) || o.endsWith(LAUNCH_DECK)), "no launch call is credited");
  });

  it("with helper A's call open, neither launch is credited with a change found at another helper's Post", async () => {
    const r = await setup();
    const recs = load(r.folder);
    // up to the balanced pairs ending at 35; then the memo writer's long call opens (38) and writes the docx; the deck builder's call 36/37 closes meanwhile
    const order = [...recs.slice(0, 36), recs[38]!, recs[36]!, recs[37]!];
    await play(r, order, WRITES, (i) => (i === 36 ? 38 : -1));
    const owners = r.owners();
    assert.ok(owners["us_economy_stability_memo.docx"] !== undefined, "the docx was recorded");
    // a launch's own Post has not come, so its id is not in the ops: it shows as "unknown:<id>"
    assert.ok(![LAUNCH_MEMO, LAUNCH_DECK].some((id) => owners["us_economy_stability_memo.docx"]!.some((o) => o.endsWith(id))), `a launch was credited: ${JSON.stringify(owners)}`);
  });

  it("identical prompts on the two launches form no link, and the memo docx is not credited to the deck builder alone (guarded case)", async () => {
    const r = await setup();
    const recs = load(r.folder);
    const memoPrompt = recs[2]!.stdin.prompt;
    const same = recs.map((x) => (x.stdin.agentId === DECK && x.event === "userPromptSubmitted") || (x.event === "preToolUse" && x.stdin.toolName === "task" && x.stdin.toolArgs.description !== recs[0]!.stdin.toolArgs.description) ? { ...x, stdin: x.event === "userPromptSubmitted" ? { ...x.stdin, prompt: memoPrompt } : { ...x.stdin, toolArgs: { ...x.stdin.toolArgs, prompt: memoPrompt } } } : x);
    neverBlocks(await play(r, same));
    // the memo writer's calls all ran while both launches were open; the deck builder's later calls may name the one launch still open, which is not a prompt link
    const memoCalls = helperCalls(r).filter((c) => c.agent_id === MEMO);
    assert.ok(memoCalls.length > 5);
    for (const c of memoCalls) assert.equal(c.launch_tool_use_id, undefined, `${c.tool_name} of ${c.agent_id} was linked to ${c.launch_tool_use_id}`);
    assert.notDeepEqual(r.owners()["us_economy_stability_memo.docx"], [DECK], "sole credit to the wrong helper");
  });

  it("a call that failed but wrote its file keeps its credit (failure is no credit signal)", async () => {
    const r = await setup();
    const recs = load(r.folder);
    const failed = recs.map((x, i) => (i === 39 ? { event: "postToolUseFailure", stdin: { sessionId: x.stdin.sessionId, timestamp: x.stdin.timestamp, cwd: x.stdin.cwd, toolName: x.stdin.toolName, toolArgs: x.stdin.toolArgs, error: "exit code 1", agentId: x.stdin.agentId, agentType: x.stdin.agentType, parentAgentId: x.stdin.parentAgentId } } : x));
    neverBlocks(await play(r, failed));
    assert.equal(helperCalls(r).filter((c) => c.closedBy === "failure" && /^exit code 1$/.test(String(c.error))).length, 1, "the writing call closed as a failure");
    assert.deepEqual(r.owners()["us_economy_stability_memo.docx"], [MEMO]);
  });
});
