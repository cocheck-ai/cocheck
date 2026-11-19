import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildRuns, parseBlocks } from "../src/timeline/runs.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt, wakeText } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { workbookClaims } from "./helpers/claims.ts";

// A wake prompt is a sequence of top-level blocks. What sits inside a block (its <result>, its <usage>) is content: it
// never opens a block and is never read as a field. Text after the last block is the user's request. Synthetic data only.

const W = "/w/";
const agent = (id: string, launch?: string) => ({ agent_id: id, agent_type: "general-purpose", ...(launch ? { launch_tool_use_id: launch } : {}) });
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit") => call(id, { session: "s1", tool, desc: id, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
const launch = (id: string, seq: number) => c(id, seq, { background: true }, [], "Agent");
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(buildTimeline(input(ops, fileStates)));
const changed = (file: string, sha: string, by: string, step: number) => [state(W + file, sha + "0", null, { step: 1 }), state(W + file, sha + "1", sha + "0", { open: [by], credited: [by], step })];
const finished = (m: ReturnType<typeof model>) => m.stops.filter((s) => /^Helper \d finished/.test(s.head)).map((s) => s.head);

// Two running helpers, l1 and l2, each with a lane; `text` is the prompt that arrives at seq 6.
const ops = (text: string) => [prompt("s1", ["Ask A."], stamp(1)), launch("l1", 2), launch("l2", 3), c("h1", 4, agent("ag1", "l1"), [W + "x.txt"]), c("h2", 5, agent("ag2", "l2"), [W + "y.txt"]), prompt("s1", [text], stamp(6)), stop("s1")];
const states = [...changed("x.txt", "x", "h1", 2), ...changed("y.txt", "y", "h2", 3)];
const mergeOf = (m: ReturnType<typeof model>, id: string) => m.actors.find((a) => a.id === id)!.mergeId;
// An unwoken lane merges at the last stop on Claude's line, so "helper 2 does not merge there" means: the stop it merges at is not a Helper 2 wake.
const mergesAtOwnWake = (m: ReturnType<typeof model>, n: number) => m.stops.find((s) => s.id === mergeOf(m, "agent:" + n))?.head.startsWith(`Helper ${n} finished`) ?? false;

