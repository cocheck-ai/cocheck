import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { numbersIn } from "../src/office/connector/pptx/diff.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { SKIPPED_RELATIONSHIPS, readDeckTraced, slideRelationshipTypes } from "../src/office/connector/pptx/reader.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import type { FormatLayer } from "../src/formats/layer.ts";
import { changedOutsideWording } from "../src/fingerprint.ts";

// ---- fixture decks -------------------------------------------------------------------------
// Minimal valid OOXML built with fflate. `variant` 1 is what a PowerPoint resave does to the same
// content: reversed part names, renumbered rIds, split runs with spell-check/dirty attributes, a new
// date-field cache, rewritten docProps timestamps and a different zip entry order.

type Shape = (v: number) => string;

interface SlideSpec {
  id: number;
  shapes: Shape[];
  notes?: string[];
  charts?: string[];
  /** Extra parts reached by relationship from the slide; the body names the id as `@@X:key@@`. */
  extras?: Extra[];
}

/**
 * A relationship from a slide (or the presentation, for `Deck.presExtras`). With `part` and `xml` it
 * owns a part; with `to` it points at an existing part or, when `external`, at a URL.
 */
interface Extra {
  key: string;
  relType: string;
  part?: (v: number) => string;
  xml?: (v: number) => string;
  to?: (v: number) => string;
  external?: boolean;
}

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const para = (t: string, v: number): string => {
  if (v === 0 || t.length < 2) return `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(t)}</a:t></a:r></a:p>`;
  const mid = Math.floor(t.length / 2);
  return (
    `<a:p><a:r><a:rPr lang="en-US" dirty="0" err="1"/><a:t>${esc(t.slice(0, mid))}</a:t></a:r>` +
    `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(t.slice(mid))}</a:t></a:r><a:endParaRPr lang="en-US" dirty="0"/></a:p>`
  );
};

const sp =
  (id: number, name: string, paras: string[]): Shape =>
  (v) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras.map((t) => para(t, v)).join("")}</p:txBody></p:sp>`;

const dateField =
  (id: number): Shape =>
  (v) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Date Placeholder ${id}"/><p:cNvSpPr/><p:nvPr><p:ph type="dt"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p>` +
    `<a:fld id="{B1}" type="datetime1"><a:rPr lang="en-US"/><a:t>${v === 0 ? "9/30/2026" : "10/1/2026"}</a:t></a:fld>` +
    `<a:fld id="{B2}" type="slidenum"><a:rPr lang="en-US"/><a:t>${v === 0 ? "1" : "7"}</a:t></a:fld></a:p></p:txBody></p:sp>`;

const table =
  (id: number, name: string, rows: string[][]): Shape =>
  (v) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid/>` +
    rows.map((r) => `<a:tr h="370840">${r.map((c) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(c, v)}</a:txBody><a:tcPr/></a:tc>`).join("")}</a:tr>`).join("") +
    `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

const chartFrame =
  (id: number, name: string, n: number): Shape =>
  () =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="@@CHART${n}@@"/></a:graphicData></a:graphic></p:graphicFrame>`;

const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const A14 = "http://schemas.microsoft.com/office/drawing/2010/main";
const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const CX = "http://schemas.microsoft.com/office/drawing/2014/chartex";

/** A text shape whose paragraph is an a14:m equation (what PowerPoint writes), run split on a resave. */
const equation =
  (id: number, name: string, eq: string): Shape =>
  (v) => {
    const half = Math.ceil(eq.length / 2);
    const runs = v === 0 ? `<m:r><m:t>${eq}</m:t></m:r>` : `<m:r><m:rPr><m:sty m:val="p"/></m:rPr><a:rPr lang="en-US" dirty="0"/><m:t>${eq.slice(0, half)}</m:t></m:r><m:r><a:rPr lang="en-US"/><m:t>${eq.slice(half)}</m:t></m:r>`;
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p>` +
      `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:a14="${A14}" Requires="a14"><a14:m><m:oMathPara xmlns:m="${MATH}"><m:oMath>${runs}</m:oMath></m:oMathPara></a14:m></mc:Choice>` +
      `<mc:Fallback><a:r><a:t>${eq}</a:t></a:r></mc:Fallback></mc:AlternateContent></a:p></p:txBody></p:sp>`
    );
  };

const picture =
  (id: number, name: string, descr: string): Shape =>
  (v) =>
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}" descr="${descr}"${v === 0 ? "" : ' title=""'}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;

/** A text shape whose one run is a hyperlink; a resave splits the run, and PowerPoint repeats the link on each half. */
const linkedText =
  (id: number, name: string, text: string, key: string, tip: string, trigger = "hlinkClick"): Shape =>
  (v) => {
    const link = `<a:${trigger} r:id="@@X:${key}@@"${tip ? ` tooltip="${tip}"` : ""}/>`;
    const mid = Math.floor(text.length / 2);
    const runs =
      v === 0
        ? `<a:r><a:rPr lang="en-US">${link}</a:rPr><a:t>${text}</a:t></a:r>`
        : `<a:r><a:rPr lang="en-US" dirty="0" err="1">${link}</a:rPr><a:t>${text.slice(0, mid)}</a:t></a:r><a:r><a:rPr lang="en-US" dirty="0">${link}</a:rPr><a:t>${text.slice(mid)}</a:t></a:r>`;
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${runs}</a:p></p:txBody></p:sp>`;
  };

/** A picture whose shape-level link (`hlinkClick` unless told otherwise, on the `cNvPr`) goes to `key`'s relationship. */
const pictureLink =
  (id: number, name: string, key: string, action = "", trigger = "hlinkClick", tip = ""): Shape =>
  () =>
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"><a:${trigger} r:id="@@X:${key}@@"${action ? ` action="${action}"` : ""}${tip ? ` tooltip="${tip}"` : ""}/></p:cNvPr><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;

const smartArtFrame =
  (id: number, name: string): Shape =>
  () =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="@@X:dgm@@" r:lo="@@X:dgm@@" r:qs="@@X:dgm@@" r:cs="@@X:dgm@@"/></a:graphicData></a:graphic></p:graphicFrame>`;

const DSP = "http://schemas.microsoft.com/office/drawing/2008/diagram";

/** SmartArt: the data part, and the pre-rendered drawing part its `dataModelExt` points at. */
const smartArtParts = (steps: string[], drawn: string): Extra[] => [
  {
    key: "dgm",
    relType: `${REL}/diagramData`,
    part: (v) => `ppt/diagrams/data${v === 0 ? 1 : 7}.xml`,
    xml: (v) =>
      `<?xml version="1.0"?><dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:dsp="${DSP}"><dgm:ptLst>` +
      steps.map((t, i) => `<dgm:pt modelId="{${v === 0 ? "AAAA" : "BBBB"}-${i}}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" dirty="${v}"/><a:t>${t}</a:t></a:r></a:p></dgm:t></dgm:pt>`).join("") +
      `</dgm:ptLst><dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt relId="@@X:dgmdraw@@" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst></dgm:dataModel>`,
  },
  {
    key: "dgmdraw",
    relType: "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
    part: (v) => `ppt/diagrams/drawing${v === 0 ? 1 : 7}.xml`,
    xml: (v) =>
      `<?xml version="1.0"?><dsp:drawing xmlns:dsp="${DSP}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:spTree><dsp:sp modelId="{${v === 0 ? "CCCC" : "DDDD"}}"><dsp:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" dirty="${v}"/><a:t>${drawn}</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>`,
  },
];

const chartExFrame =
  (id: number, name: string): Shape =>
  () =>
    `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:cx1="${CX}" Requires="cx1"><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>` +
    `<a:graphic><a:graphicData uri="${CX}"><cx:chart xmlns:cx="${CX}" r:id="@@X:cex@@"/></a:graphicData></a:graphic></p:graphicFrame></mc:Choice>` +
    `<mc:Fallback><p:sp><p:nvSpPr><p:cNvPr id="${id + 100}" name="Fallback ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp></mc:Fallback></mc:AlternateContent>`;

