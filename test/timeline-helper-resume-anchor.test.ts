import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// recorded-run shape. Claude launches Helper 1 and Helper 2 with descriptions; both finish; Claude then sends Helper 1 a message (the
// SendMessage stop), and Helper 2's second run finishes (a wake) before Helper 1 writes again. Helper 1's resumed line leaves from the
// SendMessage stop on Claude's lane, never from an earlier stop or from the other helper's finish.

const W = "/w/";
const agent = (id: string, launch: string) => ({ agent_id: id, agent_type: "general-purpose", launch_tool_use_id: launch });
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit", desc = id) => call(id, { session: "s1", tool, desc, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
// The real launch shape: the line is the bare intent (the description wins), and the args carry the description and a tool label.
const launch = (id: string, seq: number, what: string) => c(id, seq, { background: true, description: what, toolLabel: { fields: { description: what, subagent_type: "general-purpose" } } }, [], "Agent", what);
const send = (id: string, seq: number, to: string, message: string) => c(id, seq, { toolLabel: { fields: { to, message } } }, [], "SendMessage");
const input = (ops: RawOp[], fileStates: RawState[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[]) => buildRailModel(buildTimeline(input(ops, fileStates)));
const changed = (file: string, sha: string, by: string, step: number) => [state(W + file, sha + "0", null, { step: 1 }), state(W + file, sha + "1", sha + "0", { open: [by], credited: [by], step })];
const wake = (launcher: string, taskId: string, seq: number) => wakePrompt("s1", { toolUseId: launcher, taskId, summary: `Agent ${taskId} finished` }, seq);

const ops = [
  prompt("s1", ["Build the memo and the deck."], stamp(1)),
  launch("L1", 2, "Write one-page Word memo"),
  launch("L2", 3, "Build pptx deck with charts"),
  c("h1", 4, agent("ag1", "L1"), [W + "memo.txt"]),
  c("h2", 5, agent("ag2", "L2"), [W + "deck.txt"]),
  wake("L1", "ag1", 6),
  wake("L2", "ag2", 7),
  prompt("s1", ["Fix both."], stamp(8)),
  send("S1", 9, "ag1", "Fix the memo numbers."),
  send("S2", 10, "ag2", "Fix the deck numbers."),
  c("h1b", 12, agent("ag1", "L1"), [W + "memo.txt"]),
  c("h2b", 11, agent("ag2", "L2"), [W + "deck.txt"]),
  wake("S2", "ag2", 11.5),
  wake("S1", "ag1", 13),
  stop("s1", "done"),
];
const states = [
  ...changed("memo.txt", "m", "h1", 2),
  ...changed("deck.txt", "d", "h2", 3),
  state(W + "memo.txt", "m2", "m1", { open: ["h1b"], credited: ["h1b"], step: 4 }),
  state(W + "deck.txt", "d2", "d1", { open: ["h2b"], credited: ["h2b"], step: 5 }),
];

describe("a resumed helper starts at the message that woke it", () => {
  it("the resumed line leaves from its own SendMessage stop", () => {
    const m = model(ops, states);
    const ids = m.stops.map((s) => s.id);
    const r1 = m.actors.find((a) => a.id === "agent:1r1")!;
    const r2 = m.actors.find((a) => a.id === "agent:2r1")!;
    assert.ok(r1 && r2, JSON.stringify(m.actors.map((a) => a.id)) + ids.join(","));
    const msgTo = (name: string) => m.stops.find((s) => s.id.startsWith("msg-") && s.label === `Message to ${name}`)!.id;
    assert.equal(r1.startId, msgTo("Helper 1"), ids.join(","));
    assert.equal(r2.startId, msgTo("Helper 2"), ids.join(","));
  });
  it("a start step names its purpose when the launch carries a description", () => {
    const m = model(ops, states);
    assert.deepEqual(m.stops.filter((s) => s.id.startsWith("start-")).map((s) => s.head), ["Started Helper 1 to write one-page Word memo", "Started Helper 2 to build pptx deck with charts"]);
  });
  it("an Agent launch with no description reads \"Started Helper N\" and has no purpose", () => {
    const bare = [
      prompt("s1", ["Go."], stamp(1)),
      c("L1", 2, { background: true }, [], "Agent", ""),
      c("h1", 3, agent("ag1", "L1"), [W + "memo.txt"]),
      stop("s1", "done"),
    ];
    const t = buildTimeline(input(bare, changed("memo.txt", "m", "h1", 2)));
    const launchCall = t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls)).find((x) => x.id === "L1")!;
    assert.equal(launchCall.purpose, undefined);
    assert.deepEqual(buildRailModel(t).stops.filter((x) => x.id.startsWith("start-")).map((x) => x.head), ["Started Helper 1"]);
  });
  it("a Bash call with a description field has no purpose", () => {
    const bash = [prompt("s1", ["Go."], stamp(1)), c("b1", 2, {}, [], "Bash", "list the files"), stop("s1", "done")];
    const t = buildTimeline(input(bash, []));
    const b1 = t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls)).find((x) => x.id === "b1")!;
    assert.equal(b1.purpose, undefined);
  });
});
