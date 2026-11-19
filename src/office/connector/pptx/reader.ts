import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { type Frame, type Xfrm, frameOf, inheritedXfrm, placeholderOf, readXfrm } from "./frames.ts";
import { type El, child, descendants, find, parseXml, relAttr, walk } from "./xml.ts";

/**
 * Reads a .pptx into the parts of a deck a reviewer cares about: per slide, its shapes (text,
 * table cells, chart cached values; groups walked to the leaves) and its speaker notes. Slide
 * order comes from `presentation.xml`'s `sldIdLst`, never from part names, and every part is
 * reached through relationships, so a resave that renames parts or renumbers `rId`s reads the same.
 * Anything volatile on resave (field text such as the date or slide number) is read as a placeholder.
 *
 * Text-bearing parts that are not modelled (SmartArt data and drawing, chartex charts, an unreadable
 * chart part, chart legend entries, trendline names and userShapes, alt text) are folded into a
 * per-shape hash of just their text, `Shape.unmodelled`, so an edit there is one visible row; the
 * hash ignores rIds, ids, rsids, dirty/err flags and formatting by construction.
 *
 * Destinations are read per shape (`Shape.links`) as resolved targets, never rIds, and comments per
 * slide (`Slide.comments`). `SKIPPED_RELATIONSHIPS` names every relationship type reached from a slide
 * that is deliberately not read, with the reason; a test fails on any type that is neither skipped
 * nor consumed by a reader, so a new kind of part cannot be silently ignored.
 */

export type ShapeKind = "text" | "table" | "chart" | "group" | "other";

export interface ChartSeries {
  name: string;
  /** Point index -> category label. */
  categories: Map<number, string>;
  /** Point index -> cached value text. */
  values: Map<number, string>;
  /** Point index -> custom data label text. */
  labels: Map<number, string>;
}

export interface Link {
  /** Which trigger: a click, a hover or a mouse-over. */
  trigger: "click" | "hover" | "mouseOver";
  /** The linked run text, adjacent runs sharing the link joined; empty for a link on the shape itself. */
  text: string;
  /** Resolved destination: a URL, `slide <sldId>`, an in-package part, or the bare `ppaction://` action. */
  target: string;
  /** The `sldId` of the slide a jump goes to; the diff re-expresses it through its slide matching. */
  slide?: string;
  tooltip: string;
}

export interface Comment {
  /** Stable identity within a slide: the modern comment id, or the legacy author and index. */
  key: string;
  author: string;
  /** The comment text; each reply follows on its own line as `> author: text`. */
  text: string;
}

export interface ChartData {
  title: string;
  /** Hash of the data in the embedded workbook the chart draws from (sheets and shared strings, not properties); absent when the chart has none. */
  workbook?: string;
  /** Axis titles in document order, labelled by axis kind ("category axis", "value axis (2)"...). */
  axes: { label: string; title: string }[];
  series: ChartSeries[];
}

export interface Shape {
  /** The `cNvPr` id; unique within a slide in a well-formed deck. */
  id: string;
  name: string;
  kind: ShapeKind;
  /** Enclosing groups, outermost first (ids and names). */
  scope: { id: string; name: string }[];
  /** `text`: the shape's paragraphs. */
  paragraphs?: string[];
  /** `text`: the same paragraphs with their ordered parts (the structural model). */
  structure?: Para[];
  /** `table`: cell text by row then column. */
  table?: string[][];
  /** `table`: each cell's paragraphs with their parts, by row then column. */
  tableStructure?: Para[][][];
  chart?: ChartData;
  /** Hyperlinks (click, hover, mouse-over) on the shape or its runs, in document order. */
  links?: Link[];
  /** Hash of the text-bearing content the reader does not model; absent when there is none. */
  unmodelled?: string;
  /** The shape's own `a:xfrm` offset and extent (EMU, in its group's child space); absent when it has none (a placeholder that inherits its frame). */
  xfrm?: { x: number; y: number; cx: number; cy: number };
  /** `table`: the widths of the `a:tblGrid` columns (EMU). */
  columns?: number[];
}

export interface Slide {
  /** The `sldId` id attribute: stable across a resave. */
  id: string;
  shapes: Shape[];
  /** Speaker notes paragraphs, `null` when the slide has no notes part. */
  notes: string[] | null;
  comments: Comment[];
  /** `show="0"`: the slide is hidden in the slide show. */
  hidden?: boolean;
  /** The transition in words ("fade (med)"); `null` when the slide has none. */
  transition?: string | null;
}

export interface Deck {
  slides: Slide[];
}

/** Parts larger than this (decompressed) are skipped; no slide, notes or chart part comes close. */
const MAX_PART_BYTES = 64 * 1024 * 1024;

type Parts = Map<string, El>;

