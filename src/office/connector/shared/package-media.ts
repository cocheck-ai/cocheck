import { createHash } from "node:crypto";
import { posix } from "node:path";
import { unzipSync } from "fflate";
import { matchByIdentity, matchDeckSlides } from "../pptx/diff.ts";
import { readDeck } from "../pptx/reader.ts";
import { chartDiff, noiseWords, parseChart, textOf as treeText, type ChartDiff, type ChartTree, type Skip } from "./chart-diff.ts";
import { canonicalOrRaw, canonicalXml } from "./ooxml-names.ts";
import { quietApp, quietCore } from "./docprops-noise.ts";

// What a user would miss in the rows of the cell, paragraph and shape diffs: a chart or picture that came or went, and a slide that
// changed only in its design. Read straight from the package parts; never throws (an unreadable package has nothing to add).

export interface MediaChange {
  /** xlsx: `Sheet!chart`; docx: `paragraph N`; pptx: `Slide N`. */
  location: string;
  kind: "chart added" | "chart removed" | "chart moved" | "chart changed" | "image added" | "image removed" | "slide changed" | "theme changed";
  /** The chart title or the caption of the picture, when the file states one; null otherwise. */
  title: string | null;
  /** For `chart moved`: the sheet the chart left (`location` is where it now sits). */
  from?: string;
  /** For `slide changed`: what differs, in words ("a picture was replaced"), when the parts say; absent otherwise. */
  detail?: string;
}

type Parts = Record<string, Uint8Array>;

const READ = /\.(xml|rels)$|\/media\/|\/embeddings\//;
const unpack = (bytes: Uint8Array): Parts => unzipSync(bytes, { filter: (f) => READ.test(f.name) });
/** A part as text, its names written the way the readers here look them up, whatever namespace prefixes the writer chose (the text as written when it cannot be resolved). */
const text = (parts: Parts, name: string): string | null => (parts[name] ? canonicalOrRaw(Buffer.from(parts[name]!).toString("utf8"), "ooxml", name) : null);
/** A SpreadsheetML part with its names written as the namespaces say, whatever prefix the writer chose; a part that cannot be read counts as missing (this module never throws). */
function sheetmlText(parts: Parts, name: string, kind: "main" | "pkgrel"): string | null {
  const raw = parts[name] ? Buffer.from(parts[name]!).toString("utf8") : null;
  if (raw === null) return null;
  try {
    return canonicalXml(raw, kind, name);
  } catch {
    return null;
  }
}
const hashOf = (bytes: Uint8Array | undefined): string => (bytes ? createHash("sha256").update(bytes).digest("hex") : "");
/** A part's hash: an XML part by its canonical text (so a respelled copy hashes the same; an ordinary file's text is its bytes), any other part by its bytes. */
const partHash = (parts: Parts, name: string): string => {
  const xml = /\.xml$/i.test(name) ? text(parts, name) : null;
  return xml === null ? hashOf(parts[name]) : createHash("sha256").update(xml).digest("hex");
};
const unescapeXml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag: string, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** The relationships of a part: id to resolved part name (external targets left out), with the relationship type. */
function relsOf(parts: Parts, part: string, canonical = false): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  const relsPath = `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`;
  const xml = canonical ? sheetmlText(parts, relsPath, "pkgrel") : text(parts, relsPath);
  for (const tag of xml?.match(/<Relationship\s[^>]*>/g) ?? []) {
    const [id, target, type] = [attr(tag, "Id"), attr(tag, "Target"), attr(tag, "Type")];
    if (id === null || target === null || attr(tag, "TargetMode") === "External") continue;
    out.set(id, { target: target.startsWith("/") ? target.slice(1) : posix.normalize(`${posix.dirname(part)}/${target}`), type: type ?? "" }); // kept: an OOXML package part name, not a file path
  }
  return out;
}

/**
 * Text of a chart's own title (the one before the plot area), or null. A writer may leave the namespace prefix off (`<title>`, `<a:t>`) or put the
 * words in a cached string reference (`<v>`) instead of rich text, so none of those is assumed.
 */
function chartTitle(xml: string): string | null {
  const head = xml.split(/<(?:\w+:)?plotArea[\s>]/)[0]!;
  const block = /<(?:\w+:)?title>([\s\S]*?)<\/(?:\w+:)?title>/.exec(head)?.[1];
  if (block === undefined) return null;
  const words = (re: RegExp): string => [...block.matchAll(re)].map((m) => unescapeXml(m[1]!)).join("").trim();
  const t = words(/<(?:\w+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:\w+:)?t>/g) || words(/<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/g);
  return t === "" ? null : t;
}

interface Item {
  kind: "chart" | "image";
  hash: string;
  title: string | null;
  place: string;
  /** xlsx charts: the chart part's XML, so a chart edited in place can say what differs. */
  xml?: string;
  /** xlsx charts: the drawing anchor (`col,row` of the top-left cell) when the drawing states one, so two charts on a sheet can be told apart. */
  anchor?: string | null;
}

