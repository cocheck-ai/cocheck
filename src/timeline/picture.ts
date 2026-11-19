import { inflateSync } from "node:zlib";
import { imageTypeOf, readStoredImage } from "./stored-image.ts";
import { isSecretPath, secretLine } from "../secret-files.ts";
import type { Generic, GenericRegion } from "./generic.ts";
import { claimedFile } from "../connector/claimed-state.ts";

/**
 * The picture tier of a file change: a changed png, jpg, jpeg, gif, webp or svg file that is not secret. The browser shows both states
 * itself from the stored bytes (the preview route serves them), so nothing is rendered here. When both states are PNGs, they are decoded
 * with node's zlib (no dependency) and a pixel diff names the regions that changed. Any other pair has no boxes.
 *
 * The region step is bounded (grid cells instead of a per-pixel flood) so the timeline route stays fast.
 *
 * Honesty rule: two PNGs that match pixel for pixel say "The change isn't visible in this preview".
 */

export const PICTURE_LABEL = "The image as stored, drawn by your browser";
export const NOT_VISIBLE = "The change isn't visible in this preview";
/** The reason a state a connector reads has no picture from CoCheck. */
export const CLAIMED_NO_PICTURE = "a connector reads this type of file, so CoCheck draws no picture of it.";

/** The most pixels one decoded picture may hold; a larger one falls to the fingerprint tier rather than costing the route time. */
export const MAX_PIXELS = 4_000_000;
/** The most regions listed; past this they are merged into one box around them all. */
export const MAX_REGIONS = 20;

export interface Pixels {
  w: number;
  h: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes a non-interlaced 8-bit PNG (gray, gray+alpha, RGB, RGBA or palette) to RGBA; null for anything else or a damaged file. */
export function decodePng(buf: Buffer): Pixels | null {
  try {
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    let pos = 8;
    let w = 0, h = 0, depth = 0, type = -1, interlace = 0;
    let palette: Buffer | null = null;
    let trns: Buffer | null = null;
    const idat: Buffer[] = [];
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const name = buf.toString("latin1", pos + 4, pos + 8);
      const body = buf.subarray(pos + 8, pos + 8 + len);
      if (body.length !== len) return null;
      if (name === "IHDR") {
        w = body.readUInt32BE(0);
        h = body.readUInt32BE(4);
        depth = body[8]!;
        type = body[9]!;
        interlace = body[12]!;
      } else if (name === "PLTE") palette = body;
      else if (name === "tRNS") trns = body;
      else if (name === "IDAT") idat.push(body);
      else if (name === "IEND") break;
      pos += 12 + len;
    }
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
    if (depth !== 8 || interlace !== 0 || channels === undefined || w < 1 || h < 1 || w * h > MAX_PIXELS) return null;
    if (type === 3 && palette === null) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * channels;
    if (raw.length !== (stride + 1) * h) return null;
    const cur = new Uint8Array(stride);
    let prev = new Uint8Array(stride);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const filter = raw[y * (stride + 1)]!;
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels]! : 0;
        const b = prev[i]!;
        const c = i >= channels ? prev[i - channels]! : 0;
        let v = row[i]!;
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        } else if (filter !== 0) return null;
        cur[i] = v & 255;
      }
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const s = x * channels;
        if (type === 6) { data[o] = cur[s]!; data[o + 1] = cur[s + 1]!; data[o + 2] = cur[s + 2]!; data[o + 3] = cur[s + 3]!; }
        else if (type === 2) { data[o] = cur[s]!; data[o + 1] = cur[s + 1]!; data[o + 2] = cur[s + 2]!; data[o + 3] = 255; }
        else if (type === 0) { data[o] = data[o + 1] = data[o + 2] = cur[s]!; data[o + 3] = 255; }
        else if (type === 4) { data[o] = data[o + 1] = data[o + 2] = cur[s]!; data[o + 3] = cur[s + 1]!; }
        else {
          const k = cur[s]!;
          if (k * 3 + 2 >= palette!.length) return null;
          data[o] = palette![k * 3]!; data[o + 1] = palette![k * 3 + 1]!; data[o + 2] = palette![k * 3 + 2]!;
          data[o + 3] = trns !== null && k < trns.length ? trns[k]! : 255;
        }
      }
      prev = Uint8Array.from(cur);
    }
    return { w, h, data };
  } catch {
    return null;
  }
}

