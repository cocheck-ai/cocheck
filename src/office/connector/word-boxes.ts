// Word's boxes on its print pages (level 3). A box is placed from where the finder (the kit's `findPdfParagraphs`) finds the paragraph's own words on the
// page, never from the change list's text, and only when the paragraph is certain:
//   - the paragraph is visible: hidden text (w:vanish, direct or by style) is left out of the words searched, a paragraph with no visible words has no box, and a
//     change that lies only in hidden text has no box (nothing on the page changed: the words that remain may sit in another paragraph);
//   - its visible words are unique among the visible paragraphs of its side: no other visible paragraph has the same words or holds them inside a longer one, and no
//     header or footer does; every side the change touches must pass, or the change has no box on either side;
//   - a paragraph with a tracked deletion has no box (how the page prints the struck words is the reviewer's setting, so its words are not the file's);
//   - the finder found it, on pages that have a picture, and none of those pictures is flagged unchanged (a page the two sides print alike shows no change).
// Anything else leaves the change without a box and says so in `unplaced` ("not marked", with the reason). Headers and footers are never boxed: only body
// paragraph rows are placed, and a paragraph whose words a header or footer repeats is refused. A paragraph that runs over a page break gets one box per page
// (the finder's segments). Deleted paragraphs are boxed on the before side only (their row has no after paragraph), added ones on the after side only, a changed
// one on both sides. The layer reports a moved paragraph as a removed row and an added row, so each side is boxed by its own row when its words are unique.
// Paragraph numbers are the layer's (files/docx.ts: every w:p in document order, tables included), so the same walk is used here.
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { LayerDiffRow } from "../../formats/layer.ts";
import { canonicalOrRaw } from "./shared/ooxml-names.ts";
import type { PdfFindOutput, PdfFindQuery, PdfRect } from "../../../public-kit/helpers/pdf-text.mjs";
import type { PdfPager, Picture } from "./pictures.ts";

type Side = "before" | "after";
type Node = Record<string, unknown>;
export interface WordBox { picture: string; rect: PdfRect; highlights?: PdfRect[] }
export interface WordPlacement { boxes?: WordBox[]; unplaced?: Partial<Record<Side, string>> }

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, parseAttributeValue: false, trimValues: false, preserveOrder: true });
const attrsOf = (n: Node): Record<string, string> => (n[":@"] as Record<string, string> | undefined) ?? {};
const val = (n: Node | undefined, name = "w:val"): string | undefined => (n === undefined ? undefined : attrsOf(n)[`@_${name}`]);
const kidsOf = (n: Node, tag: string): Node[] | undefined => (Array.isArray(n[tag]) ? (n[tag] as Node[]) : undefined);
const OFF = new Set(["0", "false", "off"]);
/** The toggle `tag` in a property list: undefined when absent, else whether it is on. */
const toggle = (props: Node[], tag: string): boolean | undefined => {
  const p = props.find((x) => x[tag] !== undefined);
  return p === undefined ? undefined : !OFF.has(val(p) ?? "");
};

export interface WordPara {
  /** The words the page prints for the paragraph: hidden text and tracked-deleted text left out. */
  text: string;
  /** Some text in the paragraph is hidden. */
  hidden: boolean;
  /** The paragraph holds a tracked deletion. */
  deleted: boolean;
}

/** Which style ids are hidden (w:vanish on the style or on one it is based on). */
function hiddenStyles(xml: string | undefined): Set<string> {
  const out = new Set<string>();
  if (xml === undefined) return out;
  const own = new Map<string, { vanish: boolean | undefined; basedOn: string | undefined }>();
  const visit = (nodes: Node[]): void => {
    for (const n of nodes) for (const [tag, kids] of Object.entries(n)) {
      if (tag === ":@" || !Array.isArray(kids)) continue;
      if (tag === "w:style") {
        const rPr = (kids as Node[]).find((k) => k["w:rPr"] !== undefined);
        const props = rPr ? (rPr["w:rPr"] as Node[]) : [];
        own.set(val(n, "w:styleId") ?? "", { vanish: toggle(props, "w:vanish"), basedOn: val((kids as Node[]).find((k) => k["w:basedOn"] !== undefined), "w:val") });
      } else visit(kids as Node[]);
    }
  };
  visit(parser.parse(xml) as Node[]);
  for (const id of own.keys()) {
    let cur: string | undefined = id;
    for (let hops = 0; cur !== undefined && hops < 20; hops++) {
      const s = own.get(cur);
      if (s === undefined) break;
      if (s.vanish !== undefined) { if (s.vanish) out.add(id); break; }
      cur = s.basedOn;
    }
  }
  return out;
}

