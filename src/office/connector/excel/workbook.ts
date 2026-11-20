// The Excel connector's own reading of one .xlsx package: every sheet (worksheets and chart sheets) with its cells, the canonical look of
// each cell (resolved from styles.xml, never by style id: openpyxl renumbers ids on every save), hidden and outlined rows and columns,
// merges, sizes, the file's own print area, and an inventory of the package parts that are not cells (charts, images, comments, tables,
// pivots, external links, macros). Read-only; nothing here touches a file on disk. Excel knowledge lives here, in the connector.
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { canonicalOrRaw, canonicalXml } from "../shared/ooxml-names.ts";
import { colToNum, shiftFormula } from "../xlsx/formula.ts";
import { builtinCode } from "../xlsx/numfmt.ts";

export type Value = string | number | boolean | { error: string } | null;

export interface Cell {
  /** The literal, or the formula's cached result; null when blank or not stored. */
  v: Value;
  /** Formula text without "=", shared formulas expanded per cell; null for a constant. */
  f: string | null;
  /** False for a formula cell with no stored result (`<v>` missing or empty): its value is unknown until Excel recalculates. */
  cached: boolean;
  /** The canonical look (number format, font, fill, border, alignment, protection) as one comparable string. */
  look: string;
}

export interface Rect { r1: number; c1: number; r2: number; c2: number }

export interface Drawing {
  kind: "chart" | "image" | "shape";
  /** The chart's title text, the picture's name, or "" when it has none. */
  name: string;
  /** The drawing object's own name in the sheet's XML (xdr cNvPr, "Chart 1"): what Excel calls the chart object. `name` is the title for a chart. */
  objectName?: string;
  /** Content hash with relationship ids stripped, so a renumbered copy compares equal. */
  sha: string;
  /** A chart's own XML (relationship ids kept as read), for describing what differs between two sides. */
  xml?: string;
  /** Where it sits on a worksheet (xdr:from / xdr:to, 1-based), when anchored to cells. */
  anchor?: Rect;
  /** The anchor's own offset into its first cell (xdr:colOff and xdr:rowOff, EMU), present when either is not zero. */
  anchorOffset?: { x: number; y: number };
  /** The anchor exactly as the file writes it, for placing the frame on a printed page: a two-cell anchor's corners, a one-cell anchor's corner and size,
   * or an absolute anchor's position and size (EMU; columns and rows 0-based as in the file). */
  place?: DrawingPlace;
}

/** A frame corner: a cell (0-based column and row) and the offset into it in EMU. */
export interface AnchorCorner { col: number; row: number; colOff: number; rowOff: number }
export type DrawingPlace =
  | { kind: "twoCell"; from: AnchorCorner; to: AnchorCorner }
  | { kind: "oneCell"; from: AnchorCorner; ext: { cx: number; cy: number } }
  | { kind: "absolute"; pos: { x: number; y: number }; ext: { cx: number; cy: number } };

export interface Sheet {
  name: string;
  kind: "worksheet" | "chartsheet" | "other";
  state: "visible" | "hidden" | "veryHidden";
  /** Rows of cells, 1-based row -> 1-based column -> cell. Only cells the file stores. */
  rows: Map<number, Map<number, Cell>>;
  maxRow: number;
  maxCol: number;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  /** Outline (group) level of a row, only rows with a level. */
  outline: Map<number, number>;
  /** Row heights in points that the file sets; others take `defaultHeight`. */
  heights: Map<number, number>;
  defaultHeight: number;
  /** Column widths in Excel's characters that the file sets; others take `defaultWidth`. */
  widths: Map<number, number>;
  defaultWidth: number;
  merges: Rect[];
  autoFilter?: Rect;
  rightToLeft: boolean;
  protectedSheet: boolean;
  /** The file's own print area (`_xlnm.Print_Area`), as written. */
  printArea?: string;
  drawings: Drawing[];
  /** Comment text by cell ("B3"). */
  comments: Map<string, string>;
}

export interface Part { name: string; sha: string; size: number }

