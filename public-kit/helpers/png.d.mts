// Types for png.mjs (public-kit/spec/v1.md, "Helpers").

/** A decoded picture: `rgba` holds width * height * 4 bytes, row by row from the top left. */
export interface Pixels { width: number; height: number; rgba: Buffer }
/** A rectangle in pixels. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Largest picture read (decoded RGBA bytes), so a hostile header cannot ask for gigabytes. */
export declare const MAX_PIXEL_BYTES: number;
/** The PNG in `bytes` as RGBA pixels; `undefined` for 16-bit, interlaced, oversized or damaged pictures and anything that is not a PNG. */
export declare function decodePng(bytes: Buffer): Pixels | undefined;
/** True when the rectangle holds the same pixels in both pictures. The pictures must be the same size and the rectangle inside them; otherwise `undefined` (cannot say). */
export declare function sameRegion(a: Pixels, b: Pixels, r: Rect): boolean | undefined;
/** True when rectangle `ra` of `a` and rectangle `rb` of `b` hold the same pixels; rectangles of different size are false; one empty after clipping is `undefined`. */
export declare function sameRegionAt(a: Pixels, ra: Rect, b: Pixels, rb: Rect): boolean | undefined;
