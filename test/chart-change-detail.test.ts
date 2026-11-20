// A changed chart part names every differing chart element in words, through the shared structural diff (shared/chart-diff.ts), in every
// Office format that embeds DrawingML charts. Guards against: a chart change outside the curated set (titles, type, series ranges) reading
// only "Chart changed", or vanishing from the list when nothing curated differs.
// Live case: a number format added to the value axis of three charts (`<c:numFmt formatCode="#,##0" sourceLinked="0"/>`).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { planExcel } from "../src/office/connector/excel/diff.ts";
import { chartChangeWords, mediaChanges, xlsxChartDetail } from "../src/office/connector/shared/package-media.ts";
import { diffDecks } from "../src/office/connector/pptx/diff.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { createFilesLayer } from "../src/office/connector/docx/layer.ts";

const FX = path.join(import.meta.dirname, "fixtures");
const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const NUMFMT = `<c:numFmt ${C} formatCode="#,##0" sourceLinked="0"/>`;

const repack = (bytes: Uint8Array, edit: (name: string, xml: string) => string): Uint8Array => {
  const files = unzipSync(bytes);
  for (const n of Object.keys(files)) if (/charts\/chart\d+\.xml$/.test(n)) files[n] = strToU8(edit(n, strFromU8(files[n]!)));
  return zipSync(files);
};

