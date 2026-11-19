import { strFromU8, unzipSync } from "fflate";
import { checkStructure } from "./structure-check.ts";
import { canonicalOrRaw } from "./ooxml-names.ts";

/**
 * A look at an Office file before it is handed to Office. It reads bytes only; it never launches anything.
 *
 * This guards against a hint used as a verdict: a skipped file Office would have opened is hidden from the user, while a launch on an
 * encrypted file only hangs. So the skip set is an allow-list of exactly five verdicts (SKIP_VERDICTS). Everything else is a hint, and a file
 * with hints still gets `action: "launch"`. A limit being reached is a hint too ("limits-reached"), never a sixth verdict: the scan stops
 * reading and returns what it found so far.
 *
 * Extending: add a `HintKind` and a scanner to SCANNERS (external targets are listed through `targets` on a hint). A scanner can only
 * return hints, so it cannot add a verdict.
 */

export const SKIP_VERDICTS = ["not-a-zip", "encrypted-ole", "missing-content-types", "torn-eocd", "extension-mismatch"] as const;
export type SkipVerdict = (typeof SKIP_VERDICTS)[number];

export type HintKind =
  | "likely-repair"
  | "external-relationship"
  | "update-fields"
  | "ddeauto"
  | "external-attached-template"
  | "hidden-slides"
  | "legacy-binary-format"
  | "unreadable-package"
  | "limits-reached";

export interface ExternalTarget {
  /** The relationship type's last path segment: "image", "oleObject", "externalLink". */
  type: string;
  target: string;
}

export interface PreflightHint {
  kind: HintKind;
  /** The package part the hint is about; null when it is about the file as a whole. */
  part: string | null;
  /** One plain sentence. */
  detail: string;
  /** External targets named by this hint, when it has any. */
  targets?: ExternalTarget[];
}

export type PreflightResult =
  | { action: "skip"; verdict: SkipVerdict; reason: string; hints: PreflightHint[] }
  | { action: "launch"; hints: PreflightHint[] };

export interface PreflightLimits {
  /** The most parts a package may list before part scanning stops. */
  maxParts?: number;
  /** The most declared uncompressed bytes preflight will inflate in total. */
  maxUnzippedBytes?: number;
}
export const DEFAULT_MAX_PARTS = 20_000;
export const DEFAULT_MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const CONTENT_TYPES = "[content_types].xml";

type App = "word" | "excel" | "powerpoint";
const MAIN_PART: Array<[string, App]> = [["word/document.xml", "word"], ["xl/workbook.xml", "excel"], ["ppt/presentation.xml", "powerpoint"]];
const extApp = (file: string): App | null => {
  const e = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  if (e === "docx" || e === "docm" || e === "dotx" || e === "dotm") return "word";
  if (e === "xlsx" || e === "xlsm" || e === "xltx" || e === "xltm" || e === "xlsb") return "excel";
  if (e === "pptx" || e === "pptm" || e === "ppsx" || e === "ppsm" || e === "potx" || e === "potm") return "powerpoint";
  return null;
};

const skip = (verdict: SkipVerdict, reason: string): PreflightResult => ({ action: "skip", verdict, reason, hints: [] });
const startsWith = (b: Uint8Array, sig: number[]): boolean => b.length >= sig.length && sig.every((v, i) => b[i] === v);

const EOCD_WINDOW = 22 + 0xffff;
/** True when the end-of-central-directory record is found and the directory it names is inside the file and starts with a directory record. */
function zipTail(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - EOCD_WINDOW); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return false;
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0) return true;
  // Zip64 puts the real values elsewhere; this check does not judge it (fflate reads it, or the package is a hint).
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return true;
  const at = (p: number): boolean => p >= 0 && p + 4 <= eocd && view.getUint32(p, true) === SIG_CENTRAL;
  return at(cdOffset);
}

/** True when the OLE container names an EncryptedPackage stream (stored UTF-16LE in the directory). */
function hasEncryptedPackage(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from("EncryptedPackage", "utf16le"));
}