export interface Workbook {
  sheets: Sheet[];
  /** Defined names other than Excel's own print names, as `name|scope -> text`. */
  names: Map<string, string>;
  /** Every package part by name, with a content hash. */
  parts: Map<string, Part>;
  /** True when the workbook asks Excel to recalculate everything on open. */
  fullCalcOnLoad: boolean;
  /** Formula cells across the workbook that carry no stored result. */
  uncached: number;
  /** A VBA project is present. */
  macros: boolean;
}

const ARRAYS = new Set(["sheet", "Relationship", "si", "r", "xf", "font", "fill", "border", "numFmt", "definedName", "col", "mergeCell", "comment", "xdr:twoCellAnchor", "xdr:oneCellAnchor", "xdr:absoluteAnchor", "twoCellAnchor", "oneCellAnchor", "absoluteAnchor"]);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: false, removeNSPrefix: true, isArray: (n) => ARRAYS.has(n) });

/** For a part already written the way `canonicalXml` spells it: a name in a foreign namespace stays `foreign:<local>` and is never taken for a modelled one. */
const canonicalParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: false, isArray: (n) => ARRAYS.has(n) });

const dec = new TextDecoder("utf-8");
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex").slice(0, 16);
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type X = any;

function textOf(v: X): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in v) return String(v["#text"]);
  return "";
}

/** Rich or plain string item text. */
function siText(si: X): string {
  if (si === undefined) return "";
  if (si.t !== undefined) return textOf(si.t);
  return arr(si.r).map((r: X) => textOf(r.t)).join("");
}

/** Stable JSON with sorted keys: a style component compared by what it says, not how it was written. */
function stable(v: X): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}

interface Styles { looks: string[] }
function readStyles(xml: string | undefined): Styles {
  if (xml === undefined) return { looks: [] };
  const ss = parser.parse(xml)?.styleSheet ?? {};
  const fmts = new Map<number, string>();
  for (const n of arr(ss.numFmts?.numFmt)) fmts.set(Number(n["@_numFmtId"]), String(n["@_formatCode"] ?? ""));
  const fonts = arr(ss.fonts?.font).map(stable);
  const fills = arr(ss.fills?.fill).map(stable);
  const borders = arr(ss.borders?.border).map(stable);
  const looks = arr(ss.cellXfs?.xf).map((x: X) => {
    const id = Number(x["@_numFmtId"] ?? 0);
    const fmt = fmts.get(id) ?? builtinCode(id) ?? `#${id}`;
    return stable({ fmt, font: fonts[Number(x["@_fontId"] ?? 0)] ?? "", fill: fills[Number(x["@_fillId"] ?? 0)] ?? "", border: borders[Number(x["@_borderId"] ?? 0)] ?? "", align: x.alignment ?? null, prot: x.protection ?? null });
  });
  return { looks };
}

