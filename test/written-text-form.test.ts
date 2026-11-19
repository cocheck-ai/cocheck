import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cellHash, holds, holdsHash, needsTextForm, writtenHash } from "../src/office/connector/xlsx/written.ts";

describe("written text that Excel would coerce", () => {
  it("a stored number does not hold leading-zero or trailing-zero text", () => {
    assert.equal(holds("00123", 123, null), false);
    assert.equal(holds("02139", 2139, null), false);
    assert.equal(holds("1.50", 1.5, null), false);
    assert.equal(holds("00123", "00123", null), true);
  });

  it("canonical numeric text still matches the stored number", () => {
    assert.equal(holds("10", 10, null), true);
    assert.equal(holds("10", "10", null), true);
    assert.equal(holds("-2", -2, null), true);
    assert.equal(holds("TRUE", true, null), true);
  });

  it("write_range hashes for coerced text accept only the exact text", () => {
    const h = writtenHash("00123");
    assert.equal(h, cellHash("s:00123"));
    assert.equal(holdsHash(h, 123, null), false);
    assert.equal(holdsHash(h, "00123", null), true);
    assert.ok(Array.isArray(writtenHash("10")));
  });

  it("needsTextForm table", () => {
    for (const s of ["00123", "1.50", "1e3", "1,000", "5%", "$10", "1/2", "2026-09-28", "Mar 3", "10:30", "1 1/2", "'x", " 5", "false", "hello", "Q", "Marketing"]) {
      assert.equal(needsTextForm(s), true, s);
    }
    for (const s of ["10", "3.5", "-2", "0", "TRUE", "FALSE", "", "=A1+1"]) {
      assert.equal(needsTextForm(s), false, s);
    }
  });
});
