import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PdfPageSize, Platform } from "../../platform/index.ts";
import { hostPlatform } from "../../platform/index.ts";
// The page rasterizer and the PDF reader are the published kit helpers: core draws and reads pages with the same code outside connectors load.
import { macPdf, pdfPageSizes, renderPdfPage as kitRenderPdfPage } from "../../../public-kit/helpers/pdf.mjs";
import { pdfTextAvailable, readPdfText as kitReadPdfText, samePages } from "../../../public-kit/helpers/pdf-text.mjs";

/**
 * PDFs in core, one service on every OS: the pdf.js reader (public-kit/helpers/pdf-text.mjs) gives each page's size and text runs, and the OS only
 * draws pages to pixels (public-kit/helpers/pdf.mjs: the `pdfpages` program on macOS, built from `native/pdfpages.swift` into
 * `dist/helpers/pdfpages`; Windows.Data.Pdf through powershell.exe on Windows). Every run works on a temp copy of the stored bytes, never on a file
 * in a user's folder, with a time limit.
 */

export interface PdfRun {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** One entry per non-space character of a heading-shaped run (capital letters, digits and spaces only), in the run's pixels; absent on any other run. */
  chars?: { c: string; x: number; y: number; w: number; h: number }[];
}
export interface PdfPage {
  index: number;
  width: number;
  height: number;
  runs: PdfRun[];
}

const TIMEOUT_MS = 30_000;
const HELPER_ENV = { PATH: "/usr/bin:/bin" };

/** `<repo>/dist/helpers/pdfpages`; the same relative path from src/timeline/render and from dist/timeline/render. */
export const PDF_HELPER = fileURLToPath(new URL("../../../dist/helpers/pdfpages", import.meta.url));

/** Where the macOS page drawer is looked for; the COCHECK_PDF_HELPER environment variable moves it (tests, odd installs). */
export const pdfHelperPath = (): string => process.env.COCHECK_PDF_HELPER ?? PDF_HELPER;

const probed = new Map<string, boolean>();
/** Whether the drawer starts at all. One spawn per path per process; any exit status counts (no arguments is a usage exit), an exec error or a kill does not. */
function helperRuns(file: string): boolean {
  let ok = probed.get(file);
  if (ok === undefined) {
    const res = spawnSync(file, [], { timeout: 10_000, killSignal: "SIGKILL", stdio: "ignore", env: HELPER_ENV });
    ok = res.error === undefined && res.signal === null && res.status !== null;
    probed.set(file, ok);
  }
  return ok;
}

/** Whether the macOS page drawer is here and runs, so one that exists but cannot execute (wrong architecture, older macOS) reads as missing. */
export const pdfHelperAvailable = (): boolean => process.platform === "darwin" && existsSync(pdfHelperPath()) && helperRuns(pdfHelperPath());

/** The OS's own PDF drawer where the platform has one (Windows); absent on macOS, where `pdfpages` draws. */
const docPdf = (plat: Platform | undefined) => plat?.docRender?.pdf;
/** This OS's drawer, the page sizes the text is checked against: Windows' reader, pdfpages on macOS, none elsewhere (no page is drawn there). */
const drawer = (plat: Platform | undefined) => docPdf(plat) ?? (plat?.name === "darwin" ? macPdf(pdfHelperPath()) : null);
/** Whether pages can be read and drawn here: pdf.js is installed and this OS has a drawer. */
export const pdfPagesAvailable = (plat: Platform | undefined = hostPlatform()): boolean => {
  const p = docPdf(plat);
  return pdfTextAvailable() && (p !== undefined ? p.available() : pdfHelperAvailable());
};
/** Whether pages carry text runs here (pdf.js is installed): false means no box can be placed, and the view says so. */
export const pdfTextRuns = (_plat: Platform | undefined = hostPlatform()): boolean => pdfTextAvailable();
/** The name of what draws the pages, for a sentence ("macOS PDFKit could not draw this page"). */
export const pdfDrawerName = (plat: Platform | undefined = hostPlatform()): string => docPdf(plat)?.engine ?? "macOS PDFKit";

/** Milliseconds until a read is stopped; COCHECK_PDFJS_TIMEOUT_MS shortens it (tests). */
const readTimeoutMs = (): number => Number(process.env.COCHECK_PDFJS_TIMEOUT_MS) || TIMEOUT_MS;
/** What reads the text (tests pass a fake): the kit's pdf.js reader. */
export type TextReader = (bytes: Buffer, options: { timeoutMs: number }) => Promise<{ pages: PdfPage[] | null; error: "timeout" | "failed" | null }>;

/** Every page's size (pixels at two per point) and text runs; null when the PDF cannot be read, the reader is missing, or it timed out. */
export async function readPdfPages(bytes: Buffer, plat: Platform | undefined = hostPlatform()): Promise<PdfPage[] | null> {
  return (await readPdfOutcome(bytes, plat)).pages;
}

/** `readPdfPages`, and when it gave nothing, whether the reader was stopped by its time limit (not a verdict on the file) or failed on the bytes. */
export async function readPdfOutcome(bytes: Buffer, plat: Platform | undefined = hostPlatform()): Promise<{ pages: PdfPage[] | null; error: "timeout" | "failed" | null }> {
  const { pages, error } = await readPdfText(bytes, plat);
  return { pages, error };
}

/**
 * `readPdfOutcome`, and whether the pages carry text runs. The text is pdf.js's on every OS; the pages are the ones this OS draws (its drawer's
 * sizes), and pdf.js's runs are kept only when its pages are the drawer's (count, sizes within the kit's SIZE_TOLERANCE), because the boxes sit on
 * the drawer's pictures: otherwise the pages have no runs and the view is pictures only. Where no page is drawn (no drawer), pdf.js's pages as read.
 */
export async function readPdfText(bytes: Buffer, plat: Platform | undefined = hostPlatform(), read: TextReader = kitReadPdfText): Promise<{ pages: PdfPage[] | null; error: "timeout" | "failed" | null; textRuns: boolean }> {
  const backend = drawer(plat);
  const [js, drawn] = await Promise.all([read(bytes, { timeoutMs: readTimeoutMs() }), backend === null ? Promise.resolve(null) : pdfPageSizes(bytes, { backend, timeoutMs: TIMEOUT_MS })]);
  // a side that cannot be read says so in its own sentence; it does not by itself switch the other side's boxes off (macOS)
  const failedRuns = docPdf(plat) === undefined && pdfTextAvailable();
  if (drawn === null) return js.pages === null ? { pages: null, error: js.error ?? "failed", textRuns: failedRuns } : { pages: js.pages, error: null, textRuns: true };
  if (drawn === "timeout" || drawn === "failed") return { pages: null, error: drawn, textRuns: failedRuns };
  const text = js.pages !== null && samePages(js.pages, drawn.pages);
  return { pages: drawn.pages.map((p, i) => ({ index: p.index, width: p.width, height: p.height, runs: text ? js.pages![i]!.runs : [] })), error: null, textRuns: text || (docPdf(plat)?.textRuns ?? false) };
}

/** Page `n` (1-based) as a PNG; null when it cannot be drawn. The kit's rasterizer, with this OS's drawer (Windows) or the pdfpages path core uses. */
export async function renderPdfPage(bytes: Buffer, n: number, plat: Platform | undefined = hostPlatform()): Promise<Buffer | null> {
  return kitRenderPdfPage(bytes, n, { windows: docPdf(plat) ?? null, pdfpages: pdfHelperPath(), timeoutMs: TIMEOUT_MS });
}
