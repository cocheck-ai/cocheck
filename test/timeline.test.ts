import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TIMELINE_SCHEMA, buildTimeline, timelineEtag, type Change, type FormatChanges, type Timeline, type TimelineCall, type TimelineInput } from "../src/timeline/timeline.ts";
import { toolLabel } from "../src/tool-label.ts";
import { call, fixtures, prompt, state, stop, type Fixture } from "./fixtures/timeline.ts";

// The timeline read model. Pure: ledger rows in, one document out. Synthetic fixtures only (test/fixtures/timeline.ts, carried over
// from the test-drive viewer); no real recorded session is used or tuned to.

const input = (f: Fixture, over: Partial<TimelineInput> = {}): TimelineInput => ({
  taskId: 1,
  build: "test-build",
  ops: f.ops,
  fileStates: f.fileStates,
  folder: "/w",
  valuesExpiredAt: null,
  removals: [],
  stored: new Map(),
  formats: new Map(),
  quickLook: true,
  ...over,
});
const timelineOf = (name: string, over: Partial<TimelineInput> = {}): Timeline => buildTimeline(input(fixtures[name]!(), over));
const allCalls = (t: Timeline): TimelineCall[] => t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls));

/** Every string in the body, with the key it sits under. */
function strings(value: unknown, key = ""): Array<[string, string]> {
  if (typeof value === "string") return [[key, value]];
  if (Array.isArray(value)) return value.flatMap((v) => strings(v, key));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, k));
  return [];
}

describe("timeline shape", () => {
  it("is requests, then runs, then calls, in the record's order, under the schema name", () => {
    const t = timelineOf("directWriter");
    assert.equal(t.schema, TIMELINE_SCHEMA);
    assert.equal(t.schema, "cocheck.timeline/1");
    assert.equal(t.task, 1);
    assert.equal(t.requests.length, 1);
    assert.deepEqual(t.requests[0]!.runs.map((u) => u.calls.map((c) => c.id)), [["w1"], ["w2"], ["w3"], ["w4"]]);
    assert.deepEqual(t.requests[0]!.runs.map((u) => u.id), ["run:w1", "run:w2", "run:w3", "run:w4"]);
    assert.deepEqual(t.requests[0]!.runs.map((u) => u.endedBy), ["change", "change", "change", "end of request"]);
    assert.equal(t.requests[0]!.runs[0]!.rule, "runs/1");
    assert.deepEqual(t.requests[0]!.texts.map((x) => [x.text, x.source]), [["Write the notes.", "user"]]);
    assert.deepEqual([t.requests[0]!.closing?.text, t.requests[0]!.closing?.source], ["Done.", "agent-claim"]);
    assert.match(t.requests[0]!.closing!.label, /not checked against the files/);
    assert.deepEqual(t.hosts, ["claude"]);
    assert.equal(t.folder, "w");
  });

  it("run facts carry no interpretation: counts, files, the call a change was seen at", () => {
    const t = timelineOf("liveAppNamed");
    const run = t.requests[0]!.runs[0]!;
    assert.deepEqual([run.callCount, run.failedCount, run.files, run.changedFiles, run.changedAtCall], [6, 0, ["model.xlsx"], ["model.xlsx"], 6]);
    assert.ok(!("phase" in run) && !("reading" in run) && !("caption" in run));
    assert.deepEqual(run.calls.map((c) => [c.index, c.of]), [[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6]]);
  });

  it("orders requests by their submit stamps and calls by their start stamps, not by the clock", () => {
    const ops = [
      call("late", { desc: "second", named: ["/w/a.txt"], at: 10, extra: { startSeq: 5 } }),
      call("early", { desc: "first", named: ["/w/a.txt"], at: 99, extra: { startSeq: 3 } }),
      prompt("s1", ["Do it."], { requests: [{ seq: 2, at: 1, firstStep: null }] }),
      stop("s1"),
    ];
    const t = buildTimeline(input({ ops, fileStates: [] }));
    assert.deepEqual(allCalls(t).map((c) => c.id), ["early", "late"]);
    assert.equal(t.requests[0]!.placement.kind, "recorded");
    assert.equal(t.requests[0]!.id, "q2");
  });
});

