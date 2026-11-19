import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { loadRows } from "../src/timeline/load.ts";
import { readRecord } from "../src/timeline/runs.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a run recorded before has no agent_id on its call ops. At read time a call op is matched by its tool_use_id against the
// tool_use ids in its own session's subagent transcripts (synthetic here, in the shape of Claude Code's agent-<id>.jsonl and .meta.json).
// Guarded against: a stamped agent_id wins, no match stays on the main line, another session's transcript never claims a call.

const probe = path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** The agent transcript line an assistant message makes: tool_use blocks carrying the ids, and words the reader must never keep. */
const assistant = (ids: string[], session = "s1") => JSON.stringify({ type: "assistant", isSidechain: true, sessionId: session, message: { role: "assistant", content: [{ type: "text", text: "SECRET WORDS" }, ...ids.map((id) => ({ type: "tool_use", id, name: "Read", input: { file_path: "/x" } }))] } });
const meta = (toolUseId: unknown) => JSON.stringify({ agentType: "general-purpose", description: "SECRET DESCRIPTION", toolUseId, spawnDepth: 1 });

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-projects-")));
  cleanups.push(async () => {
    for (const d of [home, folder, root]) await rm(d, { recursive: true, force: true });
  });
  await copyFile(probe, path.join(folder, "casebook.xlsx"));
  const projectDir = path.join(root, folder.replace(/[^A-Za-z0-9]/g, "-"));
  await mkdir(projectDir, { recursive: true });
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000) };
  const input = { file_path: path.join(folder, "casebook.xlsx") };
  /** One call of a session; `extra` is the payload's agent fields (none for a run recorded before agent ids were stamped). */
  const callOf = async (id: string, session = "s1", extra: Record<string, unknown> = {}) => {
    const send = (hook_event_name: string) => handleHook({ session_id: session, cwd: folder, hook_event_name, tool_name: "Read", tool_use_id: id, tool_input: input, ...extra } as HookPayload, opts);
    await send("PreToolUse");
    await send("PostToolUse");
  };
  const agentFile = async (session: string, name: string, body: string) => {
    const dir = path.join(projectDir, session, "subagents");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), body);
    return dir;
  };
  // each session is its own task, so the record is read from every task and merged.
  const read = (over: { transcriptsRoot?: string } = {}) => {
    const ledger = openLedger(home);
    try {
      const calls = new Map<string, { agentId: string | null; launchId?: string | null }>() as ReturnType<typeof readRecord>["calls"];
      const stored: string[] = [];
      let loaded: ReturnType<typeof loadRows> | undefined;
      for (const id of ledger.allTaskIds()) {
        loaded = loadRows(ledger, id, "test", { transcriptsRoot: root, ...over } as never);
        for (const [k, v] of readRecord(loaded.ops, []).calls) calls.set(k, v);
        stored.push(...ledger.okOpsForTask(id, 0, ledger.maxOpId()).map((o) => o.argsJson));
      }
      return { loaded: loaded!, calls, stored };
    } finally {
      ledger.close();
    }
  };
  /** A call that does match, so a test about a refusal is red when the backfill is absent altogether (a refusal alone passes on unchanged code). */
  const control = async () => {
    await callOf("toolu_CTL");
    await agentFile("s1", "agent-ctl.jsonl", assistant(["toolu_CTL"]) + "\n");
  };
  const alive = (calls: Map<string, { agentId: string | null }>) => assert.equal(calls.get("toolu_CTL")!.agentId, "ctl", "the backfill did not run");
  return { callOf, agentFile, read, projectDir, root, home, control, alive };
}