/** The paragraphs of a .docx in the layer's order, with the words each prints, and the (folded) words of every header and footer paragraph. Throws on an unreadable package. */
export function readWordParas(bytes: Uint8Array): { paras: WordPara[]; frame: string[] } {
  const files = unzipSync(bytes, { filter: (f) => /^word\/(document\.xml|styles\.xml|(header|footer)\d*\.xml)$/.test(f.name) });
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("not a Word document: word/document.xml is missing");
  const text = (name: string): string | undefined => (files[name] ? canonicalOrRaw(Buffer.from(files[name]!).toString("utf8"), "ooxml", name) : undefined);
  const styleHidden = hiddenStyles(text("word/styles.xml"));
  const read = (nodes: Node[], hiddenByStyle: boolean, st: { hidden: boolean; deleted: boolean }): string => {
    let out = "";
    for (const n of nodes) for (const [tag, kids] of Object.entries(n)) {
      if (tag === ":@" || !Array.isArray(kids)) continue;
      const k = kids as Node[];
      if (tag === "w:r") {
        const rPr = k.find((x) => x["w:rPr"] !== undefined);
        const props = rPr ? (rPr["w:rPr"] as Node[]) : [];
        const rs = val(props.find((x) => x["w:rStyle"] !== undefined), "w:val");
        const direct = toggle(props, "w:vanish");
        const vanish = direct ?? (hiddenByStyle || (rs !== undefined && styleHidden.has(rs)));
        const inner = read(k, false, st);
        if (vanish) { if (inner !== "" || k.some((x) => x["w:t"] !== undefined)) st.hidden = true; continue; }
        out += inner;
      } else if (tag === "w:t") {
        for (const t of k) if (typeof t["#text"] === "string") out += t["#text"];
      } else if (tag === "w:tab") out += "\t";
      else if (tag === "w:br" || tag === "w:cr") out += "\n";
      else if (tag === "w:del" || tag === "w:moveFrom" || tag === "w:delText") st.deleted = true;
      else if (tag === "mc:Fallback" || tag === "w:pPr") continue;
      else out += read(k, hiddenByStyle, st);
    }
    return out;
  };
  const paraOf = (kids: Node[]): WordPara => {
    const pPr = kids.find((x) => x["w:pPr"] !== undefined);
    const ps = val((pPr?.["w:pPr"] as Node[] | undefined)?.find((x) => x["w:pStyle"] !== undefined), "w:val");
    const st = { hidden: false, deleted: false };
    return { text: read(kids, ps !== undefined && styleHidden.has(ps), st), hidden: st.hidden, deleted: st.deleted };
  };
  const paras: WordPara[] = [];
  const collect = (nodes: Node[], into: WordPara[]): void => {
    for (const n of nodes) for (const [tag, kids] of Object.entries(n)) {
      if (tag === ":@" || !Array.isArray(kids)) continue;
      if (tag === "w:p") into.push(paraOf(kids as Node[]));
      else collect(kids as Node[], into);
    }
  };
  const findDoc = (nodes: Node[]): void => {
    for (const n of nodes) for (const [tag, kids] of Object.entries(n)) {
      if (tag === ":@" || !Array.isArray(kids)) continue;
      if (tag === "w:document") collect(kids as Node[], paras);
      else findDoc(kids as Node[]);
    }
  };
  findDoc(parser.parse(text("word/document.xml")!) as Node[]);
  const frame: string[] = [];
  for (const name of Object.keys(files)) {
    if (!/^word\/(header|footer)\d*\.xml$/.test(name)) continue;
    const xs: WordPara[] = [];
    collect(parser.parse(text(name)!) as Node[], xs);
    for (const x of xs) if (fold(x.text) !== "") frame.push(fold(x.text));
  }
  return { paras, frame };
}

/** Words as the finder compares them: whitespace collapsed, quotes, dashes and ligatures folded, soft hyphens and zero-width marks dropped. */
export function fold(s: string): string {
  return s.normalize("NFKC").replace(/[­​-‍﻿]/g, "").replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();
}