/** Items present on one side only: equal hashes cancel; for charts, what is left on the same place pairs off as a chart edited in place. */
function leftovers(before: Item[], after: Item[], pairCharts: boolean, sheets?: { before: ReadonlySet<string>; after: ReadonlySet<string> }): { removed: Item[]; added: Item[]; moved: Array<{ from: Item; to: Item }>; paired: Array<{ from: Item; to: Item }> } {
  // For a workbook the first pass cancels a chart on the same sheet; what is left with equal XML on another sheet moved.
  const take = (list: Item[], it: Item, samePlace = false): boolean => {
    const k = list.findIndex((x) => x.hash === it.hash && x.kind === it.kind && (!samePlace || x.place === it.place));
    if (k < 0) return false;
    list.splice(k, 1);
    return true;
  };
  const added = [...after];
  const moved: Array<{ from: Item; to: Item }> = [];
  let removed = before.filter((it) => !take(added, it, sheets !== undefined));
  if (sheets !== undefined) {
    const still: Item[] = [];
    for (const r of removed) {
      const k = added.findIndex((x) => x.hash === r.hash && x.kind === r.kind);
      if (k < 0) {
        still.push(r);
        continue;
      }
      const to = added.splice(k, 1)[0]!;
      // A sheet renamed with its charts is not a move: its previous name no longer exists and its new name is new.
      if (sheets.after.has(r.place) || sheets.before.has(to.place)) moved.push({ from: r, to });
    }
    removed = still;
  }
  const paired: Array<{ from: Item; to: Item }> = [];
  if (pairCharts) {
    // A chart edited in place keeps its identity: same title, else same anchor. Only a unique match on both sides pairs; with several charts on a
    // sheet nothing else does (a removal then reads removed and the survivor is never taken for it). A lone chart on a sheet pairs with its lone successor.
    const charts = (list: Item[]): Item[] => list.filter((x) => x.kind === "chart");
    const unique = (list: Item[], it: Item, key: (x: Item) => string | null | undefined): boolean => {
      const k = key(it);
      return k !== null && k !== undefined && charts(list).filter((x) => x.place === it.place && key(x) === k).length === 1;
    };
    const pair = (r: Item, a: Item): void => {
      paired.push({ from: r, to: a });
      removed.splice(removed.indexOf(r), 1);
      added.splice(added.indexOf(a), 1);
    };
    for (const key of [(x: Item) => x.title, (x: Item) => x.anchor]) {
      for (const r of charts(removed)) {
        if (!unique(removed, r, key)) continue;
        const a = charts(added).find((x) => x.place === r.place && key(x) === key(r));
        if (a !== undefined && unique(added, a, key)) pair(r, a);
      }
    }
    for (const r of charts(removed)) {
      const [was, now] = [charts(before).filter((x) => x.place === r.place), charts(after).filter((x) => x.place === r.place)];
      const a = charts(added).find((x) => x.place === r.place);
      if (was.length === 1 && now.length === 1 && a !== undefined) pair(r, a);
    }
  }
  return { removed, added, moved, paired };
}

const rowsOf = (removed: Item[], added: Item[], locate: (it: Item) => string): MediaChange[] => [
  ...removed.map((it): MediaChange => ({ location: locate(it), kind: it.kind === "chart" ? "chart removed" : "image removed", title: it.title })),
  ...added.map((it): MediaChange => ({ location: locate(it), kind: it.kind === "chart" ? "chart added" : "image added", title: it.title })),
];

// ---- xlsx: charts, by the sheet they sit on ----

/** Every chart of a workbook in sheet order then drawing order, with the sheet it sits on and its part name. */
function xlsxChartParts(parts: Parts, names: Set<string> = new Set()): Array<{ sheet: string; part: string; xml: string; chartSheet: boolean; anchor?: string | null }> {
  const out: Array<{ sheet: string; part: string; xml: string; chartSheet: boolean; anchor?: string | null }> = [];
  const workbook = sheetmlText(parts, "xl/workbook.xml", "main");
  if (workbook === null) return out;
  const rels = relsOf(parts, "xl/workbook.xml", true);
  for (const tag of workbook.match(/<sheet\s[^>]*>/g) ?? []) {
    const [name, id] = [attr(tag, "name"), attr(tag, "r:id")];
    const sheet = id === null ? undefined : rels.get(id)?.target;
    const chartSheet = id !== null && (rels.get(id)?.type ?? "").endsWith("/chartsheet");
    if (name === null || sheet === undefined) continue;
    names.add(unescapeXml(name));
    for (const rel of relsOf(parts, sheet, true).values()) {
      if (!rel.type.endsWith("/drawing")) continue;
      const drawing = text(parts, rel.target) ?? "";
      const drawingRels = relsOf(parts, rel.target, true);
      for (const m of drawing.matchAll(/<c:chart\s[^>]*r:id="([^"]*)"/g)) {
        const from = [...drawing.slice(0, m.index).matchAll(/<(?:\w+:)?from>([\s\S]*?)<\/(?:\w+:)?from>/g)].pop()?.[1];
        const cell = (tag: string): string | undefined => new RegExp(`<(?:\\w+:)?${tag}>\\s*(\\d+)\\s*<`).exec(from ?? "")?.[1];
        const anchor = cell("col") !== undefined && cell("row") !== undefined ? `${cell("col")},${cell("row")}` : null;
        const chart = drawingRels.get(m[1]!)?.target;
        const xml = chart === undefined ? null : text(parts, chart);
        if (xml !== null) out.push({ sheet: unescapeXml(name), part: chart!, xml, chartSheet, anchor });
      }
    }
  }
  return out;
}

function xlsxCharts(parts: Parts, names: Set<string> = new Set()): Item[] {
  return xlsxChartParts(parts, names).map((c) => ({ kind: "chart", hash: partHash(parts, c.part), title: chartTitle(c.xml), place: c.sheet, xml: c.xml, anchor: c.anchor }));
}

