import type { LayerDiffRow } from "../../../formats/layer.ts";
import { alignSequences } from "../../../formats/files/align.ts";
import { chartDiff, chartDigest, type Skip } from "../shared/chart-diff.ts";
import type { ChartData, Comment, Deck, Link, Para, ParaPart, Shape, Slide } from "./reader.ts";

/**
 * Deck diff: slides matched by their `sldId` (then by identical content), shapes within a slide by
 * id then name, each change a row addressed `Slide N / shape name` (group members add their group
 * path, table cells `R2C3`, chart points `series, category`, notes `Notes`, comments `comment`; a
 * hyperlink change is a row at its shape). The numbers inside a
 * text unit are rows of their own: the prose is compared with every number masked, the numbers
 * are compared as a list, so a pure number edit is one row and a pure wording edit is one row.
 */

const row = (location: string, kind: string, before: unknown, after: unknown, detail: Record<string, unknown>): LayerDiffRow => ({
  location,
  kind,
  before,
  after,
  derivable: false,
  detail: { kind, sheet: slideOf(location), ...detail },
});

function slideOf(location: string): string {
  return /^Slide \d+/.exec(location)?.[0] ?? "";
}

/** A `!` in a name would make the review page read the text before it as a sheet name. */
const safe = (name: string): string => name.replace(/!/g, "！");

// A number token: optional sign and currency, digits with grouping, decimals, and an attached scale or
// unit suffix (k, m, mm, bn, b, x, %); not glued to a word ("Q3", "3rd") or to a larger number. The digits
// are matched atomically (lookahead plus backreference) so "$4.2Mx" cannot backtrack to a bare "$4".
const NUMBER = /(?<![\w.,])[-+]?[$€£]?(?=(\d[\d,]*(?:\.\d+)?))\1(?:%|bn|mm|[kKmMbBxX])?(?!\w)/g;

export const numbersIn = (text: string): string[] => text.match(NUMBER) ?? [];

const maskNumbers = (text: string): string => text.replace(NUMBER, "#");

/** A paragraph that has no structure of its own (a chart label, a note): one text run. */
const plain = (text: string): Para => ({ text, parts: [{ kind: "r", text }] });

/** The parts of one paragraph on both sides of a change; `null` where the paragraph is absent. */
export interface ParaDiff {
  before: ParaPart[] | null;
  after: ParaPart[] | null;
}

/**
 * Whether paragraph `p` of the row is its old self with run `run` (1-based, counting `a:r` parts only, as the
 * editor does) replaced by `text`: same parts of the same kinds, every other part untouched. A row that
 * carries no parts for `p` matches nothing.
 */
export function runReplaced(d: ParaDiff | undefined, run: number, text: string): boolean {
  if (!d?.before || !d.after || d.before.length !== d.after.length) return false;
  let seen = 0;
  return d.before.every((b, i) => {
    const a = d.after![i]!;
    if (a.kind !== b.kind) return false;
    if (b.kind === "r" && ++seen === run) return a.text === text;
    return a.text === b.text;
  });
}

/** Diffs one unit of text at `unit`, pushing a prose row and a row per changed number. */
function diffText(unit: string, before: Para[], after: Para[], out: LayerDiffRow[], extra: Record<string, unknown> = {}): void {
  const [tb, ta] = [before.map((p) => p.text), after.map((p) => p.text)];
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((t, i) => t === y[i]);
  if (same(tb, ta)) return;
  const [textBefore, textAfter] = [tb.join("\n"), ta.join("\n")];
  const parts = (p: number): Record<number, ParaDiff> => ({ [p]: { before: before[p - 1]?.parts ?? null, after: after[p - 1]?.parts ?? null } });
  if (!same(tb.map(maskNumbers), ta.map(maskNumbers))) {
    const changed: number[] = [];
    for (let i = 0; i < Math.max(tb.length, ta.length); i++) if (tb[i] !== ta[i]) changed.push(i + 1);
    const paragraphParts = Object.assign({}, ...changed.map(parts));
    out.push(row(unit, "text changed", textBefore, textAfter, { unit, ...extra, changedParagraphs: changed, paragraphParts }));
  }
  // numbers are listed across the whole unit (`number N`), each with its paragraph (the `a:p` index) and index in it
  const sites = (ps: Para[]) => ps.flatMap((p, i) => numbersIn(p.text).map((_, k) => ({ paragraph: i + 1, index: k + 1 })));
  const [a, b] = [tb.flatMap(numbersIn), ta.flatMap(numbersIn)];
  const [sa, sb] = [sites(before), sites(after)];
  const where = (site: { paragraph: number; index: number }) => ({
    paragraph: site.paragraph,
    paragraphNumberIndex: site.index,
    paragraphBefore: tb[site.paragraph - 1] ?? "",
    paragraphAfter: ta[site.paragraph - 1] ?? "",
    paragraphParts: parts(site.paragraph),
  });
  for (const { before: i, after: j } of alignSequences(a, b)) {
    if (i !== null && j !== null) {
      out.push(row(`${unit} / number ${j + 1}`, "number changed", a[i], b[j], { unit, numberIndex: j + 1, ...where(sb[j]), ...extra }));
    } else if (j !== null) {
      out.push(row(`${unit} / number ${j + 1}`, "number added", null, b[j], { unit, numberIndex: j + 1, ...where(sb[j]), ...extra }));
    } else {
      out.push(row(`${unit} / number ${i! + 1}`, "number removed", a[i!], null, { unit, numberIndex: i! + 1, ...where(sa[i!]), ...extra }));
    }
  }
}

