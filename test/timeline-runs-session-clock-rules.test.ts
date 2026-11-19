import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRuns, readRecord } from "../src/timeline/runs.ts";
import { lineOf } from "../src/timeline/describe.ts";
import { toolLabel } from "../src/tool-label.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

// The rule changes made to the ported viewer rules (the ported tests themselves are unchanged, in timeline-runs.test.ts and
// timeline-describe.test.ts). Each change is the viewer reading CoCheck's own record names and nothing else.

const W = "/w/";

describe("submit order", () => {
  it("splits one turn's requests by the submit stamp and the call start stamp, whatever the clock says", () => {
    const ops = [
      // The clock says q2 started first; the counters say it started after the second request was sent.
      call("q1", { desc: "edit a", named: [W + "a.txt"], at: 500, extra: { startSeq: 4 } }),
      call("q2", { desc: "edit b", named: [W + "b.txt"], at: 100, extra: { startSeq: 9 } }),
      prompt("s1", ["Edit a.", "Also edit b."], { requests: [{ seq: 3, at: 50, firstStep: null }, { seq: 8, at: 60, firstStep: null }] }),
      stop("s1", "Both."),
    ];
    const { requests } = buildRuns(ops, []);
    assert.deepEqual(requests.map((r) => [r.texts, r.placement, r.calls.map((c) => c.id)]), [[["Edit a."], "recorded", ["q1"]], [["Also edit b."], "recorded", ["q2"]]]);
    assert.equal(requests[0]!.closing, null);
    assert.equal(requests[1]!.closing!.text, "Both.");
  });

  it("orders a request's calls by start stamp, and requests across sessions by their stamps", () => {
    const ops = [
      call("b1", { session: "B", desc: "b", named: [W + "b.txt"], at: 1, extra: { startSeq: 20 } }),
      call("a2", { session: "A", desc: "a2", named: [W + "a.txt"], at: 9, extra: { startSeq: 12 } }),
      call("a1", { session: "A", desc: "a1", named: [W + "a.txt"], at: 99, extra: { startSeq: 11 } }),
      prompt("A", ["A asks."], { requests: [{ seq: 10, at: 1, firstStep: null }] }),
      prompt("B", ["B asks."], { requests: [{ seq: 15, at: 1, firstStep: null }] }),
      stop("A"),
      stop("B"),
    ];
    const { requests } = buildRuns(ops, []);
    assert.deepEqual(requests.map((r) => [r.session, r.calls.map((c) => c.id)]), [["A", ["a1", "a2"]], ["B", ["b1"]]]);
  });

  it("one stamped request is recorded; a stamp of 0 (held before stamps existed) is not a place, so the request stays inferred", () => {
    const stamped = buildRuns([call("c", { desc: "x", named: [W + "a.txt"], at: 1 }), prompt("s1", ["Hi."], { requests: [{ seq: 5, at: 1, firstStep: null }] }), stop("s1")], []);
    assert.equal(stamped.requests[0]!.placement, "recorded");
    const padded = buildRuns([call("c", { desc: "x", named: [W + "a.txt"], at: 1 }), prompt("s1", ["Hi."], { requests: [{ seq: 0, at: "unknown", firstStep: null }] }), stop("s1")], []);
    assert.equal(padded.requests[0]!.placement, "inferred");
  });

  it("falls back to the clock when a call carries no start stamp", () => {
    const ops = [
      call("q2", { desc: "edit b", named: [W + "b.txt"], at: 20 }),
      call("q1", { desc: "edit a", named: [W + "a.txt"], at: 10 }),
      prompt("s1", ["Edit a.", "Also edit b."], { requests: [{ seq: 3, at: 5, firstStep: null }, { seq: 8, at: 15, firstStep: null }] }),
      stop("s1"),
    ];
    const { requests } = buildRuns(ops, []);
    assert.deepEqual(requests.map((r) => r.calls.map((c) => c.id)), [["q1"], ["q2"]]);
  });

  it("splits by the first step when that is all the record has", () => {
    const ops = [
      call("q1", { desc: "edit a", named: [W + "a.txt"], at: 10 }),
      call("q2", { desc: "edit b", named: [W + "b.txt"], at: 20 }),
      prompt("s1", ["Edit a.", "Also edit b."], { requests: [{ seq: 0, at: "unknown", firstStep: 1 }, { seq: 0, at: "unknown", firstStep: 7 }] }),
      stop("s1"),
    ];
    ops[0]!.args_json = JSON.stringify({ ...JSON.parse(ops[0]!.args_json!), steps: [1] });
    ops[1]!.args_json = JSON.stringify({ ...JSON.parse(ops[1]!.args_json!), steps: [8] });
    const { requests } = buildRuns(ops, []);
    assert.deepEqual(requests.map((r) => [r.placement, r.calls.map((c) => c.id)]), [["recorded", ["q1"]], ["recorded", ["q2"]]]);
  });
});

describe("safe label", () => {
  // Every label here is the real toolLabel() output, the shape the call op stores on the call op.
  const hooks = { text: (x: string) => x, path: (x: string) => x };
  const one = (tool: string, input: Record<string, unknown>, o: Parameters<typeof call>[1] = {}) =>
    readRecord([call("c", { at: 1, tool, cmd: tool, ...o, extra: { toolLabel: toolLabel(tool, input, hooks) } })], []).calls.get("c")!;

  it("reads the stored {fields} label, and uses it between the agent's description and CoCheck's own translation", () => {
    const skill = one("Skill", { skill: "cocheck-excel" });
    assert.deepEqual(skill.toolLabel, { fields: { skill: "cocheck-excel" } });
    assert.deepEqual([lineOf(skill).text, lineOf(skill).source], ["Loaded cocheck-excel instructions", "label"]);
    assert.equal(lineOf(one("Skill", { skill: "x" }, { desc: "agent says this" })).source, "description");
    assert.equal(lineOf(one("Skill", { skill: "x" }, { said: "Agent words here." })).source, "words");
  });

  it("no label, an empty one, a string, or a stray object is no label", () => {
    const read = (toolLabel: unknown) => readRecord([call("c", { at: 1, tool: "Skill", cmd: "Skill", extra: { toolLabel } })], []).calls.get("c")!;
    for (const bad of [undefined, null, "Loaded a skill", { text: "Loaded a skill" }, { fields: {} }, { fields: { skill: "  " } }]) {
      assert.equal(read(bad).toolLabel, null);
      assert.equal(lineOf(read(bad)).source, "tool");
    }
  });

  it("a tool known only by its input field names stays 'Used <tool>'", () => {
    const c = one("Frobnicate", { alpha: 1 });
    assert.deepEqual(c.toolLabel, { fields: {}, inputFields: ["alpha"] });
    assert.deepEqual([lineOf(c).text, lineOf(c).source], ["Used Frobnicate", "tool"]);
  });

  it("a shell call keeps its own path: the label's command field is never the line", () => {
    const c = one("Bash", { command: "frob --hidden SENTINEL", description: "" }, { cmd: "ls" });
    assert.equal(c.toolLabel!.fields.command, "frob --hidden SENTINEL");
    assert.deepEqual([lineOf(c).text, lineOf(c).source], ["Listed files in the folder", "shell"]);
    assert.ok(!lineOf(c).text.includes("SENTINEL"));
  });
});
