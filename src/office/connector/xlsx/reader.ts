/**
 * Read-only xlsx snapshot extraction: unzips the package (fflate), parses the OOXML parts
 * (fast-xml-parser), and resolves each cell to the `CellSnapshot` shape in `../types.ts` -
 * cached value, expanded formula text, and resolved number format code. No write path exists
 * or is planned here; this module never touches the input buffer's source file.
 *
 * Known gaps (documented, not silent): only unqualified same-sheet formula references are
 * understood (see `formula.ts`); array formulas (`<f t="array">`) are treated like plain
 * formulas (their `ref` span is ignored - only the anchor cell's text is kept, which is what
 * Excel itself stores per cell); charts, comments, and defined names are not read.
 */
import { unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { cellError, type CellSnapshot, type SheetSnapshot, type WorkbookSnapshot } from "./types.ts";
import { shiftFormula, parseAddress } from "./formula.ts";
import { builtinCode, type DateSystem } from "./numfmt.ts";
import { canonicalXml, type PartKind } from "../shared/ooxml-names.ts";

/**
 * Thrown when a workbook is past the bounds a caller passed to `readWorkbookSnapshot`: its parts
 * unzip to more than `maxUnzippedBytes`, or its sheets hold more than `maxCells` cells. Reading
 * stops as soon as either is crossed, so the heap never holds more than the bound. `limit` says
 * which bound in words, e.g. "over 600,000 cells".
 */
export class WorkbookTooLarge extends Error {
  readonly limit: string;

  constructor(limit: string) {
    super(`xlsx: workbook too large to read (${limit})`);
    this.limit = limit;
  }
}

export interface ReadLimits {
  /** Total cells across every sheet. */
  maxCells?: number;
  /** Total uncompressed bytes of every part in the package, checked before anything is inflated. */
  maxUnzippedBytes?: number;
}

const ARRAY_TAGS = new Set(["row", "c", "si", "r", "sheet", "numFmt", "xf", "Relationship"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

/** The first element's local name in already-canonical XML, the part's root. */
function rootOf(xml: string): string | undefined {
  return /<(?![?!])([^\s/>]+)/.exec(xml)?.[1];
}

const NO_CELL_SHEETS = new Set(["chartsheet", "dialogsheet"]);

function malformed(part: string, why: string): Error {
  return new Error(`xlsx: ${part} is malformed (${why})`);
}

/**
 * A small XML part parsed whole. It must be well-formed, and its root must be `root` in `kind`'s namespace:
 * a part we cannot read is an error, never an empty document.
 */
function readXml(files: Record<string, Uint8Array>, path: string, kind: PartKind, root: string): any {
  const bytes = files[path];
  if (!bytes) {
    throw new Error(`xlsx: missing required part ${path}`);
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    throw malformed(path, valid.err.msg);
  }
  const xml = canonicalXml(text, kind, path);
  if (rootOf(xml) !== root) {
    throw malformed(path, `no ${root} element`);
  }
  return parser.parse(xml);
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * fast-xml-parser gives a leaf element's text as a bare string when it has no attributes, but
 * as `{ "#text": "...", "@_...": ... }` when it does (e.g. `<t xml:space="preserve">`). Every
 * place we read `<t>` content has to handle both shapes.
 */
function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)["#text"]);
  }
  return String(node);
}

/** Concatenates a shared-string `<si>` entry's text, whether it's a plain `<t>` or rich-text `<r>` runs. */
function siText(si: Record<string, unknown>): string {
  if (si["t"] !== undefined) {
    return textOf(si["t"]);
  }
  const runs = asArray<Record<string, unknown>>(si["r"] as any);
  return runs.map((run) => textOf(run["t"])).join("");
}

function parseSharedStrings(files: Record<string, Uint8Array>): string[] {
  if (!files["xl/sharedStrings.xml"]) return [];
  const doc = readXml(files, "xl/sharedStrings.xml", "main", "sst");
  const items = asArray<Record<string, unknown>>(doc?.sst?.si);
  return items.map(siText);
}

interface StyleTable {
  /** cellXfs index -> resolved number format code. */
  numFmtByXf: string[];
}

