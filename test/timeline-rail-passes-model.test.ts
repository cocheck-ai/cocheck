import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { stopIdentities } from "../src/timeline/rail/stop-status.ts";
import { buildPasses } from "../src/timeline/rail/passes.ts";
import type { SendBackRow, StopVerdictRow, SubmissionRow } from "../src/ledger.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// the rail marks each send-back and each submission, and tags the stops after it from file history alone (no model call):
// "reworks" (a file that had a failed stop), "changes_passed" (a file the person passed), "new". Pure: model, verdict rows, send-backs and
// submissions in, markers, tags and links out. Guarded against: a verdict given after the marker, or on other bytes, never counts.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, at: number): Change => ({ id, file, outside: false, at, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref(id.padEnd(64, "b")), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const timelineOf = (changes: Change[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: 1, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }] }] }) as unknown as Timeline;

const iso = (ms: number): string => new Date(ms).toISOString();
let rowId = 0;
const verdictOf = (tl: Timeline, stop: string, status: StopVerdictRow["status"], ms: number, fingerprint?: string): StopVerdictRow => {
  const id = stopIdentities(buildRailModel(tl), tl).get(stop)!;
  return { id: ++rowId, taskId: 7, stopId: stop, subject: id.subject, fingerprint: fingerprint ?? id.fingerprint, status, note: status === "failed" ? "wrong" : "", reviewer: "t", ts: iso(ms) };
};
const sendBack = (id: number, ms: number): SendBackRow => ({ id, taskId: 7, prompt: "p", stopIds: [], reviewer: "t", note: "", nonce: null, ts: iso(ms) });
const submission = (id: number, ms: number): SubmissionRow => ({ id, taskId: 7, signoffId: id, acknowledged: [], reviewer: "t", ts: iso(ms), stateMark: null, covered: null });
const run = (tl: Timeline, rows: StopVerdictRow[], sb: SendBackRow[] = [], su: SubmissionRow[] = []) => buildPasses(buildRailModel(tl), tl, rows, sb, su);

// a.xlsx c1 (failed), b.xlsx c2 (passed), c.xlsx c3 (not reviewed); the send-back at 4000; then a.xlsx c4, b.xlsx c5, d.xlsx c6.
const basic = timelineOf([change("c1", "a.xlsx", 1000), change("c2", "b.xlsx", 2000), change("c3", "c.xlsx", 3000), change("c4", "a.xlsx", 5000), change("c5", "b.xlsx", 6000), change("c6", "d.xlsx", 7000), change("c7", "c.xlsx", 8000)]);
const basicRows = [verdictOf(basic, "chg-c1", "failed", 3500), verdictOf(basic, "chg-c2", "passed", 3600)];

describe("markers", () => {
  it("draws a marker at the send-back and at the submission, named in plain words, before the first stop after it", () => {
    const p = run(basic, basicRows, [sendBack(1, 4000)], [submission(1, 6500)]);
    assert.deepEqual(p.markers.map((m) => [m.kind, m.label, m.pass, m.beforeStop]), [["sent_back", "Sent back for review", 1, "chg-c4"], ["submitted", "Signed off by t, 1970-01-01: everything above this line was reviewed", 2, "chg-c6"]]);
  });
  it("orders markers by time whatever table they came from, and a marker after every stop has no stop after it", () => {
    const p = run(basic, basicRows, [sendBack(1, 9000)], [submission(1, 4000)]);
    assert.deepEqual(p.markers.map((m) => [m.kind, m.beforeStop]), [["submitted", "chg-c4"], ["sent_back", null]]);
  });
  it("no marker, no tag: stops before the first marker are untagged", () => {
    const p = run(basic, basicRows);
    assert.deepEqual([p.markers, p.tags, p.answeredBy], [[], {}, {}]);
  });
});

describe("tags after a send-back", () => {
  const p = run(basic, basicRows, [sendBack(1, 4000)]);
  it("tags a stop on a failed file as a rework, a stop on a passed file as a change to something passed, and an unreviewed or unseen file as new", () => {
    assert.deepEqual(["chg-c4", "chg-c5", "chg-c6", "chg-c7"].map((s) => p.tags[s]?.tag), ["reworks", "changes_passed", "new", "new"]);
  });
  it("tags nothing before the marker, and no request or other stop without a file", () => {
    assert.deepEqual(Object.keys(p.tags).sort(), ["chg-c4", "chg-c5", "chg-c6", "chg-c7"]);
  });
  it("links a rework to the stop it answers and that stop forward, and no other stop has either link", () => {
    assert.equal(p.tags["chg-c4"]!.answers, "chg-c1");
    assert.deepEqual(p.answeredBy, { "chg-c1": ["chg-c4"] });
    assert.equal(p.tags["chg-c5"]!.answers, undefined);
  });
  it("the tag carries plain words and its pass number", () => {
    assert.deepEqual([p.tags["chg-c4"]!.text, p.tags["chg-c5"]!.text, p.tags["chg-c6"]!.text, p.tags["chg-c4"]!.pass], ["Reworks a stop you failed", "Changes something you passed", "New since the review", 1]);
  });
});

