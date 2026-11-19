import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// A step id names the same step in every later answer. A call that started earlier but is recorded later (parallel helpers where
// the shorter one lands first) must not renumber the start-/msg-/finish-/wake-/reply- steps already on the page. Shapes follow the earlier stop-model fixture.

const W = "/w/";
let nextId = 1000;
const finish = (agentId: string, agentType: string, seq: number, at: number, text: string): RawOp => ({ id: ++nextId, tool: "hook", intent: "helper finished", args_json: JSON.stringify({ hookAdapter: 1, hookEvent: "SubagentStop", host: "claude", session_id: "s1", agent_id: agentId, agent_type: agentType, at, seq, finish: { text } }) });
const agent = (id: string, type: string, launch: string) => ({ agent_id: id, agent_type: type, launch_tool_use_id: launch });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit", at = seq * 10) => call(id, { session: "s1", tool, desc: id, at, named, extra: { startSeq: seq, ...extra } });
const msg = (id: string, seq: number, fields: Record<string, string>, at = seq * 10) => c(id, seq, { toolLabel: { fields } }, [], "SendMessage", at);
const launch = (id: string, desc: string, seq: number, at = seq * 10) => c(id, seq, { toolLabel: { fields: { subagent_type: "general-purpose", description: desc } } }, [], "Agent", at);
const stopAt = (text: string, at: number): RawOp => { const o = stop("s1", text); return { ...o, args_json: JSON.stringify({ ...JSON.parse(o.args_json as string), at }) }; };
const input = (ops: RawOp[], fileStates: RawState[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[]) => buildRailModel(buildTimeline(input(ops, fileStates)));
const idsOf = (ops: RawOp[], fileStates: RawState[]) => new Map(model(ops, fileStates).stops.map((s) => [s.id, `${s.head} | ${JSON.stringify(s.card ?? null)}`]));

const base: RawOp[] = [
  prompt("s1", ["Make the charts and the memo."], { requests: [{ seq: 1, at: 10, firstStep: null }] }),
  launch("LC", "Build the charts", 20),
  launch("LM", "Write the memo", 30),
  c("hc", 40, agent("agc", "charts-deck", "LC"), [W + "charts.xlsx"]),
  c("hm", 50, agent("agm", "memo-writer", "LM"), [W + "memo.docx"]),
  finish("agc", "charts-deck", 60, 600, "Charts are in charts.xlsx."),
  stopAt("Charts done, memo still running.", 700),
  msg("S1", 80, { to: "memo-writer", summary: "use the new chart", message: "Rewrite the memo around the new chart." }, 800),
  wakePrompt("s1", { toolUseId: "LM", summary: 'Agent "Write the memo" finished' }, 2, 900),
  stopAt("Both done.", 1000),
];
const states: RawState[] = [
  state(W + "charts.xlsx", "c0", null, { step: 1 }), state(W + "charts.xlsx", "c1", "c0", { open: ["hc"], credited: ["hc"], step: 2 }),
  state(W + "memo.docx", "m0", null, { step: 1 }), state(W + "memo.docx", "m1", "m0", { open: ["hm"], credited: ["hm"], step: 3 }),
];
// Recorded after the base, but every one of them happened before the steps above: a shorter helper that landed first, its message, its finish, its wake, its reply.
const late: RawOp[] = [
  launch("LX", "Fetch CPI", 15, 150),
  msg("S0", 16, { to: "memo-writer", message: "An earlier note." }, 160),
  finish("agx", "general-purpose", 17, 170, "CPI fetched."),
  wakePrompt("s1", { toolUseId: "LX", summary: 'Agent "Fetch CPI" finished' }, 3, 180),
  stopAt("An earlier turn ended.", 190),
];

describe("a step id names the same step in every later answer", () => {
  it("steps recorded later but earlier in time leave every id already shown on the same step", () => {
    const before = idsOf(base, states), after = idsOf([...base, ...late], states);
    const kinds = new Set([...before.keys()].map((k) => k.split("-")[0]));
    for (const k of ["start", "msg", "finish", "wake", "reply"]) assert.ok(kinds.has(k), `the base holds a ${k}- step: ${[...before.keys()].join(",")}`);
    for (const [id, head] of before) assert.equal(after.get(id), head, `${id} still names "${head}" (now: ${after.get(id)})`);
    assert.ok(after.size > before.size, "the late steps were added");
  });

  it("two steps never share an id", () => {
    const ids = model([...base, ...late], states).stops.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("the parallel-helper case of the review: the later-started helper recorded first, the earlier one later", () => {
    const p = prompt("s1", ["Build."], { requests: [{ seq: 1, at: 10, firstStep: null }] });
    const B = launch("B", "Fetch CPI", 3), A = launch("A", "Fetch UNRATE", 2);
    const one = idsOf([p, B], []), two = idsOf([p, B, A], []);
    for (const [id, head] of one) assert.equal(two.get(id), head);
  });

  // Two helpers that change no file: each gets an "at work" step (idle-). The earlier-started one is recorded second.
  const quiet = (id: string, agentId: string, launchId: string, at: number): RawOp => c(id, at / 10, agent(agentId, "general-purpose", launchId), [], "Read", at);
  const idleOps = (which: "B" | "A"): RawOp[] => which === "B"
    ? [launch("LB", "Check CPI", 30), quiet("rB", "agB", "LB", 31), wakePrompt("s1", { toolUseId: "LB", summary: 'Agent "Check CPI" finished' }, 3, 60)]
    : [launch("LA", "Check UNRATE", 20), quiet("rA", "agA", "LA", 21), wakePrompt("s1", { toolUseId: "LA", summary: 'Agent "Check UNRATE" finished' }, 2, 50)];
  const lead = prompt("s1", ["Check."], { requests: [{ seq: 1, at: 10, firstStep: null }] });

  it("idle- steps are keyed by the agent, so an earlier-started helper recorded later takes none of their ids", () => {
    const one = model([lead, ...idleOps("B")], []), two = model([lead, ...idleOps("B"), ...idleOps("A")], []);
    const idles = one.stops.filter((x) => x.id.startsWith("idle-"));
    assert.ok(idles.length > 0, `the first answer holds an idle- step: ${one.stops.map((x) => x.id).join(",")}`);
    // The visible "Helper n" is order-numbered and may change (see the probe below); the id names the agent, so it must not.
    const norm = (t: string) => t.replace(/Helper \d+/g, "Helper N");
    const after = new Map(two.stops.map((x) => [x.id, norm(`${x.head} | ${JSON.stringify(x.card ?? null)}`)]));
    for (const x of one.stops) assert.equal(after.get(x.id), norm(`${x.head} | ${JSON.stringify(x.card ?? null)}`), `${x.id} still names the same step`);
    assert.deepEqual(idles.map((x) => x.id), ["idle-s1:agB"], "the id carries the agent, not a lane number");
    assert.ok(two.stops.some((x) => x.id === "idle-s1:agA") && two.stops.some((x) => x.id === "idle-s1:agB"));
    assert.equal(new Set(two.stops.map((x) => x.id)).size, two.stops.length);
  });

  it("probe: what a visible label does when the earlier helper is recorded later", () => {
    const one = model([lead, ...idleOps("B")], []), two = model([lead, ...idleOps("B"), ...idleOps("A")], []);
    const names = (m: ReturnType<typeof model>) => m.stops.map((x) => `${x.id}=${x.label}`).join(" ; ");
    console.log("LABELS1:", names(one));
    console.log("LABELS2:", names(two));
  });
});