const textOf = (block: string): string | null => {
  const words = (re: RegExp): string => [...block.matchAll(re)].map((m) => unescapeXml(m[1]!)).join("").trim();
  return words(/<(?:\w+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:\w+:)?t>/g) || words(/<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/g) || null;
};
const AXES: Array<[string, string]> = [["catAx", "category axis"], ["dateAx", "date axis"], ["valAx", "value axis"], ["serAx", "series axis"]];
/** Titles of each axis kind in order, from the chart's own XML (a title before the axis's own children ends at its closing tag). */
function axisTitles(xml: string): Map<string, Array<string | null>> {
  const out = new Map<string, Array<string | null>>();
  for (const [tag] of AXES) {
    const list: Array<string | null> = [];
    for (const m of xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}[\\s>][\\s\\S]*?</(?:\\w+:)?${tag}>`, "g"))) {
      const t = /<(?:\w+:)?title>([\s\S]*?)<\/(?:\w+:)?title>/.exec(m[0])?.[1];
      list.push(t === undefined ? null : textOf(t));
    }
    out.set(tag, list);
  }
  return out;
}
const PLOTS = /<(?:\w+:)?(area|area3D|bar|bar3D|bubble|doughnut|line|line3D|ofPie|pie|pie3D|radar|scatter|stock|surface|surface3D)Chart[\s>]/g;
/** The kinds of plot a chart draws ("line", "column", "bar", "pie"), in order, one word each; a bar plot is a column plot unless its direction says bar. */
function plotKinds(xml: string): string[] {
  const kinds: string[] = [];
  for (const m of xml.matchAll(PLOTS)) {
    let kind = m[1]!.replace(/3D$/, "");
    if (kind === "bar") {
      const rest = xml.slice(m.index);
      const dir = /<(?:\w+:)?barDir\s+val="([^"]*)"/.exec(rest.slice(0, rest.search(/<\/(?:\w+:)?bar3?D?Chart>/) + 1 || undefined))?.[1];
      kind = dir === "bar" ? "bar" : "column";
    }
    kinds.push(kind);
  }
  return kinds;
}
/** The data range of each series, in order (values for most charts, y values for scatter and bubble). */
function seriesRanges(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?ser[\s>][\s\S]*?<\/(?:\w+:)?ser>/g)) {
    const f = /<(?:\w+:)?(?:val|yVal)>[\s\S]*?<(?:\w+:)?f>([^<]*)<\/(?:\w+:)?f>/.exec(m[0])?.[1];
    out.push(f === undefined ? "" : unescapeXml(f).replace(/\$/g, "").replace(/'([^' ]+)'!/g, "$1!"));
  }
  return out;
}
const q = (s: string | null): string => (s === null ? "none" : `"${s}"`);

/**
 * What differs between a chart's two XMLs, in words. The curated sentences (title, axis titles, plot type, series ranges) come first; every
 * other difference in the chart part comes from the structural diff (`chart-diff.ts`), so a change outside the curated set is still named.
 * A part whose only differences are ignored content (cached values, ids) has no lines and says which in `noise`; prefixes, attribute order
 * and whitespace are no difference at all.
 */
export function chartChangeWords(was: string, now: string): ChartDiff {
  const bits: string[] = [];
  const [tw, tn] = [chartTitle(was), chartTitle(now)];
  if (tw !== tn) bits.push(`title ${q(tw)} \u2192 ${q(tn)}`);
  const [aw, an] = [axisTitles(was), axisTitles(now)];
  for (const [tag, label] of AXES) {
    const [lw, ln] = [aw.get(tag)!, an.get(tag)!];
    for (let i = 0; i < Math.max(lw.length, ln.length); i++) {
      const [x, y] = [lw[i] ?? null, ln[i] ?? null];
      if (x !== y) bits.push(`${label} title ${q(x)} \u2192 ${q(y)}`);
    }
  }
  const [kw, kn] = [plotKinds(was).join(" + "), plotKinds(now).join(" + ")];
  const typed = kw !== kn;
  if (typed) bits.push(`type ${kw || "none"} \u2192 ${kn || "none"}`);
  const [sw, sn] = [seriesRanges(was), seriesRanges(now)];
  const gone = sw.filter((r) => !sn.includes(r));
  const came = sn.filter((r) => !sw.includes(r));
  const ranged = gone.length > 0 || came.length > 0;
  if (gone.length > 0 && came.length > 0 && sw.length === sn.length) bits.push(`series range ${gone.join(", ")} \u2192 ${came.join(", ")}`);
  else {
    if (came.length > 0) bits.push(`${came.length === 1 ? "series" : `${came.length} series`} added (${came.join(", ")})`);
    if (gone.length > 0) bits.push(`${gone.length === 1 ? "series" : `${gone.length} series`} removed (${gone.join(", ")})`);
  }
  let a: ChartTree, b: ChartTree;
  try {
    [a, b] = [parseChart(was), parseChart(now)];
  } catch {
    // an unreadable chart part: the curated sentences, else a plain statement that it differs (never nothing)
    return { lines: bits.length > 0 ? bits : was === now ? [] : ["its chart part changed (unreadable)"], noise: [] };
  }
  // what a curated sentence already said is not said twice
  const skip: Skip = (el, path, pair) => {
    const parent = path[path.length - 1];
    if (el.name === "title" && (parent?.name === "chart" || /^(cat|val|date|ser)Ax$/.test(parent?.name ?? ""))) return pair.a === undefined || pair.b === undefined;
    if (el.name === "tx" && parent?.name === "title") return treeText(pair.a) !== treeText(pair.b);
    if (typed && parent?.name === "plotArea" && /Chart$/.test(el.name)) return true;
    if (ranged && el.name === "ser") return pair.a === undefined || pair.b === undefined;
    if (ranged && el.name === "f" && /^(val|yVal)$/.test(path[path.length - 2]?.name ?? "")) return true;
    return false;
  };
  const d = chartDiff(a, b, skip);
  return { lines: [...bits, ...d.lines], noise: bits.length > 0 ? [] : d.noise };
}

/** `chartChangeWords` as one detail string: the named differences, the ignored-only sentence, or undefined when the parts mean the same chart. */
export function xlsxChartDetail(was: string, now: string): string | undefined {
  const d = chartChangeWords(was, now);
  return d.lines.length > 0 ? d.lines.join("; ") : d.noise.length > 0 ? noiseWords(d.noise) : undefined;
}

// ---- docx: pictures and charts, with the caption beside them ----

const CAPTION_TEXT = /^(figure|fig\.?|chart|image|picture|exhibit|source)\b/i;

function docxItems(parts: Parts): Array<Item & { index: number }> {
  const xml = text(parts, "word/document.xml");
  if (xml === null) return [];
  const rels = relsOf(parts, "word/document.xml");
  const paragraphs = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? [];
  const words = paragraphs.map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unescapeXml(m[1]!)).join("").trim());
  const items: Array<Item & { index: number }> = [];
  paragraphs.forEach((p, i) => {
    const found: Array<{ kind: "chart" | "image"; id: string }> = [
      ...[...p.matchAll(/<a:blip\s[^>]*r:embed="([^"]*)"/g)].map((m) => ({ kind: "image" as const, id: m[1]! })),
      ...[...p.matchAll(/<c:chart\s[^>]*r:id="([^"]*)"/g)].map((m) => ({ kind: "chart" as const, id: m[1]! })),
    ];
    for (const f of found) {
      const target = rels.get(f.id)?.target;
      if (target === undefined) continue;
      const next = paragraphs[i + 1];
      const nextIsCaption = next !== undefined && words[i + 1] !== "" && (/<w:pStyle\s[^>]*w:val="[^"]*caption/i.test(next) || CAPTION_TEXT.test(words[i + 1]!));
      const caption = words[i] !== "" ? words[i]! : nextIsCaption ? words[i + 1]! : null;
      const xml = f.kind === "chart" ? text(parts, target) : null;
      items.push({ kind: f.kind, hash: partHash(parts, target), title: caption, place: caption ?? "", index: i + 1, ...(xml !== null ? { xml } : {}) });
    }
  });
  return items;
}

/**
 * Charts of a document edited in place, with what differs in words (the shared chart diff). Charts pair in document order when both sides
 * hold the same number of them; a chart whose part differs only in ignored content (cached values, ids) has no entry. Empty for an unreadable package.
 */
export function docxChartChanges(a: Uint8Array, b: Uint8Array): Array<{ index: number; title: string | null; lines: string[] }> {
  try {
    const [x, y] = [docxItems(unpack(a)).filter((it) => it.kind === "chart"), docxItems(unpack(b)).filter((it) => it.kind === "chart")];
    if (x.length !== y.length) return [];
    return y.flatMap((now, k) => {
      const was = x[k]!;
      if (was.hash === now.hash || was.xml === undefined || now.xml === undefined) return [];
      const { lines } = chartChangeWords(was.xml, now.xml);
      return lines.length === 0 ? [] : [{ index: now.index, title: now.title, lines }];
    });
  } catch {
    return [];
  }
}

// ---- pptx: slides whose design or media changed ----

interface DeckSlide {
  id: string;
  /** Layout, master and theme hashes apart, so a change can name the one that differs. */
  layout: string;
  master: string;
  theme: string;
  themePart: string | null;
  /** The slide's own XML mentions a theme colour or font (`schemeClr`, `+mn-lt`), or one of its charts does. */
  usesTheme: boolean;
  /** The layout or master the slide sits on names a theme colour or font. */
  designUsesTheme: boolean;
  chartParts: Array<{ hash: string; part: string }>;
  signature: string;
  /** The parts the signature is made of, kept apart so a change can say which one differs. */
  xml: string;
  design: string;
  images: string[];
  charts: string[];
}

/**
 * A slide's hash with its CoCheck tag references left out: writing a tag adds a `p:tags` entry to a shape's `custDataLst` (and a tags part and
 * relationship, which the signature never reads), and that alone is not a change to what the slide draws.
 */
function slideHash(parts: Parts, name: string): string {
  const xml = text(parts, name);
  if (xml === null) return "";
  const bare = xml.replace(/<((?:\w+:)?)tags\s[^>]*\/>/g, "").replace(/<((?:\w+:)?)custDataLst>\s*<\/\1custDataLst>/g, "").replace(/<(?:\w+:)?custDataLst\s*\/>/g, "");
  return createHash("sha256").update(bare).digest("hex");
}

const THEME_USE = /schemeClr|"\+m[jn]-/;

function pptxSlides(parts: Parts): DeckSlide[] {
  const xml = text(parts, "ppt/presentation.xml");
  if (xml === null) return [];
  const rels = relsOf(parts, "ppt/presentation.xml");
  const out: DeckSlide[] = [];
  for (const tag of xml.match(/<p:sldId\s[^>]*>/g) ?? []) {
    const [id, rid] = [attr(tag, "id"), attr(tag, "r:id")];
    const slide = rid === null ? undefined : rels.get(rid)?.target;
    if (id === null || slide === undefined) continue;
    const slideXml = slideHash(parts, slide);
    const sig = [slideXml];
    const design: string[] = [];
    let layout = "", master = "", theme = "", themePart: string | null = null;
    const chartParts: Array<{ hash: string; part: string }> = [];
    let designUsesTheme = false;
    let usesTheme = THEME_USE.test(text(parts, slide) ?? "");
    const images: string[] = [];
    const charts: string[] = [];
    for (const rel of relsOf(parts, slide).values()) {
      if (/\/(slideLayout)$/.test(rel.type)) {
        layout = partHash(parts, rel.target);
        if (THEME_USE.test(text(parts, rel.target) ?? "")) designUsesTheme = true;
        design.push(layout);
        for (const up of relsOf(parts, rel.target).values()) {
          if (!up.type.endsWith("/slideMaster")) continue;
          master = partHash(parts, up.target);
          if (THEME_USE.test(text(parts, up.target) ?? "")) designUsesTheme = true;
          design.push(master);
          for (const th of relsOf(parts, up.target).values()) if (th.type.endsWith("/theme")) { theme = partHash(parts, th.target); themePart = th.target; design.push(theme); }
        }
      } else if (/\/(image|chart|oleObject|package)$/.test(rel.type)) {
        const h = partHash(parts, rel.target);
        sig.push(h);
        if (rel.type.endsWith("/image")) images.push(h);
        else if (rel.type.endsWith("/chart")) {
          charts.push(h);
          chartParts.push({ hash: h, part: rel.target });
          if (THEME_USE.test(text(parts, rel.target) ?? "")) usesTheme = true;
        }
      }
    }
    // The signature keeps its order: layout, master and theme hashes come before the media hashes, as they always did.
    const media = sig.slice(1);
    out.push({ id, layout, master, theme, themePart, usesTheme, designUsesTheme, chartParts, signature: [slideXml, ...design, ...media].join(":"), xml: slideXml, design: design.join(":"), images: images.sort(), charts: charts.sort() });
  }
  return out;
}

/** Hashes in `a` with no partner in `b`, as a multiset difference. */
function unmatched(a: string[], b: string[]): number {
  const rest = [...b];
  let n = 0;
  for (const h of a) {
    const k = rest.indexOf(h);
    if (k < 0) n++;
    else rest.splice(k, 1);
  }
  return n;
}

const xmlName = (xml: string, tag: string): string | null => new RegExp(`<${tag}\\s[^>]*?name="([^"]*)"`).exec(xml)?.[1] ?? null;
const inner = (xml: string, tag: string): string => new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`).exec(xml)?.[0].replace(/\sname="[^"]*"/, "") ?? "";

/** The precise sentence for one changed chart, from its two XMLs: the named differences from the shared chart diff; "a chart changed" alone only when nothing it draws differs. */
function chartSentence(was: string | null, now: string | null): string {
  if (was === null || now === null) return "a chart changed";
  const markers = (x: string): string[] => x.match(/<c:marker>[\s\S]*?<\/c:marker>/g) ?? [];
  const strip = (x: string): string => x.replace(/<c:marker>[\s\S]*?<\/c:marker>/g, "<c:marker/>");
  const [mw, mn] = [markers(was), markers(now)];
  if (strip(was) === strip(now) && mw.length === mn.length && mw.length > 0) {
    const dash = (m: string): string => /<a:prstDash\s+val="([^"]*)"/.exec(m)?.[1] ?? "solid";
    const dashed = mw.map((m, k) => [dash(m), dash(mn[k]!)] as const).filter(([a, b]) => a !== b);
    const rest = mw.every((m, k) => m.replace(/<a:prstDash[^>]*\/>/g, "") === mn[k]!.replace(/<a:prstDash[^>]*\/>/g, ""));
    if (dashed.length > 0 && rest) return `line-marker outline dash: ${dashed[0]![0]} \u2192 ${dashed[0]![1]} (the line itself is unchanged)`;
  }
  const { lines } = chartChangeWords(was, now);
  return lines.length > 0 ? `a chart changed: ${lines.join("; ")}` : "a chart changed";
}

/** The deck-level sentence for a changed theme: what differs between the two theme parts and which slides draw from it. */
function themeSentence(was: string | null, now: string | null, slides: number[], usesTheme: boolean, designUsesTheme: boolean): string {
  const bits: string[] = [];
  if (was !== null && now !== null) {
    const [a, b] = [xmlName(was, "a:theme"), xmlName(now, "a:theme")];
    if (a !== b) bits.push(`renamed${a === null ? "" : ` "${a}"`} to${b === null ? " another name" : ` "${b}"`}`);
    if (inner(was, "a:clrScheme") !== inner(now, "a:clrScheme")) bits.push("palette colours replaced");
    if (inner(was, "a:fontScheme") !== inner(now, "a:fontScheme")) bits.push("fonts replaced");
    if (inner(was, "a:fmtScheme") !== inner(now, "a:fmtScheme")) bits.push("effect styles replaced");
  }
  const what = bits.length > 0 ? bits.join(", ") : "its definition changed";
  const tail = usesTheme ? "some of their shapes or charts name theme colours or fonts, so they may look different" : designUsesTheme ? "no shape or chart on them names a theme colour or font, but their layout or master does, so text or backgrounds drawn from it may look different" : "no shape, chart, layout or master on them names a theme colour or font, so nothing on the slides looks different";
  return `the deck's theme changed (${what}); slide${slides.length === 1 ? "" : "s"} ${pageList(slides)} use${slides.length === 1 ? "s" : ""} it, and ${tail}`;
}

