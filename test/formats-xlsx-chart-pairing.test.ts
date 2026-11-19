import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";

// with two charts on a sheet, a removal must not read as an edit of the survivor. Workbooks are built from the openpyxl fixture
// chart-edit-a.xlsx (one chart, titled "Revenue vs Cost", anchored at F2) by cloning its chart part and drawing anchor.
const base = (): Record<string, Uint8Array> => unzipSync(readFileSync("test/fixtures/chart-edit-a.xlsx"));
const str = (b: Uint8Array): string => Buffer.from(b).toString("utf8");
interface Spec { title: string; col: number; row?: number; type?: "line" | "bar"; reformat?: boolean }

function book(specs: Spec[]): Uint8Array {
  const p = base();
  const chart = str(p["xl/charts/chart1.xml"]!);
  const drawing = str(p["xl/drawings/drawing1.xml"]!);
  const anchor = /<oneCellAnchor>[\s\S]*<\/oneCellAnchor>/.exec(drawing)![0];
  let anchors = "";
  let rels = "";
  let types = str(p["[Content_Types].xml"]!).replace(/<Override PartName="\/xl\/charts\/chart1.xml"[^>]*\/>/, "");
  specs.forEach((s, i) => {
    let xml = chart.replace("Revenue vs Cost", s.title);
    if (s.type === "bar") xml = xml.replace(/lineChart/g, "barChart");
    if (s.reformat) xml = xml.replace(/></g, ">\n<");
    p[`xl/charts/chart${i + 1}.xml`] = Buffer.from(xml);
    anchors += anchor.replace(/<col>\d+<\/col>/, `<col>${s.col}</col>`).replace(/<row>\d+<\/row>/, `<row>${s.row ?? 1}</row>`).replace('r:id="rId1"', `r:id="rId${i + 1}"`);
    rels += `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/xl/charts/chart${i + 1}.xml" Id="rId${i + 1}"/>`;
    types = types.replace("</Types>", `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
  });
  p["xl/drawings/drawing1.xml"] = Buffer.from(drawing.replace(anchor, anchors));
  p["xl/drawings/_rels/drawing1.xml.rels"] = Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`);
  p["[Content_Types].xml"] = Buffer.from(types);
  return zipSync(p);
}
const rows = (a: Uint8Array, b: Uint8Array): string[] => mediaChanges(".xlsx", a, b).map((r) => `${r.kind} | ${r.title ?? ""}${r.detail ? " | " + r.detail : ""}`);

const alpha: Spec = { title: "Alpha sales", col: 5 };
const beta: Spec = { title: "Beta costs", col: 5, row: 20, type: "bar" };

describe("two charts on one sheet (reviewer probe: Alpha removed, Beta restyled by another writer)", () => {
  const before = book([alpha, { ...beta, reformat: true }]);
  it("removing Alpha reads as Alpha removed, Beta untouched, never Beta removed", () => {
    assert.deepEqual(rows(before, book([beta])), ["chart removed | Alpha sales"]);
  });
  it("removing Beta reads as Beta removed", () => {
    assert.deepEqual(rows(before, book([alpha])), ["chart removed | Beta costs"]);
  });
  it("a title edit on one of two charts is still one change, found by anchor", () => {
    assert.deepEqual(rows(book([alpha, beta]), book([{ ...alpha, title: "Alpha sales 2026" }, beta])), ['chart changed | Alpha sales 2026 | title "Alpha sales" → "Alpha sales 2026"']);
  });
  it("ambiguous (both titles edited, both anchors moved) falls back to removed plus added", () => {
    const r = rows(book([alpha, beta]), book([{ ...alpha, title: "A2", col: 9 }, { ...beta, title: "B2", col: 9, row: 40 }])).sort();
    assert.deepEqual(r, ["chart added | A2", "chart added | B2", "chart removed | Alpha sales", "chart removed | Beta costs"]);
  });
  it("a removal plus a new chart at another place is removed plus added", () => {
    assert.deepEqual(rows(book([alpha, beta]), book([beta, { title: "Gamma", col: 12, row: 3 }])).sort(), ["chart added | Gamma", "chart removed | Alpha sales"]);
  });
});

describe("one chart per sheet keeps today's behaviour", () => {
  it("a title edit pairs even when the anchor moved", () => {
    assert.deepEqual(rows(book([alpha]), book([{ ...alpha, title: "Alpha 2", col: 9 }])), ['chart changed | Alpha 2 | title "Alpha sales" → "Alpha 2"']);
  });
  it("a lone removal reads removed", () => {
    assert.deepEqual(rows(book([alpha]), book([])), ["chart removed | Alpha sales"]);
  });
});
