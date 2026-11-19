import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalFormula, holds, holdsHash, writtenHash } from "../src/office/connector/xlsx/written.ts";

describe("qualified this-row references keep their table", () => {
  it("Sales and Costs this-row refs differ; Sales[@Amount] is Sales[[#This Row],[Amount]]", () => {
    assert.notEqual(canonicalFormula("Sales[[#This Row],[Amount]]"), canonicalFormula("Costs[[#This Row],[Amount]]"));
    assert.equal(canonicalFormula("=Sales[@Amount]"), canonicalFormula("Sales[[#This Row],[Amount]]"));
    assert.equal(canonicalFormula("=sales[@[amount]]"), canonicalFormula("SALES[[#This Row],[Amount]]"));
  });
  it("a written Costs ref does not hold a stored Sales ref", () => {
    assert.equal(holds("=Costs[@Amount]", 0, "Sales[[#This Row],[Amount]]"), false);
    assert.equal(holds("=Sales[@Amount]", 0, "Costs[[#This Row],[Amount]]"), false);
    assert.equal(holdsHash(writtenHash("=Costs[@Amount]"), 0, "Sales[[#This Row],[Amount]]"), false);
  });
  it("an unqualified [@Amount] still matches either table, both ways", () => {
    for (const stored of ["Sales[[#This Row],[Amount]]", "Costs[[#This Row],[Amount]]", "=[@Amount]"]) {
      assert.equal(holds("=[@Amount]", 0, stored), true, stored);
      assert.equal(holdsHash(writtenHash("=[@Amount]"), 0, stored), true, stored);
    }
    // Excel's AppleScript read-back of a qualified write inside its own table is the shorthand.
    assert.equal(holds("=Sales[@Amount]*2", 0, "=[@Amount]*2"), true);
    assert.equal(holds("=[@Amount]", 0, "Sales[[#This Row],[Cost]]"), false);
  });
  it("Sales[@] is Sales[#This Row], not an empty-named column", () => {
    assert.equal(canonicalFormula("=Sales[@]"), canonicalFormula("Sales[#This Row]"));
    assert.equal(canonicalFormula("=SUM(Sales[@])"), canonicalFormula("SUM(Sales[[#This Row]])"));
    assert.notEqual(canonicalFormula("=Sales[@]"), canonicalFormula("=[@[]]"));
    assert.notEqual(canonicalFormula("=Sales[@]"), canonicalFormula("=Costs[#This Row]"));
  });
});
