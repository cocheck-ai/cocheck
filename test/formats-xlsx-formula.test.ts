import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colToNum, numToCol, shiftFormula, toRelativeSignature, parseAddress } from "../src/office/connector/xlsx/formula.ts";

describe("colToNum / numToCol", () => {
  it("round-trips single and multi-letter columns", () => {
    assert.equal(colToNum("A"), 1);
    assert.equal(colToNum("Z"), 26);
    assert.equal(colToNum("AA"), 27);
    assert.equal(colToNum("AZ"), 52);
    assert.equal(numToCol(1), "A");
    assert.equal(numToCol(26), "Z");
    assert.equal(numToCol(27), "AA");
    assert.equal(numToCol(52), "AZ");
  });
});

describe("shiftFormula", () => {
  it("shifts relative references by row and column delta", () => {
    assert.equal(shiftFormula("B2*C2", 0, 1), "B3*C3");
    assert.equal(shiftFormula("SUM(D2:D4)", 0, 2), "SUM(D4:D6)");
    assert.equal(shiftFormula("A1", 2, 0), "C1");
  });

  it("leaves absolute ($) components untouched", () => {
    assert.equal(shiftFormula("$A$1+B2", 1, 1), "$A$1+C3");
    assert.equal(shiftFormula("A$1", 0, 5), "A$1");
    // "$A1": column is absolute (untouched by a column delta), row is relative (still shifts).
    assert.equal(shiftFormula("$A1", 5, 0), "$A1");
    assert.equal(shiftFormula("$A1", 0, 5), "$A6");
  });

  it("does not touch letters+digits that are part of a function name, not a ref", () => {
    assert.equal(shiftFormula("LOG10(A1)", 0, 1), "LOG10(A2)");
  });

  it("leaves a foreign-sheet-qualified ref untouched, quoted or bare, even with no ownSheetName given", () => {
    assert.equal(shiftFormula("'Quoted Sheet'!A1+B2", 1, 1), "'Quoted Sheet'!A1+C3");
    assert.equal(shiftFormula("Sheet2!A1+B2", 1, 1), "Sheet2!A1+C3");
  });

  it("shifts a ref qualified with the formula's own sheet name like a local ref, keeping the qualifier", () => {
    assert.equal(shiftFormula("Sheet1!A1", 1, 1, "Sheet1"), "Sheet1!B2");
    assert.equal(shiftFormula("'My Sheet'!A1", 1, 1, "My Sheet"), "'My Sheet'!B2");
  });

  it("does not shift a ref qualified with a different sheet name even when ownSheetName is given", () => {
    assert.equal(shiftFormula("Sheet2!A1+B2", 1, 1, "Sheet1"), "Sheet2!A1+C3");
  });

  it("never touches a cell-reference-looking token inside a double-quoted string literal", () => {
    assert.equal(shiftFormula('CONCATENATE("A1",B2)', 0, 1), 'CONCATENATE("A1",B3)');
    assert.equal(shiftFormula('IF(A1="B2","yes","no")', 1, 0), 'IF(B1="B2","yes","no")');
  });
});

describe("toRelativeSignature", () => {
  it("produces identical signatures for a formula shifted by a uniform row delta", () => {
    const sigAt3 = toRelativeSignature("B3*C3", "D3");
    const sigAt4 = toRelativeSignature("B4*C4", "D4");
    assert.equal(sigAt3, sigAt4);
  });

  it("produces different signatures when a range genuinely grows, even after accounting for the shift", () => {
    const sigBefore = toRelativeSignature("SUM(D2:D4)", "D5");
    const sigAfter = toRelativeSignature("SUM(D2:D5)", "D6");
    assert.notEqual(sigBefore, sigAfter);
  });

  it("keeps absolute references fixed rather than relative", () => {
    const sig = toRelativeSignature("$A$1*B2", "C2");
    assert.match(sig, /R1C1/);
  });

  it("normalizes an own-sheet-qualified ref like a local one, keeping the qualifier text", () => {
    assert.equal(toRelativeSignature("Sheet1!A1", "B1", "Sheet1"), "Sheet1!R[0]C[-1]");
  });

  it("leaves a foreign-sheet-qualified ref as literal text - it can't move when this sheet's rows shift", () => {
    assert.equal(toRelativeSignature("Sheet2!A1", "B1", "Sheet1"), "Sheet2!A1");
  });
});

describe("whole-row references", () => {
  it("shifts both sides of a row range by the row delta, keeping $ anchoring per side", () => {
    assert.equal(shiftFormula("SUM(3:3)", 0, 1), "SUM(4:4)");
    assert.equal(shiftFormula("SUM($3:$3)", 0, 1), "SUM($3:$3)");
    assert.equal(shiftFormula("SUM(3:5)", 0, 1), "SUM(4:6)");
    assert.equal(shiftFormula("SUM($3:5)", 0, 1), "SUM($3:6)");
  });

  it("produces identical relative signatures for a row range shifted by a uniform row delta", () => {
    const sigAt3 = toRelativeSignature("SUM(3:3)", "B2");
    const sigAt4 = toRelativeSignature("SUM(4:4)", "B3");
    assert.equal(sigAt3, sigAt4);
  });

  it("shifts a row range qualified with the formula's own sheet name, leaves a foreign one untouched", () => {
    assert.equal(shiftFormula("Sheet1!3:3", 0, 1, "Sheet1"), "Sheet1!4:4");
    assert.equal(shiftFormula("Sheet2!3:3", 0, 1, "Sheet1"), "Sheet2!3:3");
  });
});

describe("whole-column references", () => {
  it("shifts both sides of a column range by the column delta, keeping $ anchoring per side", () => {
    assert.equal(shiftFormula("SUM(A:A)", 1, 0), "SUM(B:B)");
    assert.equal(shiftFormula("SUM($A:$A)", 1, 0), "SUM($A:$A)");
    assert.equal(shiftFormula("SUM(A:C)", 1, 0), "SUM(B:D)");
  });

  it("produces identical relative signatures for a column range shifted by a uniform column delta", () => {
    const sigAtB = toRelativeSignature("SUM(A:A)", "B2");
    const sigAtC = toRelativeSignature("SUM(B:B)", "C2");
    assert.equal(sigAtB, sigAtC);
  });

  it("shifts a column range qualified with the formula's own sheet name, leaves a foreign one untouched", () => {
    assert.equal(shiftFormula("Sheet1!A:A", 1, 0, "Sheet1"), "Sheet1!B:B");
    assert.equal(shiftFormula("Sheet2!A:A", 1, 0, "Sheet1"), "Sheet2!A:A");
  });
});

describe("parseAddress", () => {
  it("parses column letters and row number", () => {
    assert.deepEqual(parseAddress("D5"), { col: 4, row: 5 });
    assert.deepEqual(parseAddress("AA10"), { col: 27, row: 10 });
  });

  it("throws on a malformed address", () => {
    assert.throws(() => parseAddress("not-a-cell"));
  });
});
