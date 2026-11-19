import { XMLParser } from "fast-xml-parser";

/**
 * A small element tree over fast-xml-parser's ordered output. Tag and attribute names are matched
 * by local name (`p:sp` is `sp`), so a deck written with other namespace prefixes reads the same;
 * the one prefix that matters, `r:` on relationship ids, is told apart from a plain `id` by `relId`.
 */
export interface El {
  /** Local name, prefix stripped. */
  name: string;
  /** Raw attribute names (prefix kept) to values. */
  attrs: Record<string, string>;
  children: El[];
  /** Direct text content, concatenated. */
  text: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  preserveOrder: true,
  processEntities: true,
});

type Node = Record<string, unknown>;

const local = (tag: string): string => tag.slice(tag.indexOf(":") + 1);

function build(nodes: Node[]): El[] {
  const out: El[] = [];
  for (const node of nodes) {
    for (const [tag, value] of Object.entries(node)) {
      if (tag === ":@" || tag.startsWith("?") || tag === "#comment") continue;
      if (tag === "#text") {
        continue;
      }
      const kids = Array.isArray(value) ? (value as Node[]) : [];
      const el: El = { name: local(tag), attrs: (node[":@"] as Record<string, string> | undefined) ?? {}, children: build(kids), text: "" };
      for (const k of kids) {
        if (typeof k["#text"] === "string") el.text += k["#text"];
      }
      out.push(el);
    }
  }
  return out;
}

const NUMERIC_REF = /&#(?:(\d+)|x([0-9a-fA-F]+));/g;
const MARKUP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/**
 * Numeric character references (`&#8211;`, `&#x26;`) are decoded up front, in one pass, so escaped
 * and literal text read the same. The five markup characters stay escaped (`&#x26;` is `&amp;`, which
 * the parser then reads as `&`); references to control characters XML forbids are left as written.
 */
function decodeNumericRefs(xml: string): string {
  return xml.replace(NUMERIC_REF, (ref, dec: string | undefined, hex: string | undefined) => {
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    const ok = (cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) || cp === 9 || cp === 10 || cp === 13;
    if (!ok) return ref;
    const ch = String.fromCodePoint(cp);
    return MARKUP[ch] ?? ch;
  });
}

/** The root element of an XML document. */
export function parseXml(xml: string): El {
  const roots = build(parser.parse(decodeNumericRefs(xml)) as Node[]);
  if (roots.length === 0) {
    throw new Error("empty XML document");
  }
  return roots[0]!;
}

/** First direct child named `name`. */
export function child(el: El, name: string): El | undefined {
  return el.children.find((c) => c.name === name);
}

/** Every descendant named `name`, document order, not descending into a match. */
export function descendants(el: El, name: string, out: El[] = []): El[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    else descendants(c, name, out);
  }
  return out;
}

/** First descendant named `name` (depth-first, document order). */
export function find(el: El, name: string): El | undefined {
  for (const c of el.children) {
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** A relationship-id attribute (`r:id`, `r:embed`, `r:link`...): the first attribute with a prefix other than xmlns. */
export function relAttr(el: El, local_: string): string | undefined {
  for (const [k, v] of Object.entries(el.attrs)) {
    if (k.includes(":") && !k.startsWith("xmlns") && local(k) === local_) return v;
  }
  return undefined;
}


/** Every element in the subtree (the element itself included), document order. */
export function walk(el: El, out: El[] = []): El[] {
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}
