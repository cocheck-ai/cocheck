import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// every file stop links to the call that wrote it, on a helper's lane as on Claude's, and the words a helper said just before the
// call are that call's line.

const W = "/w/";
const agent = (id: string, launch: string) => ({ agent_id: id, agent_type: "general-purpose", launch_tool_use_id: launch });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Bash", said?: string) => call(id, { session: "s1", tool, desc: id, at: seq * 10, named, said, extra: { startSeq: seq, ...extra } });
const input = (ops: RawOp[], fileStates: RawState[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[]) => buildRailModel(buildTimeline(input(ops, fileStates)));

const ops = [
  prompt("s1", ["Write the memo."], { requests: [{ seq: 1, at: 10, firstStep: null }] }),
  c("L1", 2, { background: true }, [], "Agent"),
  c("h1", 3, agent("ag1", "L1"), [W + "memo.txt"], "Bash", "Writing the memo now. Then the check."),
  c("h2", 4, agent("ag1", "L1"), [W + "memo.txt"], "Bash", "Fixing paragraph 14."),
  c("m1", 5, {}, [W + "main.txt"], "Bash", "Saving the main file."),
  stop("s1", "done"),
];
const states = [
  state(W + "memo.txt", "m0", null, { step: 1 }),
  state(W + "memo.txt", "m1", "m0", { open: ["h1"], credited: ["h1"], step: 2 }),
  state(W + "memo.txt", "m2", "m1", { open: ["h2"], credited: ["h2"], step: 3 }),
  state(W + "main.txt", "x0", null, { step: 1 }),
  state(W + "main.txt", "x1", "x0", { open: ["m1"], credited: ["m1"], step: 4 }),
];

describe("file stops link to their call", () => {
  it("a lone file stop on a helper's lane carries its call, whose line is the helper's words", () => {
    const m = model(ops, states);
    const files = m.stops.filter((s) => s.change);
    assert.equal(files.length, 3);
    assert.ok(files.every((s) => s.call !== undefined), JSON.stringify(files.map((s) => [s.id, s.lane, s.call])));
    const memo = files.filter((s) => (s.lane ?? "").startsWith("agent:"));
    assert.equal(memo.length, 2);
    assert.deepEqual(memo.map((s) => s.call!.text), ["Writing the memo now.", "Fixing paragraph 14."]);
    assert.equal(files.find((s) => s.lane === "claude")!.call!.text, "Saving the main file.");
  });
});
