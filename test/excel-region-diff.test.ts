// The Excel connector's change list and print plan (src/office/connector/excel/diff.ts) over openpyxl-written before/after pairs
// (test/fixtures/excel-region, built by test/fixtures/build-excel-region-fixtures.py). Pure: no Office, no helper.
// Must not: a real change hidden (an exception swallowed by a pattern, a chart removal under cell noise, a hidden-row edit
// with no reason), a before window that is not the image of the after window, and a created file that lists thousands of cells.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { answerExcel } from "../src/office/connector/excel/answer.ts";
import { clusterItems, LIMITS, planExcel, rangeText, win, type ExcelPlan, type XChange } from "../src/office/connector/excel/diff.ts";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";

const FX = path.join(import.meta.dirname, "fixtures", "excel-region");
const side = (id: string, s: "before" | "after"): Uint8Array | null => { const b = readFileSync(path.join(FX, `${id}-${s}.xlsx`)); return b.length ? b : null; };
const plan = (id: string): ExcelPlan => planExcel(side(id, "before"), side(id, "after"));
const areas = (p: ExcelPlan, s: "before" | "after", sheet?: string) => p[s].filter((x) => sheet === undefined || x.name === sheet).flatMap((x) => x.areas.map((a) => ({ ...a, sheet: x.name, range: rangeText(a.rect) })));
const find = (p: ExcelPlan, f: (c: XChange) => boolean): XChange => { const c = p.changes.find(f); assert.ok(c, JSON.stringify(p.changes.map((x) => `${x.label} ${x.text ?? ""}`))); return c!; };
const unplaced = (c: XChange): Record<string, string> | undefined => c.private?.unplaced as Record<string, string> | undefined;
const covers = (a: { rect: { r1: number; r2: number; c1: number; c2: number } }, r: number, c: number): boolean => a.rect.r1 <= r && r <= a.rect.r2 && a.rect.c1 <= c && c <= a.rect.c2;

