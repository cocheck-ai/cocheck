import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel, type RailStop } from "../src/timeline/rail/model.ts";
import { stopIdentities, summarize } from "../src/timeline/rail/stop-status.ts";
import { afterSignoff } from "../src/timeline/rail/passes.ts";
import { movedInto, notesOf } from "../src/review-server.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// Step paths: step titles carry the path relative to the watched folder, rail rows that share a bare name are told apart,
// and a deleted file's step says so, with its path, at the top. Equal bytes prove identical content, not where it came from, so nothing is paired
// or called moved/renamed: every record keeps its own step, and only under strict evidence (one call, sole credit, exactly one gone and
// one new with the same bytes) does each note state the literal same-content fact. Guarded against: no such fact on weaker evidence.

const W = "/w";
const sha = (c: string): string => c.repeat(64);
type Op = { file: string; kind: "new" | "gone" | "edit"; sha: string; prev?: string; by: string; also?: string; step?: number };

/** `base` files exist before the task (baseline states); `ops` are the changes, each credited to the call named in `by`. */
function build(base: Array<[string, string]>, ops: Op[]): { m: RailModel; t: ReturnType<typeof buildTimeline> } {
  const calls = [...new Set(ops.flatMap((o) => [o.by, ...(o.also ? [o.also] : [])]))];
  const raw = calls.map((id, i) => call(id, { at: 10 + i * 10, end: 14 + i * 10, cmd: "mv old-name.txt new-name.txt && rm delete-me.txt && mv sub/nested.txt nested.txt", named: [], extra: { startSeq: 10 + i * 10 } }));
  const fileStates = [
    ...base.map(([f, s]) => state(`${W}/${f}`, sha(s), null, { step: 1 })),
    ...ops.map((o) => {
      const st = state(`${W}/${o.file}`, sha(o.kind === "gone" ? o.prev! : o.sha), o.kind === "new" ? null : sha(o.prev!), { open: [o.by, ...(o.also ? [o.also] : [])], credited: [o.by, ...(o.also ? [o.also] : [])], ...(o.step !== undefined ? { step: o.step } : {}) });
      return o.kind === "gone" ? { ...st, kept: "gone" } : st;
    }),
  ];
  const input: TimelineInput = { taskId: 5, build: "t", ops: [...raw, prompt("s1", ["Tidy t05."], { requests: [{ seq: 1, at: 0, firstStep: null }] }), stop("s1", "done")], fileStates, folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  const t = buildTimeline(input);
  return { m: buildRailModel(t), t };
}
const changes = (m: RailModel): RailStop[] => m.stops.filter((s) => s.change !== undefined);
const titles = (m: RailModel): string[] => changes(m).map((s) => s.title!);

/** The live t05 shape: one shell command renamed, deleted and moved. */
const T05 = (): ReturnType<typeof build> =>
  build(
    [["t05/old-name.txt", "a"], ["t05/delete-me.txt", "b"], ["t05/sub/nested.txt", "c"]],
    [
      { file: "t05/old-name.txt", kind: "gone", sha: "", prev: "a", by: "c1" },
      { file: "t05/new-name.txt", kind: "new", sha: "a", by: "c1" },
      { file: "t05/delete-me.txt", kind: "gone", sha: "", prev: "b", by: "c1" },
      { file: "t05/sub/nested.txt", kind: "gone", sha: "", prev: "c", by: "c1" },
      { file: "t05/nested.txt", kind: "new", sha: "c", by: "c1" },
    ],
  );
/** The same shape as the Windows ledger (2026-11-03): each gone and new pair is one recorded step. */
const T05_STEPS = (): ReturnType<typeof build> =>
  build(
    [["t05/old-name.txt", "a"], ["t05/delete-me.txt", "b"], ["t05/sub/nested.txt", "c"]],
    [
      { file: "t05/new-name.txt", kind: "new", sha: "a", by: "c1", step: 20 },
      { file: "t05/old-name.txt", kind: "gone", sha: "", prev: "a", by: "c1", step: 20 },
      { file: "t05/delete-me.txt", kind: "gone", sha: "", prev: "b", by: "c1", step: 21 },
      { file: "t05/nested.txt", kind: "new", sha: "c", by: "c1", step: 22 },
      { file: "t05/sub/nested.txt", kind: "gone", sha: "", prev: "c", by: "c1", step: 22 },
    ],
  );

describe("step titles carry the path relative to the watched folder", () => {
  it("a plain create, change and delete title with their relative paths", () => {
    const { m } = build([["t05/a.txt", "a"], ["t05/b.txt", "b"]], [
      { file: "t05/a.txt", kind: "edit", sha: "x", prev: "a", by: "c1" },
      { file: "t05/b.txt", kind: "gone", sha: "", prev: "b", by: "c2" },
      { file: "t05/sub/c.txt", kind: "new", sha: "y", by: "c3" },
    ]);
    assert.deepEqual(new Set(titles(m)), new Set(["Changed t05/a.txt", "Deleted t05/b.txt", "Created t05/sub/c.txt"]));
  });
  it("rail rows with one bare name are told apart by their folders, and the page keeps that part visible", () => {
    const { m } = build([["t05/sub/nested.txt", "c"]], [
      { file: "t05/sub/nested.txt", kind: "edit", sha: "d", prev: "c", by: "c1" },
      { file: "t05/nested.txt", kind: "new", sha: "e", by: "c2" },
    ]);
    const labels = changes(m).map((s) => s.label);
    assert.deepEqual(new Set(labels), new Set(["Changed sub/nested.txt", "Created t05/nested.txt"]));
    for (const s of changes(m)) assert.ok(s.label.endsWith(s.tail!), `${s.label} keeps its tail ${s.tail}`);
    const js = readFileSync(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    assert.match(js, /s\.tail/, "the rail row keeps the distinguishing tail visible");
    // The trimmed start keeps room for its ellipsis in every row state, so "Deleted" never shrinks to a bare "D" fused to the tail.
    const css = readFileSync(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    const txh = /\.row \.lbl \.txh\{([^}]*)\}/.exec(css)![1]!;
    assert.match(txh, /text-overflow:ellipsis/);
    assert.match(txh, /min-width:(?!0[;}])[\d.]+em/, "a non-zero min-width holds the ellipsis");
    assert.match(txh, /flex:0 1000 auto/, "the start gives way before the kept tail does");
    assert.doesNotMatch(css, /\.row[^{]*\.now[^{]*\.txh\{[^}]*min-width:0/, "no row state takes that room away");
  });
  it("a name that appears once keeps the bare label", () => {
    const { m } = build([], [{ file: "t05/sub/only.txt", kind: "new", sha: "a", by: "c1" }]);
    assert.equal(changes(m)[0]!.label, "Created only.txt");
    assert.equal(changes(m)[0]!.tail, undefined);
  });
});

const noteOf = (t: ReturnType<typeof build>["t"], file: string): string =>
  [...t.unplaced, ...t.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))].find((c) => c.file === file)!.note.text;

describe("records of different steps are never paired: every record keeps its own step", () => {
  it("t05: five records, five steps, each titled with its path; no moved or renamed wording anywhere", () => {
    const { m } = T05();
    assert.deepEqual(new Set(titles(m)), new Set(["Deleted t05/old-name.txt", "Created t05/new-name.txt", "Deleted t05/delete-me.txt", "Deleted t05/sub/nested.txt", "Created t05/nested.txt"]));
    // The call's own line ("Moved old-name.txt to new-name.txt", translated from the literal mv command) is the command's words, not a claim of CoCheck's.
    const said = changes(m).flatMap((s) => [s.label, s.head, s.title, s.change!.note, s.change!.fact ?? ""]).concat(m.files.flatMap((f) => f.versions.map((v) => v.label)));
    assert.doesNotMatch(said.join("|"), /\b[Mm]oved\b|\b[Rr]enamed\b/);
  });
  it("every gone file keeps its own verdict id, and the count is of all five", () => {
    const { m, t } = T05();
    const ids = stopIdentities(m, t);
    for (const s of changes(m)) assert.ok(ids.has(s.id), s.id);
    assert.equal(summarize(m, t, []).submit.notReviewed.filter((id) => id.startsWith("chg-")).length, 5);
  });
  it("a deleted step says so at the top, with its path, and keeps the before view", () => {
    const { m } = T05();
    const del = changes(m).find((s) => s.title === "Deleted t05/delete-me.txt")!;
    assert.match(del.change!.fact!, /^Deleted: t05\/delete-me\.txt no longer exists after this step\./);
    assert.equal(del.change!.kind, "deleted");
    assert.ok(del.change!.viewUrl, "the before content is still fetched");
    assert.ok(changes(m).filter((s) => s.change!.kind !== "deleted").every((s) => s.change!.fact === undefined));
  });
});

describe("the literal same-content fact, only under strict evidence", () => {
  it("t05: each side names the other path, in the note the card, AI line and send-back read", () => {
    const { m, t } = T05();
    assert.match(noteOf(t, "t05/nested.txt"), /Same content as t05\/sub\/nested\.txt, which this call deleted\.$/);
    assert.match(noteOf(t, "t05/sub/nested.txt"), /This call created t05\/nested\.txt with the same content\.$/);
    assert.doesNotMatch(noteOf(t, "t05/delete-me.txt"), /content/);
    // The rail card of the new file keeps the sentence (the "created ... in the folder" part is trimmed as before).
    const mk = changes(m).find((s) => s.title === "Created t05/nested.txt")!;
    assert.equal(mk.change!.note, "Same content as t05/sub/nested.txt, which this call deleted.");
    assert.match(changes(m).find((s) => s.title === "Deleted t05/sub/nested.txt")!.change!.note, /This call created t05\/nested\.txt with the same content/);
  });
});

describe("no same-content fact without strict evidence", () => {
  const silent = (t: ReturnType<typeof build>["t"], files: string[]): void => { for (const f of files) assert.doesNotMatch(noteOf(t, f), /Same content|same content|moved|renamed/, f); };
  it("two gone files with the same bytes and one new", () => {
    const { t } = build([["t05/a.txt", "a"], ["t05/b.txt", "a"]], [
      { file: "t05/a.txt", kind: "gone", sha: "", prev: "a", by: "c1" },
      { file: "t05/b.txt", kind: "gone", sha: "", prev: "a", by: "c1" },
      { file: "t05/c.txt", kind: "new", sha: "a", by: "c1" },
    ]);
    silent(t, ["t05/a.txt", "t05/b.txt", "t05/c.txt"]);
  });
  it("one gone and two new with the same bytes (a copy)", () => {
    const { t } = build([["t05/a.txt", "a"]], [
      { file: "t05/a.txt", kind: "gone", sha: "", prev: "a", by: "c1" },
      { file: "t05/b.txt", kind: "new", sha: "a", by: "c1" },
      { file: "t05/c.txt", kind: "new", sha: "a", by: "c1" },
    ]);
    silent(t, ["t05/a.txt", "t05/b.txt", "t05/c.txt"]);
  });
  it("the delete and the create in different calls", () => {
    const { t } = build([["t05/sub/nested.txt", "c"]], [
      { file: "t05/sub/nested.txt", kind: "gone", sha: "", prev: "c", by: "c1" },
      { file: "t05/nested.txt", kind: "new", sha: "c", by: "c2" },
    ]);
    silent(t, ["t05/sub/nested.txt", "t05/nested.txt"]);
  });
  it("joint credit: the create shares its call with another", () => {
    const { t } = build([["t05/sub/nested.txt", "c"]], [
      { file: "t05/sub/nested.txt", kind: "gone", sha: "", prev: "c", by: "c1" },
      { file: "t05/nested.txt", kind: "new", sha: "c", by: "c1", also: "c2" },
    ]);
    silent(t, ["t05/sub/nested.txt", "t05/nested.txt"]);
  });
  it("content changed on the way", () => {
    const { t } = build([["t05/sub/nested.txt", "c"]], [
      { file: "t05/sub/nested.txt", kind: "gone", sha: "", prev: "c", by: "c1" },
      { file: "t05/nested.txt", kind: "new", sha: "d", by: "c1" },
    ]);
    silent(t, ["t05/sub/nested.txt", "t05/nested.txt"]);
  });
});

describe("a same-step, same-bytes gone and new pair is one moved or renamed step", () => {
  it("the Windows shape: one Renamed item, one Moved item, the plain delete stays", () => {
    const { m } = T05_STEPS();
    assert.deepEqual(new Set(titles(m)), new Set(["Renamed t05/old-name.txt to t05/new-name.txt", "Moved t05/sub/nested.txt to t05/nested.txt", "Deleted t05/delete-me.txt"]));
    assert.equal(changes(m).length, 3);
    const mv = changes(m).find((s) => s.moved?.kind === "moved")!;
    assert.deepEqual({ ...mv.moved, fromStop: undefined }, { from: "t05/sub/nested.txt", to: "t05/nested.txt", kind: "moved", fromStop: undefined });
    assert.match(mv.moved!.fromStop, /^chg-c\d+$/);
    assert.equal(mv.change!.file, "t05/nested.txt");
    assert.match(mv.head, /moved t05\/sub\/nested\.txt to t05\/nested\.txt$/);
    assert.equal(changes(m).find((s) => s.moved?.kind === "renamed")!.label, "Renamed new-name.txt");
  });
  it("a verdict covers the one item: the stop ids are the model's stops", () => {
    const { m, t } = T05_STEPS();
    const ids = stopIdentities(m, t);
    for (const s of changes(m)) assert.ok(ids.has(s.id), s.id);
    assert.equal(summarize(m, t, []).submit.notReviewed.filter((id) => id.startsWith("chg-")).length, 3);
  });
  it("different steps with the same bytes never pair (the T05 shape, one step per record)", () => {
    const { m } = T05();
    assert.ok(changes(m).every((s) => s.moved === undefined));
    assert.equal(changes(m).length, 5);
  });
  it("two different files that share bytes in different steps never pair", () => {
    const { m } = build([["t05/a.txt", "a"]], [
      { file: "t05/a.txt", kind: "gone", sha: "", prev: "a", by: "c1", step: 30 },
      { file: "t05/b.txt", kind: "new", sha: "a", by: "c2", step: 31 },
    ]);
    assert.ok(changes(m).every((s) => s.moved === undefined));
    assert.equal(changes(m).length, 2);
  });
  it("a copy (old file still present, so no gone record) is not a move", () => {
    const { m } = build([["t05/a.txt", "a"]], [{ file: "t05/b.txt", kind: "new", sha: "a", by: "c1", step: 40 }]);
    assert.equal(changes(m).length, 1);
    assert.equal(changes(m)[0]!.moved, undefined);
    assert.equal(changes(m)[0]!.title, "Created t05/b.txt");
  });
  it("same step, but several files with the same bytes: no pair", () => {
    const { m } = build([["t05/a.txt", "a"], ["t05/b.txt", "a"]], [
      { file: "t05/a.txt", kind: "gone", sha: "", prev: "a", by: "c1", step: 50 },
      { file: "t05/b.txt", kind: "gone", sha: "", prev: "a", by: "c1", step: 50 },
      { file: "t05/c.txt", kind: "new", sha: "a", by: "c1", step: 50 },
    ]);
    assert.ok(changes(m).every((s) => s.moved === undefined));
    assert.equal(changes(m).length, 3);
  });
  it("same step, content changed on the way: no pair", () => {
    const { m } = build([["t05/a.txt", "a"]], [
      { file: "t05/a.txt", kind: "gone", sha: "", prev: "a", by: "c1", step: 60 },
      { file: "t05/b.txt", kind: "new", sha: "d", by: "c1", step: 60 },
    ]);
    assert.ok(changes(m).every((s) => s.moved === undefined));
    assert.equal(changes(m).length, 2);
  });
});

describe("verdicts stored on the gone record's stop id are carried onto the moved item", () => {
  const row = (id: number, stopId: string, status: "failed" | "passed", ts: string) => ({ id, taskId: 5, stopId, subject: "file:t05/sub/nested.txt", fingerprint: "old", status, note: "n" + id, reviewer: "t", ts });
  const paired = (): { m: RailModel; t: ReturnType<typeof build>["t"]; old: string; mv: RailStop } => {
    const { m, t } = T05_STEPS();
    const mv = changes(m).find((s) => s.moved?.kind === "moved")!;
    return { m, t, old: mv.moved!.fromStop, mv };
  };
  it("a failed row on the old stop id blocks sign-off and is in failed", () => {
    const { m, t, old, mv } = paired();
    assert.ok(!m.stops.some((s) => s.id === old), "the gone stop has no stop of its own");
    const sum = summarize(m, t, [row(1, old, "failed", "2026-11-03T10:00:00Z")]);
    assert.deepEqual(sum.failed.map((f) => f.stop), [mv.id]);
    assert.deepEqual(sum.submit.blocking, [mv.id]);
    assert.equal(sum.submit.eligible, false);
    assert.equal(sum.stops[mv.id]!.status, "failed");
    assert.equal(sum.stops[mv.id]!.history.length, 1);
  });
  it("the newest verdict wins when both ids carry one", () => {
    const { m, t, old, mv } = paired();
    const newer = { ...row(2, mv.id, "passed", "2026-11-03T11:00:00Z"), subject: "file:t05/nested.txt", fingerprint: stopIdentities(m, t).get(mv.id)!.fingerprint };
    assert.equal(summarize(m, t, [row(1, old, "failed", "2026-11-03T10:00:00Z"), newer]).stops[mv.id]!.status, "passed");
    assert.equal(summarize(m, t, [newer, row(3, old, "failed", "2026-11-03T12:00:00Z")]).stops[mv.id]!.status, "failed");
  });
  it("a send-back that named the old id still carries the failed row", () => {
    const { m, t, old, mv } = paired();
    const sum = summarize(m, t, [row(1, old, "failed", "2026-11-03T10:00:00Z")], [{ ts: "2026-11-03T10:30:00Z", stops: [old] }]);
    assert.deepEqual(sum.failed.map((f) => f.stop), [mv.id]);
  });
  it("a sign-off that covered only the old id covers the moved stop", () => {
    const { m, t, old, mv } = paired();
    const oldChange = [...t.unplaced, ...t.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))].find((c) => `chg-${c.id}` === old)!;
    const sub = { id: 1, ts: "2026-11-03T10:00:00Z", reviewer: "t", acknowledged: [], covered: [{ stop: old, status: "not_reviewed", sha256: oldChange.after.sha256 }] } as never;
    const out = afterSignoff(m, t, [], sub);
    assert.ok(!out.newSteps.includes(mv.id));
    assert.ok(!out.changed.includes(mv.id));
  });
  it("without such a row nothing changes", () => {
    const { m, t, mv } = paired();
    assert.equal(summarize(m, t, []).stops[mv.id]!.status, "not_reviewed");
  });
  it("a note stored on the old stop id shows on the moved stop, and its region's change key follows", () => {
    const { m, old, mv } = paired();
    const oldKey = old.slice(4);
    const region = { id: 9, taskId: 5, changeKey: oldKey, side: "after", kind: "lines", sha: "", page: null, rect: { from: 1, to: 2 }, where: "", picture: false, ts: "t", linked: false };
    const ledger = { liveNotes: () => [{ id: 1, text: "look", ts: "t", regionId: 9, stopId: old }, { id: 2, text: "plain", ts: "t", regionId: null, stopId: "chg-c1" }], regionsForTask: () => [region], regionsOfRows: () => [] } as never;
    const out = notesOf(ledger, "/nowhere", 5, m) as Array<{ id: number; stop: string | null; region: { change: string } | null }>;
    assert.equal(out[0]!.stop, mv.id);
    assert.equal(out[0]!.region!.change, mv.change!.key);
    assert.equal(out[1]!.stop, "chg-c1", "a note on another stop is left alone");
  });
  it("the index tallies fold the old id into the moved one: movedInto maps gone to new by the same rule", () => {
    const st = (id: number, file: string, sha: string, prev: string | null, kept: string, stepId: number) => ({ id, stepId, filePath: file, sha256: sha, prevSha256: prev, kept }) as never;
    const into = movedInto([st(1, "/w/a/x.txt", "", "h1", "gone", 7), st(2, "/w/x.txt", "h1", null, "whole", 7), st(3, "/w/y.txt", "", "h2", "gone", 8), st(4, "/w/z.txt", "h2", null, "whole", 9), st(5, "/w/c.txt", "h3", null, "whole", 10)]);
    assert.deepEqual([...into], [["chg-c1", "chg-c2"]]);
  });
});