const chartExPart = (title: string, vals: number[]): Extra => ({
  key: "cex",
  relType: "http://schemas.microsoft.com/office/2014/relationships/chartEx",
  part: (v: number) => `ppt/charts/chartEx${v === 0 ? 1 : 4}.xml`,
  xml: (v: number) =>
    `<?xml version="1.0"?><cx:chartSpace xmlns:cx="${CX}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><cx:chartData><cx:data id="${v}">` +
    `<cx:strDim type="cat"><cx:f>Sheet1!$A$2:$A$3</cx:f><cx:lvl ptCount="${vals.length}"><cx:pt idx="0">Leads</cx:pt><cx:pt idx="1">Deals</cx:pt></cx:lvl></cx:strDim>` +
    `<cx:numDim type="val"><cx:f>Sheet1!$B$2:$B$3</cx:f><cx:lvl ptCount="${vals.length}" formatCode="${v === 0 ? "General" : "0.0"}">${vals.map((x, i) => `<cx:pt idx="${i}">${x}</cx:pt>`).join("")}</cx:lvl></cx:numDim>` +
    `</cx:data></cx:chartData><cx:chart><cx:title><cx:tx><cx:txData><cx:v>${title}</cx:v></cx:txData></cx:tx></cx:title></cx:chart></cx:chartSpace>`,
});

const group =
  (id: number, name: string, kids: Shape[]): Shape =>
  (v) =>
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${kids.map((k) => k(v)).join("")}</p:grpSp>`;

interface ChartSpec {
  title?: string;
  axisTitle?: string;
  /** Replaces the whole part: for unreadable-chart cases. */
  raw?: string;
  /** Write the title as a cell reference with a cached string, not rich text. */
  titleRef?: boolean;
  /** Value-axis title, a cell reference with a cached string. */
  valTitle?: string;
  /** Legend with one entry; `legendDelete` hides it. */
  legend?: boolean;
  legendDelete?: boolean;
  /** Trendline name on the first series. */
  trend?: string;
  /** Text of a drawing part the chart reaches by `userShapes`. */
  usr?: string;
  /** "Value From Cells" label cache for the first series, by point. */
  rng?: string[];
  /** Series data; `labels` are custom data labels by point index. */
  series: { name: string; cats: string[]; vals: (number | string)[]; labels?: Record<number, string> }[];
}

function chartXml(c: ChartSpec, v: number): string {
  if (c.raw !== undefined) return c.raw;
  const pts = (xs: (string | number)[]) => xs.map((x, i) => `<c:pt idx="${i}"><c:v>${x}</c:v></c:pt>`).join("");
  const sers = c.series
    .map(
      (s, i) =>
        `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${s.name}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
        (s.labels
          ? `<c:dLbls>${Object.entries(s.labels)
              .map(([i, t]) => `<c:dLbl><c:idx val="${i}"/><c:tx><c:rich><a:bodyPr/><a:p>${v === 0 ? `<a:r><a:t>${t}</a:t></a:r>` : `<a:r><a:rPr dirty="0"/><a:t>${t}</a:t></a:r>`}</a:p></c:rich></c:tx><c:showVal val="1"/></c:dLbl>`)
              .join("")}<c:showVal val="0"/></c:dLbls>`
          : "") +
        (i === 0 && c.trend !== undefined ? `<c:trendline><c:name>${c.trend}</c:name><c:trendlineType val="linear"/></c:trendline>` : "") +
        `<c:cat><c:strRef><c:f>Sheet1!$A$2</c:f><c:strCache><c:ptCount val="${s.cats.length}"/>${pts(s.cats)}</c:strCache></c:strRef></c:cat>` +
        `<c:val><c:numRef><c:f>Sheet1!$B$2</c:f><c:numCache><c:formatCode>${v === 0 ? "General" : "0.0"}</c:formatCode><c:ptCount val="${s.vals.length}"/>${pts(s.vals)}</c:numCache></c:numRef></c:val>` +
        (i === 0 && c.rng
          ? `<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"><c15:datalabelsRange><c15:f>Sheet1!$C$2:$C$3</c15:f><c15:dlblRangeCache><c:ptCount val="${c.rng.length}"/>${pts(c.rng)}</c15:dlblRangeCache></c15:datalabelsRange></c:ext></c:extLst>`
          : "") +
        `</c:ser>`,
    )
    .join("");
  const strTitle = (t: string) => `<c:title><c:tx><c:strRef><c:f>Sheet1!$A$9</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${t}</c:v></c:pt></c:strCache></c:strRef></c:tx></c:title>`;
  const title = c.title && c.titleRef ? strTitle(c.title) : c.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${c.title}</a:t></a:r></a:p></c:rich></c:tx></c:title>` : "";
  return (
    `<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">` +
    `<c:chart>${title}<c:plotArea><c:barChart>${sers}</c:barChart><c:catAx><c:title><c:tx><c:rich><a:p><a:r><a:t>${c.axisTitle ?? "Axis title"}</a:t></a:r></a:p></c:rich></c:tx></c:title></c:catAx>${c.valTitle !== undefined ? `<c:valAx>${strTitle(c.valTitle)}</c:valAx>` : ""}</c:plotArea>${c.legend ? `<c:legend><c:legendPos val="r"/><c:legendEntry><c:idx val="0"/><c:delete val="${c.legendDelete ? 1 : 0}"/></c:legendEntry></c:legend>` : ""}</c:chart>${c.usr !== undefined ? `<c:userShapes r:id="rId1"/>` : ""}</c:chartSpace>`
  );
}

const notesXml = (paras: string[], v: number): string =>
  `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras.map((t) => para(t, v)).join("")}</p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:fld id="{C1}" type="slidenum"><a:t>${v === 0 ? "1" : "9"}</a:t></a:fld></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld></p:notes>`;

interface Deck {
  /** In presentation order (the sldIdLst). */
  slides: SlideSpec[];
  charts?: Record<string, ChartSpec>;
  /** Relationships from presentation.xml (comment authors). */
  presExtras?: Extra[];
}