interface Listed { name: string; size: number }
interface Scan {
  names: string[];
  parts: Record<string, string>;
  bytes: Uint8Array;
  file: string;
  hints: PreflightHint[];
}
type Scanner = (s: Scan) => void;

const attrsOf = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out[m[1]!] = m[2] ?? m[3] ?? "";
  return out;
};
const unescapeXml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const externalRelationships: Scanner = ({ parts, hints }) => {
  for (const [part, xml] of Object.entries(parts)) {
    if (!/\.rels$/i.test(part)) continue;
    const found: ExternalTarget[] = [];
    for (const m of xml.matchAll(/<Relationship\b([^>]*)>/g)) {
      const a = attrsOf(m[1]!);
      const target = unescapeXml(a.Target ?? "");
      // A UNC path or file: URL reaches off the machine even when the relationship forgets TargetMode.
      if (!/^external$/i.test(a.TargetMode ?? "") && !/^(\\\\|file:)/i.test(target)) continue;
      const type = (a.Type ?? "").split("/").pop() ?? "";
      if (type === "attachedTemplate") {
        hints.push({ kind: "external-attached-template", part, detail: `The attached template is external: ${target}`, targets: [{ type, target }] });
      } else if (type !== "hyperlink") {
        found.push({ type, target });
      }
    }
    if (found.length > 0) hints.push({ kind: "external-relationship", part, detail: `${found.length} external ${found.length === 1 ? "relationship" : "relationships"}`, targets: found });
  }
};

/** INCLUDETEXT / INCLUDEPICTURE / LINK fields in the Word body pull a named file or URL when fields update. */
const includeFields: Scanner = ({ parts, hints }) => {
  for (const [part, xml] of Object.entries(parts)) {
    if (!/^word\/[^/]*\.xml$/i.test(part)) continue;
    const found: ExternalTarget[] = [];
    const texts = [...xml.matchAll(/<w:instrText\b[^>]*>([^<]*)</g)].map((m) => m[1]!);
    for (const m of xml.matchAll(/<w:fldSimple\b([^>]*)>/g)) texts.push(attrsOf(m[1]!)["w:instr"] ?? "");
    for (const t of texts) {
      const m = /^\s*(INCLUDETEXT|INCLUDEPICTURE)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))/i.exec(unescapeXml(t));
      if (m === null) continue;
      found.push({ type: m[1]!.toLowerCase() === "includetext" ? "includeText" : "includePicture", target: (m[2] ?? m[3] ?? "").replace(/\\\\/g, "\\") });
    }
    if (found.length > 0) hints.push({ kind: "external-relationship", part, detail: `${found.length} included ${found.length === 1 ? "file" : "files"} named by fields`, targets: found });
  }
};

const updateFields: Scanner = ({ parts, hints }) => {
  const xml = parts["word/settings.xml"];
  const m = xml === undefined ? null : /<w:updateFields\b([^>]*)>/.exec(xml);
  if (m === null) return;
  const val = /(?:^|\s)w:val="([^"]*)"/.exec(m[1]!)?.[1];
  if (val === undefined || /^(true|1|on)$/i.test(val)) hints.push({ kind: "update-fields", part: "word/settings.xml", detail: "The document updates its fields when opened, which can prompt." });
};

const ddeAuto: Scanner = ({ parts, hints }) => {
  for (const [part, xml] of Object.entries(parts)) {
    if (/\.rels$/i.test(part)) continue;
    if (/DDEAUTO/i.test(xml)) hints.push({ kind: "ddeauto", part, detail: "A DDEAUTO field runs a command when the file opens." });
  }
};

const hiddenSlides: Scanner = ({ parts, hints }) => {
  const hidden: string[] = [];
  for (const [part, xml] of Object.entries(parts)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/i.test(part)) continue;
    const root = /<p:sld\b[^>]*>/.exec(xml)?.[0] ?? "";
    if (/\sshow="(0|false)"/i.test(root)) hidden.push(part);
  }
  if (hidden.length > 0) hints.push({ kind: "hidden-slides", part: hidden[0]!, detail: `${hidden.length} hidden ${hidden.length === 1 ? "slide" : "slides"}` });
};

