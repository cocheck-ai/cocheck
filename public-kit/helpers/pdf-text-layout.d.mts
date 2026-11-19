// Types for pdf-text-layout.mjs (public-kit/spec/v1.md, "Helpers").
import type { PdfFindOutput, PdfFindQuery, PdfRect, PdfRun } from "./pdf-text.d.mts";

/** One pdf.js text item (`getTextContent().items[i]`). */
export interface PdfJsItem { str: string; transform: number[]; width: number; height: number; hasEOL: boolean; fontName: string }
export interface PdfJsStyle { fontFamily?: string; ascent: number; descent: number; vertical?: boolean }
/** A page as pdf.js gives it at scale SCALE: the viewport (`transform` maps PDF space to pixels) and the text content. */
export interface PageInput {
  viewport: { width: number; height: number; transform: number[] };
  items: PdfJsItem[];
  styles: Record<string, PdfJsStyle>;
  /** Each font's advance widths (per 1000 em) by character, keyed by the items' `fontName`; optional (standard proportions without it). */
  widths?: Record<string, Record<string, number>>;
  /** Each item's character spans from `glyphSpans`; optional (the font's advances without it). */
  offsets?: Array<Array<[number, number]> | null>;
}
/** A page laid out the PDFKit way: `string` is what PDFKit's `page.string` reads; the rest is where each of its characters sits. */
export interface TextPage { width: number; height: number; string: string; pos: unknown[]; items: unknown[]; runs: Array<{ band: number; text: string }>; bands: unknown[]; viewport: PageInput["viewport"] }

export declare const SCALE: number;
export declare const GAP_EM: number;
export declare const BACK_EM: number;
export declare const BULLET_EM: number;
/** Each item's character spans along its baseline from the glyphs in a page's operator list (null per unmatched item; null when not modelled). */
export declare function glyphSpans(ops: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }, OPS: Record<string, number>, items: PdfJsItem[]): Array<Array<[number, number]> | null> | null;
/** Lines, runs and the page string of one page. */
export declare function layoutPage(input: PageInput): TextPage;
/** The page's runs as the helper prints them (heading-shaped runs with `chars`). */
export declare function pageRuns(page: TextPage): PdfRun[];
/** The line rectangles of characters [loc, loc + len) of the page string, clipped to the page. */
export declare function lineRects(page: TextPage, loc: number, len: number): PdfRect[];
/** The finder's text normalisation, each unit with the UTF-16 index it came from. */
export declare function normUnits(s: string, dropHyphens: boolean): { u: number[]; o: number[] };
/** The helper's `--find` over laid-out pages. */
export declare function findInPages(pages: TextPage[], queries: PdfFindQuery[]): PdfFindOutput;
