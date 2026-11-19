import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// "Helper N" is the Nth helper launched in the task, not the Nth to appear. A recorded run showed the first helper launched as "Helper 2"
// because the numbers were handed out in the order events were walked (the first helper to change a file).

const W = "/w/";
const agent = (id: string, launch: string) => ({ agent_id: id, agent_type: "general-purpose", launch_tool_use_id: launch });
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit") =>
  call(id, { session: "s1", tool, desc: id, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
const launch = (id: string, seq: number) => c(id, seq, { background: true }, [], "Agent");
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(buildTimeline(input(ops, fileStates)));
const changed = (file: string, sha: string, by: string, step: number) => [state(W + file, sha + "0", null, { step: 1 }), state(W + file, sha + "1", sha + "0", { open: [by], credited: [by], step })];
const send = (id: string, seq: number, to: string) => call(id, { session: "s1", tool: "SendMessage", desc: id, at: seq * 10, input: { to }, extra: { startSeq: seq } });
const wake = (launcher: string, taskId: string, seq: number) => wakePrompt("s1", { toolUseId: launcher, taskId, summary: `Agent ${taskId} finished` }, seq);
const names = (m: ReturnType<typeof model>) => m.actors.filter((a) => a.id.startsWith("agent:")).map((a) => `${a.id}=${a.name}`).sort();

describe("helper numbers follow launch order", () => {
  // Helper launched second (ag2) changes its file first; the first launched (ag1) finishes later.
  const reverse = [
    prompt("s1", ["Go."], stamp(1)),
    launch("l1", 2),
    launch("l2", 3),
    c("e2", 4, agent("ag2", "l2"), [W + "x.txt"]),
    c("e1", 5, agent("ag1", "l1"), [W + "y.txt"]),
    wakePrompt("s1", { toolUseId: "l2" }, 20),
    wakePrompt("s1", { toolUseId: "l1" }, 21),
    stop("s1"),
  ];
  const states = [...changed("x.txt", "x", "e2", 2), ...changed("y.txt", "y", "e1", 3)];

  it("two helpers finishing in reverse order: the first launched is Helper 1 on every surface", () => {
    const m = model(reverse, states);
    const heads = m.stops.map((s) => s.head);
    assert.ok(heads.some((h) => h.startsWith("Started Helper 1")), heads.join(" | "));
    const first = m.stops.findIndex((s) => s.head.startsWith("Started Helper 1"));
    const second = m.stops.findIndex((s) => s.head.startsWith("Started Helper 2"));
    assert.ok(first >= 0 && second > first, heads.join(" | "));
    // Helper 1 is ag1 (launched by l1): it finishes after Helper 2.
    const fin1 = m.stops.findIndex((s) => s.head.startsWith("Helper 1 finished"));
    const fin2 = m.stops.findIndex((s) => s.head.startsWith("Helper 2 finished"));
    assert.ok(fin2 >= 0 && fin1 > fin2, heads.join(" | "));
    assert.deepEqual(names(m), ["agent:1=Helper 1", "agent:2=Helper 2"]);
  });

  it("a resumed helper keeps its original number, even when another helper was numbered in between", () => {
    const ops = [
      prompt("s1", ["Go."], stamp(1)),
      launch("l1", 2),
      launch("l2", 3),
      c("e2", 4, agent("ag2", "l2"), [W + "x.txt"]),
      wake("l2", "ag2", 5),
      c("e1", 6, agent("ag1", "l1"), [W + "y.txt"]),
      wake("l1", "ag1", 7),
      prompt("s1", ["Again."], stamp(8)),
      send("S1", 9, "ag1"),
      c("e1b", 10, agent("ag1", "l1"), [W + "y.txt"]),
      wake("S1", "ag1", 11),
      stop("s1"),
    ];
    const m = model(ops, [...changed("x.txt", "x", "e2", 2), ...changed("y.txt", "y", "e1", 3), state(W + "y.txt", "y2", "y1", { open: ["e1b"], credited: ["e1b"], step: 4 })]);
    const lanes = m.actors.filter((a) => a.id.startsWith("agent:"));
    assert.deepEqual([...new Set(lanes.map((a) => a.name))].sort(), ["Helper 1", "Helper 2"], JSON.stringify(lanes.map((a) => [a.id, a.name])));
    assert.ok(lanes.filter((a) => a.name === "Helper 1").length >= 2, "the resumed line shares the number");
  });

  it("a helper with no recorded launch call is numbered after every launched one", () => {
    const ops = [
      prompt("s1", ["Go."], stamp(1)),
      c("e9", 2, agent("ag9", "gone"), [W + "z.txt"]),
      launch("l1", 3),
      c("e1", 4, agent("ag1", "l1"), [W + "y.txt"]),
      wakePrompt("s1", { toolUseId: "l1" }, 20),
      stop("s1"),
    ];
    const m = model(ops, [...changed("z.txt", "z", "e9", 2), ...changed("y.txt", "y", "e1", 3)]);
    const byName = Object.fromEntries(m.actors.filter((a) => a.id.startsWith("agent:")).map((a) => [a.id, a.name]));
    assert.equal(Object.keys(byName).length, 2);
    const ag1 = m.stops.find((s) => s.head.startsWith("Started Helper"))!;
    assert.ok(ag1.head.startsWith("Started Helper 1"), ag1.head);
    // the unlaunched helper (e9) is Helper 2, the launched one (e1) Helper 1
    const heads = m.stops.map((s) => s.head).join(" | ");
    assert.ok(heads.includes("Helper 2 changed z.txt") && heads.includes("Helper 1 changed y.txt"), heads);
  });
});
