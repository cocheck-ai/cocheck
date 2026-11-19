import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// the Files list puts files deleted during the task first, then the rest; newest last change first within a group, ties by path. (Migration
// the office-deliverables group that led the list is deleted, not replaced). Shapes: recorded run (unrate.raw created then deleted, CSVs, the workbook) and a tester demo run (CSVs, workbook, memo, charts, deck).

const sha = (c: string): string => c.repeat(64);
type Step = { id: string; at: number; file: string; now: string; prev: string | null; gone?: boolean };
function build(root: string, steps: Step[]): RailModel {
  const ops = steps.map((s) => call(s.id, { at: s.at, end: s.at + 4, cmd: `curl -sL https://x/${s.id} -o ${s.file}`, named: [], extra: { startSeq: s.at } }));
  const fileStates = steps.map((s) => ({ ...state(root + s.file, sha(s.now), s.prev === null ? null : sha(s.prev), { open: [s.id], credited: [s.id] }), ...(s.gone ? { kept: "gone" } : {}) }));
  const input: TimelineInput = { taskId: 5, build: "t", ops: [...ops, prompt("s1", ["Build."], { requests: [{ seq: 1, at: 0, firstStep: null }] }), stop("s1", "done")], fileStates, folder: root.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}
const names = (m: RailModel): string[] => m.files.map((f) => f.name);

// the same recorded run, but unrate.raw is deleted AFTER the CSVs, so recency alone would put it above them
const D13 = "/Users/user/Desktop/quarterly-report/claude/";
const XLS = "econ_data_unemployment_cpi.xlsx";
const econSteps: Step[] = [
  { id: "p1", at: 10, file: "data/cpi.csv", now: "a", prev: null }, { id: "q1", at: 14, file: "data/unrate.csv", now: "c", prev: null },
  { id: "u0", at: 20, file: "data/unrate.raw", now: "r", prev: null }, { id: "u1", at: 30, file: "data/unrate.raw", now: "r", prev: "r", gone: true },
  { id: "r1", at: 40, file: XLS, now: "x", prev: null }, { id: "p2", at: 60, file: "data/cpi.csv", now: "b", prev: "a" },
];
// a tester demo run, in the ledger's order
const D14 = "/Users/user/Desktop/budget-model/claude/econ_data/";
const demo: Step[] = [
  { id: "g1", at: 10, file: "raw/CPIAUCSL.csv", now: "a", prev: null }, { id: "g2", at: 11, file: "us_inflation.csv", now: "b", prev: null },
  { id: "w1", at: 20, file: "econ_data.xlsx", now: "c", prev: null }, { id: "w2", at: 22, file: "econ_data.xlsx", now: "d", prev: "c" },
  { id: "g3", at: 23, file: "us_real_interest_rates.csv", now: "e", prev: null },
  { id: "m1", at: 30, file: "econ_data_memo.docx", now: "f", prev: null },
  { id: "c1", at: 40, file: "chart1.png", now: "g", prev: null }, { id: "c2", at: 41, file: "chart2.png", now: "h", prev: null },
  { id: "k1", at: 50, file: "econ_data_deck.pptx", now: "i", prev: null },
];

describe("files order", () => {
  it("recorded run: unrate.raw (deleted) first, then the rest by last change, the workbook among them", () => {
    assert.deepEqual(names(build(D13, econSteps)), ["unrate.raw", "cpi.csv", XLS, "unrate.csv"]);
  });
  it("tester demo: every file by last change, an office file no different", () => {
    assert.deepEqual(names(build(D14, demo)), ["econ_data_deck.pptx", "chart2.png", "chart1.png", "econ_data_memo.docx", "us_real_interest_rates.csv", "econ_data.xlsx", "us_inflation.csv", "CPIAUCSL.csv"]);
  });
  it("an office file whose latest state is deleted is in the deleted group; a live office file sits among the rest", () => {
    const m = build(D14, [{ id: "k1", at: 10, file: "deck.pptx", now: "i", prev: null }, { id: "k2", at: 20, file: "deck.pptx", now: "i", prev: "i", gone: true }, { id: "w1", at: 5, file: "w.xlsx", now: "c", prev: null }, { id: "t1", at: 30, file: "t.txt", now: "t", prev: null }, { id: "x1", at: 8, file: "x.raw", now: "x", prev: null }, { id: "x2", at: 9, file: "x.raw", now: "x", prev: "x", gone: true }]);
    assert.deepEqual(names(m), ["deck.pptx", "x.raw", "t.txt", "w.xlsx"]);
  });
  it("ties by path within a group", () => {
    const m = build(D14, [{ id: "a", at: 10, file: "b.docx", now: "a", prev: null }, { id: "b", at: 10, file: "a.docx", now: "b", prev: null }]);
    assert.deepEqual(m.files.map((f) => f.file), [...m.files.map((f) => f.file)].sort());
  });
  it("inputs still point at the right file after the regrouping", () => {
    const m = build(D13, econSteps);
    for (const f of m.files) for (const v of f.versions) for (const i of v.inputs ?? []) assert.ok(m.files[i.file], `${f.name} input ${i.file}`);
  });
});

type E = { style: unknown; append: (...k: unknown[]) => void; tag: string; attrs: Record<string, unknown>; kids: unknown[]; text: () => string };
const el = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): E => {
  const flat = kids.flat().filter((k) => k !== "" && k !== null && k !== undefined);
  return { style: { setProperty() {} }, append: (...k: unknown[]) => { flat.push(...k.flat()); }, tag, attrs, kids: flat, text: () => flat.map((k) => (typeof k === "string" ? k : (k as E).text())).join("") };
};
describe("the list", () => {
  it("a deleted file carries a small deleted mark; other files do not", () => {
    const g: Record<string, unknown> = {};
    vm.runInContext(readFileSync(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), vm.createContext(Object.assign(g, { globalThis: g })));
    const fv = g.CoCheckFilesView as Record<string, (...a: unknown[]) => unknown>;
    const m = build(D13, econSteps);
    const box = { kids: [] as unknown[], textContent: "", append(...k: unknown[]) { box.kids.push(...k); } };
    fv.paintList(box, m.files, 0, { el, chip: (l: string) => el("b", {}, l), name: (l: string) => l, color: () => "#000", open() {}, pick() {} });
    const rows = (box.kids as E[]).filter((e) => e.tag === "button");
    const marked = rows.filter((r) => /deleted/.test(r.text())).map((r) => r.text());
    assert.equal(marked.length, 1);
    assert.match(marked[0]!, /unrate\.raw/);
  });
  it("the default file is the first in order when the hash names none", () => {
    // review.js picks FILES[0] unless the hash names a file (fi = max(0, findIndex)); the model's first file is the deleted unrate.raw
    assert.equal(build(D13, econSteps).files[0]!.name, "unrate.raw");
    const src = readFileSync(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    assert.match(src, /Math\.max\(0, FILES\.findIndex/);
  });
});
