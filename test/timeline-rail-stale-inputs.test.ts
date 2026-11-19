import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// Only a file's latest version is judged, so the recorded run's workbook v1 and v2 no longer flag. The cases that need a flag use `open` (the workbook's final
// version, v2, read cpi.csv v2 and cpi.csv changed to v3 after it).
// The stale-input flag. Recorded order: cpi.csv v1 and v2 exist, the workbook's v1 and v2 are built from cpi.csv v2, cpi.csv then changes to v3,
// and the workbook's v3 is built from cpi.csv v3. The shapes are the recorded run's fixture (same paths, same RUN line).

const W = "/Users/user/Desktop/quarterly-report/";
const D = W + "claude/";
const sha = (c: string): string => c.repeat(64);
const RUN = 'python3 build_workbook.py && which soffice libreoffice 2>/dev/null; ls /Applications | grep -i -E "libre|excel|numbers"';
const SCRIPT = readFileSync(new URL("./fixtures/build-econ-workbook.py.txt", import.meta.url), "utf8");

type Step = { id: string; at: number; file: string; now: string; prev: string | null; cmd: string };
function build(steps: Step[]): RailModel {
  const ops = steps.map((s) => call(s.id, { at: s.at, end: s.at + 4, cmd: s.cmd, named: [], extra: { startSeq: s.at } }));
  ops.push(call("w1", { tool: "Write", at: 1, end: 2, cmd: "Write", extra: { startSeq: 1, toolLabel: { fields: { file_path: D + "build_workbook.py" } } } }));
  const fileStates = [state(D + "build_workbook.py", sha("d"), null, { open: ["w1"], credited: ["w1"] }),
    ...steps.map((s) => state(D + s.file, sha(s.now), s.prev === null ? null : sha(s.prev), { open: [s.id], credited: [s.id] }))];
  const input: TimelineInput = { taskId: 5, build: "t", ops: [...ops, prompt("s1", ["Build."], { requests: [{ seq: 1, at: 0, firstStep: null }] }), stop("s1", "done")], fileStates, folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map([[sha("d"), SCRIPT]]) };
  return buildRailModel(buildTimeline(input));
}
const CPI = "data/cpi.csv", XLS = "econ_data_unemployment_cpi.xlsx";
const mk = (id: string, at: number, file: string, now: string, prev: string | null, cmd = file === XLS ? RUN : `curl -sL https://x/${id} -o ${file}`): Step => ({ id, at, file, now, prev, cmd });
const real = [mk("p1", 10, CPI, "a", null), mk("p2", 12, CPI, "b", "a"), mk("r1", 40, XLS, "x", null), mk("r2", 50, XLS, "y", "x"), mk("p3", 60, CPI, "c", "b"), mk("r3", 70, XLS, "z", "y")];
const open = real.slice(0, 5);
const file = (m: RailModel, f: string) => m.files.find((x) => x.file.endsWith(f))!;
const staleOf = (m: RailModel, f: string, vi: number) => (file(m, f).versions[vi]!.stale ?? []).map((s) => ({ name: m.files[s.file]!.name, p: s.p, newer: s.newer }));

