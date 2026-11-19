import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { translateTool, translateShell } from "../src/timeline/describe.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, text: string, changes: Change[] = [], over: Record<string, unknown> = {}) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text, source: "agent-description", label: "l" }, agent: null, ...over });
const failed = (id: string, start: number, text: string, error: string, over: Record<string, unknown> = {}) => call(id, start, text, [], { outcome: "failed", error, ...over });
const timeline = (calls: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: calls.length, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls }] }] } as unknown as Timeline);

// headings and rail labels match the mock (docs/design/review-page-v2.md): a heading is a plain verb and a file name (the path on
// hover) under the actor's chip; helper names carry no agent type; a finish says "finished" once; a failure group reads "N runs failed";
// a rail label is a verb and a file; skill loads, tool lookups and runner names are in plain words.

const mk = (id: string, file: string, kind: "created" | "modified", call: string): Change => ({ ...change(id, file, call), kind }) as Change;
const helper = { agent: { id: "a1", type: "general-purpose" } };

describe("headings and rail labels", () => {
  // the heading names the file by its path relative to the watched folder, not the bare name; the rail label keeps the bare name.
  it("a change's rail label is its verb and file name; its title is the verb and the relative path, and its path is that path", () => {
    const m = buildRailModel(timeline([call("k1", 1, "make it", [mk("a", "out/gdp.csv", "created", "k1"), mk("b", "memo.docx", "modified", "k1")])]));
    const c = m.stops.filter((s) => s.change);
    assert.deepEqual(c.map((s) => s.label), ["Created gdp.csv", "Changed memo.docx"]);
    assert.deepEqual(c.map((s) => s.title), ["Created out/gdp.csv", "Changed memo.docx"]);
    assert.equal(c[0]!.path, "out/gdp.csv");
    assert.ok(c.every((s) => !/\(/.test(s.title!)), "no agent type");
  });

  it("a helper's name carries no agent type, in a failure group or a single failure", () => {
    const m = buildRailModel(timeline([failed("x1", 1, "memo 1", "E1", helper), failed("x2", 2, "memo 2", "E2", helper)]));
    const g = m.stops.find((s) => s.runs)!;
    assert.ok(!/general-purpose/.test(JSON.stringify(m.stops)), JSON.stringify(m.stops.map((s) => s.head)));
    assert.equal(g.title, "2 runs failed");
    assert.equal(g.label, "2 runs failed");
    assert.ok(!/calls that failed/.test(g.head), g.head);
  });

  it("a single failure's title does not say 'ran a call that failed'", () => {
    const m = buildRailModel(timeline([failed("f1", 1, "Fetch FRED", "Exit code 1")]));
    assert.equal(m.stops.find((s) => s.runs)!.title, "Failed: Fetch FRED");
  });

  it("a request's title has no actor name", () => {
    assert.equal(buildRailModel(timeline([failed("f1", 1, "Fetch", "E")])).stops[0]!.title, "Made request 1");
  });
});

describe("the words cut list", () => {
  it("a skill load, a tool lookup and a uv run read in plain words", () => {
    // a skill is named by its own name, never a product name
    assert.equal(translateTool("Skill", { skill: "anthropic-skills:pptx" }), "Loaded pptx instructions");
    assert.equal(translateTool("Skill", { skill: "anthropic-skills:xlsx" }), "Loaded xlsx instructions");
    assert.equal(translateTool("Skill", { skill: "frontend-design" }), "Loaded frontend-design instructions");
    assert.equal(translateTool("ToolSearch", { query: "select:WebSearch" }), "Looked up a tool");
    assert.doesNotMatch(translateShell("uv run python build.py"), /\buv\b/);
    assert.equal(translateShell("uv run python build.py"), translateShell("python build.py"));
    assert.equal(translateShell("uv run --with pandas fetch.py"), translateShell("fetch.py"));
  });
});
