import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type FormatChanges, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel, type RailStop } from "../src/timeline/rail/model.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// Two gaps:
//  - a call that runs a script file an earlier call of the same agent wrote whole (a heredoc `cat > memo.js`, or the Write tool) shows a write signal
//    for the file that script saves, though the running call's own text names the file only as the input of a converter;
//  - an office file outside the work folder is only ever seen because a call named it; found with no call open (the sweep before that call), it
//    goes to the open calls that named it, never to "outside the agents".

const FMT: FormatChanges = { module: "docx", rows: [], more: 0 };
const h1 = { agent_id: "a1", agent_type: "general-purpose" };
const h2 = { agent_id: "a2", agent_type: "general-purpose" };
const MEMO = "/w/out/macro_memo.docx";
const SCRIPT = "const fs=require('fs');\nPacker.toBuffer(doc).then(b=>fs.writeFileSync('/w/out/macro_memo.docx',b));";

const build = (ops: RawOp[], states: RawState[]): { body: Timeline; model: RailModel } => {
  const input = { taskId: 1, build: "b", ops, fileStates: states, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map(states.map((s) => [s.id, FMT])), quickLook: false, host: "claude" } as TimelineInput;
  const body = JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline;
  return { body, model: buildRailModel(body) };
};
const changeStops = (m: RailModel): RailStop[] => m.stops.filter((s) => s.change);
const owners = (b: Timeline): string[] => b.requests.flatMap((r) => r.runs.flatMap((u) => u.calls)).filter((x) => x.changes.length > 0).map((x) => x.id);
const heredoc = (name: string, text: string) => `S=/tmp/s; cat > $S/${name} <<'E'\n${text}\nE`;

describe("a script an earlier call wrote is read for the write it makes", () => {
  const run = (writerCmd: string, otherCmd = "python3 prep.py", script = SCRIPT, scriptBy = h1) => {
    const ops = [
      prompt("s1", ["Write the memo."]),
      call("w0", { at: 1, end: 5, cmd: "x", input: { command: heredoc("memo.js", script) }, extra: scriptBy }),
      call("c1", { at: 10, end: 40, cmd: writerCmd, input: { command: writerCmd }, extra: h1 }),
      call("c2", { at: 15, end: 30, by: "failure", cmd: otherCmd, input: { command: otherCmd }, extra: { ...h2, error: "boom" } }),
      stop("s1"),
    ];
    return build(ops, [state(MEMO, "n1", null, { open: ["c1", "c2"], credited: ["c1", "c2"], step: 3 })]);
  };

  it("node memo.js, with the memo named only for the PDF converter, goes to the script's agent alone", () => {
    const { body, model } = run("cd /tmp/s && node memo.js && soffice --headless --convert-to pdf " + MEMO);
    assert.equal(changeStops(model)[0]!.lane, "agent:1");
    const calls = body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls));
    assert.deepEqual(calls.find((x) => x.id === "c1")!.changes[0]!.by.calls, ["c1"]);
    assert.equal(calls.find((x) => x.id === "c2")!.changes.length, 0);
  });

  it("a script that only reads the file is no signal: joint", () => {
    const { model } = run("node memo.js", "python3 prep.py", "const b=require('fs').readFileSync('/w/out/macro_memo.docx');");
    assert.equal(changeStops(model)[0]!.lane, "unsure");
  });

  it("a script another agent wrote is not this call's script: joint", () => {
    const { model } = run("node memo.js", "python3 prep.py", SCRIPT, h2);
    assert.equal(changeStops(model)[0]!.lane, "unsure");
  });

  it("a reader never takes credit over a writer: the other call writes the file by redirect", () => {
    const { body } = run("soffice --convert-to pdf " + MEMO, "cp /tmp/base.docx " + MEMO);
    assert.deepEqual(owners(body), ["c2"]);
  });

  it("two calls that both run a script of their own that writes it stay joint", () => {
    const ops = [
      prompt("s1", ["Write the memo."]),
      call("w1", { at: 1, end: 5, cmd: "x", input: { command: heredoc("memo.js", SCRIPT) }, extra: h1 }),
      call("w2", { at: 2, end: 6, cmd: "x", input: { command: heredoc("memo.js", SCRIPT) }, extra: h2 }),
      call("c1", { at: 10, end: 40, cmd: "node memo.js", input: { command: "node memo.js" }, extra: h1 }),
      call("c2", { at: 15, end: 30, cmd: "node memo.js", input: { command: "node memo.js" }, extra: h2 }),
      stop("s1"),
    ];
    const { model } = build(ops, [state(MEMO, "n1", null, { open: ["c1", "c2"], credited: ["c1", "c2"], step: 3 })]);
    assert.equal(changeStops(model)[0]!.lane, "unsure");
  });

  it("the Write tool's content counts as the script", () => {
    const ops = [
      prompt("s1", ["Write the memo."]),
      call("w0", { at: 1, end: 5, tool: "Write", cmd: "Write", input: { file_path: "/tmp/s/memo.js", content: SCRIPT }, extra: h1 }),
      call("c1", { at: 10, end: 40, cmd: "node /tmp/s/memo.js", input: { command: "node /tmp/s/memo.js" }, extra: h1 }),
      call("c2", { at: 15, end: 30, cmd: "ls", input: { command: "ls" }, extra: h2 }),
      stop("s1"),
    ];
    const { model } = build(ops, [state(MEMO, "n1", null, { open: ["c1", "c2"], credited: ["c1", "c2"], step: 3 })]);
    assert.equal(changeStops(model)[0]!.lane, "agent:1");
  });
});