function loadXmlParts(bytes: Uint8Array): Map<string, Uint8Array> {
  return new Map(
    Object.entries(
      unzipSync(bytes, {
        filter: (f) => /\.(xml|rels)$/i.test(f.name) && f.originalSize <= MAX_PART_BYTES && !/^ppt\/(media|embeddings)\//i.test(f.name),
      }),
    ),
  );
}

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** The target part of relationship `target` declared by `source`'s rels part. */
export function resolve(source: string, target: string): string {
  if (target.startsWith("/")) return normalizePath(target); // kept: an OOXML package part name, not a file path
  const dir = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
  return normalizePath(`${dir}/${target}`);
}

interface Rel {
  type: string;
  /** Resolved part name, or the URL as written when `external`. */
  target: string;
  external: boolean;
}

class Package {
  readonly #raw: Map<string, Uint8Array>;
  readonly #parsed: Parts = new Map();
  readonly #rels = new Map<string, Map<string, Rel>>();
  /** Relationship types a reader has resolved and read; see `readDeckTraced`. */
  readonly consumed = new Set<string>();
  /** Slide part name -> `sldId`, so a jump to a slide reads the same however the parts are named. */
  readonly slideIds = new Map<string, string>();

  /** The whole file, for the parts `raw` does not hold (media, embedded workbooks). */
  source: Uint8Array = new Uint8Array();

  constructor(raw: Map<string, Uint8Array>) {
    this.#raw = raw;
  }

  /** Bytes of one named part of the zip, read on demand; undefined when absent or too large. */
  blob(name: string): Uint8Array | undefined {
    try {
      return unzipSync(this.source, { filter: (f) => f.name === name && f.originalSize <= MAX_PART_BYTES })[name];
    } catch {
      return undefined;
    }
  }

  has(part: string): boolean {
    return this.#raw.has(part);
  }

  raw(part: string): Uint8Array | undefined {
    return this.#raw.get(part);
  }

  xml(part: string): El | undefined {
    let el = this.#parsed.get(part);
    if (!el) {
      const bytes = this.#raw.get(part);
      if (!bytes) return undefined;
      el = parseXml(Buffer.from(bytes).toString("utf8"));
      this.#parsed.set(part, el);
    }
    return el;
  }

  /**
   * Where a hyperlink element (`hlinkClick` and kin) goes, as a resolved target rather than an rId:
   * the URL, `slide <sldId>`, the part name, or - with no relationship - the bare `ppaction://` action.
   */
  linkTarget(part: string, link: El): { target: string; slide?: string } {
    const rel = this.use(this.rels(part).get(relAttr(link, "id") ?? ""));
    if (!rel) return { target: link.attrs["action"] ?? "" };
    if (rel.external) return { target: rel.target };
    const slide = this.slideIds.get(rel.target);
    return slide !== undefined ? { target: `slide ${slide}`, slide } : { target: rel.target };
  }

  /** Marks a relationship as read by the model and returns it. */
  use(rel: Rel | undefined): Rel | undefined {
    if (rel) this.consumed.add(rel.type);
    return rel;
  }

  /** Relationships of `part`: id -> resolved target part name. */
  rels(part: string): Map<string, Rel> {
    let map = this.#rels.get(part);
    if (!map) {
      map = new Map();
      const slash = part.lastIndexOf("/");
      const relsPart = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
      const root = this.xml(relsPart);
      for (const r of root?.children ?? []) {
        const id = r.attrs["Id"];
        const target = r.attrs["Target"];
        if (id === undefined || target === undefined) continue;
        const external = r.attrs["TargetMode"] === "External";
        map.set(id, { type: r.attrs["Type"] ?? "", target: external ? target : resolve(part, target), external });
      }
      this.#rels.set(part, map);
    }
    return map;
  }
}

/** Equation text: every `m:t` under an `a14:m` / `m:oMath`, runs joined. */
const mathText = (el: El): string =>
  walk(el)
    .filter((e) => e.name === "t")
    .map((e) => e.text)
    .join("");

/**
 * One piece of a paragraph, in document order: a text run (`r`, a direct `a:r`), a line break (`br`, text
 * "\n"), a field (`fld`) or `x` for anything nested (equation, AlternateContent pick), which no run index counts.
 */
export interface ParaPart {
  kind: "r" | "br" | "fld" | "x";
  text: string;
}

/**
 * A paragraph IS an `a:p`: its ordered parts, and their text joined. Paragraph indexes (1-based `a:p` of a
 * `txBody`) and run indexes (1-based, counting only the direct `a:r` parts, as `edit.ts` does) come from
 * this and never from splitting text on newlines, which an `a:br` also produces.
 */
export interface Para {
  text: string;
  parts: ParaPart[];
}