/** Shapes with display names unique within their group: a second "Title" reads "Title (2)". */
export interface Placed {
  shape: Shape;
  /** Location of the shape without the slide prefix. */
  path: string;
}

/** The words a shape or group is shown by: its name, else (no name, or only spaces) its role, else its kind. */
const KIND_WORDS: Record<Shape["kind"], string> = { text: "Text box", table: "Table", chart: "Chart", group: "Group", other: "Shape" };
const shownName = (name: string, fallback: string): string => safe(name.trim() !== "" ? name : fallback);

export function place(shapes: Shape[]): Placed[] {
  const seen = new Map<string, number>();
  return shapes.map((shape) => {
    const prefix = shape.scope.map((g) => shownName(g.name, KIND_WORDS.group)).join(" / ");
    const base = `${prefix ? `${prefix} / ` : ""}${shownName(shape.name, shape.role ?? KIND_WORDS[shape.kind])}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { shape, path: n === 1 ? base : `${base} (${n})` };
  });
}

function shapeText(s: Shape): string {
  if (s.paragraphs) return s.paragraphs.join("\n");
  if (s.table) return s.table.map((r) => r.join(" | ")).join("\n");
  if (s.chart) return [s.chart.title, ...s.chart.series.map((x) => x.name)].filter(Boolean).join(" | ");
  return "";
}

/** Everything text-like on a slide, for a one-line summary of an added or removed slide. */
function slideText(slide: Slide): string {
  const parts = slide.shapes.map(shapeText).filter((t) => t !== "");
  if (slide.notes && slide.notes.some((n) => n !== "")) parts.push(`Notes: ${slide.notes.join("\n")}`);
  if (slide.comments.length > 0) parts.push(`Comments: ${slide.comments.map(commentText).join(" / ")}`);
  return parts.join(" | ");
}

const scopeIds = (s: Shape) => s.scope.map((g) => g.id).join("/");
const scopeNames = (s: Shape) => s.scope.map((g) => g.name).join("/");

/** Pairs shapes of two slides: by group path + id, then by group path + name; kinds must agree. */
export function matchShapes(a: Placed[], b: Placed[]): { pairs: [Placed, Placed][]; removed: Placed[]; added: Placed[] } {
  const pairs: [Placed, Placed][] = [];
  const takenB = new Set<Placed>();
  const unmatchedA: Placed[] = [];
  const pass = (keyOf: (p: Placed) => string, left: Placed[]): Placed[] => {
    const queues = new Map<string, Placed[]>();
    for (const p of b) {
      if (takenB.has(p)) continue;
      const k = keyOf(p);
      if (!queues.has(k)) queues.set(k, []);
      queues.get(k)!.push(p);
    }
    const rest: Placed[] = [];
    for (const p of left) {
      const hit = queues.get(keyOf(p))?.shift();
      if (hit) {
        pairs.push([p, hit]);
        takenB.add(hit);
      } else {
        rest.push(p);
      }
    }
    return rest;
  };
  const afterIds = pass((p) => `${p.shape.kind}|${scopeIds(p.shape)}|${p.shape.id}`, a);
  unmatchedA.push(...pass((p) => `${p.shape.kind}|${scopeNames(p.shape)}|${p.shape.name}`, afterIds));
  return { pairs, removed: unmatchedA, added: b.filter((p) => !takenB.has(p)) };
}

function diffTable(loc: string, a: string[][], b: string[][], sa: Para[][][] | undefined, sb: Para[][][] | undefined, out: LayerDiffRow[]): void {
  // a cell's paragraphs come from its structure; a table read without one has one paragraph per cell
  const cell = (s: Para[][][] | undefined, t: string[][], r: number, c: number): Para[] => s?.[r]?.[c] ?? [plain(t[r]?.[c] ?? "")];
  const sig = (s: Para[][][] | undefined, t: string[][]) => (_: string[], r: number) => JSON.stringify(t[r]!.map((_c, c) => cell(s, t, r, c).map((p) => p.text)));
  for (const { before, after } of alignSequences(a.map(sig(sa, a)), b.map(sig(sb, b)))) {
    if (before !== null && after !== null) {
      const [ra, rb] = [a[before]!, b[after]!];
      for (let c = 0; c < Math.max(ra.length, rb.length); c++) {
        const [x, y] = [ra[c], rb[c]];
        const unit = `${loc} / R${after + 1}C${c + 1}`;
        if (x !== undefined && y !== undefined) diffText(unit, cell(sa, a, before, c), cell(sb, b, after, c), out, { tableRow: after + 1, tableColumn: c + 1 });
        else if (x === y) continue;
        else if (y !== undefined) out.push(row(unit, "table cell added", null, y, { unit, tableRow: after + 1, tableColumn: c + 1 }));
        else out.push(row(unit, "table cell removed", x, null, { unit, tableRow: after + 1, tableColumn: c + 1 }));
      }
    } else if (after !== null) {
      out.push(row(`${loc} / R${after + 1}`, "table row added", null, b[after]!.join(" | "), { unit: `${loc} / R${after + 1}`, tableRow: after + 1 }));
    } else {
      out.push(row(`${loc} / R${before! + 1}`, "table row removed", a[before!]!.join(" | "), null, { unit: `${loc} / R${before! + 1}`, tableRow: before! + 1 }));
    }
  }
}

export const chartLabel = (cats: Map<number, string>, idx: number): string => cats.get(idx) ?? `point ${idx + 1}`;

function sameNumber(a: string, b: string): boolean {
  if (a === b) return true;
  const [x, y] = [Number(a), Number(b)];
  return a.trim() !== "" && b.trim() !== "" && Number.isFinite(x) && Number.isFinite(y) && x === y;
}

const asValue = (s: string): number | string => (s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : s);

function diffChart(loc: string, a: ChartData, b: ChartData, out: LayerDiffRow[]): void {
  if (a.title !== b.title) {
    out.push(row(`${loc} / title`, "chart title changed", a.title, b.title, { unit: `${loc} / title` }));
  }
  const axisLabels = [...new Set([...a.axes, ...b.axes].map((x) => x.label))];
  for (const label of axisLabels) {
    diffText(`${loc} / ${label}`, [plain(a.axes.find((x) => x.label === label)?.title ?? "")], [plain(b.axes.find((x) => x.label === label)?.title ?? "")], out);
  }
  const n = Math.max(a.series.length, b.series.length);
  for (let i = 0; i < n; i++) {
    const [sa, sb] = [a.series[i], b.series[i]];
    if (sa && !sb) {
      out.push(row(`${loc} / ${sa.name || `series ${i + 1}`}`, "chart series removed", [...sa.values.values()].map(asValue), null, { unit: `${loc} / ${sa.name || `series ${i + 1}`}`, series: i + 1 }));
      continue;
    }
    if (!sa && sb) {
      out.push(row(`${loc} / ${sb.name || `series ${i + 1}`}`, "chart series added", null, [...sb.values.values()].map(asValue), { unit: `${loc} / ${sb.name || `series ${i + 1}`}`, series: i + 1 }));
      continue;
    }
    const [x, y] = [sa!, sb!];
    const label = y.name || `series ${i + 1}`;
    if (x.name !== y.name) {
      out.push(row(`${loc} / ${label}`, "chart series renamed", x.name, y.name, { unit: `${loc} / ${label}`, series: i + 1 }));
    }
    const idxs = [...new Set([...x.values.keys(), ...y.values.keys(), ...x.categories.keys(), ...y.categories.keys(), ...x.labels.keys(), ...y.labels.keys()])].sort((p, q) => p - q);
    for (const idx of idxs) {
      const [catA, catB] = [x.categories.get(idx), y.categories.get(idx)];
      const unit = `${loc} / ${label}, ${chartLabel(y.categories.size ? y.categories : x.categories, idx)}`;
      const detail = { unit, series: i + 1, seriesName: y.name, point: idx + 1 };
      if (catA !== catB) {
        out.push(row(`${unit} / category`, "chart category changed", catA ?? null, catB ?? null, detail));
      }
      diffText(`${unit} / label`, [plain(x.labels.get(idx) ?? "")], [plain(y.labels.get(idx) ?? "")], out, detail);
      const [va, vb] = [x.values.get(idx), y.values.get(idx)];
      if (va === undefined && vb === undefined) continue;
      if (va !== undefined && vb !== undefined && sameNumber(va, vb)) continue;
      out.push(row(unit, "chart value", va === undefined ? null : asValue(va), vb === undefined ? null : asValue(vb), detail));
    }
  }
}

const linkLabel = (l: Link): string => `${l.trigger === "click" ? "" : `${l.trigger} `}${l.text || "(shape)"}`;

/** Restate key of each link of a shape, numbered in document order: a second link with the same label reads `(2)`. */
function linkUnits(loc: string, links: Link[]): Map<Link, string> {
  const seen = new Map<string, number>();
  return new Map(
    links.map((l) => {
      const base = `${loc} / link ${linkLabel(l)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return [l, n === 1 ? base : `${base} (${n})`];
    }),
  );
}