/** The changed words of `b` against `a`: the common prefix and suffix cut back to word edges; offsets into `b`. Empty when nothing is left to point at. */
export function changedSpan(a: string, b: string): Array<[number, number]> {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  let start = i, end = b.length - j;
  while (start > 0 && !/\s/.test(b[start - 1]!)) start--;
  while (end < b.length && !/\s/.test(b[end]!)) end++;
  return end > start ? [[start, end]] : [];
}

const MAX_PARAS_PER_SIDE = 40;
const TEXT_ROWS = new Set(["paragraph changed", "paragraph added", "paragraph removed", "paragraphs added", "paragraphs removed"]);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined);

interface Plan { row: number; side: Side; indices: number[] }

export interface WordBoxInput {
  rows: LayerDiffRow[];
  before?: Buffer;
  after?: Buffer;
  pdfs: { before?: Buffer; after?: Buffer };
  pager: PdfPager;
  pictures: Picture[];
}

/**
 * The boxes and unplaced words for each change of a Word answer, keyed by change index (the row's position: id `c<index+1>`). Only body paragraph rows are
 * handled; every other row is left alone. Never throws: anything unexpected is every touched row unplaced with the reason.
 */
export async function placeWordBoxes(inp: WordBoxInput): Promise<Map<number, WordPlacement>> {
  const out = new Map<number, WordPlacement>();
  const sidesOf = (row: LayerDiffRow): Array<{ side: Side; from: number; to: number }> => {
    const d = row.detail;
    const s: Array<{ side: Side; from: number; to: number }> = [];
    const bi = num(d.beforeIndex), ai = num(d.afterIndex);
    if (bi !== undefined) s.push({ side: "before", from: bi, to: num(d.beforeLast) ?? bi });
    if (ai !== undefined) s.push({ side: "after", from: ai, to: num(d.afterLast) ?? ai });
    return s;
  };
  const candidates = inp.rows.map((r, i) => ({ r, i })).filter(({ r }) => TEXT_ROWS.has(r.kind) && sidesOf(r).length > 0);
  if (candidates.length === 0) return out;
  const refuse = (i: number, why: string): void => {
    const un: Partial<Record<Side, string>> = {};
    for (const s of sidesOf(inp.rows[i]!)) un[s.side] = `not marked: ${why}`;
    out.set(i, { unplaced: un });
  };
  const all = (why: string): Map<number, WordPlacement> => { for (const { i } of candidates) refuse(i, why); return out; };
  try {
    const read: Partial<Record<Side, { paras: WordPara[]; frame: string[] }>> = {};
    for (const s of ["before", "after"] as const) {
      const b = inp[s];
      if (b !== undefined && inp.pdfs[s] !== undefined) read[s] = readWordParas(b);
    }
    if (inp.pager.find === undefined) return all("Word's page text cannot be placed on this machine");
    const folded = (s: Side): string[] => (read[s]?.paras ?? []).map((p) => fold(p.text));
    const foldedBy = { before: folded("before"), after: folded("after") };

    // which rows may be boxed, and why not otherwise
    const wanted: Record<Side, Set<number>> = { before: new Set(), after: new Set() };
    const plans: Plan[] = [];
    const reasons = new Map<number, string>();
    const certain = (side: Side, k: number): string | undefined => {
      const r = read[side];
      if (r === undefined) return "that side was not drawn";
      const p = r.paras[k];
      if (p === undefined) return "the paragraph is not in the file's text";
      const f = foldedBy[side][k]!;
      if (f === "") return "the paragraph is hidden text, which Word does not print";
      if (p.deleted) return "the paragraph holds a tracked deletion, which the page may print in the margin or struck through";
      if (r.frame.some((h) => h.includes(f))) return "a header or footer has the same words";
      for (let o = 0; o < foldedBy[side].length; o++) if (o !== k && foldedBy[side][o] !== "" && foldedBy[side][o]!.includes(f)) return "the same words appear in another paragraph";
      return undefined;
    };
    for (const { r, i } of candidates) {
      const sides = sidesOf(r);
      let why: string | undefined;
      const mine: Plan[] = [];
      for (const s of sides) {
        const idx: number[] = [];
        for (let k = s.from; k <= s.to; k++) idx.push(k - 1);
        if (idx.length > MAX_PARAS_PER_SIDE) { why = "too many paragraphs to mark one by one"; break; }
        for (const k of idx) { why = certain(s.side, k); if (why !== undefined) break; }
        if (why !== undefined) break;
        mine.push({ row: i, side: s.side, indices: idx });
      }
      if (why === undefined && r.kind === "paragraph changed" && foldedBy.before[mine[0]!.indices[0]!] === foldedBy.after[mine[1]!.indices[0]!]) why = "the change is in hidden text, which Word does not print";
      if (why !== undefined) { reasons.set(i, why); continue; }
      for (const m of mine) { plans.push(m); for (const k of m.indices) wanted[m.side].add(k); }
    }
    for (const [i, why] of reasons) refuse(i, why);
    if (plans.length === 0) return out;

    // one finder run per side: every visible paragraph in document order, the wanted ones with a box
    const found: Partial<Record<Side, { out: PdfFindOutput; byId: Map<string, PdfFindOutput["results"][number]> }>> = {};
    for (const s of ["before", "after"] as const) {
      if (wanted[s].size === 0) continue;
      const paras = read[s]!.paras;
      const spans = new Map<number, Array<[number, number]>>();
      for (const p of plans) if (p.side === s) {
        const row = inp.rows[p.row]!;
        if (row.kind !== "paragraph changed") continue;
        const bi = num(row.detail.beforeIndex)! - 1, ai = num(row.detail.afterIndex)! - 1;
        const a = read.before!.paras[bi]!.text, b = read.after!.paras[ai]!.text;
        spans.set(p.indices[0]!, s === "before" ? changedSpan(b, a) : changedSpan(a, b));
      }
      const queries: PdfFindQuery[] = [];
      paras.forEach((p, k) => {
        if (foldedBy[s][k] === "") return;
        queries.push({ id: String(k), text: p.text, want: wanted[s].has(k), ...(spans.has(k) && spans.get(k)!.length > 0 ? { spans: spans.get(k)! } : {}) });
      });
      const res = await inp.pager.find(inp.pdfs[s]!, queries);
      if (res === null) {
        for (const p of plans) if (p.side === s && !out.has(p.row)) refuse(p.row, "Word's page text could not be read");
        continue;
      }
      found[s] = { out: res, byId: new Map(res.results.map((x) => [x.id, x])) };
    }

    // boxes per row, all or none
    const pic = new Map(inp.pictures.map((p) => [p.id, p]));
    const rowBoxes = new Map<number, WordBox[]>();
    for (const p of plans) {
      if (out.has(p.row)) continue;
      const f = found[p.side];
      let why: string | undefined;
      const boxes: WordBox[] = [];
      if (f === undefined) why = "Word's page text could not be read";
      else for (const k of p.indices) {
        const r = f.byId.get(String(k));
        if (r === undefined || !r.found || r.segments.length === 0) { why = "the paragraph's words were not found on the page"; break; }
        for (const seg of r.segments) {
          const pc = pic.get(`${p.side}:page${seg.page}`);
          const pg = f.out.pages.find((x) => x.index === seg.page);
          if (pc === undefined) { why = `page ${seg.page} is not drawn`; break; }
          if (pc.unchanged === true) { why = `page ${seg.page} prints the same on both sides`; break; }
          if (pg !== undefined && pc.width !== undefined && pc.height !== undefined && (Math.abs(pg.width - pc.width) > 2 || Math.abs(pg.height - pc.height) > 2)) { why = `the page text and the picture of page ${seg.page} disagree on its size`; break; }
          const w = pc.width ?? pg?.width, h = pc.height ?? pg?.height;
          const inside = (q: PdfRect): boolean => w !== undefined && h !== undefined && q.x >= 0 && q.y >= 0 && q.w > 0 && q.h > 0 && q.x + q.w <= w + 1 && q.y + q.h <= h + 1;
          if (!inside(seg.rect)) { why = "the placed rectangle does not fit the page picture"; break; }
          const hl = seg.highlights.filter(inside);
          boxes.push({ picture: pc.id, rect: seg.rect, ...(hl.length > 0 ? { highlights: hl } : {}) });
        }
        if (why !== undefined) break;
      }
      if (why !== undefined) { refuse(p.row, why); rowBoxes.delete(p.row); continue; }
      rowBoxes.set(p.row, [...(rowBoxes.get(p.row) ?? []), ...boxes]);
    }
    for (const [i, boxes] of rowBoxes) if (!out.has(i)) out.set(i, { boxes });
    return out;
  } catch (e) {
    return all(`Word's boxes could not be placed (${(e as Error).message})`);
  }
}