function build(deck: Deck, v = 0): Uint8Array {
  const n = deck.slides.length;
  const files: Record<string, Uint8Array> = {};
  const add = (name: string, xml: string) => {
    files[name] = strToU8(xml);
  };
  // v1 numbers slide parts in reverse and shifts every relationship id
  const partNo = (i: number) => (v === 0 ? i + 1 : n - i + 10);
  const rid = (i: number) => (v === 0 ? `rId${i + 1}` : `rId${i + 40}`);
  let chartNo = v === 0 ? 1 : 20;
  add("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  add("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  add("docProps/core.xml", `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dcterms="y"><dcterms:modified>${v === 0 ? "2026-09-30T10:00:00Z" : "2026-10-01T08:30:00Z"}</dcterms:modified></cp:coreProperties>`);
  add("docProps/app.xml", `<?xml version="1.0"?><Properties><TotalTime>${v === 0 ? 3 : 41}</TotalTime><Words>${v === 0 ? 10 : 12}</Words></Properties>`);
  for (const x of deck.presExtras ?? []) add(x.part!(v), x.xml!(v));
  const sldIds = deck.slides.map((s, i) => `<p:sldId id="${s.id}" r:id="${rid(i)}"/>`).join("");
  add("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation ${NS}><p:sldMasterIdLst/><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`);
  add(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${deck.slides
      .map((_, i) => `<Relationship Id="${rid(i)}" Type="${REL}/slide" Target="slides/slide${partNo(i)}.xml"/>`)
      .join("")}${(deck.presExtras ?? []).map((x, k) => `<Relationship Id="rId${v === 0 ? 60 + k : 80 + k}" Type="${x.relType}" Target="${x.part!(v).replace(/^ppt\//, "")}"/>`).join("")}</Relationships>`,
  );
  deck.slides.forEach((s, i) => {
    const rels: string[] = [];
    let body = s.shapes.map((sh) => sh(v)).join("");
    (s.charts ?? []).forEach((key, k) => {
      const cn = chartNo++;
      const spec = deck.charts![key]!;
      add(`ppt/charts/chart${cn}.xml`, chartXml(spec, v));
      if (spec.usr !== undefined) {
        add(`ppt/charts/_rels/chart${cn}.xml.rels`, `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/chartUserShapes" Target="../drawings/drawing${cn}.xml"/></Relationships>`);
        add(`ppt/drawings/drawing${cn}.xml`, `<?xml version="1.0"?><c:userShapes xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:cdr="http://schemas.openxmlformats.org/drawingml/2006/chartDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><cdr:relSizeAnchor><cdr:sp modelId="{${v}}"><cdr:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" dirty="${v}"/><a:t>${spec.usr}</a:t></a:r></a:p></cdr:txBody></cdr:sp></cdr:relSizeAnchor></c:userShapes>`);
      }
      rels.push(`<Relationship Id="rId${v === 0 ? 10 + k : 70 + k}" Type="${REL}/chart" Target="../charts/chart${cn}.xml"/>`);
      body = body.replace(`@@CHART${k}@@`, `rId${v === 0 ? 10 + k : 70 + k}`);
    });
    const ids = new Map((s.extras ?? []).map((x, k) => [x.key, `rId${v === 0 ? 30 + k : 95 + k}`]));
    const fill = (xml: string) => xml.replace(/@@X:(\w+)@@/g, (_, key: string) => ids.get(key) ?? "");
    (s.extras ?? []).forEach((x) => {
      const id = ids.get(x.key)!;
      const target = x.to ? x.to(v) : `../${x.part!(v).replace(/^ppt\//, "")}`;
      if (x.part) add(x.part(v), fill(x.xml!(v)));
      rels.push(`<Relationship Id="${id}" Type="${x.relType}" Target="${target}"${x.external ? ' TargetMode="External"' : ""}/>`);
      body = body.replaceAll(`@@X:${x.key}@@`, id);
    });
    if (s.notes) {
      add(`ppt/notesSlides/notesSlide${partNo(i)}.xml`, notesXml(s.notes, v));
      rels.push(`<Relationship Id="rId${v === 0 ? 2 : 3}" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${partNo(i)}.xml"/>`);
    }
    add(`ppt/slides/slide${partNo(i)}.xml`, `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`);
    add(`ppt/slides/_rels/slide${partNo(i)}.xml.rels`, `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  });
  const names = Object.keys(files);
  const ordered = Object.fromEntries((v === 0 ? names : names.reverse()).map((k) => [k, files[k]!]));
  return zipSync(ordered, { mtime: v === 0 ? new Date(2020, 0, 1) : new Date(2026, 9, 1) });
}

const P188 = "http://schemas.microsoft.com/office/powerpoint/2018/8/main";

/** Legacy comment (`p:cmLst`) and its authors part; a resave renumbers the author and rewrites the timestamp. */
const legacyComment = (text: string): { slide: Extra; pres: Extra } => ({
  slide: {
    key: "cmt",
    relType: `${REL}/comments`,
    part: (v) => `ppt/comments/comment${v === 0 ? 1 : 5}.xml`,
    xml: (v) =>
      `<?xml version="1.0"?><p:cmLst ${NS}><p:cm authorId="${v === 0 ? 0 : 3}" dt="${v === 0 ? "2026-09-01T10:00:00.000" : "2026-09-30T08:00:00.000"}" idx="1"><p:pos x="10" y="10"/><p:text>${text}</p:text></p:cm></p:cmLst>`,
  },
  pres: {
    key: "cau",
    relType: `${REL}/commentAuthors`,
    part: (v) => `ppt/commentAuthors${v === 0 ? "" : "2"}.xml`,
    xml: (v) => `<?xml version="1.0"?><p:cmAuthorLst ${NS}><p:cmAuthor id="${v === 0 ? 0 : 3}" name="Ana Lopez" initials="AL" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`,
  },
});

/** Modern comment (`p188:cmLst`) with one reply, and its authors part. */
const modernComment = (text: string, reply: string): { slide: Extra; pres: Extra } => ({
  slide: {
    key: "mcm",
    relType: "http://schemas.microsoft.com/office/2018/10/relationships/comments",
    part: (v) => `ppt/comments/modernComment_100_${v === 0 ? "A1" : "B7"}.xml`,
    xml: (v) =>
      `<?xml version="1.0"?><p188:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p188="${P188}"><p188:cm id="{C0FFEE00-0000-0000-0000-000000000001}" authorId="{A1A1A1A1-0000-0000-0000-000000000001}" created="${v === 0 ? "2026-09-01T10:00:00.000" : "2026-09-30T09:00:00.000"}">` +
      `<ac:deMkLst xmlns:ac="http://schemas.microsoft.com/office/drawing/2013/main/command"><pc:docMk xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"/></ac:deMkLst>` +
      `<p188:replyLst><p188:reply id="{D0D0D0D0-0000-0000-0000-000000000002}" authorId="{A1A1A1A1-0000-0000-0000-000000000001}" created="2026-09-02T10:00:00.000"><p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="${v}"/><a:t>${reply}</a:t></a:r></a:p></p188:txBody></p188:reply></p188:replyLst>` +
      `<p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="${v}"/><a:t>${text}</a:t></a:r></a:p></p188:txBody></p188:cm></p188:cmLst>`,
  },
  pres: {
    key: "mau",
    relType: "http://schemas.microsoft.com/office/2018/10/relationships/authors",
    part: (v) => `ppt/authors${v === 0 ? "" : "2"}.xml`,
    xml: () => `<?xml version="1.0"?><p188:authorLst xmlns:p188="${P188}"><p188:author id="{A1A1A1A1-0000-0000-0000-000000000001}" name="Ben Ruiz" initials="BR" userId="S::ben" providerId="AD"/></p188:authorLst>`,
  },
});