/** The parts of a paragraph; fields whose text changes on every resave read as a placeholder. */
function paragraphParts(p: El, nested = false, out: ParaPart[] = []): ParaPart[] {
  const push = (kind: ParaPart["kind"], text: string) => out.push({ kind: nested ? "x" : kind, text });
  for (const c of p.children) {
    if (c.name === "AlternateContent") {
      // an equation is written as Choice (a14:m) with a Fallback copy; read what PowerPoint renders
      const pick = child(c, "Choice") ?? child(c, "Fallback");
      if (pick) paragraphParts(pick, true, out);
    } else if (c.name === "m" || c.name === "oMath" || c.name === "oMathPara") {
      out.push({ kind: "x", text: mathText(c) });
    } else if (c.name === "r") {
      push("r", child(c, "t")?.text ?? "");
    } else if (c.name === "br") {
      push("br", "\n");
    } else if (c.name === "fld") {
      push("fld", fieldText(c));
    }
  }
  return out;
}

function toPara(p: El): Para {
  const parts = paragraphParts(p);
  return { text: parts.map((x) => x.text).join(""), parts };
}

const paragraphText = (p: El): string => toPara(p).text;

function fieldText(fld: El): string {
  const type = fld.attrs["type"] ?? "";
  return /^(slidenum|datetime)/i.test(type) ? `{${type}}` : (child(fld, "t")?.text ?? "");
}

/** The runs of a paragraph with their `rPr`, read the way `paragraphText` reads them. */
function paragraphRuns(p: El, out: { text: string; pr: El | undefined }[] = []): { text: string; pr: El | undefined }[] {
  for (const c of p.children) {
    if (c.name === "AlternateContent") {
      const pick = child(c, "Choice") ?? child(c, "Fallback");
      if (pick) paragraphRuns(pick, out);
    } else if (c.name === "r") {
      out.push({ text: child(c, "t")?.text ?? "", pr: child(c, "rPr") });
    } else if (c.name === "fld") {
      out.push({ text: fieldText(c), pr: child(c, "rPr") });
    }
  }
  return out;
}

const TRIGGERS: Record<string, Link["trigger"]> = { hlinkClick: "click", hlinkHover: "hover", hlinkMouseOver: "mouseOver" };

/** Links on the shape's own `cNvPr`, then (unless `shapeOnly`, as for a group) on the runs under it; neighbouring runs sharing a link read as one. */
function shapeLinks(pkg: Package, part: string, el: El, shapeOnly: boolean): Link[] {
  const out: Link[] = [];
  const make = (h: El, text: string): Link => ({ trigger: TRIGGERS[h.name]!, text, ...pkg.linkTarget(part, h), tooltip: h.attrs["tooltip"] ?? "" });
  for (const h of cNvPr(el)?.children ?? []) {
    if (TRIGGERS[h.name]) out.push(make(h, ""));
  }
  if (shapeOnly) return out;
  for (const p of walk(el).filter((e) => e.name === "p")) {
    let prev: Link[] = [];
    for (const run of paragraphRuns(p)) {
      const cur: Link[] = [];
      for (const h of run.pr?.children ?? []) {
        if (!TRIGGERS[h.name]) continue;
        const l = make(h, run.text);
        const same = prev.find((x) => x.trigger === l.trigger && x.target === l.target && x.tooltip === l.tooltip);
        if (same) same.text += run.text;
        else out.push(l);
        cur.push(same ?? l);
      }
      prev = cur;
    }
  }
  return out;
}

function bodyStructure(txBody: El | undefined): Para[] {
  return txBody ? txBody.children.filter((c) => c.name === "p").map(toPara) : [];
}

function bodyParagraphs(txBody: El | undefined): string[] {
  return bodyStructure(txBody).map((p) => p.text);
}

/** Table cells as paragraphs: rows, then columns, then the cell's `a:p` list. */
function tableStructure(tbl: El): Para[][][] {
  return tbl.children
    .filter((c) => c.name === "tr")
    .map((tr) => tr.children.filter((c) => c.name === "tc").map((tc) => bodyStructure(child(tc, "txBody"))));
}

function tableCells(tbl: El): string[][] {
  return tbl.children
    .filter((c) => c.name === "tr")
    .map((tr) =>
      tr.children
        .filter((c) => c.name === "tc")
        .map((tc) => bodyParagraphs(child(tc, "txBody")).join("\n")),
    );
}

/** The `cNvPr` of a shape element, wherever its `nv*Pr` wrapper puts it. */
function cNvPr(el: El): El | undefined {
  for (const c of el.children) {
    if (/^nv.*Pr$/.test(c.name)) return child(c, "cNvPr");
  }
  return undefined;
}

/** Alt text: the `descr` and `title` of a shape's `cNvPr`. */
function altText(pr: El | undefined): string[] {
  const out: string[] = [];
  for (const k of ["descr", "title"]) {
    const v = pr?.attrs[k];
    if (v) out.push(`alt ${k}=${v}`);
  }
  return out;
}

/** The cache element holding points: `strCache`, `numCache` or the first level of a multi-level cache. */
function cachePoints(ref: El | undefined): Map<number, string> {
  const points = new Map<number, string>();
  if (!ref) return points;
  const cache = find(ref, "strCache") ?? find(ref, "numCache") ?? find(find(ref, "multiLvlStrCache") ?? ref, "lvl");
  if (!cache) return points;
  for (const pt of cache.children.filter((c) => c.name === "pt")) {
    const idx = Number(pt.attrs["idx"]);
    if (Number.isInteger(idx)) points.set(idx, child(pt, "v")?.text ?? "");
  }
  return points;
}

