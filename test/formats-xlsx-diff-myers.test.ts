import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import type { CellSnapshot, SheetSnapshot, WorkbookSnapshot } from "../src/office/connector/xlsx/types.ts";

/**
 * The windowed-similarity fallback (prefix/suffix trim + capped cross-product, positional
 * pairing past the cap) gets the *count* right for a single insert/delete inside a giant
 * low-cardinality gap, but misaligns everything once the gap also contains a handful of
 * scattered genuine edits: the trim stops at the first edit, the remaining middle blows past the
 * window, and positional pairing past that point pairs unrelated rows. A minimal edit-script
 * (Myers) alignment over the gap's row signatures doesn't have that failure mode - it finds the
 * true minimal insert/delete/replace set regardless of gap size, as long as the edit distance
 * itself stays under the algorithm's own budget (see `formats-xlsx-diff-perf.test.ts` for the
 * "distance too large" fallback-and-note case).
 */
function sheetOf(values: string[], colName = "A"): SheetSnapshot {
  const cells = new Map<string, CellSnapshot>();
  values.forEach((value, i) => {
    const address = `${colName}${i + 1}`;
    cells.set(address, { address, value, formula: null, numFmt: "General" });
  });
  return { name: "Sheet1", cells };
}
function workbookOf(values: string[]): WorkbookSnapshot {
  return { sheets: [sheetOf(values)] };
}

/**
 * Fastest of three runs. A budget assertion guards against an algorithmic blowup, which slows every
 * run; a stall from a loaded machine (descheduling, GC) hits one run, so the minimum ignores it.
 */
function timedDiff(before: string[], after: string[]): { rows: ReturnType<typeof diffWorkbooks>; elapsed: number } {
  let best = Infinity;
  let rows: ReturnType<typeof diffWorkbooks> = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    rows = diffWorkbooks(workbookOf(before), workbookOf(after));
    best = Math.min(best, performance.now() - t0);
  }
  return { rows, elapsed: best };
}

const N = 10_000;
const BUDGET_MS = 500;

describe("diffWorkbooks: scattered edits inside a low-cardinality gap with one insert (reviewer repro A)", () => {
  it("resolves to exactly one insert plus the five genuine edits, at N=10,000", () => {
    const before: string[] = [];
    for (let r = 1; r <= N; r++) before.push(r % 2 === 0 ? "y" : "x");

    const editedBeforeRows = new Set([1000, 3000, 5000, 7000, 9000]);
    const after: string[] = ["NEW"];
    for (let r = 1; r <= N; r++) {
      after.push(editedBeforeRows.has(r) ? "EDITED" : before[r - 1]!);
    }

    const { rows, elapsed } = timedDiff(before, after);
    assert.ok(elapsed < BUDGET_MS, `took ${elapsed.toFixed(1)}ms, budget is ${BUDGET_MS}ms`);

    assert.equal(rows.length, 7, `expected 7 rows, got ${rows.length}: ${JSON.stringify(rows.slice(0, 10))}`);
    assert.deepEqual(
      rows.filter((r) => r.kind === "structure"),
      [{ sheet: "Sheet1", cell: "1:1", kind: "structure", note: "row inserted" }],
    );
    assert.equal(rows.filter((r) => r.kind === "value" && r.valueAfter === "EDITED").length, 5);
  });
});

describe("diffWorkbooks: an insert in the middle of a cycling gap with edits on both sides (reviewer repro B)", () => {
  it("resolves to exactly one insert plus the six genuine edits, at N=10,000", () => {
    const states = ["open", "closed", "pending", "hold"];
    const before: string[] = [];
    for (let r = 1; r <= N; r++) before.push(states[r % states.length]!);

    const editedBeforeRows = new Set([4990, 4995, 4998, 5001, 5004, 5010]);
    const after: string[] = [];
    for (let r = 1; r <= N; r++) {
      if (r === 5000) after.push("NEW");
      after.push(editedBeforeRows.has(r) ? "EDITED" : before[r - 1]!);
    }

    const { rows, elapsed } = timedDiff(before, after);
    assert.ok(elapsed < BUDGET_MS, `took ${elapsed.toFixed(1)}ms, budget is ${BUDGET_MS}ms`);

    assert.equal(rows.length, 8, `expected 8 rows, got ${rows.length}: ${JSON.stringify(rows.slice(0, 10))}`);
    assert.equal(rows.filter((r) => r.kind === "structure").length, 1);
    assert.equal(rows.filter((r) => r.kind === "value" && r.valueAfter === "EDITED").length, 6);
  });
});