/** Links of one shape: paired by trigger and text, then leftovers of the same trigger in order; each change is a row at the shape. */
function diffLinks(loc: string, a: Link[], b: Link[], out: LayerDiffRow[]): void {
  const takenB = new Set<Link>();
  const pairs: [Link, Link][] = [];
  const left: Link[] = [];
  const pass = (keyOf: (l: Link) => string, from: Link[]): Link[] => {
    const rest: Link[] = [];
    for (const l of from) {
      const hit = b.find((x) => !takenB.has(x) && keyOf(x) === keyOf(l));
      if (hit) {
        takenB.add(hit);
        pairs.push([l, hit]);
      } else {
        rest.push(l);
      }
    }
    return rest;
  };
  const afterText = pass((l) => `${l.trigger}|${l.text}|${l.target}|${l.tooltip}`, a);
  const afterKey = pass((l) => `${l.trigger}|${l.text}`, afterText);
  left.push(...pass((l) => l.trigger, afterKey));
  const [unitsA, unitsB] = [linkUnits(loc, a), linkUnits(loc, b)];
  for (const [x, y] of pairs) {
    const unit = unitsB.get(y)!;
    const detail = { linkText: y.text, trigger: y.trigger };
    if (x.target !== y.target) out.push(row(loc, "hyperlink target changed", x.target, y.target, { unit, ...detail }));
    if (x.tooltip !== y.tooltip) out.push(row(loc, "hyperlink tooltip changed", x.tooltip, y.tooltip, { unit: `${unit} / tooltip`, ...detail }));
  }
  for (const x of left) {
    out.push(row(loc, "hyperlink removed", x.target, null, { unit: unitsA.get(x)!, linkText: x.text, trigger: x.trigger }));
  }
  for (const y of b.filter((l) => !takenB.has(l))) {
    out.push(row(loc, "hyperlink added", null, y.target, { unit: unitsB.get(y)!, linkText: y.text, trigger: y.trigger }));
  }
}

