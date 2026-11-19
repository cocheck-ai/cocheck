import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PAIRS, SNAPSHOTS, readGold, type Format, type ViewCapture } from "./helpers/connector-migration.ts";
import { CHECKS, changeIdsOf, creditedTo, railCaseOf, diffCaseOf, p1LocatorFindable, p2SidesMatchKind, p3SidesRenderNonEmpty, p4CreditIsCoChecks, p5PrecisionWithinDeclared, p6Deterministic, plant, railCredits, runAll, type DiffCase, type Precision } from "./lib/diff-props.ts";

/*
 * the six diff properties (test/lib/diff-props.ts) hold on the Office goldens, and each one fails on a planted bad input.
 * This file names no schema field: everything goes through the adapter.
 */

const g1 = readGold<Record<string, { rows: never[] }>>("g1-layer-rows.json");
const g2 = readGold<Record<string, ViewCapture>>("g2-renderer-views.json");
/** What each connector declares it can pin down. */
const DECLARED: Record<Format, Precision> = { xlsx: "cell", docx: "words", pptx: "words" };

const view = (v: ViewCapture) => v as unknown as Parameters<typeof diffCaseOf>[1];
const goldenCase = (name: string, withCredit = false): DiffCase => {
  const v = view(g2[name]!);
  const credits = withCredit ? railCredits(readGold(`g3-rail-${name}.json`), changeIdsOf(v)) : {};
  return diffCaseOf(g1[name]!, v, credits);
};

describe("P1-P6 hold on the Office goldens", () => {
  for (const p of PAIRS) {
    it(`${p.name}: P1, P2, P3, P5`, () => {
      const c = goldenCase(p.name);
      assert.ok(c.changes.length > 0, "the golden has changes");
      for (const [n, r] of [["P1", p1LocatorFindable(c)], ["P2", p2SidesMatchKind(c)], ["P3", p3SidesRenderNonEmpty(c)], ["P5", p5PrecisionWithinDeclared(c, { declared: DECLARED[p.format] })]] as const) assert.deepEqual(r.failures, [], `${p.name} ${n}`);
    });
  }
  for (const n of SNAPSHOTS.filter((x) => x !== "xlsx-credited")) it(`${n}: P4 every change is credited by CoCheck, here as an explicit "unsure"`, () => {
    const c = goldenCase(n, true);
    assert.ok(c.changes.length > 0);
    assert.deepEqual(p4CreditIsCoChecks(c).failures, []);
    assert.ok(c.changes.every((x) => x.credit?.state === "unsure"));
  });
  it("xlsx-credited: P4 holds, with the helper's call, an outside credit and a joint (unsure) credit each on its own change", () => {
    const { case: c, keys } = railCaseOf(readGold("g3-rail-xlsx-credited.json"));
    assert.deepEqual(p4CreditIsCoChecks(c).failures, []);
    const at = (k: string) => c.changes[keys[k]!]!.credit;
    assert.deepEqual(at("c2"), { state: "call", call: "toolu_01iL75MA3vESAf6kY01xGxsP" }, "helper's change credited to its call");
    assert.ok(c.calls.includes("toolu_01iL75MA3vESAf6kY01xGxsP"));
    assert.deepEqual(at("c4"), { state: "outside" }, "outside change");
    assert.deepEqual(at("c6"), { state: "unsure" }, "joint change (Claude plus the helper) stays an explicit unsure");
    assert.ok(c.changes.every((x) => x.credit !== null), "no change is missing a credit");
    assert.ok(c.changes.some((x) => x.credit?.state === "call") && c.changes.some((x) => x.credit?.state === "outside"), "not an all-unsure case");
    assert.equal(p4CreditIsCoChecks(plant.missingCredit(c)).ok, false);
    assert.equal(p4CreditIsCoChecks(plant.unknownCall(c)).ok, false);
    assert.equal(p4CreditIsCoChecks(plant.connectorAttribution(c)).ok, false);
  });
  it("P4 positive path: a change credited to a call CoCheck knows", () => {
    const v = view(g2["docx-W1"]!);
    const c = diffCaseOf(g1["docx-W1"]!, v, creditedTo("call-1", changeIdsOf(v)), ["call-1"]);
    assert.deepEqual(p4CreditIsCoChecks(c).failures, []);
    assert.ok(c.changes.every((x) => x.credit?.state === "call"));
  });
  it("the named map holds the same six checks", () => {
    assert.deepEqual(Object.keys(CHECKS), ["P1", "P2", "P3", "P4", "P5", "P6"]);
    assert.deepEqual(runAll(goldenCase("docx-W1", true), { declared: "words", again: goldenCase("docx-W1", true) }), { P1: [], P2: [], P3: [], P4: [], P5: [], P6: [] });
  });
});

