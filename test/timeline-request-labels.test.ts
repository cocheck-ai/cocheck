import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { prompt, stop, wakeText } from "./fixtures/timeline.ts";
import type { RawOp } from "../src/timeline/runs.ts";

// The timeline says who wrote each request text. A host notice (the task-notification prompt, shaped as in a real session) is not the
// person's request. A prompt the person typed stays the person's, even when it says "task" or "agent".

const USER = "the user's request";
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const input = (ops: RawOp[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const textsOf = (ops: RawOp[]) => buildTimeline(input(ops)).requests.flatMap((r) => r.texts);
// Recorded-run shape: a notice whose launcher is not in the record stays a request text, whole.
const orphan = wakeText({ toolUseId: "toolu_not_recorded", summary: 'Agent "Fetch NYC snowfall data" finished', result: "Dataset built. Central Park matches your reference totals (2023-24 7.5\")." });

describe("request labels", () => {
  it("a host notice that stays a request text is labelled as a notice, never as the user's request", () => {
    const t = textsOf([prompt("s1", ["Ask A."], stamp(1)), prompt("s1", [orphan], stamp(2)), stop("s1")]);
    const n = t.find((x) => x.text.startsWith("<task-notification>"))!;
    assert.ok(n, "the notice text is in the timeline");
    assert.notEqual(n.label, USER);
    assert.match(n.label, /notice/);
  });
  it("typed prompts that mention task, agent or a notification stay the user's request", () => {
    const typed = ["Please start a background task agent for the weather data.", "The task-notification said finished, why is the agent idle?", "Is <task-notification> a tag you use? Ask the agent."];
    const t = textsOf([...typed.map((p, i) => prompt("s1", [p], stamp(i + 1))), stop("s1")]);
    for (const p of typed) assert.equal(t.find((x) => x.text === p)?.label, USER, p);
  });
  it("a typed prompt sent in the same turn as a notice keeps its own label", () => {
    const t = textsOf([prompt("s1", ["Ask A.", orphan], stamp(1)), stop("s1")]);
    assert.equal(t.find((x) => x.text === "Ask A.")?.label, USER);
    assert.notEqual(t.find((x) => x.text.startsWith("<task-notification>"))?.label, USER);
  });
});
