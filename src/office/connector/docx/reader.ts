import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { canonicalOrRaw } from "../shared/ooxml-names.ts";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  preserveOrder: true,
});

type Node = Record<string, unknown>;

/** The text of every paragraph (`w:p`) in `word/document.xml`, in document order, tables included. */
export function readDocxParagraphs(bytes: Uint8Array): string[] {
  const entry = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" })["word/document.xml"];
  if (!entry) {
    throw new Error("not a Word document: word/document.xml is missing");
  }
  const paragraphs: string[] = [];
  walk(parser.parse(canonicalOrRaw(Buffer.from(entry).toString("utf8"), "ooxml", "word/document.xml")) as Node[], paragraphs);
  return paragraphs;
}

function walk(nodes: Node[], out: string[]): void {
  for (const node of nodes) {
    for (const [tag, children] of Object.entries(node)) {
      if (tag === "w:p") {
        out.push(paragraphText(children as Node[]));
      } else if (Array.isArray(children)) {
        walk(children as Node[], out);
      }
    }
  }
}

/** Concatenates the paragraph's `w:t` runs; tabs and line breaks become their characters. */
function paragraphText(nodes: Node[]): string {
  let text = "";
  for (const node of nodes) {
    for (const [tag, children] of Object.entries(node)) {
      if (tag === "w:t") {
        for (const t of children as Node[]) {
          if (typeof t["#text"] === "string") text += t["#text"];
        }
      } else if (tag === "w:tab") {
        text += "\t";
      } else if (tag === "w:br" || tag === "w:cr") {
        text += "\n";
      } else if (Array.isArray(children)) {
        text += paragraphText(children as Node[]);
      }
    }
  }
  return text;
}

// ---- the richer reading: formatting, pictures, list markers, headers and footers ----

const attrParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  preserveOrder: true,
});

/** One picture in a paragraph: the hash of the image it shows and the size (EMU) the paragraph draws it at. */
export interface DocxPicture {
  img: string;
  cx: string;
  cy: string;
}

export interface DocxParagraph {
  /** Same text `readDocxParagraphs` gives. */
  text: string;
  /** Paragraph style, alignment, and the distinct values each run property takes over the paragraph's runs (sorted, comma-joined). */
  fmt: Record<string, string>;
  pics: DocxPicture[];
  list: { numId: string; ilvl: number } | null;
  /** The list marker as a reader counts it ("3", "c", "iv"), null for a bullet or a paragraph outside a numbered list. */
  label: string | null;
}

export interface DocxModel {
  paragraphs: DocxParagraph[];
  /** Header and footer parts by file number: `header1.xml` is part 1. Text is the part's paragraphs joined by a line break. */
  headers: Map<number, string>;
  footers: Map<number, string>;
}

const attrsOf = (node: Node): Record<string, string> => ((node[":@"] as Record<string, string> | undefined) ?? {});
const val = (node: Node, name = "w:val"): string | undefined => attrsOf(node)[`@_${name}`];
const childrenOf = (node: Node, tag: string): Node[] | undefined => (Array.isArray(node[tag]) ? (node[tag] as Node[]) : undefined);

function find(nodes: Node[], tag: string, visit: (node: Node, children: Node[]) => void): void {
  for (const node of nodes) {
    for (const [t, kids] of Object.entries(node)) {
      if (t === ":@" || !Array.isArray(kids)) continue;
      if (t === tag) visit(node, kids as Node[]);
      else find(kids as Node[], tag, visit);
    }
  }
}

const on = (n: Node | undefined): string => (n === undefined ? "off" : ["0", "false", "off", "none"].includes(val(n) ?? "") ? "off" : "on");

