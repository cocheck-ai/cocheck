// a failure's host text on the rail is the first error line, outside paths masked; the title names the step that failed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

const STACK = [
  "Exit code 1",
  "node:internal/modules/cjs/loader:1228",
  "Error: Cannot find module '/Users/user/.claude/skills/synced/9f1c/node_modules/docx'",
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
  "    at /private/tmp/claude-501/x/memo.js:3:11",
].join("\n");
const h = { agent_id: "a1", agent_type: "general-purpose" };

const build = (cmd: string, desc: string, tool = "Bash") => {
  const ops = [prompt("s1", ["Run it."]), call("c1", { at: 10, end: 40, by: "failure", tool, cmd, desc, extra: { ...h, error: STACK } }), stop("s1")];
  const input = { taskId: 1, build: "b", ops, fileStates: [state("/w/a.xlsx", "n0", null, { step: 1 })], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map(), quickLook: false, host: "claude" } as TimelineInput;
  const body = JSON.parse(JSON.stringify(buildTimeline(input)));
  return { body, model: buildRailModel(body) };
};

describe("failure host text and title", () => {
  // a failed call is a failure group of one, labelled with its count
  it("the host text is one line, with outside paths masked", () => {
    const { body, model } = build("for f in *.csv; do head -3 $f; done", "");
    const c = body.requests.flatMap((r: any) => r.runs).flatMap((r: any) => r.calls)[0];
    assert.ok(c.error && !c.error.includes("\n"), String(c.error));
    assert.ok(!/\/Users\/|\/private\/|\.claude/.test(c.error), c.error);
    assert.match(c.error, /^Error: Cannot find module/);
    const stop = model.stops.find((s) => s.label === "1 run failed")!;
    assert.ok(stop.card!.lines.length <= 2, JSON.stringify(stop.card));
  });
  it("the title names the step, not a flag", () => {
    const { model } = build("for f in *.csv; do head -3 $f; done", "");
    const stop = model.stops.find((s) => s.label === "1 run failed")!;
    assert.ok(!/Ran for|Ran -d/.test(stop.head), stop.head);
    assert.match(stop.card!.title, /^Failed: /);
    assert.ok(stop.card!.title.length > "Failed: ".length);
  });
});