const AXES: Record<string, string> = { catAx: "category axis", valAx: "value axis", dateAx: "date axis", serAx: "series axis" };

function richText(el: El): string {
  return descendants(el, "p").map(paragraphText).join("\n");
}

/** A chart or axis title: its rich text, or the string cached under a `c:strRef` when it is linked to a cell. */
function titleText(title: El | undefined): string {
  const tx = title ? child(title, "tx") : undefined;
  if (!tx) return "";
  const rich = child(tx, "rich");
  if (rich) return richText(rich);
  return [...cachePoints(child(tx, "strRef")).values()].join("\n");
}

function readChart(root: El): ChartData {
  const title = child(find(root, "chart") ?? root, "title");
  const series: ChartSeries[] = [];
  const plot = find(root, "plotArea");
  const axes: ChartData["axes"] = [];
  const seen = new Map<string, number>();
  for (const ax of plot?.children ?? []) {
    const kind = AXES[ax.name];
    if (!kind) continue;
    const n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    const t = child(ax, "title");
    axes.push({ label: `${kind} title${n === 1 ? "" : ` (${n})`}`, title: titleText(t) });
  }
  for (const ser of plot ? descendants(plot, "ser") : []) {
    const tx = child(ser, "tx");
    const name = tx ? (child(tx, "v")?.text ?? [...cachePoints(tx).values()][0] ?? "") : "";
    const labels = new Map<number, string>();
    for (const lbl of child(ser, "dLbls")?.children.filter((c) => c.name === "dLbl") ?? []) {
      const idx = Number(child(lbl, "idx")?.attrs["val"]);
      const tx = child(lbl, "tx");
      if (Number.isInteger(idx) && tx) labels.set(idx, richText(tx));
    }
    // "Value From Cells": the label text lives in a cache beside the series; a CELLRANGE field
    // inside a custom label stands for that point's cached cell
    const range = find(ser, "dlblRangeCache");
    for (const pt of range?.children.filter((c) => c.name === "pt") ?? []) {
      const idx = Number(pt.attrs["idx"]);
      if (!Number.isInteger(idx)) continue;
      const cell = child(pt, "v")?.text ?? "";
      const custom = labels.get(idx);
      labels.set(idx, custom === undefined ? cell : custom.replaceAll("[CELLRANGE]", cell));
    }
    series.push({
      name,
      labels,
      categories: cachePoints(child(ser, "cat") ?? child(ser, "xVal")),
      values: cachePoints(child(ser, "val") ?? child(ser, "yVal")),
    });
  }
  return { title: titleText(title), axes, series };
}

const digest = (tokens: string[]): string | undefined =>
  tokens.length === 0 ? undefined : createHash("sha1").update(tokens.join("\u0000")).digest("hex").slice(0, 12);

/** Every non-empty text node of a part, by element name: what a chartex or SmartArt part says, minus formulas and ids. */
function partTokens(root: El, prefix: string): string[] {
  return walk(root)
    .filter((e) => e.name !== "f" && e.text.trim() !== "")
    .map((e) => `${prefix}${e.name}=${e.text.trim()}`);
}

/** Where each hyperlink in a part goes, resolved through the part's own relationships. */
function linkTokens(pkg: Package, part: string, root: El, prefix: string): string[] {
  return walk(root)
    .filter((e) => TRIGGERS[e.name] !== undefined)
    .map((e) => {
      const { target, slide } = pkg.linkTarget(part, e);
      return `${prefix}${e.name}=${slide !== undefined ? "slide" : target}|${e.attrs["tooltip"] ?? ""}`;
    });
}

/** Text and link destinations of a part the reader has no model for; a part that cannot be read hashes as itself. */
function opaquePart(pkg: Package, part: string | undefined, prefix: string): string[] {
  const bytes = part ? pkg.raw(part) : undefined;
  if (!part || !bytes) return [`${prefix}missing`];
  try {
    const root = pkg.xml(part)!;
    return [...partTokens(root, prefix), ...linkTokens(pkg, part, root, prefix)];
  } catch {
    return [`${prefix}unreadable ${createHash("sha1").update(bytes).digest("hex")}`];
  }
}

/** Chart content the model does not carry: legend entries, trendline names and the userShapes drawing. */
function chartExtras(pkg: Package, part: string, root: El): string[] {
  const out: string[] = [];
  for (const t of walk(root).filter((e) => e.name === "trendline")) {
    out.push(`trendline=${child(t, "name")?.text ?? ""}|${child(t, "trendlineType")?.attrs["val"] ?? ""}`);
  }
  const legend = find(root, "legend");
  if (legend) {
    out.push("legend");
    for (const e of legend.children.filter((c) => c.name === "legendEntry")) {
      out.push(`legend entry ${child(e, "idx")?.attrs["val"] ?? ""} delete=${child(e, "delete")?.attrs["val"] ?? "0"}`, ...partTokens(e, "legend entry:"));
    }
  }
  for (const rel of pkg.rels(part).values()) {
    if (rel.type === REL_USER_SHAPES && pkg.use(rel)) out.push(...opaquePart(pkg, rel.target, "userShapes:"));
  }
  return out;
}