const commentText = (c: Comment): string => `${c.author}: ${c.text}`;

/** Comments of one slide: by identity, then leftovers by identical text (an id renumbered on resave); each change is a row at `Slide N / comment`. */
function diffComments(slide: string, a: Comment[], b: Comment[], out: LayerDiffRow[]): void {
  const loc = `${slide} / comment`;
  const takenB = new Set<Comment>();
  const pairs: [Comment, Comment][] = [];
  const pass = (keyOf: (c: Comment) => string, from: Comment[]): Comment[] => {
    const rest: Comment[] = [];
    for (const c of from) {
      const hit = b.find((x) => !takenB.has(x) && keyOf(x) === keyOf(c));
      if (hit) {
        takenB.add(hit);
        pairs.push([c, hit]);
      } else {
        rest.push(c);
      }
    }
    return rest;
  };
  const removed = pass(commentText, pass((c) => c.key, a));
  for (const [x, y] of pairs) {
    if (commentText(x) !== commentText(y)) out.push(row(loc, "comment changed", commentText(x), commentText(y), { unit: `${loc} ${y.key}` }));
  }
  for (const x of removed) out.push(row(loc, "comment removed", commentText(x), null, { unit: `${loc} ${x.key}` }));
  for (const y of b.filter((c) => !takenB.has(c))) out.push(row(loc, "comment added", null, commentText(y), { unit: `${loc} ${y.key}` }));
}


