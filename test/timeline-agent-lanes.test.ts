import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildRuns } from "../src/timeline/runs.ts";
import { buildTimeline, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";
import { workbookClaims } from "./helpers/claims.ts";

// each subagent gets its own lane. Hook payloads (synthetic, in the field names the Claude Code 2.1.296 hook schema declares:
// agent_id and agent_type, present only inside a subagent) -> call ops -> requests and runs -> timeline body -> rail model.
// Guarded against: a request never claims another request's agent's calls, and a call with no agent id stays on the main line.

const probe = path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function adapter() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  await copyFile(probe, path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000) };
  const send = (over: Record<string, unknown>) => handleHook({ session_id: "s1", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  let n = 0;
  /** One call carrying the extra payload fields; returns the args of the op it logged. */
  const run = async (extra: Record<string, unknown>) => {
    const id = `c${++n}`;
    await send({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: id, tool_input: { file_path: path.join(folder, "casebook.xlsx") }, ...extra });
    await send({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: id, tool_input: { file_path: path.join(folder, "casebook.xlsx") }, ...extra });
    const ledger = openLedger(home);
    try {
      const rows = ledger.okOpsForTask(1, 0, ledger.maxOpId()).filter((o) => (JSON.parse(o.argsJson) as { tool_use_id?: string }).tool_use_id === id);
      assert.equal(rows.length, 1);
      return JSON.parse(rows[0]!.argsJson) as Record<string, unknown>;
    } finally {
      ledger.close();
    }
  };
  return { run };
}

describe("the adapter records the agent on a call op", () => {
  it("a call inside a subagent records agent_id and agent_type", async () => {
    const { run } = await adapter();
    const args = await run({ agent_id: "a7b78c211b6c4bb40", agent_type: "general-purpose" });
    assert.equal(args.agent_id, "a7b78c211b6c4bb40");
    assert.equal(args.agent_type, "general-purpose");
  });

  it("a main-thread call records neither field", async () => {
    const { run } = await adapter();
    const args = await run({});
    assert.ok(!("agent_id" in args) && !("agent_type" in args));
  });

  it("an agent_type with no agent_id (a main thread started as an agent) stays on the main line", async () => {
    const { run } = await adapter();
    const args = await run({ agent_type: "code-reviewer" });
    assert.ok(!("agent_id" in args) && !("agent_type" in args));
  });

  it("an agent_id that is not a short plain string is no agent id", async () => {
    const { run } = await adapter();
    for (const bad of [{ id: 1 }, "", "x".repeat(200), "has/slash", 7, null]) {
      const args = await run({ agent_id: bad, agent_type: "general-purpose" });
      assert.ok(!("agent_id" in args), `kept ${JSON.stringify(bad)}`);
    }
  });
});

const W = "/w/";
const agent = (id: string, type = "general-purpose") => ({ agent_id: id, agent_type: type });
const ids = (r: { calls: Array<{ id: string }> }) => r.calls.map((c) => c.id);
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });

/**
 * Request A (stamp 1) starts two agents. Request B (stamp 10) is sent while they still run. Agent 1 and agent 2 keep calling after
 * B; agent 3 first calls after B and belongs to B. Every call carries a start stamp; at = stamp * 10.
 */