const isChartEx = (frame: El, root: El | undefined): boolean =>
  /chartex/i.test(find(frame, "graphicData")?.attrs["uri"] ?? "") || (root !== undefined && child(root, "chartData") !== undefined);

/** A shape's own offset and extent, as a spread: nothing when it has no transform of its own. */
const ownXfrm = (c: El): { xfrm?: Shape["xfrm"] } => {
  const x = readXfrm(c);
  return x ? { xfrm: { x: x.x, y: x.y, cx: x.cx, cy: x.cy } } : {};
};

/** The widths of a table's grid columns (EMU); a width that does not read is NaN, which differs from anything. */
const gridColumns = (tbl: El): number[] => (child(tbl, "tblGrid")?.children ?? []).filter((c) => c.name === "gridCol").map((c) => Number(c.attrs["w"] ?? Number.NaN));

/** Marks a group whose transform could not be read: every member inside it has no frame. */
const NO_FRAME: Xfrm = { x: 0, y: 0, cx: 0, cy: 0, rot: 0, flipH: false, flipV: false };

function readShapes(pkg: Package, slidePart: string, tree: El, frames?: { out: (Frame | undefined)[]; layout: El | undefined; master: El | undefined }): Shape[] {
  const out: Shape[] = [];
  const rels = pkg.rels(slidePart);

  // one frame per pushed shape, in the same order (frames.ts); a group's transform is carried to its members
  const frameFor = (c: El, groups: Xfrm[]): Frame | undefined => {
    if (groups.includes(NO_FRAME)) return undefined;
    const own = readXfrm(c) ?? (() => { const ph = placeholderOf(c); return ph && groups.length === 0 ? inheritedXfrm(ph, frames!.layout, frames!.master) : undefined; })();
    return own ? frameOf(own, groups) : undefined;
  };
  const walk = (el: El, scope: Shape["scope"], groups: Xfrm[]) => {
    for (const c of el.children) {
      switch (c.name) {
        case "AlternateContent": {
          // Choice is what PowerPoint renders; Fallback repeats it for older readers.
          const pick = child(c, "Choice") ?? child(c, "Fallback");
          if (pick) walk(pick, scope, groups);
          break;
        }
        case "grpSp": {
          const pr = cNvPr(c);
          const me = { id: pr?.attrs["id"] ?? "", name: pr?.attrs["name"] ?? "" };
          const links = shapeLinks(pkg, slidePart, c, true);
          out.push({ ...me, kind: "group", scope, ...(links.length ? { links } : {}), unmodelled: digest(altText(pr)), ...ownXfrm(c) });
          frames?.out.push(frameFor(c, groups));
          const gx = readXfrm(c);
          // a group without a usable transform: its members get no frame (never a guess)
          walk(c, [...scope, me], gx && gx.chCx !== undefined ? [...groups, gx] : [...groups, NO_FRAME]);
          break;
        }
        case "sp":
        case "pic":
        case "cxnSp":
        case "graphicFrame":
        case "contentPart": {
          const pr = cNvPr(c);
          const tokens = altText(pr);
          const base = { id: pr?.attrs["id"] ?? "", name: pr?.attrs["name"] ?? "", scope };
          const links = shapeLinks(pkg, slidePart, c, false);
          const done = (shape: Shape) => { out.push({ ...shape, ...(links.length ? { links } : {}), unmodelled: digest(tokens), ...ownXfrm(c) }); frames?.out.push(frameFor(c, groups)); };
          if (c.name === "sp" && child(c, "txBody")) {
            done({ ...base, kind: "text", paragraphs: bodyParagraphs(child(c, "txBody")), structure: bodyStructure(child(c, "txBody")) });
          } else if (c.name === "graphicFrame") {
            const tbl = find(c, "tbl");
            const chartRef = find(c, "chart");
            if (tbl) {
              done({ ...base, kind: "table", table: tableCells(tbl), tableStructure: tableStructure(tbl), columns: gridColumns(tbl) });
            } else if (chartRef) {
              const part = pkg.use(rels.get(relAttr(chartRef, "id") ?? ""))?.target;
              let root: El | undefined;
              try {
                root = part ? pkg.xml(part) : undefined;
              } catch {
                root = undefined;
              }
              if (root && !isChartEx(c, root)) {
                tokens.push(...chartExtras(pkg, part!, root));
                const wbPart = [...pkg.rels(part!).values()].find((r) => !r.external && r.type === `${REL}/package`)?.target;
                const wb = wbPart ? pkg.blob(wbPart) : undefined;
                done({ ...base, kind: "chart", chart: { ...readChart(root), ...(wb ? { workbook: workbookData(wb) } : {}) } });
              } else {
                tokens.push(...opaquePart(pkg, part, "chart:"));
                done({ ...base, kind: "other" });
              }
            } else {
              const relIds = find(c, "relIds");
              if (relIds) {
                const data = pkg.use(rels.get(relAttr(relIds, "dm") ?? ""))?.target;
                tokens.push(...opaquePart(pkg, data, "diagram:"));
                // the pre-rendered drawing is what PowerPoint shows; the data part points at it by relId
                let drawingId: string | undefined;
                try {
                  drawingId = data ? find(pkg.xml(data)!, "dataModelExt")?.attrs["relId"] : undefined;
                } catch {
                  // an unreadable data part already hashed as itself
                }
                const drawing = drawingId ? pkg.use(rels.get(drawingId)) : undefined;
                if (drawing) tokens.push(...opaquePart(pkg, drawing.target, "drawing:"));
              }
              done({ ...base, kind: "other" });
            }
          } else {
            done({ ...base, kind: "other" });
          }
          break;
        }
        default:
          break;
      }
    }
  };
  walk(tree, [], []);
  return out;
}

