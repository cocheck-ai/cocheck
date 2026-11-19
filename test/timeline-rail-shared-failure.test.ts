import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type FormatChanges, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel, type RailStop } from "../src/timeline/rail/model.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// a change several open calls are credited with goes to one call alone only when exactly one of them shows a write signal
// for that file (a redirect or tee target, the destination of cp/mv/touch/sed -i, or the file named beside a save/write call in script or
// heredoc text). A name in a read-only command never counts, and neither does a full path in another folder. Anything less certain stays joint.
// a failed call always shows as failed on the rail. Alone, it has its own failure stop. Sharing a change with other open calls,
// the change carries the failure and names the failed call. When several open calls are credited with one change and exactly one names the
// file in its command or input text (heredoc bodies and script text included), the change is credited to that call's actor alone.
// The case: Helper 1's node script wrote econ_data_ai.pptx from a heredoc and threw while theming; Helper 2 only regenerated a memo.

const FILE = "/w/econ_data_ai.pptx";
const FMT: FormatChanges = { module: "pptx", rows: [], more: 0 };
const h1 = { agent_id: "a1", agent_type: "general-purpose" };
const h2 = { agent_id: "a2", agent_type: "general-purpose" };
const HEREDOC = "node - <<'EOF'\nconst p = new Pptx();\np.save('econ_data_ai.pptx');\nEOF";
const WRITER_VAR = "node - <<'EOF'\nconst out = 'econ_data_ai' + '.pptx';\np.save(out);\nEOF";
const ERR = "Exit code 1\nTypeError: theme is not a function";

const build = (ops: RawOp[], states: RawState[]): { body: Timeline; model: RailModel } => {
  const input = { taskId: 1, build: "b", ops, fileStates: states, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map([[states[0]!.id, FMT]]), quickLook: false, host: "claude" } as TimelineInput;
  const body = JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline;
  return { body, model: buildRailModel(body) };
};
const changeStops = (m: RailModel): RailStop[] => m.stops.filter((s) => s.change);
const shared = (a: Parameters<typeof call>[1], b: Parameters<typeof call>[1]) => {
  const ops = [prompt("s1", ["Build the deck."]), call("c1", { at: 10, end: 40, ...a }), call("c2", { at: 15, end: 30, ...b }), stop("s1")];
  return build(ops, [state(FILE, "n1", null, { open: ["c1", "c2"], credited: ["c1", "c2"] })]);
};

describe("a failed call is never silent", () => {
  // a failed call is a failure group of one, labelled with its count
  it("alone and changing no file, it keeps its own failure stop", () => {
    const { model } = build([prompt("s1", ["Run it."]), call("c1", { at: 10, end: 40, by: "failure", extra: { ...h1, error: ERR } }), stop("s1")], [state(FILE, "n0", null, { step: 1 })]);
    const f = model.stops.filter((s) => s.label === "1 run failed");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.lane, "agent:1");
  });

  it("sharing a change with an open call that did not fail, the change carries the failure and names the failed call", () => {
    // Neither command names the file, so the credit stays joint on the neutral lane.
    const { model } = shared({ by: "failure", cmd: "node build.js", extra: { ...h1, error: ERR } }, { cmd: "node memo.js", extra: h2 });
    const [c] = changeStops(model);
    assert.ok(c, "the change is on the rail");
    assert.equal(c.lane, "unsure");
    assert.ok(c.change!.failed, "the change shows the failure");
    assert.match(c.change!.failed!, /Helper 1/);
    assert.doesNotMatch(c.change!.failed!, /Helper 2/);
    assert.match(c.change!.failed!, /TypeError: theme is not a function/);
    assert.ok(c.failure, "the failed change has a failure box");
  });

  it("a shared change whose other call succeeded or is unknown never reads as failed when no call failed", () => {
    const { model } = shared({ cmd: "node build.js", extra: h1 }, { cmd: "node memo.js", extra: h2 });
    assert.equal(changeStops(model)[0]!.change!.failed, null);
  });

  it("every credited call failed: the change is failed as before", () => {
    const { model } = shared({ by: "failure", cmd: "node a.js", extra: { ...h1, error: ERR } }, { by: "failure", cmd: "node b.js", extra: h2 });
    assert.ok(changeStops(model)[0]!.change!.failed);
  });
});