function shape() {
  const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = []) => call(id, { desc: id, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
  const ops = [
    c("a1", 2, {}, []),
    c("a2", 3, {}, [W + "w.txt"]),
    c("h1", 4, agent("ag1"), [W + "x.txt"]),
    c("k1", 5, agent("ag2"), [W + "y.txt"]),
    prompt("s1", ["Ask A."], stamp(1)),
    prompt("s1", ["Ask B."], stamp(10)),
    c("h2", 12, agent("ag1"), [W + "x.txt"]),
    c("k2", 13, agent("ag2"), [W + "y.txt"]),
    c("b1", 14, {}, [W + "z.txt"]),
    c("m1", 15, agent("ag3", "Explore"), [W + "q.txt"]),
    stop("s1", "done"),
  ];
  const fileStates = [
    state(W + "w.txt", "w0", null, { step: 1 }),
    state(W + "x.txt", "x0", null, { step: 1 }),
    state(W + "y.txt", "y0", null, { step: 1 }),
    state(W + "z.txt", "z0", null, { step: 1 }),
    state(W + "q.txt", "q0", null, { step: 1 }),
    state(W + "w.txt", "w1", "w0", { open: ["a2"], credited: ["a2"] }),
    state(W + "x.txt", "x1", "x0", { open: ["h1"], credited: ["h1"] }),
    state(W + "y.txt", "y1", "y0", { open: ["k1"], credited: ["k1"] }),
    state(W + "x.txt", "x2", "x1", { open: ["h2"], credited: ["h2"] }),
    state(W + "y.txt", "y2", "y1", { open: ["k2"], credited: ["k2"] }),
    state(W + "z.txt", "z1", "z0", { open: ["b1"], credited: ["b1"] }),
    state(W + "q.txt", "q1", "q0", { open: ["m1"], credited: ["m1"] }),
  ];
  return { ops, fileStates };
}

const input = (f: ReturnType<typeof shape>): TimelineInput => ({ taskId: 1, build: "t", ops: f.ops, fileStates: f.fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });

describe("requests and runs", () => {
  it("an agent's calls stay with the request its first call belongs to, even after a later request is sent", () => {
    const { requests } = buildRuns(shape().ops, shape().fileStates);
    assert.deepEqual(requests.map((r) => [r.texts[0], ids(r)]), [
      ["Ask A.", ["a1", "a2", "h1", "k1", "h2", "k2"]],
      ["Ask B.", ["b1", "m1"]],
    ]);
  });

  it("a call with no agent id is never moved: it goes where its own start puts it", () => {
    const f = shape();
    // Same shape with the agent fields stripped: the old placement, by start stamp alone.
    const plain = f.ops.map((o) => {
      const a = JSON.parse(o.args_json!) as Record<string, unknown>;
      delete a.agent_id;
      delete a.agent_type;
      return { ...o, args_json: JSON.stringify(a) };
    });
    const { requests } = buildRuns(plain, f.fileStates);
    assert.deepEqual(requests.map((r) => ids(r)), [["a1", "a2", "h1", "k1"], ["h2", "k2", "b1", "m1"]]);
  });

  it("an agent that first calls under a later request is not pulled back to an earlier one", () => {
    const { requests } = buildRuns(shape().ops, shape().fileStates);
    assert.ok(ids(requests[1]!).includes("m1"));
    assert.ok(!ids(requests[0]!).includes("m1"));
  });

  it("the same agent id in two sessions is two agents", () => {
    const c = (id: string, session: string, seq: number, extra: Record<string, unknown>) => call(id, { session, desc: id, at: seq * 10, extra: { startSeq: seq, ...extra } });
    const ops = [
      c("p1", "s1", 2, agent("same")),
      prompt("s1", ["One."], stamp(1)),
      stop("s1"),
      c("q1", "s2", 5, agent("same")),
      prompt("s2", ["Two."], stamp(4)),
      stop("s2"),
    ];
    const { requests, calls } = buildRuns(ops, []);
    assert.deepEqual(requests.map((r) => ids(r)), [["p1"], ["q1"]]);
    assert.equal(calls.get("q1")!.laneHead, undefined, "q1 is the first call of its own agent, not a later call of s1's");
  });

  it("a run never mixes lanes: the main line and each agent are cut apart, and a request's runs follow their first calls", () => {
    const { requests } = buildRuns(shape().ops, shape().fileStates);
    const a = requests[0]!;
    for (const run of a.runs) assert.equal(new Set(run.calls.map((x) => x.agentId)).size, 1, "one lane per run");
    assert.deepEqual(a.runs.map((u) => ids(u)), [["a1", "a2"], ["h1"], ["k1"], ["h2"], ["k2"]]);
  });

  it("records with no agent id at all build the runs they built before", () => {
    const ops = [call("t1", { desc: "t1", named: [W + "app.py"], at: 10 }), call("t2", { tool: "ToolSearch", desc: "", at: 20 }), call("t3", { desc: "t3", named: [W + "app.py"], at: 30 }), prompt("s1", ["Go."]), stop("s1")];
    const { requests } = buildRuns(ops, []);
    assert.deepEqual(requests[0]!.runs.map((u) => ids(u)), [["t1", "t2", "t3"]]);
  });
});

describe("timeline body", () => {
  const tl = (): Timeline => buildTimeline(input(shape()));
  const callsOf = (t: Timeline) => t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls));

  it("carries the agent id and type on each agent call and null on the main line", () => {
    const by = new Map(callsOf(tl()).map((c) => [c.id, c.agent]));
    assert.deepEqual(by.get("h1"), { id: "ag1", type: "general-purpose" });
    assert.deepEqual(by.get("m1"), { id: "ag3", type: "Explore" });
    assert.equal(by.get("a1"), null);
    assert.equal(by.get("b1"), null);
  });
});