/** Notes text: every body-like placeholder, skipping the slide image, number, header, footer and date. */
function readNotes(pkg: Package, notesPart: string): string[] {
  const root = pkg.xml(notesPart);
  const tree = root ? find(root, "spTree") : undefined;
  if (!tree) return [];
  const out: string[] = [];
  for (const sp of descendants(tree, "sp")) {
    const ph = find(sp, "ph");
    if (ph && /^(sldImg|sldNum|hdr|ftr|dt)$/.test(ph.attrs["type"] ?? "")) continue;
    out.push(...bodyParagraphs(child(sp, "txBody")));
  }
  return out;
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_OFFICE_DOCUMENT = /\/officeDocument$/;
const REL_SLIDE = /\/slide$/;
const REL_NOTES = /\/notesSlide$/;
const REL_USER_SHAPES = `${REL}/chartUserShapes`;
const REL_COMMENTS = `${REL}/comments`;
const REL_COMMENT_AUTHORS = `${REL}/commentAuthors`;
const REL_MODERN_COMMENTS = "http://schemas.microsoft.com/office/2018/10/relationships/comments";
const REL_MODERN_AUTHORS = "http://schemas.microsoft.com/office/2018/10/relationships/authors";

/**
 * Relationship types reachable from a slide that are deliberately not read, with why. Anything else
 * a slide reaches must be consumed by a reader (hyperlinks, notes, charts, SmartArt data and drawing,
 * chart userShapes, comments and their authors); the catch-all test enumerates both against real decks.
 */
export const SKIPPED_RELATIONSHIPS: Record<string, string> = {
  [`${REL}/image`]: "picture bytes; alt text is hashed, a swapped image is not text or a destination",
  [`${REL}/slide`]: "a notes slide's pointer back to its own slide; a jump from a hyperlink is read as a link target",
  [`${REL}/slideLayout`]: "layout formatting; a slide's own text lives on the slide",
  [`${REL}/slideMaster`]: "master formatting",
  [`${REL}/notesMaster`]: "notes master formatting",
  [`${REL}/handoutMaster`]: "handout master formatting",
  [`${REL}/theme`]: "theme colours and fonts",
  [`${REL}/themeOverride`]: "chart theme colours and fonts",
  [`${REL}/package`]: "embedded workbook; the chart's cached values are read instead",
  [`${REL}/oleObject`]: "embedded object binary; not readable as text",
  [`${REL}/diagramLayout`]: "SmartArt layout definition",
  [`${REL}/diagramQuickStyle`]: "SmartArt style",
  [`${REL}/diagramColors`]: "SmartArt colours",
  [`${REL}/tags`]: "custom tags, not shown on the slide",
  [`${REL}/vmlDrawing`]: "legacy comment shape geometry",
  [`${REL}/printerSettings`]: "printer settings",
  "http://schemas.microsoft.com/office/2011/relationships/chartStyle": "chart style formatting",
  "http://schemas.microsoft.com/office/2011/relationships/chartColorStyle": "chart colour formatting",
  "http://schemas.microsoft.com/office/2007/relationships/hdphoto": "picture effect image",
  "http://schemas.microsoft.com/office/2007/relationships/media": "audio or video bytes",
  [`${REL}/audio`]: "audio bytes",
  [`${REL}/video`]: "video bytes",
};

/** Parts a walk for relationship types does not follow into: shared formatting, and slides (a jump is a cycle). */
const NO_DESCENT = new Set([`${REL}/slideLayout`, `${REL}/slideMaster`, `${REL}/notesMaster`, `${REL}/handoutMaster`, `${REL}/theme`, `${REL}/slide`]);

function openPackage(bytes: Uint8Array): { pkg: Package; presentation: string; pres: El } {
  const pkg = new Package(loadXmlParts(bytes));
  pkg.source = bytes;
  let presentation = "ppt/presentation.xml";
  for (const rel of pkg.rels("").values()) {
    if (REL_OFFICE_DOCUMENT.test(rel.type)) presentation = rel.target;
  }
  const pres = pkg.xml(presentation);
  if (!pres) {
    throw new Error("not a PowerPoint deck: presentation.xml is missing");
  }
  return { pkg, presentation, pres };
}

/** Author id -> display name from the part the presentation reaches by `relType`. */
function readAuthors(pkg: Package, presentation: string, relType: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of pkg.rels(presentation).values()) {
    if (rel.type !== relType) continue;
    pkg.use(rel);
    const root = pkg.xml(rel.target);
    for (const a of root?.children ?? []) {
      const id = a.attrs["id"];
      if (id !== undefined) out.set(id, a.attrs["name"] ?? id);
    }
  }
  return out;
}

