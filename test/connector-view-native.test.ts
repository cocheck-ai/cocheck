import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSealed } from "../src/seal.ts";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { ensureStoreDir } from "../src/states.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline, type Timeline } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel, type RailStop } from "../src/timeline/rail/model.ts";
import type { DiffObject } from "../src/connector/diff-object.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRegistry } from "../src/connector/registry.ts";

// A connector DiffObject draws natively (text panes, record card, opaque line, plain placeholders), every connector string reaches the page as a
// text node, and a connector row is credited like a file row. A fake URI connector (notion://page/x) stands in through opts.connectorDiff.

const FOLDER = "/work", CLIENT = "claude:/work", URI = "notion://page/x";
const sha = (b: string): string => createHash("sha256").update(b).digest("hex");
const INJECT = "<img src=x onerror=alert(1)>";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const fake = (extra: DiffObject["changes"] = []): DiffObject => ({
  spec: "cocheck.diff/1", subject: URI, connector: "notion", producer: "connector", before: { ref: "r0" }, after: { ref: "r1" }, caveats: ["read through the cache"],
  changes: [
    { anchors: [{ label: "Intro" }], kind: "text", confidence: "exact", before: { type: "text", value: "old words" }, after: { type: "text", value: `new words ${INJECT}` }, note: "the intro was reworded" },
    { anchors: [{ entity: "Status", label: "Status card" }], kind: "properties", confidence: "exact", before: { type: "json", value: { status: "Open", owner: "ana" } }, after: { type: "json", value: { status: "Done", owner: "ana" } } },
    { anchors: [{ label: "Layout" }], kind: "page rearranged", confidence: "opaque", before: null, after: null },
    ...extra,
  ],
});

/** A real ledger with the built-in file note.md and the connector row, both credited to call c1; returns the timeline and its rail model. */
async function run(connectorDiff?: Parameters<typeof loadTimelineInput>[3]["connectorDiff"], only: "both" | "conn" | "file" = "both"): Promise<{ timeline: Timeline; model: RailModel; input: Awaited<ReturnType<typeof loadTimelineInput>> }> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger: Ledger = openLedger(home);
  cleanups.push(async () => { ledger.close(); await rm(home, { recursive: true, force: true }); });
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: FOLDER }));
  await writeSealed(path.join(states, sha("a\n")), "a\n");
  await writeSealed(path.join(states, sha("b\n")), "b\n");
  const files = [
    { filePath: `${FOLDER}/note.md`, sha256: sha("b\n"), prevSha256: sha("a\n"), size: 2, kept: "whole" as const, note: "" },
    { filePath: URI, sha256: "r1", prevSha256: "r0", size: 0, kept: "hash" as const, note: "", connector: "notion" },
  ].filter((f) => only === "both" || (only === "conn") === (f.connector !== undefined));
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: ["c1"], credited: ["c1"], files });
  const loaded = loadRows(ledger, id, "t");
  const input = await loadTimelineInput(ledger, home, loaded, { build: "t", quickLook: false, render: async () => null, ...(connectorDiff === undefined ? {} : { connectorDiff }) });
  const ops = [call("c1", { named: [`${FOLDER}/note.md`, URI], at: 10, end: 20 }), prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")];
  const timeline = buildTimeline({ ...input, ops });
  return { timeline, model: buildRailModel(timeline), input };
}
const stopOf = (m: RailModel, f: (s: RailStop) => boolean): RailStop => m.stops.find(f)!;
const connStop = (m: RailModel): RailStop => stopOf(m, (s) => s.change?.file === URI);
const fileStop = (m: RailModel): RailStop => stopOf(m, (s) => s.change?.file === "note.md");


describe("loader: every change carries a DiffObject", () => {
  it("a built-in row gets a builtin DiffObject through toDiffObject; a connector row gets opts.connectorDiff's answer, asked with the row's refs", async () => {
    const asked: unknown[] = [];
    const { input } = await run(async (row) => { asked.push(row); return fake(); });
    assert.deepEqual(asked, [{ subject: URI, connector: "notion", before: { ref: "r0" }, after: { ref: "r1" } }]);
    const ds = [...input.diffs!.values()];
    assert.equal(ds.length, 2);
    assert.deepEqual(ds.map((d) => d.producer).sort(), ["builtin", "connector"]);
    const c = ds.find((d) => d.producer === "connector")!;
    assert.equal(c.changes.length, 3);
    assert.equal(c.builtin, undefined, "a connector object carries no builtin field");
  });
  it("no connectorDiff, or a throw, gives an unavailable DiffObject that says why, never a dropped change", async () => {
    for (const f of [undefined, async () => { throw new Error("boom"); }] as const) {
      const { model, input } = await run(f);
      const c = [...input.diffs!.values()].find((d) => d.producer === "connector")!;
      assert.match(c.unavailable ?? "", /connector|boom/);
      const s = connStop(model);
      assert.ok(s !== undefined, "the connector change still has a stop");
    }
  });
  it("a connector cannot smuggle a builtin field or producer: the loader strips both", async () => {
    const evil = fake(); (evil as { producer: string }).producer = "builtin"; evil.builtin = { view: null, viewHasChanges: false, viewOrder: [] }; evil.changes[0]!.builtin = { row: { location: "x", kind: "value", before: null, after: null, text: "FORGED" } };
    const { input, model } = await run(async () => evil);
    const c = [...input.diffs!.values()].find((d) => d.subject === URI)!;
    assert.equal(c.producer, "connector");
    assert.equal(c.builtin, undefined);
    assert.ok(c.changes.every((x) => x.builtin === undefined));
    assert.ok(!JSON.stringify(model).includes("FORGED"));
  });
});

describe("model: the connector change is drawn from the DiffObject, credited like a file row", () => {
  it("one stop per row; the connector stop is not a local file change (no Office buttons, no cards; its view is the served document)", async () => {
    const { model } = await run(async () => fake());
    const c = connStop(model).change!;
    assert.match(c.viewUrl!, /\/view\//);
    assert.equal("openExcel" in c, false);
    assert.equal(c.cards, undefined);
    assert.equal(c.secret, false);
    assert.ok(fileStop(model).change!.viewUrl !== null, "the file row keeps its view");
  });
  it("the call is credited as for the file row", async () => {
    const { model } = await run(async () => fake());
    assert.deepEqual(connStop(model).calls?.map((x) => x.id), ["c1"]);
    assert.deepEqual(connStop(model).calls?.map((x) => x.id), fileStop(model).calls?.map((x) => x.id));
    assert.equal(connStop(model).lane, fileStop(model).lane);
  });
  // The items/record/placeholder tests of the retired connectorView moved to test/connector-levels-drawn.test.ts (the served document drawn by level).
});
// The page tests of the retired connectorView drawing were replaced by test/connector-levels-drawn.test.ts, which draws the served document.