describe("the live case: value axis number format added on three charts", () => {
  const before = readFileSync(path.join(FX, "chart-three-before.xlsx"));
  const after = repack(before, (_n, x) => x.replace("<majorGridlines/>", `<majorGridlines/>${NUMFMT}`));
  it("each chart's change names the axis, the property and both formats", () => {
    const rows = planExcel(before, after).changes.filter((c) => c.kind === "chart").map((c) => c.text);
    assert.equal(rows.length, 3, JSON.stringify(rows));
    for (const t of rows) assert.match(t ?? "", /changed: value axis number format General → #,##0$/);
  });
  it("the media rows keep all three charts (never dropped for want of a curated difference)", () => {
    const rows = mediaChanges(".xlsx", before, after);
    assert.equal(rows.length, 3, JSON.stringify(rows));
    for (const r of rows) assert.equal(r.detail, "value axis number format General → #,##0");
  });
});

describe("synthetic chart edits are each named", () => {
  const base = strFromU8(unzipSync(readFileSync(path.join(FX, "excel-region", "chart-removed-before.xlsx")))["xl/charts/chart1.xml"]!);
  const detail = (edit: (x: string) => string): string | undefined => xlsxChartDetail(base, edit(base));
  it("axis minimum and maximum, set then changed", () => {
    const scaled = base.replace('<valAx><axId val="100"/><scaling><orientation val="minMax"/>', '<valAx><axId val="100"/><scaling><orientation val="minMax"/><max val="100"/><min val="0"/>');
    assert.equal(xlsxChartDetail(base, scaled), "value axis maximum auto → 100; value axis minimum auto → 0");
    assert.equal(xlsxChartDetail(scaled, scaled.replace('<min val="0"/>', '<min val="50"/>')), "value axis minimum 0 → 50");
  });
  it("series line colour, added then changed", () => {
    const red = (x: string): string => x.replace(`<spPr><a:ln ${A}><a:prstDash val="solid"/></a:ln></spPr><marker>`, `<spPr><a:ln ${A}><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="solid"/></a:ln></spPr><marker>`);
    assert.equal(detail(red), "series 1 line color none → #FF0000");
    assert.equal(xlsxChartDetail(red(base), red(base).replace('val="FF0000"', 'val="4472c4"')), "series 1 line color #FF0000 → #4472C4");
  });
  it("legend position", () => {
    assert.equal(detail((x) => x.replace('<legendPos val="r"/>', '<legendPos val="b"/>')), "legend position right → bottom");
  });
  it("a change only in cached values says nothing it draws changed, and gives no media row", () => {
    const cached = (v: string) => (x: string): string => x.replace("</f></numRef></val>", `</f><numCache><formatCode>General</formatCode><ptCount val="1"/><pt idx="0"><v>${v}</v></pt></numCache></numRef></val>`);
    const [was, now] = [cached("1")(base), cached("2")(base)];
    assert.deepEqual(chartChangeWords(was, now), { lines: [], noise: ["cached values"] });
    assert.equal(xlsxChartDetail(was, now), "nothing it draws changed (only its cached copy of the cell values differs)");
  });
  it("a renumbered unique id or axis id alone is no visible change", () => {
    const uid = (g: string) => (x: string): string => x.replace("<order val=\"0\"/>", `<order val="0"/><extLst><ext uri="{C3380CC4-5D6E-409C-BE32-E72D297353CC}" xmlns:c16="http://schemas.microsoft.com/office/drawing/2014/chart"><c16:uniqueId val="{${g}}"/></ext></extLst>`);
    assert.equal(xlsxChartDetail(uid("0001")(base), uid("0002")(base)), "nothing it draws changed (only internal ids were renumbered)");
    assert.equal(chartChangeWords(base, base.replace(/<(axId|crossAx) val="100"\/>/g, '<$1 val="7"/>')).lines.length, 0);
  });
  it("an element outside the word list still names its part and element", () => {
    assert.equal(detail((x) => x.replace("<majorGridlines/>", "<majorGridlines/><fancyTickStyle val=\"3\"/>")), "value axis fancy tick style none → 3");
  });
  it("a title change is worded as before, and only once", () => {
    assert.equal(detail((x) => x.replace("<a:t>Squares</a:t>", "<a:t>Cubes</a:t>")), 'title "Squares" → "Cubes"');
  });
  it("prefixes, attribute order and whitespace are no difference", () => {
    const respelled = base.replace(/<(\/?)(?=[a-zA-Z])(?!a:)/g, "<$1c:").replace(`<c:chartSpace xmlns="`, `<c:chartSpace xmlns:c="`).replace(/></g, ">\n  <");
    assert.equal(xlsxChartDetail(base, respelled), undefined);
  });
});

describe("pptx and docx charts use the same words", () => {
  it("pptx: a value axis number format change is a chart row, described", () => {
    const before = readFileSync(path.join(FX, "change-first-deck", "PD-before.pptx"));
    const after = repack(before, (n, x) => (n.endsWith("chart1.xml") ? x.replace('<c:numFmt formatCode="0&quot;%&quot;" sourceLinked="0"/>', '<c:numFmt formatCode="0.0&quot;%&quot;" sourceLinked="0"/>') : x));
    const rows = diffDecks(readDeck(before), readDeck(after)).filter((r) => r.kind === "chart changed");
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.match(createPptxLayer().describe(rows[0]!), /: chart value axis number format 0"%" → 0\.0"%"$/);
  });
  it("docx: an embedded chart's legend moved is a chart row, described", async () => {
    const chart = (pos: string): string => `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace ${C} ${A}><c:chart><c:plotArea><c:lineChart><c:ser><c:idx val="0"/><c:order val="0"/></c:ser></c:lineChart></c:plotArea><c:legend><c:legendPos val="${pos}"/></c:legend></c:chart></c:chartSpace>`;
    const doc = (pos: string): Uint8Array => {
      const files = unzipSync(readFileSync(path.join(FX, "word-conditional-format-fmt-after.docx")));
      files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]!).replace(/<w:body>/, `<w:body><w:p><w:r><w:drawing><c:chart ${C} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdChart9"/></w:drawing></w:r></w:p>`));
      files["word/_rels/document.xml.rels"] = strToU8(strFromU8(files["word/_rels/document.xml.rels"]!).replace("</Relationships>", '<Relationship Id="rIdChart9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/></Relationships>'));
      files["word/charts/chart1.xml"] = strToU8(chart(pos));
      return zipSync(files);
    };
    const dir = await mkdtemp(path.join(tmpdir(), "chart-detail-"));
    try {
      const [a, b] = [path.join(dir, "a.docx"), path.join(dir, "b.docx")];
      await writeFile(a, doc("r"));
      await writeFile(b, doc("t"));
      const layer = createFilesLayer();
      const rows = (await layer.diff(a, b)).filter((r) => r.kind === "chart changed");
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(layer.describe(rows[0]!), "chart changed: legend position right → top");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