describe("call lines", () => {
  it("carry their source: words, description, or CoCheck's translation with what it was built from", () => {
    const ops = [
      call("a", { desc: "does a thing", said: "Checking the totals first. More.", named: ["/w/a.txt"], at: 1 }),
      call("b", { desc: "Rebuild the sheet", at: 2 }),
      call("c", { tool: "Read", cmd: "Read", input: { file_path: "/w/a.txt" }, at: 3 }),
      call("d", { host: "codex", desc: "", cmd: "sed -n 1,40p main.go", at: 4 }),
      call("e", { tool: "Skill", desc: "", cmd: "Skill", at: 5, extra: { toolLabel: toolLabel("Skill", { skill: "cocheck-excel" }, { text: (x) => x, path: (x) => x }) } }),
      prompt("s1", ["Go."]),
      stop("s1"),
    ];
    const lines = Object.fromEntries(allCalls(buildTimeline(input({ ops, fileStates: [] }))).map((c) => [c.id, c.line]));
    assert.deepEqual([lines.a!.text, lines.a!.source], ["Checking the totals first.", "agent-words"]);
    assert.deepEqual([lines.b!.text, lines.b!.source], ["Rebuild the sheet", "agent-description"]);
    assert.deepEqual([lines.c!.text, lines.c!.source, lines.c!.basis], ["Read a.txt", "cocheck-translation", "tool"]);
    assert.deepEqual([lines.d!.text, lines.d!.source, lines.d!.basis], ["Read main.go", "cocheck-translation", "shell"]);
    assert.deepEqual([lines.e!.text, lines.e!.source, lines.e!.basis], ["Loaded cocheck-excel instructions", "cocheck-translation", "tool-label"]);
    assert.match(lines.a!.label, /agent's words/);
    assert.match(lines.d!.label, /CoCheck's/);
  });

  it("a rule-built line never carries the agent's-words source, in any fixture", () => {
    let checked = 0;
    for (const name of Object.keys(fixtures)) {
      const f = fixtures[name]!();
      const said = new Set<string>();
      for (const op of f.ops) {
        const a = JSON.parse(op.args_json ?? "{}") as { tool_use_id?: string; narration?: { source?: string; text?: string } };
        if (a.tool_use_id && a.narration?.source === "agent" && a.narration.text?.replace(/^\s*[A-Z-]+\s*/, "").trim()) said.add(a.tool_use_id);
      }
      for (const c of allCalls(buildTimeline(input(f)))) {
        if (c.line.source === "agent-words") assert.ok(said.has(c.id), `${name}/${c.id} labelled as the agent's words with none recorded`);
        else checked++;
        if (!said.has(c.id) && !c.line.source.startsWith("agent-")) assert.equal(c.line.source, "cocheck-translation");
      }
    }
    assert.ok(checked > 20, `checked ${checked}`);
  });

  it("a mode label or an empty narration is not the agent's words", () => {
    const ops = [call("m", { tool: "Read", cmd: "Read", said: "EXECUTE", named: ["/w/a.txt"], at: 1 }), call("n", { tool: "Read", cmd: "Read", named: ["/w/a.txt"], at: 2 }), prompt("s1", ["Go."]), stop("s1")];
    assert.deepEqual(allCalls(buildTimeline(input({ ops, fileStates: [] }))).map((c) => c.line.source), ["cocheck-translation", "cocheck-translation"]);
  });
});

describe("changes and credit", () => {
  it("a change shows only on the call the record credits it to, never on a call that merely had the file open", () => {
    const t = timelineOf("backgroundOpen");
    const byCall = Object.fromEntries(allCalls(t).map((c) => [c.id, c.changes.map((x) => x.file)]));
    assert.deepEqual(byCall, { bg: [], e1: ["a.txt"], e2: ["b.txt"] });
  });

  it("a change open to two calls and credited to both stays joint, on both", () => {
    const ops = [call("x", { desc: "edit one", named: ["/w/a.txt"], at: 10, end: 40 }), call("y", { desc: "edit two", named: ["/w/a.txt"], at: 20, end: 30 }), prompt("s1", ["Go."]), stop("s1")];
    const fileStates = [state("/w/a.txt", "a1", "a0", { open: ["x", "y"], credited: ["x", "y"] })];
    const calls = allCalls(buildTimeline(input({ ops, fileStates })));
    const [cx, cy] = [calls.find((c) => c.id === "x")!, calls.find((c) => c.id === "y")!];
    assert.equal(cx.changes.length, 1);
    assert.equal(cy.changes.length, 1);
    assert.equal(cx.changes[0]!.id, cy.changes[0]!.id);
    assert.deepEqual([cx.changes[0]!.credit.joint, cx.changes[0]!.credit.calls], [true, ["x", "y"]]);
    assert.match(cx.changes[0]!.credit.text, /jointly/);
  });

  it("open to two calls but credited to one: the other call does not show it, and the credit is not joint", () => {
    const ops = [call("x", { desc: "edit one", named: ["/w/a.txt"], at: 10, end: 40 }), call("y", { desc: "look", named: ["/w/b.txt"], at: 20, end: 30 }), prompt("s1", ["Go."]), stop("s1")];
    const fileStates = [state("/w/a.txt", "a1", "a0", { open: ["x", "y"], credited: ["x"] })];
    const calls = allCalls(buildTimeline(input({ ops, fileStates })));
    assert.deepEqual(calls.map((c) => [c.id, c.changes.map((x) => x.credit.joint)]), [["x", [false]], ["y", []]]);
  });

  it("a change nobody is credited with sits under no call, with the reason in words (never 'a person')", () => {
    const ops = [call("x", { desc: "look", named: ["/w/a.txt"], at: 10, end: 40 }), prompt("s1", ["Go."]), stop("s1")];
    // B.txt is a Pre sweep with no call open, so it is outside; the fixture's default Post sweep would read as found during calls.
    const fileStates = [state("/w/a.txt", "a1", "a0", { open: ["x"], credited: [] }), { ...state("/w/b.txt", "b1", "b0", { open: [], credited: [] }), phase: "Pre" }];
    const t = buildTimeline(input({ ops, fileStates }));
    assert.deepEqual(allCalls(t).flatMap((c) => c.changes), []);
    assert.deepEqual(t.unplaced.map((c) => [c.file, c.credit.calls, c.credit.text]), [
      ["a.txt", [], "calls were still open, but none can be shown to have made it"],
      // The credit text comes from `attribution.ts`; "not from an agent call" (the hook's ledger words) is not served.
      ["b.txt", [], "found between agent calls, with no call running"],
    ]);
    assert.ok(t.missing.some((m) => /shown under no call/.test(m)));
  });

  it("each change holds its before and after state by hash, and points back to earlier calls that named the file", () => {
    const t = timelineOf("targetlessBetween", { stored: new Map([["p1", 10], ["p2", 12], ["p0", 9]]) });
    const changes = allCalls(t).flatMap((c) => c.changes.map((x) => ({ call: c.id, change: x })));
    assert.deepEqual(changes.map((x) => [x.call, x.change.before?.sha256, x.change.after.sha256]), [["t1", "p0", "p1"], ["t6", "p1", "p2"]]);
    // t4 read app.py between the two changes; t1 (credited with the first change) is not "named earlier" for the second.
    const second = changes[1]!.change;
    assert.deepEqual(second.alsoNamedBy.map((x) => x.call), ["t4"]);
    assert.equal(second.credit.calls[0], "t6");
    assert.ok(!second.credit.calls.includes("t4"), "naming a file is not credit");
    assert.deepEqual([second.after.stored, second.after.size, second.before?.stored, second.before?.size], [true, 12, true, 10]);
  });

  it("the format layer's findings ride on the change, with the count of rows it did not list", () => {
    const f = fixtures.liveAppNamed!();
    const fmt: FormatChanges = { module: "xlsx", rows: [{ location: "Sheet1!B3", kind: "value", before: "1", after: "2", text: "Sheet1!B3 changed from 1 to 2" }], more: 4 };
    const t = buildTimeline(input(f, { formats: new Map([[f.fileStates[1]!.id, fmt]]) }));
    const ch = allCalls(t).flatMap((c) => c.changes)[0]!;
    assert.deepEqual([ch.format?.module, ch.format?.rows.length, ch.format?.more], ["xlsx", 1, 4]);
    assert.ok(ch.missing.includes("4 more changes inside the file are not listed."));
  });
});

describe("absent pieces are sentences", () => {
  const changeOf = (t: Timeline): Change => allCalls(t).flatMap((c) => c.changes)[0]!;

  it("a state not in the store says why, and its preview is empty with a sentence", () => {
    const t = timelineOf("liveAppNamed", { removals: [{ sha256: "m0", ts: "2026-10-01T00:00:00Z", reason: "signed off: the states between were deleted" }] });
    const ch = changeOf(t);
    assert.equal(ch.after.stored, false);
    assert.equal(ch.before?.why, "signed off: the states between were deleted");
    assert.equal(ch.before?.preview.ref, null);
    assert.match(ch.before!.preview.missing!, /^No preview: signed off/);
    assert.ok(ch.missing.some((m) => /before this change is not in the store/.test(m)));
    assert.ok(ch.missing.includes("The format layer did not read this change."));
  });

  it("a stored state of an image file offers a reference to its stored bytes; any other file has none, with a sentence naming no OS", () => {
    const stored = new Map([["m0", 1], ["m1", 1]]);
    const other = changeOf(timelineOf("liveAppNamed", { stored }));
    assert.equal(other.after.preview.ref, null);
    assert.equal(other.after.preview.label, "Image as stored");
    assert.match(other.after.preview.missing!, /only png, jpg, gif, webp and svg/);
    assert.doesNotMatch(other.after.preview.missing!, /macOS|Quick Look/);
  });

  it("no request text, no closing message and an inferred place are each said", () => {
    const t = timelineOf("twoRequestsOneTurn");
    assert.ok(t.requests[0]!.missing.some((m) => /2 requests sent in one turn/.test(m)));
    const none = buildTimeline(input({ ops: [call("o", { desc: "x", named: ["/w/a.txt"], at: 1 })], fileStates: [] }));
    assert.deepEqual(none.requests[0]!.missing, ["Request not captured.", "The record carries no submit order for this request, so it is placed before its first run (inferred).", "No closing message recorded."]);
  });

  it("a host that reports no failures gets no failed count and no 'succeeded'", () => {
    const t = timelineOf("codexLike");
    const run = t.requests[0]!.runs[0]!;
    assert.equal(run.failedCount, null);
    assert.deepEqual(run.calls.map((c) => c.outcome), ["unknown", "unknown"]);
    assert.ok(run.missing.some((m) => /does not report failed calls/.test(m)));
    const failing = timelineOf("failThenSucceed").requests[0]!.runs[0]!;
    assert.deepEqual([failing.failedCount, failing.calls.map((c) => c.outcome)], [2, ["failed", "failed", "succeeded"]]);
  });

  it("no string anywhere in the body is empty", () => {
    for (const name of Object.keys(fixtures)) {
      const t = timelineOf(name, { stored: new Map([["m1", 5]]) });
      const empty = strings(t).filter(([, v]) => v === "");
      assert.deepEqual(empty, [], name);
    }
  });
});

describe("expiry", () => {
  it("reads expired, not blank: the sentence is there, the words are gone, the changes keep their hashes", () => {
    const f = fixtures.directWriter!();
    // After expireValues the ops hold no arguments and no intent.
    const blanked = f.ops.map((o) => ({ ...o, args_json: "{}", intent: "" }));
    const t = buildTimeline(input({ ...f, ops: blanked, fileStates: f.fileStates }, { valuesExpiredAt: "2026-11-15T00:00:00.000Z" }));
    assert.equal(t.requests.length, 0);
    assert.match(t.expired!.text, /expired on 2026-11-15/);
    assert.match(t.expired!.text, /requests, the agent's words, the call lines/);
    assert.ok(t.missing.includes(t.expired!.text));
    assert.deepEqual(t.unplaced.map((c) => [c.file, c.after.sha256, c.credit.text]), [
      ["notes.md", "n1", "credited to a call whose record expired"],
      ["notes.md", "n2", "credited to a call whose record expired"],
      ["notes.md", "n3", "credited to a call whose record expired"],
    ]);
    assert.equal(t.unplaced[0]!.format, null);
  });

  it("ignores any op that survived, so an expired task never shows words", () => {
    const t = timelineOf("directWriter", { valuesExpiredAt: "2026-11-15T00:00:00.000Z" });
    assert.equal(t.requests.length, 0);
    assert.ok(!JSON.stringify(t).includes("Writing the notes"));
  });
});

describe("the validator", () => {
  it("moves with the highest op id, the highest state id, the expiry stamp and the schema's build, and with nothing else", () => {
    const f = fixtures.directWriter!();
    const base = { ops: f.ops, fileStates: f.fileStates, valuesExpiredAt: null, removals: [], build: "b1" };
    const tag = timelineEtag(base);
    assert.equal(timelineEtag({ ...base, ops: [...f.ops] }), tag);
    assert.notEqual(timelineEtag({ ...base, ops: [...f.ops, { id: 999, args_json: "{}" }] }), tag);
    assert.notEqual(timelineEtag({ ...base, fileStates: [...f.fileStates, { ...f.fileStates[0]!, id: 999 }] }), tag);
    assert.notEqual(timelineEtag({ ...base, valuesExpiredAt: "2026-11-15T00:00:00.000Z" }), tag);
    assert.notEqual(timelineEtag({ ...base, build: "b2" }), tag);
    assert.match(tag, /^"[0-9a-f]{32}"$/);
  });
});

describe("what never reaches the body", () => {
  const SECRET_ARG = "SENTINEL_ARG_7c1e";
  const OUTSIDE_DIR = "/Users/outsider-SENTINELDIR/private";
  const f = (): Fixture => ({
    ops: [
      call("k1", { host: "codex", desc: "", cmd: `python3 build.py --token=${SECRET_ARG} && curl -d ${SECRET_ARG} https://example.test/x`, named: ["/w/a.xlsx", `${OUTSIDE_DIR}/secret.xlsx`], at: 10, extra: { outsideRefs: [{ path: `${OUTSIDE_DIR}/ref.txt` }], workedIn: [{ path: OUTSIDE_DIR }] } }),
      call("k2", { desc: `Copy it to ${OUTSIDE_DIR}/copy.xlsx and ${"/w/inside/ok.txt"}`, named: [`${OUTSIDE_DIR}/copy.xlsx`], at: 20, said: `Looking at ${OUTSIDE_DIR}/notes.txt first.` }),
      call("k3", { tool: "Bash", desc: "", cmd: `echo ${SECRET_ARG} > /w/out.txt`, at: 30 }),
      prompt("s1", [`Please read ${OUTSIDE_DIR}/brief.docx`]),
      stop("s1", `All done, see ${OUTSIDE_DIR}/result.txt.`),
    ],
    fileStates: [state("/w/a.xlsx", "a1", "a0", { open: ["k1"], credited: ["k1"] })],
  });

  it("holds neither the raw command nor a directory outside the watched folder", () => {
    const body = JSON.stringify(buildTimeline(input(f())));
    assert.ok(!body.includes(SECRET_ARG), "a command argument leaked");
    assert.ok(!body.includes("curl"), "the raw command leaked");
    assert.ok(!body.includes("build.py --token"), "the raw command leaked");
    assert.ok(!body.includes("SENTINELDIR"), "an outside directory leaked");
    assert.ok(!body.includes("/Users/"), "an absolute outside path leaked");
    assert.ok(!body.includes("outsideRefs"));
  });

  it("cuts an outside path in text to its file name and says so; a path inside the folder becomes relative", () => {
    const t = buildTimeline(input(f()));
    const k2 = allCalls(t).find((c) => c.id === "k2")!;
    assert.equal(k2.line.text, "Looking at notes.txt first.");
    assert.equal(k2.line.redacted, true);
    assert.equal(t.requests[0]!.texts[0]!.text, "Please read brief.docx");
    assert.equal(t.requests[0]!.closing!.text, "All done, see result.txt.");
    assert.ok(t.missing.some((m) => /outside the watched folder in the text below/.test(m)));
    const k1 = allCalls(t).find((c) => c.id === "k1")!;
    assert.deepEqual(k1.files, ["a.xlsx"]);
    assert.ok(k1.missing.some((m) => /outside the watched folder/.test(m)));
    const inside = buildTimeline(input({ ...f(), ops: [call("z", { desc: "Wrote /w/inside/ok.txt", at: 1 }), prompt("s1", ["Hi."])] }));
    assert.equal(allCalls(inside)[0]!.line.text, "Wrote inside/ok.txt");
  });

  it("keeps URLs and slashes in prose as they are", () => {
    const ops = [call("u", { desc: "Open https://example.com/a/b and divide by /2 and/or 3/4", at: 1 }), prompt("s1", ["Hi."])];
    assert.equal(allCalls(buildTimeline(input({ ops, fileStates: [] })))[0]!.line.text, "Open https://example.com/a/b and divide by /2 and/or 3/4");
  });
});
