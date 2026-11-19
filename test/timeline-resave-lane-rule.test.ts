// The lane rule for a re-save the claiming connector vouches changed nothing (P3, frozen). One call credited: it stays on
// that agent's lane, muted, "saved again, nothing changed". Any other credit: no stop on the "?" or outside lane, only a muted line in the
// file's history, left out of the lane counts and the missing sentences. Any other answer (no opt-in, a caveat, pending, failed) is a normal stop.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { ensureStoreDir } from "../src/states.ts";
import { freezeChanges } from "../src/connector/frozen.ts";
import { CHANGES_SPEC } from "../src/connector/changes-v1.ts";
import { vouchesNothingChanged } from "../src/connector/nothing-changed-rule.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline, type Timeline } from "../src/timeline/timeline.ts";
import { buildRailModel, SAVED_AGAIN_NOTHING_CHANGED, type RailModel, type RailStop } from "../src/timeline/rail/model.ts";
import { OUTSIDE_LANE, UNSURE_LANE } from "../src/timeline/attribution.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
const VT = (globalThis as unknown as { CoCheckViewTable: { coverageLine: (doc: unknown) => string; NOTHING_CHANGED: string } }).CoCheckViewTable;

const FOLDER = "/work", CLIENT = "claude:/work", BOOK = `${FOLDER}/book.xlsx`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const VOUCHED = { spec: CHANGES_SPEC, changes: [], caveats: [], source: { by: "connector", name: "microsoft-excel", level: 3, nothingChanged: true } };

type Credit = "call" | "outside" | "during";

/** One task: c1 ran (10-20), and book.xlsx moved at a sweep credited as `credit`, with `doc` frozen for it (or a pending capture). */
async function run(credit: Credit, doc: unknown | "pending"): Promise<{ timeline: Timeline; model: RailModel }> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-f4-"));
  const ledger: Ledger = openLedger(home);
  cleanups.push(async () => { ledger.close(); await rm(home, { recursive: true, force: true }); });
  const id = ledger.openTask(CLIENT);
  await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: FOLDER }));
  const frozen = doc === "pending" ? undefined : await freezeChanges(home, id, doc);
  const file = {
    filePath: BOOK, sha256: "b".repeat(64), prevSha256: "a".repeat(64), size: 10, kept: "whole" as const, note: "", connector: "microsoft-excel",
    ...(frozen === undefined ? { capturePending: true } : { connectorVersion: "1", connectorSpec: CHANGES_SPEC, changesSha256: frozen.sha256 }),
  };
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: credit === "outside" ? "Pre" : "Post", callsOpen: credit === "outside" ? [] : ["c1"], credited: credit === "call" ? ["c1"] : [], files: [file] });
  const loaded = loadRows(ledger, id, "t");
  const input = await loadTimelineInput(ledger, home, loaded, { build: "t", quickLook: false, render: async () => null });
  const ops = [call("c1", { named: [BOOK], at: 10, end: 20 }), prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")];
  const timeline = buildTimeline({ ...input, ops });
  return { timeline, model: buildRailModel(timeline) };
}
const bookStop = (m: RailModel): RailStop => m.stops.find((s) => s.change?.file === "book.xlsx")!;
const bookVersions = (m: RailModel) => m.files.find((f) => f.file === "book.xlsx")?.versions ?? [];
const MISSING = /shown under no call/;

describe("P3 over a frozen document", () => {
  it("vouches only with the opt-in recorded at capture, an empty list, no picture, caveat, status or more", () => {
    assert.equal(vouchesNothingChanged(VOUCHED), true);
    assert.equal(vouchesNothingChanged({ ...VOUCHED, source: { ...VOUCHED.source, nothingChanged: undefined } }), false, "no opt-in");
    assert.equal(vouchesNothingChanged({ ...VOUCHED, changes: [{ id: "c1", mark: "changed", label: "A1" }] }), false, "a change");
    assert.equal(vouchesNothingChanged({ ...VOUCHED, caveats: ["only part was read"] }), false, "partial");
    assert.equal(vouchesNothingChanged({ ...VOUCHED, status: { kind: "refused" } }), false, "refused or timed out");
    assert.equal(vouchesNothingChanged({ ...VOUCHED, pendingRetry: 1 }), false, "ask again");
    assert.equal(vouchesNothingChanged({ ...VOUCHED, failed: true }), false);
    assert.equal(vouchesNothingChanged({ ...VOUCHED, more: 3 }), false);
    // a captured empty list is drawn at level 1 (drawnLevel caps by content), so the level is not part of the claim
    assert.equal(vouchesNothingChanged({ ...VOUCHED, source: { ...VOUCHED.source, level: 1 } }), true, "a captured empty list, drawn at level 1");
    assert.equal(vouchesNothingChanged(null), false);
  });
});

