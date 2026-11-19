import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { diffWorkbooks } from "../src/office/connector/xlsx/diff.ts";
import { colToNum, numToCol } from "../src/office/connector/xlsx/formula.ts";
import type { DiffRow, WorkbookSnapshot } from "../src/office/connector/xlsx/types.ts";

// A cell a row or column shift moved counts as unchanged only if its after formula is exactly
// the before formula with every ref moved the way Excel moves it; a ref into a deleted row or
// column never counts as a pure shift.

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

function loadDiff(pairName: string): DiffRow[] {
  const before = readWorkbookSnapshot(readFileSync(`${fixturesDir}${pairName}-before.xlsx`));
  const after = readWorkbookSnapshot(readFileSync(`${fixturesDir}${pairName}-after.xlsx`));
  return diffWorkbooks(before, after);
}

/** One sheet `S` from address -> [value, formula]. */
function sheet(cells: Map<string, [number | null, string | null]>): WorkbookSnapshot {
  return {
    sheets: [
      {
        name: "S",
        cells: new Map([...cells].map(([address, [value, formula]]) => [address, { address, value, formula, numFmt: "General" }])),
      },
    ],
  };
}

/** A rows x cols grid of distinct values, with `formulas` (address -> text) in place of values. */
function grid(rows: number, cols: number, formulas: Record<string, string>): Map<string, [number | null, string | null]> {
  const out = new Map<string, [number | null, string | null]>();
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) out.set(`${numToCol(c)}${r}`, [r * 100 + c, null]);
  }
  for (const [address, formula] of Object.entries(formulas)) out.set(address, [null, formula]);
  return out;
}

type Op = { axis: "row" | "col"; kind: "insert" | "delete"; at: number };

/** Where Excel moves index `n` on `axis` under `op`: null when `op` deleted it. */
function moveIndex(op: Op, axis: "row" | "col", n: number): number | null {
  if (op.axis !== axis || n < op.at) return n;
  if (op.kind === "insert") return n + 1;
  return n === op.at ? null : n - 1;
}

/** Excel's rewrite of a single-ref formula `<ref>*2` under `op`. */
function excelRemap(formula: string, op: Op): string {
  const m = /^([A-Z]+)(\d+)\*2$/.exec(formula)!;
  const col = moveIndex(op, "col", colToNum(m[1]!));
  const row = moveIndex(op, "row", Number(m[2]));
  return col === null || row === null ? "#REF!*2" : `${numToCol(col)}${row}*2`;
}

/** `cells` as Excel leaves them after `op`: cells moved, cells in a deleted line dropped, formulas remapped. */
function applyOp(cells: Map<string, [number | null, string | null]>, op: Op): Map<string, [number | null, string | null]> {
  const out = new Map<string, [number | null, string | null]>();
  for (const [address, [value, formula]] of cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(address)!;
    const col = moveIndex(op, "col", colToNum(m[1]!));
    const row = moveIndex(op, "row", Number(m[2]));
    if (col === null || row === null) continue;
    out.set(`${numToCol(col)}${row}`, [value, formula === null ? null : excelRemap(formula, op)]);
  }
  return out;
}

const formulaCells = (rows: DiffRow[]) => rows.filter((r) => r.kind === "formula").map((r) => r.cell);