/** Legacy (`p:cmLst`) and modern (`p188:cmLst`) comments of a slide; authors by name, never by id. */
function readComments(pkg: Package, slidePart: string, presentation: string): Comment[] {
  const out: Comment[] = [];
  for (const rel of pkg.rels(slidePart).values()) {
    if (rel.type !== REL_COMMENTS && rel.type !== REL_MODERN_COMMENTS) continue;
    pkg.use(rel);
    const root = pkg.xml(rel.target);
    if (!root) continue;
    if (rel.type === REL_COMMENTS) {
      const authors = readAuthors(pkg, presentation, REL_COMMENT_AUTHORS);
      for (const cm of root.children.filter((c) => c.name === "cm")) {
        const author = authors.get(cm.attrs["authorId"] ?? "") ?? `author ${cm.attrs["authorId"] ?? "?"}`;
        out.push({ key: `${author}#${cm.attrs["idx"] ?? ""}`, author, text: child(cm, "text")?.text ?? "" });
      }
    } else {
      const authors = readAuthors(pkg, presentation, REL_MODERN_AUTHORS);
      const who = (el: El) => authors.get(el.attrs["authorId"] ?? "") ?? `author ${el.attrs["authorId"] ?? "?"}`;
      for (const cm of root.children.filter((c) => c.name === "cm")) {
        const status = cm.attrs["status"];
        let text = `${bodyParagraphs(child(cm, "txBody")).join("\n")}${status && status !== "active" ? ` [${status}]` : ""}`;
        for (const reply of child(cm, "replyLst")?.children.filter((c) => c.name === "reply") ?? []) {
          text += `\n> ${who(reply)}: ${bodyParagraphs(child(reply, "txBody")).join("\n")}`;
        }
        out.push({ key: cm.attrs["id"] ?? `${who(cm)}#${out.length}`, author: who(cm), text });
      }
    }
  }
  return out;
}

const hash12 = (s: string | Uint8Array): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** Canonical text of a workbook part: relationship ids, revision uids and extension lists are dropped, since a resave rewrites them. */
function canon(el: El): string {
  const attrs = Object.entries(el.attrs)
    .filter(([k]) => !k.startsWith("xmlns") && !k.startsWith("r:") && !k.startsWith("xr:") && k !== "mc:Ignorable")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `<${el.name} ${attrs}>${el.text}${el.children.filter((c) => c.name !== "extLst").map(canon).join("")}</${el.name}>`;
}

/** What an embedded workbook holds: its sheets and shared strings, so a resave that only rewrites properties or timestamps hashes the same. */
function workbookData(bytes: Uint8Array): string {
  try {
    const files = unzipSync(bytes, { filter: (f) => /^xl\/(worksheets\/[^/]+\.xml|sharedStrings\.xml)$/.test(f.name) && f.originalSize <= MAX_PART_BYTES });
    const names = Object.keys(files).sort();
    if (names.length === 0) return hash12(bytes);
    return hash12(names.map((n) => `${n}\n${canon(parseXml(Buffer.from(files[n]!).toString("utf8")))}`).join("\n"));
  } catch {
    return hash12(bytes);
  }
}

/** The transition as words: its kind, direction, speed and auto-advance time. */
function describeTransition(root: El): string | null {
  const t = find(root, "transition");
  if (!t) return null;
  const kind = t.children.find((c) => c.name !== "sndAc");
  const parts = [kind ? `${kind.name}${kind.attrs["dir"] ? ` ${kind.attrs["dir"]}` : ""}` : "none"];
  if (t.attrs["spd"]) parts.push(`(${t.attrs["spd"]})`);
  if (t.attrs["advTm"]) parts.push(`after ${Number(t.attrs["advTm"]) / 1000}s`);
  return parts.join(" ");
}

/** The deck, and the relationship types its readers resolved on the way. */
export function readDeckTraced(bytes: Uint8Array): { deck: Deck; consumed: ReadonlySet<string> } {
  const r = readDeckInner(bytes, false);
  return { deck: r.deck, consumed: r.consumed };
}

