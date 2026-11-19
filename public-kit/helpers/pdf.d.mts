// Types for pdf.mjs (public-kit/spec/v1.md, "Helpers").
import type { spawn } from "node:child_process";

/** A page's number (1-based) and size in pixels at two per point. */
export interface PdfPageSize { index: number; width: number; height: number }
/** An OS backend: reads a PDF (a temp copy) and draws one page to a PNG file. */
export interface PdfBackend {
  /** Whether the OS can read PDFs at all. */
  available(): boolean;
  /** Whether `pages` gives text runs (the Windows backend does not). */
  textRuns: boolean;
  /** Whether CoCheck takes text from its pdf.js reader on this OS instead. */
  pdfjs: boolean;
  /** Names the OS reader in a sentence ("Windows PDF"). */
  engine: string;
  /** Page count and sizes of `file`. */
  pages(file: string, timeoutMs: number): Promise<{ pages: PdfPageSize[] } | "timeout" | "failed">;
  /** Page `n` (1-based) of `file` as a PNG written to `out`. */
  png(file: string, n: number, out: string, timeoutMs: number): Promise<"ok" | "timeout" | "failed">;
  /** Several pages of `file` in one reader call (the Windows backend): one status per item, "ok" only for a page the reader reported finished. */
  pngs?(file: string, items: { n: number; out: string }[], timeoutMs: number): Promise<("ok" | "failed")[]>;
}
/** One requested page of `renderPdfPages`. */
export interface PdfPageDrawn { page: number; out: string; status: "ok" | "failed" }
/** The process functions the Windows backend runs on. */
export interface WindowsPdfDeps {
  env: Record<string, string | undefined>;
  spawn: typeof spawn;
  /** Runs a program to its end (used only to stop a timed-out reader). */
  run(command: string, args: string[], options?: { timeout?: number }): unknown;
  exists(file: string): boolean;
}
export interface RenderOptions {
  /** The OS backend to draw with; null for none (then pdfpages draws). Default: the Windows backend on Windows, none elsewhere. */
  windows?: PdfBackend | null;
  /** The pdfpages program used when there is no OS backend. Default `pdfpagesPath()`. */
  pdfpages?: string;
  /** Milliseconds before the run is killed. Default 30000. */
  timeoutMs?: number;
}

/** Where the macOS backend looks for pdfpages: COCHECK_PDF_HELPER when set, otherwise the copy CoCheck installs. */
export declare function pdfpagesPath(): string;
/** The PowerShell script the Windows backend runs. */
export declare const WINDOWS_PDF_SCRIPT: string;
/** The Windows backend over the given process functions. */
export declare function createWindowsPdf(deps: WindowsPdfDeps): PdfBackend;
/** The Windows backend over Node's own process functions. */
export declare function windowsPdf(): PdfBackend;
/** The macOS backend over the pdfpages program (default `pdfpagesPath()`). */
export declare function macPdf(program?: string): PdfBackend;
/** This OS's drawing backend: Windows' reader on Windows, pdfpages on macOS, null elsewhere. */
export declare function osPdf(): PdfBackend | null;
/** Draws `pages` of the PDF at `file` into `outDir` as page-<n>.png in one reader call; finished pages stay "ok" on a timeout, the rest are "failed". */
export declare function renderPdfPages(file: string, pages: number[], outDir: string, timeoutMs?: number, windows?: PdfBackend | null): Promise<PdfPageDrawn[]>;
/** The pages of the PDF in `bytes` as PNG buffers by one batch call; null for a page not finished. */
export declare function renderPdfBytesPages(bytes: Buffer, pages: number[], options?: RenderOptions): Promise<Map<number, Buffer | null>>;
/** Each page's drawn size by this OS's backend (or `options.backend`); null when there is none. */
export declare function pdfPageSizes(bytes: Buffer, options?: { backend?: PdfBackend | null; timeoutMs?: number }): Promise<{ pages: PdfPageSize[] } | "timeout" | "failed" | null>;
/** Page `n` (1-based) of the PDF in `bytes` as a PNG, or null when it cannot be drawn here. */
export declare function renderPdfPage(bytes: Buffer, n: number, options?: RenderOptions): Promise<Buffer | null>;
