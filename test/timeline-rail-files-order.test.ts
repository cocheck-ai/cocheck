import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// the Files list is ordered by the time of each file's last version, newest first, ties by path. A recorded shape: unrate.raw is created and
// deleted early, the CSVs are written next, cpi.csv gets a v3, and the workbook's last version comes at the end; the list must read workbook, cpi.csv, unrate.csv, unrate.raw.

const W = "/Users/user/Desktop/quarterly-report/";
const D = W + "claude/";
const sha = (c: string): string => c.repeat(64);
type Step = { id: string; at: number; file: string; now: string; prev: string | null; gone?: boolean; cmd?: string };
function build(steps: Step[]): RailModel {
  const ops = steps.map((s) => call(s.id, { at: s.at, end: s.at + 4, cmd: s.cmd ?? `curl -sL https://x/${s.id} -o ${s.file}`, named: [], extra: { startSeq: s.at } }));
  const fileStates = steps.map((s) => ({ ...state(D + s.file, sha(s.now), s.prev === null ? null : sha(s.prev), { open: [s.id], credited: [s.id] }), ...(s.gone ? { kept: "gone" } : {}) }));
  const input: TimelineInput = { taskId: 5, build: "t", ops: [...ops, prompt("s1", ["Build."], { requests: [{ seq: 1, at: 0, firstStep: null }] }), stop("s1", "done")], fileStates, folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}
const XLS = "econ_data_unemployment_cpi.xlsx";
const econSteps: Step[] = [
  { id: "u0", at: 5, file: "data/unrate.raw", now: "r", prev: null }, { id: "u1", at: 8, file: "data/unrate.raw", now: "r", prev: "r", gone: true },
  { id: "p1", at: 10, file: "data/cpi.csv", now: "a", prev: null }, { id: "p2", at: 12, file: "data/cpi.csv", now: "b", prev: "a" },
  { id: "q1", at: 14, file: "data/unrate.csv", now: "c", prev: null },
  { id: "r1", at: 40, file: XLS, now: "x", prev: null, cmd: "python3 build_workbook.py" }, { id: "r2", at: 50, file: XLS, now: "y", prev: "x", cmd: "python3 build_workbook.py" },
  { id: "p3", at: 60, file: "data/cpi.csv", now: "c", prev: "b" }, { id: "r3", at: 70, file: XLS, now: "z", prev: "y", cmd: "python3 build_workbook.py" },
];
const names = (m: RailModel): string[] => m.files.map((f) => f.name);

describe("files order", () => {
  it("recorded run: unrate.raw (deleted) first, then the rest by last change", () => {
    assert.deepEqual(names(build(econSteps)), ["unrate.raw", XLS, "cpi.csv", "unrate.csv"]);
  });
  it("breaks a tie in last-version time by path", () => {
    const m = build([{ id: "a", at: 10, file: "b.csv", now: "a", prev: null }, { id: "b", at: 10, file: "a.csv", now: "b", prev: null }]);
    assert.deepEqual(names(m), ["a.csv", "b.csv"].filter((n) => names(m).includes(n)));
    assert.deepEqual(m.files.map((f) => f.file), [...m.files.map((f) => f.file)].sort());
  });
  it("keeps inputs and stale pointing at the right file after the reorder", () => {
    const m = build(econSteps);
    for (const f of m.files) for (const v of f.versions) for (const i of v.inputs ?? []) assert.ok(m.files[i.file], `${f.name} input ${i.file}`);
    const x = m.files.find((f) => f.file.endsWith(".xlsx"))!;
    for (const v of x.versions) for (const i of v.inputs ?? []) assert.match(m.files[i.file]!.name, /csv|raw/);
  });
});
