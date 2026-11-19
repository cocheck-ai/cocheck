import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { stopIdentities, summarize, verdictEvents, type VerdictEvent } from "../src/timeline/rail/stop-status.ts";

// A fail is superseded only by a same-file state recorded after a send-back (or submission) that carried it. An unsent
// fail is never superseded, so the page, send-back and the agent read all offer it. Guarded against: a fail dropped without ever being sent.

const change = (id: string, file: string): any => ({
  id, file, kind: "modified", before: { sha256: `b${id}` }, after: { sha256: `a${id}` }, note: { text: `Changed ${file}.`, source: "rule" }, format: null,
});
const stopOf = (c: any): any => ({ id: `chg-${c.id}`, label: path.basename(c.file), head: `Claude changed ${c.file}`, lane: "main", change: { key: c.id, file: c.file, kind: c.kind, note: c.note.text, rowNotes: [], secret: false } });

const T = (n: number) => `2026-10-12T00:00:0${n}.000Z`;
/** c1 (older) and c2 (newer state of the same file), rail order c1 then c2. `rows` are [stop, note, second] verdicts; `events` are the send-backs and submissions. */
function fixture(rows: Array<[string, string, number]>, events: VerdictEvent[]) {
  const all = new Map(["c1", "c2"].map((id) => [id, change(id, "/work/notes.txt")]));
  const timeline: any = { unplaced: [...all.values()], requests: [] };
  const model: any = { task: 7, folder: "/work", actors: [], stops: ["chg-c1", "chg-c2"].map((id) => stopOf(all.get(id.slice(4)))) };
  const ids = stopIdentities(model, timeline);
  const v = rows.map(([stop, note, sec], i) => ({ id: i + 1, taskId: 7, stopId: stop, subject: ids.get(stop)!.subject, fingerprint: ids.get(stop)!.fingerprint, status: "failed" as const, note, reviewer: "t", ts: T(sec) }));
  return summarize(model, timeline, v, events).submit;
}

describe("only a carried fail is superseded", () => {
  it("never sent: the fail is not superseded, blocks, and is offered, whatever state exists after the verdict", () => {
    const sub = fixture([["chg-c1", "Old.", 1]], []);
    assert.deepEqual([sub.superseded, sub.blocking, sub.eligible], [[], ["chg-c1"], false]);
  });
  it("sent in a send-back that named it: the later state of the file supersedes it, so it is not resent and does not block", () => {
    const sub = fixture([["chg-c1", "Old.", 1]], [{ ts: T(2), stops: ["chg-c1"] }]);
    assert.deepEqual([sub.superseded, sub.blocking], [["chg-c1"], []]);
  });
  it("a send-back that named other stops does not carry it", () => {
    const sub = fixture([["chg-c1", "Old.", 1]], [{ ts: T(2), stops: ["chg-c2"] }]);
    assert.deepEqual([sub.superseded, sub.blocking], [[], ["chg-c1"]]);
  });
  it("a send-back from before the verdict does not carry it", () => {
    const sub = fixture([["chg-c1", "Old.", 2]], [{ ts: T(1), stops: ["chg-c1"] }]);
    assert.deepEqual([sub.superseded, sub.blocking], [[], ["chg-c1"]]);
  });
  it("a submission that covered it carries it (covered null covers every stop)", () => {
    const events = verdictEvents([], [{ ts: T(2), covered: null } as any]);
    assert.deepEqual(fixture([["chg-c1", "Old.", 1]], events).superseded, ["chg-c1"]);
  });
  it("the deliberate re-fail: saving the old fail again after the send-back is a new verdict, unsent, so it is offered and blocks again", () => {
    const sub = fixture([["chg-c1", "Old.", 1], ["chg-c1", "Old, again.", 3]], [{ ts: T(2), stops: ["chg-c1"] }]);
    assert.deepEqual([sub.superseded, sub.blocking], [[], ["chg-c1"]]);
  });
  it("the current state of the file is never superseded by an older one, sent or not", () => {
    const sub = fixture([["chg-c2", "Current.", 1]], [{ ts: T(2), stops: ["chg-c2"] }]);
    assert.deepEqual([sub.superseded, sub.blocking], [[], ["chg-c2"]]);
  });
});
