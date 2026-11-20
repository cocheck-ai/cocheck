import { createHash } from "node:crypto";
import { parseXml, type El } from "../pptx/xml.ts";

/**
 * A structural diff of a DrawingML chart part (`c:chartSpace`), the same part in xlsx, docx and pptx. Both sides are read as element
 * trees and compared semantically: namespace prefixes, attribute order and whitespace never count, and neither does content the schema
 * defines as derived from somewhere else (see NOISE). Every remaining difference is located in chart terms (which part, which property)
 * and worded; a curated word list only improves the phrasing, and an element it does not know is still named from its own tag. So any
 * change to what the chart draws is described, never dropped.
 */

/**
 * What the comparison leaves out, from the chart schema (ECMA-376 Part 1, 21.2):
 * - cached data (`numCache`, `strCache`, `multiLvlStrCache`, and the c15 `dlblRangeCache` / `dlblFieldTableCache` / `fullRef`-adjacent
 *   caches): a copy of the cells a `c:f` formula points at, rewritten whenever those cells change. The cells are the source and carry
 *   their own change; the cache is not an edit to the chart.
 * - identities: `c16:uniqueId` (a per-series GUID a writer mints), relationship ids (`r:id` on `externalData`, `userShapes`, a picture
 *   fill), and the numeric values of `axId` / `crossAx` (an axis is compared by its position, so a writer that renumbers axes is not
 *   a change, but a series moved to the other axis still is).
 * - namespace declarations and `mc:Ignorable` (they name prefixes, and prefixes never count).
 */
const CACHES = new Set(["numCache", "strCache", "multiLvlStrCache", "dlblRangeCache", "dlblFieldTableCache"]);
const IDS = new Set(["uniqueId"]);

/** A chart part's tree (the pptx reader's element tree shape: local names, raw attribute names). */
export type ChartTree = El;

export interface ChartDiff {
  /** One plain-words line per differing chart element ("value axis number format General → #,##0"). */
  lines: string[];
  /** When `lines` is empty but the parts still differ: which ignored content differs ("cached values", "internal ids"). */
  noise: string[];
}

/** Skip one element (on either side, with its whole subtree) from the comparison; `pair` holds both sides when the element exists on both. */
export type Skip = (el: El, path: readonly El[], pair: { a?: El; b?: El }) => boolean;

const local = (k: string): string => k.slice(k.indexOf(":") + 1);
const isRelId = (k: string): boolean => k.includes(":") && !k.startsWith("xmlns") && /^(id|embed|link|pict)$/.test(local(k));
const dropAttr = (k: string): boolean => k === "xmlns" || k.startsWith("xmlns:") || local(k) === "Ignorable" || isRelId(k);

const NUM = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const norm = (v: string): string => (v === "true" ? "1" : v === "false" ? "0" : NUM.test(v.trim()) ? String(Number(v)) : v);

export function parseChart(xml: string): ChartTree {
  return parseXml(xml);
}

const kid = (el: El, name: string): El | undefined => el.children.find((c) => c.name === name);
const val = (el: El | undefined): string | undefined => (el === undefined ? undefined : Object.entries(el.attrs).find(([k]) => local(k) === "val")?.[1]);
/** The words of a title or name element: its rich-text runs, else its cached string, else a literal value. */
export function textOf(el: El | undefined): string {
  if (el === undefined) return "";
  const runs: string[] = [];
  const walk = (e: El): void => {
    if (e.name === "t") runs.push(e.text);
    else e.children.forEach(walk);
  };
  walk(el);
  if (runs.length > 0) return runs.join("").trim();
  const v: string[] = [];
  const walkV = (e: El): void => {
    if (e.name === "v") v.push(e.text);
    else e.children.forEach(walkV);
  };
  walkV(el);
  return v.join("").trim();
}