const likelyRepair: Scanner = ({ bytes, file, hints }) => {
  const r = checkStructure(bytes, file);
  for (const f of r?.findings ?? []) if (f.severity === "likely-repair") hints.push({ kind: "likely-repair", part: f.part, detail: f.sentence });
};

/** Every scanner here only appends hints.  */
const SCANNERS: Scanner[] = [externalRelationships, includeFields, updateFields, ddeAuto, hiddenSlides, likelyRepair];

const SCANNED = /\.(xml|rels)$/i;

export function preflight(bytes: Uint8Array, file: string, limits: PreflightLimits = {}): PreflightResult {
  const maxParts = limits.maxParts ?? DEFAULT_MAX_PARTS;
  const maxBytes = limits.maxUnzippedBytes ?? DEFAULT_MAX_UNZIPPED_BYTES;

  if (startsWith(bytes, OLE_MAGIC)) {
    if (hasEncryptedPackage(bytes)) return skip("encrypted-ole", "The file is an encrypted Office package; Office would wait for a password.");
    return { action: "launch", hints: [{ kind: "legacy-binary-format", part: null, detail: "The file is an OLE binary, not an Open XML package; Office opens it by content." }] };
  }
  if (!startsWith(bytes, [0x50, 0x4b])) return skip("not-a-zip", "The file is not a zip package.");
  if (!zipTail(bytes)) return skip("torn-eocd", "The zip's end-of-central-directory record is missing or points outside the file.");

  const hints: PreflightHint[] = [];
  const listed: Listed[] = [];
  try {
    unzipSync(bytes, { filter: (f) => { listed.push({ name: f.name, size: f.originalSize }); return false; } });
  } catch {
    return { action: "launch", hints: [{ kind: "unreadable-package", part: null, detail: "The zip directory could not be read; Office may still open the file." }] };
  }
  const names = listed.map((l) => l.name);
  const lower = new Set(names.map((n) => n.toLowerCase()));
  if (!lower.has(CONTENT_TYPES)) return skip("missing-content-types", "The package has no [Content_Types].xml; Office refuses it.");

  const want = extApp(file);
  if (want !== null) {
    const present = MAIN_PART.filter(([p]) => lower.has(p)).map(([, a]) => a);
    if (present.length === 1 && present[0] !== want) return skip("extension-mismatch", `The extension says ${want} but the package holds ${present[0]} content.`);
  }

  // Everything below only produces hints. Reading stops at a limit and says so.
  let limited = names.length > maxParts;
  const totalDeclared = listed.reduce((n, l) => n + l.size, 0);
  if (totalDeclared > maxBytes) limited = true;
  const chosen = new Set<string>();
  if (names.length <= maxParts) {
    let budget = maxBytes;
    for (const l of listed) {
      if (!SCANNED.test(l.name)) continue;
      if (l.size > budget) { limited = true; continue; }
      budget -= l.size;
      chosen.add(l.name);
    }
  }
  const parts: Record<string, string> = {};
  let readable = true;
  try {
    const raw = unzipSync(bytes, { filter: (f) => chosen.has(f.name) });
    for (const [n, u8] of Object.entries(raw)) parts[n] = canonicalOrRaw(strFromU8(u8), "ooxml", n);
  } catch {
    readable = false;
    hints.push({ kind: "unreadable-package", part: null, detail: "A part could not be inflated; Office may still open the file." });
  }
  if (readable) {
    const scan: Scan = { names, parts, bytes, file, hints };
    for (const s of SCANNERS) {
      if (limited && s === likelyRepair) continue;
      try { s(scan); } catch { /* a scanner failure is a missing hint, never a verdict */ }
    }
  }
  if (limited) hints.push({ kind: "limits-reached", part: null, detail: `Preflight stopped reading at its limits (${maxParts} parts, ${maxBytes} bytes); the hints may be incomplete.` });
  return { action: "launch", hints };
}
