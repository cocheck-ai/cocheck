/**
 * Office XML read by what its names mean, not by how a writer spelled them.
 *
 * Elements and attributes are identified by namespace URI and local name. For `canonicalXml` that means these spelling choices do not change the
 * canonical text: the prefix of a modelled namespace (`x:`, `ns0:`, none) and the declaration of it (renamed along with the names), the quote
 * style and spacing around `=` inside tags, a BOM, and strict versus transitional URIs for the same namespace. For `startTags` the same names are
 * resolved by URI at read time and nothing is rewritten.
 *
 * NOT normalised, so two spellings of one part can still give two different canonical texts (and so different hashes in package-media and the
 * chart sha), exactly as before this layer existed: where a declaration sits (a declaration repeated on a child instead of the root), unused
 * declarations, declaration order, attribute order, `<a/>` versus `<a></a>`, ` />` versus `/>`, whitespace between tags, a single-quoted XML
 * declaration, the prefix of an unmodelled namespace (c14, c16, wp14, ...), and the values of `mc:Ignorable`, `mc:Requires`, `mc:ProcessContent`
 * and `mc:PreserveAttributes`, which name prefixes. Two contrived parts can therefore canonicalise to the same text (swapped prefixes with
 * `mc:Ignorable` unchanged; two prefixes that both collide with modelled ones).
 *
 * Two ways in, both built on the same namespace scopes:
 *  - `canonicalXml` rewrites a part so every name in a namespace the readers model is spelled the way they look it up, then the existing
 *    pattern and parser readers run unchanged on the result. For reading.
 *  - `startTags` lists the start tags of a part with their namespaces and the byte span of each attribute value, and `withAttribute` edits
 *    one value in place. `spellingBefore` says which prefix (or the default namespace) is in scope for a namespace at a point. For rewriting
 *    a part byte-conservatively: nothing outside the edited value, or the one element inserted, moves.
 */

export const MAIN_NS = new Set(["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"]);
export const PKG_REL_NS = new Set(["http://schemas.openxmlformats.org/package/2006/relationships"]);
export const DOC_REL_NS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
/** Excel's revision namespace (`xr:revisionPtr`, `xr:uid`, ...). */
export const XR_NS = "http://schemas.microsoft.com/office/spreadsheetml/2014/revision";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/**
 * The namespaces the readers model, each with the prefix the readers look it up by ("" for none). SpreadsheetML's main namespace and the package
 * relationships and content types are looked up unprefixed; the rest by the prefix every Office writer uses.
 */
const CONVENTIONAL: ReadonlyMap<string, string> = new Map<string, string>([
  ...[...MAIN_NS, ...PKG_REL_NS, "http://schemas.openxmlformats.org/package/2006/content-types"].map((u): [string, string] => [u, ""]),
  ...[...DOC_REL_NS].map((u): [string, string] => [u, "r"]),
  ...(
    [
      ["w", "wordprocessingml/2006/main", "wordprocessingml/main"],
      ["p", "presentationml/2006/main", "presentationml/main"],
      ["a", "drawingml/2006/main", "drawingml/main"],
      ["c", "drawingml/2006/chart", "drawingml/chart"],
      ["xdr", "drawingml/2006/spreadsheetDrawing", "drawingml/spreadsheetDrawing"],
      ["wp", "drawingml/2006/wordprocessingDrawing", "drawingml/wordprocessingDrawing"],
      ["pic", "drawingml/2006/picture", "drawingml/picture"],
    ] as const
  ).flatMap(([prefix, transitional, strict]): Array<[string, string]> => [
    [`http://schemas.openxmlformats.org/${transitional}`, prefix],
    [`http://purl.oclc.org/ooxml/${strict}`, prefix],
  ]),
  ["http://schemas.openxmlformats.org/markup-compatibility/2006", "mc"],
  [XR_NS, "xr"],
  ["http://schemas.microsoft.com/office/word/2010/wordml", "w14"],
  ["http://schemas.microsoft.com/office/word/2012/wordml", "w15"],
  ["http://schemas.microsoft.com/office/word/2018/wordml", "w16"],
  ["http://schemas.microsoft.com/office/word/2016/wordml/cid", "w16cid"],
]);