/** Hidden and transition of one matched slide (layout, master, theme and pictures are rows of the media layer, `package-media.ts`). A side read without these fields (a hand-built model) is not compared. */
function diffSlideSetup(slide: string, a: Slide, b: Slide, out: LayerDiffRow[]): void {
  if (a.hidden !== undefined && b.hidden !== undefined && a.hidden !== b.hidden) {
    out.push(row(`${slide} / Hidden`, b.hidden ? "slide hidden" : "slide shown", a.hidden ? "hidden" : "shown", b.hidden ? "hidden" : "shown", { unit: `${slide} / Hidden` }));
  }
  if (a.transition !== undefined && b.transition !== undefined && a.transition !== b.transition) {
    out.push(row(`${slide} / Transition`, "transition changed", a.transition ?? "none", b.transition ?? "none", { unit: `${slide} / Transition` }));
  }
}

/** Position and size differences smaller than this (EMU, a tenth of a point) are rounding noise from a resave, not a change. */
export const GEOMETRY_TOLERANCE_EMU = 1270;
const far = (p: number, q: number): boolean => !(Math.abs(p - q) <= GEOMETRY_TOLERANCE_EMU);
const inches = (emu: number): string => `${Math.round((emu / 914400) * 100) / 100}`;
const geometryWords = (x: NonNullable<Shape["xfrm"]>, cols: number[] | undefined, moved: boolean, resized: boolean): string =>
  [moved ? `at ${inches(x.x)}, ${inches(x.y)} in` : "", resized ? `${inches(x.cx)} x ${inches(x.cy)} in` : "", resized && cols && cols.length > 0 ? `columns ${cols.map(inches).join(", ")} in` : ""].filter((t) => t !== "").join(", ");

/**
 * One row when a matched shape moved or changed size: its own offset and extent, and a table's column widths. A shape with no transform
 * of its own on either side (an inheriting placeholder) is not compared. A group's members sit in its child space, so a moved group is
 * one row, not one per member.
 */
function diffGeometry(loc: string, sa: Shape, sb: Shape, out: LayerDiffRow[]): void {
  const [xa, xb] = [sa.xfrm, sb.xfrm];
  const moved = xa !== undefined && xb !== undefined && (far(xa.x, xb.x) || far(xa.y, xb.y));
  const sized = xa !== undefined && xb !== undefined && (far(xa.cx, xb.cx) || far(xa.cy, xb.cy));
  const [ca, cb] = [sa.columns ?? [], sb.columns ?? []];
  const widened = ca.length === cb.length && ca.some((w, i) => far(w, cb[i]!));
  const resized = sized || widened;
  if (!moved && !resized) return;
  const kind = moved && resized ? "shape moved and resized" : moved ? "shape moved" : "shape resized";
  const words = (s: Shape): string => (s.xfrm ? geometryWords(s.xfrm, s.columns, moved, resized) : `columns ${(s.columns ?? []).map(inches).join(", ")} in`);
  out.push(row(loc, kind, words(sa), words(sb), { unit: `${loc} / geometry`, shapeKind: sb.kind }));
}

/**
 * What else differs in a matched chart's part, from the shared structural diff: a number format, a colour, an axis scale, a legend position.
 * What another row already says is left out here, so nothing is said twice: the text and values `diffChart` rows (titles, axis titles, series
 * names and points, data labels) and what the shape's unmodelled hash carries (`chartExtras` in the reader: legend presence, legend entries,
 * trendline names and types).
 */
