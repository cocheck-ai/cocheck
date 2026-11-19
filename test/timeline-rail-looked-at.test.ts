import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// Read-tool reads are "Looked at" (quiet, never a stale warning); "Built from" holds what the producing call names (in the script it runs, or opened in the same call).
// A file the call writes is never its input; a file a script only compares is not one either. Shapes follow a recorded run.

const W = "/Users/user/Desktop/data-prep/";
const D = W + "claude/";
const sha = (c: string): string => c.repeat(64);
const label = (file: string) => ({ toolLabel: { fields: { file_path: file } } });

interface Op { id: string; at: number; cmd: string; tool?: string; read?: string; named?: string[] }
interface St { file: string; now: string; prev?: string | null; by: string }

function build(ops: Op[], states: St[], scripts: Array<[string, string]> = []): RailModel {
  const calls = ops.map((o) => call(o.id, { at: o.at, end: o.at + 4, cmd: o.cmd, ...(o.tool ? { tool: o.tool } : {}), named: o.named ?? [], extra: { startSeq: o.at, ...(o.read ? label(D + o.read) : {}) } }));
  const fileStates = states.map((s) => state(D + s.file, sha(s.now), s.prev ? sha(s.prev) : null, { open: [s.by], credited: [s.by] }));
  const input: TimelineInput = {
    taskId: 8, build: "t", ops: [...calls, prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")], fileStates,
    folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false,
    scriptTexts: new Map(scripts.map(([k, t]) => [sha(k), t])),
  };
  return buildRailModel(buildTimeline(input));
}

const file = (m: RailModel, name: string) => m.files.find((f) => f.file.endsWith(name))!;
const names = (m: RailModel, list: Array<{ file: number; p: number }> | undefined) => (list ?? []).map((i) => m.files[i.file]!.file.replace(/^claude\//, ""));
const staleCount = (m: RailModel) => m.files.reduce((n, f) => n + f.versions.reduce((k, v) => k + (v.stale?.length ?? 0), 0), 0);

describe("Looked at vs Built from", () => {
  const made: Op[] = [{ id: "a1", at: 10, cmd: "echo a > data/a.csv" }, { id: "b1", at: 12, cmd: "echo b > data/b.csv" }];
  const madeStates: St[] = [{ file: "data/a.csv", now: "a", by: "a1" }, { file: "data/b.csv", now: "b", by: "b1" }];

  it("a file only opened with the Read tool is Looked at, is no input, and a later change to it warns nothing; the script-named input stays a chip and still warns", () => {
    const m = build(
      [...made, { id: "rd", tool: "Read", at: 20, cmd: "Read", read: "data/a.csv" }, { id: "r1", at: 30, cmd: `python3 -c "print(open('data/b.csv').read())" > out.txt` },
        { id: "e1", at: 40, cmd: "echo a2 > data/a.csv" }, { id: "e2", at: 42, cmd: "echo b2 > data/b.csv" }],
      [...madeStates, { file: "out.txt", now: "o", by: "r1" }, { file: "data/a.csv", now: "c", prev: "a", by: "e1" }, { file: "data/b.csv", now: "d", prev: "b", by: "e2" }],
    );
    const out = file(m, "out.txt").versions[0]!;
    assert.deepEqual(names(m, out.inputs), ["data/b.csv"]);
    assert.equal(out.inputs![0]!.why, "script");
    assert.deepEqual(names(m, out.looked), ["data/a.csv"]);
    assert.deepEqual((out.stale ?? []).map((s) => m.files[s.file]!.file.replace(/^claude\//, "")), ["data/b.csv"], "only the Built-from input warns");
  });

  it("a Looked-at file changing afterwards raises no stale warning at all", () => {
    const m = build(
      [...made, { id: "rd", tool: "Read", at: 20, cmd: "Read", read: "data/a.csv" }, { id: "r1", at: 30, cmd: `python3 -c "print(1)" > out.txt` }, { id: "e1", at: 40, cmd: "echo a2 > data/a.csv" }],
      [...madeStates, { file: "out.txt", now: "o", by: "r1" }, { file: "data/a.csv", now: "c", prev: "a", by: "e1" }],
    );
    assert.equal(staleCount(m), 0);
    assert.deepEqual(names(m, file(m, "out.txt").versions[0]!.looked), ["data/a.csv"]);
  });

  it("a file the call itself writes is never its input, whatever names it (structural)", () => {
    const m = build(
      [...made, { id: "r1", at: 30, cmd: `python3 -c "import pandas as pd; pd.read_csv('data/b.csv'); pd.read_csv('out.csv')" > out.csv` }],
      [...madeStates, { file: "out.csv", now: "o", by: "r1" }],
    );
    assert.deepEqual(names(m, file(m, "out.csv").versions[0]!.inputs), ["data/b.csv"]);
  });

  it("a file a script only compares (equality check, nothing written) is not an input", () => {
    const m = build(
      [...made, { id: "r1", at: 30, cmd: `touch out.bin; python3 -c "print(open('data/a.csv').read()==open('data/b.csv').read())"`, named: [D + "data/a.csv", D + "data/b.csv"] }],
      [...madeStates, { file: "out.bin", now: "o", by: "r1" }],
    );
    assert.equal(file(m, "out.bin").versions[0]!.inputs, undefined);
  });

  it("a real input that merely sits inside a comparison, in a call that writes, stays a chip", () => {
    const m = build(
      [...made, { id: "r1", at: 30, cmd: `python3 -c "import pandas as pd; print(pd.read_csv('data/a.csv').query('x==1'))" > out.txt` }],
      [...madeStates, { file: "out.txt", now: "o", by: "r1" }],
    );
    assert.deepEqual(names(m, file(m, "out.txt").versions[0]!.inputs), ["data/a.csv"]);
    const m2 = build(
      [...made, { id: "r1", at: 30, cmd: `python3 -c "import shutil; shutil.copy('data/a.csv','out.bin'); print(open('data/a.csv').read()==open('data/b.csv').read())"` }],
      [...madeStates, { file: "out.bin", now: "o", by: "r1" }],
    );
    assert.ok(names(m2, file(m2, "out.bin").versions[0]!.inputs).includes("data/a.csv"), "a script that copies is not a check");
  });

  it("c129 shape: a deck built by `node build.js` keeps the PNGs the script names as chips, even when the agent also Read them", () => {
    const js = `const s = pptx.addSlide();\ns.addImage({ path: P + 'output/mvo_frontier.png' });\ns.addImage({ path: P + 'output/mvo_weights.png' });\npptx.writeFile({ fileName: 'deck.pptx' });\n`;
    const m = build(
      [{ id: "p1", at: 10, cmd: "echo 1 > output/mvo_frontier.png" }, { id: "p2", at: 12, cmd: "echo 2 > output/mvo_weights.png" },
        { id: "rd", tool: "Read", at: 20, cmd: "Read", read: "output/mvo_frontier.png" },
        { id: "w1", tool: "Write", at: 25, cmd: "Write", read: "build.js" }, { id: "r1", at: 30, cmd: "node build.js" }],
      [{ file: "output/mvo_frontier.png", now: "a", by: "p1" }, { file: "output/mvo_weights.png", now: "b", by: "p2" }, { file: "build.js", now: "j", by: "w1" }, { file: "deck.pptx", now: "d", by: "r1" }],
      [["j", js]],
    );
    const v = file(m, "deck.pptx").versions[0]!;
    assert.deepEqual(names(m, v.inputs).sort(), ["build.js", "output/mvo_frontier.png", "output/mvo_weights.png"]);
    assert.ok(v.inputs!.filter((i) => m.files[i.file]!.file.endsWith(".png")).every((i) => i.why === "script"));
    assert.equal(v.looked, undefined, "a file that is a chip is not also Looked at");
  });

  it("a bare name next to the folder the call names resolves inside that folder, not to a same-named file elsewhere", () => {
    const js = `const D = 'output/deck/';\ns.addImage({ path: D + 'x.png' });\n`;
    const m = build(
      [{ id: "p1", at: 10, cmd: "echo 1 > output/x.png" }, { id: "p2", at: 12, cmd: "echo 2 > output/deck/x.png" },
        { id: "w1", tool: "Write", at: 25, cmd: "Write", read: "build.js" }, { id: "r1", at: 30, cmd: "node build.js" }],
      [{ file: "output/x.png", now: "a", by: "p1" }, { file: "output/deck/x.png", now: "b", by: "p2" }, { file: "build.js", now: "j", by: "w1" }, { file: "deck.pptx", now: "d", by: "r1" }],
      [["j", js]],
    );
    const got = names(m, file(m, "deck.pptx").versions[0]!.inputs);
    assert.ok(got.includes("output/deck/x.png"));
    assert.ok(!got.includes("output/x.png"));
  });

  it("two folders the call names both hold the bare name: it is not pinned to either", () => {
    const js = `const A = 'output/deck/';\nconst B = 'output/';\ns.addImage({ path: A + 'a.png' });\n`;
    const m = build(
      [{ id: "p1", at: 10, cmd: "echo 1 > output/a.png" }, { id: "p2", at: 12, cmd: "echo 2 > output/deck/a.png" },
        { id: "w1", tool: "Write", at: 25, cmd: "Write", read: "build.js" }, { id: "r1", at: 30, cmd: "node build.js" }],
      [{ file: "output/a.png", now: "a", by: "p1" }, { file: "output/deck/a.png", now: "b", by: "p2" }, { file: "build.js", now: "j", by: "w1" }, { file: "deck.pptx", now: "d", by: "r1" }],
      [["j", js]],
    );
    const got = names(m, file(m, "deck.pptx").versions[0]!.inputs);
    assert.ok(!got.includes("output/a.png") && !got.includes("output/deck/a.png"));
  });
});
