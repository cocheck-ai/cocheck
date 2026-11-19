import { createHash } from "node:crypto";
import { alignSequences } from "../../formats/files/align.ts";
import { decodePng, diffPixels, regionsOf, type Pixels } from "../picture.ts";

/**
 * The page cross-check. Text finds what changed on a page; it cannot see a chart, a picture or a fill. So pages whose text is the
 * same on both sides are also compared by pixels, with the picture tier's own differ (`diffPixels`, `regionsOf`). A pixel-identical pair
 * yields nothing, and a page that already holds a text-match box is never compared: a text change is never downgraded to a pixel one.
 */

export interface PageText {
  index: number;
  /** The page's lines, whitespace-normalised and joined; two pages with the same signature have the same text. */
  signature: string;
}

export interface PagePair {
  before: number;
  after: number;
}

export interface PixelPage {
  before: number;
  after: number;
  /** Boxes around the differing pixels, in the pixels of the two page pictures. */
  regions: Array<{ x: number; y: number; w: number; h: number }>;
}

/**
 * Pages with text pair by text, the way lines do: their signatures are aligned with `alignSequences`, and the pages it leaves out as
 * identical pair in order. A page that moved, was inserted or has changed text has no partner. Pages with no text pair by position, and
 * only when both sides have the same page count (both pages at that position have no text); with differing counts position means
 * nothing, so they are left for `matchByPicture`.
 */
export function pairPages(before: PageText[], after: PageText[]): PagePair[] {
  const tb = before.filter((p) => p.signature !== "");
  const ta = after.filter((p) => p.signature !== "");
  const changed = alignSequences(tb.map((p) => p.signature), ta.map((p) => p.signature));
  const gone = new Set(changed.flatMap((p) => (p.before === null ? [] : [p.before])));
  const added = new Set(changed.flatMap((p) => (p.after === null ? [] : [p.after])));
  const keptB = tb.filter((_, i) => !gone.has(i));
  const keptA = ta.filter((_, i) => !added.has(i));
  const pairs: PagePair[] = keptB.map((p, i) => ({ before: p.index, after: keptA[i]!.index }));
  if (before.length === after.length) {
    before.forEach((p, i) => {
      if (p.signature === "" && after[i]!.signature === "") pairs.push({ before: p.index, after: after[i]!.index });
    });
  }
  return pairs.sort((x, y) => x.before - y.before);
}

/** A page with no partner, with the size of its picture in pixels. */
export interface UnpairedPage {
  side: "before" | "after";
  page: number;
  w: number;
  h: number;
}

export interface PictureMatch {
  /** Pages whose pictures are identical on both sides, paired in order. */
  pairs: PagePair[];
  unpaired: UnpairedPage[];
  /** Pages whose picture could not be drawn or read: neither paired nor shown. */
  skipped: number;
  /** The same pages, by side and number, so a caveat can name them. */
  skippedPages: Array<{ side: "before" | "after"; page: number }>;
}

const pictureHash = (px: Pixels): string => createHash("sha256").update(`${px.w}x${px.h}`).update(px.data).digest("hex");

/**
 * Text-less pages that text could not pair (page counts differ, or the partner at the same position has text). Their pictures are drawn
 * and aligned by exact content, so an inserted picture-only page is the one unpaired page and its unchanged neighbours still pair.
 */
