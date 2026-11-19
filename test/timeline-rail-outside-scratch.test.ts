import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// an office file written outside the folder that no request names (the recorded run's synth.xlsx, filled with random numbers by a gen.py scratch script) is scratch: kept out of
// the main Files list, the folder trees and the stale warnings, in a collapsed "Outside the folder" group. Guarded against: an outside file the person's request names
// (by path or by name) stays in the main list. The rule is structural: the file name stands as a word in a typed request; no list of names.

const W = "/w";
const sha = (c: string): string => c.repeat(64);
const rd = (id: string, at: number, file: string) => call(id, { tool: "Read", at, end: at + 1, cmd: "Read", extra: { startSeq: at, toolLabel: { fields: { file_path: file } } } });

function build(request: string, outside: string[], closing = "done"): RailModel {
  const ops = [
    rd("r1", 5, W + "/data.csv"),
    call("g1", { at: 10, end: 14, cmd: "python3 gen.py", extra: { startSeq: 10 } }),
    ...outside.map((f, i) => call(`o${i}`, { at: 20 + i * 3, end: 22 + i * 3, cmd: "python3 gen.py", named: [f], extra: { startSeq: 20 + i * 3 } })),
    call("n1", { at: 50, end: 52, cmd: "touch notes/new.txt", extra: { startSeq: 50 } }),
    call("d2", { at: 60, end: 62, cmd: "curl -o data.csv x", extra: { startSeq: 60 } }),
    prompt("s1", [request], { requests: [{ seq: 1, at: 0, firstStep: null }] }),
    stop("s1", closing),
  ];
  const fileStates = [
    state(W + "/data.csv", sha("a"), null, { open: ["g1"], credited: ["g1"] }),
    ...outside.map((f, i) => state(f, sha("b"), null, { open: [`o${i}`], credited: [`o${i}`] })),
    state(W + "/notes/new.txt", sha("c"), null, { open: ["n1"], credited: ["n1"] }),
    state(W + "/data.csv", sha("d"), sha("a"), { open: ["d2"], credited: ["d2"] }),
  ];
  const input: TimelineInput = { taskId: 5, build: "t", ops, fileStates, folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}
const find = (m: RailModel, name: string) => m.files.find((f) => f.name === name);
const SYNTH = "/tmp/scratch/synth.xlsx";

describe("the model", () => {
  const m = build("Pull the data and chart it.", [SYNTH]);
  it("flags an outside file no request names as scratch, after every in-folder changed file, with no stale warning", () => {
    const s = find(m, "synth.xlsx")!;
    assert.equal(s.outside, true);
    assert.equal(m.files.findIndex((f) => f.outside), m.files.length - 1 - m.files.filter((f) => f.source).length);
    assert.ok(m.files.filter((f) => !f.outside).every((f) => f.versions.every((v) => v.stale === undefined)));
    assert.equal(s.versions.at(-1)!.stale, undefined);
  });
  it("draws it in no folder tree", () => {
    const tree = m.stops.find((st) => st.change?.file === "notes/new.txt")!.change!;
    assert.ok(tree.newFile && !tree.newFile.outside);
    assert.ok(![...(tree.treeBefore ?? []), ...(tree.treeAfter ?? [])].some((r) => JSON.stringify(r).includes("synth")));
  });
  it("keeps the step itself, so the change stays reviewable on the rail", () => {
    assert.ok(m.stops.some((st) => st.change?.file === "synth.xlsx" && st.change.newFile?.outside === true));
  });
  it("leaves every in-folder file as it was (no flag, same versions)", () => {
    const base = build("Pull the data and chart it.", []);
    const strip = (x: RailModel) => JSON.stringify(x.files.filter((f) => !f.outside).map((f) => ({ ...f, versions: f.versions.map((v) => ({ ...v, change: "", stop: "", inputs: undefined, stale: undefined })) })));
    assert.equal(strip(m), strip(base));
  });
  it("a name with no request mention is scratch whatever it is called, and so is a .pptx or .docx", () => {
    const r = build("Pull the data.", ["/tmp/q/deck.pptx", "/tmp/q/memo.docx", "/tmp/q/clean_report.xlsx"]);
    for (const n of ["deck.pptx", "memo.docx", "clean_report.xlsx"]) assert.equal(find(r, n)!.outside, true, n);
  });
});

describe("an outside file the person asked for stays listed", () => {
  const cases: Array<[string, string, string]> = [
    ["named by path", "Save the result to /Users/x/Desktop/final.xlsx please.", "/Users/x/Desktop/final.xlsx"],
    ["named by file name", "Make me a deck.pptx and put it on my desktop.", "/Users/x/Desktop/deck.pptx"],
    ["named in another case, with punctuation", "Write it as Memo.DOCX, thanks", "/Users/x/Desktop/memo.docx"],
    ["named with a space in the path (the request is cut to a mark)", "Save it as /Users/x/Desktop/my deck.pptx", "/Users/x/Desktop/my deck.pptx"],
  ];
  for (const [what, request, file] of cases) {
    it(what, () => {
      const r = build(request, [file, SYNTH]);
      const name = file.slice(file.lastIndexOf("/") + 1);
      assert.equal(find(r, name)!.outside, undefined, "asked file must not be scratch");
      assert.equal(find(r, "synth.xlsx")!.outside, true, "scratch beside it still is");
      assert.ok(r.stops.some((st) => st.change?.file === name), "its step stays");
    });
  }
  it("a name that only contains another file's name is not a mention", () => {
    const r = build("Pull the data into mysynth.xlsx.bak notes", [SYNTH]);
    assert.equal(find(r, "synth.xlsx")!.outside, true);
  });
  it("the agent's own reply naming a file is not a request", () => {
    const r = build("Pull the data.", [SYNTH], "I also wrote synth.xlsx with random numbers.");
    assert.equal(find(r, "synth.xlsx")!.outside, true);
  });
});

describe("the page", () => {
  const g: Record<string, unknown> = {};
  vm.runInContext(readFileSync(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), vm.createContext(Object.assign(g, { globalThis: g })));
  const FV = g.CoCheckFilesView as Record<string, (...a: unknown[]) => unknown>;
  type E = { style: Record<string, unknown>; tag: string; attrs: Record<string, unknown>; kids: unknown[]; open?: boolean; append: (...k: unknown[]) => void };
  const el = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): E => { const e: E = { style: {}, tag, attrs, kids: kids.flat().filter((k) => k !== "" && k != null), append: (...k) => { e.kids.push(...k.flat()); } }; return e; };
  const h = { el, chip: (l: string) => el("b", {}, l), name: (l: string) => l, color: () => "#000", pick() {} };
  const m = build("Pull the data.", [SYNTH]);
  const paint = (sel: number) => { const box = { kids: [] as unknown[], textContent: "", append(...k: unknown[]) { box.kids.push(...k); } }; FV.paintList(box, m.files, sel, h); return box.kids as E[]; };
  const walk = (e: E): E[] => [e, ...e.kids.filter((k) => typeof k !== "string").flatMap((k) => walk(k as E))];
  const names = (e: E): string[] => walk(e).filter((x) => x.attrs?.class === "nm").map((x) => String(x.kids[0]));
  it("lists no outside file in the main list; it sits in one collapsed group with where it is", () => {
    const kids = paint(0);
    const direct = kids.filter((k) => k.tag === "button").flatMap(names);
    assert.ok(!direct.includes("synth.xlsx"));
    const groups = kids.filter((k) => k.tag === "details");
    assert.equal(groups.length, 1);
    assert.notEqual(groups[0]!.open, true);
    assert.deepEqual(names(groups[0]!), ["synth.xlsx"]);
    assert.ok(JSON.stringify(groups[0]).includes("Outside the folder"));
    assert.ok(JSON.stringify(groups[0]).includes("outside the folder"));
  });
  it("opens the group when the selected file is in it", () => {
    const i = m.files.findIndex((f) => f.outside);
    assert.equal(paint(i).find((k) => k.tag === "details")!.open, true);
  });
});
