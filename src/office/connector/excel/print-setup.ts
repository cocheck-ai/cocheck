// The copy of a workbook that Excel prints from: the same package with `paperSize` and `errors` removed from each worksheet's own pageSetup.
// Both change what a print looks like (a paper that cuts or shrinks the picture; "print errors as" changing what a cell shows) and AppleScript
// cannot set either, so they are taken out of the copy. Pure: bytes in, bytes out, in memory. Edited textually on the original XML (nothing is parsed
// and re-serialised): only those two attributes, on pageSetup elements that are direct children of a worksheet or chartsheet root, are cut out; every other
// byte of every part, and every other part, stays. Null (the caller sends the plain copy, adds no claim) when there is nothing to remove, or when anything
// is unexpected: not a readable zip, a sheet part that is missing or not a worksheet, XML that does not parse, or a result the whole-package check refuses.
import { unzipSync, zipSync, type Zippable } from "fflate";
import { inflateAll, PRINT_COPY_CAP_BYTES, withinCap, type PrintCopyOptions } from "../print-copy-cap.ts";
import { attributeOf, isPackageRel, startTags, type StartTag } from "../shared/ooxml-names.ts";

const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
const WORKBOOK = "xl/workbook.xml";
const dec = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const enc = new TextEncoder();
/** The only attributes this rewrite may remove. */
export const PRINT_SETUP_ATTRIBUTES = ["paperSize", "errors"] as const;
const SHEET_ROOTS = new Set(["worksheet", "chartsheet"]);
const SHEET_NS = /^http:\/\/(?:schemas\.openxmlformats\.org|purl\.oclc\.org\/ooxml)\/spreadsheetml\/(?:2006\/)?main$/;

const unescapeXml = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e]!);
function resolve(target: string): string {
  const out: string[] = [];
  for (const p of (target.startsWith("/") ? target.slice(1) : `xl/${target}`).split("/")) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); }
  return out.join("/");
}
const isSheetPageSetup = (t: StartTag): boolean => t.depth === 1 && t.local === "pageSetup" && t.uri !== undefined && SHEET_NS.test(t.uri);

/** The sheet parts (worksheets and chartsheets) the workbook lists, or null when that cannot be read. */
function sheetParts(files: Record<string, Uint8Array>): string[] | null {
  const rels = files[WORKBOOK_RELS];
  if (rels === undefined || files[WORKBOOK] === undefined) return null;
  const out: string[] = [];
  for (const t of startTags(dec.decode(rels), WORKBOOK_RELS)) {
    if (!isPackageRel(t, "Relationship") || attributeOf(t, "TargetMode") === "External") continue;
    const type = unescapeXml(attributeOf(t, "Type") ?? "");
    const kind = type.slice(type.lastIndexOf("/") + 1);
    if (kind !== "worksheet" && kind !== "chartsheet") continue;
    const target = attributeOf(t, "Target");
    if (target === undefined) return null;
    const part = resolve(unescapeXml(target));
    if (files[part] === undefined) return null;
    out.push(part);
  }
  return out;
}

/** The span of the attribute (leading whitespace, name, value) inside the tag text, or null. */
function attributeSpan(tag: StartTag, local: string): [number, number] | null {
  const a = tag.attributes.find((x) => x.uri === undefined && x.local === local);
  if (a === undefined) return null;
  const head = /\s+[^\s=]+\s*=\s*$/.exec(tag.text.slice(0, a.valueStart - 1));
  if (head === null) throw new Error("attribute not located");
  return [head.index, a.valueEnd + 1];
}

function strip(xml: string, part: string): string | null {
  let out = "";
  let at = 0;
  let root = false;
  for (const tag of startTags(xml, part)) {
    if (tag.depth === 0) { root = SHEET_ROOTS.has(tag.local) && tag.uri !== undefined && SHEET_NS.test(tag.uri); if (!root) throw new Error(`${part} is not a sheet`); continue; }
    if (!isSheetPageSetup(tag)) continue;
    const spans = PRINT_SETUP_ATTRIBUTES.map((n) => attributeSpan(tag, n)).filter((s): s is [number, number] => s !== null).sort((x, y) => x[0] - y[0]);
    if (spans.length === 0) continue;
    let rest = tag.text;
    for (const [s, e] of [...spans].reverse()) rest = rest.slice(0, s) + rest.slice(e);
    out += xml.slice(at, tag.index) + rest;
    at = tag.index + tag.text.length;
  }
  return at === 0 ? null : out + xml.slice(at);
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
/** A tag's text with the two attributes cut out, by a pattern that does not use the editor's offsets. */
const cut = (tag: string): string => tag.replace(/\s+(?:paperSize|errors)\s*=\s*(?:"[^"]*"|'[^']*')/g, "");
const PAGE_SETUP_TAG = /<(?:[\w.-]+:)?pageSetup(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/**
 * The whole-package check (over every part, not a sample). True only when `next` has the same part names as `orig`, every part that is not a listed sheet part is byte for byte
 * the same (.rels, docProps, media and binaries included), and each sheet part is the same text once the two attributes are cut out of its pageSetup tags,
 * with those two gone from every pageSetup directly under the root and every other pageSetup tag (a custom view's, say) left exactly as it was.
 */
export function onlyPrintSetupDiffers(orig: Record<string, Uint8Array>, next: Record<string, Uint8Array>, sheets: readonly string[]): boolean {
  const names = Object.keys(orig);
  if (names.length !== Object.keys(next).length) return false;
  for (const name of names) {
    const a = orig[name], b = next[name];
    if (a === undefined || b === undefined) return false;
    if (!sheets.includes(name)) { if (!sameBytes(a, b)) return false; continue; }
    if (sameBytes(a, b)) continue;
    let x: string, y: string;
    try { x = dec.decode(a); y = dec.decode(b); } catch { return false; }
    if (x.replace(PAGE_SETUP_TAG, cut) !== y.replace(PAGE_SETUP_TAG, cut)) return false;
    try {
      const was = [...startTags(x, name)].filter((t) => t.local === "pageSetup");
      const now = [...startTags(y, name)].filter((t) => t.local === "pageSetup");
      if (was.length !== now.length) return false;
      for (let i = 0; i < was.length; i++) {
        if (isSheetPageSetup(now[i]!)) { if (PRINT_SETUP_ATTRIBUTES.some((n) => attributeOf(now[i]!, n) !== undefined)) return false; }
        else if (was[i]!.text !== now[i]!.text) return false;
      }
    } catch { return false; }
  }
  return true;
}

/** The workbook's bytes with `paperSize` and `errors` removed from every sheet's pageSetup; null when there is nothing to remove or it cannot be done safely. */
export function excelPrintCopy(bytes: Buffer, opts?: PrintCopyOptions): Buffer | null {
  try {
    const raw = new Uint8Array(bytes);
    if (!withinCap(raw, opts?.cap ?? PRINT_COPY_CAP_BYTES)) return null;
    const files = inflateAll(raw, opts);
    const sheets = sheetParts(files);
    if (sheets === null) return null;
    const edits = new Map<string, Uint8Array>();
    for (const part of sheets) {
      const next = strip(dec.decode(files[part]!), part);
      if (next !== null) edits.set(part, enc.encode(next));
    }
    if (edits.size === 0) return null;
    const out: Zippable = {};
    for (const [name, data] of Object.entries(files)) out[name] = edits.get(name) ?? data;
    const next = Buffer.from(zipSync(out));
    return onlyPrintSetupDiffers(files, unzipSync(new Uint8Array(next)), sheets) ? next : null;
  } catch {
    return null;
  }
}
