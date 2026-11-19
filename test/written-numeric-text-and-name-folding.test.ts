import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalFormula, holds, needsTextForm, textForm, writtenHash, cellHash } from "../src/office/connector/xlsx/written.ts";

describe("numeric text is sent raw only when Excel's stored number spells it exactly", () => {
  it("a 16-digit card number goes as text and a 15-digit stored number does not hold it", () => {
    // Live on Excel 16.113: sent raw, it was stored as 4111111111111110 and reported ok.
    assert.equal(textForm("4111111111111111"), "'4111111111111111");
    assert.equal(holds("4111111111111111", 4111111111111110, null), false);
    assert.equal(holds("4111111111111111", "4111111111111111", null), true);
    assert.equal(writtenHash("4111111111111111"), cellHash("s:4111111111111111"));
  });

  it("exponent spellings go as text and the stored number does not hold them", () => {
    for (const s of ["1e-7", "1e+21", "1E5", "2.5e3"]) {
      assert.equal(needsTextForm(s), true, s);
      assert.equal(holds(s, Number(s), null), false, s);
    }
  });

  it("plain spellings of at most 15 significant digits still go raw", () => {
    for (const s of ["0", "10", "-2", "3.5", "0.001", "999999999999999", "-123456789.012345", "100"]) {
      assert.equal(needsTextForm(s), false, s);
      assert.equal(holds(s, Number(s), null), true, s);
    }
    for (const s of ["1234567890123456", "0.1234567890123456", "12345678901234567890"]) {
      assert.equal(needsTextForm(s), true, s);
    }
  });
});

describe("names fold case the way Excel does", () => {
  it("sheet names compare case-insensitively without folding ß to SS", () => {
    assert.equal(canonicalFormula("='Straße'!A1"), canonicalFormula("='STRAßE'!A1"));
    assert.notEqual(canonicalFormula("='Straße'!A1"), canonicalFormula("='STRASSE'!A1"));
    assert.notEqual(canonicalFormula("=Straße!A1"), canonicalFormula("=STRASSE!A1"));
  });
  it("defined names do not fold ß to SS", () => {
    assert.notEqual(canonicalFormula("=maße*2"), canonicalFormula("=MASSE*2"));
    assert.equal(canonicalFormula("=maße*2"), canonicalFormula("=MAßE*2"));
  });
  it("structured-ref column names compare case-insensitively", () => {
    assert.equal(canonicalFormula("=SUM(Table1[amount])"), canonicalFormula("=SUM(Table1[Amount])"));
    assert.equal(canonicalFormula("=Table1[[#This Row],[amount]]"), canonicalFormula("=Table1[[#This Row],[Amount]]"));
    assert.ok(holds("=SUM(Table1[amount])", null, "=SUM(Table1[Amount])"));
  });
  it("string literals stay case-sensitive", () => {
    assert.notEqual(canonicalFormula('="ab"'), canonicalFormula('="AB"'));
  });
});
