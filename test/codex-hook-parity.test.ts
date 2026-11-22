import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { normalize } from "../src/normalize.ts";
import { profileOf } from "../src/hosts/index.ts";
const codex = profileOf("codex");
import { codexTrustProblem } from "../src/hosts/codex-trust.ts";
import { installRecordPath, installStatus, runInstall } from "../src/install.ts";

// Codex at parity where its hooks allow. Line shapes are the real records of the probe (0.164.0-alpha.11.1).
const evidence = path.resolve(import.meta.dirname, "..", "platforms", "codex", "versions", "0.164.0-alpha.11.1");
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const calls = async (): Promise<Array<{ probe_event: string; stdin: any }>> =>
  (await readFile(path.join(evidence, "hook-calls-run2.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => {
    const d = JSON.parse(l);
    return { probe_event: d.probe_event, stdin: typeof d.stdin === "string" ? JSON.parse(d.stdin) : d.stdin };
  });
const find = async (event: string, pick: (s: any) => boolean = () => true) => (await calls()).find((c) => c.probe_event === event && pick(c.stdin))!.stdin;

let sandbox: string;
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const userHome = path.join(sandbox, "home");
  await mkdir(path.join(userHome, ".codex"), { recursive: true });
  const folder = path.join(sandbox, "work");
  await mkdir(folder, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex") };
  const run = (argv: string[]) => runInstall({ argv: ["node", "install.ts", ...argv], env, cwd: sandbox, hookPath, stopReview: async () => "none" });
  return { userHome, folder, env, config: path.join(userHome, ".codex", "config.toml"), data: path.join(sandbox, "data"), run };
}

describe("events", () => {
  it("install writes SessionStart, SubagentStart and SubagentStop, and uninstall restores a user's config byte for byte", async () => {
    const f = await fresh();
    const original = Buffer.from('model = "gpt-6"\r\n[mcp_servers.x]\r\ncommand = "x"\r\n\r\n[[hooks.PreToolUse]]\r\n[[hooks.PreToolUse.hooks]]\r\ntype = "command"\r\ncommand = "/usr/local/bin/mine.sh"');
    await writeFile(f.config, original);
    const res = await f.run(["--home", f.data, "--folder", f.folder, "--for", "codex"]);
    assert.equal(res.exitCode, 0, res.stderr);
    const text = await readFile(f.config, "utf8");
    for (const e of ["SessionStart", "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit"]) assert.match(text, new RegExp(`\\[\\[hooks\\.${e}\\]\\] # cocheck`), e);
    assert.ok(text.includes("/usr/local/bin/mine.sh"), "the user's own hook stays");
    const un = await f.run(["--uninstall", "--for", "codex"]);
    assert.equal(un.exitCode, 0, un.stderr);
    assert.deepEqual(await readFile(f.config), original);
  });
});

describe("helpers and events from the real record", () => {
  it("a helper's calls carry its agent id, SubagentStop closes it with its last message, SessionStart and SubagentStart record nothing", async () => {
    const helperPost = normalize("codex", await find("PostToolUse", (s) => s.agent_id !== undefined && s.tool_name === "Bash"));
    assert.equal(helperPost.kind, "tool-post");
    assert.equal(helperPost.agentId, "01a16ff1-c26a-7f03-80e7-465fcf0b0f19");
    const stop = normalize("codex", await find("SubagentStop"));
    assert.equal(stop.kind, "subagent-stop");
    assert.equal(stop.agentId, helperPost.agentId);
    assert.equal(stop.lastAssistantMessage, "Created b.txt containing exactly beta.");
    assert.equal(normalize("codex", await find("SessionStart")).kind, "other");
    assert.equal(normalize("codex", await find("SubagentStart")).kind, "other");
    assert.ok(codex.install!.events.includes("SubagentStart"));
  });
});

describe("failure inferred from tool_response", () => {
  it("the real failing ls reads as failed", async () => {
    const ev = normalize("codex", await find("PostToolUse", (s) => String(s.tool_response).includes("No such file")));
    assert.equal(ev.failure?.raw, "ls: /nonexistent_t147: No such file or directory");
  });
  it("must not: empty output, ordinary output and mixed output never read as failed", async () => {
    const ok = await find("PostToolUse", (s) => s.tool_response === "" && s.tool_name === "Bash");
    assert.equal(normalize("codex", ok).failure, undefined);
    for (const out of ["a.txt\nb.txt\n", "ls: x: No such file or directory\nbut then it went on to print results\n", "note: the file said: Permission denied for guests, so I stopped"]) {
      assert.equal(normalize("codex", { ...ok, tool_response: out }).failure, undefined, out);
    }
  });
});

describe("trust", () => {
  const listing = async () => JSON.parse(await readFile(path.join(evidence, "app-server-hooks-list.json"), "utf8"));
  it("the real hooks/list shape: all trusted is silent, a modified or untrusted hook is reported", async () => {
    const l = await listing();
    assert.equal(codexTrustProblem(l, hookPath), undefined);
    const bad = { hooks: l.hooks.map((h: any, i: number) => (i === 1 ? { ...h, trustStatus: "modified" } : i === 2 ? { ...h, trustStatus: "untrusted" } : h)) };
    const msg = codexTrustProblem(bad, hookPath)!;
    assert.match(msg, /postToolUse, userPromptSubmit/);
    assert.match(msg, /modified, untrusted/);
    assert.equal(codexTrustProblem({ hooks: [] }, hookPath), undefined);
  });
  it("a user's own untrusted hook is not blamed on CoCheck when the listing names commands", () => {
    const list = { hooks: [{ eventName: "stop", trustStatus: "untrusted", enabled: true, command: "/usr/local/bin/mine.sh" }] };
    assert.equal(codexTrustProblem(list, hookPath), undefined);
  });
  it("cocheck status reads trust through the (stubbed) app-server call and says not recording", async () => {
    const f = await fresh();
    const res = await f.run(["--home", f.data, "--folder", f.folder, "--for", "codex"]);
    assert.equal(res.exitCode, 0, res.stderr);
    const l = await listing();
    const asked: string[] = [];
    const trusted = installStatus(f.env, f.userHome, (home) => (asked.push(home), l));
    assert.deepEqual(asked, [path.join(f.userHome, ".codex")]);
    assert.equal(trusted.recording, true, trusted.text);
    const modified = installStatus(f.env, f.userHome, () => ({ hooks: l.hooks.map((h: any) => ({ ...h, trustStatus: "modified" })) }));
    assert.equal(modified.recording, false);
    assert.match(modified.text, /does not trust CoCheck's hooks/);
    assert.match(modified.text, /Codex: installed, hooks not trusted/);
    const unreadable = installStatus(f.env, f.userHome, () => undefined);
    assert.equal(unreadable.recording, true, "an app-server that cannot be asked is not a reason");
    assert.ok(installRecordPath(f.userHome));
  });
});

describe("must not: no hook blocks or alters a Codex call", () => {
  it("every real probe payload exits 0 with no stdout decision, and the tracked-or-not run writes nothing to the Codex folder", async () => {
    const f = await fresh();
    let ran = 0;
    for (const c of await calls()) {
      const s = { ...c.stdin, cwd: f.folder, transcript_path: undefined };
      const res = await runHook({ argv: ["node", "hook.ts", "--host", "codex", "--folder", f.folder], env: { COCHECK_HOME: f.data }, stdin: (async function* () { yield Buffer.from(JSON.stringify(s)); })() });
      assert.equal(res.exitCode, 0, `${c.probe_event}: ${res.stderr}`);
      if (res.stdout !== "") assert.equal(c.probe_event, "UserPromptSubmit", "only a recorded prompt may print, and it prints context text");
      assert.doesNotMatch(res.stdout, /"decision"|"block"|permissionDecision|updatedInput/);
      ran++;
    }
    assert.ok(ran >= 28);
    await assert.rejects(readFile(f.config), "the hook never touches the Codex config");
  });
});
