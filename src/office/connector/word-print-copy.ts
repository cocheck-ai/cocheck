// The copy of a document that Word prints from: the same package with its comments taken out. Word prints comments in a side pane that shrinks every
// page, and no setting that the print call controls turns the pane off (observed with Word's print). Removed: the comments part and its extended, ids and extensible
// companions (and any .rels file of theirs), the relationships and content-type entries that name them, and every commentRangeStart, commentRangeEnd and
// commentReference element in the other parts. Tracked changes (w:ins, w:del) are not touched. Pure: bytes in, bytes out, in memory; the parts are edited
// textually, so nothing else in them moves. The change list never reads this copy: it is read from the file the agent wrote.
// Null (the caller sends the plain copy and makes no claim) when the file has no comments, and when anything is unexpected: not a readable zip, a part that is
// not UTF-8, an element to cut that is not self-closing, XML that does not parse, or a result the whole-package check refuses.
import { unzipSync, zipSync, type Zippable } from "fflate";
import { inflateAll, PRINT_COPY_CAP_BYTES, withinCap, type PrintCopyOptions } from "./print-copy-cap.ts";
import { attributeOf, startTags } from "./shared/ooxml-names.ts";

const CONTENT_TYPES = "[Content_Types].xml";
const dec = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const enc = new TextEncoder();
const WORD_NS = /^http:\/\/(?:schemas\.openxmlformats\.org\/wordprocessingml\/2006|purl\.oclc\.org\/ooxml\/wordprocessingml)\/main$/;
const COMMENT_CT = /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.comments(?:Extended|Ids|Extensible)?\+xml$/;
const COMMENT_REL = new Set(["comments", "commentsExtended", "commentsIds", "commentsExtensible"]);
const ANCHORS = new Set(["commentRangeStart", "commentRangeEnd", "commentReference"]);
const ANCHOR_HINT = /comment(?:RangeStart|RangeEnd|Reference)/;
const selfClosing = (t: string): boolean => /\/\s*>$/.test(t);
const unescapeXml = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e]!);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The part a relationship in `relsName` points at (internal targets only), as a package path. */
function target(relsName: string, value: string): string {
  const source = relsName.replace(/(^|\/)_rels\/[^/]*$/, "$1");
  const parts = (value.startsWith("/") ? value.slice(1) : `${source}${value}`).split("/");
  const out: string[] = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); }
  return out.join("/");
}
const ownRels = (part: string): string => part.replace(/([^/]*)$/, "_rels/$1.rels");
const isXml = (n: string): boolean => /\.(?:xml|rels)$/i.test(n) || n === CONTENT_TYPES;
const relationships = (name: string, xml: string): { tag: string; index: number; type: string; to: string | null }[] => {
  const out: { tag: string; index: number; type: string; to: string | null }[] = [];
  for (const t of startTags(xml, name)) {
    if (t.local !== "Relationship") continue;
    const ty = unescapeXml(attributeOf(t, "Type") ?? "");
    const to = attributeOf(t, "TargetMode") === "External" ? null : attributeOf(t, "Target");
    out.push({ tag: t.text, index: t.index, type: ty.slice(ty.lastIndexOf("/") + 1), to: to === null || to === undefined ? null : target(name, unescapeXml(to)) });
  }
  return out;
};

