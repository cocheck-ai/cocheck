import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { MAIN_LANE } from "../src/timeline/attribution.ts";
import { buildRailModel, plain } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// the conversation is complete on the rail. Every reply is a step on Claude's lane, a helper start is a step that names the helper,
// a SendMessage to an agent id reads as that helper, and message cards are plain text.

const W = "/w/";
const agent = (id: string, type: string, launch: string) => ({ agent_id: id, agent_type: type, launch_tool_use_id: launch });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit", desc = id) => call(id, { session: "s1", tool, desc, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(buildTimeline(input(ops, fileStates)));

// The fixture's stop carries time 0; a real Stop carries the time the turn ended.
const stopAt = (text: string, at: number): RawOp => {
  const o = stop("s1", text);
  return { ...o, args_json: JSON.stringify({ ...JSON.parse(o.args_json as string), at }) };
};
const ID = "a543acc90947c750d";
const ops = [
  prompt("s1", ["Build the deck."], { requests: [{ seq: 1, at: 10, firstStep: null }] }),
  c("LD", 2, { toolLabel: { fields: { description: "Build the deck", subagent_type: "general-purpose" } } }, [], "Agent", "Started a helper agent: Build the deck"),
  c("hd", 3, agent(ID, "general-purpose", "LD"), [W + "deck.pptx"]),
  c("S1", 4, { toolLabel: { fields: { to: ID, message: "## Plan\n**Use** the `blue` theme and [the brief](http://x.y)." } } }, [], "SendMessage"),
  stopAt("This deck has only **8** slides.", 100),
];
const states: RawState[] = [state(W + "deck.pptx", "d0", null, { step: 1 }), state(W + "deck.pptx", "d1", "d0", { open: ["hd"], credited: ["hd"], step: 2 })];

describe("the conversation on the rail", () => {
  it("a recorded reply is a message step on Claude's lane after its turn's calls, with no verdict", () => {
    const m = model(ops, states);
    const reply = m.stops.find((s) => s.id.startsWith("reply-"))!;
    assert.ok(reply, m.stops.map((s) => s.id).join(","));
    assert.equal(reply.lane, MAIN_LANE);
    assert.deepEqual(reply.message!.lines, ["This deck has only 8 slides."]);
    assert.equal(reply.message!.toName, "you");
    assert.equal(reply.change, undefined);
    assert.ok(m.stops.indexOf(reply) > m.stops.findIndex((s) => s.id.startsWith("msg-")));
  });
  it("starting a helper is a step that names the helper", () => {
    const m = model(ops, states);
    const start = m.stops.find((s) => s.id.startsWith("start-"))!;
    assert.equal(start.head, "Started Helper 1 to build the deck");
    assert.equal(start.lane, MAIN_LANE);
    assert.ok(m.stops.indexOf(start) < m.stops.findIndex((s) => s.change));
  });
  it("a SendMessage to an agent id reads as the helper, never the id", () => {
    const m = model(ops, states);
    const msg = m.stops.find((s) => s.id.startsWith("msg-"))!;
    assert.equal(msg.label, "Message to Helper 1");
    assert.equal(msg.message!.toName, "Helper 1");
    assert.ok(!JSON.stringify(msg).includes(ID));
  });
  it("an id that matches no helper reads as a helper", () => {
    const o = [prompt("s1", ["Go."], { requests: [{ seq: 1, at: 10, firstStep: null }] }), c("S1", 2, { toolLabel: { fields: { to: ID, message: "hi" } } }, [], "SendMessage"), stop("s1", "ok")];
    const msg = model(o).stops.find((s) => s.id.startsWith("msg-"))!;
    assert.equal(msg.label, "Message to a helper");
  });
  it("message cards carry plain text", () => {
    const m = model(ops, states);
    assert.deepEqual(m.stops.find((s) => s.id.startsWith("msg-"))!.message!.lines, ["Plan", "Use the blue theme and the brief."]);
  });
  it("plain drops markdown syntax and keeps the words", () => {
    assert.equal(plain("### Title"), "Title");
    assert.equal(plain("* item with *emphasis* and __bold__"), "- item with emphasis and bold");
    assert.equal(plain("snake_case_name stays, 2 * 3 stays"), "snake_case_name stays, 2 * 3 stays");
  });
});