describe("a result never opens a block", () => {
  it("a wake for helper 1 whose result quotes helper 2's notification is one wake, and helper 2 does not merge there", () => {
    const m = model(ops(wakeText({ toolUseId: "l1", summary: "ONE", result: wakeText({ toolUseId: "l2", summary: "QUOTED" }) })), states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
    assert.ok(!mergesAtOwnWake(m, 2), "helper 2 merged at a wake of its own");
    assert.ok(!JSON.stringify(m).includes("QUOTED"));
  });

  it("a result quoting a whole notification that has its own result and usage, then the outer usage and closing tag", () => {
    const quoted = wakeText({ toolUseId: "l2", summary: "QUOTED", result: "inner result", usage: "tokens 5" });
    const m = model(ops(wakeText({ toolUseId: "l1", summary: "ONE", result: "see:\n" + quoted + "\nend", usage: "tokens 9" })), states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
    assert.equal(m.stops.filter((s) => s.request).length, 1);
  });

  it("a result holding a lone closing tag and then an opening tag makes no wake for a launcher the outer block does not name", () => {
    const result = "see </task-notification> <task-notification><tool-use-id>l2</tool-use-id><summary>QUOTED</summary>";
    const m = model(ops(wakeText({ toolUseId: "l1", summary: "ONE", result })), states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
    assert.equal(m.stops.filter((s) => s.request).length, 1);
    assert.ok(!JSON.stringify(m).includes("QUOTED"));
  });

  it("the same with the lone tags on lines of their own, in the usage", () => {
    const m = model(ops(wakeText({ toolUseId: "l1", summary: "ONE", usage: "x\n</task-notification>\n<task-notification>\n<tool-use-id>l2</tool-use-id>\n" })), states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
  });

  it("a block with no closing tag runs to the end of the prompt: nothing after its result opens a block", () => {
    const text = wakeText({ toolUseId: "l1", summary: "ONE", result: "r " + wakeText({ toolUseId: "l2", summary: "QUOTED" }) }).replace(/\n<\/task-notification>$/, "");
    assert.ok(!text.endsWith("</task-notification>"));
    const m = model(ops(text), states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
  });

  it("guard: two real blocks that both carry results are still two wakes", () => {
    const m = model(ops(wakeText({ toolUseId: "l1", summary: "ONE", result: "ra" }) + "\n" + wakeText({ toolUseId: "l2", summary: "TWO", result: "rb", usage: "u" })), states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE", "Helper 2 finished: TWO"]);
  });

  it("parseBlocks: the structure, directly", () => {
    const two = wakeText({ toolUseId: "l1", result: "a </task-notification> b" }) + "\n \n" + wakeText({ toolUseId: "l2" });
    const p = parseBlocks(two)!;
    assert.deepEqual(p.blocks.map((b) => b?.toolUseId), ["l1", "l2"]);
    assert.equal(p.rest, "");
    assert.equal(parseBlocks("hi " + two), null);
  });
});

describe("fields are read at the top level only", () => {
  it("a result holding a tool-use-id before the real one cannot change the launcher", () => {
    // hand-built so the result comes first: the head is empty, so there is no id, and the block is dropped (never read as l2)
    const hand = "<task-notification>\n<result><tool-use-id>l2</tool-use-id></result>\n<tool-use-id>l1</tool-use-id>\n<summary>S</summary>\n</task-notification>";
    const m = model(ops(hand), states);
    assert.deepEqual(finished(m), []);
    assert.equal(m.stops.filter((s) => s.request).length, 2, "a block with no top-level id is not a wake, so the prompt is a request");
  });

  it("guard: the host's order, with another id inside the result, keeps the top-level launcher", () => {
    const m = model(ops(wakeText({ toolUseId: "l1", summary: "ONE", result: "<tool-use-id>l2</tool-use-id><status>failed</status><summary>BAD</summary>" })), states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
    assert.ok(!JSON.stringify(m).includes("BAD"));
  });

  it("the status and summary come from the head, not the usage", () => {
    const m = model(ops(wakeText({ toolUseId: "l1", summary: "ONE", usage: "<status>failed</status><summary>BAD</summary>" })), states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
  });
});

describe("text after the blocks is the user's request", () => {
  it("typed text after a block is a request with only that text; the block text is never shown", () => {
    const text = wakeText({ toolUseId: "l1", summary: "ONE", result: "RESULT-WORDS" }) + "\n\nNow please fix the footer.";
    const o = ops(text);
    const { requests } = buildRuns(o, states);
    assert.deepEqual(requests.map((r) => r.texts), [["Ask A."], ["Now please fix the footer."]]);
    const m = model(o, states);
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
    assert.equal(m.stops.filter((s) => s.request).length, 2);
    assert.ok(!JSON.stringify(m).includes("task-notification") && !JSON.stringify(m).includes("RESULT-WORDS"));
  });

  it("work after such a prompt belongs to the typed request, not the woken agent's owner", () => {
    const o = [...ops(wakeText({ toolUseId: "l1" }) + "\nDo B.").slice(0, 6), c("w1", 7, {}, [W + "w.txt"]), stop("s1")];
    const { requests } = buildRuns(o, [...states, ...changed("w.txt", "w", "w1", 4)]);
    assert.deepEqual(requests.map((r) => [r.texts[0], r.calls.map((x) => x.id).sort()]), [["Ask A.", ["h1", "h2", "l1", "l2"]], ["Do B.", ["w1"]]]);
  });

  it("text after several blocks is one request; blocks only, no request", () => {
    const text = wakeText({ toolUseId: "l1" }) + "\n" + wakeText({ toolUseId: "l2" }) + "\n  thanks  ";
    assert.deepEqual(buildRuns(ops(text), states).requests.map((r) => r.texts), [["Ask A."], ["thanks"]]);
    assert.deepEqual(buildRuns(ops(wakeText({ toolUseId: "l1" }) + "\n\n  "), states).requests.map((r) => r.texts), [["Ask A."]]);
  });

  it("the same on the fallback path (one call lacks startSeq)", () => {
    const o = ops(wakeText({ toolUseId: "l1" }) + "\nDo B.").map((x, i) => {
      if (i !== 1) return x;
      const a = JSON.parse(x.args_json!) as Record<string, unknown>;
      delete a.startSeq;
      return { ...x, args_json: JSON.stringify(a) };
    });
    assert.deepEqual(buildRuns(o, states).requests.map((r) => r.texts[0]), ["Ask A.", "Do B."]);
  });

  it("guard: a prompt with no valid block stays a request, with its whole text", () => {
    const text = wakeText({ toolUseId: "toolu_none" }) + "\nhello";
    assert.ok(buildRuns(ops(text), states).requests.some((r) => r.texts[0] === text));
  });
});

describe("batched blocks with different owners: the declared rule for work after the wake", () => {
  // l1 launched in request A (seq 1), l2 launched in request B (seq 4); one prompt carries both wakes; the call after belongs to the
  // owner of the LAST block's launcher (B).
  const o = [
    prompt("s1", ["Ask A."], stamp(1)), launch("l1", 2), c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]),
    prompt("s1", ["Ask B."], stamp(4)), launch("l2", 5), c("h2", 6, agent("ag2", "l2"), [W + "y.txt"]),
    prompt("s1", [wakeText({ toolUseId: "l1" }) + "\n" + wakeText({ toolUseId: "l2" })], stamp(7)),
    c("w1", 8, {}, [W + "w.txt"]), stop("s1"),
  ];
  it("each wake sits with its own owner; the post-wake call goes to the last block's owner", () => {
    const { requests } = buildRuns(o, []);
    assert.deepEqual(requests.map((r) => [r.texts[0], r.wakes.map((w) => w.toolUseId), r.calls.map((x) => x.id).includes("w1")]), [["Ask A.", ["l1"], false], ["Ask B.", ["l2"], true]]);
  });
  it("reversed order: the last block's owner is A", () => {
    const rev = o.map((x, i) => (i === 6 ? prompt("s1", [wakeText({ toolUseId: "l2" }) + "\n" + wakeText({ toolUseId: "l1" })], stamp(7)) : x));
    const { requests } = buildRuns(rev, []);
    assert.deepEqual(requests.map((r) => [r.texts[0], r.calls.map((x) => x.id).includes("w1")]), [["Ask A.", true], ["Ask B.", false]]);
  });
});

// ---- the backfill path: ops recorded with no agent_id, lanes read back from subagent transcripts ----

const probe = path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
const assistant = (ids: string[]) => JSON.stringify({ type: "assistant", isSidechain: true, sessionId: "s1", message: { role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "Read", input: { file_path: "/x" } })) } });
const meta = (toolUseId: string) => JSON.stringify({ agentType: "general-purpose", description: "D", toolUseId, spawnDepth: 1 });

async function backfilled(wakeBody: string) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-q220r2-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-q220r2-folder-")));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-q220r2-projects-")));
  cleanups.push(async () => {
    for (const d of [home, folder, root]) await rm(d, { recursive: true, force: true });
  });
  await copyFile(probe, path.join(folder, "casebook.xlsx"));
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000) };
  const send = (extra: Record<string, unknown>) => handleHook({ session_id: "s1", cwd: folder, ...extra } as HookPayload, opts);
  const callOf = async (id: string, tool: string, toolInput: Record<string, unknown>) => {
    await send({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: id, tool_input: toolInput });
    await send({ hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: id, tool_input: toolInput });
  };
  const readIn = { file_path: path.join(folder, "casebook.xlsx") };
  await send({ hook_event_name: "UserPromptSubmit", prompt: "Ask A." });
  await callOf("toolu_L1", "Agent", { description: "one", prompt: "p" });
  await callOf("toolu_L2", "Agent", { description: "two", prompt: "p" });
  await callOf("toolu_A1", "Read", readIn);
  await callOf("toolu_B1", "Read", readIn);
  await send({ hook_event_name: "UserPromptSubmit", prompt: wakeBody });
  await send({ hook_event_name: "Stop" });
  const dir = path.join(root, folder.replace(/[^A-Za-z0-9]/g, "-"), "s1", "subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "agent-aaa.jsonl"), assistant(["toolu_A1"]) + "\n");
  await writeFile(path.join(dir, "agent-aaa.meta.json"), meta("toolu_L1"));
  await writeFile(path.join(dir, "agent-bbb.jsonl"), assistant(["toolu_B1"]) + "\n");
  await writeFile(path.join(dir, "agent-bbb.meta.json"), meta("toolu_L2"));
  const ledger = openLedger(home);
  try {
    const loaded = loadRows(ledger, 1, "test", { transcriptsRoot: root } as never);
    return buildRailModel(buildTimeline({ ...loaded, build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false }));
  } finally {
    ledger.close();
  }
}