export async function matchByPicture(before: number[], after: number[], render: RenderPage): Promise<PictureMatch> {
  let skipped = 0;
  const skippedPages: PictureMatch["skippedPages"] = [];
  const load = async (side: "before" | "after", pages: number[]) => {
    const out: Array<{ page: number; px: Pixels; hash: string }> = [];
    for (const page of pages) {
      const png = await render(side, page);
      const px = png === null ? null : decodePng(png);
      if (px === null) {
        skipped += 1;
        skippedPages.push({ side, page });
      } else out.push({ page, px, hash: pictureHash(px) });
    }
    return out;
  };
  const [b, a] = [await load("before", before), await load("after", after)];
  const changed = alignSequences(b.map((p) => p.hash), a.map((p) => p.hash));
  const gone = new Set(changed.flatMap((p) => (p.before === null ? [] : [p.before])));
  const added = new Set(changed.flatMap((p) => (p.after === null ? [] : [p.after])));
  const keptB = b.filter((_, i) => !gone.has(i));
  const keptA = a.filter((_, i) => !added.has(i));
  const unpaired: UnpairedPage[] = [
    ...b.filter((_, i) => gone.has(i)).map((p) => ({ side: "before" as const, page: p.page, w: p.px.w, h: p.px.h })),
    ...a.filter((_, i) => added.has(i)).map((p) => ({ side: "after" as const, page: p.page, w: p.px.w, h: p.px.h })),
  ];
  return { pairs: keptB.map((p, i) => ({ before: p.page, after: keptA[i]!.page })), unpaired, skipped, skippedPages };
}

/** Renders page `n` of one side as a PNG, or null when it cannot be drawn. */
export type RenderPage = (side: "before" | "after", n: number) => Promise<Buffer | null>;

export interface PixelResult {
  pages: PixelPage[];
  /** Pairs that could not be compared because a picture could not be drawn or read. */
  skipped: number;
  /** Those pairs themselves, so both pages can be named. */
  skippedPairs: PagePair[];
}

/** Compares each pair's two pictures. A pair with no differing pixel is left out. */
export async function comparePages(pairs: PagePair[], render: RenderPage): Promise<PixelResult> {
  const pages: PixelPage[] = [];
  let skipped = 0;
  const skippedPairs: PagePair[] = [];
  for (const pair of pairs) {
    const [b, a] = await Promise.all([render("before", pair.before), render("after", pair.after)]);
    const pb: Pixels | null = b === null ? null : decodePng(b);
    const pa: Pixels | null = a === null ? null : decodePng(a);
    if (pb === null || pa === null) {
      skipped += 1;
      skippedPairs.push(pair);
      continue;
    }
    const d = diffPixels(pb, pa);
    if (d.count === 0) continue;
    pages.push({ before: pair.before, after: pair.after, regions: regionsOf(d) });
  }
  return { pages, skipped, skippedPairs };
}

/**
 * The page account. Every page of both sides gets exactly one status, whatever the pairing did:
 *   T   holds a text-match box (shown)
 *   P=  paired 1:1 (identical page text, text-less by position on equal counts, or identical picture) and pixel-identical (hidden, counted)
 *   P≠ paired 1:1, pixels differ (shown, pixel boxes)
 *   R   has text, no box, no 1:1 partner because page breaks moved (shown, no box, pictures not compared)
 *   U   no text, no partner (shown whole-boxed by pixels)
 *   S   could not be drawn (named by number)
 * A pair is a 1:1 partner only when neither page is T: when one side is T the other is R, never dropped.
 */
export type PageStatus = "T" | "P=" | "P≠" | "R" | "U" | "S";

export interface AccountInput {
  before: Array<{ index: number; hasText: boolean }>;
  after: Array<{ index: number; hasText: boolean }>;
  /** Pages holding a text-match box. */
  boxed: { before: ReadonlySet<number>; after: ReadonlySet<number> };
  /** Every 1:1 candidate (text, position and picture pairs). */
  pairs: PagePair[];
  /** Pairs whose pixels differ. */
  changed: PagePair[];
  /** Pairs that could not be compared because a picture failed. */
  skippedPairs: PagePair[];
  /** Pages that could not be drawn. */
  skippedPages: Array<{ side: "before" | "after"; page: number }>;
  /** Text-less pages that went through matchByPicture without a partner (the ones that can be U); others with no partner cannot be drawn. */
  drawnUnpaired: Array<{ side: "before" | "after"; page: number }>;
  /** One entry per unchanged line: the before page and the after page it sits on. Used for naming R groups only. */
  linked: PagePair[];
}