/**
 * The one definition of "identical": no pixel differs by more than this in any colour channel (0-255). Boxes are drawn at the
 * same tolerance, so a picture that is not identical always has at least one box.
 */
export const IDENTICAL_TOL = 2;

export const BLANK: Pixels = { w: 0, h: 0, data: new Uint8Array(0) };

/**
 * Pixels that differ by more than `tol` in any colour channel (alpha counts as white background). Sizes may differ: the shorter
 * picture is treated as blank white past its edge. `mask[y*w+x]` is 1 where they differ.
 */
export function diffPixels(a: Pixels, b: Pixels, tol = IDENTICAL_TOL): { w: number; h: number; mask: Uint8Array; count: number } {
  const w = Math.max(a.w, b.w), h = Math.max(a.h, b.h), mask = new Uint8Array(w * h);
  const px = (p: Pixels, x: number, y: number, c: number): number => {
    if (x >= p.w || y >= p.h) return 255;
    const i = (y * p.w + x) * 4, al = p.data[i + 3]! / 255;
    return p.data[i + c]! * al + 255 * (1 - al);
  };
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(px(a, x, y, 0) - px(b, x, y, 0)) > tol || Math.abs(px(a, x, y, 1) - px(b, x, y, 1)) > tol || Math.abs(px(a, x, y, 2) - px(b, x, y, 2)) > tol) {
        mask[y * w + x] = 1;
        count++;
      }
    }
  }
  return { w, h, mask, count };
}

const CELL = 8;

/**
 * Boxes around the differing pixels, top to bottom. Pixels are binned into 8-pixel cells; touching cells join one box, then boxes
 * within `gap` pixels merge. Work is bounded by the picture size, not by how much changed, and at most MAX_REGIONS boxes are returned.
 */
export function regionsOf({ w, h, mask }: { w: number; h: number; mask: Uint8Array }, gap = 6): GenericRegion[] {
  const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL);
  const box = new Int32Array(cw * ch * 4).fill(-1); // x0, y0, x1, y1 of the differing pixels in each cell
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const k = ((y >> 3) * cw + (x >> 3)) * 4;
      if (box[k] < 0) { box[k] = x; box[k + 1] = y; box[k + 2] = x; box[k + 3] = y; continue; }
      if (x < box[k]!) box[k] = x;
      if (y < box[k + 1]!) box[k + 1] = y;
      if (x > box[k + 2]!) box[k + 2] = x;
      if (y > box[k + 3]!) box[k + 3] = y;
    }
  }
  const seen = new Uint8Array(cw * ch);
  const out: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (let c0 = 0; c0 < cw * ch; c0++) {
    if (box[c0 * 4]! < 0 || seen[c0]) continue;
    let b = { x0: box[c0 * 4]!, y0: box[c0 * 4 + 1]!, x1: box[c0 * 4 + 2]!, y1: box[c0 * 4 + 3]! };
    const stack = [c0];
    seen[c0] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cw, cy = (c - cx) / cw;
      b = { x0: Math.min(b.x0, box[c * 4]!), y0: Math.min(b.y0, box[c * 4 + 1]!), x1: Math.max(b.x1, box[c * 4 + 2]!), y1: Math.max(b.y1, box[c * 4 + 3]!) };
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const n = ny * cw + nx;
          if (box[n * 4]! >= 0 && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    out.push(b);
  }
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const p = out[i]!, q = out[j]!;
        if (p.x0 <= q.x1 + gap && q.x0 <= p.x1 + gap && p.y0 <= q.y1 + gap && q.y0 <= p.y1 + gap) {
          out[i] = { x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1) };
          out.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  let boxes = out;
  if (boxes.length > MAX_REGIONS) {
    boxes = [{ x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) }];
  }
  return boxes.map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 })).sort((p, q) => p.y - q.y || p.x - q.x);
}

