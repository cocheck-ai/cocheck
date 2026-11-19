import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt } from "./fixtures/timeline.ts";

// A recorded Claude run (schema 10, before the per-step file state) renders no stop. Its ledger holds ops that name
// casebook.xlsx and task_snapshots copies, but `steps` and `file_states` are empty, and `buildRailModel` (src/timeline/rail/model.ts) makes a stop from a
// request, a placed change (a file state), a failed call, a start/send or a reply, so this record holds only its request. The shape here: Bash calls naming a workbook in the watched folder, and no file state at all.
// Cause is the missing state, not the loader; the fix is a separate item (read the task_snapshots copies, or say the record has no step state).
const F = "/Users/user/cocheck-probe-run/r2/claude";
const casebook = `${F}/casebook.xlsx`;

describe("a record from before per-step file state", () => {
  // todo: today the model holds the request stop and nothing else.
  it("shows a stop for the calls that named the workbook", { todo: true }, () => {
    const ops = [
      call("b1", { at: 10, end: 14, cmd: `python3 set_cell.py ${casebook} Sheet1!B2 5`, named: [casebook], extra: { startSeq: 10 } }),
      call("b2", { at: 20, end: 24, cmd: `python3 set_cell.py ${casebook} Sheet1!B3 6`, named: [casebook], extra: { startSeq: 20 } }),
      prompt("s1", ["Edit the model."], { requests: [{ seq: 1, at: 0, firstStep: null }] }),
    ];
    const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates: [], folder: F, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
    const m = buildRailModel(buildTimeline(input));
    assert.ok(m.stops.some((s) => !s.request), `only the request stop: ${m.stops.map((s) => s.id).join(",")}`);
  });
});
