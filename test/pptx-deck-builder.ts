import { strToU8, zipSync } from "fflate";

/** A minimal but real .pptx builder for the deck-model tests (parts, relationships and sldIdLst as PowerPoint writes them). */
export interface SlideSpec {
  id: number;
  /** The slide's one text box. */
  text: string;
  hidden?: boolean;
  transition?: string;
  media?: string[];
  chart?: { workbook: string; values: string[]; props?: string };
  notes?: string;
  /** Horizontal offset of the text box, EMU. */
  dx?: number;
}

export interface DeckSpec {
  slides: SlideSpec[];
  layout?: string;
  master?: string;
  theme?: string;
}

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"`;
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: Array<[string, string, string]>): Uint8Array =>
  strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`);

export function buildDeck(spec: DeckSpec): Buffer {
  const files: Record<string, Uint8Array> = {};
  files["_rels/.rels"] = rels([["rId1", `${R}/officeDocument`, "ppt/presentation.xml"]]);
  files["ppt/presentation.xml"] = strToU8(
    `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${spec.slides.map((s, i) => `<p:sldId id="${s.id}" r:id="rId${i + 10}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
  );
  files["ppt/_rels/presentation.xml.rels"] = rels(spec.slides.map((s, i) => [`rId${i + 10}`, `${R}/slide`, `slides/slide${s.id}.xml`]));
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(`<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld name="${spec.layout ?? "Title"}"><p:spTree/></p:cSld></p:sldLayout>`);
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = rels([["rId1", `${R}/slideMaster`, "../slideMasters/slideMaster1.xml"]]);
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(`<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld name="${spec.master ?? "Office"}"><p:spTree/></p:cSld></p:sldMaster>`);
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rels([["rId1", `${R}/theme`, "../theme/theme1.xml"]]);
  files["ppt/theme/theme1.xml"] = strToU8(`<?xml version="1.0"?><a:theme ${NS} name="${spec.theme ?? "Office Theme"}"/>`);
  for (const s of spec.slides) {
    const rl: Array<[string, string, string]> = [["rId1", `${R}/slideLayout`, "../slideLayouts/slideLayout1.xml"]];
    let extra = "";
    (s.media ?? []).forEach((m, i) => {
      files[`ppt/media/image${s.id}_${i}.png`] = strToU8(m);
      rl.push([`rId${20 + i}`, `${R}/image`, `../media/image${s.id}_${i}.png`]);
    });
    if (s.chart) {
      files[`ppt/embeddings/book${s.id}.xlsx`] = zipSync({ "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns:xr="x" xr:uid="{${s.chart.props ?? "A"}}"><sheetData><row><c><v>${s.chart.workbook}</v></c></row></sheetData></worksheet>`), "docProps/core.xml": strToU8(s.chart.props ?? "p") }, { mtime: new Date(2020, 0, 1) });
      files[`ppt/charts/chart${s.id}.xml`] = strToU8(
        `<?xml version="1.0"?><c:chartSpace ${NS}><c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:tx><c:v>S</c:v></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$9</c:f><c:strCache><c:ptCount val="${s.chart.values.length}"/>${s.chart.values.map((_, i) => `<c:pt idx="${i}"><c:v>c${i}</c:v></c:pt>`).join("")}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$9</c:f><c:numCache><c:ptCount val="${s.chart.values.length}"/>${s.chart.values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("")}</c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart><c:externalData r:id="rId1"/></c:chartSpace>`,
      );
      files[`ppt/charts/_rels/chart${s.id}.xml.rels`] = rels([["rId1", `${R}/package`, `../embeddings/book${s.id}.xlsx`]]);
      rl.push(["rId30", `${R}/chart`, `../charts/chart${s.id}.xml`]);
      extra = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart 9"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="100000" y="3000000"/><a:ext cx="4000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId30"/></a:graphicData></a:graphic></p:graphicFrame>`;
    }
    if (s.notes !== undefined) {
      files[`ppt/notesSlides/notes${s.id}.xml`] = strToU8(`<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
      rl.push(["rId40", `${R}/notesSlide`, `../notesSlides/notes${s.id}.xml`]);
    }
    files[`ppt/slides/_rels/slide${s.id}.xml.rels`] = rels(rl);
    files[`ppt/slides/slide${s.id}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld ${NS}${s.hidden ? ' show="0"' : ""}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text 2"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${100000 + (s.dx ?? 0)}" y="100000"/><a:ext cx="4000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>${s.text}</a:t></a:r></a:p></p:txBody></p:sp>${extra}</p:spTree></p:cSld>${s.transition ?? ""}</p:sld>`,
    );
  }
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}
