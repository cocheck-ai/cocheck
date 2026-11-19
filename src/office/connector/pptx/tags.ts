import { strFromU8 } from "fflate";
import { parseXml, relAttr, type El } from "./xml.ts";
import { type Span, parseSpans, kid } from "./spans.ts";
import { Zip } from "./zip.ts";

/**
 * Shape tags (spec 6.6): a shape carries `p:nvPr/p:custDataLst/p:tags r:id=...`; the id names a slide
 * relationship of the tags type, which targets `/ppt/tags/tagN.xml` holding `<p:tag name val/>`.
 * proved PowerPoint keeps these across saves. Reads go through the XML parser (PowerPoint writes a bare
 * `>` inside an attribute, which a regex reader mishandles). Read only: the writer went with the deck tools.
 */

const REL_TAGS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tags";

const dirOf = (part: string): string => part.slice(0, part.lastIndexOf("/") + 1);
const relsPart = (part: string): string => `${dirOf(part)}_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`;

function resolveTarget(source: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1); // kept: an OOXML package part name, not a file path
  const out: string[] = [];
  for (const seg of `${dirOf(source)}${target}`.split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out.join("/");
}

interface Rel {
  id: string;
  type: string;
  target: string;
}

function readRels(zip: Zip, part: string): Rel[] {
  const name = relsPart(part);
  if (!zip.has(name)) return [];
  return parseXml(strFromU8(zip.read(name)))
    .children.filter((c) => c.name === "Relationship")
    .map((c) => ({ id: c.attrs["Id"] ?? "", type: c.attrs["Type"] ?? "", target: c.attrs["Target"] ?? "" }));
}

/** The slide part of slide `n` (1-based), in presentation order. */
function slidePartOf(zip: Zip, n: number): string {
  const pres = parseXml(strFromU8(zip.read("ppt/presentation.xml")));
  const list = pres.children.find((c) => c.name === "sldIdLst");
  const entry = list?.children.filter((c) => c.name === "sldId")[n - 1];
  if (!entry) throw new Error(`slide ${n} does not exist`);
  const rel = readRels(zip, "ppt/presentation.xml").find((r) => r.id === relAttr(entry, "id"));
  if (!rel) throw new Error(`slide ${n} has no relationship`);
  return resolveTarget("ppt/presentation.xml", rel.target);
}

/** Tags of a tag part, in order: the parser decodes every attribute entity. */
export function parseTagPart(xml: string): { name: string; value: string }[] {
  const root: El = parseXml(xml);
  return root.children.filter((c) => c.name === "tag").map((c) => ({ name: c.attrs["name"] ?? "", value: c.attrs["val"] ?? "" }));
}

/** The `nv*Pr` wrapper of the shape with `cNvPr id` `shapeId` (first one in document order). */
function wrapperOf(el: Span, shapeId: string): Span | undefined {
  for (const c of el.children) {
    if (/^nv.*Pr$/.test(c.name) && kid(c, "cNvPr")?.attrs["id"] === shapeId) return c;
    const hit = wrapperOf(c, shapeId);
    if (hit) return hit;
  }
  return undefined;
}

const tagRefIds = (lst: Span): string[] =>
  lst.children.filter((c) => c.name === "tags").map((c) => Object.entries(c.attrs).find(([k]) => k === "r:id" || k.endsWith(":id"))?.[1] ?? "");

/** The tags of the tag part holding `name` for shape `shapeId` of slide `slide`, if any. */
function holderTags(zip: Zip, slide: number, shapeId: string, name: string): { name: string; value: string }[] | undefined {
  const part = slidePartOf(zip, slide);
  const wrapper = wrapperOf(parseSpans(strFromU8(zip.read(part))), shapeId);
  if (!wrapper) throw new Error(`slide ${slide} has no shape with id ${shapeId}`);
  const nvPr = kid(wrapper, "nvPr");
  const lst = nvPr && kid(nvPr, "custDataLst");
  const rels = readRels(zip, part);
  for (const id of lst ? tagRefIds(lst) : []) {
    const rel = rels.find((r) => r.id === id && r.type === REL_TAGS);
    const target = rel && resolveTarget(part, rel.target);
    if (!target || !zip.has(target)) continue;
    const tags = parseTagPart(strFromU8(zip.read(target)));
    if (tags.some((t) => t.name === name)) return tags;
  }
  return undefined;
}

/** The value of tag `name` on shape `shapeId` of slide `slide`, if it carries one. */
export function readShapeTag(bytes: Uint8Array, slide: number, shapeId: string, name: string): string | undefined {
  return holderTags(new Zip(bytes), slide, shapeId, name)?.find((t) => t.name === name)?.value;
}
