// Codex reports a namespaced tool with the namespace joined onto its name (`collaborationsend_message`); its session log keeps them apart
// (`"name":"send_message","namespace":"collaboration"`). The Codex profile separates them once, at ingest and when stored records are read, so
// every rule keyed on the tool's own name applies: send_message never writes and reads as a sent message, like Claude's SendMessage.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/normalize.ts";
import { toolNeverWrites } from "../src/credit-guard.ts";
import { translateTool } from "../src/timeline/describe.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { RawOp } from "../src/timeline/runs.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

const pre = (tool_name: string, extra: Record<string, unknown> = {}) =>
  normalize("codex", { session_id: "s", cwd: "/w", hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: "call_1", ...extra });

describe("Codex tool identity", () => {
  it("the joined name is split at ingest: the tool's own name is kept", () => {
    assert.equal(pre("collaborationsend_message").toolName, "send_message");
    assert.equal(pre("collaborationspawn_agent").toolName, "spawn_agent");
    assert.equal(pre("collaborationwait_agent").toolName, "wait_agent");
    assert.equal(pre("collaborationlist_agents").toolName, "list_agents");
  });
  it("a payload that names the namespace is split by it", () => {
    assert.equal(pre("toolboxdo_thing", { tool_namespace: "toolbox" }).toolName, "do_thing");
    assert.equal(pre("do_thing", { tool_namespace: "toolbox" }).toolName, "do_thing");
  });
  it("other names are left as they are, and other hosts are never touched", () => {
    for (const t of ["Bash", "apply_patch", "mcp__github__get_file_contents", "collaboration", "Read"]) assert.equal(pre(t).toolName, t);
    assert.equal(normalize("claude", { session_id: "s", cwd: "/w", hook_event_name: "PreToolUse", tool_name: "collaborationsend_message", tool_input: {}, tool_use_id: "x" }).toolName, "collaborationsend_message");
  });
  it("send_message never writes and reads as a sent message, like SendMessage", () => {
    assert.equal(toolNeverWrites(pre("collaborationsend_message").toolName), true);
    assert.equal(toolNeverWrites("SendMessage"), true);
    assert.equal(translateTool(pre("collaborationsend_message").toolName, { target: "/root/deck", message: "go" }), "Sent a message");
  });
  it("a stored record with the joined name is read by the tool's own name (a launch is still a launch)", () => {
    const ops: RawOp[] = [
      prompt("s1", ["Go."], { requests: [{ seq: 1, at: 10, firstStep: null }] }),
      call("A1", { session: "s1", host: "codex", tool: "collaborationspawn_agent", at: 20, named: [], extra: { startSeq: 2, toolLabel: { fields: { task_name: "recipe" } } } }),
      call("M1", { session: "s1", host: "codex", tool: "collaborationsend_message", at: 30, named: [], extra: { startSeq: 3 } }),
      stop("s1", "done"),
    ];
    const input = { taskId: 1, build: "t", ops, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false } as unknown as TimelineInput;
    const t = buildTimeline(input);
    const calls = t.requests.flatMap((r) => r.runs).flatMap((r) => r.calls);
    assert.deepEqual(calls.map((c) => c.tool).sort(), ["send_message", "spawn_agent"]);
    assert.ok(buildRailModel(t).stops.some((s) => s.id.startsWith("start-")), "the launch has its start step");
  });
});