/** A deck exercising every modelled part: text, table, group (nested), chart, notes, fields, links, comments. */
function richDeck(
  over: {
    title?: string; cell?: string; inner?: string; nested?: string; q2?: number; note?: string; axis?: string; label?: string; eq?: string; alt?: string; step?: string; cex?: number; broken?: string;
    link?: string; tip?: string; picLink?: string; jump?: string; comment?: string; modern?: string; reply?: string;
    ctitle?: string; vaxis?: string; rng?: string; legendDelete?: boolean; trend?: string; usr?: string; draw?: string;
    /** Hover and mouse-over links: `<run|shape>Hover` / `<run|shape>Over` are targets, `...Tip` tooltips. */
    runHover?: string; runHoverTip?: string; runOver?: string; runOverTip?: string;
    shapeHover?: string; shapeHoverTip?: string; shapeOver?: string; shapeOverTip?: string;
  } = {},
): Deck {
  const legacy = legacyComment(over.comment ?? "Check the margin");
  const modern = modernComment(over.modern ?? "Is this current?", over.reply ?? "Yes, as of Q3");
  return {
    charts: {
      rev: { title: "Revenue", axisTitle: over.axis ?? "Revenue USD", series: [{ name: "Revenue", cats: ["Q1", "Q2", "Q3"], vals: [10, over.q2 ?? 20, 30], labels: { 1: over.label ?? "up 5%" } }] },
      broken: { series: [], raw: over.broken ?? "<<< not a chart" },
      ref: {
        title: over.ctitle ?? "Cost by quarter",
        titleRef: true,
        valTitle: over.vaxis ?? "Cost USD",
        legend: true,
        legendDelete: over.legendDelete ?? false,
        trend: over.trend ?? "Linear fit",
        usr: over.usr ?? "Source: finance",
        rng: ["alpha", over.rng ?? "beta"],
        series: [{ name: "Cost", cats: ["Q1", "Q2"], vals: [4, 6] }],
      },
    },
    presExtras: [legacy.pres, modern.pres],
    slides: [
      {
        id: 256,
        shapes: [
          sp(2, "Title 1", [over.title ?? "Quarterly review"]),
          dateField(3),
          table(4, "Sales Table", [["Region", "Owner"], ["North", over.cell ?? "Alpha"], ["South", "Beta"]]),
          group(5, "Group 5", [sp(6, "Label 6", [over.inner ?? "Inside the group"]), group(7, "Group 7", [sp(8, "Deep 8", [over.nested ?? "Nested deep"])])]),
          chartFrame(9, "Chart 9", 0),
          equation(10, "Equation 10", over.eq ?? "x=1"),
          picture(11, "Picture 11", over.alt ?? "Logo on a blue field"),
          smartArtFrame(12, "Diagram 12"),
          chartExFrame(13, "Funnel 13"),
          chartFrame(14, "Broken chart 14", 1),
          linkedText(15, "Docs link 15", "Read the docs", "lnk", over.tip ?? "Open the docs"),
          pictureLink(16, "Logo link 16", "plnk"),
          pictureLink(17, "Next button 17", "jmp", "ppaction://hlinksldjump"),
          chartFrame(18, "Cost chart 18", 2),
          linkedText(19, "Hover text 19", "Hover for details", "rhv", over.runHoverTip ?? "Hover tip", "hlinkHover"),
          linkedText(20, "Over text 20", "Mouse over me", "rmo", over.runOverTip ?? "Over tip", "hlinkMouseOver"),
          pictureLink(21, "Hover logo 21", "shv", "", "hlinkHover", over.shapeHoverTip ?? "Shape hover tip"),
          pictureLink(22, "Over logo 22", "smo", "", "hlinkMouseOver", over.shapeOverTip ?? "Shape over tip"),
        ],
        charts: ["rev", "broken", "ref"],
        extras: [
          ...smartArtParts(["Plan", over.step ?? "Build"], over.draw ?? "Plan then build"),
          chartExPart("Funnel", [100, over.cex ?? 40]),
          { key: "lnk", relType: `${REL}/hyperlink`, to: () => over.link ?? "https://example.com/docs", external: true },
          { key: "plnk", relType: `${REL}/hyperlink`, to: () => over.picLink ?? "https://example.com/logo", external: true },
          { key: "rhv", relType: `${REL}/hyperlink`, to: () => over.runHover ?? "https://example.com/run-hover", external: true },
          { key: "rmo", relType: `${REL}/hyperlink`, to: () => over.runOver ?? "https://example.com/run-over", external: true },
          { key: "shv", relType: `${REL}/hyperlink`, to: () => over.shapeHover ?? "https://example.com/shape-hover", external: true },
          { key: "smo", relType: `${REL}/hyperlink`, to: () => over.shapeOver ?? "https://example.com/shape-over", external: true },
          { key: "jmp", relType: `${REL}/slide`, to: (v) => `slide${v === 0 ? 2 : 11}.xml` },
          legacy.slide,
          modern.slide,
        ],
        notes: [over.note ?? "Say hello"],
      },
      { id: 257, shapes: [sp(2, "Title 1", ["Second slide"]), sp(3, "Body 3", ["Nothing here"])] },
    ],
  };
}

// ---- harness -------------------------------------------------------------------------------

const layer = createPptxLayer();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cocheck-pptx-layer-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

let seq = 0;
async function put(bytes: Uint8Array): Promise<string> {
  const p = path.join(dir, `deck-${seq++}.pptx`);
  await writeFile(p, bytes);
  return p;
}

async function diffOf(a: Uint8Array, b: Uint8Array) {
  return layer.diff(await put(a), await put(b));
}

const brief = (rows: Awaited<ReturnType<typeof diffOf>>) => rows.map((r) => [r.location, r.kind, r.before, r.after]);