describe("an office file outside the folder is credited to the call that named it", () => {
  const CHK = "/tmp/scratch/chk.xlsx";
  const AT = 1_000_000;
  // First seen at a Pre sweep with nothing open, as the ledger records the sweep before the call that names the file.
  const found = (credited: string[] = []): RawState => ({ ...state(CHK, "x1", null, { step: 5, credited }), phase: "Pre", ts: new Date(AT + 3).toISOString() });
  const base = (): RawState => state("/w/other.txt", "z0", null, { step: 1 });
  const lanes = (ops: RawOp[], credited: string[] = []) => build([prompt("s1", ["go"]), ...ops, stop("s1")], [base(), found(credited)]);

  it("one open call named it: that call alone, never outside", () => {
    const { body, model } = lanes([call("c1", { at: AT - 1, end: AT + 900, named: [CHK], cmd: "cp a.xlsx chk.xlsx", extra: h1 })]);
    const c = changeStops(model).find((s) => s.change!.file.endsWith("chk.xlsx"))!;
    assert.equal(c.lane, "agent:1");
    assert.doesNotMatch(c.head, /outside/i);
    assert.deepEqual(body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls)).find((x) => x.id === "c1")!.changes.map((x) => x.by.kind), ["call"]);
  });

  it("two open calls named it: joint, with both", () => {
    const { model } = lanes([
      call("c1", { at: AT - 1, end: AT + 900, named: [CHK], cmd: "ls", extra: h1 }),
      call("c2", { at: AT - 2, end: AT + 800, named: [CHK], cmd: "ls", extra: h2 }),
    ]);
    const c = changeStops(model).find((s) => s.change!.file.endsWith("chk.xlsx"))!;
    assert.equal(c.lane, "unsure");
  });

  it("two named it but exactly one writes it: the writer alone (a reader never takes credit)", () => {
    const { body } = lanes([
      call("c1", { at: AT - 1, end: AT + 900, named: [CHK], cmd: "ls", input: { command: "ls " + CHK }, extra: h1 }),
      call("c2", { at: AT - 2, end: AT + 800, named: [CHK], cmd: "cp a.xlsx " + CHK, input: { command: "cp a.xlsx " + CHK }, extra: h2 }),
    ]);
    assert.deepEqual(owners(body), ["c2"]);
  });

  it("no call named it, or the naming call was not open: still outside", () => {
    const { model } = lanes([call("c1", { at: AT - 500, end: AT + 900, named: ["/tmp/scratch/other.xlsx"], cmd: "ls", extra: h1 }), call("c2", { at: AT + 5000, end: AT + 6000, named: [CHK], cmd: "ls", extra: h1 })]);
    assert.equal(changeStops(model).find((s) => s.change!.file.endsWith("chk.xlsx"))!.lane, "other");
  });

  it("a file inside the folder found the same way stays outside (the folder is watched, so a call did not create it)", () => {
    const inFolder: RawState = { ...found(), file_path: "/w/new.xlsx" };
    const { model } = build([prompt("s1", ["go"]), call("c1", { at: AT - 1, end: AT + 900, named: ["/w/new.xlsx"], cmd: "ls", extra: h1 }), stop("s1")], [base(), inFolder]);
    assert.equal(changeStops(model).find((s) => s.change!.file.endsWith("new.xlsx"))!.lane, "other");
  });
});