describe("the model", () => {
  it("flags the latest version when it read cpi.csv v2 and cpi.csv v3 came after, and no earlier version", () => {
    const m = build(open);
    assert.equal(file(m, XLS).versions[0]!.stale, undefined);
    assert.deepEqual(staleOf(m, XLS, 1), [{ name: "cpi.csv", p: 2, newer: 3 }]);
    assert.equal(file(m, CPI).versions[0]!.stale, undefined);
    const s = file(m, XLS).versions[1]!.stale![0]!;
    assert.equal(s.newerLane, file(m, CPI).versions[2]!.lane);
    assert.equal(s.newerChip, file(m, CPI).versions[2]!.chip);
  });
  it("flags nothing on the full run: v1 and v2 are superseded, v3 read the latest cpi.csv", () => {
    const m = build(real);
    for (let i = 0; i < 3; i++) assert.equal(file(m, XLS).versions[i]!.stale, undefined);
  });
  it("never flags an input that changed only before the read", () => {
    const m = build(real.slice(0, 4));
    assert.equal(staleOf(m, XLS, 0).length, 0);
    assert.equal(staleOf(m, XLS, 1).length, 0);
  });
  it("never flags a rewrite with identical bytes (a later version with the same sha as the one read)", () => {
    const m = build([mk("p1", 10, CPI, "a", null), mk("r1", 40, XLS, "x", null), mk("p2", 60, CPI, "a", "a"), mk("p3", 65, CPI, "b", "a"), mk("p4", 68, CPI, "a", "b")]);
    assert.ok((file(m, XLS).versions[0]!.inputs ?? []).length > 0, "the read is seen");
    assert.equal(staleOf(m, XLS, 0).length, 0, JSON.stringify(file(m, CPI).versions.map((v) => v.sha)));
  });
  it("flags only the version that read the stale input, never one built from it", () => {
    const m = build([...open, mk("q1", 80, "out/summary.csv", "s", null, "cat econ_data_unemployment_cpi.xlsx > out/summary.csv")]);
    const q = m.files.find((f) => f.file.endsWith("summary.csv"));
    assert.equal(q?.versions[0]?.stale, undefined);
  });
});

// the page half: files-view.js alone, with a minimal element builder
type E = { append: (...k: unknown[]) => void; style: Record<string, unknown>; tag: string; attrs: Record<string, unknown>; kids: unknown[]; text: () => string };
function pageFns() {
  const g: Record<string, unknown> = {};
  vm.runInContext(readFileSync(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), vm.createContext(Object.assign(g, { globalThis: g })));
  return g.CoCheckFilesView as Record<string, (...a: unknown[]) => unknown>;
}
const el = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): E => {
  const flat = kids.flat().filter((k) => k !== "" && k !== null && k !== undefined);
  const e: E = { tag, attrs, kids: flat, style: { setProperty() {} }, append: (...k: unknown[]) => { e.kids.push(...k.flat()); }, text: () => flat.map((k) => (typeof k === "string" ? k : (k as E).text())).join("") };
  return e;
};
const all = (e: E): E[] => [e, ...e.kids.filter((k) => typeof k !== "string").flatMap((k) => all(k as E))];
const mkBox = () => { const box = { kids: [] as unknown[], textContent: "", append(...k: unknown[]) { box.kids.push(...k); } }; return box; };

describe("the page", () => {
  const m = build(open);
  const xi = m.files.findIndex((f) => f.file.endsWith(".xlsx"));
  const h = (opened: Array<[number, number]>) => ({ el, chip: (l: string) => el("b", {}, l), name: (l: string) => "<" + l + ">", color: () => "#000", open: (f: number, p: number) => opened.push([f, p]) });
  it("shows a warning naming both versions and actors, and its button opens the newer input version", () => {
    const opened: Array<[number, number]> = [];
    const box = mkBox();
    pageFns().paintStale(box, m.files, m.files[xi], 2, h(opened));
    const w = el("div", {}, ...box.kids);
    assert.match(w.text(), /cpi\.csv v2 by <.*>\. cpi\.csv changed afterwards: v3 by <.*>\./);
    const b = all(w).find((e) => e.tag === "button")!;
    assert.equal(b.text(), "Open cpi.csv v3");
    (b.attrs.onclick as () => void)();
    assert.deepEqual(opened, [[m.files.findIndex((f) => f.file.endsWith("cpi.csv")), 3]]);
  });
  it("shows nothing on a version the file later superseded", () => {
    const box = mkBox();
    pageFns().paintStale(box, m.files, m.files[xi], 1, h([]));
    assert.equal(box.kids.length, 0);
  });
  it("marks the list entry and the strip node, and no other", () => {
    const list = mkBox();
    pageFns().paintList(list, m.files, 0, h([]));
    const marked = (list.kids as E[]).filter((e) => e.attrs.class === "fi st").map((e) => e.attrs["data-file"]);
    assert.deepEqual(marked, [String(xi)]);
    const strip = mkBox();
    pageFns().paintStrip(strip, m.files[xi], 1, { ...h([]), go() {} });
    const pills = (strip.kids as E[]).map((e) => all(e).some((x) => x.attrs.class === "stl"));
    assert.deepEqual(pills, [false, false, true, false]);
  });
});