/** The formatting a reader can see on a paragraph; run properties are gathered over every run that holds text. */
function formatOf(paragraph: Node[]): Record<string, string> {
  const seen: Record<string, Set<string>> = { bold: new Set(), italic: new Set(), underline: new Set(), strike: new Set(), color: new Set(), size: new Set(), font: new Set(), highlight: new Set() };
  const fmt: Record<string, string> = {};
  for (const node of paragraph) {
    const pPr = childrenOf(node, "w:pPr");
    if (pPr) {
      for (const p of pPr) {
        if (p["w:pStyle"]) fmt.style = val(p) ?? "";
        if (p["w:jc"]) fmt.alignment = val(p) ?? "";
      }
    }
  }
  find(paragraph, "w:r", (_run, kids) => {
    if (!JSON.stringify(kids).match(/"w:(t|tab|br|cr)"/)) return;
    const rPr = kids.find((k) => k["w:rPr"] !== undefined);
    const props = (rPr ? (rPr["w:rPr"] as Node[]) : []) as Node[];
    const get = (tag: string): Node | undefined => props.find((p) => p[tag] !== undefined);
    seen.bold!.add(on(get("w:b")));
    seen.italic!.add(on(get("w:i")));
    const u = get("w:u");
    seen.underline!.add(u === undefined || val(u) === "none" ? "off" : "on");
    seen.strike!.add(on(get("w:strike")));
    const c = get("w:color");
    seen.color!.add(((c && val(c)) || "auto").toLowerCase() === "000000" ? "auto" : ((c && val(c)) || "auto").toLowerCase());
    const sz = get("w:sz");
    seen.size!.add((sz && val(sz)) || "");
    const f = get("w:rFonts");
    seen.font!.add((f && (val(f, "w:ascii") ?? val(f, "w:hAnsi"))) || "");
    const h = get("w:highlight");
    seen.highlight!.add((h && val(h)) || "none");
  });
  for (const [k, s] of Object.entries(seen)) if (s.size > 0) fmt[k] = [...s].sort().join(",");
  return fmt;
}

function picturesOf(paragraph: Node[], hashOfRel: (id: string) => string): DocxPicture[] {
  const out: DocxPicture[] = [];
  find(paragraph, "w:drawing", (_d, kids) => {
    let embed = "";
    let cx = "";
    let cy = "";
    find(kids, "a:blip", (blip) => {
      embed ||= attrsOf(blip)["@_r:embed"] ?? "";
    });
    find(kids, "wp:extent", (ext) => {
      if (cx === "") {
        cx = attrsOf(ext)["@_cx"] ?? "";
        cy = attrsOf(ext)["@_cy"] ?? "";
      }
    });
    if (embed !== "") out.push({ img: hashOfRel(embed), cx, cy });
  });
  return out;
}

type Level = { fmt: string; start: number };
interface Numbering {
  abstractOf: Map<string, string>;
  levels: Map<string, Map<number, Level>>;
  /** `w:startOverride` of a list instance, keyed `numId:ilvl`. */
  starts: Map<string, number>;
}

function readNumbering(xml: string | undefined): Numbering {
  const n: Numbering = { abstractOf: new Map(), levels: new Map(), starts: new Map() };
  if (xml === undefined) return n;
  find(attrParser.parse(xml) as Node[], "w:abstractNum", (abs, kids) => {
    const id = attrsOf(abs)["@_w:abstractNumId"];
    if (id === undefined) return;
    const lv = new Map<number, Level>();
    find(kids, "w:lvl", (lvl, lk) => {
      const il = Number(attrsOf(lvl)["@_w:ilvl"]);
      const fmt = lk.find((k) => k["w:numFmt"] !== undefined);
      const start = lk.find((k) => k["w:start"] !== undefined);
      lv.set(il, { fmt: (fmt && val(fmt)) || "decimal", start: Number((start && val(start)) ?? 1) });
    });
    n.levels.set(id, lv);
  });
  find(attrParser.parse(xml) as Node[], "w:num", (num, kids) => {
    const id = attrsOf(num)["@_w:numId"];
    const abs = kids.find((k) => k["w:abstractNumId"] !== undefined);
    if (id !== undefined && abs) n.abstractOf.set(id, val(abs) ?? "");
    for (const k of kids) {
      if (id === undefined || k["w:lvlOverride"] === undefined) continue;
      const start = (k["w:lvlOverride"] as Node[]).find((o) => o["w:startOverride"] !== undefined);
      if (start) n.starts.set(`${id}:${attrsOf(k)["@_w:ilvl"] ?? 0}`, Number(val(start)));
    }
  });
  return n;
}

const letters = (k: number, base: number): string => {
  let s = "";
  for (let v = k; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(base + ((v - 1) % 26)) + s;
  return s;
};
const roman = (k: number): string => {
  let s = "";
  let v = k;
  for (const [n, r] of [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]] as Array<[number, string]>) {
    while (v >= n) {
      s += r;
      v -= n;
    }
  }
  return s;
};
const markerOf = (fmt: string, k: number): string | null => {
  switch (fmt) {
    case "decimal":
    case "decimalZero":
      return String(k);
    case "lowerLetter":
      return letters(k, 97);
    case "upperLetter":
      return letters(k, 65);
    case "lowerRoman":
      return roman(k);
    case "upperRoman":
      return roman(k).toUpperCase();
    default:
      return null;
  }
};

