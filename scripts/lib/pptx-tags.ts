import { strFromU8, strToU8 } from "fflate";
import { Zip } from "../../src/office/connector/pptx/zip.ts";

/**
 * Deck-number-to-model-cell links stored inside the PPTX as shape tags (spec section 6.6).
 * A tagged shape carries `p:nvPr/p:custDataLst/p:tags r:id=...`; the id names a slide relationship of
 * the tags type, which targets /ppt/tags/tagN.xml holding `<p:tag name="COCHECK.LINKS" val="..."/>`.
 * Everything here is byte-level on the three or four parts it must touch; no other part is rewritten.
 */

export const TAG_NAME = "COCHECK.LINKS";
const REL_TAGS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tags";
const CT_TAGS = "application/vnd.openxmlformats-officedocument.presentationml.tags+xml";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";

const escAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");

const unescAttr = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}="([^"]*)"`));
  return m ? unescAttr(m[1]!) : undefined;
};

interface Rel {
  id: string;
  type: string;
  target: string;
}

const dirOf = (part: string): string => part.slice(0, part.lastIndexOf("/") + 1);
const relsPart = (part: string): string => `${dirOf(part)}_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`;

function resolveTarget(source: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out: string[] = [];
  for (const seg of `${dirOf(source)}${target}`.split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}

const readRels = (zip: Zip, part: string): Rel[] => {
  const name = relsPart(part);
  if (!zip.has(name)) return [];
  const xml = strFromU8(zip.read(name));
  return [...xml.matchAll(/<Relationship\s[^>]*>/g)].map((m) => ({ id: attr(m[0], "Id")!, type: attr(m[0], "Type")!, target: attr(m[0], "Target")! }));
};

/** Slide part names in presentation order. */
function slideParts(zip: Zip): string[] {
  const pres = strFromU8(zip.read("ppt/presentation.xml"));
  const rels = readRels(zip, "ppt/presentation.xml");
  return [...pres.matchAll(/<p:sldId\s[^>]*>/g)].map((m) => {
    const rel = rels.find((r) => r.id === attr(m[0], "r:id"));
    if (!rel) throw new Error("presentation.xml names a slide whose relationship is missing");
    return resolveTarget("ppt/presentation.xml", rel.target);
  });
}

interface ShapeSpan {
  name: string;
  /** Offset just past the shape's cNvPr element. */
  from: number;
  /** Offset of the next cNvPr (or the end of the part): the shape's own non-visual properties lie in [from, to). */
  to: number;
}

function shapeSpans(xml: string): ShapeSpan[] {
  const found = [...xml.matchAll(/<p:cNvPr\s[^>]*?(?:\/>|>.*?<\/p:cNvPr>)/gs)];
  return found.map((m, i) => ({ name: attr(m[0].match(/^<p:cNvPr\s[^>]*?\/?>/s)![0], "name") ?? "", from: m.index! + m[0].length, to: found[i + 1]?.index ?? xml.length }));
}

const nextFree = (taken: Iterable<string>, make: (n: number) => string): string => {
  const set = new Set(taken);
  for (let n = 1; ; n++) if (!set.has(make(n))) return make(n);
};

/** Returns a copy of the deck in which shape `shapeName` on slide `slide` (1-based) carries the link tag. */
export function tagShape(input: Uint8Array, slide: number, shapeName: string, json: string): Uint8Array {
  JSON.parse(json);
  const zip = new Zip(input);
  const slides = slideParts(zip);
  const slidePart = slides[slide - 1];
  if (!slidePart) throw new Error(`slide ${slide} does not exist (the deck has ${slides.length})`);
  const xml = strFromU8(zip.read(slidePart));
  const spans = shapeSpans(xml).filter((s) => s.name === shapeName);
  if (spans.length === 0) throw new Error(`no shape named "${shapeName}" on slide ${slide}`);
  if (spans.length > 1) throw new Error(`${spans.length} shapes are named "${shapeName}" on slide ${slide}; the name is ambiguous`);
  const span = spans[0]!;
  const region = xml.slice(span.from, span.to);
  const nv = region.match(/<p:nvPr\s*\/>|<p:nvPr(?:\s[^>]*)?>/);
  if (!nv) throw new Error(`shape "${shapeName}" has no p:nvPr`);

  const rels = readRels(zip, slidePart);
  const relId = nextFree(rels.map((r) => r.id), (n) => `rId${n}`);
  const tagPart = nextFree(zip.names, (n) => `ppt/tags/tag${n}.xml`);
  const ref = `<p:tags r:id="${relId}"/>`;

  let patched: string;
  const nvAt = span.from + nv.index!;
  if (nv[0].endsWith("/>")) {
    patched = xml.slice(0, nvAt) + `<p:nvPr><p:custDataLst>${ref}</p:custDataLst></p:nvPr>` + xml.slice(nvAt + nv[0].length);
  } else {
    const bodyStart = nvAt + nv[0].length;
    const close = xml.indexOf("</p:nvPr>", bodyStart);
    const body = xml.slice(bodyStart, close);
    const lst = body.indexOf("</p:custDataLst>");
    let insertAt: number;
    let text: string;
    if (lst >= 0) {
      insertAt = bodyStart + lst;
      text = ref;
    } else {
      // custDataLst sits after ph and the audio/video/media children, before extLst.
      const ext = body.indexOf("<p:extLst");
      insertAt = bodyStart + (ext >= 0 ? ext : body.length);
      text = `<p:custDataLst>${ref}</p:custDataLst>`;
    }
    patched = xml.slice(0, insertAt) + text + xml.slice(insertAt);
  }

  const relsName = relsPart(slidePart);
  const relEntry = `<Relationship Id="${relId}" Type="${REL_TAGS}" Target="../tags/${tagPart.slice("ppt/tags/".length)}"/>`;
  const replacements = new Map<string, Uint8Array>([[slidePart, strToU8(patched)]]);
  const additions = new Map<string, Uint8Array>();
  if (zip.has(relsName)) {
    const relsXml = strFromU8(zip.read(relsName));
    if (!relsXml.includes("</Relationships>")) throw new Error(`${relsName} is self-closed; refusing to guess`);
    replacements.set(relsName, strToU8(relsXml.replace("</Relationships>", `${relEntry}</Relationships>`)));
  } else {
    additions.set(relsName, strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntry}</Relationships>`));
  }
  const ct = strFromU8(zip.read("[Content_Types].xml"));
  replacements.set("[Content_Types].xml", strToU8(ct.replace("</Types>", `<Override PartName="/${tagPart}" ContentType="${CT_TAGS}"/></Types>`)));
  additions.set(
    tagPart,
    strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:tagLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="${NS_P}"><p:tag name="${TAG_NAME}" val="${escAttr(json)}"/></p:tagLst>`),
  );
  return zip.rewrite(replacements, additions);
}

