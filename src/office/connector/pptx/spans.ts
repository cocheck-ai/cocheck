/**
 * An element tree that remembers where each element sits in the source text. Read only since the deck
 * tools went: `readShapeTag` walks a slide with it. Nothing here ever writes XML out.
 */
export interface Span {
  /** Qualified name as written (`a:t`). */
  qname: string;
  /** Local name, prefix stripped. */
  name: string;
  /** Attributes by name as written, entity references decoded. */
  attrs: Record<string, string>;
  /** Offset of the `<` of the open tag. */
  start: number;
  /** Offset just past the `>` of the open tag. */
  openEnd: number;
  /** Offset of the `<` of the close tag; equals `openEnd` when the element is self-closing. */
  closeStart: number;
  /** Offset just past the element. */
  end: number;
  selfClosing: boolean;
  children: Span[];
}

const TAG = /<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (_m, dec: string | undefined, hex: string | undefined, named: string | undefined) =>
    named ? NAMED[named]! : String.fromCodePoint(dec !== undefined ? Number(dec) : parseInt(hex!, 16)),
  );
}

const localName = (q: string): string => q.slice(q.indexOf(":") + 1);

/** The root element of `xml`; throws on anything that is not well-nested markup. */
export function parseSpans(xml: string): Span {
  const stack: Span[] = [];
  let root: Span | undefined;
  let pos = 0;
  for (;;) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) break;
    const skip = (open: string, close: string): boolean => {
      if (!xml.startsWith(open, lt)) return false;
      const e = xml.indexOf(close, lt + open.length);
      if (e < 0) throw new Error(`malformed XML: unterminated ${open} at ${lt}`);
      pos = e + close.length;
      return true;
    };
    if (skip("<!--", "-->") || skip("<![CDATA[", "]]>") || skip("<?", "?>")) continue;
    if (xml.startsWith("<!", lt)) {
      if (/^<!DOCTYPE[^>]*\[/.test(xml.slice(lt, lt + 200))) throw new Error("malformed XML: DOCTYPE with an internal subset");
      pos = xml.indexOf(">", lt) + 1;
      if (pos === 0) throw new Error(`malformed XML: unterminated declaration at ${lt}`);
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(xml);
    if (!m) throw new Error(`malformed XML: bad tag at ${lt}`);
    pos = TAG.lastIndex;
    const [, closing, qname, attrText, selfClose] = m as unknown as [string, string, string, string, string];
    if (closing) {
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new Error(`malformed XML: </${qname}> at ${lt} does not close ${top?.qname ?? "anything"}`);
      top.closeStart = lt;
      top.end = pos;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(ATTR)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
    const span: Span = { qname, name: localName(qname), attrs, start: lt, openEnd: pos, closeStart: pos, end: pos, selfClosing: selfClose === "/", children: [] };
    const parent = stack.at(-1);
    if (parent) parent.children.push(span);
    else if (!root) root = span;
    if (!span.selfClosing) stack.push(span);
  }
  if (!root) throw new Error("malformed XML: no root element");
  if (stack.length > 0) throw new Error(`malformed XML: ${stack.at(-1)!.qname} is never closed`);
  return root;
}

/** First direct child named `name`. */
export const kid = (s: Span, name: string): Span | undefined => s.children.find((c) => c.name === name);