/** Axis id -> position among the plot area's axes, so ids compare by which axis they mean. */
function axisOrder(root: El): Map<string, string> {
  const out = new Map<string, string>();
  const plot = find(root, "plotArea");
  let n = 0;
  for (const c of plot?.children ?? []) if (AXIS_KINDS.has(c.name)) { const id = val(kid(c, "axId")); if (id !== undefined) out.set(id, `axis ${++n}`); }
  return out;
}
function find(el: El, name: string): El | undefined {
  for (const c of el.children) {
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

const AXIS_KINDS = new Map([["valAx", "value axis"], ["catAx", "category axis"], ["dateAx", "date axis"], ["serAx", "series axis"]]);
const PLOT = /^(area|area3D|bar|bar3D|bubble|doughnut|line|line3D|ofPie|pie|pie3D|radar|scatter|stock|surface|surface3D)Chart$/;

/** An element's identity among its siblings: its name plus an index it declares (`idx` attribute or child, an extension's `uri`). */
function keyOf(el: El): string {
  const idx = el.attrs["idx"] ?? (el.name === "ser" || el.name === "dLbl" || el.name === "dPt" || el.name === "legendEntry" || el.name === "pivotFmt" ? val(kid(el, "idx")) : undefined);
  const uri = el.name === "ext" ? el.attrs["uri"] : undefined;
  return `${el.name}|${idx ?? uri ?? ""}`;
}

interface Diff {
  path: El[]; // ancestors, the element itself last
  kind: "attr" | "text" | "added" | "removed" | "replaced";
  attr?: string;
  before?: string;
  after?: string;
  a?: El;
  b?: El;
}

interface Ctx { axA: Map<string, string>; axB: Map<string, string>; skip: Skip | undefined; ignoreIds: boolean; caches: boolean }

const attrsOf = (el: El, ax: Map<string, string>, ignoreIds: boolean): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(el.attrs)) {
    if (dropAttr(k) && (ignoreIds || !isRelId(k))) continue;
    const name = local(k);
    out.set(name, ignoreIds && name === "val" && (el.name === "axId" || el.name === "crossAx") ? (ax.get(v) ?? v) : norm(v));
  }
  return out;
};

function compare(a: El, b: El, path: El[], ctx: Ctx, out: Diff[]): void {
  const here = [...path, b];
  const [xa, xb] = [attrsOf(a, ctx.axA, ctx.ignoreIds), attrsOf(b, ctx.axB, ctx.ignoreIds)];
  for (const k of new Set([...xa.keys(), ...xb.keys()])) if (xa.get(k) !== xb.get(k)) out.push({ path: here, kind: "attr", attr: k, before: xa.get(k), after: xb.get(k), a, b });
  if (a.children.length === 0 && b.children.length === 0 && a.text.trim() !== b.text.trim()) out.push({ path: here, kind: "text", before: a.text.trim(), after: b.text.trim(), a, b });
  const ignored = (e: El): boolean => (!ctx.caches && CACHES.has(e.name)) || (ctx.ignoreIds && IDS.has(e.name));
  const [ka, kb] = [a.children.filter((c) => !ignored(c)), b.children.filter((c) => !ignored(c))];
  const keyed = (list: El[]): Map<string, El> => {
    const m = new Map<string, El>();
    const seen = new Map<string, number>();
    for (const c of list) { const k = keyOf(c); const n = seen.get(k) ?? 0; seen.set(k, n + 1); m.set(`${k}#${n}`, c); }
    return m;
  };
  const [ma, mb] = [keyed(ka), keyed(kb)];
  const gone: El[] = [], came: El[] = [];
  for (const [k, x] of ma) {
    const y = mb.get(k);
    if (y === undefined) { if (!ctx.skip?.(x, here, { a: x })) gone.push(x); continue; }
    if (ctx.skip?.(y, here, { a: x, b: y })) continue;
    compare(x, y, here, ctx, out);
  }
  for (const [k, y] of mb) if (!ma.has(k) && !ctx.skip?.(y, here, { b: y })) came.push(y);
  // one element swapped for another in the same place (a solid fill for no fill, one colour model for another): one change, before -> after
  if (gone.length === 1 && came.length === 1 && gone[0]!.name !== came[0]!.name) out.push({ path: here, kind: "replaced", a: gone[0], b: came[0] });
  else {
    for (const x of gone) out.push({ path: [...here, x], kind: "removed", a: x });
    for (const y of came) out.push({ path: [...here, y], kind: "added", b: y });
  }
}

// ---- words ----

