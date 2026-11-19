// Types for pdf-text.mjs (public-kit/spec/v1.md, "Helpers").
import type { Pixels, Rect } from "./png.d.mts";

/** One letter of a heading-shaped run, in the run's pixels. */
export interface PdfChar { c: string; x: number; y: number; w: number; h: number }
/** One line of text as it is printed (a table row's cells are separate runs), in pixels at two per point, origin top-left. */
export interface PdfRun {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** One entry per non-space character of a run of capital letters, digits and spaces only (a printed heading); absent on any other run. */
  chars?: PdfChar[];
}
/** A page: its number (1-based), size in pixels at two per point, and text runs. */
export interface PdfTextPage { index: number; width: number; height: number; runs: PdfRun[] }
/** One paragraph to place: its text as the document has it, whether a box is wanted, and the changed spans (UTF-16 [start, end) offsets into `text`). */
export interface PdfFindQuery { id: string; text: string; want?: boolean; spans?: Array<[number, number]> }
export interface PdfRect { x: number; y: number; w: number; h: number }
/** Where a paragraph sits: one segment per page it touches (rect: its lines' union, clipped to the page), rounded to 0.1 px. */
export interface PdfFindResult { id: string; found: boolean; pass?: "strict" | "nohyphen" | "none" | "empty"; pagebreak: boolean; segments: Array<{ page: number; rect: PdfRect; highlights: PdfRect[] }> }
export interface PdfFindOutput { pages: Array<{ index: number; width: number; height: number }>; results: PdfFindResult[] }
/** A page cut to what is printed on it: the PNG and where its top-left sits on the page, in page pixels; or a blank page. */
export type PdfCrop = { png: Buffer; x: number; y: number; w: number; h: number; pageWidth: number; pageHeight: number } | { empty: true };
export interface PdfTextOptions {
  /** Milliseconds before the pdf.js child is killed. Default 30000. */
  timeoutMs?: number;
}
export interface PdfCropOptions extends PdfTextOptions {
  /** Draws page `n` of the PDF as a PNG at two pixels per point. Default: pdf.mjs `renderPdfPage` (this OS's backend). */
  render?: (bytes: Buffer, n: number) => Promise<Buffer | null>;
}

/** The first argument that makes pdf-text.mjs run as the pdf.js child process. */
export declare const CHILD_FLAG: string;
/** The pdf.js build the reader loads (CoCheck's shipped copy, else the pdfjs-dist package), or null when neither is installed. */
export declare function pdfJsPath(): string | null;
/** Whether the reader can run here (pdf.js is installed). Any OS. */
export declare function pdfTextAvailable(): boolean;
/** Every page's size and text runs; pages null when the PDF cannot be read or pdf.js is missing ("failed"), or the time limit stopped it ("timeout"). */
export declare function readPdfText(bytes: Buffer, options?: PdfTextOptions): Promise<{ pages: PdfTextPage[] | null; error: "timeout" | "failed" | null }>;
/** Where each paragraph sits (queries: every paragraph of the document in order); null when it cannot be answered. */
export declare function findPdfParagraphs(bytes: Buffer, queries: PdfFindQuery[], options?: PdfTextOptions): Promise<PdfFindOutput | null>;
/** Pixels two page sizes may differ by and still be the same page. */
export declare const SIZE_TOLERANCE: number;
/** Whether a reader's pages are the drawer's pages: same count, sizes within SIZE_TOLERANCE. */
export declare function samePages(pages: Array<{ index: number; width: number; height: number }>, drawn: Array<{ index: number; width: number; height: number }>): boolean;
/** `readPdfText` checked against the pages this OS draws: the drawer's pages, with pdf.js's runs only when the two agree. */
export declare function readDrawnPdfText(bytes: Buffer, options?: PdfTextOptions & { backend?: import("./pdf.d.mts").PdfBackend | null }): Promise<{ pages: PdfTextPage[] | null; error: "timeout" | "failed" | null; textRuns: boolean }>;
/** An 8-bit RGBA PNG of the pixels (fixed filter and level). */
export declare function encodePng(width: number, height: number, rgba: Buffer): Buffer;
/** The box around every printed pixel (red, green or blue under 245), grown by `padPx` and clamped; null when nothing is printed. */
export declare function inkBox(px: Pixels, padPx: number): Rect | null;
/** Page `n` cut to what is printed on it, grown by `padPt` points; null when the page cannot be drawn here. */
export declare function cropPdfPage(bytes: Buffer, n: number, padPt: number, options?: PdfCropOptions): Promise<PdfCrop | null>;
