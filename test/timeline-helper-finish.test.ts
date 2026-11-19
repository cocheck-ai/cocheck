import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRuns } from "../src/timeline/runs.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { HELPER_LANE, MAIN_LANE } from "../src/timeline/attribution.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// a recipient named by agent type or agent id reads as its helper ("Helper 2"), so these labels name the helper.
// a helper's SubagentStop op reads as a finish, every turn's reply is kept, and a SendMessage's words show both ways.
// Shapes follow a recorded run: named teammates (charts-deck, memo-writer) fire no notification prompt; Claude sends memo-writer an instruction
// before it rewrites the memo; the memo writer reports back by SendMessage.

const W = "/w/";
let nextId = 1000;
const finish = (agentId: string, agentType: string, seq: number, at: number, text?: string): RawOp => ({
  id: ++nextId,
  tool: "hook",
  intent: "helper finished",
  args_json: JSON.stringify({ hookAdapter: 1, hookEvent: "SubagentStop", host: "claude", session_id: "s1", agent_id: agentId, agent_type: agentType, at, seq, finish: text === undefined ? {} : { text } }),
});
const agent = (id: string, type: string, launch: string) => ({ agent_id: id, agent_type: type, launch_tool_use_id: launch });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit") => call(id, { session: "s1", tool, desc: id, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
const msg = (id: string, seq: number, fields: Record<string, string>, extra: Record<string, unknown> = {}) => c(id, seq, { toolLabel: { fields }, ...extra }, [], "SendMessage");
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const timeline = (ops: RawOp[], fileStates: RawState[] = []) => buildTimeline(input(ops, fileStates));
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(timeline(ops, fileStates));

const ops = [
  prompt("s1", ["Make the charts and the memo."], stamp(1)),
  c("LC", 2, {}, [], "Agent"),
  c("LM", 3, {}, [], "Agent"),
  c("hc", 4, agent("agc", "charts-deck", "LC"), [W + "charts.xlsx"]),
  c("hm", 5, agent("agm", "memo-writer", "LM"), [W + "memo.docx"]),
  finish("agc", "charts-deck", 6, 60, "Charts are in charts.xlsx."),
  stop("s1", "Charts done, memo still running."),
  msg("S1", 8, { to: "memo-writer", summary: "use the new chart", message: "Rewrite the memo around the new chart.\nKeep it to one page." }),
  c("hm2", 9, agent("agm", "memo-writer", "LM"), [W + "memo.docx"]),
  msg("S2", 10, { to: "team-lead", message: "Memo rewritten." }, agent("agm", "memo-writer", "LM")),
  finish("agm", "memo-writer", 11, 110, "Memo rewritten and saved."),
  stop("s1", "Both done."),
];
const states: RawState[] = [
  state(W + "charts.xlsx", "c0", null, { step: 1 }),
  state(W + "charts.xlsx", "c1", "c0", { open: ["hc"], credited: ["hc"], step: 2 }),
  state(W + "memo.docx", "m0", null, { step: 1 }),
  state(W + "memo.docx", "m1", "m0", { open: ["hm"], credited: ["hm"], step: 3 }),
  state(W + "memo.docx", "m2", "m1", { open: ["hm2"], credited: ["hm2"], step: 4 }),
];