const pageList = (ns: number[]): string => {
  const out: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j]! + 1) j++;
    out.push(j > i + 1 ? `${ns[i]}-${ns[j]}` : ns.slice(i, j + 1).join(", "));
    i = j;
  }
  return out.join(", ");
};

/** What differs between one slide's two sides, in words, from the parts the signature is made of; undefined when none of them says. The theme is left to the deck row. */
function slideDetail(was: DeckSlide, now: DeckSlide, before: Parts, after: Parts): string | undefined {
  const parts: string[] = [];
  const gone = unmatched(was.images, now.images), came = unmatched(now.images, was.images);
  if (gone > 0 && came > 0) parts.push("a picture was replaced");
  else if (came > 0) parts.push("a picture was added");
  else if (gone > 0) parts.push("a picture was removed");
  if (unmatched(was.charts, now.charts) + unmatched(now.charts, was.charts) > 0) {
    const [w, n] = [was.chartParts.filter((c) => !now.chartParts.some((d) => d.hash === c.hash)), now.chartParts.filter((c) => !was.chartParts.some((d) => d.hash === c.hash))];
    parts.push(w.length === 1 && n.length === 1 ? chartSentence(text(before, w[0]!.part), text(after, n[0]!.part)) : "a chart changed");
  }
  if (was.layout !== now.layout) parts.push("its layout changed");
  if (was.master !== now.master) parts.push("its master changed");
  if (was.xml !== now.xml) parts.push("its shapes or text changed");
  return parts.length === 0 ? undefined : parts.join("; ");
}