describe("which verdict counts", () => {
  it("a verdict given after the marker, or on other bytes, does not count", () => {
    const late = [verdictOf(basic, "chg-c1", "failed", 4500), verdictOf(basic, "chg-c2", "passed", 4500, "0".repeat(64))];
    const p = run(basic, late, [sendBack(1, 4000)]);
    assert.deepEqual(["chg-c4", "chg-c5"].map((s) => p.tags[s]?.tag), ["new", "new"]);
    assert.deepEqual(p.answeredBy, {});
  });
  it("a file failed at one stop and passed at a later one, both before the marker: failed wins, it is a rework of the failed stop", () => {
    const tl = timelineOf([change("c1", "a.xlsx", 1000), change("c2", "a.xlsx", 2000), change("c3", "a.xlsx", 5000)]);
    const rows = [verdictOf(tl, "chg-c1", "failed", 2500), verdictOf(tl, "chg-c2", "passed", 2600)];
    const p = run(tl, rows, [sendBack(1, 4000)]);
    assert.deepEqual([p.tags["chg-c3"]!.tag, p.tags["chg-c3"]!.answers], ["reworks", "chg-c1"]);
  });
  it("the latest stop of the file before the marker decides, and an unreviewed latest stop falls back to the latest verdict", () => {
    const tl = timelineOf([change("c1", "a.xlsx", 1000), change("c2", "a.xlsx", 2000), change("c3", "a.xlsx", 5000)]);
    const p = run(tl, [verdictOf(tl, "chg-c1", "passed", 2500)], [sendBack(1, 4000)]);
    assert.equal(p.tags["chg-c3"]!.tag, "changes_passed");
  });
  it("a verdict later withdrawn (marked not reviewed) is not a verdict", () => {
    const tl = timelineOf([change("c1", "a.xlsx", 1000), change("c3", "a.xlsx", 5000)]);
    const p = run(tl, [verdictOf(tl, "chg-c1", "failed", 2000), verdictOf(tl, "chg-c1", "not_reviewed", 3000)], [sendBack(1, 4000)]);
    assert.equal(p.tags["chg-c3"]!.tag, "new");
  });
  it("every stop of a file after the marker is tagged the same way, and the failed stop links forward to all of them", () => {
    const tl = timelineOf([change("c1", "a.xlsx", 1000), change("c2", "a.xlsx", 5000), change("c3", "a.xlsx", 6000)]);
    const p = run(tl, [verdictOf(tl, "chg-c1", "failed", 2000)], [sendBack(1, 4000)]);
    assert.deepEqual(p.answeredBy, { "chg-c1": ["chg-c2", "chg-c3"] });
    assert.deepEqual(["chg-c2", "chg-c3"].map((s) => p.tags[s]!.answers), ["chg-c1", "chg-c1"]);
  });
});

describe("several passes", () => {
  // a.xlsx: c1 failed; marker 1 at 4000; c4 reworks it and is passed at 6000; marker 2 (a submission) at 7000; c8 touches it again.
  const tl = timelineOf([change("c1", "a.xlsx", 1000), change("c4", "a.xlsx", 5000), change("c8", "a.xlsx", 8000), change("c9", "z.xlsx", 9000)]);
  const rows = [verdictOf(tl, "chg-c1", "failed", 2000), verdictOf(tl, "chg-c4", "passed", 6000)];
  const p = run(tl, rows, [sendBack(1, 4000)], [submission(1, 7000)]);
  it("each pass compares against the verdicts as of its own marker", () => {
    assert.deepEqual([p.tags["chg-c4"]!.tag, p.tags["chg-c4"]!.pass, p.tags["chg-c8"]!.tag, p.tags["chg-c8"]!.pass, p.tags["chg-c9"]!.tag], ["reworks", 1, "changes_passed", 2, "new"]);
  });
  it("a failure answered and then passed is not a rework of the second pass, and its link points only at the first rework", () => {
    assert.equal(p.tags["chg-c8"]!.answers, undefined);
    assert.deepEqual(p.answeredBy, { "chg-c1": ["chg-c4"] });
  });
  it("a rework that failed again is answered by the next pass's stop, and the chain links on", () => {
    const rows2 = [verdictOf(tl, "chg-c1", "failed", 2000), verdictOf(tl, "chg-c4", "failed", 6000)];
    const q = run(tl, rows2, [sendBack(1, 4000)], [submission(1, 7000)]);
    assert.deepEqual([q.tags["chg-c8"]!.tag, q.tags["chg-c8"]!.answers], ["reworks", "chg-c4"]);
    assert.deepEqual(q.answeredBy, { "chg-c1": ["chg-c4"], "chg-c4": ["chg-c8"] });
  });
});