/** Element words: [word, silent when something deeper is named]. An empty word adds nothing. */
const WORDS: Record<string, [string, boolean?]> = {
  chartSpace: ["chart", true], chart: ["chart", true], plotArea: ["plot area", true], legend: ["legend"], title: ["title"], dTable: ["data table"],
  view3D: ["3-D view"], floor: ["floor"], sideWall: ["side wall"], backWall: ["back wall"], dLbls: ["data labels"], trendline: ["trendline"],
  errBars: ["error bars"], majorGridlines: ["major gridlines"], minorGridlines: ["minor gridlines"], upDownBars: ["up/down bars"], upBars: ["up bars"],
  downBars: ["down bars"], hiLowLines: ["high-low lines"], dropLines: ["drop lines"], serLines: ["series lines"], marker: ["marker"],
  spPr: ["fill and line", true], txPr: ["text", true], rich: ["text", true], tx: ["text", true], bodyPr: ["text box", true], lstStyle: ["", true],
  p: ["", true], pPr: ["", true], r: ["", true], rPr: ["", true], defRPr: ["", true], endParaRPr: ["", true], t: ["text"],
  ln: ["line"], solidFill: ["fill color"], gradFill: ["gradient fill"], noFill: ["no fill"], pattFill: ["pattern fill"], blipFill: ["picture fill"],
  srgbClr: ["", true], schemeClr: ["", true], sysClr: ["", true], prstClr: ["", true], prstDash: ["dash"], custDash: ["dash"], headEnd: ["arrow start"], tailEnd: ["arrow end"],
  effectLst: ["effects"], outerShdw: ["shadow"], glow: ["glow"], softEdge: ["soft edges"], alpha: ["transparency"], lumMod: ["brightness"], lumOff: ["brightness offset"],
  latin: ["font"], ea: ["East Asian font"], cs: ["complex-script font"],
  scaling: ["", true], min: ["minimum"], max: ["maximum"], logBase: ["log scale base"], orientation: ["direction"], majorUnit: ["major unit"],
  minorUnit: ["minor unit"], numFmt: ["number format"], delete: ["hidden"], axPos: ["position"], legendPos: ["position"], overlay: ["overlaps the plot"],
  tickLblPos: ["tick label position"], majorTickMark: ["major tick marks"], minorTickMark: ["minor tick marks"], crosses: ["crosses"], crossesAt: ["crosses at"],
  crossBetween: ["crossing"], crossAx: ["crossing axis"], axId: ["axis"], dispUnits: ["display units"], builtInUnit: ["", true], custUnit: ["custom unit"],
  dispUnitsLbl: ["display units label"], lblOffset: ["label offset"], lblAlgn: ["label alignment"], tickLblSkip: ["label interval"], tickMarkSkip: ["tick mark interval"],
  noMultiLvlLbl: ["single-level labels"], baseTimeUnit: ["base time unit"], majorTimeUnit: ["major time unit"], minorTimeUnit: ["minor time unit"], auto: ["automatic"],
  showVal: ["show values"], showCatName: ["show category names"], showSerName: ["show series names"], showPercent: ["show percentages"],
  showLegendKey: ["show legend keys"], showBubbleSize: ["show bubble sizes"], showLeaderLines: ["leader lines"], leaderLines: ["leader lines"], dLblPos: ["position"], separator: ["separator"],
  symbol: ["symbol"], size: ["size"], smooth: ["smoothing"], varyColors: ["vary colors by point"], gapWidth: ["gap width"], gapDepth: ["gap depth"], overlap: ["overlap"],
  grouping: ["grouping"], barDir: ["direction"], shape: ["shape"], plotVisOnly: ["plot visible cells only"], dispBlanksAs: ["empty cells shown as"],
  autoTitleDeleted: ["title hidden"], style: ["style"], roundedCorners: ["rounded corners"], layout: ["layout", true], manualLayout: ["position", true],
  x: ["left"], y: ["top"], w: ["width"], h: ["height"], xMode: ["left mode"], yMode: ["top mode"], wMode: ["width mode"], hMode: ["height mode"], layoutTarget: ["layout target"],
  cat: ["categories"], val: ["values"], xVal: ["x values"], yVal: ["y values"], bubbleSize: ["bubble sizes"], f: ["range"], numRef: ["", true], strRef: ["", true],
  numLit: ["values", true], strLit: ["text", true], multiLvlStrRef: ["", true], idx: ["index"], order: ["plot order"], explosion: ["explosion"],
  firstSliceAng: ["first slice angle"], holeSize: ["hole size"], invertIfNegative: ["invert if negative"], bubbleScale: ["bubble scale"], bubble3D: ["3-D bubbles"],
  showNegBubbles: ["show negative bubbles"], scatterStyle: ["scatter style"], radarStyle: ["radar style"], ofPieType: ["pie-of-pie type"], splitType: ["split type"],
  splitPos: ["split position"], secondPieSize: ["second pie size"], wireframe: ["wireframe"], bandFmts: ["band formats"],
  trendlineType: ["type"], period: ["period"], forward: ["forward forecast"], backward: ["backward forecast"], intercept: ["intercept"], dispRSqr: ["shows R-squared"],
  dispEq: ["shows equation"], trendlineLbl: ["label"], errDir: ["direction"], errBarType: ["type"], errValType: ["value type"], noEndCap: ["no end cap"], plus: ["plus values"], minus: ["minus values"],
  rotX: ["x rotation"], rotY: ["y rotation"], depthPercent: ["depth"], rAngAx: ["right-angle axes"], perspective: ["perspective"], thickness: ["thickness"],
  showHorzBorder: ["horizontal borders"], showVertBorder: ["vertical borders"], showOutline: ["outline"], showKeys: ["legend keys"], legendEntry: ["legend entry"],
  lang: ["language"], date1904: ["1904 date system"], externalData: ["linked data"], autoUpdate: ["auto update"], printSettings: ["print settings"],
  protection: ["protection"], userShapes: ["drawn shapes"], pivotSource: ["pivot source"], clrMapOvr: ["color mapping"], extLst: ["extension data", true], ext: ["", true],
  AlternateContent: ["", true], Choice: ["", true], Fallback: ["", true],
};