describe("rail model", () => {
  const model = () => buildRailModel(buildTimeline(input(shape())));

  it("draws one numbered lane per agent that changed something, in the order they first appear", () => {
    const m = model();
    const helpers = m.actors.filter((a) => a.parent);
    assert.deepEqual(helpers.map((a) => [a.id, a.chip, a.name, a.parent, a.type]), [
      ["agent:1", "1", "Helper 1", "claude", "general-purpose"],
      ["agent:2", "2", "Helper 2", "claude", "general-purpose"],
      ["agent:3", "3", "Helper 3", "claude", "Explore"],
    ]);
    const lanes = (id: string) => m.stops.filter((s) => s.lane === id).map((s) => s.change?.file);
    assert.deepEqual(lanes("agent:1"), ["x.txt", "x.txt"]);
    assert.deepEqual(lanes("agent:2"), ["y.txt", "y.txt"]);
    assert.deepEqual(lanes("agent:3"), ["q.txt"]);
  });

  it("a change with no agent id stays on Claude's line", () => {
    const m = model();
    // Claude's lane also carries its reply step now (this fixture's Stop is stamped at time 0), so only change steps are compared.
    assert.deepEqual(m.stops.filter((s) => s.lane === "claude" && s.change).map((s) => s.change?.file), ["w.txt", "z.txt"]);
  });

  it("a helper's moment names the request that launched it, not the one sent while it ran", () => {
    const m = model();
    const h2 = m.stops.filter((s) => s.lane === "agent:1")[1]!;
    assert.equal(h2.change!.ask, "Ask A.");
    assert.equal(m.stops.filter((s) => s.lane === "agent:3")[0]!.change!.ask, "Ask B.");
  });

  it("a helper's line branches off Claude's last stop before it and merges into the next one after it", () => {
    const m = model();
    // change steps only; the reply step (time 0 in this fixture) is not a branch point under test.
    const claude = m.stops.filter((s) => s.lane === "claude" && s.change);
    const [w, z] = [claude[0]!.id, claude[1]!.id];
    const by = (id: string) => m.actors.find((a) => a.id === id)!;
    assert.deepEqual([by("agent:1").startId, by("agent:1").mergeId], [w, z]);
    assert.deepEqual([by("agent:2").startId, by("agent:2").mergeId], [w, z]);
    // Agent 3 only appears after Claude's last stop: it branches there and has nothing to merge into.
    assert.deepEqual([by("agent:3").startId, by("agent:3").mergeId], [z, null]);
  });

  it("with no agent in the record the model has the three fixed lanes only", () => {
    const f = shape();
    // the agent fields are dropped by parsing, not by a text replace. The replace left a trailing comma, so every agent call's op
    // failed to parse and its changes were credited to calls with no record; they stay off the main lane and go on "unsure".
    const strip = (json: string): string => JSON.stringify((({ agent_id: _id, agent_type: _type, ...rest }) => rest)(JSON.parse(json)));
    const plain = { ...f, ops: f.ops.map((o) => ({ ...o, args_json: strip(o.args_json!) })) };
    const m = buildRailModel(buildTimeline(input(plain)));
    assert.deepEqual(m.actors.map((a) => a.id), ["you", "claude", "other"]);
    assert.ok(m.stops.every((s) => !s.lane?.startsWith("agent:")));
  });
});

