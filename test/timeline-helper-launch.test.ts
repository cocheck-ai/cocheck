import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { MAIN_LANE } from "../src/timeline/attribution.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { isLauncherTool, isWaitTool, launcherMayCredit } from "../src/credit-guard.ts";
import { translateTool } from "../src/timeline/describe.ts";
import { state } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// a launch on Copilot (`task`) and Codex (`collaborationspawn_agent`) is a launch point on the spawner's lane and a "Started a helper
// agent" step with its own description. Fixtures are the real ops of recorded Copilot and Codex runs, paths made generic.

const load = (f: string): RawOp[] => (JSON.parse(readFileSync(new URL(`./fixtures/helper-launch/${f}`, import.meta.url), "utf8")) as RawOp[]).map((o) => ({ id: o.id, tool: o.tool, intent: o.intent, args_json: o.args_json }));
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(buildTimeline(input(ops, fileStates)));

describe("launcher predicate", () => {
  it("accepts Agent, Task, task and every recorded form of spawn_agent", () => {
    for (const t of ["Agent", "Task", "task", "spawn_agent", "collaborationspawn_agent", "collaboration.spawn_agent", "collaboration:spawn_agent", "collaboration/spawn_agent"]) assert.equal(isLauncherTool(t), true, t);
  });
  it("never accepts a wait, a read or a task-named non-launcher", () => {
    for (const t of ["TaskCreate", "TaskUpdate", "TaskStop", "TaskOutput", "TodoWrite", "read_agent", "wait_agent", "collaborationwait_agent", "collaboration.wait_agent", "list_agents", "close_agent", "send_input", "SendMessage", "subtask", "task_complete", "spawn_agent_status", "Bash", "", null, undefined]) assert.equal(isLauncherTool(t), false, String(t));
    assert.equal(isWaitTool("collaborationwait_agent"), true);
    assert.equal(launcherMayCredit("collaborationwait_agent", true), true);
    assert.equal(launcherMayCredit("TaskCreate", true), true);
    assert.equal(launcherMayCredit("collaborationspawn_agent", true), false);
  });
});

describe("Copilot task launches", () => {
  // Each helper's own call (ids as recorded) is credited with the file it wrote.
  const memoCall = "copilot-9ee7c215-0b86-41e9-a2fa-16e3b6ef5f72-14";
  const deckCall = "copilot-9ee7c215-0b86-41e9-a2fa-16e3b6ef5f72-16";
  const m = model(load("copilot-task.json"), [
    state("/w/memo.docx", "m0", null, { step: 1 }), state("/w/memo.docx", "m1", "m0", { open: [memoCall], credited: [memoCall], step: 2 }),
    state("/w/deck.pptx", "d0", null, { step: 3 }), state("/w/deck.pptx", "d1", "d0", { open: [deckCall], credited: [deckCall], step: 4 }),
  ]);
  it("each launch is a start step with its own description, on the spawner's lane", () => {
    const starts = m.stops.filter((s) => s.id.startsWith("start-"));
    const heads = starts.map((s) => s.head).sort((a, b) => a.replace(/^Started Helper \d /, "").localeCompare(b.replace(/^Started Helper \d /, "")));
    assert.equal(heads.length, 2, m.stops.map((s) => s.id).join(","));
    assert.match(heads[0]!, /^Started Helper \d to create stability deck$/);
    assert.match(heads[1]!, /^Started Helper \d to write stability memo$/);
    for (const s of starts) {
      assert.equal(s.lane, MAIN_LANE);
      assert.ok(!/subagent|I.ll have/.test(JSON.stringify(s)), "no main-agent narration");
    }
  });
  it("the helper lanes start at the launch", () => {
    const helpers = m.actors.filter((l) => l.parent != null);
    assert.equal(helpers.length, 2, JSON.stringify(m.actors.map((l) => [l.id, l.parent])));
    for (const l of helpers) assert.ok(l.startId != null && l.startId.startsWith("start-"), `lane ${l.id} starts at ${l.startId}`);
  });
});

describe("Codex spawn_agent launches", () => {
  const m = model(load("codex-spawn.json"));
  const starts = m.stops.filter((s) => s.id.startsWith("start-"));
  it("each spawn is a start step on the spawner's lane, never the main agent's narration", () => {
    assert.equal(starts.length, 2, m.stops.map((s) => s.id).join(","));
    for (const s of starts) {
      assert.equal(s.lane, MAIN_LANE);
      assert.match(s.head, /^Started /);
      assert.ok(!/Great, now|subagents/.test(JSON.stringify(s)), s.head);
    }
  });
  it("wait_agent is never a launch", () => {
    assert.equal(starts.length, 2);
    assert.ok(!m.stops.some((s) => s.id.startsWith("start-") && /wait/i.test(s.head)));
  });
});

describe("a launch's plain sentence comes from its own input", () => {
  it("names the description, task name or type of any launcher, and nothing else", () => {
    assert.equal(translateTool("task", { description: "Write stability memo", prompt: "p" }), "Started a helper agent: Write stability memo");
    assert.equal(translateTool("collaborationspawn_agent", { task_name: "memo" }), "Started a helper agent: memo");
    assert.equal(translateTool("collaborationspawn_agent", {}), "Started a helper agent");
    assert.equal(translateTool("Agent", { subagent_type: "general-purpose" }), "Started a helper agent (general-purpose)");
  });
  it("a non-launcher whose name holds task or agent is not described as a launch", () => {
    for (const tool of ["TaskCreate", "read_agent", "wait_agent", "collaborationwait_agent"]) assert.ok(!/Started a helper/.test(translateTool(tool, { description: "x" })), tool);
  });
});