export interface FoundTag {
  slide: number;
  shape: string;
  name: string;
  value: string;
}

/** Every COCHECK.* tag reachable from a shape's custDataLst, in slide then document order. */
export function readTags(input: Uint8Array): FoundTag[] {
  const zip = new Zip(input);
  const out: FoundTag[] = [];
  slideParts(zip).forEach((slidePart, i) => {
    const xml = strFromU8(zip.read(slidePart));
    const rels = readRels(zip, slidePart);
    for (const span of shapeSpans(xml)) {
      const region = xml.slice(span.from, span.to);
      const nv = region.match(/<p:nvPr(?:\s[^>]*)?>.*?<\/p:nvPr>/s);
      const lst = nv?.[0].match(/<p:custDataLst>(.*?)<\/p:custDataLst>/s);
      if (!lst) continue;
      for (const t of lst[1]!.matchAll(/<p:tags\s[^>]*>/g)) {
        const rel = rels.find((r) => r.id === attr(t[0], "r:id") && r.type === REL_TAGS);
        if (!rel) continue;
        const part = resolveTarget(slidePart, rel.target);
        if (!zip.has(part)) continue;
        for (const tag of strFromU8(zip.read(part)).matchAll(/<p:tag\s[^>]*>/g)) {
          const name = attr(tag[0], "name") ?? "";
          if (name.toUpperCase().startsWith("COCHECK.")) out.push({ slide: i + 1, shape: span.name, name, value: attr(tag[0], "val") ?? "" });
        }
      }
    }
  });
  return out;
}
