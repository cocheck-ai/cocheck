import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type FormatChanges, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel, type RailStop } from "../src/timeline/rail/model.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// Helper 1 ran `rm unrate.raw` while Helper 2 overlapped; write-signal had no deletion verb, so the delete stayed shared.
// A deleted file now narrows to the one call whose text deletes that file. A glob, a variable path or another file's name never does.

const FMT: FormatChanges = { module: "docx", rows: [], more: 0 };
const h1 = { agent_id: "a48db86bffe4b2e8d", agent_type: "general-purpose" };
const h2 = { agent_id: "aedabc4ba4af060d1", agent_type: "general-purpose" };
const DIR = "/Users/user/Desktop/quarterly-report/claude/data";
const RAW = `${DIR}/unrate.raw`;
// the two real command lines of ops 1131 (Helper 1) and 1132 (Helper 2)
const RM1 = `cd ${DIR} && awk -F, 'NR==1{print "date,UNRATE";next} {gsub(/\\r/,"");print}' unrate.raw > unrate.csv && rm unrate.raw && ls && wc -l unrate.csv && head -2 unrate.csv`;
const CURL2 = `mkdir -p ${DIR} && cd ${DIR} && curl -sL "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL&cosd=2015-01-01&coed=2025-12-31" -o cpi.csv; head -3 cpi.csv; tail -3 cpi.csv; wc -l cpi.csv`;

const build = (ops: RawOp[], states: RawState[]): { body: Timeline; model: RailModel } => {
  const input = { taskId: 1, build: "b", ops, fileStates: states, folder: DIR, valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map(states.map((s) => [s.id, FMT])), quickLook: false, host: "claude" } as TimelineInput;
  const body = JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline;
  return { body, model: buildRailModel(body) };
};
const changeStops = (m: RailModel): RailStop[] => m.stops.filter((s) => s.change);
const owners = (b: Timeline): string[] => b.requests.flatMap((r) => r.runs.flatMap((u) => u.calls)).filter((x) => x.changes.length > 0).map((x) => x.id);

const run = (c1: string, c2: string, file = RAW, input1?: unknown) => {
  const ops = [
    prompt("s1", ["Build the workbook."]),
    call("c1", { at: 10, end: 40, cmd: c1, input: input1 ?? { command: c1 }, extra: h1 }),
    call("c2", { at: 15, end: 30, cmd: c2, input: { command: c2 }, extra: h2 }),
    stop("s1"),
  ];
  const del = { ...state(file, "n1", "n0", { open: ["c1", "c2"], credited: ["c1", "c2"], step: 3 }), kept: "gone" };
  return build(ops, [del]);
};

describe("a deleted file goes to the call that deletes it", () => {
  it("Helper 1's `rm unrate.raw` owns the delete, not Helper 2's curl", () => {
    const { body, model } = run(RM1, CURL2);
    assert.deepEqual(owners(body), ["c1"]);
    assert.equal(changeStops(model)[0]!.lane, "agent:1");
  });
  for (const [name, cmd] of [["rm -f", `cd ${DIR} && rm -f unrate.raw`], ["unlink", `cd ${DIR} && unlink unrate.raw`], ["full path", `rm ${RAW}`], ["after --", `cd ${DIR} && rm -- unrate.raw`], ["python", `python3 -c "import os; os.remove('${RAW}')"`], ["python unlink", `python3 -c "from pathlib import Path; Path('${RAW}').unlink()"`], ["node", `node -e "require('fs').unlinkSync('${RAW}')"`]] as const) {
    it(`${name} narrows`, () => assert.deepEqual(owners(run(cmd, CURL2).body), ["c1"]));
  }
  it("a delete verb inside a tool input script field narrows", () => {
    assert.deepEqual(owners(run("x", CURL2, RAW, { script: `import os\nos.remove("${RAW}")` }).body), ["c1"]);
  });
});

describe("no delete signal means shared, never a wrong credit", () => {
  const joint = (c1: string, c2 = CURL2, file = RAW) => assert.equal(changeStops(run(c1, c2, file).model)[0]!.lane, "unsure");
  it("a glob stays shared", () => joint(`cd ${DIR} && rm unrate.*`));
  it("a variable path stays shared", () => joint(`cd ${DIR} && F=unrate.raw && rm $F`));
  it("a delete naming a different file stays shared", () => joint(`cd ${DIR} && rm unrate.csv`));
  it("a file with the same ending but another name stays shared", () => joint(`cd ${DIR} && rm old_unrate.raw`));
  it("a delete of the same name in another folder stays shared", () => joint(`rm /elsewhere/unrate.raw`));
  it("a bare name after a cd to another folder stays shared", () => joint(`cd /elsewhere && rm unrate.raw`));
  it("a read of the file is no delete signal", () => joint(`cd ${DIR} && cat unrate.raw`));
  it("two calls that both delete it stay shared", () => joint(`rm ${RAW}`, `rm -f ${RAW}`));
  it("a write signal does not credit a delete", () => joint(`cp /tmp/x ${RAW}`));
});