const ATTR_WORDS: Record<string, string> = {
  val: "", formatCode: "", sourceLinked: "linked to source", w: "width", sz: "font size", b: "bold", i: "italic", u: "underline", strike: "strikethrough",
  typeface: "", prst: "", rot: "rotation", vert: "text direction", anchor: "anchor", cap: "caps", cmpd: "compound line", algn: "alignment", kern: "kerning",
  baseline: "baseline", spc: "spacing", type: "type", len: "length", dir: "direction", dist: "distance", blurRad: "blur", lang: "", dirty: "", err: "", idx: "", uri: "",
};

const BOOL_ELEMENTS = new Set(["delete", "overlay", "smooth", "varyColors", "showVal", "showCatName", "showSerName", "showPercent", "showLegendKey", "showBubbleSize", "showLeaderLines",
  "plotVisOnly", "autoTitleDeleted", "roundedCorners", "invertIfNegative", "date1904", "noMultiLvlLbl", "bubble3D", "showNegBubbles", "wireframe", "dispRSqr", "dispEq", "noEndCap",
  "rAngAx", "showHorzBorder", "showVertBorder", "showOutline", "showKeys", "autoUpdate", "auto"]);
const BOOL_ATTRS = new Set(["sourceLinked", "b", "i"]);
const AUTO_WHEN_ABSENT = new Set(["min", "max", "majorUnit", "minorUnit", "crossesAt", "logBase"]);
const CODES: Record<string, string> = {
  r: "right", l: "left", t: "top", b: "bottom", tr: "top right", ctr: "center", inEnd: "inside end", outEnd: "outside end", inBase: "inside base", bestFit: "best fit",
  minMax: "normal", maxMin: "reversed", col: "column", bar: "bar", nextTo: "next to axis", high: "high", low: "low", none: "none", cross: "cross", in: "inside", out: "outside",
  autoZero: "automatic", gap: "gaps", zero: "zero", span: "connect points", between: "between categories", midCat: "on tick marks", clustered: "clustered", stacked: "stacked",
  percentStacked: "100% stacked", standard: "standard", solid: "solid", dash: "dash", sysDash: "dash", dot: "dot", sysDot: "dot", lgDash: "long dash", dashDot: "dash-dot",
};

const camel = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase();
const wordOf = (name: string): [string, boolean] => {
  const w = WORDS[name];
  return w === undefined ? [camel(name), false] : [w[0], w[1] ?? false];
};

