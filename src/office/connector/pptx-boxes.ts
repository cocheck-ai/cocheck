// PowerPoint's boxes on its own PDF pages (level 3). The frames come from the deck XML (src/office/connector/pptx/frames.ts: slide, layout, master, group
// scaling, rotation); the page of a slide counts only the slides PowerPoint prints (a hidden slide has none); the slide size in EMU maps to the
// picture's pixels. Pixels decide last: a box with no ink difference under it is dropped, which is the same test `cocheck connector test` applies.
//
// Must not happen: a box on the wrong shape or the wrong slide (a page map that forgot a hidden slide). A missing box costs only a mark with
// words, so every doubt drops the box: a page count that is not the shown-slide count, a picture of another shape or size than the slide, a frame that
// does not resolve, a page that cannot be decoded, a slide pair with no comparator page.
import { decodePng, sameRegion, sameRegionAt, type Pixels } from "../../../public-kit/helpers/png.mjs";
import type { LayerDiffRow } from "../../formats/layer.ts";
import { matchDeckSlides, matchShapes, place, type Placed } from "./pptx/diff.ts";
import type { Frame } from "./pptx/frames.ts";
import { readDeckFrames, type Deck } from "./pptx/reader.ts";
import type { Picture } from "./pictures.ts";

type Side = "before" | "after";
interface IRect { x: number; y: number; w: number; h: number }
/** The fields of a change this module may add (program.ts's `Change` does not name them; they are spec level 3 fields). */
export interface BoxChange { id: string; mark: string; boxes?: { picture: string; rect: IRect }[]; unplaced?: Partial<Record<Side, string>>; lines?: string[] }

export interface PptxBoxInput {
  before?: Uint8Array;
  after?: Uint8Array;
  /** The reader's rows, `rows[i]` being the row of `changes[i]`. */
  rows: LayerDiffRow[];
  changes: BoxChange[];
  pictures: Picture[];
  caveats: string[];
}

const PNG_PREFIX = "data:image/png;base64,";
/** The words for a change on a slide PowerPoint does not print. */
export const hiddenWords = (n: number): string => `slide ${n} is hidden; PowerPoint does not print it`;
export const OVERFLOW_WORDS = "text runs past its box";
/** Rows about a slide's own parts, never a shape: a shape that happens to be named like one is not boxed. */
const RESERVED = new Set(["Notes", "comment", "Hidden", "Transition"]);
/** Rows where a shape moved or changed size (the reader's kinds). */
const GEOMETRY_KINDS = new Set(["shape moved", "shape resized", "shape moved and resized"]);
/** Differing pixels just outside a text box that make it "runs past its box". */
const OVERFLOW_MIN_PIXELS = 8;
const OVERFLOW_RING = 0.06;

interface SideState {
  deck: Deck;
  frames: (Frame | undefined)[][];
  size: { cx: number; cy: number };
  /** Printed page (1-based) of each slide index, undefined for a hidden slide. */
  pageOf: (number | undefined)[];
  pics: Map<number, Picture>;
}

function sideState(bytes: Uint8Array | undefined, side: Side, pictures: Picture[], caveats: string[]): SideState | undefined {
  if (bytes === undefined) return undefined;
  const pics = pictures.filter((p) => p.side === side);
  if (pics.length === 0) return undefined;
  const { deck, size, frames } = readDeckFrames(bytes);
  if (size === undefined) return undefined;
  let n = 0;
  const pageOf = deck.slides.map((s) => (s.hidden === true ? undefined : ++n));
  if (pics[0]!.pageCount !== n) {
    caveats.push(`${side === "before" ? "Before" : "After"}: PowerPoint printed ${pics[0]!.pageCount} pages for ${n} shown slides, so no box is drawn on this side.`);
    return undefined;
  }
  return { deck, frames, size, pageOf, pics: new Map(pics.map((p) => [p.page, p])) };
}

/** A picture that can carry boxes for this deck: it has a size, and the shape of the slide. */
function usable(sd: SideState, pic: Picture | undefined): pic is Picture & { width: number; height: number } {
  if (pic === undefined || pic.width === undefined || pic.height === undefined || pic.width < 1 || pic.height < 1) return false;
  return Math.abs(pic.width / pic.height - sd.size.cx / sd.size.cy) <= 0.01 * (sd.size.cx / sd.size.cy);
}

