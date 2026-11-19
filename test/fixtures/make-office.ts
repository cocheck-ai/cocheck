import { strToU8, unzipSync, zipSync } from "fflate";
import { readFileSync } from "node:fs";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A minimal valid .docx: one paragraph per string. `extraProp` adds a custom property so the bytes differ with identical text. */
export function makeDocx(paragraphs: string[], extraProp = ""): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${extraProp ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' : ""}</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>${extraProp ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' : ""}</Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`),
  };
  if (extraProp) files["docProps/core.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(extraProp)}</dc:title></cp:coreProperties>`);
  return Buffer.from(zipSync(files, { level: 0, mtime: new Date(Date.UTC(2020, 0, 1)) }));
}

/** A real .pptx fixture with `from` replaced by `to` in its slide text (every slide part). */
export function editPptx(file: string, from: string, to: string): Buffer {
  const parts = unzipSync(new Uint8Array(readFileSync(file)));
  let hit = 0;
  for (const name of Object.keys(parts)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const xml = Buffer.from(parts[name]!).toString("utf8");
    if (xml.includes(from)) hit += 1;
    parts[name] = strToU8(xml.split(from).join(to));
  }
  if (hit === 0) throw new Error(`"${from}" is not in ${file}`);
  return Buffer.from(zipSync(parts, { level: 0, mtime: new Date(Date.UTC(2020, 0, 1)) }));
}

/** A copy of a .pptx with one solid rectangle added to slide `n`: the text is the same, the slide draws differently. */
export function addPptxRect(file: string, n: number, rgb = "C00000"): Buffer {
  const parts = unzipSync(new Uint8Array(readFileSync(file)));
  const name = `ppt/slides/slide${n}.xml`;
  const xml = Buffer.from(parts[name]!).toString("utf8");
  const rect = `<p:sp><p:nvSpPr><p:cNvPr id="90" name="Block"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="6000000" y="4500000"/><a:ext cx="2400000" cy="1200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${rgb}"/></a:solidFill></p:spPr></p:sp>`;
  parts[name] = strToU8(xml.replace("</p:spTree>", `${rect}</p:spTree>`));
  return Buffer.from(zipSync(parts, { level: 0, mtime: new Date(Date.UTC(2020, 0, 1)) }));
}
