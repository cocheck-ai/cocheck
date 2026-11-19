import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { runInstall } from "../src/install.ts";
import { book } from "./hook-corpus.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Line shapes are the probe's real records (platforms/codex/versions/0.164.0-alpha.11.1).
const evidence = path.resolve(import.meta.dirname, "..", "platforms", "codex", "versions", "0.164.0-alpha.11.1");
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
async function scratch() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-t150r4-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const folder = path.join(root, "work");
  const sessions = path.join(root, "sessions");
  await mkdir(home);
  await mkdir(folder);
  await mkdir(sessions);
  return { root, home, folder, sessions };
}
const timeline = (home: string, folder: string) => {
  const ledger = openLedger(home);
  try {
    return buildTimeline({ ...loadRows(ledger, 1, "test"), build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false });
  } finally {
    ledger.close();
  }
};

describe("(a): outcomes Codex cannot confirm are never shown as succeeded", () => {
  it("an inferred failure reads failed with its sentence, every other call reads not reported, the run says Codex does not report failures", async () => {
    const s = await scratch();
    let clock = 1_000_000;
    const hook = (o: Record<string, unknown>) =>
      handleHook({ session_id: "01a16ff1-ac5d-78f1-a588-6ff46ea9e279", cwd: s.folder, model: "gpt-6.1-sol", permission_mode: "bypassPermissions", ...o } as unknown as HookPayload, { host: "codex", home: s.home, claimed: workbookClaims, folder: s.folder, perSession: false, now: () => (clock += 1000), codexSessions: s.sessions });
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Look around" });
    // the real failing ls and the real empty-output success shapes from hook-calls-run2.jsonl
    const ls = { tool_name: "Bash", tool_input: { command: "ls /nonexistent_dir" } };
    await hook({ hook_event_name: "PreToolUse", tool_use_id: "exec-9f48", ...ls });
    await hook({ hook_event_name: "PostToolUse", tool_use_id: "exec-9f48", ...ls, tool_response: "ls: /nonexistent_dir: No such file or directory\n" });
    const put = { tool_name: "Bash", tool_input: { command: "printf alpha > a.txt" } };
    await hook({ hook_event_name: "PreToolUse", tool_use_id: "exec-de55", ...put });
    await hook({ hook_event_name: "PostToolUse", tool_use_id: "exec-de55", ...put, tool_response: "" });
    const run = timeline(s.home, s.folder).requests.flatMap((r: any) => r.runs).flatMap((r: any) => [r]);
    const calls = run.flatMap((r: any) => r.calls);
    assert.deepEqual(calls.map((c: any) => c.outcome), ["failed", "unknown"]);
    assert.ok(calls[0].missing.includes("failure inferred from output text"), JSON.stringify(calls[0].missing));
    assert.ok(calls[1].missing.some((m: string) => /Outcome not reported/.test(m)), JSON.stringify(calls[1].missing));
    assert.ok(run.every((r: any) => r.missing.some((m: string) => /does not report failed calls/.test(m))), "the run says the host does not report failed calls");
    assert.ok(run.every((r: any) => r.failedCount === null), "no failed count is given");
    assert.doesNotMatch(JSON.stringify(timeline(s.home, s.folder).requests), /"outcome":"succeeded"/);
  });
});