describe("older runs get their subagent lanes back", () => {
  it("a call with no agent_id takes the lane of the agent whose transcript holds its tool_use id, placed by the meta file's launcher", async () => {
    const t = await setup();
    await t.callOf("main1");
    await t.callOf("toolu_A1");
    await t.callOf("toolu_B1");
    await t.agentFile("s1", "agent-aaa.jsonl", [assistant(["toolu_A1"]), "not json", assistant(["toolu_A2"])].join("\n") + "\n");
    await t.agentFile("s1", "agent-aaa.meta.json", meta("toolu_LAUNCH"));
    await t.agentFile("s1", "agent-bbb.jsonl", assistant(["toolu_B1"]) + "\n");
    const { calls } = t.read();
    assert.equal(calls.get("toolu_A1")!.agentId, "aaa");
    assert.equal(calls.get("toolu_A1")!.launchId, "toolu_LAUNCH");
    assert.equal(calls.get("toolu_B1")!.agentId, "bbb");
    assert.equal(calls.get("toolu_B1")!.launchId, null);
    assert.equal(calls.get("main1")!.agentId, null);
  });

  it("stored ops are never rewritten", async () => {
    const t = await setup();
    await t.callOf("toolu_A1");
    await t.agentFile("s1", "agent-aaa.jsonl", assistant(["toolu_A1"]) + "\n");
    const { stored, calls } = t.read();
    assert.equal(calls.get("toolu_A1")!.agentId, "aaa");
    assert.ok(stored.length > 0);
    for (const s of stored) assert.ok(!s.includes("agent_id"), s);
  });

  it("a stamped agent_id always wins over a match", async () => {
    const t = await setup();
    await t.control();
    await t.callOf("toolu_A1", "s1", { agent_id: "stamped", agent_type: "general-purpose" });
    await t.agentFile("s1", "agent-aaa.jsonl", assistant(["toolu_A1"]) + "\n");
    await t.agentFile("s1", "agent-aaa.meta.json", meta("toolu_LAUNCH"));
    const { calls } = t.read();
    t.alive(calls);
    assert.equal(calls.get("toolu_A1")!.agentId, "stamped");
    assert.equal(calls.get("toolu_A1")!.launchId, null);
  });

  it("a call no transcript names stays on the main line", async () => {
    const t = await setup();
    await t.control();
    await t.callOf("toolu_Z9");
    await t.agentFile("s1", "agent-aaa.jsonl", assistant(["toolu_A1"]) + "\n");
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_Z9")!.agentId, null); }
  });

  it("a transcript of another session never claims a call", async () => {
    const t = await setup();
    await t.control();
    await t.callOf("toolu_A1", "s1");
    await t.agentFile("s2", "agent-aaa.jsonl", assistant(["toolu_A1"], "s2") + "\n");
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
    // A line inside s1's own folder that names another session is not trusted either.
    await t.agentFile("s1", "agent-bbb.jsonl", assistant(["toolu_A1"], "s2") + "\n");
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
  });

  it("an id that two agents' transcripts both hold is no match", async () => {
    const t = await setup();
    await t.control();
    await t.callOf("toolu_A1");
    await t.agentFile("s1", "agent-aaa.jsonl", assistant(["toolu_A1"]) + "\n");
    await t.agentFile("s1", "agent-bbb.jsonl", assistant(["toolu_A1"]) + "\n");
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
  });

  it("a missing, empty or unreadable transcript dir changes nothing", async () => {
    const t = await setup();
    await t.control();
    await t.callOf("toolu_A1");
    const before = t.read();
    t.alive(before.calls);
    assert.equal(before.calls.get("toolu_A1")!.agentId, null);
    assert.equal(t.read({ transcriptsRoot: path.join(t.root, "no", "such", "root") }).calls.get("toolu_A1")!.agentId, null);
    await t.agentFile("s1", "agent-aaa.jsonl", "");
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
    assert.equal(t.read().loaded.etag, before.loaded.etag);
  });

  it("a transcript that does not parse, or is a link, or is too big, matches nothing", async () => {
    const t = await setup();
    await t.control();
    await t.callOf("toolu_A1");
    await t.agentFile("s1", "agent-aaa.jsonl", "{{{ toolu_A1 \"type\":\"tool_use\"\n");
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
    const dir = await t.agentFile("s1", "agent-real.txt", assistant(["toolu_A1"]) + "\n");
    await symlink(path.join(dir, "agent-real.txt"), path.join(dir, "agent-lnk.jsonl"));
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
    await t.agentFile("s1", "agent-big.jsonl", assistant(["toolu_A1"]) + "\n" + " ".repeat(65 * 1024 * 1024));
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
  });

  describe("no link anywhere between the root and the file is followed", () => {
    /** A real layout outside the root that holds the call's id, plus a control in a real project dir (session s2) so a refusal cannot pass vacuously. */
    async function linked() {
      const t = await setup();
      const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-outside-")));
      cleanups.push(() => rm(outside, { recursive: true, force: true }));
      const other = path.join(t.root, "other-project", "s2", "subagents");
      await mkdir(other, { recursive: true });
      await writeFile(path.join(other, "agent-ctl.jsonl"), assistant(["toolu_CTL"], "s2") + "\n");
      await t.callOf("toolu_CTL", "s2");
      await t.callOf("toolu_A1");
      const check = () => {
        const r = t.read();
        assert.equal(r.calls.get("toolu_CTL")!.agentId, "ctl", "the backfill did not run");
        assert.equal(r.calls.get("toolu_A1")!.agentId, null);
        return r;
      };
      return { t, outside, check };
    }

    it("a symlinked project dir", async () => {
      const { t, outside, check } = await linked();
      await mkdir(path.join(outside, "proj", "s1", "subagents"), { recursive: true });
      await writeFile(path.join(outside, "proj", "s1", "subagents", "agent-a1.jsonl"), assistant(["toolu_A1"]) + "\n");
      await rm(t.projectDir, { recursive: true });
      await symlink(path.join(outside, "proj"), t.projectDir);
      check();
    });

    it("a symlinked session dir", async () => {
      const { t, outside, check } = await linked();
      await mkdir(path.join(outside, "s1", "subagents"), { recursive: true });
      await writeFile(path.join(outside, "s1", "subagents", "agent-a1.jsonl"), assistant(["toolu_A1"]) + "\n");
      await symlink(path.join(outside, "s1"), path.join(t.projectDir, "s1"));
      check();
    });

    it("a symlinked subagents dir", async () => {
      const { t, outside, check } = await linked();
      await mkdir(path.join(outside, "sub"), { recursive: true });
      await writeFile(path.join(outside, "sub", "agent-a1.jsonl"), assistant(["toolu_A1"]) + "\n");
      await mkdir(path.join(t.projectDir, "s1"), { recursive: true });
      await symlink(path.join(outside, "sub"), path.join(t.projectDir, "s1", "subagents"));
      check();
    });

    it("a symlinked agent transcript", async () => {
      const { t, outside, check } = await linked();
      await writeFile(path.join(outside, "x.jsonl"), assistant(["toolu_A1"]) + "\n");
      const dir = await t.agentFile("s1", "agent-other.jsonl", "");
      await symlink(path.join(outside, "x.jsonl"), path.join(dir, "agent-a1.jsonl"));
      check();
    });

    it("a symlinked meta file gives no launcher", async () => {
      const { t, outside, check } = await linked();
      await writeFile(path.join(outside, "m.json"), meta("toolu_LAUNCH"));
      const dir = await t.agentFile("s1", "agent-a1.jsonl", assistant(["toolu_A1"]) + "\n");
      await symlink(path.join(outside, "m.json"), path.join(dir, "agent-a1.meta.json"));
      const r = t.read();
      assert.equal(r.calls.get("toolu_A1")!.agentId, "a1");
      assert.equal(r.calls.get("toolu_A1")!.launchId, null);
      assert.equal(r.calls.get("toolu_CTL")!.agentId, "ctl");
      void check;
    });
  });

  it("an id inside message text, or in a user line, is not a tool_use id", async () => {
    const t = await setup();
    await t.control();
    await t.callOf("toolu_A1");
    const text = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: 'x {"type":"tool_use","id":"toolu_A1"}' }] } });
    const user = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_use", id: "toolu_A1" }] } });
    await t.agentFile("s1", "agent-aaa.jsonl", text + "\n" + user + "\n");
    { const r = t.read(); t.alive(r.calls); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
  });

  it("a bad agent id in a file name, or a bad launcher, is not used", async () => {
    const t = await setup();
    await t.callOf("toolu_A1");
    await t.agentFile("s1", "agent-..jsonl", assistant(["toolu_A1"]) + "\n");
    await t.agentFile("s1", "agent-.hid.jsonl", assistant(["toolu_A1"]) + "\n");
    { const r = t.read(); assert.equal(r.calls.get("toolu_A1")!.agentId, null); }
    await t.agentFile("s1", "agent-ok.jsonl", assistant(["toolu_A1"]) + "\n");
    await t.agentFile("s1", "agent-ok.meta.json", meta("has/slash"));
    const c = t.read().calls.get("toolu_A1")!;
    assert.equal(c.agentId, "ok");
    assert.equal(c.launchId, null);
  });

  it("the loaded rows carry none of the transcript's words", async () => {
    const t = await setup();
    await t.callOf("toolu_A1");
    await t.agentFile("s1", "agent-aaa.jsonl", assistant(["toolu_A1"]) + "\n");
    await t.agentFile("s1", "agent-aaa.meta.json", meta("toolu_LAUNCH"));
    const { loaded, calls } = t.read();
    assert.equal(calls.get("toolu_A1")!.agentId, "aaa");
    assert.ok(!JSON.stringify(loaded.ops).includes("SECRET"));
  });

  it("ids are found across read-chunk edges, after big lines, and in a last line with no newline", async () => {
    const t = await setup();
    for (const id of ["toolu_E1", "toolu_E2", "toolu_E3"]) await t.callOf(id);
    const pad = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(1_500_000) } });
    const huge = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_E9" }, { type: "text", text: "y".repeat(9_000_000) }] } });
    await t.agentFile("s1", "agent-edge.jsonl", [assistant(["toolu_E1"]), pad, huge, pad, assistant(["toolu_E2"]), assistant(["toolu_E3"])].join("\n"));
    const { calls } = t.read();
    assert.equal(calls.get("toolu_E1")!.agentId, "edge");
    assert.equal(calls.get("toolu_E2")!.agentId, "edge");
    assert.equal(calls.get("toolu_E3")!.agentId, "edge");
  });

  it("the adapter keeps no dot-only or dotfile agent id, and reads no meta through a dot session", async () => {
    const t = await setup();
    for (const [n, bad] of ["..", ".", ".hid", "..x"].entries()) {
      await t.callOf(`toolu_D${n}`, "s1", { agent_id: bad, agent_type: "general-purpose" });
    }
    const { calls } = t.read();
    for (const n of [0, 1, 2, 3]) assert.equal(calls.get(`toolu_D${n}`)!.agentId, null);
  });
});
