// Snapshots of the pdf.js reader's outputs (public-kit/helpers/pdf-text.mjs) for test/pdf-reader-golden.slow.test.ts: page sizes, text runs and
// chars, Word's paragraph finder on the queries the Word connector sends, and (where pages can be drawn) each page's crop box and pixels.
import { decodePng, sameRegionAt } from "../../public-kit/helpers/png.mjs";
import { renderPdfPage } from "../../public-kit/helpers/pdf.mjs";
import { cropPdfPage, findPdfParagraphs, readPdfText, type PdfFindQuery } from "../../public-kit/helpers/pdf-text.mjs";

/** Queries for one Word document's PDF, built the way the Word connector builds them (every visible paragraph in order), all wanted, each with a span over its middle third. */
export function queriesFor(paras: Array<{ text: string }>, fold: (s: string) => string): Array<PdfFindQuery & { want: boolean }> {
  const out: Array<PdfFindQuery & { want: boolean }> = [];
  paras.forEach((p, k) => {
    if (fold(p.text) === "") return;
    const n = p.text.length, a = Math.floor(n / 3), b = Math.max(a + 1, Math.floor((2 * n) / 3));
    out.push({ id: String(k), text: p.text, want: true, ...(n >= 3 ? { spans: [[a, b] as [number, number]] } : {}) });
  });
  return out;
}

/** Numbers rounded to 0.01 px, so a snapshot names the reader's answer, not float noise. */
const round = (v: unknown): unknown => {
  if (typeof v === "number") return Math.round(v * 100) / 100;
  if (Array.isArray(v)) return v.map(round);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  return v;
};

export interface Golden { pages: unknown; find?: unknown; crops?: unknown }

/** The reader's answers for one PDF; `queries` adds the finder, `crop` the crop of every page (pages drawn by this OS's backend). */
export async function snapshot(pdf: Buffer, o: { queries?: PdfFindQuery[]; crop?: boolean } = {}): Promise<Golden> {
  const { pages } = await readPdfText(pdf, { timeoutMs: 120_000 });
  const out: Golden = { pages: round(pages) };
  if (o.queries !== undefined) out.find = round(await findPdfParagraphs(pdf, o.queries, { timeoutMs: 120_000 }));
  if (o.crop === true && pages !== null) {
    // the box is pinned; the pixels are checked against the page drawn in this same run (the OS's drawing can differ a little from machine to
    // machine, which is the drawer's business, not the reader's)
    const crops = [];
    for (let n = 1; n <= pages.length; n++) {
      const c = await cropPdfPage(pdf, n, 12);
      if (c === null || "empty" in c) { crops.push(c); continue; }
      const cut = decodePng(c.png)!, page = decodePng((await renderPdfPage(pdf, n))!)!;
      crops.push({ x: c.x, y: c.y, w: c.w, h: c.h, pageWidth: c.pageWidth, pageHeight: c.pageHeight, pixelsAreThePagesOwn: page.width === c.pageWidth && sameRegionAt(page, { x: c.x, y: c.y, w: c.w, h: c.h }, cut, { x: 0, y: 0, w: c.w, h: c.h }) === true });
    }
    out.crops = crops;
  }
  return out;
}