/** Slides that exist on both sides and differ in anything the slide draws from: its XML, layout, master, pictures or charts, and one deck row for a changed theme. */
function slideChanges(before: Parts, after: Parts, pairing: Map<number, number> | null): MediaChange[] {
  const wasList = pptxSlides(before);
  const nowList = pptxSlides(after);
  // a deck the reader cannot read has no pairing: ids pair only when proven trusted (same rule as matchDeckSlides), else removed plus added
  pairing ??= matchByIdentity(wasList.map((s) => s.id), wasList.map((s) => s.signature), nowList.map((s) => s.id), nowList.map((s) => s.signature));
  const beforeOf = new Map([...pairing].map(([i, j]) => [j, i]));
  const out: MediaChange[] = [];
  const themed: Array<{ n: number; was: DeckSlide; now: DeckSlide }> = [];
  nowList.forEach((s, j) => {
    // the pairing is the deck diff's one slide-identity map (not the sldId alone, which a tool that renumbers can collide); a deck the
    // reader cannot read falls back to the sldId
    const old = wasList[beforeOf.get(j) ?? -1];
    if (old === undefined) return;
    if (old.theme !== s.theme) themed.push({ n: j + 1, was: old, now: s });
    const detail = slideDetail(old, s, before, after);
    // A slide whose only difference is the theme has no row of its own: the deck row below says it once.
    if (old.signature !== s.signature && detail !== undefined) out.push({ location: `Slide ${j + 1}`, kind: "slide changed", title: null, detail });
    else if (old.signature !== s.signature && old.theme === s.theme) out.push({ location: `Slide ${j + 1}`, kind: "slide changed", title: null });
  });
  if (themed.length > 0) {
    const first = themed[0]!;
    const sentence = themeSentence(first.was.themePart === null ? null : text(before, first.was.themePart), first.now.themePart === null ? null : text(after, first.now.themePart), themed.map((t) => t.n), themed.some((t) => t.now.usesTheme), themed.some((t) => t.now.designUsesTheme));
    out.push({ location: "Deck", kind: "theme changed", title: null, detail: sentence });
  }
  return out;
}