describe("the Excel region diff over openpyxl fixtures", () => {
  it("single edit: one change, one area centred on it, the same window both sides", () => {
    const p = plan("single-edit");
    assert.deepEqual(p.changes.map((c) => [c.label, c.before, c.after]), [["Sheet1!C50", "150", "changed"]]);
    const [b] = areas(p, "before"), [a] = areas(p, "after");
    assert.equal(b!.range, "A46:E55");
    assert.equal(a!.range, b!.range);
    assert.equal(a!.group, b!.group);
  });

  it("insert block: one 'rows inserted' change (no cell list), folded after pieces, the before window at the seam", () => {
    const p = plan("insert-block");
    const ins = find(p, (c) => c.kind === "rows-inserted");
    assert.equal(ins.text, "316 rows inserted after row 934 (now rows 935-1,250)");
    assert.ok(ins.lines?.includes("Column C: =B935*2 filled down"), JSON.stringify(ins.lines));
    assert.ok(!p.changes.some((c) => ["value", "formula", "pattern"].includes(c.kind)), "no cell changes for rows that only moved");
    const fold = find(p, (c) => c.kind === "fold");
    assert.equal(fold.parent, ins.id);
    assert.match(fold.text!, /all inserted, no other changes/);
    const after = areas(p, "after"), before = areas(p, "before");
    assert.equal(after.length, 2);
    assert.ok(after[0]!.rect.r1 <= 932 && after[0]!.rect.r2 >= 942, after[0]!.range);
    assert.ok(after[1]!.rect.r1 <= 1243 && after[1]!.rect.r2 >= 1253, after[1]!.range);
    assert.equal(before.length, 1);
    assert.ok(before[0]!.rect.r1 <= 932 && before[0]!.rect.r2 >= 935, before[0]!.range);
    assert.ok([...after, ...before].every((x) => x.group === after[0]!.group));
  });

  it("delete block: one 'rows deleted' change; the after window is the seam, the before side keeps both edges", () => {
    const p = plan("delete-block");
    assert.equal(find(p, (c) => c.kind === "rows-deleted").text, "50 rows deleted (were rows 400-449)");
    const before = areas(p, "before"), after = areas(p, "after");
    assert.equal(before.length, 2);
    assert.ok(covers(before[0]!, 400, 1) && covers(before[1]!, 449, 1));
    assert.equal(after.length, 1);
    assert.ok(covers(after[0]!, 399, 1) && covers(after[0]!, 400, 1), after[0]!.range);
  });

  it("filled-down pattern with exceptions: one parent naming them, each exception its own child with its own area; the error is named", () => {
    const p = plan("pattern-exception");
    const parent = find(p, (c) => c.kind === "pattern" && c.label === "Calc!C2:C2001");
    assert.match(parent.text!, /except rows 40, 1,200, 1,500, 2,001/);
    const kids = p.changes.filter((c) => c.parent === parent.id && c.kind !== "fold");
    assert.deepEqual(kids.map((c) => c.label), ["Calc!C40", "Calc!C1200", "Calc!C1500", "Calc!C2001"]);
    assert.ok(kids[0]!.lines?.some((l) => /#DIV\/0!/.test(l)), JSON.stringify(kids[0]));
    const after = areas(p, "after");
    for (const r of [40, 1200, 1500, 2001]) assert.ok(after.some((a) => covers(a, r, 3)), `row ${r} is pictured: ${after.map((a) => a.range).join(" ")}`);
    assert.ok(after.every((a) => a.rect.r2 - a.rect.r1 + 1 <= LIMITS.maxAreaRows));
  });

  it("sort plus one edit: one reorder change and exactly one cell change, each side's window around its own row", () => {
    const p = plan("sort");
    find(p, (c) => c.kind === "reorder");
    const cells = p.changes.filter((c) => c.kind === "value");
    assert.equal(cells.length, 1);
    assert.equal(cells[0]!.after, "EDITED");
    const [b] = areas(p, "before"), [a] = areas(p, "after");
    assert.ok(covers(b!, 251, 3), b!.range); // id 250 was on row 251 before the sort
    const row = Number(/C(\d+)/.exec(cells[0]!.label)![1]);
    assert.ok(covers(a!, row, 3), a!.range);
    assert.ok(b!.rect.r2 - b!.rect.r1 < 20 && a!.rect.r2 - a!.rect.r1 < 20);
  });

  it("chart dropped on an openpyxl rewrite: the removal ranks first, no style or string noise, the anchor area pictured", () => {
    const p = plan("chart-removed");
    assert.deepEqual(p.changes.map((c) => c.kind), ["chart", "value"]);
    assert.equal(p.changes[0]!.text, "Chart 'Squares' removed from sheet Data");
    const [b] = areas(p, "before");
    assert.ok(covers(b!, 2, 5) && covers(b!, 10, 2), b!.range);
  });

  it("hidden row, hidden column, hidden sheet: no area, a stated reason; the visible edit is pictured", () => {
    const p = plan("hidden-row");
    assert.equal(unplaced(find(p, (c) => c.label === "Main!B20"))?.after, "in hidden row 20");
    assert.equal(unplaced(find(p, (c) => c.label === "Main!D5"))?.after, "in hidden column D");
    assert.equal(unplaced(find(p, (c) => c.label === "Secret!A1"))?.after, "on the hidden sheet Secret");
    assert.ok(find(p, (c) => c.label === "Main!B20").lines?.includes("Not in the pictures: in hidden row 20."));
    const after = areas(p, "after");
    assert.deepEqual(after.map((a) => a.sheet), ["Main"]);
    assert.ok(covers(after[0]!, 30, 2));
    assert.equal(unplaced(find(p, (c) => c.label === "Main!B30")), undefined);
  });

  it("created workbook: one change per sheet, never thousands of cells; one-sided pictures with a placeholder", () => {
    const p = plan("created");
    assert.deepEqual(p.changes.map((c) => c.text), ["Sheet GDP created: 950 rows by 4 columns, 3,800 cells (949 formulas)", "Sheet CPI created: 900 rows by 3 columns, 2,700 cells (899 formulas)", "Sheet Notes created: 20 rows by 2 columns, 40 cells"]);
    assert.deepEqual(p.before, []);
    assert.equal(areas(p, "after").length, 3);
    assert.ok(p.groups.every((g) => g.placeholder?.before === "The file did not exist yet"));
  });

  it("renamed sheet: one rename change, the formulas pointing at it are not edits, the real edit is found", () => {
    const p = plan("renamed-sheet");
    assert.deepEqual(p.changes.map((c) => [c.kind, c.label]).sort(), [["sheet-renamed", "Sheet Inputs"], ["value", "Inputs!B5"]]);
  });

  it("recalculation cascade: one input change pictured, one summary of the recalculated cells caused by it, RAND only a caveat", () => {
    const p = plan("recalc-cascade");
    const input = find(p, (c) => c.label === "Assumptions!B1");
    assert.deepEqual([input.before, input.after], ["0.05", "0.07"]);
    const sum = find(p, (c) => c.kind === "derived");
    assert.equal(sum.causedBy, input.id);
    assert.equal(sum.private?.count, 500);
    assert.ok(unplaced(sum)?.after);
    assert.ok(!p.changes.some((c) => c.label.startsWith("Calc!C2")));
    assert.ok(p.caveats.some((c) => /RAND/.test(c)));
    assert.deepEqual(areas(p, "after").map((a) => a.sheet), ["Assumptions"]);
  });

  it("scattered edits: the changed total ranks first, same-column singles grouped (3 pictured), the H:K block one change, at most 6 areas", () => {
    const p = plan("scattered");
    const cells = p.changes.filter((c) => c.kind !== "group" && !c.parent);
    assert.equal(cells[0]!.label, "Ledger!D600");
    const grp = find(p, (c) => c.kind === "group");
    assert.match(grp.text!, /^197 single-cell edits in column D, rows 10-598/);
    const kids = p.changes.filter((c) => c.parent === grp.id);
    assert.equal(kids.length, 197);
    assert.equal(kids.filter((c) => !unplaced(c)).length, 3);
    assert.equal(find(p, (c) => c.label === "Ledger!H200:K204").text, "Values changed in 20 cells, H200:K204");
    assert.ok(areas(p, "after").length <= LIMITS.perSheet);
  });

  it("wide row edit: one change across the row, folded to a left and a right piece, each at most 15 columns", () => {
    const p = plan("wide");
    const run = find(p, (c) => c.kind === "row-run");
    assert.equal(run.label, "Wide!B5:AZ5");
    assert.match(find(p, (c) => c.kind === "fold").text!, /^Columns .+ not shown/);
    const after = areas(p, "after");
    assert.equal(after.length, 2);
    assert.ok(after.every((a) => a.rect.c2 - a.rect.c1 + 1 <= LIMITS.maxBlockCols && covers(a, 5, a.rect.c1 + 1)));
    assert.deepEqual(after.map((a) => a.range), areas(p, "before").map((a) => a.range));
  });

  it("FRED-like: rows added at the end, the formula change down column C as one pattern, the other sheet's edit; the chart sheet untouched", () => {
    const p = plan("series");
    assert.equal(find(p, (c) => c.kind === "rows-inserted").text, "12 rows added at the end (rows 952-963)");
    const pat = find(p, (c) => c.kind === "pattern");
    assert.equal(pat.label, "GDP!C6:C951");
    assert.equal(pat.before, "=B6/B2-1 (filled down)");
    assert.equal(pat.after, "=(B6/B2-1)*100 (filled down)");
    find(p, (c) => c.label === "Unemployment!B150");
    assert.ok(!p.changes.some((c) => c.kind === "chart" || /Chart/.test(c.label)));
    const gdp = areas(p, "after", "GDP");
    assert.ok(gdp.some((a) => covers(a, 6, 3)) && gdp.some((a) => covers(a, 951, 3) && covers(a, 963, 1)), gdp.map((a) => a.range).join(" "));
    assert.ok(gdp.every((a) => a.rect.r2 - a.rect.r1 + 1 <= LIMITS.maxAreaRows));
  });

  it("deletion at the end and a sheet emptied: no failure, the emptied sheet says so and has no after picture", () => {
    const p = plan("delete-end");
    assert.equal(find(p, (c) => c.kind === "rows-deleted").text, "51 rows deleted at the end (were rows 250-300)");
    const emptied = find(p, (c) => c.kind === "sheet-emptied");
    assert.match(emptied.text!, /^Sheet Old is now empty/);
    assert.deepEqual(areas(p, "after", "Old"), []);
    assert.ok(p.groups.some((g) => g.placeholder?.after === "The sheet is now empty: nothing to print"));
  });

  it("every fixture answers a valid level-2 document with no driver (the change list, the reason for no pictures)", async () => {
    const app = OFFICE_APPS.excel;
    for (const id of ["insert-block", "delete-block", "pattern-exception", "sort", "chart-removed", "hidden-row", "created", "renamed-sheet", "recalc-cascade", "scattered", "wide", "single-edit", "series", "delete-end"]) {
      const doc = await answerExcel(app, path.join(FX, `${id}-before.xlsx`), path.join(FX, `${id}-after.xlsx`), { driver: undefined, pager: { pages: async () => null, png: async () => null }, lockPath: "/nonexistent" });
      assert.deepEqual(checkChanges(doc, 2), [], id);
      assert.ok(doc.changes.length > 0 && doc.changes.length < 260, `${id}: ${doc.changes.length}`);
    }
  });
});

// ---- generic rules on a tiny workbook written here

function mini(rows: (string | number | null)[][], name = "S"): Uint8Array {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const col = (c: number): string => { let s = ""; for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const data = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => v === null ? "" : typeof v === "number" ? `<c r="${col(j + 1)}${i + 1}"><v>${v}</v></c>` : v.startsWith("=") ? `<c r="${col(j + 1)}${i + 1}"><f>${esc(v.slice(1))}</f></c>` : `<c r="${col(j + 1)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join("")}</row>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`),
  });
}
const grid = (n: number, f: (r: number) => (string | number | null)[]): (string | number | null)[][] => Array.from({ length: n }, (_, i) => f(i + 1));

