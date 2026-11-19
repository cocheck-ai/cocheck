import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countDiffOps, diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import { numToCol } from "../src/office/connector/xlsx/formula.ts";
import type { CellSnapshot, WorkbookSnapshot } from "../src/office/connector/xlsx/types.ts";

/**
 * Worst case for the gap-fill step: N duplicate-value rows (all sharing one signature, so none
 * of them are anchor-eligible - the whole block becomes a single unequal-count gap) with one row
 * inserted. Before the prefix/suffix trim, `pairGap` built a full O(n*m) cross-product of
 * candidate pairs for this shape and OOM'd around N=8000 (see the review). Covers insert
 * at the top, middle, end, and a delete, all at N=10,000.
 */
function duplicateRowWorkbook(n: number): WorkbookSnapshot {
  const cells = new Map<string, CellSnapshot>();
  for (let r = 1; r <= n; r++) {
    cells.set(`A${r}`, { address: `A${r}`, value: "dup", formula: null, numFmt: "General" });
  }
  return { sheets: [{ name: "Sheet1", cells }] };
}

function withInsertAt(n: number, position: "top" | "middle" | "end"): WorkbookSnapshot {
  const rows: string[] = [];
  const insertIndex = position === "top" ? 0 : position === "middle" ? Math.floor(n / 2) : n;
  for (let i = 0; i < n; i++) {
    if (i === insertIndex) rows.push("NEWROW");
    rows.push("dup");
  }
  if (insertIndex === n) rows.push("NEWROW");
  const cells = new Map<string, CellSnapshot>();
  rows.forEach((value, i) => {
    const address = `A${i + 1}`;
    cells.set(address, { address, value, formula: null, numFmt: "General" });
  });
  return { sheets: [{ name: "Sheet1", cells }] };
}

function withOneDeleted(n: number): WorkbookSnapshot {
  const cells = new Map<string, CellSnapshot>();
  for (let r = 1; r <= n - 1; r++) {
    cells.set(`A${r}`, { address: `A${r}`, value: "dup", formula: null, numFmt: "General" });
  }
  return { sheets: [{ name: "Sheet1", cells }] };
}

/**
 * Fastest of three runs. A budget assertion guards against an algorithmic blowup, which slows every
 * run; a stall from a loaded machine (descheduling, GC, cold JIT) hits one run, so the minimum ignores it.
 */
function timedDiff(before: WorkbookSnapshot, after: WorkbookSnapshot): { rows: ReturnType<typeof diffWorkbooks>; elapsed: number } {
  let best = Infinity;
  let rows: ReturnType<typeof diffWorkbooks> = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    rows = diffWorkbooks(before, after);
    best = Math.min(best, performance.now() - t0);
  }
  return { rows, elapsed: best };
}

const N = 10_000;
const BUDGET_MS = 500;

describe("diffWorkbooks perf: 10,000 duplicate rows with one structural change", () => {
  for (const position of ["top", "middle", "end"] as const) {
    it(`completes an insert at the ${position} in under ${BUDGET_MS}ms`, () => {
      const before = duplicateRowWorkbook(N);
      const after = withInsertAt(N, position);
      const { rows, elapsed } = timedDiff(before, after);
      assert.ok(elapsed < BUDGET_MS, `took ${elapsed.toFixed(1)}ms, budget is ${BUDGET_MS}ms`);
      // Exactly one structural row plus its one cell diff - the surrounding duplicates must not
      // show up as noise. A row appended past the previous last row (the "end" case) is a plain
      // new cell, not an insertion, so it reports no structure row at all.
      assert.equal(rows.filter((r) => r.kind === "structure").length, position === "end" ? 0 : 1);
      assert.equal(rows.length, position === "end" ? 1 : 2);
    });
  }

  it(`completes a delete in under ${BUDGET_MS}ms`, () => {
    const before = duplicateRowWorkbook(N);
    const after = withOneDeleted(N);
    const { rows, elapsed } = timedDiff(before, after);
    assert.ok(elapsed < BUDGET_MS, `took ${elapsed.toFixed(1)}ms, budget is ${BUDGET_MS}ms`);
    assert.equal(rows.filter((r) => r.kind === "structure").length, 1);
  });
});

/** `rows` x `cols`: A a label, B the row number, then left-neighbour formulas (so a column insert at C crosses them). */
function wideFormulaSheet(rows: number, cols: number, insertAtC: boolean): WorkbookSnapshot {
  const cells = new Map<string, CellSnapshot>();
  const put = (address: string, value: string | number, formula: string | null = null) => cells.set(address, { address, value, formula, numFmt: "General" });
  const col = (c: number) => numToCol(insertAtC && c >= 3 ? c + 1 : c);
  for (let r = 1; r <= rows; r++) {
    put(`A${r}`, `label ${r}`);
    put(`B${r}`, r);
    for (let c = 3; c <= cols; c++) put(`${col(c)}${r}`, r * 1.05 ** (c - 2), `${col(c - 1)}${r}*1.05`);
  }
  return { sheets: [{ name: "Sheet1", cells }] };
}

describe("diffWorkbooks at 1000 x 550", () => {
  it("diffs a column insert with under twice the no-change work", () => {
    const before = wideFormulaSheet(1000, 550, false);
    const unchangedAfter = wideFormulaSheet(1000, 550, false);
    const insertedAfter = wideFormulaSheet(1000, 550, true);
    assert.deepEqual(diffWorkbooks(before, insertedAfter).map((r) => r.cell), ["C:C"]);
    // Counted operations, not wall-clock time: the same on every run, so a loaded machine can't fail it.
    const sum = (c: ReturnType<typeof countDiffOps>) => c.formulaSignatures + c.rowSignatureCells + c.cellsCompared;
    const unchanged = sum(countDiffOps(() => diffWorkbooks(before, unchangedAfter)));
    const inserted = sum(countDiffOps(() => diffWorkbooks(before, insertedAfter)));
    assert.ok(unchanged > 0, "the counter saw no work");
    assert.ok(inserted < 2 * unchanged, `column insert did ${inserted} operations, no change ${unchanged}`);
  });

  it("returns a diff with more rows than a call's argument limit without overflowing the stack", () => {
    const before = wideFormulaSheet(1000, 550, false);
    const after = wideFormulaSheet(1000, 550, false);
    for (const cell of after.sheets[0]!.cells.values()) if (cell.formula !== null) cell.value = (cell.value as number) + 1;
    assert.equal(diffWorkbooks(before, after).length, 548_000);
  });
});
