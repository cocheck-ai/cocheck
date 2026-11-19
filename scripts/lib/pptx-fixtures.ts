// Structurally complete .pptx decks built with fflate on top of the master, layouts, theme and
// presProps/viewProps/tableStyles PowerPoint itself wrote (pptx-skeleton.ts), for the kill test and its unit tests. Shaped like
// what PowerPoint writes so PowerPoint opens them; PowerPoint is made to resave them before any
// edit is made, so the edit module only ever sees Office-written bytes in the live run.
import { strToU8, zipSync } from "fflate";
import { SK_DEFAULT_TEXT_STYLE, SK_LAYOUTS, SK_MASTER, SK_PRES_PROPS, SK_TABLE_STYLES, SK_THEME, SK_VIEW_PROPS } from "./pptx-skeleton.ts";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = NS_R;
/** "Title and Content" in the skeleton: the layout every fixture slide uses. */
const CONTENT_LAYOUT = "slideLayout2.xml";
const CT_BASE = "application/vnd.openxmlformats-officedocument";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Parts = Record<string, string | Uint8Array>;
type Rel = { id: string; type: string; target: string };

const rels = (list: Rel[]): string =>
  `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith("http") ? r.type : `${REL}/${r.type}`}" Target="${r.target}"/>`)
    .join("")}</Relationships>`;

const GROUP_PROPS =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const run = (t: string): string => `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(t)}</a:t></a:r>`;
const para = (t: string): string => `<a:p>${run(t)}</a:p>`;

const xfrm = (x: number, y: number, cx: number, cy: number): string => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;

function title(id: number, text: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${para(text)}</p:txBody></p:sp>`;
}

function textBox(id: number, name: string, x: number, y: number, cx: number, cy: number, paragraphs: string[]): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, cx, cy)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphs.map(para).join("")}</p:txBody></p:sp>`;
}

function chartFrame(id: number, name: string, rid: string): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="838200" y="1825625"/><a:ext cx="6096000" cy="3500000"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function group(id: number, name: string, members: string[]): string {
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="838200" y="2000000"/><a:ext cx="6000000" cy="2000000"/><a:chOff x="838200" y="2000000"/><a:chExt cx="6000000" cy="2000000"/></a:xfrm></p:grpSpPr>${members.join("")}</p:grpSp>`
  );
}

const chartXml = (): string => {
  const ser = (i: number, name: string, col: string, vals: number[]): string =>
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>Sheet1!$${col}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:invertIfNegative val="0"/>` +
    `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$5</c:f><c:strCache><c:ptCount val="4"/>${["Q1", "Q2", "Q3", "Q4"].map((q, k) => `<c:pt idx="${k}"><c:v>${q}</c:v></c:pt>`).join("")}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>Sheet1!$${col}$2:$${col}$5</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="4"/>${vals.map((v, k) => `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>`).join("")}</c:numCache></c:numRef></c:val></c:ser>`;
  return (
    `${DECL}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:date1904 val="0"/><c:roundedCorners val="0"/>` +
    `<c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
    ser(0, "Revenue", "B", [120, 135, 150, 170]) +
    ser(1, "Cost", "C", [80, 85, 90, 95]) +
    `<c:gapWidth val="150"/><c:axId val="111111111"/><c:axId val="222222222"/></c:barChart>` +
    `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>` +
    `</c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`
  );
};

/** A small workbook holding the chart's data, as the chart's embedded package. */
function workbook(): Uint8Array {
  const cell = (ref: string, v: string | number): string => (typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const rows = [["", "Revenue", "Cost"], ["Q1", 120, 80], ["Q2", 135, 85], ["Q3", 150, 90], ["Q4", 170, 95]] as (string | number)[][];
  const sheet = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v === "" ? "" : cell(`${"ABC"[j]}${i + 1}`, v))).join("")}</row>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8(`${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT_BASE}.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT_BASE}.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(rels([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }])),
    "xl/workbook.xml": strToU8(`${DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(rels([{ id: "rId1", type: "worksheet", target: "worksheets/sheet1.xml" }])),
    "xl/worksheets/sheet1.xml": strToU8(`${DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`),
  });
}

const lvlN = (n: number): string => `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;

const hfPlaceholder = (id: number, name: string, ph: string, x: number, y: number, algn: string, anchor: string, text: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(x, y, 2971800, 458788)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${anchor}"/><a:lstStyle><a:lvl1pPr algn="${algn}"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle><a:p>${text}</a:p></p:txBody></p:sp>`;

