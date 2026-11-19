import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evidenceDir, markSessionTagged, prepareSession, tagCommand } from "../src/attribution/tag.ts";
import { writeEvidenceFromOps } from "../src/attribution/evidence.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { readRows } from "../src/timeline/load.ts";
import { setTracking } from "../src/tracking.ts";
import { buildTimeline, type Change, type TimelineInput } from "../src/timeline/timeline.ts";
import { workbookClaims } from "./helpers/claims.ts";

// A child that outlives its call. Helper 2 ran `venv/bin/python x.py | grep AVGO.*net_inc`; zsh aborted the line
// ("no matches found") the moment it forked python, so the call closed and its shell was gone before python's hook looked for the tag in
// its ancestors. No record was logged, and the write 0.65 s after the call's Post was credited to nobody ("?").
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
const SHELLS = ["/bin/bash", "/bin/zsh"].filter((s) => existsSync(s));
const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;
const hasNode = spawnSync("node", ["-e", "0"]).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const records = (logDir: string) =>
  existsSync(logDir)
    ? readdirSync(logDir).filter((n) => n.endsWith(".jsonl")).flatMap((n) => readFileSync(path.join(logDir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    : [];

/** The call as Claude Code runs it, returning when the shell has exited (a child may still run). */
function runLikeClaude(shell: string, command: string, cwd: string, home: string, opts: { tracked?: boolean; tag?: boolean } = {}) {
  const lines = prepareSession(home, "sess1", [path.dirname(cwd)], Date.now());
  if (opts.tracked !== false) setTracking(home, "claude", "sess1", true);
  markSessionTagged(home, "sess1");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: cwd, LANG: "C" };
  const run = opts.tag === false ? command : tagCommand(command, "toolu_late", "helperX", shell)!;
  const pre = lines.split("\n").filter(Boolean).join("; ");
  return spawnSync(shell, ["-c", `${pre}; eval ${sq(run)} < /dev/null && pwd -P >| /dev/null`], { cwd, env, encoding: "utf8", timeout: 20_000 });
}

async function waitFor(file: string, ms = 8_000) {
  for (let t = 0; t < ms; t += 100) {
    if (existsSync(file)) return true;
    await sleep(100);
  }
  return false;
}
async function waitRecords(logDir: string, want: (r: any) => boolean, ms = 8_000) {
  for (let t = 0; t < ms; t += 100) {
    const got = records(logDir).filter(want);
    if (got.length > 0) return got;
    await sleep(100);
  }
  return [];
}

describe("a child that outlives its call's shell still logs under the call's tag", () => {
  for (const shell of SHELLS) {
    // `sh -c 'sleep; exec <interpreter>'` in the background: the interpreter starts after the call's shell has exited, so no ancestor is left.
    const late = (prog: string) => `nohup sh -c ${sq(`sleep 1; exec ${prog}`)} > /dev/null 2>&1 &`;
    it(`${path.basename(shell)}: a Python child started after the shell exited records its write with the call's tag`, async (t) => {
      if (!hasPython) return t.skip("no python3");
      const w = await tmp("py");
      const cwd = path.join(w, "work");
      await mkdir(cwd);
      const r = runLikeClaude(shell, late(`python3 -c "open('late.txt','w').write('1')"`), cwd, path.join(w, "home"));
      assert.equal(r.status, 0, r.stderr);
      assert.ok(await waitFor(path.join(cwd, "late.txt")), "the child ran");
      const got = await waitRecords(evidenceDir(path.join(w, "home")), (x) => x.op === "write" && x.path.endsWith("late.txt"));
      assert.deepEqual(got.map((x) => [x.call, x.agent]), [["toolu_late", "helperX"]]);
    });
    it(`${path.basename(shell)}: a Node child started after the shell exited records its write with the call's tag`, async (t) => {
      if (!hasNode) return t.skip("no node");
      const w = await tmp("node");
      const cwd = path.join(w, "work");
      await mkdir(cwd);
      const r = runLikeClaude(shell, late(`node -e "require('fs').writeFileSync('late.txt','1')"`), cwd, path.join(w, "home"));
      assert.equal(r.status, 0, r.stderr);
      assert.ok(await waitFor(path.join(cwd, "late.txt")), "the child ran");
      const got = await waitRecords(evidenceDir(path.join(w, "home")), (x) => x.op === "write" && x.path.endsWith("late.txt"));
      assert.deepEqual(got.map((x) => [x.call, x.agent]), [["toolu_late", "helperX"]]);
    });
    // Must not happen: no tag on the call, no record; an untracked session loads no guard and sets no tag.
    it(`${path.basename(shell)}: an untagged call's late child logs nothing`, async (t) => {
      if (!hasPython) return t.skip("no python3");
      const w = await tmp("untagged");
      const cwd = path.join(w, "work");
      await mkdir(cwd);
      runLikeClaude(shell, late(`python3 -c "open('late.txt','w').write('1')"`), cwd, path.join(w, "home"), { tag: false });
      assert.ok(await waitFor(path.join(cwd, "late.txt")));
      await sleep(500);
      assert.deepEqual(records(evidenceDir(path.join(w, "home"))), []);
    });
    it(`${path.basename(shell)}: an untracked session sets no tag and loads no guard, so its late child logs nothing`, async (t) => {
      if (!hasPython) return t.skip("no python3");
      const w = await tmp("untracked");
      const cwd = path.join(w, "work");
      await mkdir(cwd);
      const r = runLikeClaude(shell, `${late(`python3 -c "open('late.txt','w').write('1')"`)}\nprintenv COCHECK_WRITE_CALL || echo absent`, cwd, path.join(w, "home"), { tracked: false });
      assert.equal(r.stdout.trim(), "absent");
      assert.ok(await waitFor(path.join(cwd, "late.txt")));
      await sleep(500);
      assert.deepEqual(records(evidenceDir(path.join(w, "home"))), []);
    });
    it(`${path.basename(shell)}: a tagged call sets the tag for its children only as "<call>:<agent>"`, () => {
      const r = runLikeClaude(shell, "printenv COCHECK_WRITE_CALL", tmpdir(), path.join(tmpdir(), `cocheck-env-${process.pid}`));
      cleanups.push(() => rm(path.join(tmpdir(), `cocheck-env-${process.pid}`), { recursive: true, force: true }));
      assert.equal(r.stdout.trim(), "toolu_late:helperX");
    });
  }
});

// ---- the adapter: a write that lands after the call's Post ----
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const who = (ch: Change) => [...ch.by.calls].sort().join("+");

async function rig() {
  const home = await tmp("ahome");
  const folder = await tmp("afolder");
  const a = path.join(folder, "a.xlsx");
  await copyFile(probe(0), a);
  let clock = Date.parse("2026-10-24T14:00:00Z");
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>, taggedCall = false) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, { ...opts, taggedCall });
  };
  const ag = { agent_id: "helper2", agent_type: "general-purpose" };
  const bash = (event: string, id: string, command: string, tagged = false) => send({ hook_event_name: event, tool_name: "Bash", tool_use_id: id, tool_input: { command }, ...ag }, tagged);
  const wrote = async (call: string, file: string, op = "write") => {
    await mkdir(evidenceDir(home), { recursive: true });
    await appendFile(path.join(evidenceDir(home), `writes-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ v: 1, call, agent: "helper2", pid: 1, ts: clock, op, path: file, via: "python" }) + "\n");
  };
  const credits = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null).map((s) => `${path.basename(s.filePath)}:${[...s.credited].sort().join("+")}`).slice(1);
    } finally {
      l.close();
    }
  };
  const timeline = () => {
    const l = openLedger(home);
    try {
      const { ops, fileStates } = readRows(l, 1);
      const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates, folder, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude", writeEvidence: writeEvidenceFromOps(ops) };
      const t = buildTimeline(input);
      const out: string[] = [];
      for (const r of t.requests) for (const run of r.runs) for (const c of run.calls) for (const ch of c.changes ?? []) out.push(`${ch.file ?? ""}:${who(ch)}`);
      for (const ch of t.unplaced) out.push(`unplaced:${who(ch)}`);
      return out;
    } finally {
      l.close();
    }
  };
  await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  // the task exists already (a first credited change opens it), as in a recorded run
  await bash("PreToolUse", "F", "python3 first.py", true);
  await wrote("F", "/usr/bin/python3", "start");
  await copyFile(probe(1), a);
  await wrote("F", a);
  await bash("PostToolUse", "F", "python3 first.py");
  const cmd = "venv/bin/python run.py | grep x*y";
  /** Helper 2's call closes (its shell aborted), then a helper launch is open at the sweep that finds the late write. */
  const closeCall = async (id: string, tagged = true) => {
    await bash("PreToolUse", id, cmd, tagged);
    await wrote(id, "/tmp/venv/bin/python", "start");
    await bash("PostToolUse", id, cmd);
  };
  const stop = () => send({ hook_event_name: "Stop", last_assistant_message: "done" });
  const json = path.join(folder, "extracted.json");
  return { json, tick: (ms: number) => { clock += ms; }, send, bash, wrote, credits, timeline, closeCall, stop, a, write: (n: number) => copyFile(probe(n), a), cmd };
}

describe("attribution credits a late write to the call its tag names", () => {
  it("a tagged call's child writes after the call's Post: the write is credited to that call, in the ledger and the timeline", async () => {
    const t = await rig();
    await t.closeCall("H2");
    await t.write(2);
    await t.wrote("H2", t.a);
    await t.stop();
    assert.deepEqual(t.credits(), ["a.xlsx:H2"]);
    assert.ok(t.timeline().every((x) => !x.startsWith("unplaced")), JSON.stringify(t.timeline()));
    assert.ok(t.timeline().some((x) => x.endsWith(":H2")), JSON.stringify(t.timeline()));
  });

  it("the record is read at a later event than the Post, between the log line and the write: the evidence is still there", async () => {
    const t = await rig();
    await t.closeCall("H2");
    await t.wrote("H2", t.a); // logged before the write lands
    await t.bash("PreToolUse", "R1", "ls"); // a sweep finds nothing yet
    await t.bash("PostToolUse", "R1", "ls");
    await t.write(2);
    await t.stop();
    assert.deepEqual(t.credits(), ["a.xlsx:H2"]);
  });

  // Must not happen: no record, no credit; never the last open call by guess
  it("a late write with no record is credited to nobody, and not to the call that was open", async () => {
    const t = await rig();
    await t.closeCall("H2");
    await t.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "LAUNCH", tool_input: { description: "d", prompt: "p", subagent_type: "general-purpose" } }); // open at the sweep, as in the recorded run; it never credits a launch
    await t.write(2);
    await t.stop();
    assert.deepEqual(t.credits(), ["a.xlsx:"]);
  });

  it("a record naming a call the adapter never saw credits nobody", async () => {
    const t = await rig();
    await t.closeCall("H2");
    await t.write(2);
    await t.wrote("ghost", t.a);
    await t.stop();
    assert.deepEqual(t.credits(), ["a.xlsx:"]);
  });

  it("a record from a long-closed call (older than the window) credits nobody", async () => {
    const t = await rig();
    await t.closeCall("H2");
    await t.wrote("H2", t.a);
    await t.bash("PreToolUse", "R2", "ls");
    t.tick(10 * 60_000);
    await t.bash("PostToolUse", "R2", "ls");
    await t.write(2);
    await t.stop();
    assert.deepEqual(t.credits(), ["a.xlsx:"]);
  });

  // a recorded run's shape: a JSON file (no cells), v2 written by the venv python after the call's Post
  for (const open of [false, true]) {
    it(`a JSON file's v2 written after the Post is credited to the call ${open ? "with a helper launch open at the sweep" : "with nothing open"}`, async () => {
      const t = await rig();
      await writeFile(t.json, '{"v":1}');
      await t.bash("PreToolUse", "R0", "ls");
      await t.bash("PostToolUse", "R0", "ls");
      await t.closeCall("H2");
      if (open) await t.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "LAUNCH", tool_input: { description: "d", prompt: "p", subagent_type: "general-purpose" } });
      await writeFile(t.json, '{"v":2}');
      await t.wrote("H2", t.json);
      await t.stop();
      assert.equal(t.credits().at(-1), "extracted.json:H2");
    });
    it(`the same late JSON write with no record stays unattributed ${open ? "with a launch open" : "with nothing open"}`, async () => {
      const t = await rig();
      await writeFile(t.json, '{"v":1}');
      await t.bash("PreToolUse", "R0", "ls");
      await t.bash("PostToolUse", "R0", "ls");
      await t.closeCall("H2");
      if (open) await t.send({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "LAUNCH", tool_input: { description: "d", prompt: "p", subagent_type: "general-purpose" } });
      await writeFile(t.json, '{"v":2}');
      await t.stop();
      assert.equal(t.credits().at(-1), "extracted.json:");
    });
  }
});