describe("each check fails on one planted bad input", () => {
  const base = goldenCase("docx-W1", true);
  it("the base is clean", () => assert.deepEqual(runAll(base, { declared: "words", again: base }), { P1: [], P2: [], P3: [], P4: [], P5: [], P6: [] }));

  it("P1 fails on a locator that names nothing in either state", () => {
    assert.equal(p1LocatorFindable(plant.unfindableLocator(base)).ok, false);
    assert.equal(p1LocatorFindable(plant.unfindableLocator(goldenCase("xlsx-value-edit"))).ok, false);
  });
  it("P1 fails on a paragraph past the end, a slide past the end (docx and pptx) and an xlsx cell in an absent row", () => {
    assert.equal(p1LocatorFindable(plant.locatorAt(base, "paragraph 9999")).ok, false, "docx paragraph past the end");
    assert.equal(p1LocatorFindable(plant.locatorAt(base, "paragraph 0")).ok, false, "paragraph 0");
    assert.equal(p1LocatorFindable(plant.locatorAt(goldenCase("pptx-PD"), "Slide 99 / Text 9 / number 1")).ok, false, "pptx slide past the end");
    assert.equal(p1LocatorFindable(plant.locatorAt(base, "Slide 99")).ok, false, "slide past the end on the docx case");
    assert.equal(p1LocatorFindable(plant.locatorAt(goldenCase("xlsx-value-edit"), "Sheet1!B999")).ok, false, "xlsx cell in an absent row");
    assert.equal(p1LocatorFindable(plant.locatorAt(goldenCase("xlsx-value-edit"), "Sheet1!999:999")).ok, false, "xlsx absent row range");
  });
  it("P1 negatives are not blanket: the same plant on a real place stays clean", () => {
    assert.deepEqual(p1LocatorFindable(plant.locatorAt(base, "paragraph 2")).failures, []);
    assert.deepEqual(p1LocatorFindable(plant.locatorAt(goldenCase("pptx-PD"), "Slide 2 / Text 9 / number 1")).failures, []);
    assert.deepEqual(p1LocatorFindable(plant.locatorAt(goldenCase("xlsx-value-edit"), "Sheet1!B3")).failures, []);
  });
  it("P2 fails on a create drawn with a before box and on a delete drawn with an after box", () => {
    const c = goldenCase("docx-W1");
    assert.deepEqual(p2SidesMatchKind(c).failures, []);
    assert.match(p2SidesMatchKind(plant.createDrawnBefore(c)).failures.join("\n"), /create drawn on the before side/);
    assert.match(p2SidesMatchKind(plant.deleteDrawnAfter(c)).failures.join("\n"), /delete drawn on the after side/);
  });
  it("P2 fails on a create with a before side and on a delete with an after side", () => {
    assert.equal(p2SidesMatchKind(plant.createWithBefore(base)).ok, false);
    assert.equal(p2SidesMatchKind(plant.deleteWithAfter(base)).ok, false);
  });
  it("P3 fails on an empty pane and on a missing pane", () => {
    assert.equal(p3SidesRenderNonEmpty(plant.emptyPane(base)).ok, false);
    assert.equal(p3SidesRenderNonEmpty(plant.emptyPane(goldenCase("xlsx-value-edit"))).ok, false);
    assert.equal(p3SidesRenderNonEmpty(plant.noPane(base)).ok, false);
  });
  it("P4 fails when attribution comes from the connector side, when a change has no credit, and when the call is unknown", () => {
    assert.equal(p4CreditIsCoChecks(plant.connectorAttribution(base)).ok, false);
    assert.equal(p4CreditIsCoChecks(plant.missingCredit(base)).ok, false);
    assert.equal(p4CreditIsCoChecks(plant.unknownCall(base)).ok, false);
  });
  it("P5 fails when a change claims finer than declared (and when nothing is declared)", () => {
    assert.equal(p5PrecisionWithinDeclared(base, { declared: "region" }).ok, false, "words claimed, region declared");
    assert.equal(p5PrecisionWithinDeclared(goldenCase("xlsx-value-edit"), { declared: "page" }).ok, false, "cell claimed, page declared");
    assert.equal(p5PrecisionWithinDeclared(base).ok, false);
  });
  it("P6 fails when a second run moves, and when no second run is given", () => {
    assert.equal(p6Deterministic(base, { again: plant.nondeterministic(base) }).ok, false);
    assert.equal(p6Deterministic(base).ok, false);
  });
});