/** What is cut, from the package alone: the comment parts (by content type and by relationship type), and whether any anchor is present. */
function commentParts(files: Record<string, Uint8Array>): Set<string> {
  const parts = new Set<string>();
  const ct = files[CONTENT_TYPES];
  if (ct !== undefined) {
    for (const t of startTags(dec.decode(ct), CONTENT_TYPES)) {
      if (t.local === "Override" && COMMENT_CT.test(unescapeXml(attributeOf(t, "ContentType") ?? ""))) parts.add(unescapeXml(attributeOf(t, "PartName") ?? "").replace(/^\//, ""));
    }
  }
  for (const name of Object.keys(files)) {
    if (!name.endsWith(".rels")) continue;
    for (const r of relationships(name, dec.decode(files[name]!))) if (COMMENT_REL.has(r.type) && r.to !== null) parts.add(r.to);
  }
  return parts;
}

/** `text` without the listed spans. */
const without = (text: string, spans: [number, number][]): string => {
  let out = "", at = 0;
  for (const [s, e] of spans) { out += text.slice(at, s); at = e; }
  return out + text.slice(at);
};

/** The edited text of one part, or null when it needs no edit. Throws when a tag to cut is not self-closing. */
function edit(name: string, xml: string, removed: ReadonlySet<string>): string | null {
  const spans: [number, number][] = [];
  if (name === CONTENT_TYPES) {
    for (const t of startTags(xml, name)) {
      if (t.local === "Override" && removed.has(unescapeXml(attributeOf(t, "PartName") ?? "").replace(/^\//, ""))) {
        if (!selfClosing(t.text)) throw new Error("override not self-closing");
        spans.push([t.index, t.index + t.text.length]);
      }
    }
  } else if (name.endsWith(".rels")) {
    for (const r of relationships(name, xml)) {
      if (COMMENT_REL.has(r.type) || (r.to !== null && removed.has(r.to))) {
        if (!selfClosing(r.tag)) throw new Error("relationship not self-closing");
        spans.push([r.index, r.index + r.tag.length]);
      }
    }
  } else if (ANCHOR_HINT.test(xml)) {
    for (const t of startTags(xml, name)) {
      if (ANCHORS.has(t.local) && t.uri !== undefined && WORD_NS.test(t.uri)) {
        if (!selfClosing(t.text)) throw new Error("anchor not self-closing");
        spans.push([t.index, t.index + t.text.length]);
      }
    }
  }
  return spans.length === 0 ? null : without(xml, spans);
}

const hasAnchor = (xml: string, name: string): boolean => ANCHOR_HINT.test(xml) && [...startTags(xml, name)].some((t) => ANCHORS.has(t.local) && t.uri !== undefined && WORD_NS.test(t.uri));
const trackedChanges = (xml: string, name: string): number => [...startTags(xml, name)].filter((t) => (t.local === "ins" || t.local === "del") && t.uri !== undefined && WORD_NS.test(t.uri)).length;
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The whole-package check (over every part, not a sample), by patterns that do not use the editor's offsets. True only when `next` holds exactly the parts of `orig` less
 * `removed` and their own .rels, every other part is byte for byte the same unless it is one the edit may touch, and each such part equals the original with
 * only the allowed elements cut out: comment anchors in the XML parts, Override entries naming a removed part in the content types, Relationship entries
 * naming a removed part or a comment type in the .rels files. No anchor is left anywhere, nothing points at a removed part, and the tracked-change count of
 * every part is unchanged.
 */
export function onlyCommentsDiffer(orig: Record<string, Uint8Array>, next: Record<string, Uint8Array>, removed: ReadonlySet<string>): boolean {
  const gone = new Set([...removed, ...[...removed].map(ownRels)]);
  const want = Object.keys(orig).filter((n) => !gone.has(n));
  if (want.length !== Object.keys(next).length) return false;
  for (const name of want) {
    const a = orig[name], b = next[name];
    if (a === undefined || b === undefined) return false;
    if (sameBytes(a, b) && !(isXml(name))) continue;
    if (!isXml(name)) return false;
    let x: string, y: string;
    try { x = dec.decode(a); y = dec.decode(b); } catch { return false; }
    let expected = x;
    if (name === CONTENT_TYPES) {
      for (const p of removed) expected = expected.replace(new RegExp(`<(?:[\\w.-]+:)?Override\\b(?:[^>"']|"[^"]*"|'[^']*')*?PartName\\s*=\\s*(?:"/?${esc(p)}"|'/?${esc(p)}')(?:[^>"']|"[^"]*"|'[^']*')*/>`, "g"), "");
    } else if (name.endsWith(".rels")) {
      expected = x.replace(/<(?:[\w.-]+:)?Relationship\b(?:[^>"']|"[^"]*"|'[^']*')*\/>/g, (tag) => {
        const ty = /\bType\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
        const to = /\bTarget\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
        const type = unescapeXml(ty?.[1] ?? ty?.[2] ?? "");
        const external = /\bTargetMode\s*=\s*["']External["']/.test(tag);
        const dest = to === null || external ? null : target(name, unescapeXml(to[1] ?? to[2] ?? ""));
        return COMMENT_REL.has(type.slice(type.lastIndexOf("/") + 1)) || (dest !== null && removed.has(dest)) ? "" : tag;
      });
    } else {
      // an anchor is any element of that local name in the Word namespace, whatever prefix is bound to it: counted by the parser, cut by pattern
      expected = x.replace(/<([\w.-]+:)?comment(?:RangeStart|RangeEnd|Reference)\b(?:[^>"']|"[^"]*"|'[^']*')*\/>/g, "");
    }
    if (expected !== y) return false;
    if (name.endsWith(".xml") && name !== CONTENT_TYPES) {
      try { if (hasAnchor(y, name) || trackedChanges(x, name) !== trackedChanges(y, name)) return false; } catch { return false; }
    }
    if (name.endsWith(".rels")) {
      try { if (relationships(name, y).some((r) => COMMENT_REL.has(r.type) || (r.to !== null && removed.has(r.to)))) return false; } catch { return false; }
    }
  }
  return true;
}

/** The document's bytes with comments (parts, links, anchors) taken out; null when it has none or it cannot be done safely. */
export function wordPrintCopy(bytes: Buffer, opts?: PrintCopyOptions): Buffer | null {
  return wordPrintCopyDetail(bytes, opts)?.bytes ?? null;
}

/** As wordPrintCopy, and whether anything was hidden: at least one w:comment element or one comment anchor was removed (an empty comments part alone hides nothing). */
export function wordPrintCopyDetail(bytes: Buffer, opts?: PrintCopyOptions): { bytes: Buffer; hidden: boolean } | null {
  try {
    const raw = new Uint8Array(bytes);
    if (!withinCap(raw, opts?.cap ?? PRINT_COPY_CAP_BYTES)) return null;
    const files = inflateAll(raw, opts);
    for (const [name, data] of Object.entries(files)) {
      if (isXml(name) && data.length >= 2 && ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))) return null;
    }
    const removed = commentParts(files);
    for (const p of removed) if (files[p] === undefined) removed.delete(p);
    const edits = new Map<string, Uint8Array>();
    let anchors = false;
    for (const name of Object.keys(files)) {
      if (!isXml(name) || removed.has(name)) continue;
      const xml = dec.decode(files[name]!);
      if (name !== CONTENT_TYPES && !name.endsWith(".rels") && hasAnchor(xml, name)) anchors = true;
      const next = edit(name, xml, removed);
      if (next !== null) edits.set(name, enc.encode(next));
    }
    if (removed.size === 0 && !anchors) return null;
    let hidden = anchors;
    for (const p of removed) {
      if (hidden) break;
      try { hidden = [...startTags(dec.decode(files[p]!), p)].some((t) => t.local === "comment" && t.uri !== undefined && WORD_NS.test(t.uri)); } catch { /* not readable: the final check refuses it */ }
    }
    const gone = new Set([...removed, ...[...removed].map(ownRels)]);
    const out: Zippable = {};
    for (const [name, data] of Object.entries(files)) if (!gone.has(name)) out[name] = edits.get(name) ?? data;
    const next = Buffer.from(zipSync(out));
    return onlyCommentsDiffer(files, unzipSync(new Uint8Array(next)), removed) ? { bytes: next, hidden } : null;
  } catch {
    return null;
  }
}
