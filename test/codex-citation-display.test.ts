import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { profileOf } from "../src/hosts/index.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";
import type { RawOp } from "../src/timeline/runs.ts";

// Codex ends a reply with `:codex-file-citation{path="..." purpose="output"}` (a recorded Codex run). The page shows the file's
// base name; attributes never show. Display only: the stored op text is unchanged. Path rewritten to a fixture path.
const MSG = 'Created a single XLSX with raw FRED tabs. The chart uses Jan 2006 = 100 so all four indicators are comparable despite different units.\n\n:codex-file-citation{path="/work/fixture/codex/fred_data/FRED_Econ_Data_Data.xlsx" purpose="output"}';
const input = (ops: RawOp[], host: string | null): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host });
const closingOf = (text: string, host: string | null = "codex") => buildTimeline(input([call("c1", { host: host ?? "codex", at: 10 }), prompt("s1", ["go"]), stop("s1", text)], host)).requests[0]!.closing!.text;
const finishOf = (text: string) => {
  const fin: RawOp = { id: 99, tool: "hook", intent: "x", args_json: JSON.stringify({ hookAdapter: 1, hookEvent: "SubagentStop", session_id: "s1", agent_id: "h1", agent_type: "worker", at: 20, finish: { text } }) };
  return buildTimeline(input([call("c1", { host: "codex", at: 10 }), prompt("s1", ["go"]), stop("s1", "ok"), fin], "codex")).requests.flatMap((r) => r.finishes ?? [])[0]!.text!.text;
};

describe("Codex file citation display", () => {
  it("closing message: the card reads the base name, no brace text", () => {
    const t = closingOf(MSG);
    assert.ok(t.endsWith("despite different units.\n\nFRED_Econ_Data_Data.xlsx"), t);
    assert.ok(!t.includes("{") && !t.includes("purpose") && !t.includes("codex-file-citation"), t);
  });
  it("reply card and helper finish text too", () => {
    const tl = buildTimeline(input([call("c1", { host: "codex", at: 10 }), prompt("s1", ["go"]), stop("s1", MSG)], "codex"));
    assert.equal(tl.requests[0]!.replies![0]!.line.text.split("\n").pop(), "FRED_Econ_Data_Data.xlsx");
    assert.ok(finishOf(MSG).endsWith("FRED_Econ_Data_Data.xlsx"));
  });
  const show = (t: string) => profileOf("codex").displayText!(t);
  it("quoted values with spaces and escaped quotes parse", () => {
    assert.equal(show(':codex-file-citation{path="/a/b/My Report \\"final\\".xlsx" purpose="out put"}'), 'My Report "final".xlsx');
    assert.equal(show('See :codex-file-citation{path="/a/b.csv"} and :codex-file-citation{path="C:\\\\x\\\\c.txt"} now'), "See b.csv and c.txt now");
  });
  it("missing or placeholder path removes the directive", () => {
    assert.equal(show('Done.\n\n:codex-file-citation{path="<path>" purpose="output"}'), "Done.");
    assert.equal(show('Done.\n\n:codex-file-citation{purpose="output"}'), "Done.");
    assert.equal(show("Done :codex-file-citation{} ok"), "Done  ok");
  });
  it("must not: ordinary braces, other colon-words and a literal {...} are never altered", () => {
    for (const t of ['const x = {a: 1}; use {...} here', 'see :codex-file-other{path="/a/b.xlsx"}', ':file-citation{path="/a/b.xlsx"}', 'text :codex-file-citation without braces', ':codex-file-citation{...}', ':codex-file-citation{path=unquoted}', 'plain {path="/a/b.xlsx"}\n\n']) {
      assert.equal(show(t), t);
      if (!t.includes("/a/")) assert.equal(closingOf(t), t.trim()); // an outside path is masked by the older scrub, not by this rule
    }
  });
  it("another host's text is not transformed; stored op text is unchanged", () => {
    assert.ok(closingOf(MSG, "claude").includes(":codex-file-citation{"));
    const ops = [call("c1", { host: "codex", at: 10 }), prompt("s1", ["go"]), stop("s1", MSG)];
    buildTimeline(input(ops, "codex"));
    assert.ok(JSON.parse(ops[2]!.args_json ?? "{}").closing.text.includes(":codex-file-citation{path="));
  });
  // The text's own op decides; the task host is only the fallback.
  const withHost = (o: RawOp, host?: string): RawOp => ({ ...o, args_json: JSON.stringify({ ...JSON.parse(o.args_json ?? "{}"), ...(host ? { host } : {}) }) });
  it("mixed or unknown task host: a Codex stop op still transforms (reply, closing, finish)", () => {
    const fin: RawOp = { id: 98, tool: "hook", intent: "x", args_json: JSON.stringify({ hookAdapter: 1, hookEvent: "SubagentStop", host: "codex", session_id: "s1", agent_id: "h1", agent_type: "worker", at: 20, finish: { text: MSG } }) };
    const tl = buildTimeline(input([call("c1", { host: "codex", at: 10 }), call("c2", { host: "claude", session: "s2", at: 11 }), prompt("s1", ["go"]), withHost(stop("s1", MSG), "codex"), fin], null));
    const r = tl.requests.find((x) => x.closing)!;
    assert.ok(r.closing!.text.endsWith("FRED_Econ_Data_Data.xlsx"), r.closing!.text);
    assert.ok(!r.closing!.text.includes("{"));
    assert.ok(r.replies![0]!.line.text.endsWith("FRED_Econ_Data_Data.xlsx"));
    assert.ok(r.finishes![0]!.text!.text.endsWith("FRED_Econ_Data_Data.xlsx"));
  });
  it("a Claude op's text in the same mixed task is not transformed; an op with no host falls back to the task host", () => {
    const mixed = buildTimeline(input([call("c1", { host: "codex", at: 10 }), call("c2", { host: "claude", session: "s2", at: 11 }), prompt("s2", ["go"]), withHost(stop("s2", MSG), "claude")], null));
    assert.ok(mixed.requests.find((x) => x.closing)!.closing!.text.includes(":codex-file-citation{"));
    const fallback = buildTimeline(input([call("c1", { host: "codex", at: 10 }), prompt("s1", ["go"]), stop("s1", MSG)], "codex"));
    assert.ok(fallback.requests[0]!.closing!.text.endsWith("FRED_Econ_Data_Data.xlsx"));
  });
});
