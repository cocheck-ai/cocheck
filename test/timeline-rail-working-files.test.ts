import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// Codex task 15 shape: the deck exists byte-identical in .pptx_delivery/, the top folder and a .chart-data-x/ folder, with build files in dot-folders made during the task.
// Guarded against: no real deliverable is merged away or put in the working group by default.

const W = "/w";
const sha = (c: string): string => c.repeat(64);
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// files: [path, finalSha, before sha or null (null = created in the task)]
function build(request: string, files: Array<[string, string, string | null]>): RailModel {
  const ops = files.map(([, ], i) => call(`c${i}`, { at: 10 + i * 3, end: 12 + i * 3, cmd: "python3 build.py", extra: { startSeq: 10 + i * 3 } }));
  const fileStates = files.map(([f, s, before], i) => state(W + "/" + f, s, before, { open: [`c${i}`], credited: [`c${i}`] }));
  const input: TimelineInput = { taskId: 15, build: "t", ops: [...ops, prompt("s1", [request], { requests: [{ seq: 1, at: 0, firstStep: null }] }), stop("s1", "done")], fileStates, folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}
const find = (m: RailModel, file: string) => m.files.find((f) => f.file === file)!;

const codex: Array<[string, string, string | null]> = [
  [".pptx_build/slide1.xml", sha("1"), null],
  [".pptx_build/theme.xml", sha("2"), null],
  [".tmp_fred_macro/macro.csv", sha("3"), null],
  [".pptx_delivery/deck.pptx", sha("d"), null],
  ["deck.pptx", sha("d"), null],
  ["report.md", sha("e"), null],
];

describe("working files", () => {
  const m = build("Make the macro deck.", codex);
  it("flags the dot-folder build files and not the top-level deck or report", () => {
    for (const f of [".pptx_build/slide1.xml", ".pptx_build/theme.xml", ".tmp_fred_macro/macro.csv", ".pptx_delivery/deck.pptx"]) assert.equal(find(m, f).working, true, f);
    assert.equal(find(m, "deck.pptx").working, undefined);
    assert.equal(find(m, "report.md").working, undefined);
  });
  it("ranks the top-level deck above every working file", () => {
    const at = (f: string) => m.files.indexOf(find(m, f));
    for (const w of m.files.filter((f) => f.working)) assert.ok(at("deck.pptx") < m.files.indexOf(w));
  });
  it("labels identical bytes and merges nothing", () => {
    assert.equal(find(m, ".pptx_delivery/deck.pptx").sameAs, "same bytes as deck.pptx (top folder)");
    assert.equal(find(m, "deck.pptx").sameAs, undefined, "a working twin is no reason to label the real file");
    assert.equal(m.files.filter((f) => f.name === "deck.pptx").length, 2);
  });
  it("keeps stale/inputs indices inside the list", () => {
    for (const f of m.files) for (const v of f.versions) {
      for (const i of [...(v.inputs ?? []), ...(v.looked ?? []), ...(v.stale ?? [])]) assert.ok(i.file >= 0 && i.file < m.files.length);
    }
  });
  it("does not flag a pre-existing .github/workflows/ci.yml change", () => {
    const g = build("Fix CI.", [[".github/workflows/ci.yml", sha("b"), sha("a")], [".github/workflows/new.yml", sha("c"), null]]);
    assert.equal(find(g, ".github/workflows/ci.yml").working, undefined);
    assert.equal(find(g, ".github/workflows/new.yml").working, undefined, "one pre-existing file keeps the whole folder real");
  });
  it("does not flag a request-named file inside a dot-folder", () => {
    const n = build("Save it to .pptx_delivery/deck.pptx please.", codex);
    assert.equal(find(n, ".pptx_delivery/deck.pptx").working, undefined);
    assert.equal(find(n, ".pptx_build/slide1.xml").working, true);
  });
  it("gives two empty files no sameAs", () => {
    const e = build("x", [["a.txt", EMPTY, null], ["b.txt", EMPTY, null]]);
    assert.equal(find(e, "a.txt").sameAs, undefined);
    assert.equal(find(e, "b.txt").sameAs, undefined);
  });
  it("two real files with equal bytes both stay in the main list", () => {
    const r = build("x", [["a.csv", sha("f"), null], ["out/b.csv", sha("f"), null]]);
    assert.equal(r.files.filter((f) => f.working).length, 0);
    assert.equal(find(r, "out/b.csv").sameAs, "same bytes as a.csv (top folder)");
  });
});

describe("page", () => {
  const g: Record<string, unknown> = {};
  vm.runInContext(readFileSync(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), vm.createContext(Object.assign(g, { globalThis: g })));
  const FV = g.CoCheckFilesView as Record<string, (...a: unknown[]) => unknown>;
  type E = { tag: string; attrs: Record<string, unknown>; kids: unknown[]; open?: boolean; append: (...k: unknown[]) => void; addEventListener: () => void; style: Record<string, unknown> };
  const el = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): E => { const e: E = { style: {}, tag, attrs, kids: kids.flat().filter((k) => k !== "" && k != null), append: (...k) => { e.kids.push(...k.flat()); }, addEventListener() {} }; return e; };
  const walk = (e: E): E[] => [e, ...e.kids.filter((k) => typeof k !== "string").flatMap((k) => walk(k as E))];
  const ver = [{ lane: "main", kind: "created", at: 1, label: "x", stop: "s", change: "c", sha: "x", chip: "C", kept: true }];
  const file = (name: string, extra: Record<string, unknown> = {}) => ({ file: name, name, start: "none", versions: ver, ...extra });
  const paint = (files: unknown[], sel: number): E[] => {
    const box = { kids: [] as unknown[], textContent: "", append(...k: unknown[]) { box.kids.push(...k); } };
    FV.paintList(box, files, sel, { el, chip: (l: string) => el("b", {}, l), name: (l: string) => l, color: () => "#000", pick() {} });
    return box.kids as E[];
  };
  const files = [file("a"), file("w1", { working: true }), file("w2", { working: true })];
  it("puts working files in a closed group, open when the selection is inside", () => {
    const grp = (top: E[]) => top.find((k) => k.attrs?.["data-group"] === "working")!;
    assert.ok(!grp(paint(files, 0)).open);
    assert.equal(grp(paint(files, 2)).open, true);
    assert.equal(paint(files, 0).filter((k) => k.attrs?.["data-file"] !== undefined).length, 1);
    assert.equal(walk(grp(paint(files, 0))).filter((x) => x.attrs?.["data-file"] !== undefined).length, 2);
  });
});