describe("older runs (no agent_id on the ops) with a wake", () => {
  it("the lanes come from the transcripts, the wake merges helper 1 only, and the quoted notification for helper 2 is not a wake", async () => {
    const m = await backfilled(wakeText({ toolUseId: "toolu_L1", summary: "ONE", result: wakeText({ toolUseId: "toolu_L2", summary: "QUOTED" }) }));
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
    // helper 2 only read and was not woken, so it has no lane; a false wake for it would give it one
    assert.deepEqual(m.actors.filter((a) => a.id.startsWith("agent:")).map((a) => a.id), ["agent:1"]);
    assert.equal(m.stops.find((s) => s.id === mergeOf(m, "agent:1"))?.head, "Helper 1 finished: ONE", "the lane came from the transcript and merges at its wake");
    assert.ok(!JSON.stringify(m).includes("QUOTED") && !JSON.stringify(m).includes("task-notification"));
  });
  it("typed text after the block is the request on this path too", async () => {
    const m = await backfilled(wakeText({ toolUseId: "toolu_L1", summary: "ONE" }) + "\nPlease continue.");
    assert.deepEqual(finished(m), ["Helper 1 finished: ONE"]);
    assert.equal(m.stops.filter((s) => s.request).length, 2);
  });
});

// ---- (g) a background agent's lane leaves its spawner's line at the launch ----