/** The deck with each slide's shape frames (EMU, slide space, one per `Slide.shapes` entry in the same order) and the slide size; see frames.ts. */
export function readDeckFrames(bytes: Uint8Array): { deck: Deck; size: { cx: number; cy: number } | undefined; frames: (Frame | undefined)[][] } {
  const r = readDeckInner(bytes, true);
  return { deck: r.deck, size: r.size, frames: r.frames };
}

function readDeckInner(bytes: Uint8Array, withFrames: boolean): { deck: Deck; consumed: ReadonlySet<string>; size: { cx: number; cy: number } | undefined; frames: (Frame | undefined)[][] } {
  const { pkg, presentation, pres } = openPackage(bytes);
  const sz = find(pres, "sldSz");
  const [szx, szy] = [Number(sz?.attrs["cx"]), Number(sz?.attrs["cy"])];
  const size = sz && Number.isFinite(szx) && Number.isFinite(szy) && szx > 0 && szy > 0 ? { cx: szx, cy: szy } : undefined;
  const allFrames: (Frame | undefined)[][] = [];
  const rels = pkg.rels(presentation);
  const slides: Slide[] = [];
  const list = find(pres, "sldIdLst");
  const entries = list?.children.filter((c) => c.name === "sldId") ?? [];
  for (const entry of entries) {
    const rel = rels.get(relAttr(entry, "id") ?? "");
    if (rel && REL_SLIDE.test(rel.type)) pkg.slideIds.set(rel.target, entry.attrs["id"] ?? "");
  }
  for (const entry of entries) {
    const rel = rels.get(relAttr(entry, "id") ?? "");
    if (!rel || !REL_SLIDE.test(rel.type)) {
      throw new Error(`slide ${entry.attrs["id"] ?? "?"} has no slide part`);
    }
    const root = pkg.xml(rel.target);
    const tree = root ? find(root, "spTree") : undefined;
    if (!root || !tree) {
      throw new Error(`slide part ${rel.target} is missing or has no shape tree`);
    }
    const notesRel = [...pkg.rels(rel.target).values()].find((r) => REL_NOTES.test(r.type));
    // layout and master are looked up without `pkg.use`: they are skipped relationship types, read here only for placeholder frames
    let layout: El | undefined, master: El | undefined;
    if (withFrames) {
      try {
        const layoutPart = [...pkg.rels(rel.target).values()].find((r) => /\/slideLayout$/.test(r.type) && !r.external)?.target;
        layout = layoutPart ? pkg.xml(layoutPart) : undefined;
        const masterPart = layoutPart ? [...pkg.rels(layoutPart).values()].find((r) => /\/slideMaster$/.test(r.type) && !r.external)?.target : undefined;
        master = masterPart ? pkg.xml(masterPart) : undefined;
      } catch {
        layout = master = undefined;
      }
    }
    const slideFrames: (Frame | undefined)[] = [];
    allFrames.push(slideFrames);
    slides.push({
      id: entry.attrs["id"] ?? "",
      shapes: readShapes(pkg, rel.target, tree, withFrames ? { out: slideFrames, layout, master } : undefined),
      notes: notesRel && pkg.has(notesRel.target) ? readNotes(pkg, pkg.use(notesRel)!.target) : null,
      comments: readComments(pkg, rel.target, presentation),
      hidden: root.attrs["show"] === "0",
      transition: describeTransition(root),
    });
  }
  return { deck: { slides }, consumed: pkg.consumed, size, frames: allFrames };
}

export function readDeck(bytes: Uint8Array): Deck {
  return readDeckTraced(bytes).deck;
}

/** Every relationship type reachable from a slide (through charts, SmartArt, notes, comments...), shared formatting parts not followed. */
export function slideRelationshipTypes(bytes: Uint8Array): Set<string> {
  const { pkg, presentation, pres } = openPackage(bytes);
  const types = new Set<string>();
  const seen = new Set<string>();
  const visit = (part: string) => {
    if (seen.has(part)) return;
    seen.add(part);
    for (const rel of pkg.rels(part).values()) {
      types.add(rel.type);
      if (!rel.external && !NO_DESCENT.has(rel.type)) visit(rel.target);
    }
  };
  const rels = pkg.rels(presentation);
  for (const entry of find(pres, "sldIdLst")?.children.filter((c) => c.name === "sldId") ?? []) {
    const rel = rels.get(relAttr(entry, "id") ?? "");
    if (rel) visit(rel.target);
  }
  // comment authors hang off the presentation but are only reached because a slide has comments
  const hasComments = types.has(REL_COMMENTS) || types.has(REL_MODERN_COMMENTS);
  for (const rel of rels.values()) {
    if (hasComments && (rel.type === REL_COMMENT_AUTHORS || rel.type === REL_MODERN_AUTHORS)) types.add(rel.type);
  }
  return types;
}