function toRect(sd: SideState, pic: Picture & { width: number; height: number }, f: Frame): IRect | undefined {
  const kx = pic.width / sd.size.cx, ky = pic.height / sd.size.cy;
  const e = (v: number): number => Math.round(v * 1e6) / 1e6; // float noise must not move a whole-pixel edge by one
  const x0 = Math.max(0, Math.floor(e(f.x * kx))), y0 = Math.max(0, Math.floor(e(f.y * ky)));
  const x1 = Math.min(pic.width, Math.ceil(e((f.x + f.w) * kx))), y1 = Math.min(pic.height, Math.ceil(e((f.y + f.h) * ky)));
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

const pathMatch = (list: Placed[], rest: string): Placed | undefined => {
  let best: Placed | undefined;
  for (const p of list) if ((rest === p.path || rest.startsWith(`${p.path} / `)) && (best === undefined || p.path.length > best.path.length)) best = p;
  return best;
};

interface Cand { change: number; side: Side; pic: Picture & { width: number; height: number }; rect: IRect; text: boolean }
interface Patch { boxes: { picture: string; rect: IRect }[]; unplaced: Partial<Record<Side, string>>; lines: string[] }

function compute(inp: PptxBoxInput): Map<number, Patch> {
  const out = new Map<number, Patch>();
  const patch = (i: number): Patch => out.get(i) ?? out.set(i, { boxes: [], unplaced: {}, lines: [] }).get(i)!;
  const sides: Record<Side, SideState | undefined> = {
    before: sideState(inp.before, "before", inp.pictures, inp.caveats),
    after: sideState(inp.after, "after", inp.pictures, inp.caveats),
  };
  const bd = sides.before?.deck ?? (inp.before ? readDeckFrames(inp.before).deck : undefined);
  const ad = sides.after?.deck ?? (inp.after ? readDeckFrames(inp.after).deck : undefined);
  const matchAfter = bd && ad ? matchDeckSlides(bd, ad) : new Map<number, number>();
  const inv = new Map([...matchAfter].map(([i, j]) => [j, i]));
  const pixels = new Map<string, Pixels | undefined>();
  const pix = (pic: Picture): Pixels | undefined => {
    if (!pixels.has(pic.id)) pixels.set(pic.id, pic.src?.startsWith(PNG_PREFIX) ? decodePng(Buffer.from(pic.src.slice(PNG_PREFIX.length), "base64")) : undefined);
    return pixels.get(pic.id);
  };
  const exists = (i: number, side: Side): boolean => (side === "before" ? inp.changes[i]!.mark !== "added" : inp.changes[i]!.mark !== "removed");
  const cands: Cand[] = [];
  /** The page picture of slide `idx` on `side`, or undefined (not drawn, hidden, wrong shape). */
  const pageOf = (side: Side, idx: number | undefined): (Picture & { width: number; height: number }) | undefined => {
    const sd = sides[side];
    if (sd === undefined || idx === undefined) return undefined;
    const page = sd.pageOf[idx];
    const pic = page === undefined ? undefined : sd.pics.get(page);
    return usable(sd, pic) ? pic : undefined;
  };

  inp.rows.forEach((row, i) => {
    const m = /^Slide (\d+)(?: \/ ([\s\S]*))?$/.exec(row.location);
    if (!m || inp.changes[i] === undefined) return;
    const n = Number(m[1]) - 1, rest = m[2];
    // a whole slide that is added or removed: a whole-page box on the side that has it, the other side absent
    if (rest === undefined && (row.kind === "slide removed" || row.kind === "slide added")) {
      const side: Side = row.kind === "slide removed" ? "before" : "after";
      const sd = sides[side];
      if (sd === undefined || n < 0 || n >= sd.deck.slides.length) return;
      if (sd.pageOf[n] === undefined) { patch(i).unplaced[side] = hiddenWords(n + 1); return; }
      const pic = pageOf(side, n);
      if (pic) patch(i).boxes.push({ picture: pic.id, rect: { x: 0, y: 0, w: pic.width, h: pic.height } });
      return;
    }
    if (rest === undefined || n < 0) return;
    const j = n, bi = inv.get(j);
    if (bd === undefined && ad === undefined) return;
    // hidden slides: the words, on each side the change has
    for (const [side, idx] of [["before", bi], ["after", j]] as const) {
      const sd = sides[side];
      if (sd !== undefined && idx !== undefined && sd.pageOf[idx] === undefined && exists(i, side)) patch(i).unplaced[side] = hiddenWords(idx + 1);
    }
    if (RESERVED.has(rest.split(" / ")[0]!)) return;
    const aSlide = ad?.slides[j], bSlide = bi === undefined ? undefined : bd?.slides[bi];
    if (aSlide === undefined && row.kind !== "shape removed") return;
    const placedA = aSlide ? place(aSlide.shapes) : [], placedB = bSlide ? place(bSlide.shapes) : [];
    let shapeA: Placed | undefined, shapeB: Placed | undefined;
    if (row.kind === "shape removed") {
      if (bSlide === undefined) return;
      shapeB = pathMatch(placedB, rest);
    } else {
      shapeA = pathMatch(placedA, rest);
      if (shapeA === undefined) return;
      if (bSlide !== undefined) shapeB = matchShapes(placedB, placedA).pairs.find(([, pb]) => pb === shapeA)?.[0];
    }
    const text = (shapeA ?? shapeB)?.shape.kind === "text";
    for (const [side, shape, idx, slide] of [["before", shapeB, bi, bSlide], ["after", shapeA, j, aSlide]] as const) {
      const sd = sides[side];
      if (sd === undefined || shape === undefined || idx === undefined || slide === undefined || !exists(i, side)) continue;
      const pic = pageOf(side, idx);
      const frame = sd.frames[idx]?.[slide.shapes.indexOf(shape.shape)];
      const rect = pic && frame ? toRect(sd, pic, frame) : undefined;
      if (pic && rect) cands.push({ change: i, side, pic, rect, text });
    }
  });

  // pixels decide: a box with no ink difference under it is dropped, and so is one that cannot be checked
  const kept: Cand[] = [];
  const byChange = new Map<number, Cand[]>();
  for (const c of cands) byChange.set(c.change, [...(byChange.get(c.change) ?? []), c]);
  for (const [i, cs] of byChange) {
    const b = cs.find((c) => c.side === "before"), a = cs.find((c) => c.side === "after");
    const row = inp.rows[i]!;
    const m = /^Slide (\d+)/.exec(row.location)!;
    const j = Number(m[1]) - 1, bi = inv.get(j);
    let differs: boolean | undefined;
    if (b && a) {
      const [pb, pa] = [pix(b.pic), pix(a.pic)];
      const same = pb && pa ? sameRegionAt(pb, b.rect, pa, a.rect) : undefined;
      differs = same === undefined ? undefined : !same;
      // a shape that moved looks the same where it is now as where it was: the page differs at the spot it left and the spot it took
      if (differs === false && GEOMETRY_KINDS.has(row.kind) && pb && pa) differs = sameRegion(pb, pa, b.rect) === false || sameRegion(pb, pa, a.rect) === false;
    } else {
      const one = (b ?? a)!;
      const otherSide: Side = one.side === "before" ? "after" : "before";
      const otherIdx = otherSide === "before" ? bi : j;
      const other = sides[otherSide];
      const otherPic = pageOf(otherSide, otherIdx);
      if (otherPic) {
        const [p1, p2] = [pix(one.pic), pix(otherPic)];
        const same = p1 && p2 ? sameRegion(p1, p2, one.rect) : undefined;
        differs = same === undefined ? undefined : !same;
      } else if (other !== undefined && otherIdx !== undefined && other.pageOf[otherIdx] === undefined) differs = true; // the other side's slide is hidden: nothing is printed to compare with
    }
    if (differs === true) kept.push(...cs);
  }
  for (const c of kept) patch(c.change).boxes.push({ picture: c.pic.id, rect: c.rect });

  // text that runs past its frame: ink that differs just outside a text box (and inside no other change's box) on a slide pair of the same size
  for (const c of kept) {
    if (!c.text) continue;
    const row = inp.rows[c.change]!;
    const j = Number(/^Slide (\d+)/.exec(row.location)![1]) - 1, bi = inv.get(j);
    const pb = pageOf("before", bi), pa = pageOf("after", j);
    const [xb, xa] = [pb && pix(pb), pa && pix(pa)];
    if (!xb || !xa || xb.width !== xa.width || xb.height !== xa.height) continue;
    const others = kept.filter((k) => k.change !== c.change && k.pic.page === c.pic.page && k.side === c.side).map((k) => k.rect);
    const pad = Math.max(6, Math.round(c.pic.height * OVERFLOW_RING));
    const r = c.rect;
    const inside = (x: number, y: number, q: IRect): boolean => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h;
    let ink = 0;
    for (let y = Math.max(0, r.y - pad); y < Math.min(xa.height, r.y + r.h + pad); y++) {
      for (let x = Math.max(0, r.x - pad); x < Math.min(xa.width, r.x + r.w + pad); x++) {
        if (inside(x, y, r) || others.some((q) => inside(x, y, q))) continue;
        const o = (y * xa.width + x) * 4;
        if (!xa.rgba.subarray(o, o + 4).equals(xb.rgba.subarray(o, o + 4))) ink++;
      }
    }
    if (ink >= OVERFLOW_MIN_PIXELS) { const p = patch(c.change); if (!p.lines.includes(OVERFLOW_WORDS)) p.lines.push(OVERFLOW_WORDS); }
  }
  return out;
}

/** Adds PowerPoint's boxes, hidden-slide words and overflow words to `changes` in place. A failure leaves the changes as they were and says so in a caveat. */
export function addPptxBoxes(inp: PptxBoxInput): void {
  let patches: Map<number, Patch>;
  try {
    patches = compute(inp);
  } catch (e) {
    inp.caveats.push(`PowerPoint's boxes could not be placed on this pair (${(e as Error).message}); the changes are listed without boxes.`);
    return;
  }
  for (const [i, p] of patches) {
    const c = inp.changes[i]!;
    if (p.boxes.length > 0) c.boxes = p.boxes;
    if (Object.keys(p.unplaced).length > 0) c.unplaced = p.unplaced;
    if (p.lines.length > 0) c.lines = [...(c.lines ?? []), ...p.lines];
  }
}