/** What `ext` files gained or lost in charts and pictures, and which slides changed; empty for any other file or one that cannot be read. */
export function mediaChanges(ext: string, a: Uint8Array | null, b: Uint8Array): MediaChange[] {
  try {
    // No earlier file (a created workbook) means every chart is new.
    const [before, after] = [a === null ? {} : unpack(a), unpack(b)];
    if (/^\.xls[xm]$/.test(ext)) {
      const [was, now] = [new Set<string>(), new Set<string>()];
      const { removed, added, moved, paired } = leftovers(xlsxCharts(before, was), xlsxCharts(after, now), true, { before: was, after: now });
      const where = (it: Item): string => `${it.place}!chart`;
      // A chart on the same sheet whose XML differs was edited in place (a writer may renumber its part; the part name is never compared). One that differs only in what this reader does not name (prefixes, ordering, cached values) has no row.
      const changed = paired.flatMap((p): MediaChange[] => {
        const { lines } = chartChangeWords(p.from.xml ?? "", p.to.xml ?? "");
        // Nothing the chart draws differs: a rewrite's prefixes, ordering, ids, or cached values that follow a cell edit. The cell rows carry those, so no chart row.
        return lines.length === 0 ? [] : [{ location: where(p.to), kind: "chart changed", title: p.to.title, detail: lines.join("; ") }];
      });
      return [...rowsOf(removed, added, where), ...moved.map((m): MediaChange => ({ location: where(m.to), kind: "chart moved", title: m.to.title, from: m.from.place })), ...changed];
    }
    if (ext === ".docx") {
      const [x, y] = [docxItems(before), docxItems(after)];
      const { removed, added } = leftovers(x, y, true);
      const at = (it: Item): string => `paragraph ${(it as Item & { index: number }).index}`;
      return rowsOf(removed, added, at);
    }
    if (/^\.pptx?m?$/.test(ext)) {
      let pairing: Map<number, number> | null = null;
      try {
        pairing = matchDeckSlides(a === null ? { slides: [] } : readDeck(a), readDeck(b));
      } catch {
        pairing = null;
      }
      return slideChanges(before, after, pairing);
    }
  } catch {
    // an unreadable package adds nothing
  }
  return [];
}