describe("(b): two overlapping Codex helpers get no joint credit", () => {
  const SESSION = "01a16ff1-ac5d-78f1-a588-6ff46ea9e279";
  const HELPER_A = "01a16ff1-c26a-7f03-80e7-465fcf0b0f19";
  const HELPER_B = "01a16ff1-d26a-7f03-80e7-465fcf0b0f20";
  /** A helper's rollout made from the real trimmed one: its ids, and its one CommandExecution item rewritten to `cmd` / `output`. */
  function rollout(root: string, helper: string, callId: string, cmd: string, output: string): string {
    const day = path.join(root, "2026", "10", "24");
    mkdirSync(day, { recursive: true });
    const file = path.join(day, `rollout-2026-10-24T18-04-37-${helper}.jsonl`);
    const real = readFileSync(path.join(evidence, "rollouts", "helper-18-04-37.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    const lines = real.map((l) => {
      if (l.includes('"CommandExecution"')) {
        const d = JSON.parse(l);
        d.payload.item.id = callId;
        d.payload.item.command = ["/bin/zsh", "-lc", cmd];
        d.payload.item.parsed_cmd = [{ type: "unknown", cmd }];
        d.payload.item.aggregated_output = output;
        return JSON.stringify(d);
      }
      return l.split("01a16ff1-c26a-7f03-80e7-465fcf0b0f19").join(helper);
    });
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }
  async function replay(namesInRollout: boolean) {
    const s = await scratch();
    // a clock inside the rollout's day folder (local time)
    let clock = new Date(2026, 9, 24, 12, 0, 0).getTime();
    await writeFile(path.join(s.folder, "a.xlsx"), book({ A1: 0 }));
    await writeFile(path.join(s.folder, "b.xlsx"), book({ A1: 0 }));
    const hook = (o: Record<string, unknown>) =>
      handleHook({ session_id: SESSION, cwd: s.folder, model: "gpt-6.1-sol", permission_mode: "bypassPermissions", ...o } as unknown as HookPayload, { host: "codex", home: s.home, claimed: workbookClaims, folder: s.folder, perSession: false, now: () => (clock += 1000), codexSessions: s.sessions });
    const helperCall = (agent: string) => ({ agent_id: agent, agent_type: "default", tool_name: "Bash" });
    // each helper runs a script that names no workbook; only its rollout (command output) says which one it wrote
    const cmdA = "python3 build_one.py";
    const cmdB = "python3 build_two.py";
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Build the two workbooks" });
    await hook({ hook_event_name: "SubagentStart", agent_id: HELPER_A, agent_type: "default" });
    await hook({ hook_event_name: "SubagentStart", agent_id: HELPER_B, agent_type: "default" });
    await hook({ hook_event_name: "PreToolUse", tool_use_id: "exec-A", tool_input: { command: cmdA }, ...helperCall(HELPER_A) });
    await hook({ hook_event_name: "PreToolUse", tool_use_id: "exec-B", tool_input: { command: cmdB }, ...helperCall(HELPER_B) });
    await writeFile(path.join(s.folder, "a.xlsx"), book({ A1: 1 }));
    rollout(s.sessions, HELPER_A, "exec-A", cmdA, namesInRollout ? "saved a.xlsx\n" : "done\n");
    await hook({ hook_event_name: "PostToolUse", tool_use_id: "exec-A", tool_input: { command: cmdA }, tool_response: "", ...helperCall(HELPER_A) });
    await writeFile(path.join(s.folder, "b.xlsx"), book({ A1: 2 }));
    rollout(s.sessions, HELPER_B, "exec-B", cmdB, namesInRollout ? "saved b.xlsx\n" : "done\n");
    await hook({ hook_event_name: "PostToolUse", tool_use_id: "exec-B", tool_input: { command: cmdB }, tool_response: "", ...helperCall(HELPER_B) });
    await hook({ hook_event_name: "SubagentStop", agent_id: HELPER_A, agent_type: "default", last_assistant_message: "Built a." });
    await hook({ hook_event_name: "SubagentStop", agent_id: HELPER_B, agent_type: "default", last_assistant_message: "Built b." });
    const tl = timeline(s.home, s.folder);
    const calls = tl.requests.flatMap((r: any) => r.runs).flatMap((r: any) => r.calls);
    const credited = (id: string) => calls.find((c: any) => c.id === id)!.changes.map((ch: any) => path.basename(ch.file ?? ch.path ?? ""));
    return { calls, credited, tl };
  }
  it("each helper is credited with only the workbook its own rollout names", async () => {
    const r = await replay(true);
    assert.deepEqual(r.credited("exec-A"), ["a.xlsx"], JSON.stringify(r.calls.map((c: any) => [c.id, c.changes])));
    assert.deepEqual(r.credited("exec-B"), ["b.xlsx"]);
  });
  it("bound: when no rollout or command names the file, credit is joint as before (a.xlsx goes to both open calls)", async () => {
    const r = await replay(false);
    assert.deepEqual(r.credited("exec-A"), ["a.xlsx"]);
    assert.deepEqual(r.credited("exec-B"), ["a.xlsx", "b.xlsx"], "B is open at A's Post and nothing says it did not write a.xlsx");
  });
});

describe("(c): uninstall leaves an absent config absent and restores an existing one byte for byte", () => {
  async function rig() {
    const s = await scratch();
    const userHome = path.join(s.root, "u");
    await mkdir(path.join(userHome, ".codex"), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex") };
    const run = (argv: string[]) => runInstall({ argv: ["node", "install.ts", ...argv], env, cwd: s.root, hookPath, stopReview: async () => "none" });
    return { s, config: path.join(userHome, ".codex", "config.toml"), run, data: path.join(s.root, "data") };
  }
  for (const [name, original] of [["absent", undefined], ["empty file", Buffer.alloc(0)], ["user content", Buffer.from('model = "x"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "mine"\n')]] as const) {
    it(`${name}`, async () => {
      const r = await rig();
      if (original !== undefined) await writeFile(r.config, original);
      assert.equal((await r.run(["--home", r.data, "--folder", r.s.folder, "--for", "codex"])).exitCode, 0);
      assert.ok(existsSync(r.config));
      assert.equal((await r.run(["--uninstall", "--for", "codex"])).exitCode, 0);
      if (original === undefined) assert.equal(existsSync(r.config), false, "an absent config stays absent");
      else assert.deepEqual(await readFile(r.config), original);
    });
  }
});