/**
 * What a part is read as. `main` and `pkgrel` look up only SpreadsheetML's main namespace or the package relationships unprefixed; a name in any
 * other namespace becomes `foreign:<local>`. `ooxml` gives every modelled namespace the prefix the readers look it up by, whatever the part
 * is (Word, PowerPoint, drawings, charts, themes, SpreadsheetML), and leaves a name in any other namespace as the writer spelled it unless the part also declares a modelled namespace the readers spell with that same prefix (then `foreign:`).
 */
export type PartKind = "main" | "pkgrel" | "ooxml";

const XMLNS_DECL = /\sxmlns(?::([^\s=]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const MARKUP = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([^\s=]+)(\s*=\s*)("[^"]*"|'[^']*')/g;
/** A tag holding an attribute not written `name="value"`: single-quoted, or space around `=`. Text between tags, processing instructions (`<?xml version='1.0'?>`) and the inside of an attribute value are not looked at. */
const ODD_ATTRIBUTE = /<(?![?!])(?:[^<>"']|"[^"]*"|'[^']*')*?(?:='|=\s|\s=)/;

/** The namespace bindings in scope while walking a part's tags. */
class Scopes {
  readonly #stack: Map<string, string>[] = [];
  push(rest: string): void {
    const scope = new Map<string, string>();
    // declarations are attributes: read from the tag's attribute tokens, never from text inside an attribute's value
    for (const a of rest.matchAll(ATTRIBUTE)) {
      if (a[1] === "xmlns") scope.set("", a[3]!.slice(1, -1));
      else if (a[1]!.startsWith("xmlns:")) scope.set(a[1]!.slice(6), a[3]!.slice(1, -1));
    }
    this.#stack.push(scope);
  }
  pop(): boolean {
    return this.#stack.pop() !== undefined;
  }
  /** A prefix ("" for the default namespace) bound, as the innermost binding of that prefix, to one of `uris`; undefined when none is. */
  spellingOf(uris: ReadonlySet<string>): string | undefined {
    for (let i = this.#stack.length - 1; i >= 0; i--) {
      for (const prefix of this.#stack[i]!.keys()) {
        const uri = this.resolve(prefix);
        if (uri !== undefined && uris.has(uri)) return prefix;
      }
    }
    return undefined;
  }
  /** The URI bound to `prefix` ("" for the default namespace), or undefined when none is. */
  resolve(prefix: string): string | undefined {
    if (prefix === "xml") return XML_NS;
    for (let i = this.#stack.length - 1; i >= 0; i--) {
      const uri = this.#stack[i]!.get(prefix);
      if (uri !== undefined) return uri;
    }
    return undefined;
  }
}

const undeclared = (part: string, prefix: string): Error => new Error(`xml: ${part} is malformed (prefix "${prefix}" is not declared)`);
const split = (name: string): { prefix: string; local: string } => {
  const colon = name.indexOf(":");
  return colon < 0 ? { prefix: "", local: name } : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
};

/**
 * The prefixes ("" for the default namespace) that the part binds to an unmodelled namespace while the readers' spelling of some modelled namespace the part also declares
 * uses the same prefix: `xmlns:ns0="<wordml>" xmlns:w="urn:evil"` has `w` that way. Names under them are quarantined as `foreign:`; an unmodelled namespace that
 * borrows a conventional prefix in a part with no modelled namespace of its own (customXml's `p:`) is left as written. Conservative: declarations are found in raw text.
 */
function collisionsOf(text: string): Set<string> {
  const used = new Set<string>(), unmodelled = new Set<string>();
  for (const m of text.matchAll(XMLNS_DECL)) {
    const conventional = CONVENTIONAL.get(m[2] ?? m[3] ?? "");
    if (conventional !== undefined) used.add(conventional);
    else unmodelled.add(m[1] ?? "");
  }
  return new Set([...unmodelled].filter((p) => used.has(p)));
}

/** True when the part already spells every name the way `kind` looks it up, so it can be used as it is. */
function namesAreLiteral(text: string, kind: PartKind): boolean {
  if (ODD_ATTRIBUTE.test(text)) return false;
  const root = /<(?![?!])([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(text);
  if (!root) return false;
  const rootPrefix = split(root[1]!).prefix;
  if (kind === "ooxml") {
    const bound = new Map<string, string>();
    for (const m of text.matchAll(XMLNS_DECL)) {
      const prefix = m[1] ?? "", uri = m[2] ?? m[3] ?? "";
      const known = CONVENTIONAL.get(uri);
      if (bound.get(prefix) !== undefined && bound.get(prefix) !== uri) return false;
      bound.set(prefix, uri);
      if (known !== undefined && prefix !== known) return false;
    }
    return collisionsOf(text).size === 0 && (rootPrefix === "" || bound.has(rootPrefix));
  }
  if (rootPrefix !== "") return false;
  const expected = kind === "main" ? MAIN_NS : PKG_REL_NS;
  let defaults = 0;
  for (const m of text.matchAll(XMLNS_DECL)) {
    const uri = m[2] ?? m[3] ?? "";
    if (m[1] === undefined) {
      if (!expected.has(uri)) return false;
      defaults++;
    } else if (expected.has(uri) || (DOC_REL_NS.has(uri) ? m[1] !== "r" : m[1] === "r")) {
      return false;
    }
  }
  // the one default declaration has to be the root's own, or it would change meaning part-way down
  return defaults === 0 || [...root[2]!.matchAll(XMLNS_DECL)].filter((m) => m[1] === undefined).length === defaults;
}

/** The prefix a reader of `kind` gives a declared namespace ("" for the default), or undefined when the declaration is left as written. */
function declaredAs(kind: PartKind, uri: string): string | undefined {
  if (DOC_REL_NS.has(uri)) return "r";
  if (kind === "ooxml") return CONVENTIONAL.get(uri);
  return (kind === "main" ? MAIN_NS : PKG_REL_NS).has(uri) ? "" : undefined;
}

/** The name a reader of `kind` looks an element up by. */
function elementName(kind: PartKind, uri: string | undefined, prefix: string, local: string, collisions: Set<string>): string {
  if (kind !== "ooxml") return uri === undefined || (kind === "main" ? MAIN_NS : PKG_REL_NS).has(uri) ? local : `foreign:${local}`;
  if (uri === undefined) return local;
  const conventional = CONVENTIONAL.get(uri);
  if (conventional === undefined) return collisions.has(prefix) ? `foreign:${local}` : prefix === "" ? local : `${prefix}:${local}`;
  return conventional === "" ? local : `${conventional}:${local}`;
}

/** The name a reader of `kind` looks a namespaced attribute up by (an attribute with no prefix is in no namespace and is never renamed). */
function attributeName(kind: PartKind, uri: string, prefix: string, local: string, collisions: Set<string>): string {
  if (DOC_REL_NS.has(uri)) return `r:${local}`;
  if (kind !== "ooxml") return `foreign:${local}`;
  const conventional = CONVENTIONAL.get(uri);
  if (conventional === undefined) return collisions.has(prefix) ? `foreign:${local}` : `${prefix}:${local}`;
  return conventional === "" ? `foreign:${local}` : `${conventional}:${local}`;
}

/**
 * The part's XML with every name in a namespace the readers model written the way they look it up (see `PartKind`), and every attribute
 * written `name="value"`. Throws when the part is not well-formed enough to resolve (a prefix with no declaration, a closing tag with nothing
 * open, a part cut off).
 */
export function canonicalXml(source: string, kind: PartKind, part: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (namesAreLiteral(text, kind)) return text;
  const scopes = new Scopes();
  const collisions = kind === "ooxml" ? collisionsOf(text) : new Set<string>();
  const open: string[] = [];
  let sawRoot = false;
  const out = text.replace(MARKUP, (whole, slash: string | undefined, name: string | undefined, rest: string | undefined) => {
    if (name === undefined) return whole;
    const { prefix, local } = split(name);
    if (slash) {
      const canonical = open.pop();
      scopes.pop();
      if (canonical === undefined) throw new Error(`xml: ${part} is malformed (closing </${name}> with nothing open)`);
      return `</${canonical}>`;
    }
    sawRoot = true;
    scopes.push(rest!);
    const uri = scopes.resolve(prefix);
    if (prefix !== "" && uri === undefined) throw undeclared(part, prefix);
    const canonical = elementName(kind, uri, prefix, local, collisions);
    const attributes = rest!.replace(ATTRIBUTE, (_attr, attrName: string, _eq: string, value: string) => {
      const quoted = value.startsWith("'") ? `"${value.slice(1, -1).replace(/"/g, "&quot;")}"` : value;
      if (attrName === "xmlns" || attrName.startsWith("xmlns:")) {
        // a declaration of a modelled namespace is spelled as the names are, so two spellings of one part are one text
        const as = declaredAs(kind, value.slice(1, -1));
        return as === undefined ? `${attrName}=${quoted}` : `${as === "" ? "xmlns" : `xmlns:${as}`}=${quoted}`;
      }
      const c = attrName.indexOf(":");
      if (c < 0) return `${attrName}=${quoted}`;
      const attrPrefix = attrName.slice(0, c);
      const attrUri = scopes.resolve(attrPrefix);
      if (attrUri === undefined) throw undeclared(part, attrPrefix);
      return `${attrUri === XML_NS ? attrName : attributeName(kind, attrUri, attrPrefix, attrName.slice(c + 1), collisions)}=${quoted}`;
    });
    if (/\/\s*$/.test(rest!)) {
      scopes.pop();
      return `<${canonical}${attributes}>`;
    }
    open.push(canonical);
    return `<${canonical}${attributes}>`;
  });
  if (!sawRoot || open.length > 0) throw new Error(`xml: ${part} is malformed (cut off)`);
  return out;
}

/** `canonicalXml`, or the text as written when the part cannot be resolved: for readers that never throw on a part they cannot make sense of. */
export function canonicalOrRaw(text: string, kind: PartKind, part: string): string {
  try {
    return canonicalXml(text, kind, part);
  } catch {
    return text;
  }
}

/** One attribute of a start tag, with where its value sits so it can be replaced without touching anything around it. */
export interface StartAttribute {
  local: string;
  /** The namespace the attribute is in; undefined for an unprefixed attribute, which is in none. */
  uri: string | undefined;
  /** The value as written (entities not decoded). */
  value: string;
  /** Offsets of the value inside `StartTag.text`, quotes excluded. */
  valueStart: number;
  valueEnd: number;
}

export interface StartTag {
  /** Offset of the tag's `<` in the part. */
  index: number;
  /** The tag as written. */
  text: string;
  /** The element's name as written, prefix included. */
  qname: string;
  local: string;
  /** The namespace the element is in; undefined when it is in none. */
  uri: string | undefined;
  attributes: StartAttribute[];
  /** Number of elements open around this one: 0 for the root. */
  depth: number;
}

/** The value of the unprefixed attribute `local`, as written. */
export function attributeOf(tag: StartTag, local: string): string | undefined {
  return tag.attributes.find((a) => a.uri === undefined && a.local === local)?.value;
}

/** The value of attribute `local` in the officeDocument relationships namespace (`r:id`, whatever prefix is bound to it), as written. */
export function relationshipAttributeOf(tag: StartTag, local: string): string | undefined {
  return tag.attributes.find((a) => a.uri !== undefined && DOC_REL_NS.has(a.uri) && a.local === local)?.value;
}

/** The start tags of the part, in document order, with namespaces resolved, produced as they are asked for (a reader that stops early reads no further). Throws like `canonicalXml` when a prefix is not declared. */
export function* startTags(text: string, part: string): Generator<StartTag> {
  const scopes = new Scopes();
  let depth = 0;
  for (const m of text.matchAll(MARKUP)) {
    const [whole, slash, name, rest] = m;
    if (name === undefined) continue;
    if (slash) {
      scopes.pop();
      depth--;
      continue;
    }
    scopes.push(rest!);
    const { prefix, local } = split(name);
    const uri = scopes.resolve(prefix);
    if (prefix !== "" && uri === undefined) throw undeclared(part, prefix);
    const restAt = 1 + name.length;
    const attributes: StartAttribute[] = [];
    for (const a of rest!.matchAll(ATTRIBUTE)) {
      if (a[1] === "xmlns" || a[1]!.startsWith("xmlns:")) continue;
      const attr = split(a[1]!);
      const attrUri = attr.prefix === "" ? undefined : scopes.resolve(attr.prefix);
      if (attr.prefix !== "" && attrUri === undefined) throw undeclared(part, attr.prefix);
      const end = restAt + a.index! + a[0].length;
      attributes.push({ local: attr.local, uri: attrUri, value: a[3]!.slice(1, -1), valueStart: end - a[3]!.length + 1, valueEnd: end - 1 });
    }
    const tag: StartTag = { index: m.index!, text: whole, qname: name, local, uri, attributes, depth };
    if (/\/\s*$/.test(rest!)) scopes.pop();
    else depth++;
    yield tag;
  }
}

/** Whether the start tag is element `local` of SpreadsheetML's main namespace (transitional or strict). An element in no namespace is not. */
export const isMain = (tag: StartTag, local: string): boolean => tag.local === local && tag.uri !== undefined && MAIN_NS.has(tag.uri);

/**
 * The element prefix to write (with its colon; "" for the default namespace) for a new element in one of `uris` placed just before the tag at `index`, taken from what
 * the tag's ancestors have in scope there. A declaration on the tag at `index` itself does not count, since the new element comes before it. Undefined when the ancestors
 * give no spelling for those namespaces.
 */
export function spellingBefore(text: string, part: string, index: number, uris: ReadonlySet<string>): string | undefined {
  const scopes = new Scopes();
  for (const m of text.matchAll(MARKUP)) {
    const [, slash, name, rest] = m;
    if (name === undefined) continue;
    if (m.index === index) {
      const prefix = scopes.spellingOf(uris);
      return prefix === undefined ? undefined : prefix === "" ? "" : `${prefix}:`;
    }
    if (slash) {
      scopes.pop();
      continue;
    }
    scopes.push(rest!);
    const { prefix } = split(name);
    if (prefix !== "" && scopes.resolve(prefix) === undefined) throw undeclared(part, prefix);
    if (/\/\s*$/.test(rest!)) scopes.pop();
  }
  return undefined;
}
/** Whether the start tag is element `local` of the package relationships namespace (an element in no namespace counts). */
export const isPackageRel = (tag: StartTag, local: string): boolean => tag.local === local && (tag.uri === undefined || PKG_REL_NS.has(tag.uri));

/**
 * The tag's text with the unprefixed attribute `local` set to `value`: the value replaced where it sits (its quotes kept), or the attribute
 * added right after the element name. Nothing else in the tag changes.
 */
export function withAttribute(tag: StartTag, local: string, value: string): string {
  const found = tag.attributes.find((a) => a.uri === undefined && a.local === local);
  if (found) return tag.text.slice(0, found.valueStart) + value + tag.text.slice(found.valueEnd);
  const at = 1 + tag.qname.length;
  return `${tag.text.slice(0, at)} ${local}="${value}"${tag.text.slice(at)}`;
}
