import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";

// Copilot C10b: openpyxl rewrote the package to change a chart title; the chart edit had no row ("file changed" only). Fixtures are
// openpyxl output (generator: test/fixtures/chart-title-edit-generator.py.txt).
const fx = (n: string): Uint8Array => readFileSync(`test/fixtures/chart-edit-${n}.xlsx`);
const rows = (n: string) => mediaChanges(".xlsx", fx("a"), fx(n)).map((r) => `${r.location} | ${r.kind} | ${r.detail ?? r.title ?? ""}`);

describe("xlsx chart edited in place gets a chart row", () => {
  it("title edit", () => {
    assert.deepEqual(rows("title"), ['Data!chart | chart changed | title "Revenue vs Cost" → "Revenue vs Cost 2026"']);
  });
  it("axis titles", () => {
    assert.deepEqual(rows("axis"), ['Data!chart | chart changed | category axis title none → "Month"; value axis title none → "Dollars"']);
  });
  it("series added and removed", () => {
    assert.deepEqual(rows("series-added"), ["Data!chart | chart changed | series added (Data!D2:D5)"]);
    assert.deepEqual(rows("series-removed"), ["Data!chart | chart changed | series removed (Data!C2:C5)"]);
  });
  it("chart type", () => {
    assert.deepEqual(rows("type"), ["Data!chart | chart changed | type line → column"]);
  });
  it("a renumbered chart part (chart1.xml became chart2.xml) is one change plus the genuinely new chart, never removed plus added", () => {
    assert.deepEqual(rows("renumbered").sort(), ['Data!chart | chart changed | title "Revenue vs Cost" → "Revenue vs Cost 2026"', "Extra!chart | chart added | Extra chart"]);
  });
});

describe("a chart edit is never mistaken for a removal", () => {
  it("an openpyxl round trip with no edit gives no chart row", () => {
    assert.deepEqual(rows("roundtrip"), []);
  });
  it("a genuine chart removal still reads as removed", () => {
    assert.deepEqual(rows("removed"), ["Data!chart | chart removed | Revenue vs Cost"]);
  });
  it("a rewrite that only adds whitespace between elements and renames the prefix gives no row", () => {
    const parts: Record<string, Uint8Array> = unzipSync(fx("a"));
    const xml = Buffer.from(parts["xl/charts/chart1.xml"]!).toString("utf8");
    assert.ok(xml.includes("<chartSpace"), "fixture shape: default-namespace chart");
    const reprefixed = xml.replace(/<(\/?)(chartSpace|chart|title|tx|rich|plotArea|lineChart|grouping|ser|idx|order|val|numRef|f|marker|symbol|axId|catAx|valAx|scaling|orientation|axPos|crossAx)(?=[\s>\/])/g, "<$1c:$2").replace("<c:chartSpace ", '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ').replace(/\sxmlns="http:\/\/schemas.openxmlformats.org\/drawingml\/2006\/chart"/, "").replace(/></g, ">\n<");
    assert.notEqual(reprefixed, xml);
    parts["xl/charts/chart1.xml"] = Buffer.from(reprefixed);
    assert.deepEqual(mediaChanges(".xlsx", fx("a"), zipSync(parts)), []);
  });
});