// an agent's calls belong to the request of the main-stream call that launched it. Every case runs on both placement
// paths: stamped (every call has startSeq) and fallback (one call lacks it, so requests are placed by time, the pointer moving forward).
describe("launcher placement", () => {
  type Spec = [id: string, seq: number, extra?: Record<string, unknown>];
  const build = (specs: Spec[], dropSeq: boolean) => {
    const calls = specs.map(([id, seq, extra = {}]) => call(id, { desc: id, at: seq * 10, extra: { startSeq: seq, ...extra } }));
    const ops = [...calls, prompt("s1", ["Ask A."], stamp(1)), prompt("s1", ["Ask B."], stamp(10)), stop("s1")];
    if (!dropSeq) return ops;
    // The first call loses its stamp: the record then falls to the time-ordered placement.
    return ops.map((o, i) => {
      if (i !== 0) return o;
      const a = JSON.parse(o.args_json!) as Record<string, unknown>;
      delete a.startSeq;
      return { ...o, args_json: JSON.stringify(a) };
    });
  };
  const place = (specs: Spec[], dropSeq: boolean) => buildRuns(build(specs, dropSeq), []).requests.map((r) => ids(r).sort());
  const both = (name: string, specs: Spec[], want: string[][]) => {
    for (const dropSeq of [false, true]) it(`${name} (${dropSeq ? "one call missing startSeq" : "stamped"})`, () => assert.deepEqual(place(specs, dropSeq), want.map((w) => [...w].sort())));
  };

  both("two agents launched under A that run on after B stay with A", [
    ["a0", 2], ["l1", 3], ["l2", 4], ["x1", 5, { ...agent("ag1"), launch_tool_use_id: "l1" }], ["y1", 6, { ...agent("ag2"), launch_tool_use_id: "l2" }],
    ["b1", 12], ["x2", 13, { ...agent("ag1"), launch_tool_use_id: "l1" }], ["y2", 14, { ...agent("ag2"), launch_tool_use_id: "l2" }],
  ], [["a0", "l1", "l2", "x1", "y1", "x2", "y2"], ["b1"]]);

  both("an agent whose first call comes after B goes to the request of its launcher", [
    ["a0", 2], ["l1", 3], ["b1", 12], ["z1", 13, { ...agent("ag3"), launch_tool_use_id: "l1" }], ["z2", 14, { ...agent("ag3"), launch_tool_use_id: "l1" }],
  ], [["a0", "l1", "z1", "z2"], ["b1"]]);

  both("an agent launched by a call under B goes to B even when its head is late", [
    ["a0", 2], ["b1", 12], ["l2", 13], ["w1", 14, { ...agent("ag4"), launch_tool_use_id: "l2" }],
  ], [["a0"], ["b1", "l2", "w1"]]);

  both("a call with no agent id never moves, even if it names a launch id", [
    ["a0", 2], ["l1", 3], ["b1", 12], ["m1", 13, { launch_tool_use_id: "l1" }], ["z1", 14, { ...agent("ag3"), launch_tool_use_id: "l1" }],
  ], [["a0", "l1", "z1"], ["b1", "m1"]]);

  both("with no meta file recorded, the lane falls back to its first call", [
    ["a0", 2], ["l1", 3], ["x1", 4, agent("ag1")], ["b1", 12], ["x2", 13, agent("ag1")], ["w1", 14, agent("ag5")],
  ], [["a0", "l1", "x1", "x2"], ["b1", "w1"]]);

  both("a launch id naming a call the record does not hold falls back to the first call", [
    ["a0", 2], ["x1", 4, { ...agent("ag1"), launch_tool_use_id: "gone" }], ["b1", 12], ["x2", 13, { ...agent("ag1"), launch_tool_use_id: "gone" }],
  ], [["a0", "x1", "x2"], ["b1"]]);

  both("a launch id naming a call of the agent itself is no launcher", [
    ["a0", 2], ["x1", 4, { ...agent("ag1"), launch_tool_use_id: "x2" }], ["b1", 12], ["x2", 13, { ...agent("ag1"), launch_tool_use_id: "x2" }],
  ], [["a0", "x1", "x2"], ["b1"]]);

  both("a helper launched by a helper follows the outer launcher's request", [
    ["a0", 2], ["l1", 3], ["x1", 4, { ...agent("ag1"), launch_tool_use_id: "l1" }], ["b1", 12], ["x2", 13, { ...agent("ag1"), launch_tool_use_id: "l1" }], ["n1", 14, { ...agent("ag9"), launch_tool_use_id: "x2" }],
  ], [["a0", "l1", "x1", "x2", "n1"], ["b1"]]);
});

