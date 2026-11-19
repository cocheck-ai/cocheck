import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type FormatChanges, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// Create_fred_workbook.py was created (state 10937) then deleted (state 10939), yet a later new file's
// tree still drew it. The tree at a moment now leaves out a file whose latest change before that moment is a deletion, and draws it again after a recreation.
// File shapes copied from a real ledger (sha, prev_sha, kept=gone on the delete); the folder is renamed to carry no /Users path.

const FMT: FormatChanges = { module: "docx", rows: [], more: 0 };
const DIR = "/work/copilot-cli";
const PY = `${DIR}/out/create_fred_workbook.py`;
const SHA = "4370c994c11b69ac0fd62d5618d05677a7a362bea11a81fe4426097e81d8597d";
const gone = (f: string, prev: string, o: { open: string[]; step: number }) => ({ ...state(f, "", prev, { open: o.open, credited: o.open, step: o.step }), sha256: "", kept: "gone" }) as RawState;

const build = (ops: RawOp[], states: RawState[]): RailModel => {
  const input = { taskId: 19, build: "b", ops, fileStates: states, folder: DIR, valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map(states.map((s) => [s.id, FMT])), quickLook: false, host: "copilot" } as TimelineInput;
  return buildRailModel(JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline);
};
const ops = (): RawOp[] => [prompt("s1", ["Build the workbook."]), call("c1", { at: 10, end: 11, cmd: "make py" }), call("c2", { at: 20, end: 21, cmd: "rm py" }), call("c3", { at: 30, end: 31, cmd: "make csv" }), call("c4", { at: 40, end: 41, cmd: "remake py" }), call("c5", { at: 50, end: 51, cmd: "make txt" }), stop("s1")];
const made = (f: string, sha: string, c: string, step: number) => state(f, sha, null, { open: [c], credited: [c], step });
const stop_ = (m: RailModel, file: string, kind?: string) => { const s = m.stops.find((x) => x.change?.file === file.replace(DIR + "/", "") && (kind === undefined || x.change.kind === kind)); if (!s) throw new Error(JSON.stringify(m.stops.map((x) => [x.id, x.change?.file, x.change?.kind]))); return s.change!; };
const names = (rows: { t: string; name: string }[] | null) => (rows ?? []).filter((r) => r.t === "file").map((r) => r.name);
const dirCount = (rows: { t: string; name: string; count?: number }[] | null) => (rows ?? []).find((r) => r.t === "dir")?.count;

describe("a deleted file leaves the tree of every later moment", () => {
  it("create, delete, then another file's creation: the later tree has no deleted file and the right folder count", () => {
    const m = build(ops(), [made(PY, SHA, "c1", 339), gone(PY, SHA, { open: ["c2"], step: 340 }), made(`${DIR}/out/fred.csv`, "c3sha", "c3", 341)]);
    const csv = stop_(m, `${DIR}/out/fred.csv`);
    assert.ok(!JSON.stringify(csv.treeBefore).includes("create_fred_workbook"), JSON.stringify(csv.treeBefore));
    assert.ok(!JSON.stringify(csv.treeAfter).includes("create_fred_workbook"), JSON.stringify(csv.treeAfter));
    assert.deepEqual(names(csv.treeAfter), ["fred.csv"]);
    assert.equal(dirCount(csv.treeAfter), 1);
  });

  it("the deleted moment itself keeps its row and its deleted kind (the files list still marks it deleted)", () => {
    const m = build(ops(), [made(PY, SHA, "c1", 339), gone(PY, SHA, { open: ["c2"], step: 340 }), made(`${DIR}/out/fred.csv`, "c3sha", "c3", 341)]);
    assert.equal(stop_(m, PY).kind, "created");
    assert.equal(m.stops.filter((s) => s.change?.file === "out/create_fred_workbook.py").length, 2);
    assert.ok(m.stops.some((s) => s.change?.file === "out/create_fred_workbook.py" && s.change.kind === "deleted"));
    const row = m.files.find((f) => f.file === "out/create_fred_workbook.py")!;
    assert.equal(row.versions[row.versions.length - 1]!.kind, "deleted");
  });

  it("delete then recreate: the file is absent between, and back in the tree of a moment after the recreation", () => {
    const m = build(ops(), [made(PY, SHA, "c1", 339), gone(PY, SHA, { open: ["c2"], step: 340 }), made(`${DIR}/out/fred.csv`, "c3sha", "c3", 341), made(PY, "again", "c4", 342), made(`${DIR}/out/n.txt`, "c5sha", "c5", 343)]);
    const between = stop_(m, `${DIR}/out/fred.csv`);
    assert.ok(!JSON.stringify(between.treeAfter).includes("create_fred_workbook"));
    const later = stop_(m, `${DIR}/out/n.txt`);
    assert.deepEqual(names(later.treeBefore), ["create_fred_workbook.py", "fred.csv", "n.txt"]);
    assert.equal(dirCount(later.treeBefore), 3);
  });

  // A file must never vanish from a tree unless its latest change before that moment is a deletion.
  it("a file never deleted, and a file deleted then recreated, stay in every later tree (pinned)", () => {
    const m = build(ops(), [made(`${DIR}/out/keep.txt`, "k", "c1", 339), made(PY, SHA, "c1", 340), gone(PY, SHA, { open: ["c2"], step: 341 }), made(PY, "again", "c3", 342), made(`${DIR}/out/n.txt`, "c5sha", "c5", 343)]);
    const n = stop_(m, `${DIR}/out/n.txt`);
    assert.deepEqual(names(n.treeBefore), ["create_fred_workbook.py", "keep.txt", "n.txt"]);
    assert.deepEqual(names(n.treeAfter), ["create_fred_workbook.py", "keep.txt", "n.txt"]);
    assert.equal(dirCount(n.treeAfter), 3);
  });
});
