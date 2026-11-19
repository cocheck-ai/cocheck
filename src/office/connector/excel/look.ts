// What the print route writes onto the change list: v1 `boxes`, `unplaced` and `looksSame` from the boxes print-boxes.ts placed on each picture, and the PNG encoder the
// tests draw their pages with. Pure.
//
// Must not happen: a box on a neighbour cell (the reviewer trusts a wrong mark). Every ambiguous case drops to unplaced words, never to a guess. A dropped box costs only a mark.
import { deflateSync } from "node:zlib";
import { decodePng, type Pixels } from "../../../../public-kit/helpers/png.mjs";
import type { OfficeDoc } from "../program.ts";
import type { RegionPicture } from "./answer.ts";
import type { ExcelPlan } from "./diff.ts";

/** A rectangle in picture pixels. */
export type PixRect = { x: number; y: number; w: number; h: number };

export interface LookSide {
  /** The pictures of one side, each id `${side}:${group}:${order}`. */
  pictures: RegionPicture[];
  /** `clipped`: the change runs past this picture and the box is its visible intersection only. */
  boxes: { change: string; picture: string; rect: PixRect; clipped?: true }[];
  unplaced: { change: string; side: "before" | "after"; why: string }[];
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
  let c = 0xffffffff;
  for (const part of [head.subarray(4), data]) for (let i = 0; i < part.length; i++) c = CRC[(c ^ part[i]!) & 0xff]! ^ (c >>> 8);
  const tail = Buffer.alloc(4); tail.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}
/** An 8-bit RGBA PNG with fixed filter and level, so the same pixels always give the same bytes. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * True only when both pictures (or the given rectangle of each) hold the very same pixels. Different sizes, a rectangle outside a picture, or rectangles of
 * different sizes answer false: "looks the same" is a claim that the value did not change, so doubt never earns it.
 */
export function looksSame(before: Pixels, after: Pixels, rects?: { before: PixRect; after: PixRect }): boolean {
  const rb = rects?.before ?? { x: 0, y: 0, w: before.width, h: before.height }, ra = rects?.after ?? { x: 0, y: 0, w: after.width, h: after.height };
  if (rb.w !== ra.w || rb.h !== ra.h || rb.w < 1 || rb.h < 1) return false;
  const inside = (p: Pixels, r: PixRect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= p.width && r.y + r.h <= p.height;
  if (!inside(before, rb) || !inside(after, ra)) return false;
  for (let y = 0; y < rb.h; y++) {
    const a = ((rb.y + y) * before.width + rb.x) * 4, b = ((ra.y + y) * after.width + ra.x) * 4;
    if (!before.rgba.subarray(a, a + rb.w * 4).equals(after.rgba.subarray(b, b + rb.w * 4))) return false;
  }
  return true;
}

const pixelsOf = (p: RegionPicture): Pixels | undefined => { const m = /^data:image\/png;base64,(.*)$/.exec(p.src); return m ? decodePng(Buffer.from(m[1]!, "base64")) : undefined; };

/** Writes v1 `boxes`, `unplaced` and `looksSame` onto doc.changes. A box whose picture is not in doc.pictures is dropped, with "not pictured". */
export function applyLooks(doc: OfficeDoc, sides: LookSide[], plan: ExcelPlan): void {
  const shown = new Map<string, RegionPicture>();
  for (const s of sides) for (const p of s.pictures) if ((doc.pictures as { id: string }[] | undefined)?.some((q) => q.id === p.id)) shown.set(p.id, p);
  const sideOfPic = (id: string): "before" | "after" => shown.get(id)!.side;
  const pixels = new Map<string, Pixels | undefined>();
  const px = (p: RegionPicture): Pixels | undefined => { if (!pixels.has(p.id)) pixels.set(p.id, pixelsOf(p)); return pixels.get(p.id); };
  // a (side, group, order) held by exactly one picture is a mate the checker can find
  const held = new Map<string, number>();
  for (const p of shown.values()) held.set(`${p.side}|${p.group}|${p.order}`, (held.get(`${p.side}|${p.group}|${p.order}`) ?? 0) + 1);
  const allBoxes = sides.flatMap((s) => s.boxes), allUn = sides.flatMap((s) => s.unplaced);
  const mark = new Map(plan.changes.map((c) => [c.id, c.mark] as const));
  for (const ch of doc.changes as unknown as { id: string; text?: string; lines?: string[]; boxes?: unknown[]; unplaced?: { before?: string; after?: string } }[]) {
    // only a change the screen sides speak of is touched: whatever another route gave any other change stays as it is
    if (!allBoxes.some((b) => b.change === ch.id) && !allUn.some((u) => u.change === ch.id)) continue;
    const m = mark.get(ch.id);
    const mine = allBoxes.filter((b) => b.change === ch.id && shown.has(b.picture)
      && !(m === "added" && sideOfPic(b.picture) === "before") && !(m === "removed" && sideOfPic(b.picture) === "after"));
    const un: { before?: string; after?: string } = {};
    for (const side of ["before", "after"] as const) {
      const words = allUn.filter((u) => u.change === ch.id && u.side === side && !mine.some((b) => sideOfPic(b.picture) === side)).map((u) => u.why);
      const dropped = allBoxes.some((b) => b.change === ch.id && !shown.has(b.picture) && sideOf(sides, b.picture) === side) && !mine.some((b) => sideOfPic(b.picture) === side);
      if (words.length) un[side] = [...new Set(words)].join("; ");
      else if (dropped) un[side] = "not pictured";
    }
    const boxes: { picture: string; rect: PixRect; looksSame?: true }[] = mine.map((b) => ({ picture: b.picture, rect: b.rect }));
    // a box that is only part of the change says so in words, once per picture
    const cut = mine.filter((b) => b.clipped === true);
    for (const b of cut) {
      const note = m === "added" ? `Inserted: this insertion continues outside the picture; only the inserted part inside ${shown.get(b.picture)!.label} is boxed.` : `Continues outside the picture: only the part inside ${shown.get(b.picture)!.label} is boxed.`;
      if (!(ch.lines ?? []).includes(note)) ch.lines = [...(ch.lines ?? []), note];
    }
    const bs = boxes.filter((b) => sideOfPic(b.picture) === "before"), as = boxes.filter((b) => sideOfPic(b.picture) === "after");
    // "the displayed value did not change" is never said of a change that continues outside its picture
    if (cut.length === 0 && bs.length === 1 && as.length === 1) {
      const pb = shown.get(bs[0]!.picture)!, pa = shown.get(as[0]!.picture)!;
      if (pb.group === pa.group && pb.order === pa.order && held.get(`before|${pb.group}|${pb.order}`) === 1 && held.get(`after|${pa.group}|${pa.order}`) === 1) {
        const xb = px(pb), xa = px(pa);
        if (xb && xa && looksSame(xb, xa, { before: bs[0]!.rect, after: as[0]!.rect })) {
          bs[0]!.looksSame = true; as[0]!.looksSame = true;
          // the person reads the words: a changed cell whose picture is the same on both sides did not change on screen
          ch.text = ch.text !== undefined && ch.text !== "" ? `${ch.text}; the displayed value did not change` : "The displayed value did not change";
        }
      }
    }
    if (boxes.length) ch.boxes = boxes; else delete ch.boxes;
    if (un.before !== undefined || un.after !== undefined) ch.unplaced = un; else delete ch.unplaced;
  }
}

const sideOf = (sides: LookSide[], pictureId: string): "before" | "after" | undefined => sides.flatMap((s) => s.pictures).find((p) => p.id === pictureId)?.side;