/** The most uncompressed bytes of one package that `partsIdentical` unpacks; a bigger one is not compared (and so never called identical). Same bound as the pptx reader's part cap. */
export const IDENTICAL_PARTS_CAP = 64 * 1024 * 1024;

/** The uncompressed size the zip directory declares for the whole package, read without inflating any part. */
export function declaredSize(bytes: Uint8Array): number {
  let total = 0;
  unzipSync(bytes, { filter: (f) => { total += f.originalSize; return false; } });
  return total;
}

/** Unpack every part, but only after the declared sizes (both packages, when given two) are known to fit under `cap`; throws past it. */
function unpackWithin(cap: number, ...packages: Uint8Array[]): Parts[] {
  if (packages.reduce((sum, p) => sum + declaredSize(p), 0) > cap) throw new Error("package too large to compare");
  return packages.map((p) => unzipSync(p));
}

/**
 * Both packages hold the same part names and every part is byte-identical (only the zip's own entry timestamps or compression differ).
 * An unreadable package, or one past the size cap (checked from the zip directory before any part is inflated), is false: the answer errs toward "something differs".
 */
export function partsIdentical(a: Uint8Array, b: Uint8Array, cap: number = IDENTICAL_PARTS_CAP): boolean {
  try {
    const [pa, pb] = unpackWithin(cap, a, b) as [Parts, Parts];
    const names = Object.keys(pa).sort();
    const other = Object.keys(pb).sort();
    if (names.length !== other.length || names.some((n, i) => n !== other[i])) return false;
    return names.every((n) => Buffer.compare(pa[n]!, pb[n]!) === 0);
  } catch {
    return false;
  }
}