const NOTES_MASTER =
  `${DECL}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_PROPS}` +
  hfPlaceholder(2, "Header Placeholder 1", '<p:ph type="hdr" sz="quarter"/>', 0, 0, "l", "t", '<a:endParaRPr lang="en-US"/>') +
  hfPlaceholder(3, "Date Placeholder 2", '<p:ph type="dt" idx="1"/>', 3884613, 0, "r", "t", '<a:fld id="{6A8B6C1E-3F0D-4E55-9C0B-0D2D5B2B7A11}" type="datetimeFigureOut"><a:rPr lang="en-US"/><a:t>1/1/2026</a:t></a:fld><a:endParaRPr lang="en-US"/>') +
  `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Image Placeholder 3"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(685800, 1143000, 5486400, 3086100)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Notes Placeholder 4"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(685800, 4400550, 5486400, 3600450)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>` +
  hfPlaceholder(6, "Footer Placeholder 5", '<p:ph type="ftr" sz="quarter" idx="4"/>', 0, 8685213, "l", "b", '<a:endParaRPr lang="en-US"/>') +
  hfPlaceholder(7, "Slide Number Placeholder 6", '<p:ph type="sldNum" sz="quarter" idx="5"/>', 3884613, 8685213, "r", "b", '<a:fld id="{3C1B7F52-8D7A-4A64-9E52-6B7B1D0C4E22}" type="slidenum"><a:rPr lang="en-US"/><a:t>\u2039#\u203A</a:t></a:fld><a:endParaRPr lang="en-US"/>') +
  `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:notesStyle>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(lvlN).join("")}</p:notesStyle></p:notesMaster>`;