describe("exactly one call shows a write signal for the file", () => {
  const lane = (a: Parameters<typeof call>[1], b: Parameters<typeof call>[1]): string => changeStops(shared(a, b).model)[0]!.lane ?? "";
  const reader = (cmd: string) => ({ cmd, input: { command: cmd }, extra: h1 });
  const writer = (cmd: string) => ({ cmd, input: { command: cmd }, extra: h2 });

  it("p.save('econ_data_ai.pptx') in the deck helper's heredoc goes to Helper 1, with the failure", () => {
    const { body, model } = shared({ by: "failure", cmd: "node", input: { command: HEREDOC }, extra: { ...h1, error: ERR } }, { cmd: "node memo.js", input: { command: "node memo.js" }, extra: h2 });
    const [c] = changeStops(model);
    assert.equal(c!.lane, "agent:1");
    assert.match(c!.head, /^Helper 1 /);
    assert.ok(c!.change!.failed);
    assert.equal(model.actors.some((a) => a.id === "unsure"), false);
    const calls = body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls));
    assert.equal(calls.find((x) => x.id === "c1")!.changes.length, 1);
    assert.equal(calls.find((x) => x.id === "c2")!.changes.length, 0);
    assert.deepEqual(calls.find((x) => x.id === "c1")!.changes[0]!.by.calls, ["c1"]);
  });

  it("(c) one call writes and names the file, another only reads it: the writer's actor alone", () => {
    assert.equal(lane(reader("ls econ_data_ai.pptx"), { cmd: "node", input: { command: HEREDOC }, extra: h2 }), "agent:1");
    const { body } = shared(reader("cat econ_data_ai.pptx | wc -c"), writer("cat template.xml > econ_data_ai.pptx"));
    assert.equal(body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls)).find((x) => x.changes.length > 0)!.id, "c2");
  });

  it("each kind of write signal counts on its own", () => {
    for (const w of ["echo hi > econ_data_ai.pptx", "echo hi >> /w/econ_data_ai.pptx", "gen | tee econ_data_ai.pptx", "cp /tmp/base.pptx econ_data_ai.pptx", "mv /tmp/x.pptx ./econ_data_ai.pptx", "touch econ_data_ai.pptx", "sed -i 's/a/b/' econ_data_ai.pptx", "cd /w && curl -o econ_data_ai.pptx http://x"]) {
      assert.notEqual(lane(reader("ls /w"), writer(w)), "unsure", w);
    }
    assert.equal(lane({ cmd: "python3 - <<'EOF'\nopen('econ_data_ai.pptx', 'wb').write(b)\nEOF", extra: h1 }, writer("ls")), "agent:1");
    assert.equal(lane({ cmd: "python3 -c \"df.to_excel('econ_data_ai.pptx')\"", extra: h1 }, writer("ls")), "agent:1");
  });

  it("the Write tool's own file path is a write signal", () => {
    const { model } = shared({ tool: "Write", cmd: "Write", input: { file_path: FILE, content: "x" }, extra: h1 }, writer("ls"));
    assert.equal(changeStops(model)[0]!.lane, "agent:1");
  });

  it("(a) a reader names the file and the writer writes via a variable: stays joint", () => {
    assert.equal(lane(reader("cat econ_data_ai.pptx"), { cmd: "node", input: { command: WRITER_VAR }, extra: h2 }), "unsure");
  });

  it("(b) the same file name in another folder stays joint", () => {
    assert.equal(lane({ cmd: "cp base.pptx /other/econ_data_ai.pptx", extra: h1 }, writer("node gen.js")), "unsure");
    assert.equal(lane({ cmd: "echo x > /other/econ_data_ai.pptx", extra: h1 }, writer("node gen.js")), "unsure");
    assert.equal(lane({ cmd: "echo x > sub/econ_data_ai.pptx", extra: h1 }, writer("node gen.js")), "unsure");
    assert.equal(lane({ cmd: "node", input: { command: "node - <<'EOF'\np.save('/other/econ_data_ai.pptx');\nEOF" }, extra: h1 }, writer("node gen.js")), "unsure");
  });

  it("(d) four probes stay joint", () => {
    assert.equal(lane(reader("ls econ_data_ai.pptx"), writer("python build.py")), "unsure");
    assert.equal(lane(reader("grep -c slide econ_data_ai.pptx"), writer("node gen.js")), "unsure");
    assert.equal(lane(reader("cp /other/econ_data_ai.pptx /tmp"), writer("node gen.js")), "unsure");
    assert.equal(lane(reader("ls /w/sub/econ_data_ai.pptx"), writer("node gen.js")), "unsure");
  });

  it("read-only commands never count, and neither do two writers or none", () => {
    for (const r of ["cat econ_data_ai.pptx", "head econ_data_ai.pptx", "tail -n 3 econ_data_ai.pptx", "open econ_data_ai.pptx", "file econ_data_ai.pptx", "stat econ_data_ai.pptx", "wc -c econ_data_ai.pptx", "grep x econ_data_ai.pptx > out.txt", "cp econ_data_ai.pptx /tmp/", "python3 -c \"print(open('econ_data_ai.pptx','rb').read())\""]) {
      assert.equal(lane({ cmd: r, extra: h1 }, writer("node gen.js")), "unsure", r);
    }
    assert.equal(lane({ cmd: "node", input: { command: HEREDOC }, extra: h1 }, writer("echo x > econ_data_ai.pptx")), "unsure", "two writers");
  });
});