/** "B12" -> { r: 12, c: 2 } */
export function cellRef(a: string): { r: number; c: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(a.toUpperCase());
  return m ? { r: Number(m[2]), c: colToNum(m[1]!) } : null;
}
export function rangeRect(ref: string): Rect | null {
  const [a, b] = ref.split(":");
  const p = cellRef(a ?? ""), q = cellRef(b ?? a ?? "");
  if (!p || !q) return null;
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
const relsOf = (part: string): string => { const i = part.lastIndexOf("/"); return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`; };

function readRels(files: Record<string, Uint8Array>, part: string): Map<string, { type: string; target: string; external: boolean }> {
  const out = new Map<string, { type: string; target: string; external: boolean }>();
  const b = files[relsOf(part)];
  if (!b) return out;
  const x = parser.parse(canonicalXml(dec.decode(b), "pkgrel", relsOf(part)));
  for (const r of arr(x?.Relationships?.Relationship)) {
    const external = r["@_TargetMode"] === "External";
    out.set(String(r["@_Id"]), { type: String(r["@_Type"] ?? "").split("/").pop() ?? "", target: external ? String(r["@_Target"]) : resolveTarget(part, String(r["@_Target"] ?? "")), external });
  }
  return out;
}

const CELL_RE = /<c\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const ROW_RE = /<row\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const attr = (s: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(s);
  return m ? unesc(m[1] ?? m[2] ?? "") : undefined;
};
const unesc = (s: string): string => s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_m, e: string) => e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const inner = (body: string, tag: string): { attrs: string; text: string } | undefined => {
  const m = new RegExp(`<${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:/>|>([\\s\\S]*?)</${tag}>)`).exec(body);
  return m ? { attrs: m[1] ?? "", text: m[2] ?? "" } : undefined;
};

function readWorksheet(xml: string, name: string, strings: string[], styles: Styles, sheet: Sheet): number {
  let uncached = 0;
  const shared = new Map<string, { r: number; c: number; f: string }>();
  const fmtPr = inner(xml, "sheetFormatPr");
  if (fmtPr) {
    const h = Number(attr(fmtPr.attrs, "defaultRowHeight"));
    if (h > 0) sheet.defaultHeight = h;
    const w = Number(attr(fmtPr.attrs, "defaultColWidth") ?? NaN);
    const bw = Number(attr(fmtPr.attrs, "baseColWidth") ?? NaN);
    if (w > 0) sheet.defaultWidth = w;
    else if (bw > 0) sheet.defaultWidth = bw + 0.71;
  }
  const view = inner(xml, "sheetView");
  if (view && /^(1|true)$/.test(attr(view.attrs, "rightToLeft") ?? "")) sheet.rightToLeft = true;
  if (/<sheetProtection\b[^>]*\bsheet\s*=\s*["'](1|true)["']/.test(xml)) sheet.protectedSheet = true;
  const cols = inner(xml, "cols");
  if (cols) {
    for (const m of cols.text.matchAll(/<col\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g)) {
      const a = m[1] ?? "";
      const lo = Number(attr(a, "min")), hi = Math.min(Number(attr(a, "max")), lo + 16384);
      const w = Number(attr(a, "width"));
      const hidden = /^(1|true)$/.test(attr(a, "hidden") ?? "");
      for (let c = lo; c <= hi && c <= 16384; c++) {
        if (w > 0 && attr(a, "customWidth") !== "0") sheet.widths.set(c, w);
        if (hidden) sheet.hiddenCols.add(c);
      }
    }
  }
  const data = inner(xml, "sheetData");
  let rowAuto = 0;
  if (data) {
    for (const rm of data.text.matchAll(ROW_RE)) {
      const ra = rm[1] ?? "";
      const rn = Number(attr(ra, "r") ?? rowAuto + 1);
      rowAuto = rn;
      if (/^(1|true)$/.test(attr(ra, "hidden") ?? "")) sheet.hiddenRows.add(rn);
      const ol = Number(attr(ra, "outlineLevel") ?? 0);
      if (ol > 0) sheet.outline.set(rn, ol);
      const ht = Number(attr(ra, "ht") ?? 0);
      if (ht > 0) sheet.heights.set(rn, ht);
      const body = rm[2];
      if (body === undefined) continue;
      let colAuto = 0;
      let row: Map<number, Cell> | undefined;
      for (const cm of body.matchAll(CELL_RE)) {
        const ca = cm[1] ?? "", cb = cm[2] ?? "";
        const ref = attr(ca, "r");
        const p = ref ? cellRef(ref) : { r: rn, c: colAuto + 1 };
        if (!p) continue;
        colAuto = p.c;
        const t = attr(ca, "t");
        const look = styles.looks[Number(attr(ca, "s") ?? 0)] ?? styles.looks[0] ?? "";
        let f: string | null = null;
        const fe = inner(cb, "f");
        if (fe) {
          const text = unesc(fe.text);
          if (attr(fe.attrs, "t") === "shared") {
            const si = attr(fe.attrs, "si") ?? "";
            if (text !== "") { shared.set(si, { r: p.r, c: p.c, f: text }); f = text; }
            else {
              const m = shared.get(si);
              f = m ? shiftFormula(m.f, p.c - m.c, p.r - m.r, name, true) : "";
            }
          } else f = text;
        }
        const ve = inner(cb, "v");
        const vt = ve === undefined ? undefined : unesc(ve.text);
        let v: Value = null;
        if (t === "inlineStr") {
          const is = inner(cb, "is");
          v = is ? [...is.text.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1] ?? "")).join("") : "";
        } else if (vt !== undefined && vt !== "") {
          if (t === "s") v = strings[Number(vt)] ?? "";
          else if (t === "b") v = vt === "1" || vt === "true";
          else if (t === "e") v = { error: vt };
          else if (t === "str" || t === "d") v = vt;
          else { const n = Number(vt); v = Number.isNaN(n) ? vt : n; }
        }
        const cached = f === null || (vt !== undefined && vt !== "");
        if (!cached) uncached++;
        // A cell with nothing in it and the default look is no cell at all (openpyxl and Excel both write such cells).
        if (f === null && v === null && look === (styles.looks[0] ?? "")) continue;
        if (row === undefined) { row = new Map(); sheet.rows.set(rn, row); }
        row.set(p.c, { v, f, cached, look });
        if (p.c > sheet.maxCol) sheet.maxCol = p.c;
        if (rn > sheet.maxRow) sheet.maxRow = rn;
      }
    }
  }
  const merges = inner(xml, "mergeCells");
  if (merges) for (const m of merges.text.matchAll(/<mergeCell\b[^>]*\bref\s*=\s*["']([^"']+)["']/g)) { const r = rangeRect(m[1]!); if (r) sheet.merges.push(r); }
  const af = inner(xml, "autoFilter");
  if (af) { const r = rangeRect(attr(af.attrs, "ref") ?? ""); if (r) sheet.autoFilter = r; }
  return uncached;
}

/** Chart title text, from rich text runs or a literal. */
function chartTitle(xml: string): string {
  const t = /<(?:\w+:)?title\b[\s\S]*?<\/(?:\w+:)?title>/.exec(xml);
  if (!t) return "";
  return [...t[0].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => unesc(m[1] ?? "")).join("").trim() || [...t[0].matchAll(/<(?:\w+:)?f>([\s\S]*?)<\/(?:\w+:)?f>/g)].map((m) => unesc(m[1] ?? "")).join("");
}
const stripIds = (s: string): string => s.replace(/\s(?:r:)?(?:id|embed|link)="rId\d+"/g, "").replace(/\sid="\d+"/g, "").replace(/<c:externalData\b[\s\S]*?(?:\/>|<\/c:externalData>)/g, "");

function readDrawing(files: Record<string, Uint8Array>, drawingPart: string): Drawing[] {
  const b = files[drawingPart];
  if (!b) return [];
  const xml = canonicalOrRaw(dec.decode(b), "ooxml", drawingPart);
  const rels = readRels(files, drawingPart);
  const out: Drawing[] = [];
  for (const m of xml.matchAll(/<(?:xdr:)?(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/(?:xdr:)?\1>/g)) {
    const a = m[0];
    const num = (tag: string, which: "from" | "to"): number | undefined => {
      const blk = new RegExp(`<(?:xdr:)?${which}>([\\s\\S]*?)</(?:xdr:)?${which}>`).exec(a)?.[1];
      const v = blk ? new RegExp(`<(?:xdr:)?${tag}>(\\d+)</`).exec(blk)?.[1] : undefined;
      return v === undefined ? undefined : Number(v);
    };
    const fr = num("row", "from"), fc = num("col", "from"), tr = num("row", "to"), tc = num("col", "to");
    const off = { x: num("colOff", "from") ?? 0, y: num("rowOff", "from") ?? 0 };
    // a one-cell anchor gives a size in EMU instead of an end cell: count default columns (64 px) and rows (20 px) at 9525 EMU a pixel
    const ext = /<(?:xdr:)?ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(a);
    const spanC = tc === undefined && ext ? Math.max(0, Math.ceil(Number(ext[1]) / 9525 / 64) - 1) : 0;
    const spanR = tr === undefined && ext ? Math.max(0, Math.ceil(Number(ext[2]) / 9525 / 20) - 1) : 0;
    const anchor = fr !== undefined && fc !== undefined ? { r1: fr + 1, c1: fc + 1, r2: (tr ?? fr + spanR) + 1, c2: (tc ?? fc + spanC) + 1 } : undefined;
    // the anchor's own children come before the drawn object; an ext or off inside the object (its xfrm) is not the anchor's
    const head = a.slice(0, Math.max(0, a.search(/<(?:xdr:)?(?:graphicFrame|pic|sp|grpSp|cxnSp|contentPart)\b/)) || a.length);
    const corner = (which: "from" | "to"): AnchorCorner | undefined => {
      const c = num("col", which), r = num("row", which);
      return c === undefined || r === undefined ? undefined : { col: c, row: r, colOff: num("colOff", which) ?? 0, rowOff: num("rowOff", which) ?? 0 };
    };
    const hx = /<(?:xdr:)?ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(head), hp = /<(?:xdr:)?pos\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(head);
    const cf = corner("from"), ct = corner("to"), he = hx ? { cx: Number(hx[1]), cy: Number(hx[2]) } : undefined;
    const place: DrawingPlace | undefined = m[1] === "twoCellAnchor" ? (cf && ct ? { kind: "twoCell", from: cf, to: ct } : undefined)
      : m[1] === "oneCellAnchor" ? (cf && he ? { kind: "oneCell", from: cf, ext: he } : undefined)
      : hp && he ? { kind: "absolute", pos: { x: Number(hp[1]), y: Number(hp[2]) }, ext: he } : undefined;
    const chartRid = /<(?:c:)?chart\b[^>]*\br:id="([^"]+)"/.exec(a)?.[1];
    const blipRid = /<(?:a:)?blip\b[^>]*\br:embed="([^"]+)"/.exec(a)?.[1];
    const nm = unesc(/<(?:xdr:)?cNvPr\b[^>]*\bname="([^"]*)"/.exec(a)?.[1] ?? "");
    if (chartRid) {
      const target = rels.get(chartRid)?.target;
      const cx = target && files[target] ? canonicalOrRaw(dec.decode(files[target]!), "ooxml", target) : "";
      out.push({ kind: "chart", name: chartTitle(cx) || nm, ...(nm !== "" ? { objectName: nm } : {}), sha: sha(stripIds(cx)), xml: cx, ...(anchor ? { anchor } : {}), ...(anchor && (off.x !== 0 || off.y !== 0) ? { anchorOffset: off } : {}), ...(place ? { place } : {}) });
    } else if (blipRid) {
      const target = rels.get(blipRid)?.target;
      out.push({ kind: "image", name: nm, sha: target && files[target] ? sha(files[target]!) : sha(nm), ...(anchor ? { anchor } : {}), ...(place ? { place } : {}) });
    } else out.push({ kind: "shape", name: nm, sha: sha(stripIds(a)), ...(anchor ? { anchor } : {}), ...(place ? { place } : {}) });
  }
  return out;
}

/** Reads one .xlsx package. Throws on a package that is not a readable workbook. */
export function readWorkbook(bytes: Uint8Array): Workbook {
  const files = unzipSync(bytes);
  const parts = new Map<string, Part>();
  for (const [n, b] of Object.entries(files)) if (!n.endsWith("/")) parts.set(n, { name: n, sha: sha(b), size: b.length });
  // the workbook part: the officeDocument relationship, else the usual name
  let wbPart = [...readRelsAt(files, "_rels/.rels").values()].find((r) => r.type === "officeDocument")?.target ?? "xl/workbook.xml";
  if (!files[wbPart]) wbPart = "xl/workbook.xml";
  const wbXml = files[wbPart] ? canonicalXml(dec.decode(files[wbPart]!), "main", wbPart) : "";
  if (wbXml === "") throw new Error("not an Excel workbook: no workbook part");
  const wb = parser.parse(wbXml)?.workbook ?? {};
  const rels = readRels(files, wbPart);
  const relOfType = (t: string): string | undefined => [...rels.values()].find((r) => r.type === t)?.target;
  const ssPart = relOfType("sharedStrings");
  const strings = ssPart && files[ssPart] ? arr(parser.parse(canonicalXml(dec.decode(files[ssPart]!), "main", ssPart))?.sst?.si).map(siText) : [];
  const stPart = relOfType("styles");
  const styles = readStyles(stPart && files[stPart] ? canonicalXml(dec.decode(files[stPart]!), "main", stPart) : undefined);
  const out: Workbook = { sheets: [], names: new Map(), parts, fullCalcOnLoad: /^(1|true)$/.test(String(wb.calcPr?.["@_fullCalcOnLoad"] ?? "")), uncached: 0, macros: [...parts.keys()].some((n) => /vbaProject\.bin$/i.test(n)) };
  const sheetEls = arr(wb.sheets?.sheet);
  const printAreas = new Map<number, string>();
  for (const dn of arr(wb.definedNames?.definedName)) {
    const name = String(dn["@_name"] ?? ""), scope = dn["@_localSheetId"], text = textOf(dn);
    if (name === "_xlnm.Print_Area" && scope !== undefined) printAreas.set(Number(scope), text);
    else if (!name.startsWith("_xlnm.")) out.names.set(`${name}|${scope === undefined ? "" : sheetEls[Number(scope)]?.["@_name"] ?? scope}`, text);
  }
  sheetEls.forEach((s: X, i: number) => {
    const name = String(s["@_name"] ?? `Sheet${i + 1}`);
    const rid = String(s["@_id"] ?? s["@_r:id"] ?? "");
    const rel = rels.get(rid);
    const part = rel?.target ?? "";
    const st = String(s["@_state"] ?? "visible");
    const sheet: Sheet = { name, kind: rel?.type === "worksheet" ? "worksheet" : rel?.type === "chartsheet" ? "chartsheet" : "other", state: st === "hidden" ? "hidden" : st === "veryHidden" ? "veryHidden" : "visible", rows: new Map(), maxRow: 0, maxCol: 0, hiddenRows: new Set(), hiddenCols: new Set(), outline: new Map(), heights: new Map(), defaultHeight: 15, widths: new Map(), defaultWidth: 8.43, merges: [], rightToLeft: false, protectedSheet: false, drawings: [], comments: new Map() };
    const pa = printAreas.get(i);
    if (pa !== undefined) sheet.printArea = pa;
    const b = part ? files[part] : undefined;
    if (b) {
      const xml = canonicalXml(dec.decode(b), "main", part);
      if (sheet.kind === "worksheet") out.uncached += readWorksheet(xml, name, strings, styles, sheet);
      const srels = readRels(files, part);
      for (const r of srels.values()) {
        if (r.type === "drawing") sheet.drawings.push(...readDrawing(files, r.target));
        if (r.type === "comments" && files[r.target]) {
          const cx = canonicalParser.parse(canonicalXml(dec.decode(files[r.target]!), "main", r.target))?.comments;
          for (const c of arr(cx?.commentList?.comment)) sheet.comments.set(String(c["@_ref"] ?? ""), siText(c.text ?? {}));
        }
      }
    }
    out.sheets.push(sheet);
  });
  return out;
}

function readRelsAt(files: Record<string, Uint8Array>, relsPart: string): Map<string, { type: string; target: string }> {
  const out = new Map<string, { type: string; target: string }>();
  const b = files[relsPart];
  if (!b) return out;
  const x = parser.parse(canonicalXml(dec.decode(b), "pkgrel", relsPart));
  for (const r of arr(x?.Relationships?.Relationship)) out.set(String(r["@_Id"]), { type: String(r["@_Type"] ?? "").split("/").pop() ?? "", target: resolveTarget("", String(r["@_Target"] ?? "")) });
  return out;
}

/** Excel's column width (characters) as printed points at 100%: pixels = trunc(w * 7 + 5) at the default font, 0.75 pt a pixel. */
export const widthPt = (s: Sheet, c: number): number => (s.hiddenCols.has(c) ? 0 : Math.trunc((s.widths.get(c) ?? s.defaultWidth) * 7 + 5) * 0.75);
export const heightPt = (s: Sheet, r: number): number => (s.hiddenRows.has(r) ? 0 : s.heights.get(r) ?? s.defaultHeight);