describe("moved formulas retargeted by hand under a detected shift", () => {
  it("(a) insert column C, F1 =B1*2 becomes G1 =C1*2: one formula row", () => {
    const before = grid(5, 5, { F1: "B1*2" });
    const after = applyOp(before, { axis: "col", kind: "insert", at: 3 });
    assert.equal(after.get("G1")![1], "B1*2");
    after.set("G1", [null, "C1*2"]);
    assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), ["F1->G1"]);
  });

  it("(b) insert row 5, C8 =A2*2 becomes C9 =A3*2: one formula row", () => {
    const before = grid(8, 3, { C8: "A2*2" });
    const after = applyOp(before, { axis: "row", kind: "insert", at: 5 });
    assert.equal(after.get("C9")![1], "A2*2");
    after.set("C9", [null, "A3*2"]);
    assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), ["C8->C9"]);
  });

  for (const repointed of ["E1*2", "D1*2"]) {
    it(`(c) delete column E, J1 =E1*2 becomes I1 =${repointed}: one formula row`, () => {
      const before = grid(8, 8, { J1: "E1*2" });
      const after = applyOp(before, { axis: "col", kind: "delete", at: 5 });
      assert.equal(after.get("I1")![1], "#REF!*2");
      after.set("I1", [null, repointed]);
      assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), ["J1->I1"]);
    });
  }

  for (const repointed of ["A5*2", "A4*2"]) {
    it(`(c) delete row 5, D8 =A5*2 becomes D7 =${repointed}: one formula row`, () => {
      const before = grid(8, 3, { D8: "A5*2" });
      const after = applyOp(before, { axis: "row", kind: "delete", at: 5 });
      after.set("D7", [null, repointed]);
      assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), ["D8->D7"]);
    });
  }

  it("(d) a seeded fuzz of +/-1 retargets under random row and column inserts and deletes misses none", () => {
    // mulberry32: a fixed seed keeps the fuzz reproducible.
    let seed = 0x5eed063;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

    const misses: string[] = [];
    const falsePositives: string[] = [];
    let trials = 0;
    while (trials < 2000) {
      const rows = int(3, 30);
      const cols = int(3, 10);
      const formulas: Record<string, string> = {};
      for (let i = int(1, 6); i > 0; i--) formulas[`${numToCol(int(1, cols))}${int(1, rows)}`] = `${numToCol(int(1, cols))}${int(1, rows)}*2`;
      const before = grid(rows, cols, formulas);
      const axis = rand() < 0.5 ? "row" : "col";
      const op: Op = { axis, kind: rand() < 0.5 ? "insert" : "delete", at: int(1, axis === "row" ? rows : cols) };
      const excel = applyOp(before, op);

      // No hand edit: nothing but the shift and Excel's own #REF! rewrites may show as formula rows.
      for (const cell of formulaCells(diffWorkbooks(sheet(before), sheet(excel)))) {
        const beforeAddr = cell.split("->")[0]!;
        const inDeletedLine = !applyOp(new Map([[beforeAddr, [null, null]]]), op).has(cell.split("->").pop()!);
        const refBroken = excel.get(cell.split("->").pop()!)?.[1]?.startsWith("#REF!") ?? false;
        if (!refBroken && !inDeletedLine) falsePositives.push(`${JSON.stringify(op)} ${cell}`);
      }

      // Retarget one surviving formula's ref by +/-1 on one axis.
      const survivors = [...excel].filter(([, [, f]]) => f !== null);
      if (survivors.length === 0) continue;
      const [target, [, excelText]] = survivors[int(0, survivors.length - 1)]!;
      const original = [...before].find(([address, [, f]]) => f !== null && applyOp(new Map([[address, [null, f]]]), op).has(target))![1][1]!;
      const m = /^([A-Z]+)(\d+)\*2$/.exec(original)!;
      let col = colToNum(m[1]!);
      let row = Number(m[2]);
      const moved = { col: moveIndex(op, "col", col), row: moveIndex(op, "row", row) };
      if (moved.col !== null && moved.row !== null) [col, row] = [moved.col, moved.row];
      const delta = rand() < 0.5 ? -1 : 1;
      if (rand() < 0.5) col = col + delta >= 1 ? col + delta : col - delta;
      else row = row + delta >= 1 ? row + delta : row - delta;
      const edited = `${numToCol(col)}${row}*2`;
      if (edited === excelText) continue;
      trials++;
      const after = new Map(excel);
      after.set(target, [null, edited]);
      const hit = formulaCells(diffWorkbooks(sheet(before), sheet(after))).some((cell) => cell.split("->").pop() === target);
      if (!hit) misses.push(`${JSON.stringify(op)} ${original} -> ${target} ${edited} (excel: ${excelText})`);
    }
    assert.deepEqual({ misses: misses.length, falsePositives: falsePositives.length }, { misses: 0, falsePositives: 0 }, [...falsePositives.slice(0, 8), ...misses.slice(0, 4)].join("\n"));
  });
});