describe("pptx layer: what it reads", () => {
  it("accepts decks, not lock files or other formats", () => {
    assert.equal(layer.accepts("/x/deck.pptx"), true);
    assert.equal(layer.accepts("/x/DECK.PPTM"), true);
    assert.equal(layer.accepts("/x/~$deck.pptx"), false);
    assert.equal(layer.accepts("/x/notes.docx"), false);
    assert.equal(layer.accepts("/x/book.xlsx"), false);
    assert.equal(createFilesLayer().accepts("/x/deck.pptx"), false);
  });

  it("an identical deck, rebuilt, gives no rows", async () => {
    assert.deepEqual(await diffOf(build(richDeck()), build(richDeck())), []);
  });

  it("an edited text shape is one row addressed Slide N / shape name, runs joined", async () => {
    const rows = await diffOf(build(richDeck()), build(richDeck({ title: "Annual review" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Title 1", "text changed", "Quarterly review", "Annual review"]]);
    assert.equal(layer.describe(rows[0]!), "Slide 1 / Title 1: 'Quarterly review' -> 'Annual review'");
  });

  it("slide numbers come from sldIdLst, not part names", async () => {
    // v1 names the first slide in the list slide12.xml and the second slide11.xml
    const a = richDeck();
    const b = richDeck();
    b.slides[0]!.shapes[0] = sp(2, "Title 1", ["Changed first"]);
    const rows = await diffOf(build(a, 1), build(b, 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Title 1", "text changed", "Quarterly review", "Changed first"]]);
  });

  it("numbers in text are their own rows: a pure number edit is one number row, no prose row", async () => {
    const base = (t: string): Deck => ({ slides: [{ id: 256, shapes: [sp(2, "Body 2", [t])] }] });
    const a = build(base("Revenue grew from 100 to 120 in Q3"));
    const rows = await diffOf(a, build(base("Revenue grew from 100 to 125 in Q3")));
    assert.deepEqual(brief(rows), [["Slide 1 / Body 2 / number 2", "number changed", "120", "125"]]);

    const both = await diffOf(a, build(base("Sales grew from 100 to 125 in Q3")));
    assert.deepEqual(both.map((r) => r.kind).sort(), ["number changed", "text changed"]);

    const added = await diffOf(a, build(base("Revenue grew from 100 to 120 in Q3 (+20%)")));
    // the new number also adds "(#)" to the prose, so wording and number are both reported
    assert.deepEqual(added.map((r) => [r.location, r.kind]), [["Slide 1 / Body 2", "text changed"], ["Slide 1 / Body 2 / number 3", "number added"]]);
    assert.equal(added[1]!.after, "+20%");

    // "Q3" -> "Q4" is wording, not a number
    const word = await diffOf(a, build(base("Revenue grew from 100 to 120 in Q4")));
    assert.deepEqual(word.map((r) => r.kind), ["text changed"]);
  });

  it("a table cell edit is a row addressed to the cell; numeric cells give number rows", async () => {
    const rows = await diffOf(build(richDeck()), build(richDeck({ cell: "Gamma" })));
    assert.deepEqual(brief(rows), [["Slide 1 / Sales Table / R2C2", "text changed", "Alpha", "Gamma"]]);

    const num = (c: string): Deck => ({ slides: [{ id: 256, shapes: [table(4, "T", [["a", "b"], ["x", c]])] }] });
    const n = await diffOf(build(num("100")), build(num("105")));
    assert.deepEqual(brief(n), [["Slide 1 / T / R2C2 / number 1", "number changed", "100", "105"]]);
  });

  it("table rows added or removed are rows, and don't re-report the rows below as edited", async () => {
    const t = (rows: string[][]): Deck => ({ slides: [{ id: 256, shapes: [table(4, "T", rows)] }] });
    const rows = await diffOf(build(t([["h"], ["a"], ["b"]])), build(t([["h"], ["new"], ["a"], ["b"]])));
    assert.deepEqual(brief(rows), [["Slide 1 / T / R2", "table row added", null, "new"]]);
  });

  it("a change inside a group, or a group inside a group, is never missed", async () => {
    const inner = await diffOf(build(richDeck()), build(richDeck({ inner: "Changed inside" })));
    assert.deepEqual(brief(inner), [["Slide 1 / Group 5 / Label 6", "text changed", "Inside the group", "Changed inside"]]);
    const deep = await diffOf(build(richDeck()), build(richDeck({ nested: "Nested changed" })));
    assert.deepEqual(brief(deep), [["Slide 1 / Group 5 / Group 7 / Deep 8", "text changed", "Nested deep", "Nested changed"]]);
  });

  it("a shape removed from or added to a group is a row; the group itself is not double-counted", async () => {
    const a = richDeck();
    const b = richDeck();
    b.slides[0]!.shapes[3] = group(5, "Group 5", [sp(6, "Label 6", ["Inside the group"]), group(7, "Group 7", [])]);
    const removed = await diffOf(build(a), build(b));
    assert.deepEqual(brief(removed), [["Slide 1 / Group 5 / Group 7 / Deep 8", "shape removed", "Nested deep", null]]);
    const added = await diffOf(build(b), build(a));
    assert.deepEqual(brief(added), [["Slide 1 / Group 5 / Group 7 / Deep 8", "shape added", null, "Nested deep"]]);
  });

  it("chart cached values: one row per changed point, addressed series and category", async () => {
    const rows = await diffOf(build(richDeck()), build(richDeck({ q2: 25 })));
    assert.deepEqual(brief(rows), [["Slide 1 / Chart 9 / Revenue, Q2", "chart value", 20, 25]]);

    const d = richDeck();
    d.charts!.rev!.title = "Revenue 2026";
    d.charts!.rev!.series.push({ name: "Cost", cats: ["Q1"], vals: [5] });
    const more = await diffOf(build(richDeck()), build(d));
    // the chart title is read from the chart, not the axis title
    assert.deepEqual(more.map((r) => r.kind).sort(), ["chart series added", "chart title changed"]);
  });

  it("speaker notes are diffed; the notes slide number is not content", async () => {
    const rows = await diffOf(build(richDeck()), build(richDeck({ note: "Say goodbye" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Notes", "text changed", "Say hello", "Say goodbye"]]);
  });

  it("slides added, removed and moved are rows; a delete does not read as every later slide moving", async () => {
    const three = (order: number[]): Deck => ({
      slides: order.map((id) => ({ id, shapes: [sp(2, "Title 1", [`Slide ${id}`])] })),
    });
    const removed = await diffOf(build(three([256, 257, 258])), build(three([257, 258])));
    assert.deepEqual(brief(removed), [["Slide 1", "slide removed", "Slide 256", null]]);
    const added = await diffOf(build(three([256, 257])), build(three([256, 257, 258])));
    assert.deepEqual(brief(added), [["Slide 3", "slide added", null, "Slide 258"]]);
    const moved = await diffOf(build(three([256, 257, 258])), build(three([257, 258, 256])));
    assert.deepEqual(brief(moved), [["Slide 3", "slide moved", 1, 3]]);
  });

  it("an edit on a slide after a deleted slide is addressed by its new number", async () => {
    const mk = (title: string, skipFirst: boolean): Deck => ({
      slides: [{ id: 256, shapes: [sp(2, "Title 1", ["one"])] }, { id: 257, shapes: [sp(2, "Title 1", [title])] }].slice(skipFirst ? 1 : 0),
    });
    const rows = await diffOf(build(mk("two", false)), build(mk("TWO", true)));
    assert.deepEqual(brief(rows), [["Slide 1", "slide removed", "one", null], ["Slide 1 / Title 1", "text changed", "two", "TWO"]]);
  });

  it("shapes sharing a name stay distinct", async () => {
    const mk = (b: string): Deck => ({ slides: [{ id: 256, shapes: [sp(2, "TextBox", ["a"]), sp(3, "TextBox", [b])] }] });
    const rows = await diffOf(build(mk("b")), build(mk("B")));
    assert.deepEqual(brief(rows), [["Slide 1 / TextBox (2)", "text changed", "b", "B"]]);
  });

  it("a shape renamed in place is a rename row, and its text edit is still its own row", async () => {
    const mk = (name: string, t: string): Deck => ({ slides: [{ id: 256, shapes: [sp(2, name, [t])] }] });
    const rows = await diffOf(build(mk("Old", "x")), build(mk("New", "y")));
    assert.deepEqual(rows.map((r) => r.kind).sort(), ["shape renamed", "text changed"]);
  });
});

describe("pptx layer: numbers keep their attached unit", () => {
  const cases: Array<[string, string[]]> = [
    ["$4.2M", ["$4.2M"]],
    ["2.5x", ["2.5x"]],
    ["3x", ["3x"]],
    ["3X", ["3X"]],
    ["$1.2bn", ["$1.2bn"]],
    ["$3B", ["$3B"]],
    ["120k and 5K", ["120k", "5K"]],
    ["12mm", ["12mm"]],
    ["12.5%", ["12.5%"]],
    ["grew 12% to $4.2M.", ["12%", "$4.2M"]],
    ["1,000 units", ["1,000"]],
    ["Q3 FY2025 3D H1 v2 3rd", []],
    ["4.2Mx 5kg 10x10", []],
  ];
  for (const [text, want] of cases) {
    it(`numbersIn(${JSON.stringify(text)})`, () => assert.deepEqual(numbersIn(text), want));
  }

  const one = (t: string): Deck => ({ slides: [{ id: 256, shapes: [sp(2, "Body 2", [t])] }] });
  it("$4.2M -> $4.7M is one number row and no text row; 2.5x -> 3.0x is one number row", async () => {
    assert.deepEqual(brief(await diffOf(build(one("Revenue $4.2M")), build(one("Revenue $4.7M")))), [
      ["Slide 1 / Body 2 / number 1", "number changed", "$4.2M", "$4.7M"],
    ]);
    assert.deepEqual(brief(await diffOf(build(one("MOIC 2.5x")), build(one("MOIC 3.0x")))), [
      ["Slide 1 / Body 2 / number 1", "number changed", "2.5x", "3.0x"],
    ]);
  });
});

describe("pptx layer: a PowerPoint resave with no content change", () => {
  it("produces zero rows, though every byte of the container differs", async () => {
    const a = build(richDeck(), 0);
    const b = build(richDeck(), 1);
    assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
    // control: the same resave with one real edit is not silent
    const edited = await diffOf(a, build(richDeck({ cell: "Gamma" }), 1));
    assert.equal(edited.length, 1);
    assert.deepEqual(await diffOf(a, b), []);
    assert.deepEqual(await diffOf(b, a), []);
  });

  it("zero rows even when the resave renumbers every slide id (matched by content)", async () => {
    const renumbered = richDeck();
    renumbered.slides[0]!.id = 300;
    renumbered.slides[1]!.id = 301;
    const edited = richDeck({ inner: "Changed inside" });
    edited.slides[0]!.id = 300;
    edited.slides[1]!.id = 301;
    // an edit on top of a renumber is not silent: the slide whose content changed is a removed + added pair
    assert.deepEqual((await diffOf(build(richDeck()), build(edited, 1))).map((r) => r.kind), ["slide removed", "slide added"]);
    assert.deepEqual(await diffOf(build(richDeck()), build(renumbered, 1)), []);
  });

  it("a date or slide-number field recache is not a change", async () => {
    // richDeck's date placeholder carries a datetime and a slidenum field whose text differs between variants
    const a = await diffOf(build(richDeck(), 0), build(richDeck({ q2: 21 }), 1));
    assert.deepEqual(a.map((r) => r.kind), ["chart value"]);
  });
});

describe("pptx layer: nothing a reviewer can see changes silently", () => {
  const base = () => build(richDeck());
  const UNMODELLED = "unmodelled content changed";

  it("a chart axis title edit is a row", async () => {
    const rows = await diffOf(base(), build(richDeck({ axis: "Revenue EUR" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Chart 9 / category axis title", "text changed", "Revenue USD", "Revenue EUR"]]);
  });

  it("a custom data label edit is a row, and a number inside it is a number row", async () => {
    const num = await diffOf(base(), build(richDeck({ label: "up 9%" }), 1));
    assert.deepEqual(brief(num), [["Slide 1 / Chart 9 / Revenue, Q2 / label / number 1", "number changed", "5%", "9%"]]);
    const word = await diffOf(base(), build(richDeck({ label: "down 5%" }), 1));
    assert.deepEqual(brief(word), [["Slide 1 / Chart 9 / Revenue, Q2 / label", "text changed", "up 5%", "down 5%"]]);
  });

  it("equation text (a14:m / m:oMath) is read as paragraph text; its numbers are number rows", async () => {
    const rows = await diffOf(base(), build(richDeck({ eq: "x=2" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Equation 10 / number 1", "number changed", "1", "2"]]);
    const word = await diffOf(base(), build(richDeck({ eq: "y=1" }), 1));
    assert.deepEqual(brief(word), [["Slide 1 / Equation 10", "text changed", "x=1", "y=1"]]);
  });

  it("a chartex chart edit is one unmodelled-content row at the shape, not an empty chart", async () => {
    const rows = await diffOf(base(), build(richDeck({ cex: 55 }), 1));
    assert.deepEqual(rows.map((r) => [r.location, r.kind]), [["Slide 1 / Funnel 13", UNMODELLED]]);
    assert.notEqual(rows[0]!.before, rows[0]!.after);
    assert.equal(layer.describe(rows[0]!).startsWith("Slide 1 / Funnel 13: "), true);
  });

  it("SmartArt text and alt text each give one unmodelled-content row", async () => {
    const smart = await diffOf(base(), build(richDeck({ step: "Ship" }), 1));
    assert.deepEqual(smart.map((r) => [r.location, r.kind]), [["Slide 1 / Diagram 12", UNMODELLED]]);
    const alt = await diffOf(base(), build(richDeck({ alt: "Logo on a red field" }), 1));
    assert.deepEqual(alt.map((r) => [r.location, r.kind]), [["Slide 1 / Picture 11", UNMODELLED]]);
  });

  it("an unreadable chart part is a row when its bytes change, and does not sink the deck read", async () => {
    const rows = await diffOf(base(), build(richDeck({ broken: "<<< still not a chart" }), 1));
    assert.deepEqual(rows.map((r) => [r.location, r.kind]), [["Slide 1 / Broken chart 14", UNMODELLED]]);
    // the rest of the deck is still read: a real edit beside it is its own row
    const both = await diffOf(base(), build(richDeck({ cell: "Gamma" }), 1));
    assert.deepEqual(brief(both), [["Slide 1 / Sales Table / R2C2", "text changed", "Alpha", "Gamma"]]);
  });

  it("numeric character references decode: escaped and literal text are no change", async () => {
    const mk = (raw: string): Uint8Array =>
      build({ slides: [{ id: 256, shapes: [(): string => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Body 2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${raw}</a:t></a:r></a:p></p:txBody></p:sp>`] }] });
    assert.deepEqual(await diffOf(mk("A &#8211; B"), mk("A \u2013 B")), []);
    assert.deepEqual(await diffOf(mk("A &#x2013; B"), mk("A &#8211; B")), []);
    assert.deepEqual(await diffOf(mk("R&#x26;D &#60;3"), mk("R&amp;D &lt;3")), []);
    // one pass only: an escaped ampersand in front of a reference stays literal text
    const rows = await diffOf(mk("A &amp;#8211; B"), mk("A \u2013 B"));
    assert.equal(rows[0]!.kind, "text changed");
    assert.equal(rows[0]!.before, "A &#8211; B");
    // a number written as a reference is still a number
    assert.deepEqual(brief(await diffOf(mk("total &#49;00"), mk("total 105"))), [["Slide 1 / Body 2 / number 1", "number changed", "100", "105"]]);
  });

  it("a resave touching every new element kind (runs split, dirty flags, new ids and part names) gives zero rows", async () => {
    assert.deepEqual(await diffOf(build(richDeck(), 0), build(richDeck(), 1)), []);
    assert.deepEqual(await diffOf(build(richDeck(), 1), build(richDeck(), 0)), []);
  });
});

describe("pptx layer: destinations, comments and chart parts are not silent either", () => {
  const base = () => build(richDeck());
  const UNMODELLED = "unmodelled content changed";
  const where = (rows: Awaited<ReturnType<typeof diffOf>>) => rows.map((r) => [r.location, r.kind]);

  it("a run-level hyperlink retargeted with the same link text is a row naming old and new target", async () => {
    const rows = await diffOf(base(), build(richDeck({ link: "https://evil.example/docs" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Docs link 15", "hyperlink target changed", "https://example.com/docs", "https://evil.example/docs"]]);
    assert.equal(rows[0]!.detail.linkText, "Read the docs");
    assert.match(layer.describe(rows[0]!), /Read the docs/);
  });

  it("a hyperlink tooltip edit is a row", async () => {
    const rows = await diffOf(base(), build(richDeck({ tip: "Open the secret docs" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Docs link 15", "hyperlink tooltip changed", "Open the docs", "Open the secret docs"]]);
  });

  it("a shape-level link (on cNvPr) is read per shape", async () => {
    const rows = await diffOf(base(), build(richDeck({ picLink: "https://example.com/other" })));
    assert.deepEqual(brief(rows), [["Slide 1 / Logo link 16", "hyperlink target changed", "https://example.com/logo", "https://example.com/other"]]);
  });

  it("an internal slide jump is compared by the slide it reaches, not by part name", async () => {
    const rows = await diffOf(base(), build(richDeck(), 1));
    assert.deepEqual(rows, []);
    const a = richDeck();
    const b = richDeck();
    b.slides[0]!.extras = b.slides[0]!.extras!.map((x) => (x.key === "jmp" ? { ...x, to: () => "slide1.xml" } : x));
    const jump = await diffOf(build(a), build(b));
    assert.deepEqual(where(jump), [["Slide 1 / Next button 17", "hyperlink target changed"]]);
  });

  it("hover and mouse-over links are read, run-level and shape-level: a retarget is a row at the shape", async () => {
    const cases: [Parameters<typeof richDeck>[0], string, string, string, string][] = [
      [{ runHover: "https://evil.example/h" }, "Hover text 19", "hyperlink target changed", "https://example.com/run-hover", "https://evil.example/h"],
      [{ runOver: "https://evil.example/o" }, "Over text 20", "hyperlink target changed", "https://example.com/run-over", "https://evil.example/o"],
      [{ shapeHover: "https://evil.example/sh" }, "Hover logo 21", "hyperlink target changed", "https://example.com/shape-hover", "https://evil.example/sh"],
      [{ shapeOver: "https://evil.example/so" }, "Over logo 22", "hyperlink target changed", "https://example.com/shape-over", "https://evil.example/so"],
    ];
    for (const [over, shape, kind, was, now] of cases) {
      const rows = await diffOf(base(), build(richDeck(over), 1));
      assert.deepEqual(brief(rows), [[`Slide 1 / ${shape}`, kind, was, now]], shape);
    }
  });

  it("hover and mouse-over tooltip edits are rows, run-level and shape-level", async () => {
    const cases: [Parameters<typeof richDeck>[0], string, string, string][] = [
      [{ runHoverTip: "New hover" }, "Hover text 19", "Hover tip", "New hover"],
      [{ runOverTip: "New over" }, "Over text 20", "Over tip", "New over"],
      [{ shapeHoverTip: "New shape hover" }, "Hover logo 21", "Shape hover tip", "New shape hover"],
      [{ shapeOverTip: "New shape over" }, "Over logo 22", "Shape over tip", "New shape over"],
    ];
    for (const [over, shape, was, now] of cases) {
      const rows = await diffOf(base(), build(richDeck(over), 1));
      assert.deepEqual(brief(rows), [[`Slide 1 / ${shape}`, "hyperlink tooltip changed", was, now]], shape);
    }
  });

  it("a hyperlink added or removed is a row", async () => {
    const withLink = richDeck();
    const without = richDeck();
    without.slides[0]!.shapes[10] = sp(15, "Docs link 15", ["Read the docs"]);
    assert.deepEqual(where(await diffOf(build(without), build(withLink))), [["Slide 1 / Docs link 15", "hyperlink added"]]);
    assert.deepEqual(where(await diffOf(build(withLink), build(without))), [["Slide 1 / Docs link 15", "hyperlink removed"]]);
  });

  it("a chart title held only as a c:strRef cache is read", async () => {
    const rows = await diffOf(base(), build(richDeck({ ctitle: "Cost by month" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Cost chart 18 / title", "chart title changed", "Cost by quarter", "Cost by month"]]);
  });

  it("an axis title held only as a c:strRef cache is read", async () => {
    const rows = await diffOf(base(), build(richDeck({ vaxis: "Cost EUR" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Cost chart 18 / value axis title", "text changed", "Cost USD", "Cost EUR"]]);
  });

  it("a Value From Cells label cache feeds the label rows", async () => {
    const rows = await diffOf(base(), build(richDeck({ rng: "gamma" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / Cost chart 18 / Cost, Q2 / label", "text changed", "beta", "gamma"]]);
  });

  it("legend entries, trendline names and userShapes text change the chart's unmodelled hash", async () => {
    assert.deepEqual(where(await diffOf(base(), build(richDeck({ legendDelete: true }), 1))), [["Slide 1 / Cost chart 18", UNMODELLED]]);
    assert.deepEqual(where(await diffOf(base(), build(richDeck({ trend: "Exponential fit" }), 1))), [["Slide 1 / Cost chart 18", UNMODELLED]]);
    assert.deepEqual(where(await diffOf(base(), build(richDeck({ usr: "Source: marketing" }), 1))), [["Slide 1 / Cost chart 18", UNMODELLED]]);
  });

  it("SmartArt drawing text, not only the data part, is hashed", async () => {
    const rows = await diffOf(base(), build(richDeck({ draw: "Plan then ship" }), 1));
    assert.deepEqual(where(rows), [["Slide 1 / Diagram 12", UNMODELLED]]);
  });

  it("a legacy comment edit is a row at Slide N / comment, author resolved by name", async () => {
    const rows = await diffOf(base(), build(richDeck({ comment: "Check the margin again" }), 1));
    assert.deepEqual(brief(rows), [["Slide 1 / comment", "comment changed", "Ana Lopez: Check the margin", "Ana Lopez: Check the margin again"]]);
  });

  it("a modern comment, and a reply under it, are rows", async () => {
    const text = await diffOf(base(), build(richDeck({ modern: "Is this still current?" }), 1));
    assert.deepEqual(where(text), [["Slide 1 / comment", "comment changed"]]);
    assert.match(String(text[0]!.after), /^Ben Ruiz: Is this still current\?/);
    const reply = await diffOf(base(), build(richDeck({ reply: "No, it moved" }), 1));
    assert.deepEqual(where(reply), [["Slide 1 / comment", "comment changed"]]);
    assert.match(String(reply[0]!.after), /No, it moved/);
  });

  it("comments added or removed are rows", async () => {
    const without = richDeck();
    without.slides[0]!.extras = without.slides[0]!.extras!.filter((x) => x.key !== "cmt");
    assert.deepEqual(where(await diffOf(build(without), base())), [["Slide 1 / comment", "comment added"]]);
    assert.deepEqual(where(await diffOf(base(), build(without))), [["Slide 1 / comment", "comment removed"]]);
  });

  it("restate reads a link or comment row from a later snapshot", async () => {
    const rows = await diffOf(base(), build(richDeck({ link: "https://evil.example/docs" })));
    const later = await put(build(richDeck({ link: "https://third.example/" })));
    assert.equal((await layer.restate(later, rows[0]!)).after, "https://third.example/");
    const cmt = await diffOf(base(), build(richDeck({ comment: "Changed" })));
    const now = await put(build(richDeck({ comment: "Changed again" })));
    assert.equal((await layer.restate(now, cmt[0]!)).after, "Ana Lopez: Changed again");
  });

  it("a resave of a deck carrying every new kind gives zero rows, both directions", async () => {
    assert.deepEqual(await diffOf(build(richDeck(), 0), build(richDeck(), 1)), []);
    assert.deepEqual(await diffOf(build(richDeck(), 1), build(richDeck(), 0)), []);
  });
});

describe("pptx layer: every relationship reachable from a slide is accounted for", () => {
  /** Types a slide reaches that no reader consumed and that are not on the documented skip list. */
  const unaccounted = (bytes: Uint8Array): string[] => {
    const { consumed } = readDeckTraced(bytes);
    return [...slideRelationshipTypes(bytes)].filter((t) => !consumed.has(t) && !(t in SKIPPED_RELATIONSHIPS)).sort();
  };

  it("in the fixture deck, in both resave variants, each type is read or explicitly skipped", () => {
    for (const v of [0, 1]) {
      const bytes = build(richDeck(), v);
      assert.deepEqual(unaccounted(bytes), []);
      // the check is not vacuous: the fixture reaches every kind this item added
      const { consumed } = readDeckTraced(bytes);
      for (const t of ["hyperlink", "slide", "notesSlide", "chart", "diagramData", "chartUserShapes", "comments", "commentAuthors"]) {
        assert.equal(consumed.has(`${REL}/${t}`), true, t);
      }
      for (const t of [
        "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
        "http://schemas.microsoft.com/office/2014/relationships/chartEx",
        "http://schemas.microsoft.com/office/2018/10/relationships/comments",
        "http://schemas.microsoft.com/office/2018/10/relationships/authors",
      ]) {
        assert.equal(consumed.has(t), true, t);
      }
    }
  });

  it("a relationship type nobody reads is caught", () => {
    const d = richDeck();
    d.slides[0]!.extras!.push({ key: "odd", relType: "http://example.com/relationships/mystery", part: () => "ppt/odd/odd1.xml", xml: () => "<odd>hi</odd>" });
    assert.deepEqual(unaccounted(build(d)), ["http://example.com/relationships/mystery"]);
  });

  // Written by PowerPoint for Mac 16.113: the original, a bare resave (Save As, no edit) and one number edited.
  const fixture = (name: string): Uint8Array => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const [original, resave, edit] = ["deck-resave.pptx", "deck-resave-resaved.pptx", "deck-resave-edit.pptx"].map(fixture) as [Uint8Array, Uint8Array, Uint8Array];

  it("real PowerPoint decks: every relationship type they reach is read or explicitly skipped", () => {
    for (const bytes of [original, resave, edit]) {
      assert.deepEqual(unaccounted(bytes), []);
      assert.equal(slideRelationshipTypes(bytes).size > 0, true);
    }
  });

  it("real PowerPoint resave with no edit gives zero rows, though the bytes differ", async () => {
    assert.notDeepEqual(Buffer.from(resave), Buffer.from(original));
    assert.deepEqual(await diffOf(original, resave), []);
    assert.deepEqual(await diffOf(resave, original), []);
  });

  it("real PowerPoint deck with one number edited gives exactly that row", async () => {
    const rows = await diffOf(original, edit);
    assert.deepEqual(brief(rows), [["Slide 2 / Text Placeholder 4 / number 1", "number changed", "1,050", "1,120"]]);
  });

  it("PowerPoint-saved table deck: a table cell edit gives exactly that cell's row", async () => {
    const table = fixture("ppt-table-deck.pptx");
    assert.deepEqual(unaccounted(table), []);
    // The cell's one run, edited in the slide XML directly.
    const parts = unzipSync(table);
    const slide = new TextDecoder().decode(parts["ppt/slides/slide2.xml"]!);
    assert.equal(slide.split(">135<").length, 2);
    parts["ppt/slides/slide2.xml"] = strToU8(slide.replace(">135<", ">140<"));
    const edited = zipSync(parts);
    assert.deepEqual(brief(await diffOf(table, edited)), [["Slide 2 / Table 3 / R2C2 / number 1", "number changed", "135", "140"]]);
  });

  it("real PowerPoint deck, unzipped and rezipped in another order, gives zero rows", async () => {
    const files = unzipSync(original);
    const rezipped = zipSync(Object.fromEntries(Object.keys(files).reverse().map((n) => [n, files[n]!])), { mtime: new Date(2026, 9, 1) });
    assert.notDeepEqual(Buffer.from(rezipped), Buffer.from(original));
    assert.deepEqual(await diffOf(original, rezipped), []);
  });
});

describe("pptx layer: file-level rows and restate", () => {
  it("new, deleted and unreadable decks each give one whole-file row", async () => {
    const good = await put(build(richDeck()));
    assert.deepEqual((await layer.diff(null, good)).map((r) => r.kind), ["new file"]);
    assert.deepEqual((await layer.diff(good, null)).map((r) => r.kind), ["file deleted"]);
    const bad = await put(strToU8("not a zip"));
    const rows = await layer.diff(good, bad);
    assert.deepEqual(rows.map((r) => [r.location, r.kind]), [["file", "binary file changed"]]);
    assert.equal(layer.describe(rows[0]!), "file changed (could not read the deck; contents differ)");
  });

  it("snapshot is a byte copy, or 'missing'", async () => {
    const src = await put(build(richDeck()));
    const dest = path.join(dir, "snap", "copy.pptx");
    assert.equal(await layer.snapshot(src, dest), "copy");
    assert.deepEqual(await readFile(dest), await readFile(src));
    assert.equal(await layer.snapshot(path.join(dir, "nope.pptx"), dest), "missing");
  });

  it("restate reads the row's location from a later snapshot", async () => {
    const rows = await diffOf(build(richDeck()), build(richDeck({ cell: "Gamma" })));
    const later = await put(build(richDeck({ cell: "Delta" })));
    assert.equal((await layer.restate(later, rows[0]!)).after, "Delta");
    assert.equal((await layer.restate(null, rows[0]!)).after, null);
    const nums = await diffOf(
      build({ slides: [{ id: 1, shapes: [sp(2, "B", ["total 100 and 7"])] }] }),
      build({ slides: [{ id: 1, shapes: [sp(2, "B", ["total 100 and 8"])] }] }),
    );
    const now = await put(build({ slides: [{ id: 1, shapes: [sp(2, "B", ["total 100 and 9"])] }] }));
    assert.equal((await layer.restate(now, nums[0]!)).after, "9");
  });

  it("nothing logged by CoCheck can explain a deck row", () => {
    const op = { opId: 1, tool: "x", args: {}, intent: "", client: null };
    const r = { location: "Slide 1 / T", kind: "text changed", before: "a", after: "b", derivable: false, detail: {} };
    assert.equal(layer.touches(op, "/x/d.pptx", r), false);
    assert.equal(layer.explains(op, "/x/d.pptx", r), false);
  });
});

describe("pptx layer: folder watch wiring", () => {
  const fakeXlsx: FormatLayer = {
    name: "xlsx",
    accepts: (p) => /\.xlsx$/i.test(p),
    snapshot: async () => "missing",
    diff: async () => [],
    describe: () => "",
    touches: () => false,
    explains: () => false,
    restate: async (_p, row) => row,
  };

  async function setup() {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-pptx-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-pptx-folder-")));
    const ledger = openLedger(home);
    const tasks = new TaskStore(ledger, home, [fakeXlsx, createPptxLayer(), createFilesLayer()]);
    const book = path.join(folder, "book.xlsx");
    await writeFile(book, "x");
    return {
      tasks,
      folder,
      book,
      cleanup: async () => {
        ledger.close();
        await rm(home, { recursive: true, force: true });
        await rm(folder, { recursive: true, force: true });
      },
    };
  }

  it("a deck edited outside CoCheck shows as unlogged slide/shape rows", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    const deck = path.join(folder, "board.pptx");
    await writeFile(deck, build(richDeck()));
    await tasks.touch("c", book);
    await writeFile(deck, build(richDeck({ cell: "Gamma", q2: 25 })));
    const summary = await tasks.submit("c", "done", false);
    assert.deepEqual(
      summary.rows.map((r) => [path.basename(r.file), r.status, r.description]),
      [["board.pptx", "unlogged", changedOutsideWording("changed")]], // R2 g: an untouched deck is a fingerprint, so one row and no slide diff
    );
    await cleanup();
  });

  // one identity, the plain SHA-256. A TaskStore with no hook chain (this test's) sees any byte change of an untouched deck,
  // a docProps-only re-save included, as one row; a hook task drops the row and its connector vouches the re-save instead.
  it("a resave that only moves docProps is one row now (plain SHA-256, no filter); one that renumbers parts is one row too", async () => {
    const { tasks, folder, book, cleanup } = await setup();
    const deck = path.join(folder, "board.pptx");
    const base = build(richDeck(), 0);
    await writeFile(deck, base);
    await tasks.touch("c", book);
    const props = unzipSync(base);
    props["docProps/core.xml"] = strToU8(`<cp:coreProperties xmlns:cp="x" xmlns:dcterms="y"><dcterms:modified>2027-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`);
    await writeFile(deck, zipSync(props));
    assert.deepEqual((await tasks.submit("c", "done", false)).rows.map((r) => r.description), [changedOutsideWording("changed")]);
    // Renumbered parts: one row, with no slide diff.
    await writeFile(deck, build(richDeck(), 1));
    const next = await tasks.submit("c", "again", false);
    assert.deepEqual(next.rows.map((r) => r.description), [changedOutsideWording("changed")]);
    await cleanup();
  });
});