/** A part's own words, from the element and where it sits (which axis, which series by name, which point). */
function partWord(el: El, parent: El | undefined, root: El): string | undefined {
  const kind = AXIS_KINDS.get(el.name);
  if (kind !== undefined) {
    const same = (parent?.children ?? []).filter((c) => c.name === el.name);
    return same.length > 1 && same.indexOf(el) > 0 ? `secondary ${kind}` : kind;
  }
  if (el.name === "ser") {
    const name = textOf(kid(el, "tx"));
    if (name !== "") return `series "${name}"`;
    const all = [...(find(root, "plotArea") ? serAll(find(root, "plotArea")!) : [])];
    return `series ${all.indexOf(el) + 1 || ""}`.trim();
  }
  if (PLOT.test(el.name)) {
    let k = el.name.replace(/Chart$/, "").replace(/3D$/, " 3-D");
    if (/^bar/.test(k)) k = val(kid(el, "barDir")) === "bar" ? k : k.replace("bar", "column");
    return `${camel(k)} plot`;
  }
  const n = Number(val(kid(el, "idx")) ?? el.attrs["idx"]);
  if (el.name === "dLbl") return `data label ${Number.isFinite(n) ? n + 1 : ""}`.trim();
  if (el.name === "dPt") return `point ${Number.isFinite(n) ? n + 1 : ""}`.trim();
  if (el.name === "legendEntry") return `legend entry ${Number.isFinite(n) ? n + 1 : ""}`.trim();
  if (el.name === "spPr" && parent?.name === "chartSpace") return "chart area";
  if (el.name === "txPr" && parent?.name === "chartSpace") return "chart text";
  if (el.name === "title" && parent?.name === "chart") return "title";
  return undefined;
}
const serAll = (el: El): El[] => el.children.flatMap((c) => (c.name === "ser" ? [c] : serAll(c)));
/** Parts that name a place on their own: the words before them are dropped ("value axis", not "plot area value axis"). */
const ANCHORS = new Set(["ser", "legend", "dTable", "view3D", "floor", "sideWall", "backWall", ...AXIS_KINDS.keys()]);

function where(path: El[], root: El): string {
  const words: Array<{ w: string; silent: boolean }> = [];
  path.forEach((el, i) => {
    const parent = path[i - 1];
    const part = partWord(el, parent, root);
    if (ANCHORS.has(el.name) || PLOT.test(el.name) || (el.name === "title" && parent?.name === "chart") || (part !== undefined && parent?.name === "chartSpace")) words.length = 0;
    if (part !== undefined) { words.push({ w: part, silent: false }); return; }
    if (el.name === "tx" && parent?.name === "ser") { words.push({ w: "name", silent: false }); return; }
    if (el.name === "solidFill" && parent?.name === "ln") { words.push({ w: "color", silent: false }); return; }
    const [w, silent] = wordOf(el.name);
    words.push({ w, silent });
  });
  const shown = words.filter((x, i) => x.w !== "" && (!x.silent || i === words.length - 1));
  // a plot's own words are dropped once a series under it is named
  return shown.map((x) => x.w).filter((w, i, all) => all.indexOf(w) === i).join(" ");
}

function shown(el: El | undefined, attr: string | undefined, v: string | undefined): string {
  if (v === undefined) {
    if (el?.name === "numFmt" && (attr === "formatCode" || attr === undefined)) return "General";
    if (el !== undefined && AUTO_WHEN_ABSENT.has(el.name)) return "auto";
    if (attr !== undefined && attr !== "val" && el !== undefined && BOOL_ATTRS.has(attr)) return "no";
    return "none";
  }
  if (el === undefined) return v;
  if ((attr === "val" && BOOL_ELEMENTS.has(el.name)) || (attr !== undefined && BOOL_ATTRS.has(attr))) return v === "1" ? "yes" : v === "0" ? "no" : v;
  if (el.name === "srgbClr" && attr === "val") return `#${v.toUpperCase()}`;
  if (attr === "sz" && NUM.test(v)) return `${Number(v) / 100} pt`;
  if (attr === "w" && el.name === "ln" && NUM.test(v)) return `${Math.round((Number(v) / 12700) * 100) / 100} pt`;
  if (attr === "val" && CODES[v] !== undefined && !/^(min|max|majorUnit|minorUnit|crossesAt|idx|order|size)$/.test(el.name)) return CODES[v]!;
  return v.length > 60 ? `${v.slice(0, 57)}...` : v;
}

/** What one element amounts to as a value: its main attribute, its text, or its name in words ("solid fill #FF0000"). */
function valueOf(el: El): string {
  const main = el.attrs["formatCode"] ?? val(el);
  if (main !== undefined) return shown(el, el.attrs["formatCode"] !== undefined ? "formatCode" : "val", norm(main));
  if (el.children.length === 0 && el.text.trim() !== "") return `"${el.text.trim()}"`;
  const [w] = wordOf(el.name);
  const name = /Clr$/.test(el.name) ? "" : w || camel(el.name);
  return [name, colourOf(el) ?? ""].filter((x) => x !== "").join(" ") || camel(el.name);
}

