import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { callReadsUnknown, scriptReadsUnknown } from "../src/timeline/read-signal.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// "couldn't tell what this script read". The scripts are the recorded run's two real build scripts (Claude's: every read a literal; Codex's: a helper that opens `(ROOT/'data'/name)`).

const fx = (n: string): string => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const CLAUDE = fx("build-econ-workbook.py.txt"), CODEX = fx("build-econ-workbook-codex.py.txt");

describe("scriptReadsUnknown", () => {
  it("recorded run Claude script (every read a literal) is not unknown", () => assert.equal(scriptReadsUnknown(CLAUDE), false));
  it("recorded run Codex script ((ROOT/'data'/name).open() in a helper) is unknown, never clean", () => assert.equal(scriptReadsUnknown(CODEX), true));
  const unknown: Array<[string, string]> = [
    ["a loop variable", 'for n in ["a.csv", "b.csv"]:\n    open(n)\n'],
    ["an f-string", 'k = 3\nopen(f"data/{k}.csv")\n'],
    ["a join with a loop name", 'from pathlib import Path\nROOT = Path(__file__).parent\nfor n in names:\n    (ROOT / "data" / n).open()\n'],
    ["pandas read of a computed path", 'import pandas as pd\nfor n in names:\n    pd.read_csv("data/" + n)\n'],
    ["read_text on a loop name", 'for p in files:\n    p.read_text()\n'],
    ["a parameter called with a loop name", 'def load(path):\n    return open(path).read()\nfor n in names:\n    load(n)\n'],
  ];
  for (const [name, src] of unknown) it("is unknown for" + name, () => assert.equal(scriptReadsUnknown(src), true));
  const known: Array<[string, string]> = [
    ["a literal open", 'open("data/a.csv")\n'],
    ["a name assigned a literal", 'P = "data/a.csv"\nimport pandas as pd\npd.read_csv(P)\n'],
    ["Path literal read_text", 'from pathlib import Path\nPath("a.txt").read_text()\n'],
    ["a write with a computed path", 'for n in names:\n    open(n, "w").write("x")\n'],
    ["no file opening at all", 'print(1)\n'],
    ["a read in a comment only", '# open(name)\nprint(1)\n'],
    ["pandas read of a file handle from a literal open", 'import pandas as pd\nwith open("a.csv") as f:\n    pd.read_csv(f)\n'],
  ];
  for (const [name, src] of known) it("is not unknown for" + name, () => assert.equal(scriptReadsUnknown(src), false));
});

const W = "/Users/user/Desktop/quarterly-report/";
const D = W + "claude/";
const sha = (c: string): string => c.repeat(64);
const RUN = "python3 build_workbook.py";
type Step = { id: string; at: number; file: string; now: string; prev: string | null; cmd: string };
function build(steps: Step[], script: string | null): RailModel {
  const ops = steps.map((s) => call(s.id, { at: s.at, end: s.at + 4, cmd: s.cmd, named: [], extra: { startSeq: s.at } }));
  ops.push(call("w1", { tool: "Write", at: 1, end: 2, cmd: "Write", extra: { startSeq: 1, toolLabel: { fields: { file_path: D + "build_workbook.py" } } } }));
  const fileStates = [state(D + "build_workbook.py", sha("d"), null, { open: ["w1"], credited: ["w1"] }),
    ...steps.map((s) => state(D + s.file, sha(s.now), s.prev === null ? null : sha(s.prev), { open: [s.id], credited: [s.id] }))];
  const input: TimelineInput = { taskId: 5, build: "t", ops: [...ops, prompt("s1", ["Build."], { requests: [{ seq: 1, at: 0, firstStep: null }] }), stop("s1", "done")], fileStates, folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map(script === null ? [] : [[sha("d"), script]]) };
  return buildRailModel(buildTimeline(input));
}
const CPI = "data/cpi.csv", XLS = "out.xlsx";
const mk = (id: string, at: number, file: string, now: string, prev: string | null, cmd = file === XLS ? RUN : `curl -sL https://x/${id} -o ${file}`): Step => ({ id, at, file, now, prev, cmd });
// the workbook has two versions, both built from cpi.csv v1; the script is Claude's (literal reads), Codex's, or missing
const steps = [mk("p1", 10, CPI, "a", null), mk("r1", 40, XLS, "x", null), mk("r2", 50, XLS, "y", "x")];
const file = (m: RailModel, f: string) => m.files.find((x) => x.file.endsWith(f))!;
const unknownOf = (m: RailModel, f: string) => file(m, f).versions.map((v) => v.unknownReads === true);

describe("the model", () => {
  it("a script with only literal reads leaves no version unknown", () => assert.deepEqual(unknownOf(build(steps, CLAUDE), XLS), [false, false]));
  it("the Codex recorded run script marks the versions it made unknown", () => assert.deepEqual(unknownOf(build(steps, CODEX), XLS), [true, true]));
  it("a script whose text is missing marks the versions it made unknown", () => assert.deepEqual(unknownOf(build(steps, null), XLS), [true, true]));
  it("a version made by a plain download is not unknown", () => assert.deepEqual(unknownOf(build(steps, null), CPI), [false]));
  it("a version superseded by a later one shows no stale flag even when its input changed since", () => {
    const m = build([...steps, mk("p2", 60, CPI, "b", "a")], CLAUDE);
    assert.equal(file(m, XLS).versions[0]!.stale, undefined);
    assert.equal(file(m, XLS).versions[1]!.stale?.length, 1);
  });
});