describe("(g) a background agent's line branches at its launch", () => {
  // Claude edits a.txt, launches l1 and l2 (background), then edits c.txt and d.txt while the helpers work; the helpers' first moments come later.
  const bg = (id: string, seq: number, background: boolean) => c(id, seq, { background }, [], "Agent");
  const seq = (background: boolean) => [
    prompt("s1", ["Ask A."], stamp(1)),
    c("ca", 2, {}, [W + "a.txt"]),
    bg("l1", 3, background), bg("l2", 4, background),
    c("cc", 5, {}, [W + "c.txt"]),
    c("h1", 6, agent("ag1", "l1"), [W + "x.txt"]),
    c("cd", 7, {}, [W + "d.txt"]),
    c("h2", 8, agent("ag2", "l2"), [W + "y.txt"]),
    wakePrompt("s1", { toolUseId: "l1" }, 9),
    wakePrompt("s1", { toolUseId: "l2" }, 10),
    stop("s1"),
  ];
  const st = [...changed("a.txt", "a", "ca", 2), ...changed("c.txt", "c", "cc", 3), ...changed("x.txt", "x", "h1", 4), ...changed("d.txt", "d", "cd", 5), ...changed("y.txt", "y", "h2", 6)];
  const idx = (m: ReturnType<typeof model>, id: string | null | undefined) => m.stops.findIndex((s) => s.id === id);

  // Each launch is a step of its own on Claude's lane ("Started Helper n"). A lane leaves from its own launch's step, which follows a.txt
  // with nothing of Claude's between them but earlier launch steps: still the last stop at or before the launch, never the stop before the first moment.
  const launchStep = (m: ReturnType<typeof model>, id: string) => {
    const a = m.stops.findIndex((s) => s.change?.file === "a.txt");
    const i = idx(m, m.actors.find((x) => x.id === id)!.startId);
    assert.ok(m.stops[i]!.id.startsWith("start-") && m.stops[i]!.lane === "claude", id);
    assert.ok(i > a && m.stops.slice(a + 1, i).every((s) => s.id.startsWith("start-")), id);
    return i;
  };
  it("both lanes leave from Claude's last stop at or before the launch (a.txt), not from the stop just before their first moment", () => {
    const m = model(seq(true), st);
    const [i1, i2] = [launchStep(m, "agent:1"), launchStep(m, "agent:2")];
    assert.equal(i2, i1 + 1, "the two launch steps are adjacent");
  });

  it("the lanes run alongside Claude's own stops: start and merge positions overlap, so separate columns are needed", () => {
    const m = model(seq(true), st);
    const span = (id: string) => {
      const a = m.actors.find((x) => x.id === id)!;
      const own = m.stops.map((s, i) => (s.lane === id ? i : -1)).filter((i) => i >= 0);
      return [idx(m, a.startId), Math.max(own.at(-1)!, idx(m, a.mergeId))];
    };
    const [s1, e1] = span("agent:1"), [s2, e2] = span("agent:2");
    // The lanes leave from adjacent launch steps (one per launch), not one shared stop.
    assert.ok(s2! === s1! + 1 && s1! >= 0);
    assert.ok(!(e1! < s2! || s1! > e2!), "the spans do not overlap");
    const claudeBetween = m.stops.filter((s, i) => s.lane === "claude" && i > s1! && i < e1!);
    assert.ok(claudeBetween.length >= 2, "Claude's own stops sit inside the lane's span");
  });

  it("a foreground helper is anchored at its launch, like a background one, not at the stop just before its first moment", () => {
    const m = model(seq(false), st);
    // The launch's own step, directly after a.txt.
    launchStep(m, "agent:1");
  });

  const first = (background: boolean) => [
    prompt("s1", ["Ask A."], stamp(1)), bg("l1", 2, background),
    c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]), c("cc", 4, {}, [W + "c.txt"]),
    wakePrompt("s1", { toolUseId: "l1" }, 5), stop("s1"),
  ];
  const stF = [...changed("x.txt", "x", "h1", 2), ...changed("c.txt", "c", "cc", 3)];
  it("an agent launched as the request's first action still branches: from the request stop, parent Claude", () => {
    const m = model(first(true), stF);
    const h = m.actors.find((x) => x.id === "agent:1")!;
    assert.equal(h.parent, "claude");
    // The launch's own step, directly after the request stop.
    assert.equal(m.stops[idx(m, h.startId) - 1]!.id, "req-q1");
    assert.ok(m.stops[idx(m, h.startId)]!.id.startsWith("start-") && m.stops[idx(m, h.startId)]!.lane === "claude");
    assert.ok(idx(m, h.startId) < m.stops.findIndex((s) => s.lane === "agent:1"));
  });
  it("with no prompt at all the launch is still owned by a stop (the request stop of its text-less request, else Start), never a plain line", () => {
    const o = [bg("l1", 2, true), c("h1", 3, agent("ag1", "l1"), [W + "x.txt"]), wakePrompt("s1", { toolUseId: "l1" }, 5), stop("s1")];
    const m = model(o, changed("x.txt", "x", "h1", 2));
    // The launch's own step on Claude's lane, which follows the text-less request's stop when there is one.
    const s = m.stops.findIndex((x) => x.id === m.actors.find((a) => a.id === "agent:1")!.startId);
    assert.ok(s >= 0 && m.stops[s]!.id.startsWith("start-") && m.stops[s]!.lane === "claude");
    assert.ok(s === 0 || m.stops[s - 1]!.id === "req-r001");
  });
  it("a foreground helper launched first leaves from the request that owns the launch, not a plain line", () => {
    const m = model(first(false), stF);
    // The launch's own step, directly after the request that owns the launch.
    const s = idx(m, m.actors.find((x) => x.id === "agent:1")!.startId);
    assert.ok(m.stops[s]!.id.startsWith("start-") && m.stops[s]!.lane === "claude");
    assert.equal(m.stops[s - 1]!.id, "req-q1");
  });
  it("a background helper launched by a helper branches from the parent's last stop at or before that launch", () => {
    const o = [
      prompt("s1", ["Ask A."], stamp(1)), bg("l1", 2, true),
      c("p1", 3, agent("ag1", "l1"), [W + "p.txt"]),
      c("l2", 4, { ...agent("ag1", "l1"), background: true }, [], "Agent"),
      c("p2", 5, agent("ag1", "l1"), [W + "q.txt"]),
      c("k1", 6, agent("ag2", "l2"), [W + "k.txt"]),
      wakePrompt("s1", { toolUseId: "l2" }, 7), wakePrompt("s1", { toolUseId: "l1" }, 8), stop("s1"),
    ];
    const m = model(o, [...changed("p.txt", "p", "p1", 2), ...changed("q.txt", "q", "p2", 3), ...changed("k.txt", "k", "k1", 4)]);
    const child = m.actors.find((x) => x.id === "agent:2")!;
    assert.equal(child.parent, "agent:1");
    // The parent's own launch step (on the parent's lane), directly after p.txt; never Claude's launch step or the request.
    const s = idx(m, child.startId);
    assert.ok(m.stops[s]!.id.startsWith("start-") && m.stops[s]!.lane === "agent:1");
    assert.equal(m.stops[s - 1]!.change?.file, "p.txt");
  });
});