const MODELLED: Skip = (el, path, pair) => {
  const parent = path[path.length - 1]?.name;
  if (el.name === "tx" && (parent === "title" || parent === "ser" || parent === "dLbl")) return true;
  if (el.name === "title" || el.name === "ser" || el.name === "legend" || el.name === "trendline") return pair.a === undefined || pair.b === undefined;
  if (parent === "trendline" && (el.name === "name" || el.name === "trendlineType")) return true;
  return el.name === "legendEntry" || el.name === "pt" || el.name === "ptCount";
};
function chartFormat(loc: string, a: ChartData, b: ChartData, out: LayerDiffRow[]): void {
  if (a.tree === undefined || b.tree === undefined) return;
  const { lines } = chartDiff(a.tree, b.tree, MODELLED);
  if (lines.length > 0) out.push(row(loc, "chart changed", chartDigest(a.tree), chartDigest(b.tree), { unit: `${loc} / chart`, changes: lines, shapeKind: "chart" }));
}

function diffSlide(n: number, a: Slide, b: Slide, out: LayerDiffRow[]): void {
  const slide = `Slide ${n}`;
  const { pairs, removed, added } = matchShapes(place(a.shapes), place(b.shapes));
  for (const [pa, pb] of pairs) {
    const loc = `${slide} / ${pb.path}`;
    const [sa, sb] = [pa.shape, pb.shape];
    if (sa.name !== sb.name) {
      out.push(row(loc, "shape renamed", sa.name, sb.name, { unit: loc }));
    }
    diffGeometry(loc, sa, sb, out);
    if (sa.paragraphs && sb.paragraphs) diffText(loc, sa.structure ?? sa.paragraphs.map(plain), sb.structure ?? sb.paragraphs.map(plain), out);
    else if (sa.table && sb.table) diffTable(loc, sa.table, sb.table, sa.tableStructure, sb.tableStructure, out);
    else if (sa.chart && sb.chart) {
      const had = out.length;
      diffChart(loc, sa.chart, sb.chart, out);
      const cacheChanged = out.length > had;
      chartFormat(loc, sa.chart, sb.chart, out);
      const [wa, wb] = [sa.chart.workbook, sb.chart.workbook];
      if (wa !== undefined && wb !== undefined) {
        if (wa !== wb) out.push(row(`${loc} / workbook`, "chart workbook changed", "embedded workbook", "embedded workbook (edited)", { unit: `${loc} / workbook`, cache: cacheChanged ? "changed" : "unchanged" }));
      }
    }
    diffLinks(loc, sa.links ?? [], sb.links ?? [], out);
    if ((sa.unmodelled ?? "") !== (sb.unmodelled ?? "")) {
      out.push(row(loc, "unmodelled content changed", sa.unmodelled ?? null, sb.unmodelled ?? null, { unit: `${loc} / unmodelled` }));
    }
  }
  const groupsWithMembers = (list: Placed[]) => {
    const parents = new Set<string>();
    for (const p of list) if (p.shape.scope.length > 0) parents.add(p.shape.scope.at(-1)!.id);
    return parents;
  };
  const [withA, withB] = [groupsWithMembers(a.shapes.map((shape) => ({ shape, path: "" }))), groupsWithMembers(b.shapes.map((shape) => ({ shape, path: "" })))];
  for (const p of removed) {
    if (p.shape.kind === "group" && withA.has(p.shape.id)) continue;
    const loc = `${slide} / ${p.path}`;
    out.push(row(loc, "shape removed", shapeText(p.shape), null, { unit: loc, shapeKind: p.shape.kind }));
  }
  for (const p of added) {
    if (p.shape.kind === "group" && withB.has(p.shape.id)) continue;
    const loc = `${slide} / ${p.path}`;
    out.push(row(loc, "shape added", null, shapeText(p.shape), { unit: loc, shapeKind: p.shape.kind }));
  }
  diffSlideSetup(slide, a, b, out);
  const [na, nb] = [a.notes, b.notes];
  if (na !== null || nb !== null) {
    diffText(`${slide} / Notes`, (na ?? []).map(plain), (nb ?? []).map(plain), out);
  }
  diffComments(slide, a.comments, b.comments, out);
}

const contentSignature = (s: Slide): string =>
  JSON.stringify({ shapes: place(s.shapes).map((p) => [p.path, p.shape.kind, shapeText(p.shape), p.shape.table, p.shape.chart && [p.shape.chart.title, p.shape.chart.axes, p.shape.chart.series.map((x) => [x.name, [...x.categories], [...x.values], [...x.labels]])], p.shape.unmodelled, p.shape.links?.map((l) => (l.slide !== undefined ? { ...l, target: "slide", slide: "" } : l))]), notes: s.notes, comments: s.comments.map((c) => [c.author, c.text]) });