describe("the record", () => {
  it("the request owns both finishes, in order, and keeps both turns' replies", () => {
    const { requests } = buildRuns(ops, states);
    assert.equal(requests.length, 1);
    const r = requests[0]!;
    assert.deepEqual(r.finishes.map((f) => [f.agentId, f.agentType, f.text]), [["agc", "charts-deck", "Charts are in charts.xlsx."], ["agm", "memo-writer", "Memo rewritten and saved."]]);
    assert.deepEqual(r.replies.map((x) => x.closing.text), ["Charts done, memo still running.", "Both done."]);
    assert.equal(r.closing?.text, "Both done.");
  });
  it("the timeline carries the replies, the finishes and the messages with their words", () => {
    const t = timeline(ops, states);
    const r = t.requests[0]!;
    assert.deepEqual(r.replies!.map((x) => x.line.text), ["Charts done, memo still running.", "Both done."]);
    assert.deepEqual(r.finishes!.map((f) => [f.agentType, f.text?.text]), [["charts-deck", "Charts are in charts.xlsx."], ["memo-writer", "Memo rewritten and saved."]]);
    const sends = r.runs.flatMap((run) => run.calls).filter((x) => x.tool === "SendMessage");
    assert.deepEqual(sends.map((x) => x.send), [
      { to: "memo-writer", summary: "use the new chart", text: "Rewrite the memo around the new chart.\nKeep it to one page." },
      { to: "team-lead", summary: null, text: "Memo rewritten." },
    ]);
  });
  it("a SendMessage with no words in its label has no send", () => {
    const t = timeline([prompt("s1", ["Go."], stamp(1)), c("S0", 2, { toolLabel: { fields: {}, inputFields: ["to", "message"] } }, [], "SendMessage"), stop("s1", "ok")]);
    assert.equal(t.requests[0]!.runs.flatMap((run) => run.calls)[0]!.send, undefined);
  });
});

describe("the rail", () => {
  it("each helper's finish is a stop on Claude's line, with its last message", () => {
    const m = model(ops, states);
    const fin = m.stops.filter((s) => s.id.startsWith("finish-"));
    assert.deepEqual(fin.map((s) => s.head), ["Helper 1 finished: Charts are in charts.xlsx.", "Helper 2 finished: Memo rewritten and saved."]);
    assert.ok(fin.every((s) => s.lane === MAIN_LANE));
    assert.deepEqual(fin[1]!.card!.lines.map((l) => l.text), ["Memo rewritten and saved."]);
  });
  it("Claude's instruction shows as a stop before the memo rewrite, and the helper's report shows too", () => {
    const m = model(ops, states);
    const ids = m.stops.map((s) => s.id);
    const heads = m.stops.map((s) => s.head);
    const toMemo = m.stops.find((s) => s.label === "Message to Helper 2")!;
    assert.equal(toMemo.head, "Claude sent a message to Helper 2: use the new chart");
    assert.equal(toMemo.lane, MAIN_LANE);
    assert.deepEqual(toMemo.card!.lines.map((l) => l.text), ["use the new chart", "Rewrite the memo around the new chart.", "Keep it to one page."]);
    const back = m.stops.find((s) => s.label === "Message to team-lead")!;
    assert.equal(back.head, "Helper 2 sent a message to team-lead: Memo rewritten.");
    assert.ok(back.lane!.startsWith(HELPER_LANE), String(back.lane));
    const rewrites = ids.map((id, i) => (m.stops[i]!.change?.file === "memo.docx" ? i : -1)).filter((i) => i >= 0);
    assert.ok(rewrites.at(-1)! > ids.indexOf(toMemo.id), heads.join(" | "));
  });
  it("a helper whose notification also came reads as finished once, with the last message joined in", () => {
    const o = [
      prompt("s1", ["Check it."], stamp(1)),
      c("LA", 2, { background: true }, [], "Agent"),
      c("ha", 3, agent("aga", "general-purpose", "LA"), [W + "a.txt"]),
      finish("aga", "general-purpose", 4, 40, "A is checked."),
      wakePrompt("s1", { toolUseId: "LA", taskId: "aga", summary: "Agent A finished" }, 5),
      stop("s1", "done"),
    ];
    const s = [state(W + "a.txt", "a0", null, { step: 1 }), state(W + "a.txt", "a1", "a0", { open: ["ha"], credited: ["ha"], step: 2 })];
    const m = model(o, s);
    const fin = m.stops.filter((x) => x.label === "Helper 1 finished");
    assert.equal(fin.length, 1);
    assert.equal(fin[0]!.head, "Helper 1 finished");
    assert.deepEqual(fin[0]!.card!.lines.map((l) => l.text), ["Agent A finished", "A is checked."]);
  });
});