const notesSlide = (text: string): string =>
  `${DECL}<p:notes ${NS}><p:cSld><p:spTree>${GROUP_PROPS}` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${para(text)}</p:txBody></p:sp>` +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;

interface SlideDef {
  shapes: string[];
  rels?: Rel[];
  notes?: string;
}

interface DeckDef {
  slides: SlideDef[];
  extra?: Parts;
  /** Extra `[Content_Types].xml` children. */
  types?: string;
}

function build(def: DeckDef): Uint8Array {
  const parts: Parts = {};
  const hasNotes = def.slides.some((s) => s.notes !== undefined);
  const overrides: string[] = [
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT_BASE}.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT_BASE}.presentationml.slideMaster+xml"/>`,
    ...SK_LAYOUTS.map((_, i) => `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="${CT_BASE}.presentationml.slideLayout+xml"/>`),
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT_BASE}.theme+xml"/>`,
    `<Override PartName="/ppt/presProps.xml" ContentType="${CT_BASE}.presentationml.presProps+xml"/>`,
    `<Override PartName="/ppt/viewProps.xml" ContentType="${CT_BASE}.presentationml.viewProps+xml"/>`,
    `<Override PartName="/ppt/tableStyles.xml" ContentType="${CT_BASE}.presentationml.tableStyles+xml"/>`,
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    `<Override PartName="/docProps/app.xml" ContentType="${CT_BASE}.extended-properties+xml"/>`,
  ];
  const presRels: Rel[] = [{ id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" }];
  def.slides.forEach((s, i) => {
    const n = i + 1;
    presRels.push({ id: `rId${n + 1}`, type: "slide", target: `slides/slide${n}.xml` });
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT_BASE}.presentationml.slide+xml"/>`);
    const slideRels: Rel[] = [{ id: "rId1", type: "slideLayout", target: `../slideLayouts/${CONTENT_LAYOUT}` }, ...(s.rels ?? [])];
    parts[`ppt/slides/slide${n}.xml`] = `${DECL}<p:sld ${NS}><p:cSld><p:spTree>${GROUP_PROPS}${s.shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    if (s.notes !== undefined) {
      slideRels.push({ id: `rId${slideRels.length + 1}`, type: "notesSlide", target: `../notesSlides/notesSlide${n}.xml` });
      parts[`ppt/notesSlides/notesSlide${n}.xml`] = notesSlide(s.notes);
      parts[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = rels([
        { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
        { id: "rId2", type: "slide", target: `../slides/slide${n}.xml` },
      ]);
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="${CT_BASE}.presentationml.notesSlide+xml"/>`);
    }
    parts[`ppt/slides/_rels/slide${n}.xml.rels`] = rels(slideRels);
  });
  let next = def.slides.length + 2;
  let notesMasterId = "";
  if (hasNotes) {
    notesMasterId = `rId${next}`;
    presRels.push({ id: notesMasterId, type: "notesMaster", target: "notesMasters/notesMaster1.xml" });
    next++;
    parts["ppt/notesMasters/notesMaster1.xml"] = NOTES_MASTER;
    parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = rels([{ id: "rId1", type: "theme", target: "../theme/theme2.xml" }]);
    parts["ppt/theme/theme2.xml"] = SK_THEME;
    overrides.push(`<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT_BASE}.presentationml.notesMaster+xml"/>`, `<Override PartName="/ppt/theme/theme2.xml" ContentType="${CT_BASE}.theme+xml"/>`);
  }
  for (const [type, target] of [["presProps", "presProps.xml"], ["viewProps", "viewProps.xml"], ["theme", "theme/theme1.xml"], ["tableStyles", "tableStyles.xml"]] as const) {
    presRels.push({ id: `rId${next++}`, type, target });
  }
  const ids = (from: number) => def.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + from}"/>`).join("");
  parts["ppt/presentation.xml"] =
    `${DECL}<p:presentation ${NS} saveSubsetFonts="1" autoCompressPictures="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    (hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterId}"/></p:notesMasterIdLst>` : "") +
    `<p:sldIdLst>${ids(2)}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>${SK_DEFAULT_TEXT_STYLE}</p:presentation>`;
  parts["ppt/_rels/presentation.xml.rels"] = rels(presRels);
  parts["ppt/slideMasters/slideMaster1.xml"] = SK_MASTER;
  parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rels([
    ...SK_LAYOUTS.map((_, i) => ({ id: `rId${i + 1}`, type: "slideLayout", target: `../slideLayouts/slideLayout${i + 1}.xml` })),
    { id: `rId${SK_LAYOUTS.length + 1}`, type: "theme", target: "../theme/theme1.xml" },
  ]);
  SK_LAYOUTS.forEach((xml, i) => {
    parts[`ppt/slideLayouts/slideLayout${i + 1}.xml`] = xml;
    parts[`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`] = rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]);
  });
  parts["ppt/theme/theme1.xml"] = SK_THEME;
  parts["ppt/presProps.xml"] = SK_PRES_PROPS;
  parts["ppt/viewProps.xml"] = SK_VIEW_PROPS;
  parts["ppt/tableStyles.xml"] = SK_TABLE_STYLES;
  parts["docProps/core.xml"] = `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>CoCheck kill test</dc:title><dc:creator>CoCheck Test</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-10-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-01T00:00:00Z</dcterms:modified></cp:coreProperties>`;
  parts["docProps/app.xml"] = `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office PowerPoint</Application><Slides>${def.slides.length}</Slides></Properties>`;
  Object.assign(parts, def.extra ?? {});
  const content =
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${def.types ?? ""}${overrides.join("")}</Types>`;
  const root = rels([
    { id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" },
    { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
    { id: "rId3", type: "extended-properties", target: "docProps/app.xml" },
  ]);
  const files: Record<string, Uint8Array> = { "[Content_Types].xml": strToU8(content), "_rels/.rels": strToU8(root) };
  for (const [name, body] of Object.entries(parts)) files[name] = typeof body === "string" ? strToU8(body) : body;
  return zipSync(files);
}

const intro = (heading: string): string[] => [title(2, heading), textBox(3, "TextBox 2", 838200, 1400000, 9000000, 600000, ["Revenue grew 12% to $4.2M in Q3"])];

/** The generated decks of the kill test, by file stem. No table deck: the generated one differed from what PowerPoint writes; table cases use the PowerPoint-saved test/fixtures/ppt-table-deck.pptx. */
export function killTestDecks(): Record<string, Uint8Array> {
  const chartRels: Rel[] = [{ id: "rId2", type: "chart", target: "../charts/chart1.xml" }];
  return {
    "chart-deck": build({
      slides: [{ shapes: intro("Chart deck") }, { shapes: [title(2, "Revenue and cost"), chartFrame(3, "Chart 2", "rId2")], rels: chartRels }],
      extra: {
        "ppt/charts/chart1.xml": chartXml(),
        "ppt/charts/_rels/chart1.xml.rels": rels([{ id: "rId1", type: "package", target: "../embeddings/Microsoft_Excel_Worksheet.xlsx" }]),
        "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx": workbook(),
      },
      types: `<Default Extension="xlsx" ContentType="${CT_BASE}.spreadsheetml.sheet"/><Override PartName="/ppt/charts/chart1.xml" ContentType="${CT_BASE}.drawingml.chart+xml"/>`,
    }),
    "grouped-deck": build({
      slides: [
        {
          shapes: [
            title(2, "Grouped deck"),
            group(3, "Group 2", [
              textBox(4, "TextBox 3", 838200, 2000000, 2800000, 600000, ["Pipeline coverage is 3.1x"]),
              textBox(5, "TextBox 4", 4038200, 2000000, 2800000, 600000, ["Win rate is 24%"]),
            ]),
          ],
        },
      ],
    }),
    "notes-deck": build({
      slides: [
        { shapes: intro("Notes deck"), notes: "Open with the Q3 number: 12% growth." },
        { shapes: [title(2, "Second slide")], notes: "Mention the pipeline." },
      ],
    }),
    "long-deck": build({
      slides: Array.from({ length: 32 }, (_, i) => ({
        shapes: [title(2, `Slide ${i + 1} heading`), textBox(3, "TextBox 2", 838200, 1400000, 9000000, 600000, [`Item ${i + 1} count is ${100 + i}`])],
      })),
    }),
  };
}