describe("diffWorkbooks: a single oversize hunk of mutually unrelated rows", () => {
  /**
   * Builds ["ANCHOR_TOP", <n> before-block values, "ANCHOR_BOTTOM"] and
   * ["ANCHOR_TOP", <m> after-block values, "ANCHOR_BOTTOM"] where every before-block value is
   * distinct from every after-block value - no shared signature at all, so Myers resolves the
   * whole block as one contiguous delete-run + insert-run (a single hunk), re-resolved by
   * `pairGapWindowed`. The anchors pin the block as its own gap regardless of block size.
   */
  function unrelatedBlockWorkbooks(beforeCount: number, afterCount: number): { before: WorkbookSnapshot; after: WorkbookSnapshot } {
    const beforeValues = ["ANCHOR_TOP", ...Array.from({ length: beforeCount }, (_, i) => `before-unrelated-${i}`), "ANCHOR_BOTTOM"];
    const afterValues = ["ANCHOR_TOP", ...Array.from({ length: afterCount }, (_, i) => `after-unrelated-${i}`), "ANCHOR_BOTTOM"];
    return { before: workbookOf(beforeValues), after: workbookOf(afterValues) };
  }

  it("250 vs 250 unrelated rows: pairs positionally as pure value edits, no approximate note (equal-size hunk is exact even past the window)", () => {
    const { before, after } = unrelatedBlockWorkbooks(250, 250);
    const rows = diffWorkbooks(before, after);
    assert.equal(rows.filter((r) => r.kind === "structure").length, 0);
    assert.equal(rows.filter((r) => r.kind === "value").length, 250);
    assert.ok(rows.every((r) => !r.note?.toLowerCase().includes("approximate")));
  });

  it("250 vs 260 unrelated rows: the size mismatch past the window is flagged approximate", () => {
    const { before, after } = unrelatedBlockWorkbooks(250, 260);
    const rows = diffWorkbooks(before, after);
    const structureRows = rows.filter((r) => r.kind === "structure");
    assert.equal(structureRows.length, 10);
    assert.ok(structureRows.every((r) => r.note?.toLowerCase().includes("approximate")));
  });

  it("150 vs 160 unrelated rows: within the window, resolved exactly, no approximate note", () => {
    const { before, after } = unrelatedBlockWorkbooks(150, 160);
    const rows = diffWorkbooks(before, after);
    const structureRows = rows.filter((r) => r.kind === "structure");
    assert.equal(structureRows.length, 10);
    assert.ok(structureRows.every((r) => !r.note?.toLowerCase().includes("approximate")));
  });
});

describe("diffWorkbooks: an edit distance beyond the alignment budget falls back with an approximate note", () => {
  it("still completes a fully-rewritten 10,000-row sheet in under 2s, flagging the fallback", () => {
    const before: string[] = [];
    for (let r = 1; r <= N; r++) before.push(`before-${r}`);
    const after: string[] = [];
    for (let r = 1; r <= N; r++) after.push(`after-${r}`); // every single value differs - no anchors, no cheap trim
    after.push("after-extra"); // unequal counts - forces the gap through Myers instead of the equal-count fast path

    const { rows, elapsed } = timedDiff(before, after);
    assert.ok(elapsed < 2000, `took ${elapsed.toFixed(1)}ms, budget is 2000ms`);

    const structureRows = rows.filter((r) => r.kind === "structure");
    assert.ok(structureRows.length > 0);
    assert.ok(
      structureRows.some((r) => r.note?.toLowerCase().includes("approximate")),
      `expected an approximate-alignment note on at least one structure row, got: ${JSON.stringify(structureRows)}`,
    );
  });
});