function parseStyles(files: Record<string, Uint8Array>): StyleTable {
  if (!files["xl/styles.xml"]) return { numFmtByXf: [] };
  const doc = readXml(files, "xl/styles.xml", "main", "styleSheet");
  const customFmts = new Map<number, string>();
  for (const nf of asArray<Record<string, unknown>>(doc?.styleSheet?.numFmts?.numFmt)) {
    const id = Number(nf["@_numFmtId"]);
    customFmts.set(id, String(nf["@_formatCode"]));
  }
  const xfs = asArray<Record<string, unknown>>(doc?.styleSheet?.cellXfs?.xf);
  return {
    numFmtByXf: xfs.map((xf) => {
      const id = Number(xf["@_numFmtId"] ?? 0);
      // A built-in with no code CoCheck can state (the locale-dependent ids) gets a label no format parser accepts, so a cell is
      // shown unformatted and never as General. Ids 14 and 22 carry the system short date label, not a pattern.
      return customFmts.get(id) ?? builtinCode(id) ?? (id < 164 ? `built-in format ${id}` : "General");
    }),
  };
}

interface RelTarget {
  id: string;
  target: string;
}

function parseRels(files: Record<string, Uint8Array>, relsPath: string): RelTarget[] {
  if (!files[relsPath]) return [];
  const doc = readXml(files, relsPath, "pkgrel", "Relationships");
  return asArray<Record<string, unknown>>(doc?.Relationships?.Relationship).map((r) => ({
    id: String(r["@_Id"]),
    target: String(r["@_Target"]),
  }));
}

/**
 * The serial number of an ISO 8601 date (`2024-01-01`, or with a time `2024-01-01T06:00:00`) in the workbook's date system, or null when
 * the text is not a date that system can hold (a `t="d"` cell with such text stays text, never a number).
 */
export function isoDateSerial(text: string, system: DateSystem): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(?:Z|[+-]00:?00)?$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || sec > 59) return null;
  let days = system === 1904 ? (day.getTime() - Date.UTC(1904, 0, 1)) / 86_400_000 : (day.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
  if (system === 1900 && days < 60) days -= 1; // Excel's 1900 is a leap year that was not: serials below 60 count from 1899-12-31
  if (days < 0) return null;
  const frac = (h * 3600 + mi * 60 + sec + Number(m[7] ?? 0)) / 86_400;
  return days + frac;
}

/** Coerces a raw `<v>` payload according to the cell's declared type. */
function coerceValue(rawV: unknown, cellType: string | undefined, sharedStrings: string[], dateSystem: DateSystem): CellSnapshot["value"] {
  if (rawV === undefined) return null;
  const text = textOf(rawV);
  switch (cellType) {
    case "s": {
      const held = sharedStrings[Number(text)];
      if (held === undefined) {
        throw new Error(`xlsx: a cell points at shared string ${text}, which the workbook does not hold`);
      }
      return held;
    }
    case "b":
      return text === "1" || text === "true";
    case "str":
      return text;
    case "e":
      return cellError(text);
    case "d": {
      if (text === "") return null;
      return isoDateSerial(text, dateSystem) ?? text;
    }
    default: {
      if (text === "") return null;
      const n = Number(text);
      return Number.isNaN(n) ? text : n;
    }
  }
}

function inlineStrText(cell: Record<string, unknown>): string {
  const is = cell["is"] as Record<string, unknown> | undefined;
  if (!is) return "";
  if (is["t"] !== undefined) return textOf(is["t"]);
  return asArray<Record<string, unknown>>(is["r"] as any)
    .map((run) => textOf(run["t"]))
    .join("");
}

/** Tracks each shared-formula group's master formula text and master cell address, keyed by `si`. */
interface SharedFormulaGroup {
  masterAddress: string;
  masterFormula: string;
}

/**
 * Rows and cells parsed per `XMLParser` call. Parsing a whole sheet at once builds a DOM node for
 * every row, cell and value before any of it is read - about 400 MB of transient heap for a
 * 150,000-row sheet - so `sheetRowChunks` feeds the parser a bounded slice at a time. Rows alone
 * don't bound it: 2,000 rows of a 550-column sheet are 1.1 million cells, so a chunk also ends
 * before the row that would take it past `CELLS_PER_CHUNK` (a single wider row is its own chunk).
 */
const ROWS_PER_CHUNK = 2000;
const CELLS_PER_CHUNK = 20_000;

/** A cell's start tag: `<c ` / `<c>` / `<c/>`, not `<col` or any other `c`-prefixed name. */
const CELL_TAG = /<c[\s>/]/g;

function countCells(xml: string, from: number, to: number): number {
  let n = 0;
  CELL_TAG.lastIndex = from;
  for (let m = CELL_TAG.exec(xml); m !== null && m.index < to; m = CELL_TAG.exec(xml)) {
    n++;
  }
  return n;
}