describe("a name assigned the path and passed to a write call is a write signal", () => {
  const lane = (a: Parameters<typeof call>[1], b: Parameters<typeof call>[1]): string => changeStops(shared(a, b).model)[0]!.lane ?? "";
  const writer = (cmd: string) => ({ cmd, input: { command: cmd }, extra: h2 });
  const heredoc = (lang: string, body: string) => ({ cmd: lang, input: { command: `${lang} - <<'EOF'\n${body}\nEOF` }, extra: h1 });

  it("recorded-run shape: const f = path; writeFile({fileName:f}) goes to Helper 1", () => {
    const body = `(async()=>{const f='${FILE}'; const pres = new Pptx(); await pres.writeFile({fileName:f}); await applyTheme(f,THEME);})();`;
    assert.equal(lane(heredoc("node", body), writer("node memo.js")), "agent:1");
  });

  it("python: p = path; wb.save(p), df.to_excel(p) and open(p, 'wb') count", () => {
    assert.equal(lane(heredoc("python3", "p = 'econ_data_ai.pptx'\nwb.save(p)"), writer("ls")), "agent:1");
    assert.equal(lane(heredoc("python3", "p = '/w/econ_data_ai.pptx'\ndf.to_excel(p, index=False)"), writer("ls")), "agent:1");
    assert.equal(lane(heredoc("python3", "p = 'econ_data_ai.pptx'\nopen(p, 'wb').write(b)"), writer("ls")), "agent:1");
  });

  it("reassigning uses the latest assignment before the write", () => {
    assert.equal(lane(heredoc("python3", "p = 'other.pptx'\np = 'econ_data_ai.pptx'\nwb.save(p)"), writer("ls")), "agent:1");
    assert.equal(lane(heredoc("python3", "p = 'econ_data_ai.pptx'\nwb.save(p)\np = 'other.pptx'"), writer("ls")), "agent:1");
    assert.equal(lane(heredoc("python3", "p = 'econ_data_ai.pptx'\np = 'other.pptx'\nwb.save(p)"), writer("ls")), "unsure");
    assert.equal(lane(heredoc("python3", "p = 'econ_data_ai.pptx'\np = p + '.bak'\nwb.save(p)"), writer("ls")), "unsure");
  });

  it("a name only read stays no signal", () => {
    assert.equal(lane(heredoc("node", `const f='${FILE}'; const b = fs.readFileSync(f); out.writeFile({fileName:'x.pptx'});`), writer("ls")), "unsure");
    assert.equal(lane(heredoc("python3", "p = 'econ_data_ai.pptx'\nopen(p).read()\nopen(p, 'rb').read()"), writer("ls")), "unsure");
    assert.equal(lane(heredoc("python3", "p = 'econ_data_ai.pptx'\nwb = load_workbook(p)\nwb.save('copy.xlsx')"), writer("ls")), "unsure");
  });

  it("a name assigned another path, or a path in another folder, is no signal", () => {
    assert.equal(lane(heredoc("python3", "p = '/other/econ_data_ai.pptx'\nwb.save(p)"), writer("ls")), "unsure");
    assert.equal(lane(heredoc("python3", "q = 'econ_data_ai.pptx'\nwb.save(p)"), writer("ls")), "unsure");
  });
});