// Lead, batch review of stop 1: a re-save whose document carries an issue ("slide 5: needs repair") must not be muted, or the warning hides with it.
describe("a document with any issue never vouches nothing changed", () => {
  const ISSUE = { ...VOUCHED, issues: [{ text: "slide 5: needs repair", where: "Slide 5" }] };
  it("P3 refuses it, and the page's nothing-changed line agrees", () => {
    assert.equal(vouchesNothingChanged(ISSUE), false);
    assert.notEqual(VT.coverageLine({ ...ISSUE, source: { ...ISSUE.source, level: 2 } }), VT.NOTHING_CHANGED);
    // the control: the same document without the issue draws the line at level 2
    assert.equal(VT.coverageLine({ ...VOUCHED, source: { ...VOUCHED.source, level: 2 } }), VT.NOTHING_CHANGED);
  });
  for (const credit of ["call", "outside"] as const) {
    it(`credited as ${credit}: a normal stop, not muted`, async () => {
      const { model } = await run(credit, ISSUE);
      const s = bookStop(model);
      assert.equal(s.muted, undefined);
      assert.equal(s.history, undefined);
      assert.notEqual(s.lane, null);
    });
  }
});

describe("the lane rule", () => {
  it("credited to one call: stays on that agent's lane, muted, 'saved again, nothing changed'", async () => {
    const { model, timeline } = await run("call", VOUCHED);
    const s = bookStop(model);
    assert.notEqual(s.lane, null, "on the agent's lane");
    assert.notEqual(s.lane, OUTSIDE_LANE);
    assert.notEqual(s.lane, UNSURE_LANE);
    assert.equal(s.muted, true);
    assert.equal(s.sub, SAVED_AGAIN_NOTHING_CHANGED);
    assert.equal(s.history, undefined);
    assert.equal(timeline.requests.flatMap((r) => r.runs.flatMap((x) => x.calls.flatMap((c) => c.changes))).find((c) => c.file === "book.xlsx")?.resave, true);
  });

  for (const credit of ["outside", "during"] as const) {
    it(`credited as ${credit}: no stop on the "?" or outside lane, a muted line in the file's history, out of the missing sentences and lane counts`, async () => {
      const { model, timeline } = await run(credit, VOUCHED);
      const s = bookStop(model);
      assert.equal(s.lane, null, "no lane stop");
      assert.equal(s.muted, true);
      assert.deepEqual(s.history, { lane: credit === "outside" ? OUTSIDE_LANE : UNSURE_LANE });
      assert.equal(model.stops.filter((x) => x.lane === OUTSIDE_LANE || x.lane === UNSURE_LANE).length, 0, "no stop counts on either lane");
      assert.ok(!model.actors.some((a) => a.id === UNSURE_LANE), "no '?' lane is drawn for it");
      const v = bookVersions(model);
      assert.equal(v.length, 1, "listed in the file's history");
      assert.equal(v[0]!.muted, true);
      assert.doesNotMatch(timeline.missing.join(" "), MISSING);
    });
  }

  const others: Array<[string, unknown]> = [
    ["no opt-in", { ...VOUCHED, source: { by: "connector", name: "microsoft-excel", level: 3 } }],
    ["a partial answer (caveat)", { ...VOUCHED, caveats: ["only the first sheet was read"] }],
    ["a pending capture", "pending"],
  ];
  for (const [what, doc] of others) {
    it(`${what}: a normal stop on the outside lane, counted, and the missing sentence stays`, async () => {
      const { model, timeline } = await run("outside", doc);
      const s = bookStop(model);
      assert.equal(s.lane, OUTSIDE_LANE);
      assert.equal(s.muted, undefined);
      assert.equal(s.history, undefined);
      assert.match(timeline.missing.join(" "), MISSING);
    });
  }

  it("a vouched answer never moves a change off an agent's lane: a call's change with a real change list is a normal stop on its lane", async () => {
    const { model } = await run("call", { ...VOUCHED, changes: [{ id: "c1", mark: "changed", label: "Sheet1!A1", before: "1", after: "2" }] });
    const s = bookStop(model);
    assert.notEqual(s.lane, null);
    assert.equal(s.muted, undefined);
    assert.equal(s.history, undefined);
  });
});