export interface PictureInput {
  home: string;
  taskId: number;
  /** The file's path as the ledger holds it; its extension and name are used. */
  filePath: string;
  /** The path shown to the reader, relative to the task's folder; defaults to the file name. */
  relPath?: string;
  /** The state before the change, or null for a created file. */
  before: string | null;
  /** The state after the change, or null for a deleted file. */
  after: string | null;
  /** Hashes whose bytes are in the store, with their size. */
  stored: ReadonlyMap<string, number>;
  /** Sizes the ledger recorded, for a fingerprint when the bytes are gone. */
  sizes: { before: number | null; after: number | null };
  /** Treated as inputs: the text tier supplies "is text", the secret check supplies "is secret". */
  isText?: (filePath: string) => boolean;
  isSecret?: (filePath: string) => boolean;
  /**
   * a state a connector reads (its row has a `connector`, a known connector claims the file, or it shares bytes with such a state) is
   * never drawn here. The loader passes what it knows from the rows; absent, the file's name is checked against the known connectors' claims.
   */
  claimed?: boolean;
}

const nameOf = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath;

function fingerprint(i: PictureInput, note: string, label: string, secret = false): Generic {
  const side = (sha: string | null, size: number | null): { sha: string; size: number } | null =>
    sha === null ? null : { sha, size: i.stored.get(sha) ?? size ?? 0 };
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(nameOf(i.filePath))?.[1]?.toLowerCase();
  return {
    tier: "fingerprint",
    label,
    fingerprint: { before: side(i.before, i.sizes.before), after: side(i.after, i.sizes.after), kind: ext ?? "file", note },
    ...(secret ? { secret: true as const } : {}),
  };
}

const memo = new Map<string, Generic>();
const MEMO_MAX = 200;

/** The most bytes of one PNG state that are decoded for the pixel diff; a larger one is still shown, without boxes. */
const DIFF_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The generic entry for a changed file that is not text. A secret file is always a fingerprint and is never opened. Returns null
 * for a text file (the text tier owns it). An image file is a picture; any other file type is a fingerprint.
 */
export async function pictureTier(i: PictureInput): Promise<Generic | null> {
  if ((i.isSecret ?? isSecretPath)(i.filePath)) {
    return fingerprint(i, "The file looks like it holds a secret, so only its fingerprint is kept and its contents are never shown.", secretLine(i.relPath ?? nameOf(i.filePath)), true);
  }
  const unrendered = (why: string): Generic => fingerprint(i, why, `No preview of this change: ${why}`);
  // CoCheck draws no file a connector reads: a fingerprint on every path, ahead of "is text" (a claimed state is never read as lines).
  if (i.claimed ?? claimedFile(i.home)(i.filePath)) return unrendered(CLAIMED_NO_PICTURE);
  if (i.isText?.(i.filePath)) return null;
  if (imageTypeOf(i.filePath) === null) return unrendered("CoCheck shows only png, jpg, gif, webp and svg images as pictures.");
  for (const sha of [i.before, i.after]) {
    if (sha !== null && !i.stored.has(sha)) return unrendered("a version of the file is no longer in the store.");
  }
  const key = `${i.home}\0${i.taskId}\0${i.before ?? ""}\0${i.after ?? ""}\0${/\.[A-Za-z0-9]+$/.exec(nameOf(i.filePath))?.[0]?.toLowerCase() ?? ""}`;
  const hit = memo.get(key);
  if (hit) return hit;
  // Boxes only for two PNGs we can read; anything else is shown by the browser without them.
  const decode = async (sha: string | null): Promise<Pixels | null> => {
    if (sha === null) return BLANK;
    if ((i.stored.get(sha) ?? 0) > DIFF_MAX_BYTES) return null;
    const bytes = await readStoredImage(i.home, i.taskId, sha);
    return bytes === null ? null : decodePng(bytes);
  };
  const [b, a] = /\.png$/i.test(i.filePath) ? await Promise.all([decode(i.before), decode(i.after)]) : [null, null];
  const d = b !== null && a !== null ? diffPixels(b, a) : null;
  const regions = d === null || d.count === 0 ? [] : regionsOf(d);
  const identical = d !== null && d.count === 0;
  const out: Generic = {
    tier: "picture",
    label: identical ? `${PICTURE_LABEL}. ${NOT_VISIBLE}.` : PICTURE_LABEL,
    picture: { before: i.before, after: i.after, width: d?.w ?? 0, height: d?.h ?? 0, regions, ...(identical ? { note: NOT_VISIBLE } : {}) },
  };
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
  memo.set(key, out);
  return out;
}