export interface RGroup {
  before: number[];
  after: number[];
}

export interface PageAccount {
  before: Map<number, PageStatus>;
  after: Map<number, PageStatus>;
  groups: RGroup[];
}

export function accountPages(input: AccountInput): PageAccount {
  const key = (p: PagePair) => `${p.before}:${p.after}`;
  const skippedPair = new Set(input.skippedPairs.map(key));
  const changed = new Set(input.changed.map(key));
  const skippedPage = (side: "before" | "after") => new Set(input.skippedPages.filter((s) => s.side === side).map((s) => s.page));
  const drawn = (side: "before" | "after") => new Set(input.drawnUnpaired.filter((s) => s.side === side).map((s) => s.page));
  const partner = { before: new Map<number, PagePair>(), after: new Map<number, PagePair>() };
  for (const p of input.pairs) {
    if (input.boxed.before.has(p.before) || input.boxed.after.has(p.after)) continue;
    partner.before.set(p.before, p);
    partner.after.set(p.after, p);
  }
  const status = (side: "before" | "after"): Map<number, PageStatus> => {
    const out = new Map<number, PageStatus>();
    const skip = skippedPage(side);
    const unpaired = drawn(side);
    for (const pg of input[side]) {
      const n = pg.index;
      const pair = partner[side].get(n);
      let s: PageStatus;
      if (input.boxed[side].has(n)) s = "T";
      else if (skip.has(n) || (pair !== undefined && skippedPair.has(key(pair)))) s = "S";
      else if (pair !== undefined) s = changed.has(key(pair)) ? "P≠" : "P=";
      else if (pg.hasText) s = "R";
      else s = unpaired.has(n) ? "U" : "S";
      out.set(n, s);
    }
    return out;
  };
  const before = status("before");
  const after = status("after");
  // R groups: before and after pages joined whenever an unchanged line goes from one to the other; connected components.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const l of input.linked) {
    const a = find(`b${l.before}`);
    const b = find(`a${l.after}`);
    if (a !== b) parent.set(a, b);
  }
  const comps = new Map<string, RGroup>();
  const add = (side: "before" | "after", n: number) => {
    const root = find(`${side === "before" ? "b" : "a"}${n}`);
    const g = comps.get(root) ?? { before: [], after: [] };
    g[side].push(n);
    comps.set(root, g);
  };
  for (const [n] of before) add("before", n);
  for (const [n] of after) add("after", n);
  const groups = [...comps.values()]
    .filter((g) => g.before.some((n) => before.get(n) === "R") || g.after.some((n) => after.get(n) === "R"))
    .map((g) => ({ before: g.before.sort((x, y) => x - y), after: g.after.sort((x, y) => x - y) }))
    .sort((x, y) => (x.before[0] ?? Infinity) - (y.before[0] ?? Infinity) || (x.after[0] ?? Infinity) - (y.after[0] ?? Infinity));
  return { before, after, groups };
}

/** [1,2,3,5] -> "pages 1-3 and 5"; [4] -> "page 4"; [] -> "". The one place page numbers are written into a caveat. */
export function pageRanges(nums: number[]): string {
  const n = [...new Set(nums)].sort((a, b) => a - b);
  if (n.length === 0) return "";
  const runs: string[] = [];
  for (let i = 0; i < n.length; ) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j]! + 1) j++;
    runs.push(j > i ? `${n[i]}-${n[j]}` : `${n[i]}`);
    i = j + 1;
  }
  const list = runs.length === 1 ? runs[0]! : `${runs.slice(0, -1).join(", ")} and ${runs[runs.length - 1]}`;
  return `${n.length === 1 ? "page" : "pages"} ${list}`;
}

/** "is" / "are" for a count of pages. */
export const beVerb = (count: number): string => (count === 1 ? "is" : "are");
