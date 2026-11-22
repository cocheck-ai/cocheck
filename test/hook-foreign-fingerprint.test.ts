// The payloads a Copilot-started run of another host's registration carries are matched by shape; near-misses are not.
// `oldDetector` is the rule as it was first written, kept here as the oracle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { runsOtherHostsHook } from "../src/hosts/index.ts";

const copilotRunsOtherHostsHook = (payload: unknown): boolean => runsOtherHostsHook("claude", payload);

const oldDetector = (payload: unknown): boolean => {
  if (payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return p.timestamp !== undefined && typeof p.hook_event_name === "string" && p.permission_mode === undefined && p.tool_use_id === undefined && p.turn_id === undefined;
};

const root = path.resolve(import.meta.dirname, "..", "platforms");
const lines = (file: string): any[] => readFileSync(path.join(root, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pascal = lines("copilot-cli/versions/1.0.98/hook-calls-pascal.jsonl").map((r) => r.stdin as Record<string, unknown>);
const camel = lines("copilot-cli/versions/1.0.98/hook-calls-camel.jsonl").map((r) => r.stdin as Record<string, unknown>);
const claude = lines("claude-code/versions/2.1.302/payloads.jsonl").map((r) => JSON.parse(r.stdin) as Record<string, unknown>);

describe("foreign-hook fingerprint", () => {
  it("every PascalCase 1.0.98 line (a run of another host's hook that Copilot started) matches", () => {
    const named = pascal.filter((p) => typeof p.hook_event_name === "string");
    assert.ok(named.length > 10);
    for (const p of named) assert.equal(copilotRunsOtherHostsHook(p), true, String(p.hook_event_name));
    // a line of the recording that names no event is not the other host's shape, as before
    for (const p of pascal.filter((x) => typeof x.hook_event_name !== "string")) assert.equal(copilotRunsOtherHostsHook(p), oldDetector(p));
  });
  it("every Claude Code 2.1.302 line is not matched", () => {
    assert.ok(claude.length > 0);
    for (const p of claude) assert.equal(copilotRunsOtherHostsHook(p), false, String(p.hook_event_name));
  });
  it("camelCase 1.0.98 lines (no hook_event_name) are not matched", () => {
    for (const p of camel) assert.equal(copilotRunsOtherHostsHook(p), oldDetector(p));
    assert.ok(camel.some((p) => !copilotRunsOtherHostsHook(p)));
  });
  it("each fingerprint field removed or added turns a match into a miss, as the old rule did", () => {
    const base = pascal.find((p) => p.hook_event_name === "PreToolUse") ?? pascal[0]!;
    assert.equal(copilotRunsOtherHostsHook(base), true);
    const without = (k: string) => Object.fromEntries(Object.entries(base).filter(([key]) => key !== k));
    const cases: Array<[string, unknown, boolean]> = [
      ["no timestamp", without("timestamp"), false],
      ["no hook_event_name", without("hook_event_name"), false],
      ["hook_event_name not text", { ...base, hook_event_name: 7 }, false],
      ["permission_mode added", { ...base, permission_mode: "default" }, false],
      ["tool_use_id added", { ...base, tool_use_id: "toolu_1" }, false],
      ["turn_id added", { ...base, turn_id: "t1" }, false],
      ["timestamp of another type still present", { ...base, timestamp: 0 }, true],
      ["null", null, false],
      ["text", "x", false],
    ];
    for (const [name, payload, want] of cases) {
      assert.equal(copilotRunsOtherHostsHook(payload), want, name);
      assert.equal(oldDetector(payload), want, `${name} (oracle)`);
    }
  });
  it("a Claude Code line with a timestamp added still has permission_mode or tool_use_id, so it is not matched", () => {
    for (const p of claude.filter((c) => c.hook_event_name === "PreToolUse" || c.hook_event_name === "PostToolUse")) {
      assert.equal(copilotRunsOtherHostsHook({ ...p, timestamp: "2026-10-24T22:02:21.589Z" }), false);
    }
  });
});