/** A slide whose jumps to other slides name the matched slide of the other deck, so renumbered ids are not a change. */
function retargetJumps(slide: Slide, a: Deck, b: Deck, matchAfter: Map<number, number>): Slide {
  const toB = (id: string): string | undefined => {
    const j = matchAfter.get(a.slides.findIndex((x) => x.id === id));
    return j === undefined ? undefined : b.slides[j]!.id;
  };
  return {
    ...slide,
    shapes: slide.shapes.map((sh) =>
      sh.links?.some((l) => l.slide !== undefined)
        ? { ...sh, links: sh.links.map((l) => (l.slide !== undefined && toB(l.slide) !== undefined ? { ...l, slide: toB(l.slide), target: `slide ${toB(l.slide)}` } : l)) }
        : sh,
    ),
  };
}

/**
 * The one slide-identity map for a deck pair (before index -> after index). The row diff, the labels, the boxes and the before
 * picture all read this, so they cannot name different slides. The rule, in order:
 *  1. the same `sldId` and identical content pair (document order within a repeated id);
 *  2. with ids trusted (see `matchByIdentity`), the same `sldId` with different content pairs (an edit); with ids untrusted, no edits;
 *  3. unmatched slides pair by identical content, in document order.
 * A duplicate has a new `sldId`: the original keeps its pairing and the copy is left unpaired (added). A slide with no partner is
 * removed (before) or added (after); a partner is never taken twice.
 */
export function matchDeckSlides(a: Deck, b: Deck): Map<number, number> {
  return matchByIdentity(a.slides.map((s) => s.id), a.slides.map(contentSignature), b.slides.map((s) => s.id), b.slides.map(contentSignature));
}

/**
 * Identity pairing over (sldId, content signature) lists. Identity must be proven: if any slide's exact content sits on an after slide
 * with a different sldId that is another before slide's sldId, the ids were renumbered (they are untrusted deck-wide) and slides pair
 * by exact content only, so every other slide is removed plus added, never a guessed edit. A fresh id (a copy) is no contradiction.
 * A signature shared by two or more slides on either side (blank dividers) never proves renumbering: which twin sits under which id
 * is not evidence. Only a signature unique on both sides can: it proves renumbering by sitting under another before id. Other before
 * content (a different signature) sitting under a before slide's id also proves it, shared or not. Accepted gap: p14:creationId is not read as identity.
 */
export function matchByIdentity(idsB: string[], sigB: string[], idsA: string[], sigA: string[]): Map<number, number> {
  const beforeIds = new Set(idsB);
  const count = (xs: string[]): Map<string, number> => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const nB = count(sigB), nA = count(sigA);
  const unique = (sg: string): boolean => nB.get(sg) === 1 && (nA.get(sg) ?? 0) <= 1;
  // renumbering proof 2: a before slide's id now holds other before content (a slide that came from a different before id)
  const idHeldByOtherOrigin = (i: number): boolean =>
    idsA.some((id, k) => id === idsB[i] && sigA[k] !== sigB[i] && sigB.some((x, m) => x === sigA[k] && idsB[m] !== id));
  const idsTrusted = !sigB.some((sg, i) => {
    if (idHeldByOtherOrigin(i)) return true;
    if (!unique(sg)) return false;
    return sigA.some((sa, j) => sa === sg && idsA[j] !== idsB[i] && beforeIds.has(idsA[j]!));
  });
  const a = { slides: idsB.map((id) => ({ id })) }, b = { slides: idsA.map((id) => ({ id })) };
  const matchAfter = new Map<number, number>();
  const takenA = new Set<number>(), takenB = new Set<number>();
  const byId = new Map<string, number[]>();
  b.slides.forEach((s, j) => byId.set(s.id, [...(byId.get(s.id) ?? []), j]));
  const pair = (i: number, j: number): void => {
    matchAfter.set(i, j);
    takenB.add(i);
    takenA.add(j);
  };
  a.slides.forEach((s, i) => {
    const j = (byId.get(s.id) ?? []).find((x) => !takenA.has(x) && sigA[x] === sigB[i]);
    if (j !== undefined) pair(i, j);
  });
  const freeB = a.slides.map((_, i) => i).filter((i) => !takenB.has(i));
  const edits: Array<[number, number]> = [];
  const claimed = new Set<number>();
  for (const i of idsTrusted ? freeB : []) {
    const j = (byId.get(a.slides[i]!.id) ?? []).find((x) => !takenA.has(x) && !claimed.has(x));
    if (j === undefined) continue;
    claimed.add(j);
    edits.push([i, j]);
  }
  for (const [i, j] of edits) pair(i, j);
  const bySig = new Map<string, number[]>();
  b.slides.forEach((_, j) => {
    if (takenA.has(j)) return;
    bySig.set(sigA[j]!, [...(bySig.get(sigA[j]!) ?? []), j]);
  });
  a.slides.forEach((_, i) => {
    if (takenB.has(i)) return;
    const j = bySig.get(sigB[i]!)?.shift();
    if (j !== undefined) pair(i, j);
  });
  return matchAfter;
}

