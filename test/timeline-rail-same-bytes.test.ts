import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// the recorded run's sequence (Codex, task 18), paths made neutral. The memo (docx) has v1, v2, v3; the page image (png) v1 and v2, v2 built
// from the docx v2 by a render. The call that wrote docx v3 also re-rendered the png with the same bytes: the record holds no png row, only
// the op's `sameBytesRewrites` note. The png must not read as Stale against docx v3 then; with no note, or a note from before docx v3, it stays Stale.
const W = "/work/drive/";
const sha = (c: string): string => c.repeat(64);
const DOCX = "memo.docx", PNG = "memo_render/page-1.png";
type Step = { id: string; at: number; file: string; now: string; prev: string | null; cmd: string; rewrote?: string[] };
function build(steps: Step[]): RailModel {
  const ops = steps.map((s) => call(s.id, { at: s.at, end: s.at + 4, cmd: s.cmd, named: s.cmd.startsWith("cat ") ? [W + DOCX] : [], input: { command: s.cmd }, extra: { startSeq: s.at, ...(s.rewrote ? { sameBytesRewrites: s.rewrote } : {}) } }));
  const fileStates = steps.filter((s) => s.now !== "").map((s) => state(W + s.file, sha(s.now), s.prev === null ? null : sha(s.prev), { open: [s.id], credited: [s.id] }));
  const input: TimelineInput = { taskId: 5, build: "t", ops: [...ops, prompt("s1", ["Write the memo."], { requests: [{ seq: 1, at: 0, firstStep: null }] }), stop("s1", "done")], fileStates, folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map() };
  return buildRailModel(buildTimeline(input));
}
const write = (id: string, at: number, now: string, prev: string | null, rewrote?: string[]): Step => ({ id, at, file: DOCX, now, prev, cmd: `python3 build_memo.py > ${DOCX}`, ...(rewrote ? { rewrote } : {}) });
const render = (id: string, at: number, now: string, prev: string | null): Step => ({ id, at, file: PNG, now, prev, cmd: `cat ${DOCX} > ${PNG}` });
// a call that changed no file (so no state row): the same-bytes re-render
const quiet = (id: string, at: number, rewrote?: string[]): Step => ({ id, at, file: PNG, now: "", prev: null, cmd: `cat ${DOCX} > ${PNG}`, ...(rewrote ? { rewrote } : {}) });
const base = [write("d1", 10, "a", null), render("r1", 20, "x", null), write("d2", 30, "b", "a"), render("r2", 40, "y", "x")];
const png = (m: RailModel) => m.files.find((f) => f.file.endsWith("page-1.png"))!;
const stale = (m: RailModel) => (png(m).versions[png(m).versions.length - 1]!.stale ?? []).length;

describe("same-bytes rewrite is re-production", () => {
  it("control: the png built from docx v2 is Stale once docx v3 exists and nothing rewrote it", () => {
    assert.equal(stale(build([...base, write("d3", 60, "c", "b")])), 1);
  });
  it("the call that made docx v3 also rewrote the png with the same bytes: not Stale", () => {
    assert.equal(stale(build([...base, write("d3", 60, "c", "b", [PNG])])), 0);
  });
  it("a later call that rewrote the png with the same bytes (started after docx v3): not Stale", () => {
    assert.equal(stale(build([...base, write("d3", 60, "c", "b"), quiet("r3", 70, [PNG])])), 0);
  });
  it("a same-bytes rewrite from before docx v3 does not clear it", () => {
    assert.equal(stale(build([...base, quiet("r3", 50, [PNG]), write("d3", 60, "c", "b")])), 1);
  });
  it("the input changes again after the rewrite: Stale", () => {
    assert.equal(stale(build([...base, write("d3", 60, "c", "b", [PNG]), write("d4", 80, "d", "c")])), 1);
  });
  it("a rewrite of another file does not clear it", () => {
    assert.equal(stale(build([...base, write("d3", 60, "c", "b", ["other.png"])])), 1);
  });
});
