import { inflateBounded, type ZipPart } from "./layer.ts";

/**
 * The universe of package parts of an Excel workbook, and what CoCheck does with each.
 *
 * Every part maps to exactly one action:
 * - "card+box": the cells or chart a reviewer sees; a change gets a card and a box in the grid.
 * - "card": a change gets a card (through the cells, formats or sheet list it carries) and no box of its own.
 * - "opaque": "changed, not interpreted". CoCheck knows the part changed and names it; it does not read it.
 * - "noise": a fixed allow-list, "file internals changed, nothing visible". Only the parts listed below (and only while they
 *   differ in the way named) are noise. Everything else, including a part this table has never heard of, is surfaced, so a part
 *   is never dropped silently.
 */
export type PartAction = "card+box" | "card" | "opaque" | "noise";

interface PartRule {
  pattern: RegExp;
  action: PartAction;
  what: string;
}

/** Ordered: the first match wins. The last rule is the default for anything unknown. */
export const PART_UNIVERSE: readonly PartRule[] = [
  { pattern: /^xl\/worksheets\/sheet[^/]*\.xml$/, action: "card+box", what: "worksheet cells, formulas, merges, widths, hidden rows and columns" },
  { pattern: /^xl\/chartsheets\/[^/]+\.xml$/, action: "card+box", what: "chart sheet" },
  { pattern: /^xl\/charts\/chart[^/]*\.xml$/, action: "card+box", what: "chart" },
  { pattern: /^xl\/sharedStrings\.xml$/, action: "card", what: "shared strings (shown through the cells that use them)" },
  { pattern: /^xl\/styles\.xml$/, action: "card", what: "number formats and cell looks" },
  { pattern: /^xl\/workbook\.xml$/, action: "card", what: "sheet list, order, visibility, date system" },
  { pattern: /^xl\/_rels\/workbook\.xml\.rels$/, action: "opaque", what: "workbook relationships" },
  { pattern: /^xl\/theme\/theme[^/]*\.xml$/, action: "card", what: "theme colours (through cell looks)" },
  { pattern: /^xl\/worksheets\/_rels\/[^/]+\.rels$/, action: "opaque", what: "sheet relationships" },
  { pattern: /^xl\/(drawings|charts)\/_rels\/[^/]+\.rels$/, action: "opaque", what: "drawing and chart relationships" },
  { pattern: /^xl\/drawings\/drawing[^/]*\.xml$/, action: "card+box", what: "drawing anchors, pictures and shapes (chart and picture comparison)" },
  { pattern: /^xl\/media\//, action: "card+box", what: "pictures (picture comparison)" },
  { pattern: /^xl\/charts\/(style|colors)[^/]*\.xml$/, action: "opaque", what: "chart style and colour parts" },
  { pattern: /^xl\/(pivotTables|pivotCache)\//, action: "opaque", what: "pivot tables and caches" },
  { pattern: /^xl\/(slicers|slicerCaches|timelines|timelineCaches)\//, action: "opaque", what: "slicers and timelines" },
  { pattern: /^xl\/embeddings\//, action: "opaque", what: "embedded objects" },
  { pattern: /^xl\/(comments[^/]*\.xml|comments\/[^/]+\.xml)$/, action: "opaque", what: "cell comments" },
  { pattern: /^xl\/(threadedComments|persons)\//, action: "opaque", what: "threaded comments and their people" },
  { pattern: /^xl\/drawings\/(vmlDrawing|commentsDrawing)[^/]*\.vml$/, action: "opaque", what: "comment box drawings" },
  { pattern: /^xl\/tables\/[^/]+\.xml$/, action: "opaque", what: "tables" },
  { pattern: /^xl\/(externalLinks|connections\.xml|queryTables|metadata\.xml|richData|vbaProject\.bin|printerSettings|ctrlProps|activeX|model|volatileDependencies\.xml)/, action: "opaque", what: "external links, connections, macros, printer settings, data model" },
  { pattern: /^xl\/calcChain\.xml$/, action: "noise", what: "calculation order cache Excel rebuilds on every save" },
  { pattern: /^docProps\/(app\.xml|core\.xml|thumbnail\.[^/]*)$/, action: "noise", what: "save details: dates, app version, preview" },
  { pattern: /^docProps\/custom\.xml$/, action: "opaque", what: "custom document properties (labels, workflow data)" },
  { pattern: /^(\[Content_Types\]\.xml|_rels\/\.rels)$/, action: "opaque", what: "package plumbing" },
  { pattern: /^customXml\//, action: "opaque", what: "custom XML" },
  { pattern: /./, action: "opaque", what: "unknown part" },
];

export function classifyPart(name: string): PartAction {
  return PART_UNIVERSE.find((r) => r.pattern.test(name))!.action;
}

/**
 * The fixed noise list, exactly these:
 *  1. xl/calcChain.xml: changed, added or removed (Excel rebuilds it; openpyxl drops it).
 *  2. docProps/app.xml and docProps/thumbnail.*: `RESAVE_NOISE`; app.xml is noise only in its per-save fields.
 *  3. docProps/core.xml: only the timestamp, last-author and revision fields (and the created date), see `comparable`.
 *  4. xl/sharedStrings.xml, when the two sides hold exactly the same string items in a different order. Any added, removed or
 *     edited item (including a rich-text run change) is not a reorder, so it is never noise; the cells that show the strings
 *     are compared on their own and a changed displayed value still gets its card.
 *  5. A formula cell whose formula and number format are unchanged and whose cached result is stored on one side only (openpyxl
 *     drops every result): no value card (diff.ts `resultNotStored`), counted by `countUnstoredResults` and said in the footer.
 * xl/workbook.xml's revision pointer is the one other noise (`comparable`), kept as before.
 */
/** The noise allow-list, one id per class. A sixth class must be added here, which is what the pin test breaks on. */
export const NOISE_CLASSES = ["calcChain", "docPropsDatesAndApp", "sharedStringsReorder", "thumbnail", "resultNotStored"] as const;
export const CALC_CHAIN = "xl/calcChain.xml";
export const SHARED_STRINGS = "xl/sharedStrings.xml";

const SI = /<(?:[\w.-]+:)?si\b[^>]*\/>|<(?:[\w.-]+:)?si\b[\s\S]*?<\/(?:[\w.-]+:)?si\s*>/g;

/** True only when both parts hold exactly the same string items, in any order. */
export function sharedStringsReordered(x: Uint8Array, y: Uint8Array): boolean {
  const items = (b: Uint8Array): string[] | null => {
    const text = Buffer.from(b).toString("utf8");
    const found = text.match(SI) ?? [];
    const rest = text.replace(SI, "").replace(/<\?xml[^>]*\?>/, "").replace(/<(?:[\w.-]+:)?sst\b[^>]*>|<\/(?:[\w.-]+:)?sst\s*>/g, "").trim();
    return rest === "" ? found.sort() : null;
  };
  const a = items(x), b = items(y);
  return a !== null && b !== null && a.length === b.length && a.every((s, i) => s === b[i]);
}

/** Whether a differing package part is in the shared-strings-reorder noise class. */
export function isReorderNoise(name: string, x: ZipPart | undefined, y: ZipPart | undefined): boolean {
  return name === SHARED_STRINGS && x !== undefined && y !== undefined && sharedStringsReordered(inflateBounded(x), inflateBounded(y));
}