type E = { style: unknown; append: (...k: unknown[]) => void; tag: string; attrs: Record<string, unknown>; kids: unknown[]; text: () => string };
function fv() {
  const g: Record<string, unknown> = {};
  vm.runInContext(readFileSync(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), vm.createContext(Object.assign(g, { globalThis: g })));
  return g.CoCheckFilesView as Record<string, (...a: unknown[]) => unknown>;
}
const el = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): E => {
  const flat = kids.flat().filter((k) => k !== "" && k !== null && k !== undefined);
  return { style: { setProperty() {} }, append: (...k: unknown[]) => { flat.push(...k.flat()); }, tag, attrs, kids: flat, text: () => flat.map((k) => (typeof k === "string" ? k : (k as E).text())).join("") };
};
const all = (e: E): E[] => [e, ...e.kids.filter((k) => typeof k !== "string").flatMap((k) => all(k as E))];
const mkBox = () => { const box = { kids: [] as unknown[], textContent: "", append(...k: unknown[]) { box.kids.push(...k); } }; return box; };
const h = { el, chip: (l: string) => el("b", {}, l), name: (l: string) => "<" + l + ">", color: () => "#000", open() {}, pick() {} };

describe("the page", () => {
  const m = build(steps, CODEX);
  const xi = m.files.findIndex((f) => f.file.endsWith(".xlsx"));
  it("shows the calm note on a version, and none where the script is known", () => {
    const box = mkBox();
    fv().paintStale(box, m.files, m.files[xi], 2, h);
    assert.match(el("div", {}, ...box.kids as unknown[]).text(), /CoCheck couldn't tell everything this script read\./);
    const ok = build(steps, CLAUDE), none = mkBox();
    fv().paintStale(none, ok.files, ok.files[ok.files.findIndex((f) => f.file.endsWith(".xlsx"))], 2, h);
    assert.equal(none.kids.length, 0);
  });
  it("marks the list entry as unknown, distinct from stale, on the latest version only", () => {
    const list = mkBox();
    fv().paintList(list, m.files, 0, h);
    const cls = (list.kids as E[]).filter((e) => e.tag === "button").map((e) => e.attrs.class);
    assert.equal(cls[xi], "fi un");
    assert.equal(cls[m.files.findIndex((f) => f.file.endsWith("cpi.csv"))], "fi");
    // a file whose only unknown version is not the latest is not marked
    const older = JSON.parse(JSON.stringify(m.files)) as typeof m.files;
    delete older[xi]!.versions[1]!.unknownReads;
    const l2 = mkBox();
    fv().paintList(l2, older, 0, h);
    assert.equal(((l2.kids as E[]).filter((e) => e.tag === "button")[xi])!.attrs.class, "fi");
  });
});

// a missing script counts only when the call runs a script file by plain path whose text is neither in the call nor stored. Shapes are the tester-demo task 7 calls
// (the venv call is `python3.14 -m venv -q`, toolu_01FdaSRC...; the timeline JSON carries no command text, so the other two are traced shapes).
describe("callReadsUnknown", () => {
  const unk = (cmd: string, stored: Record<string, string> = {}): boolean => callReadsUnknown({ tool: "Bash", command: cmd, input: { command: cmd } }, (n) => (n in stored ? [stored[n]!] : []));
  it("python3 -m venv / pip / http.server are not missing scripts", () => {
    assert.equal(unk("python3.14 -m venv -q .venv"), false);
    assert.equal(unk(".venv/bin/python3 -m pip install pandas openpyxl"), false);
    assert.equal(unk("python3 -m http.server 8000"), false);
  });
  it("a script written and run in the same call is judged by its text", () => {
    assert.equal(unk("cat > m.js <<'EOF'\nconsole.log(1)\nEOF\nnode m.js"), false);
    assert.equal(unk("cat > b.py <<EOF\nopen('data/a.csv').read()\nEOF\npython3 b.py"), false);
    assert.equal(unk("cat > b.py <<EOF\nk=3\nopen(f'data/{k}.csv').read()\nEOF\npython3 b.py"), true);
  });
  it("a bystander script run by a variable path is not missing, while a known literal deck.js stays clean", () => {
    assert.equal(unk("node deck.js && python3 $SK/scripts/office/validate.py out.pptx; python3 $SK/scripts/office/soffice.py x", { "deck.js": "const p = require('pptxgenjs');" }), false);
    assert.equal(unk("node deck.js && python3 $SK/validate.py out.pptx", { "deck.js": "x" }), false);
  });
  it("a variable-path script the task wrote is judged by its text, one that it did not write is exempt", () => {
    assert.equal(unk("python3 $D/b.py", { "b.py": "k=3\nopen(f'data/{k}.csv').read()\n" }), true);
    assert.equal(unk("python3 $D/b.py", { "b.py": "open('data/a.csv').read()\n" }), false);
    assert.equal(unk("cat > b.py <<EOF\nk=3\nopen(f'data/{k}.csv').read()\nEOF\npython3 $D/b.py"), true);
    assert.equal(unk("python3 $SK/validate.py out.pptx"), false);
  });
  it("python3 build.py with no stored build.py is still missing", () => {
    assert.equal(unk("python3 build.py"), true);
    assert.equal(unk("node deck.js && python3 build.py out.pptx", { "deck.js": "x" }), true);
  });
});