/** The first colour inside an element, in words: `#RRGGBB` for an RGB colour, the theme or system colour's own name otherwise. */
function colourOf(el: El): string | undefined {
  const find_ = (e: El): El | undefined => (/Clr$/.test(e.name) ? e : e.children.map(find_).find((x) => x !== undefined));
  const c = find_(el);
  if (c === undefined) return undefined;
  return c.name === "srgbClr" ? `#${(val(c) ?? "").toUpperCase()}` : (val(c) ?? c.attrs["lastClr"] ?? camel(c.name));
}

function lineOf(d: Diff, root: El): string {
  const at = where(d.path, root);
  const last = d.path[d.path.length - 1]!;
  if (d.kind === "attr") {
    const aw = ATTR_WORDS[d.attr!] ?? camel(d.attr!);
    const label = [at, aw].filter((x) => x !== "").join(" ");
    return `${label} ${shown(last, d.attr, d.before)} → ${shown(last, d.attr, d.after)}`;
  }
  if (d.kind === "text") return `${at} "${d.before}" → "${d.after}"`;
  if (d.kind === "replaced") return `${at} ${valueOf(d.a!)} → ${valueOf(d.b!)}`;
  const el = (d.a ?? d.b)!;
  const v = el.attrs["formatCode"] ?? val(el);
  // a single-valued element appearing or going is a property going from its default to a value
  if (v !== undefined && el.children.filter((c) => !CACHES.has(c.name)).length === 0) {
    const [x, y] = d.kind === "added" ? [shown(el, el.attrs["formatCode"] !== undefined ? "formatCode" : "val", undefined), valueOf(el)] : [valueOf(el), shown(el, el.attrs["formatCode"] !== undefined ? "formatCode" : "val", undefined)];
    return `${at} ${x} → ${y}`;
  }
  // a fill or line appearing or going: its colour when it has one
  const tail = colourOf(el);
  if (tail !== undefined) return d.kind === "added" ? `${at} none \u2192 ${tail}` : `${at} ${tail} \u2192 none`;
  return `${at} ${d.kind}`;
}

/** At most this many lines are listed; the rest are counted. */
export const MAX_CHART_LINES = 8;

/**
 * Every difference between two chart trees in words. `skip` leaves out elements another part of the connector already words (a title the
 * curated sentence names). With no line left, `noise` says what differed among the ignored content, and is empty when the two parts mean the
 * same chart (another prefix, attribute order, whitespace).
 */
export function chartDiff(a: ChartTree, b: ChartTree, skip?: Skip): ChartDiff {
  const run = (ignoreIds: boolean, withCaches: boolean): Diff[] => {
    const out: Diff[] = [];
    compare(a, b, [], { axA: axisOrder(a), axB: axisOrder(b), skip, ignoreIds, caches: withCaches }, out);
    return out;
  };
  const diffs = run(true, false);
  const lines = [...new Set(diffs.map((d) => lineOf(d, b)))];
  if (lines.length > MAX_CHART_LINES) lines.splice(MAX_CHART_LINES - 1, lines.length, `and ${lines.length - MAX_CHART_LINES + 1} more differences`);
  if (lines.length > 0 || diffs.length > 0) return { lines, noise: [] };
  const noise: string[] = [];
  if (run(true, true).length > 0) noise.push("cached values");
  if (run(false, false).length > 0) noise.push("internal ids");
  return { lines, noise };
}

/** A digest of what the chart draws (the tree minus everything `chartDiff` ignores), for restating a row against a later snapshot. */
export function chartDigest(t: ChartTree): string {
  const ax = axisOrder(t);
  const ser = (el: El): string => {
    if (CACHES.has(el.name) || IDS.has(el.name)) return "";
    const at = [...attrsOf(el, ax, true)].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    return `<${el.name} ${at}>${el.children.length === 0 ? el.text.trim() : el.children.map(ser).join("")}</>`;
  };
  return createHash("sha256").update(ser(t)).digest("hex").slice(0, 16);
}

/** The sentence for a chart part whose only differences are ignored content. */
export function noiseWords(noise: readonly string[]): string {
  const what = noise.map((n) => (n === "cached values" ? "its cached copy of the cell values differs" : n === "internal ids" ? "internal ids were renumbered" : `${n} differ`));
  return `nothing it draws changed (only ${what.join(" and ")})`;
}
