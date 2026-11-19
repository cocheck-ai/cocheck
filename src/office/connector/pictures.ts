// Office's PDF pages as level-2 `image` pictures. The app's own PDF is the picture: CoCheck never renders an Office page itself. The shipped pdfpages helper rasterizes it (Word's paragraph finding is pdf.js in public-kit/helpers/pdf-text.mjs, used by word-boxes.ts). No boxes here: this file draws pages only.
//
// Changed or unchanged, kept simple: page n of one side is `unchanged` only when the other side has a page n whose text runs (from
// `pdfpages <pdf>`) are the same and whose PNG bytes are identical; anything else, including a page the other side does not have or whose
// picture was left out, is `changed`. A false "unchanged" must never happen, so every doubt reads "changed".
import { createHash } from "node:crypto";
import { hostPlatform } from "../../platform/index.ts";
import type { OfficeApp } from "./apps.ts";
import { renderPdfBytesPages, renderPdfPage } from "../../../public-kit/helpers/pdf.mjs";
import { findPdfParagraphs, readDrawnPdfText, type PdfFindOutput, type PdfFindQuery } from "../../../public-kit/helpers/pdf-text.mjs";

export interface PdfPager {
  /** Each page's text, in order, or null when the PDF could not be read. */
  pages(pdf: Buffer): Promise<string[] | null>;
  /** Page n (1-based) as a PNG at two pixels per point, or null. */
  png(pdf: Buffer, n: number): Promise<Buffer | null>;
  /**
   * Several pages (1-based) in one call, where the OS backend can (Windows): a map of page to PNG, null for a page not drawn. Absent: `png` draws
   * page by page (the Mac).
   */
  pngs?(pdf: Buffer, pages: number[], timeoutMs?: number): Promise<Map<number, Buffer | null>>;
  /** Where paragraphs sit on the pages (the kit's `findPdfParagraphs`); absent or null: no box can be placed (Word's boxes, word-boxes.ts). */
  find?(pdf: Buffer, queries: PdfFindQuery[]): Promise<PdfFindOutput | null>;
}

/** The published helpers: page text and the finder from the pdf.js reader (pdf-text.mjs), pages drawn by this OS's backend (pdf.mjs). */
export const helperPager: PdfPager = {
  async pages(pdf) {
    const r = await readDrawnPdfText(pdf);
    return r.pages === null ? null : r.pages.map((p) => p.runs.map((x) => x.text).join("\n"));
  },
  png: (pdf, n) => renderPdfPage(pdf, n),
  // Windows only: one powershell.exe call per side instead of one per page. The Mac has no `pngs` and keeps its one pdfpages call per page.
  ...(hostPlatform()?.name === "win32" ? { pngs: (pdf: Buffer, pages: number[], timeoutMs?: number) => renderPdfBytesPages(pdf, pages, timeoutMs === undefined ? {} : { timeoutMs }) } : {}),
  find: (pdf, queries) => findPdfParagraphs(pdf, queries),
};

/** Spec v1.1 picture `renderedBy`: what drew it (three non-empty strings). */
export interface RenderedBy { tool: string; version: string; os: string }

/**
 * Who drew an Office connector's pictures: the app's name, the version the driver reads (`appVersion`, which never starts or wakes the app) or
 * "unknown", and the OS name. Never an empty string.
 */
export async function renderedByFor(app: OfficeApp, driver: { appVersion?(app: OfficeApp): Promise<string | undefined> } | undefined): Promise<RenderedBy> {
  let version: string | undefined;
  try { version = (await driver?.appVersion?.(app))?.trim(); } catch { version = undefined; }
  return { tool: app.name, version: version ? version : "unknown", os: hostPlatform()?.name || "unknown" };
}

/** Puts `renderedBy` on every picture of `doc` that has none (placeholders too: no picture is sent without it). */
export async function stampRenderedBy(doc: { pictures?: unknown }, app: OfficeApp, driver: Parameters<typeof renderedByFor>[1]): Promise<void> {
  const list = doc.pictures as { renderedBy?: RenderedBy }[] | undefined;
  if (list === undefined || list.length === 0) return;
  const rb = await renderedByFor(app, driver);
  for (const p of list) if (p.renderedBy === undefined) p.renderedBy = { ...rb };
}

export interface Picture {
  id: string;
  side: "before" | "after";
  type: "image";
  src: string;
  label: string;
  width?: number;
  height?: number;
  page: number;
  pageCount: number;
  renderedBy?: RenderedBy;
  changed?: true;
  unchanged?: true;
}