/**
 * The sheet's `<sheetData>` content as a series of `<sheetData>` documents of at most
 * `ROWS_PER_CHUNK` rows and `CELLS_PER_CHUNK` cells each. Rows never nest and `</row>` can't occur
 * inside cell text (it would be escaped), so cutting just after a `</row>` always leaves both
 * halves well-formed. A sheet whose `<sheetData>` is absent, self-closing (`<sheetData/>`,
 * `<sheetData />`) or an empty pair yields nothing, as the whole-sheet parse it replaced read them.
 */
function* sheetRowChunks(xml: string): Generator<string> {
  const open = /<sheetData\b([^>]*)>/.exec(xml);
  if (!open || open[1]!.endsWith("/")) return;
  const start = open.index + open[0].length;
  const end = xml.indexOf("</sheetData>", start);
  if (end < 0) {
    throw new Error("xlsx: a sheet's cell data is cut off (no closing </sheetData>)");
  }
  let pos = start;
  while (pos < end) {
    let cut = pos;
    let cells = 0;
    for (let rows = 0; rows < ROWS_PER_CHUNK && cut < end; rows++) {
      const close = xml.indexOf("</row>", cut);
      const rowEnd = close < 0 || close >= end ? end : close + "</row>".length;
      const rowCells = countCells(xml, cut, rowEnd);
      if (rows > 0 && cells + rowCells > CELLS_PER_CHUNK) {
        break;
      }
      cells += rowCells;
      cut = rowEnd;
    }
    yield `<sheetData>${xml.slice(pos, cut)}</sheetData>`;
    pos = cut;
  }
}

