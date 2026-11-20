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

const build = (cmd: string, desc: string, tool = "Bash", error = STACK) => {
  const ops = [prompt("s1", ["Run it."]), call("c1", { at: 10, end: 40, by: "failure", tool, cmd, desc, extra: { ...h, error } }), stop("s1")];
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

// The line shaped like a raised error ("SomethingError: message", "Exception: message", "Error: message") wins over an earlier line that
// only mentions the word: a quoted source line, a file named errors.py.
const NODE_CRASH = [
  "Exit code 1",
  "file:///Users/user/work/.pptx-build/build.mjs:483",
  "    throw new Error('presentation-layout validator did not pass');",
  "    ^",
  "",
  "Error: presentation-layout validator did not pass",
  "    at file:///Users/user/work/.pptx-build/build.mjs:483:11",
  "",
  "Node.js v24.1.0",
].join("\n");
const PY_TRACE = [
  "Exit code 1",
  "Traceback (most recent call last):",
  '  File "/Users/user/work/build.py", line 40, in <module>',
  "    check(deck)",
  '  File "/Users/user/work/lib/errors.py", line 12, in check',
  '    raise ValueError(f"slide {n} overflows its frame")',
  "ValueError: slide 4 overflows its frame",
].join("\n");
const callError = (error: string): string => {
  const { body } = build("node build.mjs", "", "Bash", error);
  return body.requests.flatMap((r: any) => r.runs).flatMap((r: any) => r.calls)[0].error;
};

describe("the host error line prefers the raised error", () => {
  it("Node's crash printout: the Error line, not the quoted source line", () => {
    assert.equal(callError(NODE_CRASH), "Error: presentation-layout validator did not pass");
  });
  it("a Python traceback: the ValueError line, not a frame naming errors.py", () => {
    assert.equal(callError(PY_TRACE), "ValueError: slide 4 overflows its frame");
  });
  it("Java, .NET and Node's coded errors have the same shape", () => {
    assert.equal(callError("Exception in thread main\n\tat Main.run(Main.java:3)\njava.lang.IllegalStateException: queue closed"), "java.lang.IllegalStateException: queue closed");
    assert.equal(callError("Starting\nUnhandled exception. System.IO.FileNotFoundException: Could not find file"), "Unhandled exception. System.IO.FileNotFoundException: Could not find file");
    assert.equal(callError("x\nTypeError [ERR_INVALID_ARG_TYPE]: The path must be a string"), "TypeError [ERR_INVALID_ARG_TYPE]: The path must be a string");
  });
  it("with no raised-error line, the first line with an error word, as before", () => {
    assert.equal(callError("Exit code 1\ncat: notes.txt: No such file or directory"), "cat: notes.txt: No such file or directory");
  });
});
