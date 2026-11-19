// an embedded chart edited in place is ONE modified change (paired by its Excel object name, "Chart 1"), not removed plus added.
// Real fixture: excel-region chart-removed-before.xlsx (chart "Squares", object "Chart 1", series 'Data'!$B$2:$B$41).
// Guards against: pairing two different charts as one (a removal missed). A chart pairs only on an exact object-name match on the same sheet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { planExcel, type ExcelPlan, type XChange } from "../src/office/connector/excel/diff.ts";

const FX = path.join(import.meta.dirname, "fixtures", "excel-region");
const BEFORE = readFileSync(path.join(FX, "chart-removed-before.xlsx"));
const patch = (f: (chart: string, drawing: string) => { chart?: string; drawing?: string }): Uint8Array => {
  const files = unzipSync(BEFORE);
  const r = f(strFromU8(files["xl/charts/chart1.xml"]!), strFromU8(files["xl/drawings/drawing1.xml"]!));
  return zipSync({ ...files, ...(r.chart !== undefined ? { "xl/charts/chart1.xml": strToU8(r.chart) } : {}), ...(r.drawing !== undefined ? { "xl/drawings/drawing1.xml": strToU8(r.drawing) } : {}) });
};
const charts = (p: ExcelPlan): XChange[] => p.changes.filter((c) => c.kind === "chart");
const boxed = (p: ExcelPlan, side: "before" | "after", id: string) => p[side].flatMap((s) => s.areas.flatMap((a) => a.boxes)).find((b) => b.change === id);

describe("chart edited in place", () => {
  it("title-only edit (Squares -> Squares (edited)): one modified change naming the title, framed on both sides by the object name", () => {
    const after = patch((c) => ({ chart: c.replace("<a:t>Squares</a:t>", "<a:t>Squares (edited)</a:t>") }));
    const p = planExcel(BEFORE, after);
    const cs = charts(p);
    assert.equal(cs.length, 1, JSON.stringify(p.changes.map((c) => `${c.mark} ${c.text}`)));
    assert.equal(cs[0]!.mark, "changed");
    assert.match(cs[0]!.text ?? "", /title "Squares" → "Squares \(edited\)"/);
    assert.ok(!p.changes.some((c) => c.mark === "removed" || c.mark === "added"));
    for (const side of ["before", "after"] as const) assert.equal(boxed(p, side, cs[0]!.id)?.drawing, "Chart 1", side);
  });
  it("series range edit: one modified change naming the old and new range", () => {
    const p = planExcel(BEFORE, patch((c) => ({ chart: c.replace("$B$41", "$B$30") })));
    const cs = charts(p);
    assert.equal(cs.length, 1);
    assert.equal(cs[0]!.mark, "changed");
    assert.match(cs[0]!.text ?? "", /series range Data!B2:B41 → Data!B2:B30/);
  });
  it("several differences (title, type, range) are listed in one change", () => {
    const p = planExcel(BEFORE, patch((c) => ({ chart: c.replace("<a:t>Squares</a:t>", "<a:t>Cubes</a:t>").replace(/lineChart/g, "barChart").replace("$B$41", "$B$30") })));
    const cs = charts(p);
    assert.equal(cs.length, 1);
    for (const re of [/title "Squares" → "Cubes"/, /type line → column/, /series range/]) assert.match(cs[0]!.text ?? "", re);
  });
  it("an axis title added is named", () => {
    const p = planExcel(BEFORE, patch((c) => ({ chart: c.replace("<axPos val=\"l\"/><majorGridlines/>", "<axPos val=\"l\"/><majorGridlines/><title><tx><rich><a:p xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:r><a:t>Total</a:t></a:r></a:p></rich></tx></title>") })));
    assert.match(charts(p)[0]?.text ?? "", /value axis title none → "Total"/);
  });
  it("rename with the same object name (title and type both new) is still one modified change, never removed plus added", () => {
    const p = planExcel(BEFORE, patch((c) => ({ chart: c.replace("<a:t>Squares</a:t>", "<a:t>Something else</a:t>").replace(/lineChart/g, "barChart") })));
    assert.deepEqual(p.changes.filter((c) => c.kind === "chart").map((c) => c.mark), ["changed"]);
  });
  it("identical chart XML gives no chart change", () => {
    assert.equal(charts(planExcel(BEFORE, patch(() => ({})))).length, 0);
  });
  it("a different object name never pairs, even with the same title: removed plus added", () => {
    const after = patch((_c, d) => ({ drawing: d.replace('name="Chart 1"', 'name="Chart 7"') , chart: _c.replace("$B$41", "$B$30") }));
    const p = planExcel(BEFORE, after);
    assert.deepEqual(charts(p).map((c) => c.mark).sort(), ["added", "removed"]);
  });
  it("a renamed object with an edited title stays removed plus added", () => {
    const after = patch((c, d) => ({ drawing: d.replace('name="Chart 1"', 'name="Chart 7"'), chart: c.replace("<a:t>Squares</a:t>", "<a:t>Squares (edited)</a:t>") }));
    const p = planExcel(BEFORE, after);
    assert.deepEqual(charts(p).map((c) => c.mark).sort(), ["added", "removed"]);
  });
});