export function diffDecks(a: Deck, b: Deck): LayerDiffRow[] {
  const out: LayerDiffRow[] = [];
  const matchAfter = matchDeckSlides(a, b);
  const takenAfter = new Set(matchAfter.values());

  // Moves: matched slides whose relative order changed (not merely shifted by an insert or delete).
  const matchedBefore = [...matchAfter.keys()].sort((x, y) => x - y);
  const beforeOrder = matchedBefore.map((i) => String(matchAfter.get(i)));
  const afterOrder = [...matchAfter.values()].sort((x, y) => x - y).map(String);
  const moved = new Set<number>();
  for (const { before } of alignSequences(beforeOrder, afterOrder)) {
    if (before !== null) moved.add(matchedBefore[before]!);
  }

  a.slides.forEach((s, i) => {
    const j = matchAfter.get(i);
    if (j === undefined) {
      out.push(row(`Slide ${i + 1}`, "slide removed", slideText(s), null, { unit: `Slide ${i + 1}`, position: i + 1 }));
      return;
    }
    if (moved.has(i)) {
      out.push(row(`Slide ${j + 1}`, "slide moved", i + 1, j + 1, { unit: `Slide ${j + 1}` }));
    }
    diffSlide(j + 1, retargetJumps(s, a, b, matchAfter), b.slides[j]!, out);
  });
  b.slides.forEach((s, j) => {
    if (!takenAfter.has(j)) {
      out.push(row(`Slide ${j + 1}`, "slide added", null, slideText(s), { unit: `Slide ${j + 1}`, position: j + 1 }));
    }
  });
  return out;
}

/**
 * Every text-like unit of a deck by its location key (the `detail.unit` a row carries), so a row
 * can be restated against a later snapshot. Values are text; chart points are numbers when numeric.
 */
export function unitValues(deck: Deck): Map<string, unknown> {
  const out = new Map<string, unknown>();
  deck.slides.forEach((slide, i) => {
    const slideLoc = `Slide ${i + 1}`;
    out.set(slideLoc, slideText(slide));
    for (const p of place(slide.shapes)) {
      const loc = `${slideLoc} / ${p.path}`;
      const s = p.shape;
      out.set(loc, shapeText(s));
      if (s.unmodelled) out.set(`${loc} / unmodelled`, s.unmodelled);
      for (const [l, unit] of linkUnits(loc, s.links ?? [])) {
        out.set(unit, l.target);
        out.set(`${unit} / tooltip`, l.tooltip);
      }
      s.table?.forEach((r, ri) => {
        out.set(`${loc} / R${ri + 1}`, r.join(" | "));
        r.forEach((cell, ci) => out.set(`${loc} / R${ri + 1}C${ci + 1}`, cell));
      });
      if (s.chart) {
        if (s.chart.tree) out.set(`${loc} / chart`, chartDigest(s.chart.tree));
        out.set(`${loc} / title`, s.chart.title);
        for (const ax of s.chart.axes) out.set(`${loc} / ${ax.label}`, ax.title);
        s.chart.series.forEach((ser, si) => {
          const label = ser.name || `series ${si + 1}`;
          out.set(`${loc} / ${label}`, ser.name);
          for (const [idx, v] of ser.values) out.set(`${loc} / ${label}, ${chartLabel(ser.categories, idx)}`, asValue(v));
          for (const [idx, t] of ser.labels) out.set(`${loc} / ${label}, ${chartLabel(ser.categories, idx)} / label`, t);
        });
      }
    }
    if (slide.notes) out.set(`${slideLoc} / Notes`, slide.notes.join("\n"));
    for (const c of slide.comments) out.set(`${slideLoc} / comment ${c.key}`, commentText(c));
  });
  return out;
}