/** Spec: an image is limited to 4 MiB. */
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
/** Pages drawn per side at most; the rest are named in a caveat (keeps the job inside diffMs, with the time limit `drawBy`). */
export const MAX_PAGES_PER_SIDE = 30;
const PNG_PREFIX = "data:image/png;base64,";

/** Width and height from a PNG's IHDR, or undefined. */
export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const ranges = (ns: number[]): string => {
  const out: string[] = [];
  for (let i = 0; i < ns.length; ) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j]! + 1) j++;
    out.push(i === j ? `${ns[i]}` : `${ns[i]}-${ns[j]}`);
    i = j + 1;
  }
  return out.join(", ");
};

/**
 * Pictures for the sides that have a PDF, within `budget` bytes of data URLs (the answer line must stay under 16 MB). Pages are taken in the
 * order before 1, after 1, before 2, after 2, ..., so a cut leaves both sides' first pages. `appName` names who drew them in caveats. No page
 * is started at or after `drawBy` (epoch ms): the rest are left out with the same caveat.
 */
export async function pdfPictures(pdfs: { before?: Buffer; after?: Buffer }, pager: PdfPager, budget: number, appName: string, time: { drawBy?: number; now?: () => number } = {}): Promise<{ pictures: Picture[]; caveats: string[] }> {
  const now = time.now ?? Date.now;
  const late = (): boolean => time.drawBy !== undefined && now() >= time.drawBy;
  const caveats: string[] = [];
  const sides = (["before", "after"] as const).filter((s) => pdfs[s] !== undefined);
  const texts: Partial<Record<"before" | "after", string[]>> = {};
  for (const s of sides) {
    const t = await pager.pages(pdfs[s]!);
    if (t === null) caveats.push(`${cap(s)}: ${appName}'s PDF could not be read, so no page is shown.`);
    else if (t.length === 0) caveats.push(`${cap(s)}: ${appName}'s PDF has no pages.`);
    else texts[s] = t;
  }
  const pngs: Record<"before" | "after", Map<number, Buffer>> = { before: new Map(), after: new Map() };
  const left: Record<"before" | "after", number[]> = { before: [], after: [] };
  // A batch pager draws each side's wanted pages in one call, before the budget is applied (a page over the budget is drawn and dropped).
  const batch: Record<"before" | "after", Map<number, Buffer | null>> = { before: new Map(), after: new Map() };
  if (pager.pngs !== undefined) {
    for (const s of sides) {
      const t = texts[s];
      if (t === undefined || late()) continue;
      const wanted = Array.from({ length: Math.min(t.length, MAX_PAGES_PER_SIDE) }, (_, i) => i + 1);
      const limit = time.drawBy === undefined ? undefined : Math.max(1, time.drawBy - now());
      try { batch[s] = await pager.pngs(pdfs[s]!, wanted, limit); } catch { batch[s] = new Map(); }
    }
  }
  let used = 0;
  const most = Math.max(texts.before?.length ?? 0, texts.after?.length ?? 0);
  for (let n = 1; n <= most; n++) {
    for (const s of sides) {
      const t = texts[s];
      if (t === undefined || n > t.length) continue;
      if (n > MAX_PAGES_PER_SIDE || late()) { left[s].push(n); continue; }
      const png = pager.pngs !== undefined ? (batch[s].get(n) ?? null) : await pager.png(pdfs[s]!, n);
      const cost = png === null ? 0 : PNG_PREFIX.length + Math.ceil(png.length / 3) * 4;
      if (png === null || png.length > MAX_PICTURE_BYTES || used + cost > budget) { left[s].push(n); continue; }
      used += cost;
      pngs[s].set(n, png);
    }
  }
  for (const s of sides) if (left[s].length > 0) caveats.push(`${cap(s)}: page${left[s].length === 1 ? "" : "s"} ${ranges(left[s])} of ${texts[s]!.length} not shown (over the page or size limit of one answer, or not drawn).`);
  const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  const pictures: Picture[] = [];
  for (const s of sides) {
    const t = texts[s];
    if (t === undefined) continue;
    const other = s === "before" ? "after" : "before";
    for (const [n, png] of [...pngs[s]].sort((a, b) => a[0] - b[0])) {
      const o = pngs[other].get(n);
      const same = o !== undefined && texts[other]?.[n - 1] === t[n - 1] && sha(o) === sha(png);
      const size = pngSize(png);
      pictures.push({
        id: `${s}:page${n}`,
        side: s,
        type: "image",
        src: PNG_PREFIX + png.toString("base64"),
        label: `${cap(s)}, page ${n} of ${t.length}`,
        ...(size ?? {}),
        page: n,
        pageCount: t.length,
        ...(same ? { unchanged: true as const } : { changed: true as const }),
      });
    }
  }
  return { pictures, caveats };
}
