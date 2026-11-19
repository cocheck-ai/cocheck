import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// a file the task read but never changed is listed under "Built from" as the file as found at task start. A build_workbook.py script reads data/unrate.csv and data/cpi.csv by `ROOT / "data/x.csv"`; here it also reads an unchanged data/recessions.csv.

const W = "/Users/user/Desktop/quarterly-report/";
const D = W + "claude/";
const sha = (c: string): string => c.repeat(64);
const label = (file: string) => ({ toolLabel: { fields: { file_path: file } } });
const RUN = "python3 build_workbook.py";
const SCRIPT = readFileSync(new URL("./fixtures/build-econ-workbook.py.txt", import.meta.url), "utf8");
const REC = D + "data/recessions.csv";

function build(opts: { script?: string; present?: string[]; readTool?: string; extraCall?: string } = {}): RailModel {
  const script = opts.script ?? SCRIPT + '\nrecessions = load(ROOT / "data/recessions.csv")\n';
  const present = new Set(opts.present ?? [REC]);
  const c = (id: string, at: number, cmd: string) => call(id, { at, end: at + 4, cmd, extra: { startSeq: at } });
  const ops = [
    c("u1", 10, "curl -sL https://fred.example/UNRATE -o data/unrate.csv"),
    c("p1", 12, "curl -sL https://fred.example/CPIAUCSL -o data/cpi.csv"),
    ...(opts.readTool ? [call("rd", { tool: "Read", at: 36, end: 37, cmd: "Read", extra: { startSeq: 36, ...label(opts.readTool) } })] : []),
    call("w1", { tool: "Write", at: 30, end: 33, cmd: "Write", extra: { startSeq: 30, ...label(D + "build_workbook.py") } }),
    c("r1", 40, opts.extraCall ?? RUN),
    prompt("s1", ["Build the workbook."], { requests: [{ seq: 1, at: 5, firstStep: null }] }),
    stop("s1", "done"),
  ];
  const f = (file: string, now: string, by: string) => state(D + file, sha(now), null, { open: [by], credited: [by] });
  const fileStates = [f("data/unrate.csv", "a", "u1"), f("data/cpi.csv", "b", "p1"), f("build_workbook.py", "d", "w1"), f("econ_data_unemployment_cpi.xlsx", "e", "r1")];
  const input: TimelineInput = {
    taskId: 5, build: "t", ops, fileStates, folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false,
    scriptTexts: new Map([[sha("d"), script]]), existsAtStart: (p) => present.has(p),
  };
  return buildRailModel(buildTimeline(input));
}

const byName = (m: RailModel, file: string) => m.files.find((x) => x.file.endsWith(file));
const inputsOf = (m: RailModel, file: string) => (byName(m, file)!.versions[0]!.inputs ?? []).map((i) => ({ name: m.files[i.file]!.file, p: i.p, why: i.why }));

describe("unchanged files the task read", () => {
  it("recorded-run shape: a script reading an unchanged CSV lists it as a source at task start, named in the script, below every changed file", () => {
    const m = build();
    const src = byName(m, "data/recessions.csv")!;
    assert.ok(src, "the source is in the files list");
    assert.deepEqual(src.versions, []);
    assert.equal(src.source, true);
    assert.equal(m.files.indexOf(src), m.files.length - 1);
    assert.ok(m.files.slice(0, -1).every((f) => f.versions.length > 0 && !f.source));
    assert.ok(inputsOf(m, "econ_data_unemployment_cpi.xlsx").some((i) => i.name === "claude/data/recessions.csv" && i.p === 0 && i.why === "script"));
  });

  it("a Read tool call of an unchanged file is a source, looked at and not an input", () => {
    const m = build({ script: "print(1)\n", readTool: D + "data/notes.csv", present: [D + "data/notes.csv"] });
    assert.ok(byName(m, "data/notes.csv")?.source);
    assert.ok(!inputsOf(m, "econ_data_unemployment_cpi.xlsx").some((i) => i.name.endsWith("notes.csv")));
    const looked = (byName(m, "econ_data_unemployment_cpi.xlsx")!.versions[0]!.looked ?? []).map((i) => m.files[i.file]!.file);
    assert.ok(looked.some((n) => n.endsWith("notes.csv")));
  });

  it("a file only written, only mentioned in a comment, outside the task folder, or not there never appears", () => {
    const sources = (m: RailModel) => m.files.filter((f) => f.source).map((f) => f.file);
    const exists = [D + "data/o.csv", D + "data/c.csv", D + "data/missing.csv", "/Users/user/Documents/other.csv"];
    assert.deepEqual(sources(build({ script: 'import pandas as pd\ndf.to_csv(ROOT / "data/o.csv")\n', present: exists })), []);
    assert.deepEqual(sources(build({ script: '# reads data/c.csv later\nprint(1)\n', present: exists })), []);
    assert.deepEqual(sources(build({ script: 'x = load("/Users/user/Documents/other.csv")\n', present: exists })), []);
    assert.deepEqual(sources(build({ script: 'x = load(ROOT / "data/missing.csv")\n', present: [] })), []);
    assert.deepEqual(sources(build({ readTool: "/Users/user/Documents/other.csv", script: "print(1)\n", present: exists })), []);
  });
});

describe("the Files view", () => {
  it("lists sources under their own heading and says what a source is", async () => {
    const g: any = {};
    vm.runInNewContext(await readFile(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), g);
    const FV = g.CoCheckFilesView;
    const src = { file: "claude/data/recessions.csv", name: "recessions.csv", start: "lost", source: true, versions: [] };
    assert.equal(FV.describe(src, 0, () => "x"), "Not changed by the task: the file as the task found it.");
    assert.equal(FV.soloOf(src, 0).say, "Content not kept.");
  });
});
