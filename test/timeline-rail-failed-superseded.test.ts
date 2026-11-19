import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { stopIdentities, summarize } from "../src/timeline/rail/stop-status.ts";
import { buildSendBack } from "../src/timeline/rail/send-back.ts";

// the failed counts agree across the page, send back and submit. A replaced fail is decided by recording order (the file state id in the
// stop id), not rail order; send back leaves a replaced fail out; the submission's `covered` list is built inside the submit lock.
// Guarded against: a fail on the current state of a file is never dropped from send back or from blocking.

const change = (id: string, file: string): any => ({
  id, file, kind: "modified", before: { sha256: `b${id}` }, after: { sha256: `a${id}` }, note: { text: `Changed ${file}.`, source: "rule" }, format: null,
});
const stopOf = (c: any): any => ({ id: `chg-${c.id}`, label: path.basename(c.file), head: `Claude changed ${c.file}`, lane: "main", change: { key: c.id, file: c.file, kind: c.kind, note: c.note.text, rowNotes: [], secret: false } });

/** `sent` names the stops a send-back carried after the verdicts (only a fail a send-back carried can be replaced by a later state). `order` is the rail order of the stops (by observed time); the ids are recording order. */
function fixture(order: string[], failures: Record<string, string>, sent: string[] = []) {
  const all = new Map(["c1", "c2", "c3"].map((id) => [id, change(id, id === "c3" ? "/work/other.txt" : "/work/notes.txt")]));
  const timeline: any = { unplaced: [...all.values()], requests: [] };
  const model: any = { task: 7, folder: "/work", actors: [], stops: order.map((id) => stopOf(all.get(id.slice(4)))) };
  const ids = stopIdentities(model, timeline);
  const rows = Object.entries(failures).map(([stop, note], i) => ({ id: i + 1, taskId: 7, stopId: stop, subject: ids.get(stop)!.subject, fingerprint: ids.get(stop)!.fingerprint, status: "failed" as const, note, reviewer: "t", ts: "2026-10-12T00:00:00.000Z" }));
  return { model, timeline, summary: summarize(model, timeline, rows, sent.length === 0 ? [] : [{ ts: "2026-10-12T00:00:01.000Z", stops: sent }]) };
}

describe("replaced is decided by recording order", () => {
  it("c1 recorded first but timed later than c2: failing the current state (c2) blocks submit", () => {
    const f = fixture(["chg-c2", "chg-c1"], { "chg-c2": "The current state is wrong." });
    assert.deepEqual(f.summary.submit.blocking, ["chg-c2"]);
    assert.deepEqual(f.summary.submit.superseded, []);
    assert.equal(f.summary.submit.eligible, false);
  });

  it("the older state (c1) failing is replaced by c2 even when the rail puts c1 last", () => {
    const f = fixture(["chg-c2", "chg-c1"], { "chg-c1": "Old draft." }, ["chg-c1"]);
    assert.deepEqual(f.summary.submit.superseded, ["chg-c1"]);
    assert.deepEqual(f.summary.submit.blocking, []);
  });

  it("rail order and recording order agreeing still replaces the earlier fail", () => {
    const f = fixture(["chg-c1", "chg-c2"], { "chg-c1": "Old draft." }, ["chg-c1"]);
    assert.deepEqual([f.summary.submit.superseded, f.summary.submit.blocking], [["chg-c1"], []]);
  });
});

describe("send back lists only fails that are not replaced", () => {
  it("a replaced fail is left out of the numbered list and the count; the current fail stays", () => {
    const f = fixture(["chg-c1", "chg-c2", "chg-c3"], { "chg-c1": "Old draft.", "chg-c3": "Other file is wrong." }, ["chg-c1"]);
    const out = buildSendBack(f.model, f.timeline, f.summary);
    assert.deepEqual(out.stops, ["chg-c3"]);
    assert.match(out.prompt, /1 step failed/);
    assert.ok(!out.prompt.includes("Old draft."));
    assert.match(out.prompt, /^1\. Claude changed \/work\/other\.txt/m);
    assert.ok(!/^2\. /m.test(out.prompt));
  });

  it("every fail replaced and no overall note: there is nothing to send back", () => {
    const f = fixture(["chg-c1", "chg-c2"], { "chg-c1": "Old draft." }, ["chg-c1"]);
    assert.throws(() => buildSendBack(f.model, f.timeline, f.summary), /nothing to send back/);
  });

  it("every fail replaced with an overall note: the note goes alone", () => {
    const f = fixture(["chg-c1", "chg-c2"], { "chg-c1": "Old draft." }, ["chg-c1"]);
    const out = buildSendBack(f.model, f.timeline, f.summary, "Please tidy up.");
    assert.deepEqual(out.stops, []);
    assert.ok(!out.prompt.includes("Old draft."));
    assert.match(out.prompt, /Overall note: Please tidy up\./);
  });

  it("a fail on the current state of a file is in send back and blocks, in either rail order", () => {
    for (const order of [["chg-c1", "chg-c2"], ["chg-c2", "chg-c1"]]) {
      const f = fixture(order, { "chg-c2": "Current is wrong.", "chg-c1": "Old is wrong." }, ["chg-c1"]);
      const out = buildSendBack(f.model, f.timeline, f.summary);
      assert.deepEqual(out.stops, ["chg-c2"], order.join());
      assert.ok(out.prompt.includes("Current is wrong."));
      assert.deepEqual(f.summary.submit.blocking, ["chg-c2"], order.join());
    }
  });
});

describe("the covered list comes from inside the submit lock", () => {
  it("recordSoftSubmission stores the covered list the check returns, over the one passed in", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const ledger = openLedger(home);
    try {
      const taskId = ledger.openTask("claude:/work");
      const stale = [{ stop: "chg-c1", status: "not_reviewed" as const, sha256: null }];
      const fresh = [{ stop: "chg-c1", status: "passed" as const, sha256: null }];
      ledger.recordSoftSubmission({ taskId, signer: "Dana", rounds: 0, rejections: [], files: [], leftOut: [], closedTask: false, acknowledged: [], reviewer: "Dana", covered: stale }, () => fresh);
      assert.deepEqual(ledger.submissionsForTask(taskId).at(-1)!.covered, fresh);
    } finally {
      ledger.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