/** Part name to the plain words a user would use, in the order the note lists them. The docx branch calls this only when paragraph text is equal, so an equal-text word/document.xml is formatting. */
const PART_WORDS: Array<[RegExp, string]> = [
  [/^word\/styles\.xml$/, "styles"],
  [/^word\/document\.xml$/, "paragraph formatting"],
  [/^word\/header[^/]*\.xml$/, "headers"],
  [/^word\/footer[^/]*\.xml$/, "footers"],
  [/^word\/numbering\.xml$/, "list numbering"],
  [/^word\/settings\.xml$/, "document settings"],
  [/^docProps\//, "file details"],
  [/^word\/media\//, "pictures"],
  [/^word\/theme\//, "theme"],
];
const OTHER_PARTS = "other parts";

/**
 * The plain names of the package parts that differ (a part on one side only counts as differing), in the fixed order of PART_WORDS with "other parts" last and once.
 * [] means every part is byte-identical (same answer as `partsIdentical`). null means unknown: an unreadable package or one past the size cap (same cap, same pre-inflate check), so the caller keeps its generic wording.
 */
export function differingParts(a: Uint8Array, b: Uint8Array, cap: number = IDENTICAL_PARTS_CAP): string[] | null {
  try {
    const [pa, pb] = unpackWithin(cap, a, b) as [Parts, Parts];
    const differ = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((n) => !n.endsWith("/") && (pa[n] === undefined || pb[n] === undefined || Buffer.compare(pa[n]!, pb[n]!) !== 0));
    const words = new Set(differ.map((n) => PART_WORDS.find(([re]) => re.test(n))?.[1] ?? OTHER_PARTS));
    return [...PART_WORDS.map(([, w]) => w), OTHER_PARTS].filter((w, i, all) => words.has(w) && all.indexOf(w) === i);
  } catch {
    return null;
  }
}

const SECTION_ID = /(<p14:section\b[^>]*?\bid=")\{[^}]*\}(")/g;

/**
 * A plain re-save of a deck adds its guide list (`p15:sldGuideLst`, the editor's drawing guides, never drawn) to the
 * presentation part. One extension element whose only content is that list is removed, and an extension list it leaves empty with it;
 * nothing else in the part is touched.
 */
const GUIDE_EXT = /<(\w+:)?ext\b[^>]*>\s*<p15:sldGuideLst\b(?:[^>]*\/>|[\s\S]*?<\/p15:sldGuideLst>)\s*<\/\1ext>/g;
const EMPTY_EXT_LIST = /<(\w+:)?extLst\b[^>]*>\s*<\/\1extLst>/g;
const withoutGuides = (text: string): string => text.replace(GUIDE_EXT, "").replace(EMPTY_EXT_LIST, "");

/** Same part names, and every part that differs passes `allowed`. An unreadable or over-cap package is false. */
function onlyAllowedDiffer(a: Uint8Array, b: Uint8Array, cap: number, allowed: (name: string, x: Uint8Array, y: Uint8Array) => boolean): boolean {
  try {
    const [pa, pb] = unpackWithin(cap, a, b) as [Parts, Parts];
    const names = Object.keys(pa).sort();
    const other = Object.keys(pb).sort();
    if (names.length !== other.length || names.some((n, i) => n !== other[i])) return false;
    return names.every((n) => Buffer.compare(pa[n]!, pb[n]!) === 0 || allowed(n, pa[n]!, pb[n]!));
  } catch {
    return false;
  }
}

/** The core properties part and its app properties sibling, in the package's properties folder: what any plain re-save rewrites. */
const PROPS_DIR = "docProps";
/**
 * The creation time, set aside only by the re-save check: a file written again from scratch with the same body (a script regenerating it)
 * gets a fresh one, and when every other part is byte-identical that is still a re-save. It stays out of the shared noise list, because
 * a reader that reports core properties (the Excel layer) still shows it.
 */
const CREATED = /<dcterms:created\b[^>]*?(?:\/>|>[\s\S]*?<\/dcterms:created\s*>)/g;
const quietResaveCore = (text: string): string => quietCore(text).replace(CREATED, "<dcterms:created/>");

/**
 * A properties part differs only in its per-save fields (modified time, last modified by, revision, and for the re-save check the creation
 * time; app's TotalTime, application and version, the parts lists): `quietCore` and `quietApp`, the one allow-list (docprops-noise.ts), plus
 * `CREATED`. A title, subject, author, keywords or company change is content and is never set aside.
 */
const onlySavedFieldsDiffer = (n: string, x: Uint8Array, y: Uint8Array): boolean => {
  const text = (u: Uint8Array): string => Buffer.from(u).toString("utf8");
  if (n === `${PROPS_DIR}/core.xml`) return quietResaveCore(text(x)) === quietResaveCore(text(y));
  if (n === `${PROPS_DIR}/app.xml`) return quietApp(text(x)) === quietApp(text(y));
  return false;
};

/** The revision namespace a spreadsheet's main part binds its `revisionPtr` to (regenerated on every save). */
const REVISION_NS = "http://schemas.microsoft.com/office/spreadsheetml/2014/revision";

/**
 * A part with the attributes of each `revisionPtr` element set aside, when its prefix is bound to the revision namespace in that part; the
 * text unchanged otherwise.
 */
function withoutRevisionAttributes(text: string): string {
  return text.replace(/<(\w+):revisionPtr\b[^>]*?(\/?)>/g, (tag, prefix: string, end: string) => (text.includes(`xmlns:${prefix}="${REVISION_NS}"`) ? `<${prefix}:revisionPtr${end}>` : tag));
}

/**
 * Two spreadsheet packages differ only in saved-file details, the parts a plain re-save rewrites: the core and app
 * properties, and any part whose only difference is the attributes of its revision-namespace `revisionPtr` element. Anything else
 * (another part, a part added or removed, any other attribute or element) is false.
 */
export function xlsxOnlySavedDetailsDiffer(a: Uint8Array, b: Uint8Array, cap: number = IDENTICAL_PARTS_CAP): boolean {
  const text = (u: Uint8Array): string => Buffer.from(u).toString("utf8");
  return onlyAllowedDiffer(a, b, cap, (n, x, y) => onlySavedFieldsDiffer(n, x, y) || withoutRevisionAttributes(text(x)) === withoutRevisionAttributes(text(y)));
}

/** Two document packages differ only in the core and app properties, what a plain re-save rewrites. */
export function docxOnlySavedDetailsDiffer(a: Uint8Array, b: Uint8Array, cap: number = IDENTICAL_PARTS_CAP): boolean {
  return onlyAllowedDiffer(a, b, cap, onlySavedFieldsDiffer);
}

/**
 * Two decks differ only in saved-file details: the same part names, and every part that differs is on the allow-list: docProps/core.xml and docProps/app.xml in their per-save fields,
 * ppt/presentation.xml once its p14 section ids are normalized and its guide list set aside, and an embedded workbook that differs only in its own per-save fields.
 * Anything else (presProps, tableStyles, viewProps, a slide, a theme...) is false, as is an unreadable or over-cap package.
 */
export function pptxOnlySavedDetailsDiffer(a: Uint8Array, b: Uint8Array, cap: number = IDENTICAL_PARTS_CAP): boolean {
  try {
    const [pa, pb] = unpackWithin(cap, a, b) as [Parts, Parts];
    const names = Object.keys(pa).sort();
    const other = Object.keys(pb).sort();
    if (names.length !== other.length || names.some((n, i) => n !== other[i])) return false;
    const text = (u: Uint8Array): string => Buffer.from(u).toString("utf8");
    return names.every((n) => {
      if (Buffer.compare(pa[n]!, pb[n]!) === 0) return true;
      if (onlySavedFieldsDiffer(n, pa[n]!, pb[n]!)) return true;
      if (n === "ppt/presentation.xml") return withoutGuides(text(pa[n]!).replace(SECTION_ID, "$1$2")) === withoutGuides(text(pb[n]!).replace(SECTION_ID, "$1$2"));
      if (/^ppt\/embeddings\/[^/]+\.xlsx$/i.test(n)) {
        const [x, y] = unpackWithin(cap, pa[n]!, pb[n]!) as [Parts, Parts];
        const inner = Object.keys(x).sort();
        const innerOther = Object.keys(y).sort();
        if (inner.length !== innerOther.length || inner.some((m, i) => m !== innerOther[i])) return false;
        return inner.every((m) => Buffer.compare(x[m]!, y[m]!) === 0 || onlySavedFieldsDiffer(m, x[m]!, y[m]!));
      }
      return false;
    });
  } catch {
    return false;
  }
}