describe("refs past the used range, into absent rows, and into cleared rows", () => {
  it("(f) delete row 5 on a 10x3 grid, C8 =A15*2 becomes C7 =A15*2: one formula row", () => {
    const before = grid(10, 3, { C8: "A15*2" });
    const after = applyOp(before, { axis: "row", kind: "delete", at: 5 });
    assert.equal(after.get("C7")![1], "A14*2");
    after.set("C7", [null, "A15*2"]);
    assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), ["C8->C7"]);
  });

  it("(f) a range past the used range kept by hand under a row delete: one formula row", () => {
    const before = grid(10, 3, { C8: "SUM(B1:B3)+SUM(A12:A40)" });
    const after = applyOp(new Map([...before].filter(([a]) => a !== "C8")), { axis: "row", kind: "delete", at: 5 });
    after.set("C7", [null, "SUM(B1:B3)+SUM(A11:A39)"]);
    assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), []);
    after.set("C7", [null, "SUM(B1:B3)+SUM(A12:A40)"]);
    assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), ["C8->C7"]);
  });

  it("(g) delete column B on an 8x6 grid, F8 =H1*2 becomes E8 =H1*2: one formula row", () => {
    const before = grid(8, 6, { F8: "H1*2" });
    const after = applyOp(before, { axis: "col", kind: "delete", at: 2 });
    assert.equal(after.get("E8")![1], "G1*2");
    after.set("E8", [null, "H1*2"]);
    assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), ["F8->E8"]);
  });

  for (const repointed of ["A4*2", "A5*2"]) {
    it(`(h) delete an absent blank row 5, C10 =A5*2 becomes C9 =${repointed}: one formula row`, () => {
      const before = grid(10, 3, { C10: "A5*2" });
      for (const col of ["A", "B", "C"]) before.delete(`${col}5`);
      before.set("A4", [0, null]);
      const after = applyOp(before, { axis: "row", kind: "delete", at: 5 });
      assert.equal(after.get("C9")![1], "#REF!*2");
      after.set("C9", [null, repointed]);
      assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), ["C10->C9"]);
    });
  }

  it("(i) clear row 10 and insert row 5, C1 =A10*2 becomes =A11*2: no formula row", () => {
    const before = grid(12, 3, { C1: "A10*2" });
    const cleared = new Map([...before].filter(([a]) => !/^[A-C]10$/.test(a)));
    const after = applyOp(cleared, { axis: "row", kind: "insert", at: 5 });
    assert.equal(after.get("C1")![1], "A11*2");
    assert.deepEqual(formulaCells(diffWorkbooks(sheet(before), sheet(after))), []);
  });
});

describe("(e) the three live Excel-saved pairs keep their counts", () => {
  const counts = (rows: DiffRow[]) => ({
    structure: rows.filter((r) => r.kind === "structure").length,
    value: rows.filter((r) => r.kind === "value").length,
    formula: rows.filter((r) => r.kind === "formula").length,
  });

  it("column insert at Inputs!M: 1 structure row, nothing else", () => {
    assert.deepEqual(counts(loadDiff("column-insert")), { structure: 1, value: 0, formula: 0 });
  });

  it("column insert at Inputs!D with cross-sheet refs: 1 structure, 18 format-only value rows, 0 formula rows", () => {
    assert.deepEqual(counts(loadDiff("column-insert-crosssheet")), { structure: 1, value: 18, formula: 0 });
  });

  it("row insert at Inputs!10 plus a 200-cell block: 1 structure, 123 value, 80 formula rows", () => {
    assert.deepEqual(counts(loadDiff("shifted-crosssheet")), { structure: 1, value: 123, formula: 80 });
  });
});