/** Fills in each list paragraph's marker, counting per list and level; a deeper level restarts when a shallower one advances. */
function numberParagraphs(paragraphs: DocxParagraph[], numbering: Numbering): void {
  const counts = new Map<string, number[]>();
  for (const p of paragraphs) {
    if (p.list === null) continue;
    const { numId, ilvl } = p.list;
    const level = numbering.levels.get(numbering.abstractOf.get(numId) ?? "")?.get(ilvl) ?? { fmt: "decimal", start: 1 };
    const c = counts.get(numId) ?? [];
    c[ilvl] = (c[ilvl] ?? (numbering.starts.get(`${numId}:${ilvl}`) ?? level.start) - 1) + 1;
    c.length = ilvl + 1;
    counts.set(numId, c);
    p.label = markerOf(level.fmt, c[ilvl]!);
  }
}

function partParagraphs(xml: string): string {
  const out: string[] = [];
  walk(parser.parse(xml) as Node[], out);
  return out.join("\n");
}

/** A Word file read for what a card can say. Throws on a file with no `word/document.xml`, as `readDocxParagraphs` does. */
export function readDocxModel(bytes: Uint8Array): DocxModel {
  const parts = unzipSync(bytes, { filter: (f) => /^word\/(document\.xml|numbering\.xml|(header|footer)\d*\.xml|_rels\/document\.xml\.rels|media\/.*)$/.test(f.name) });
  const doc = parts["word/document.xml"];
  if (!doc) throw new Error("not a Word document: word/document.xml is missing");
  const utf8 = (name: string): string | undefined => (parts[name] ? canonicalOrRaw(Buffer.from(parts[name]!).toString("utf8"), "ooxml", name) : undefined);
  const targets = new Map<string, string>();
  for (const tag of utf8("word/_rels/document.xml.rels")?.match(/<Relationship\s[^>]*>/g) ?? []) {
    const id = /\sId="([^"]*)"/.exec(tag)?.[1];
    const target = /\sTarget="([^"]*)"/.exec(tag)?.[1];
    if (id !== undefined && target !== undefined) targets.set(id, target.startsWith("/") ? target.slice(1) : `word/${target}`);
  }
  const hashOfRel = (id: string): string => {
    const t = targets.get(id);
    const bytesOf = t === undefined ? undefined : parts[t];
    return bytesOf ? createHash("sha256").update(bytesOf).digest("hex") : `rel:${t ?? id}`;
  };
  const paragraphs: DocxParagraph[] = [];
  find(attrParser.parse(utf8("word/document.xml")!) as Node[], "w:document", (_d, body) => collect(body, paragraphs, hashOfRel));
  numberParagraphs(paragraphs, readNumbering(utf8("word/numbering.xml")));
  const headers = new Map<number, string>();
  const footers = new Map<number, string>();
  for (const name of Object.keys(parts)) {
    const m = /^word\/(header|footer)(\d*)\.xml$/.exec(name);
    if (m) (m[1] === "header" ? headers : footers).set(Number(m[2] || 1), partParagraphs(utf8(name)!));
  }
  return { paragraphs, headers, footers };
}

function collect(nodes: Node[], out: DocxParagraph[], hashOfRel: (id: string) => string): void {
  for (const node of nodes) {
    for (const [tag, children] of Object.entries(node)) {
      if (tag === ":@" || !Array.isArray(children)) continue;
      if (tag === "w:p") {
        const kids = children as Node[];
        let list: DocxParagraph["list"] = null;
        const pPr = kids.find((k) => k["w:pPr"] !== undefined);
        if (pPr) {
          find(pPr["w:pPr"] as Node[], "w:numPr", (_n, nk) => {
            const id = nk.find((k) => k["w:numId"] !== undefined);
            const lv = nk.find((k) => k["w:ilvl"] !== undefined);
            const numId = id && val(id);
            if (numId !== undefined && numId !== "0") list = { numId, ilvl: Number((lv && val(lv)) ?? 0) };
          });
        }
        out.push({ text: paragraphText(kids), fmt: formatOf(kids), pics: picturesOf(kids, hashOfRel), list, label: null });
      } else {
        collect(children as Node[], out, hashOfRel);
      }
    }
  }
}