describe("generic rules", () => {
  it("before and after address maps never mix: 50 rows inserted at 10, an edit at old row 400 is after row 450 and before row 400", () => {
    const before = grid(600, (r) => [`k${r}`, r, `=B${r}*2`]);
    const after = [...before.slice(0, 9).map((x, i) => [x[0], x[1], `=B${i + 1}*2`]), ...grid(50, (i) => [`new${i}`, 1000 + i, `=B${9 + i}*2`]), ...before.slice(9).map((x, i) => [x[0], x[1], `=B${60 + i}*2`])];
    after[449] = [after[449]![0]!, 777, after[449]![2]!]; // old row 400 is after row 450
    const p = planExcel(mini(before), mini(after));
    const edit = find(p, (c) => c.kind === "value");
    assert.equal(edit.label, "S!B450");
    assert.equal(edit.private?.beforeCell, "B400");
    assert.ok(!p.changes.some((c) => c.kind === "formula" || c.kind === "pattern"), "moved formulas are not edits");
    const b = areas(p, "before").find((a) => covers(a, 400, 2)), a = areas(p, "after").find((x) => covers(x, 450, 2));
    assert.ok(b && a && a.group === b.group, JSON.stringify([areas(p, "before"), areas(p, "after")]));
    assert.equal(a!.rect.r1 - b!.rect.r1, 50, "the after window is the before window moved by the insert");
  });

  it("block merge: items G-1 and G rows apart join, G+1 apart stay separate", () => {
    const item = (k: number) => ({ change: { id: `c${k}`, mark: "changed" as const, label: "x", kind: "value" }, k0: k, k1: k, m0: 0, m1: 0, score: 1, uniform: false });
    const gap = (g: number) => clusterItems([item(10), item(10 + g + 1)]).length;
    assert.equal(gap(LIMITS.gapRows - 1), 1);
    assert.equal(gap(LIMITS.gapRows), 1);
    assert.equal(gap(LIMITS.gapRows + 1), 2);
    // a regularly spaced run does not chain past the height cap
    const many = Array.from({ length: 100 }, (_, i) => item(i * 3));
    assert.ok(clusterItems(many).every((b) => b.k1 - b.k0 + 1 <= LIMITS.maxBlockRows));
  });

  it("windows keep their size at the sheet's edge: the shortfall moves to the open side", () => {
    assert.deepEqual(win(0, 0, 100, 3, 10), [0, 9]);
    assert.deepEqual(win(100, 100, 100, 3, 10), [91, 100]);
    assert.deepEqual(win(50, 50, 100, 3, 10), [46, 55]);
  });

  it("every changed cell belongs to exactly one change, and each pictured change to one group", () => {
    for (const id of ["scattered", "pattern-exception", "series"]) {
      const p = plan(id);
      const seen = new Map<string, number>();
      for (const c of p.changes) if (c.kind === "value" || c.kind === "formula") seen.set(c.label, (seen.get(c.label) ?? 0) + 1);
      assert.ok([...seen.values()].every((n) => n === 1), id);
      const groups = new Map<string, string>();
      for (const g of p.groups) for (const ch of g.changes) { assert.ok(!groups.has(ch), `${id}: ${ch} in two groups`); groups.set(ch, g.id); }
    }
  });
});