describe("the adapter reads the launcher", () => {
  async function withMeta(files: Record<string, string | null>, agentId = "ag-meta") {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
    const tdir = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-transcripts-")));
    cleanups.push(async () => {
      for (const d of [home, folder, tdir]) await rm(d, { recursive: true, force: true });
    });
    await copyFile(probe, path.join(folder, "casebook.xlsx"));
    await mkdir(path.join(tdir, "s1", "subagents"), { recursive: true });
    for (const [name, body] of Object.entries(files)) if (body !== null) await writeFile(path.join(tdir, "s1", "subagents", name), body);
    let clock = 1_000_000;
    const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000) };
    const send = (over: Record<string, unknown>) => handleHook({ session_id: "s1", cwd: folder, hook_event_name: "", transcript_path: path.join(tdir, "s1.jsonl"), ...over } as HookPayload, opts);
    const input = { file_path: path.join(folder, "casebook.xlsx") };
    const t0 = Date.now();
    await send({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "k1", tool_input: input, agent_id: agentId, agent_type: "general-purpose" });
    await send({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "k1", tool_input: input, agent_id: agentId, agent_type: "general-purpose" });
    const ms = Date.now() - t0;
    const ledger = openLedger(home);
    try {
      const rows = ledger.okOpsForTask(1, 0, ledger.maxOpId()).filter((o) => (JSON.parse(o.argsJson) as { tool_use_id?: string }).tool_use_id === "k1");
      return { args: JSON.parse(rows[0]!.argsJson) as Record<string, unknown>, ms, tdir };
    } finally {
      ledger.close();
    }
  }
  const meta = (id: unknown) => JSON.stringify({ agentType: "general-purpose", toolUseId: id, spawnDepth: 1 });

  it("records launch_tool_use_id from the agent's meta file", async () => {
    const { args, ms } = await withMeta({ "agent-ag-meta.meta.json": meta("toolu_01ABC") });
    assert.equal(args.launch_tool_use_id, "toolu_01ABC");
    assert.ok(ms < 1000, `pair of hooks took ${ms} ms`);
  });

  it("a missing meta file leaves the op without a launcher", async () => {
    const { args } = await withMeta({});
    assert.equal(args.agent_id, "ag-meta");
    assert.ok(!("launch_tool_use_id" in args));
  });

  it("unreadable or invalid meta leaves the op unchanged", async () => {
    for (const body of ["not json", meta("has/slash"), meta(7), meta("x".repeat(500)), "x".repeat(40_000), "null"]) {
      const { args } = await withMeta({ "agent-ag-meta.meta.json": body });
      assert.ok(!("launch_tool_use_id" in args), `kept for ${body.slice(0, 20)}`);
      assert.equal(args.agent_id, "ag-meta");
    }
  });

  it("a meta file that is a link is not followed", async () => {
    const real = await withMeta({ "real.json": meta("toolu_REAL") });
    const link = path.join(real.tdir, "s1", "subagents", "agent-ag-link.meta.json");
    await symlink(path.join(real.tdir, "s1", "subagents", "real.json"), link);
    // Same transcript dir, second agent: the dir is reused through a fresh adapter.
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
    cleanups.push(async () => {
      for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
    });
    await copyFile(probe, path.join(folder, "casebook.xlsx"));
    const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => 1_000_000 };
    const base = { session_id: "s1", cwd: folder, transcript_path: path.join(real.tdir, "s1.jsonl"), tool_name: "Read", tool_use_id: "k9", tool_input: { file_path: path.join(folder, "casebook.xlsx") }, agent_id: "ag-link", agent_type: "general-purpose" };
    await handleHook({ ...base, hook_event_name: "PreToolUse" } as HookPayload, opts);
    await handleHook({ ...base, hook_event_name: "PostToolUse" } as HookPayload, opts);
    const ledger = openLedger(home);
    try {
      const rows = ledger.okOpsForTask(1, 0, ledger.maxOpId()).filter((o) => (JSON.parse(o.argsJson) as { tool_use_id?: string }).tool_use_id === "k9");
      assert.ok(!("launch_tool_use_id" in (JSON.parse(rows[0]!.argsJson) as object)));
    } finally {
      ledger.close();
    }
  });

  it("a main-thread call never reads a meta file", async () => {
    const { args } = await withMeta({ "agent-ag-meta.meta.json": meta("toolu_01ABC") }, "");
    assert.ok(!("agent_id" in args) && !("launch_tool_use_id" in args));
  });
});

describe("a helper's notes name the helper", () => {
  const m = buildRailModel(buildTimeline(input(shape())));
  // change steps only; a reply step on Claude's lane has no change note.
  const notes = (lane: string) => m.stops.filter((s) => s.lane === lane && s.change).map((s) => s.change!.note);

  it("a note for a helper's change starts with the helper's name and number, matching its chip", () => {
    for (const [lane, n] of [["agent:1", 1], ["agent:2", 2], ["agent:3", 3]] as const) {
      assert.ok(notes(lane).length > 0);
      for (const note of notes(lane)) {
        assert.ok(note.startsWith(`Helper ${n} `), note);
        assert.ok(!/^Claude\b/.test(note), note);
      }
    }
  });

  it("a main-line note keeps Claude", () => {
    assert.ok(notes("claude").length > 0);
    for (const note of notes("claude")) assert.ok(note.startsWith("Claude "), note);
  });
});
