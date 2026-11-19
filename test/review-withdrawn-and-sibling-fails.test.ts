import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { stopIdentities, stopStates, summarize } from "../src/timeline/rail/stop-status.ts";
import { buildSendBack } from "../src/timeline/rail/send-back.ts";

// (1) a verdict withdrawn or replaced before anything was sent or submitted must not read as history;
// (2) a fail is replaced only by a state of the same file recorded AFTER the verdict, so an earlier sibling step does not disable Send back.
// Must not happen: a fail that was sent back and later passed stays in History; fail, send back, agent writes a new state: not resent.

const T0 = Date.parse("2026-11-01T23:00:00.000Z");
const iso = (min: number): string => new Date(T0 + min * 60000).toISOString();
const change = (id: string, file: string, atMin: number): any => ({
  id, file, kind: "modified", at: T0 + atMin * 60000, before: { sha256: `b${id}` }, after: { sha256: `a${id}` }, note: { text: `Changed ${file}.`, source: "rule" }, format: null,
});
const stopOf = (c: any): any => ({ id: `chg-${c.id}`, label: path.basename(c.file), head: `Claude changed ${c.file}`, lane: "main", change: { key: c.id, file: c.file, kind: c.kind, note: c.note.text, rowNotes: [], secret: false } });

function world(atMin: Record<string, number>) {
  const all = Object.entries(atMin).map(([id, m]) => change(id, "/work/deck.pptx", m));
  const timeline: any = { unplaced: all, requests: [] };
  const model: any = { task: 8, folder: "/work", actors: [], stops: all.map(stopOf) };
  const ids = stopIdentities(model, timeline);
  let n = 0;
  const row = (stop: string, status: "passed" | "failed" | "not_reviewed", min: number, note = status === "failed" ? "no" : ""): any =>
    ({ id: ++n, taskId: 8, stopId: stop, subject: ids.get(stop)!.subject, fingerprint: ids.get(stop)!.fingerprint, status, note, reviewer: "t", ts: iso(min) });
  return { model, timeline, row };
}

describe("history lists only verdicts that took effect", () => {
  it("fail, withdraw, fail again, nothing sent: History holds only the current verdict", () => {
    const w = world({ c1: 0 });
    const rows = [w.row("chg-c1", "failed", 1, "Name it Agenda"), w.row("chg-c1", "not_reviewed", 2), w.row("chg-c1", "failed", 3, "Name it Agenda")];
    const s = summarize(w.model, w.timeline, rows, []).stops["chg-c1"];
    assert.deepEqual(s.history.map((h) => h.id), [3]);
    assert.equal(s.status, "failed");
  });

  it("a withdrawn fail leaves no row at all (current is not reviewed)", () => {
    const w = world({ c1: 0 });
    const s = summarize(w.model, w.timeline, [w.row("chg-c1", "failed", 1), w.row("chg-c1", "not_reviewed", 2)], []).stops["chg-c1"];
    assert.deepEqual(s.history, []);
  });

  it("a fail replaced by a pass before anything was sent is gone; the pass is current", () => {
    const w = world({ c1: 0 });
    const s = summarize(w.model, w.timeline, [w.row("chg-c1", "failed", 1), w.row("chg-c1", "passed", 2)], []).stops["chg-c1"];
    assert.deepEqual(s.history.map((h) => h.status), ["passed"]);
  });

  it("DANGEROUS: a fail that was sent back and later passed still shows, then the pass", () => {
    const w = world({ c1: 0 });
    const rows = [w.row("chg-c1", "failed", 1), w.row("chg-c1", "passed", 5)];
    const s = summarize(w.model, w.timeline, rows, [{ ts: iso(2), stops: ["chg-c1"] }]).stops["chg-c1"];
    assert.deepEqual(s.history.map((h) => h.status), ["failed", "passed"]);
  });

  it("a send-back that did not name the stop does not give its fail effect", () => {
    const w = world({ c1: 0, c2: 0 });
    const rows = [w.row("chg-c1", "failed", 1), w.row("chg-c1", "passed", 3)];
    const s = summarize(w.model, w.timeline, rows, [{ ts: iso(2), stops: ["chg-c2"] }]).stops["chg-c1"];
    assert.deepEqual(s.history.map((h) => h.status), ["passed"]);
  });

  it("a pass that a submission covered stays; one given and replaced before it does not", () => {
    const w = world({ c1: 0 });
    const rows = [w.row("chg-c1", "passed", 1), w.row("chg-c1", "failed", 2), w.row("chg-c1", "passed", 3)];
    const s = summarize(w.model, w.timeline, rows, [{ ts: iso(4), stops: null }]).stops["chg-c1"];
    assert.deepEqual(s.history.map((h) => h.id), [3]);
    const s2 = summarize(w.model, w.timeline, rows, [{ ts: iso(1.5), stops: null }, { ts: iso(4), stops: null }]).stops["chg-c1"];
    assert.deepEqual(s2.history.map((h) => h.id), [1, 3]);
  });

  it("the ledger rows are untouched by the filter", () => {
    const w = world({ c1: 0 });
    const rows = [w.row("chg-c1", "failed", 1), w.row("chg-c1", "not_reviewed", 2)];
    const before = JSON.stringify(rows);
    stopStates(w.model.stops, stopIdentities(w.model, w.timeline), rows, []);
    assert.equal(JSON.stringify(rows), before);
  });
});

describe("a fail is replaced only by a state recorded after the verdict", () => {
  it("step 178 recorded 5 min BEFORE the fail on 177 does not replace it; Send back lists it", () => {
    const w = world({ c1: 0, c2: 5 });
    const rows = [w.row("chg-c1", "failed", 10, "Name it Today's Agenda")];
    const sum = summarize(w.model, w.timeline, rows, []);
    assert.deepEqual(sum.submit.superseded, []);
    assert.deepEqual(sum.submit.blocking, ["chg-c1"]);
    assert.match(buildSendBack(w.model, w.timeline, sum).prompt, /Today's Agenda/);
  });

  it("DANGEROUS: fail, send back, agent writes a new state: the old fail is replaced and not resent", () => {
    const w = world({ c1: 0, c2: 20 });
    const rows = [w.row("chg-c1", "failed", 10, "Old complaint")];
    const sum = summarize(w.model, w.timeline, rows, [{ ts: iso(11), stops: ["chg-c1"] }]);
    assert.deepEqual(sum.submit.superseded, ["chg-c1"]);
    assert.deepEqual(sum.submit.blocking, []);
    assert.throws(() => buildSendBack(w.model, w.timeline, sum), /nothing to send back/);
  });

  it("the fail on the newest state is never replaced", () => {
    const w = world({ c1: 0, c2: 20 });
    const sum = summarize(w.model, w.timeline, [w.row("chg-c2", "failed", 30)], []);
    assert.deepEqual([sum.submit.superseded, sum.submit.blocking], [[], ["chg-c2"]]);
  });

  it("a re-fail after the newer state was recorded uses the latest verdict's time", () => {
    const w = world({ c1: 0, c2: 20 });
    const sum = summarize(w.model, w.timeline, [w.row("chg-c1", "failed", 10), w.row("chg-c1", "not_reviewed", 21), w.row("chg-c1", "failed", 25)], []);
    assert.deepEqual(sum.submit.superseded, []);
  });
});