const COMMENT_OR_CDATA = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
const SHEET_DATA_TAG = /<sheetData(?=[\s>/])((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ROW = /<row(?=[\s>/])(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL = /<c(?=[\s>/])(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/c>)/g;

/**
 * A worksheet holds exactly one `<sheetData>`; it holds only rows, and rows only cells. The part is already
 * well-formed, so this is the structure the cell reader relies on: anything else is a sheet we cannot read, not an
 * empty or partial one. (Not schema validation: attributes, ordering and the other children are not checked.)
 */
function checkSheetData(xml: string, part: string): void {
  const bare = xml.replace(COMMENT_OR_CDATA, "");
  const tags = [...bare.matchAll(SHEET_DATA_TAG)];
  if (tags.length !== 1) {
    throw malformed(part, tags.length === 0 ? "no sheetData element" : "more than one sheetData element");
  }
  const tag = tags[0]!;
  if (tag[1]!.trimEnd().endsWith("/")) return; // self-closed: empty, and the part is otherwise well-formed
  const start = tag.index! + tag[0].length;
  const end = bare.indexOf("</sheetData>", start);
  if (end < 0) throw malformed(part, "sheetData is not closed");
  const rest = bare.slice(start, end).replace(ROW, (_row, inner: string | undefined) => {
    if (inner !== undefined && inner.replace(CELL, "").trim() !== "") {
      throw malformed(part, "a row holds something other than cells");
    }
    return "";
  });
  if (rest.trim() !== "") throw malformed(part, "sheetData holds something other than rows");
}

function readSheet(
  files: Record<string, Uint8Array>,
  sheetPath: string,
  sheetName: string,
  sharedStrings: string[],
  styles: StyleTable,
  budget: CellBudget,
  dateSystem: DateSystem,
): Map<string, CellSnapshot> {
  const bytes = files[sheetPath];
  if (!bytes) {
    throw new Error(`xlsx: missing required part ${sheetPath}`);
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  // Whole-part check before any cell is read. The validator keeps a tag stack, never a tree, so it
  // streams in effect: its memory does not grow with the part, and large sheets get no exemption.
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    throw malformed(sheetPath, valid.err.msg);
  }
  const xml = canonicalXml(text, "main", sheetPath);
  const root = rootOf(xml);
  if (root !== undefined && NO_CELL_SHEETS.has(root)) {
    return new Map(); // a chart or dialog sheet holds no cells
  }
  if (root !== "worksheet") {
    throw malformed(sheetPath, "no worksheet element");
  }
  checkSheetData(xml, sheetPath);
  const cells = new Map<string, CellSnapshot>();
  const sharedGroups = new Map<string, SharedFormulaGroup>();
  let counted = 0;

  for (const chunk of sheetRowChunks(xml)) {
    readRows((parser.parse(chunk) as any)?.sheetData?.row, sheetName, sharedStrings, styles, cells, sharedGroups, dateSystem);
    budget.used += cells.size - counted;
    counted = cells.size;
    if (budget.used > budget.max) {
      throw new WorkbookTooLarge(`over ${budget.max.toLocaleString("en-US")} cells`);
    }
  }
  return cells;
}

/** Cells read so far across a workbook's sheets, against the most it may hold. */
interface CellBudget {
  max: number;
  used: number;
}

function readRows(
  rows: unknown,
  sheetName: string,
  sharedStrings: string[],
  styles: StyleTable,
  cells: Map<string, CellSnapshot>,
  sharedGroups: Map<string, SharedFormulaGroup>,
  dateSystem: DateSystem,
): void {
  for (const row of asArray<Record<string, unknown>>(rows as any)) {
    for (const c of asArray<Record<string, unknown>>(row["c"] as any)) {
      const address = String(c["@_r"]);
      const cellType = c["@_t"] as string | undefined;
      const xfIndex = c["@_s"] !== undefined ? Number(c["@_s"]) : 0;
      const numFmt = styles.numFmtByXf[xfIndex] ?? "General";

      let value: CellSnapshot["value"];
      if (cellType === "inlineStr") {
        value = inlineStrText(c);
      } else {
        value = coerceValue(c["v"], cellType, sharedStrings, dateSystem);
      }

      let formula: string | null = null;
      const f = c["f"] as Record<string, unknown> | string | undefined;
      if (f !== undefined) {
        const isShared = typeof f === "object" && f["@_t"] === "shared";
        const text = typeof f === "string" ? f : (f["#text"] as string | undefined);
        if (isShared) {
          const si = String((f as Record<string, unknown>)["@_si"]);
          if (text !== undefined && text !== "") {
            // Master cell: declares the formula text (and usually a `ref` span we don't need).
            sharedGroups.set(si, { masterAddress: address, masterFormula: text });
            formula = text;
          } else {
            const group = sharedGroups.get(si);
            if (!group) {
              throw new Error(`xlsx: shared formula si=${si} referenced at ${address} before its master was seen`);
            }
            const masterPos = parseAddress(group.masterAddress);
            const herePos = parseAddress(address);
            formula = shiftFormula(group.masterFormula, herePos.col - masterPos.col, herePos.row - masterPos.row, sheetName, true);
          }
        } else {
          formula = text ?? "";
        }
      }

      cells.set(address, { address, value, formula, numFmt });
    }
  }
}

/** How many times `readWorkbookSnapshot` has been called in this process: a test counter, never read by product code. */
export const readCount = { n: 0 };

export function readWorkbookSnapshot(buffer: Uint8Array, limits: ReadLimits = {}): WorkbookSnapshot {
  readCount.n += 1;
  if (limits.maxUnzippedBytes !== undefined) {
    let unzipped = 0;
    // A filter that declines every entry reads only the zip directory's declared sizes.
    unzipSync(buffer, { filter: (entry) => ((unzipped += entry.originalSize), false) });
    if (unzipped > limits.maxUnzippedBytes) {
      throw new WorkbookTooLarge(`over ${Math.round(limits.maxUnzippedBytes / 1048576)} MB of workbook data`);
    }
  }
  const files = unzipSync(buffer);
  const workbookDoc = readXml(files, "xl/workbook.xml", "main", "workbook");
  const sheetDefs = asArray<Record<string, unknown>>(workbookDoc.workbook?.sheets?.sheet);
  if (sheetDefs.length === 0) {
    throw malformed("xl/workbook.xml", "it names no sheets");
  }
  const rels = parseRels(files, "xl/_rels/workbook.xml.rels");
  const sharedStrings = parseSharedStrings(files);
  const styles = parseStyles(files);
  const budget: CellBudget = { max: limits.maxCells ?? Infinity, used: 0 };
  const flag = String(workbookDoc?.workbook?.workbookPr?.["@_date1904"] ?? "").toLowerCase();
  const dateSystem: DateSystem = flag === "1" || flag === "true" ? 1904 : 1900;

  const sheets: SheetSnapshot[] = sheetDefs.map((def) => {
    if (def["@_name"] === undefined || def["@_r:id"] === undefined) {
      throw malformed("xl/workbook.xml", "a sheet has no name or no relationship id");
    }
    const name = String(def["@_name"]);
    const rId = String(def["@_r:id"]);
    const rel = rels.find((r) => r.id === rId);
    if (!rel) {
      throw new Error(`xlsx: sheet "${name}" has no matching relationship for ${rId}`);
    }
    const sheetPath = `xl/${rel.target.replace(/^\/?xl\//, "")}`;
    const cells = readSheet(files, sheetPath, name, sharedStrings, styles, budget, dateSystem);
    const state = String(def["@_state"] ?? "");
    return state === "hidden" || state === "veryHidden" ? { name, cells, state } : { name, cells };
  });

  return { sheets, dateSystem };
}
