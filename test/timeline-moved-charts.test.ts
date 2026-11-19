import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";

// c23. Six charts move from the data sheets to a new 'Charts' sheet with their XML unchanged: "moved" rows,
// never "removed N and added N" for the same charts. (a connector words the note for them; the reader's rows stay pinned.)

const enc = strToU8;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list: Array<[string, string, string]>): string => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const chartXml = (title: string, v: number): string => `<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:v>${v}</c:v></c:plotArea></c:chart></c:chartSpace>`;

function workbook(sheets: Array<{ name: string; charts: Array<[string, number]> }>): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": enc(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(rels(sheets.map((_, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`]))),
  };
  let n = 0;
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = enc(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`);
    if (s.charts.length === 0) return;
    files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = enc(rels([["rId1", "drawing", `../drawings/drawing${i + 1}.xml`]]));
    files[`xl/drawings/drawing${i + 1}.xml`] = enc(`<xdr:wsDr xmlns:xdr="x" xmlns:c="c" xmlns:r="${REL}">${s.charts.map((_, k) => `<c:chart r:id="rId${k + 1}"/>`).join("")}</xdr:wsDr>`);
    files[`xl/drawings/_rels/drawing${i + 1}.xml.rels`] = enc(rels(s.charts.map((_, k) => [`rId${k + 1}`, "chart", `../charts/chart${n + k + 1}.xml`])));
    s.charts.forEach(([t, v], k) => { files[`xl/charts/chart${n + k + 1}.xml`] = enc(chartXml(t, v)); });
    n += s.charts.length;
  });
  return zipSync(files, { mtime: new Date(2020, 0, 1) });
}

const six: Array<[string, number]> = [["A", 1], ["B", 2], ["C", 3], ["D", 4], ["E", 5], ["F", 6]];
describe("moved charts", () => {
  const data = [{ name: "d1", charts: six.slice(0, 2) }, { name: "d2", charts: six.slice(2, 4) }, { name: "d3", charts: six.slice(4) }];
  it("six charts moved to a new sheet read as one move", () => {
    const rows = mediaChanges(".xlsx", workbook(data), workbook([...data.map((d) => ({ name: d.name, charts: [] })), { name: "Charts", charts: six }]));
    assert.equal(rows.length, 6);
    // the note is the connector's now; the reader's rows still say one move each
    assert.ok(rows.every((r) => r.kind === "chart moved" && r.location.startsWith("Charts!")), JSON.stringify(rows));
  });
  it("one titled chart moved names its title and source", () => {
    const rows = mediaChanges(".xlsx", workbook([{ name: "d1", charts: [["A", 1]] }, { name: "x", charts: [] }]), workbook([{ name: "d1", charts: [] }, { name: "x", charts: [["A", 1]] }]));
    assert.deepEqual(rows.map((r) => [r.kind, r.title, r.from]), [["chart moved", "A", "d1"]]);
  });
  it("a chart whose data changed as it moved is removed and added, not moved", () => {
    const rows = mediaChanges(".xlsx", workbook([{ name: "d1", charts: [["A", 1]] }, { name: "x", charts: [] }]), workbook([{ name: "d1", charts: [] }, { name: "x", charts: [["A", 2]] }]));
    assert.ok(rows.every((r) => r.kind !== "chart moved"));
    assert.deepEqual(rows.map((r) => r.kind).sort(), ["chart added", "chart removed"]);
  });
  it("a sheet renamed with its charts is still silent", () => {
    assert.deepEqual(mediaChanges(".xlsx", workbook([{ name: "old", charts: [["A", 1]] }]), workbook([{ name: "new", charts: [["A", 1]] }])), []);
  });
});
