import { createHash } from "node:crypto";
import path from "node:path";
import { couldNotOpen, readableSideOnly, readPdf, versionWord } from "../broken.ts";
import { alignSequences } from "../../formats/files/align.ts";
import { hostPlatform } from "../../platform/index.ts";
import { IDENTICAL_TOL, decodePng } from "../picture.ts";
import type { Platform } from "../../platform/index.ts";
import { pdfTextRuns, readPdfPages, readPdfText, renderPdfPage, type PdfPage, type PdfRun, type TextReader } from "./pdf-helper.ts";
import { accountPages, beVerb, comparePages, matchByPicture, pageRanges, pairPages, type PageAccount, type PagePair, type PageStatus, type PageText, type RenderPage } from "./pixel-pages.ts";
import type { Box, ChangeInfo, FormatRenderer, Pane, View } from "./types.ts";

/**
 * The PDF renderer. PDFKit (through the helper in native/pdfpages.swift) gives each page's size and each line of text with its
 * rectangle. Pairing is by text, not by page: every line of the document is one sequence, the two sequences are aligned (`alignSequences`,
 * the same longest-common-subsequence pass the file layer uses), and only lines with no identical partner are changed. An inserted
 * paragraph therefore boxes only its own lines, however far it pushes the rest onto later pages. Boxes are `text-match`: they come from
 * the text change. The page picture is only what the boxes sit on.
 *
 * Pages whose text matches are then compared by pixels (`pixel-pages.ts`), so a changed chart or picture under the same text still
 * shows its page, with `pixel` boxes over the differing regions. A page that holds a text-match box is never compared and never given a
 * pixel box.
 */

/**
 * Every page of both sides gets exactly one status from `accountPages` (T, P=, P≠, R, U, S; defined in docs/timeline.md). Panes are
 * built from that status map, never from "pages that hold a box", so no page can vanish. A card is only for a document whose every page is P=
 * (or whose bytes are identical); "match" is said only then.
 */

/** Pages of kind U or R shown whole (R with no box); any more are named in a caveat. T and P≠ have no cap. */
const MAX_UNPAIRED_SHOWN = 20;
/** The review view lists every page of each side, in order; a document longer than this keeps the pages that matter (shown or boxed) first and the caveats name what was cut. */
export const MAX_PAGES_PER_SIDE = 300;
const SAME_RULE = `no pixel differs by more than ${IDENTICAL_TOL} of 255 in any colour`;

export const PDF_ENGINE = "drawn by macOS PDFKit";

interface Line {
  page: number;
  run: PdfRun;
}

const flatten = (pages: PdfPage[]): Line[] => pages.flatMap((p) => p.runs.map((run) => ({ page: p.index, run })));
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
/** Whitespace-insensitive, so a re-wrapped space does not read as an edit. U+FFFC (the object replacement character) is no text: macOS 27.2's
 * PDFKit reads a shape or picture as one, and it is never a word of the document. */
const norm = (s: string): string => s.replace(/\ufffc/g, " ").replace(/\s+/g, " ").trim();
/** A page with its object-only runs dropped (a run whose text is nothing but U+FFFC and spaces): the object then counts as drawing, not text, so a
 * slide that only gained a shape keeps identical text and is compared by pixels. A run holding real words keeps them and stays text. */
export const textRunsOnly = (pages: PdfPage[]): PdfPage[] => pages.map((p) => (p.runs.some((r) => norm(r.text) === "") ? { ...p, runs: p.runs.filter((r) => norm(r.text) !== "") } : p));

/** What differs when the PDFs were made from another format: who drew it, whose hash names the pictures, extra caveats. */
export interface PdfViewOptions {
  engine?: string;
  /** The hash the browser asks the page route for, per side; default the hash of the PDF bytes themselves. */
  pictureSha?: { before: string | null; after: string | null };
  caveats?: string[];
  /** Draws page `n` of a side as a PNG for the pixel comparison; default the PDFKit helper on the side's PDF bytes (tests feed their own). */
  renderPage?: RenderPage;
  /** Whether the PDF reader gave text runs; default what this system's reader does. False adds the "boxes are not drawn on this system" sentence. */
  textRuns?: boolean;
  /** The platform whose PDF drawer is used; default the running one (tests pass a faked one). */
  platform?: Platform;
  /** What reads each side's text; default the kit's pdf.js reader (tests pass one that fails, hangs or lies). */
  readText?: TextReader;
}

/** Shown on a system whose PDF reader gives no text positions (Windows): the pictures and the change cards stand, no box is placed. */
export const NO_BOXES = "Boxes are not drawn on this system: it cannot tell where on a page the text sits, so these pages are shown as pictures with the change cards and no box is guessed.";

export const pdfRenderer: FormatRenderer = {
  name: "pdfkit",
  extensions: [".pdf"],
  wholeView: true,
  view: (before, after, info) => viewPdfs(before, after, info),
};

const SIDE = { before: "Before", after: "After" } as const;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export async function viewPdfs(before: Buffer | null, after: Buffer | null, info: ChangeInfo, opts: PdfViewOptions = {}): Promise<View> {
  const engine = opts.engine ?? PDF_ENGINE;
  if (info.whole !== undefined) return wholeView(info.whole === "before" ? before : after, info, opts);
  if (info.kind === "modified" && (before === null || after === null)) return cardView(info, engine, "Only one side of this PDF could be read, so nothing is compared and nothing is boxed.");
  const plat = opts.platform ?? hostPlatform();
  const none = { pages: [] as PdfPage[], error: null, textRuns: true };
  const [br, ar] = await Promise.all([before === null ? none : readPdfText(before, plat, opts.readText), after === null ? none : readPdfText(after, plat, opts.readText)]);
  const bp = br.pages, ap = ar.pages;
  // A side read without text runs (the pdf.js reader failed, timed out or disagreed on the pages) makes the whole view pictures only: never a box from one side's text.
  if (opts.textRuns === undefined && (!br.textRuns || !ar.textRuns)) opts = { ...opts, textRuns: false };
  if (bp === null || ap === null) {
    // A side the reader failed on is named in the reader's words when this is the PDF itself; a timeout says only that CoCheck stopped.
    const own = path.extname(info.file).toLowerCase() === ".pdf";
    const reasons: Record<"before" | "after", string | null> = { before: null, after: null };
    for (const side of ["before", "after"] as const) {
      if ((side === "before" ? bp : ap) !== null) continue;
      const r = own ? await readPdf((side === "before" ? before : after)!) : null;
      reasons[side] = r !== null && "failed" in r ? r.failed : null;
    }
    const said = (["before", "after"] as const).filter((s) => reasons[s] !== null);
    const mute = (["before", "after"] as const).filter((s) => (s === "before" ? bp : ap) === null && reasons[s] === null);
    const sentences = [...said.map((s) => couldNotOpen(info.file, s, reasons[s]!)), ...mute.map((s) => `The PDF reader gave no pages for the ${versionWord(s)} version, so CoCheck drew nothing for it.`)];
    if (bp === null && ap === null) return cardView(info, engine, ...sentences, "Nothing is compared and nothing is boxed.");
    const bad = bp === null ? "before" : "after";
    const solo = readableSideOnly(info, bad, sentences[0]!);
    return viewFromPages(bp ?? [], ap ?? [], bad === "before" ? null : before, bad === "after" ? null : after, solo, opts);
  }
  return viewFromPages(bp, ap, before, after, info, opts);
}

/** Every page of one state, no pairing, no elision. A state that cannot be read is a card with the reason. */
async function wholeView(bytes: Buffer | null, info: ChangeInfo, opts: PdfViewOptions): Promise<View> {
  const engine = opts.engine ?? PDF_ENGINE;
  const side = info.whole!;
  if (bytes === null) return cardView(info, engine, `The ${versionWord(side)} version of this file is not available, so CoCheck drew nothing for it.`);
  const pages = await readPdfPages(bytes, opts.platform ?? hostPlatform());
  if (pages === null || pages.length === 0) {
    const own = path.extname(info.file).toLowerCase() === ".pdf";
    const r = own ? await readPdf(bytes) : null;
    return cardView(info, engine, r !== null && "failed" in r ? couldNotOpen(info.file, side, r.failed) : `The PDF reader gave no pages for the ${versionWord(side)} version, so CoCheck drew nothing for it.`);
  }
  const sha = opts.pictureSha?.[side] ?? sha256(bytes);
  const panes: Pane[] = pages.map((p) => ({ id: `${side}:page${p.index}`, label: `${SIDE[side]}, page ${p.index} of ${pages.length}`, picture: { sha, width: p.width, height: p.height, page: p.index } }));
  return { change: info.id, file: info.file, engine, kind: "pages", before: side === "before" ? panes : [], after: side === "after" ? panes : [], boxes: [], caveats: [...(info.missing ?? []), `Every page of the file ${side === "before" ? "as the task found it" : "as it is now"} (${pages.length}).`, ...(opts.caveats ?? [])] };
}

function cardView(info: ChangeInfo, engine: string, ...more: string[]): View {
  return { change: info.id, file: info.file, engine, kind: "card", before: [], after: [], boxes: [], caveats: [...(info.missing ?? []), ...more] };
}

/** The part of the account the view needs besides the statuses. */
interface Accounted {
  account: PageAccount;
  boxed: Array<{ side: "before" | "after"; line: Line }>;
  pixel: Awaited<ReturnType<typeof comparePages>>;
  unpaired: Awaited<ReturnType<typeof matchByPicture>>["unpaired"];
  /** The 1:1 page partners that keep page order on both sides (what the review view lines up side by side). */
  pairs: PagePair[];
}

/** Pairs the pages of two documents and gives every page one status. Pure but for `render`; takes already-read pages so a test needs no PDFKit. */
export async function accountDocument(fullB: PdfPage[], fullA: PdfPage[], render: RenderPage): Promise<Accounted> {
  // every run takes part in the alignment, object runs (only U+FFFC, a shape or picture on macOS 27.2) included, so an object that
  // appeared or went is found. Pages are paired and counted as text pages by their real text only (`bp`, `ap`).
  const bp = textRunsOnly(fullB), ap = textRunsOnly(fullA);
  const bl = flatten(fullB);
  const al = flatten(fullA);
  // An object run aligns by its size as well as its text, so a picture swapped for one of another size reads as changed;
  // an unchanged picture keeps its size wherever reflow puts it, so it still aligns as equal. Same-size swaps are not seen here (open).
  const key = (r: PdfRun): string => (norm(r.text) === "" ? `\ufffc${Math.round(r.w)}x${Math.round(r.h)}` : norm(r.text));
  const changed = alignSequences(bl.map((l) => key(l.run)), al.map((l) => key(l.run)));
  const all: Accounted["boxed"] = [];
  for (const p of changed) {
    if (p.before !== null) all.push({ side: "before", line: bl[p.before]! });
    if (p.after !== null) all.push({ side: "after", line: al[p.after]! });
  }
  // The lines with an identical partner are the complement of the changed ones, in order (as pairPages recovers its pages): they link pages for R groups.
  const gone = new Set(changed.flatMap((p) => (p.before === null ? [] : [p.before])));
  const added = new Set(changed.flatMap((p) => (p.after === null ? [] : [p.after])));
  const keptB = bl.filter((_, i) => !gone.has(i));
  const keptA = al.filter((_, i) => !added.has(i));
  const linked: PagePair[] = keptB.map((l, i) => ({ before: l.page, after: keptA[i]!.page }));
  const pageText = (pages: PdfPage[]): PageText[] => pages.map((p) => ({ index: p.index, signature: p.runs.map((r) => norm(r.text)).join("\n") }));
  // pairPages pairs exactly the pages whose real text (object runs excluded) is identical; text-less pages pair by position or picture.
  const textPairs = pairPages(pageText(bp), pageText(ap));
  // Text-less pages that text could not pair are matched by their pictures; what is left over was added or removed.
  const free = (pages: PdfPage[], side: "before" | "after"): number[] => {
    const used = new Set(textPairs.map((p) => p[side]));
    return pages.filter((p) => p.runs.length === 0 && !used.has(p.index)).map((p) => p.index);
  };
  const matched = await matchByPicture(free(bp, "before"), free(ap, "after"), render);
  // A 1:1 partner must keep the page order: pairs that cross the longest in-order run were moved, so they have no partner (text pages become R,
  // text-less ones U). Without this a text-less page moved past a text page would read as "all pages match".
  const inOrder = longestInOrder([...textPairs, ...matched.pairs]);
  /*
   * THE SHAPE RULE (the definition, not a case list):
   *   A page pair is pixel-compared if and only if its real text (U+FFFC object runs excluded) is identical on both sides. Otherwise it is
   *   text-compared, and every added, removed or changed shape or picture on either side is boxed at its own rectangle. The "same text, page
   *   breaks moved" label appears only where page breaks really moved (viewFromPages), never on a page whose partner gained or lost a line.
   * `identical` is the set of pages in an in-order pair of identical real text (or two text-less pages matched by picture): those pages are
   * compared by pixels and carry no object box (the pixel boxes mark the object). Every other page keeps its changed object runs as boxes.
   * Real-text changes are boxed wherever they are.
   */
  const identical = { before: new Set(inOrder.map((p) => p.before)), after: new Set(inOrder.map((p) => p.after)) };
  const isObject = (b: Accounted["boxed"][number]): boolean => norm(b.line.run.text) === "";
  const boxed = all.filter((b) => !isObject(b) || !identical[b.side].has(b.line.page));
  const textBoxed = { before: new Set(boxed.filter((b) => b.side === "before").map((b) => b.line.page)), after: new Set(boxed.filter((b) => b.side === "after").map((b) => b.line.page)) };
  const kept = new Set(inOrder.map((p) => `${p.before}:${p.after}`));
  const moved = [...textPairs, ...matched.pairs].filter((p) => !kept.has(`${p.before}:${p.after}`));
  const unpaired = [...matched.unpaired];
  const skippedPages = [...matched.skippedPages];
  for (const p of moved) {
    for (const side of ["before", "after"] as const) {
      const n = p[side];
      if ((side === "before" ? bp : ap).find((x) => x.index === n)!.runs.length > 0) continue;
      const png = await render(side, n);
      const px = png === null ? null : decodePng(png);
      if (px === null) skippedPages.push({ side, page: n });
      else unpaired.push({ side, page: n, w: px.w, h: px.h });
    }
  }
  const comparable = inOrder.filter((p) => textPairs.some((t) => t.before === p.before && t.after === p.after)).filter((p) => !textBoxed.before.has(p.before) && !textBoxed.after.has(p.after));
  const pixel = await comparePages(comparable, render);
  const account = accountPages({
    before: bp.map((p) => ({ index: p.index, hasText: p.runs.length > 0 })),
    after: ap.map((p) => ({ index: p.index, hasText: p.runs.length > 0 })),
    boxed: textBoxed,
    pairs: inOrder,
    changed: pixel.pages.map((p) => ({ before: p.before, after: p.after })),
    skippedPairs: pixel.skippedPairs,
    skippedPages,
    drawnUnpaired: unpaired.map((u) => ({ side: u.side, page: u.page })),
    linked,
  });
  return { account, boxed, pixel, unpaired, pairs: inOrder };
}

/** The largest set of pairs that keeps page order on both sides (longest increasing run of after pages over pairs sorted by before page). */
function longestInOrder(pairs: PagePair[]): PagePair[] {
  const ps = [...pairs].sort((x, y) => x.before - y.before);
  const best: number[] = ps.map(() => 1);
  const prev: number[] = ps.map(() => -1);
  let end = -1;
  for (let i = 0; i < ps.length; i++) {
    for (let j = 0; j < i; j++) if (ps[j]!.after < ps[i]!.after && best[j]! + 1 > best[i]!) { best[i] = best[j]! + 1; prev[i] = j; }
    if (end < 0 || best[i]! > best[end]!) end = i;
  }
  const out: PagePair[] = [];
  for (let i = end; i >= 0; i = prev[i]!) out.unshift(ps[i]!);
  return out;
}

/**
 * A system whose PDF reader gives no text positions (Windows): every page of each side as a picture, in order, no pairing, no pixel work (each
 * picture costs a process start there) and no box. The sentence says so; a change card still names what changed. Never a guessed box.
 */
function pictureOnlyView(bp: PdfPage[], ap: PdfPage[], before: Buffer | null, after: Buffer | null, info: ChangeInfo, engine: string, caveats: string[], opts: PdfViewOptions): View {
  const pane = (side: "before" | "after", bytes: Buffer | null, pages: PdfPage[]): Pane[] => {
    if (bytes === null) return [];
    const sha = opts.pictureSha?.[side] ?? sha256(bytes);
    return pages.slice(0, MAX_PAGES_PER_SIDE).map((p): Pane => ({ id: `${side}:page${p.index}`, label: `${SIDE[side]}, page ${p.index} of ${pages.length}`, picture: { sha, width: p.width, height: p.height, page: p.index } }));
  };
  const out = [...caveats, NO_BOXES];
  for (const [side, pages] of [["before", bp], ["after", ap]] as const) if (pages.length > MAX_PAGES_PER_SIDE) out.push(`This document is long: the view lists the first ${MAX_PAGES_PER_SIDE} ${side} pages; the rest are left out.`);
  out.push(...(opts.caveats ?? []));
  return { change: info.id, file: info.file, engine, kind: "pages", before: pane("before", before, bp), after: pane("after", after, ap), boxes: [], caveats: out };
}

/** The view for two documents already read page by page. Exported so a test can feed pages without PDFKit. */
export async function viewFromPages(bp: PdfPage[], ap: PdfPage[], before: Buffer | null, after: Buffer | null, info: ChangeInfo, opts: PdfViewOptions = {}): Promise<View> {
  const engine = opts.engine ?? PDF_ENGINE;
  const caveats = [...(info.missing ?? [])];
  const card = (...more: string[]): View => ({ change: info.id, file: info.file, engine, kind: "card", before: [], after: [], boxes: [], caveats: [...caveats, ...more] });
  const plat = opts.platform ?? hostPlatform();
  if (!(opts.textRuns ?? pdfTextRuns(plat))) return pictureOnlyView(bp, ap, before, after, info, engine, caveats, opts);
  const render: RenderPage = opts.renderPage ?? ((side, n) => renderPdfPage((side === "before" ? before : after)!, n, plat));
  const { account, boxed, pixel, unpaired, pairs } = await accountDocument(bp, ap, render);
  const sides = ["before", "after"] as const;
  const pagesOf = (side: "before" | "after", status: PageStatus): number[] => [...account[side]].filter(([, s]) => s === status).map(([n]) => n);
  const everyP = sides.every((side) => pagesOf(side, "P=").length === account[side].size);
  const skipped = sides.map((side) => ({ side, pages: pagesOf(side, "S") })).filter((x) => x.pages.length > 0);
  const skippedLine = (): string => {
    const total = skipped.reduce((n, x) => n + x.pages.length, 0);
    return `${cap(skipped.map((x) => `${x.side} ${pageRanges(x.pages)}`).join(" and "))} could not be drawn or compared, so ${total === 1 ? "its picture was" : "their pictures were"} not compared.`;
  };

  // U and R are the only statuses that count toward the cap; T and P≠ are always shown.
  // U (added or removed pages, no text) take the slots first, R (page breaks moved) after.
  const cappedOf = (status: PageStatus) => sides.flatMap((side) => [...account[side]].filter(([, s]) => s === status).map(([n, s]) => ({ side, page: n, status: s })));
  const capped = [...cappedOf("U"), ...cappedOf("R")];
  const shownCapped = capped.slice(0, MAX_UNPAIRED_SHOWN);
  const hiddenCapped = capped.slice(MAX_UNPAIRED_SHOWN);
  const visible = { before: new Set<number>(), after: new Set<number>() };
  for (const side of sides) for (const [n, s] of account[side]) if (s === "T" || s === "P≠") visible[side].add(n);
  for (const c of shownCapped) visible[c.side].add(c.page);

  let banner: View["banner"];
  if (visible.before.size === 0 && visible.after.size === 0) {
    const same = before !== null && after !== null && before.equals(after);
    if (!everyP) {
      // Only undrawable pages are left: nothing to show and nothing is called a match.
      return card(same ? "The two states are the same bytes." : "The file differs, and not every page could be compared, so nothing here says the pages are the same.", skippedLine());
    }
    // The pages match, so they are shown anyway, under a banner that says what changed.
    for (const side of sides) for (const n of account[side].keys()) visible[side].add(n);
    const what = same ? "The two states are the same bytes." : info.changeSentence ?? "The file changed in a way that does not draw (for example notes, hidden slides or saved-file details such as timestamps).";
    banner = { title: "No visible difference", text: `${what} The pages look the same on both sides (${SAME_RULE}).` };
  }

  // The shape rule's label clause: "same text, page breaks moved" only where they did, a group of pages whose shared lines span more than one
  // page on a side. A one-to-one group (one page each side, as when a slide lost a bullet) is a page whose partner's text changed: no such label.
  const moves = (g: { before: number[]; after: number[] }): boolean => g.before.length > 1 || g.after.length > 1;
  const brokeAcross = (side: "before" | "after", n: number): boolean => account.groups.some((g) => g[side].includes(n) && moves(g));
  // The review view lists every page of each side, line k of Before beside its partner on After. A page with no partner has a placeholder opposite.
  const rows = alignPageRows(bp, ap, pairs, before !== null && after !== null, (side, n) => { const st = account[side].get(n); return st === "T" || st === "R"; });
  const rowShown = (r: PageRow): boolean => (r.before !== null && visible.before.has(r.before)) || (r.after !== null && visible.after.has(r.after));
  const mustShow = rows.filter(rowShown).length;
  let room = Math.max(0, MAX_PAGES_PER_SIDE - mustShow);
  const kept = rows.filter((r) => {
    if (rowShown(r)) return true;
    if (room > 0) { room--; return true; }
    return false;
  });
  const cut = rows.filter((r) => !kept.includes(r));
  const byIndex = { before: new Map(bp.map((p) => [p.index, p])), after: new Map(ap.map((p) => [p.index, p])) };
  const pane = (side: "before" | "after", bytes: Buffer | null, pages: number): Pane[] => {
    if (bytes === null) return [];
    const sha = opts.pictureSha?.[side] ?? sha256(bytes);
    const other = side === "before" ? "after" : "before";
    return kept.map((r): Pane => {
      const n = r[side];
      if (n === null) {
        const m = r[other]!;
        return { id: `${side}:absent${m}`, label: `No page ${m} on this side`, absent: true };
      }
      const p = byIndex[side].get(n)!;
      return {
        id: `${side}:page${p.index}`,
        label: `${SIDE[side]}, page ${p.index} of ${pages}${account[side].get(p.index) === "R" && brokeAcross(side, p.index) ? ": same text, page breaks moved" : ""}`,
        picture: { sha, width: p.width, height: p.height, page: p.index },
        ...(account[side].get(p.index) === "P=" ? { unchanged: true as const } : {}),
        ...(account[side].get(p.index) === "R" ? { reflowed: true as const } : {}),
      };
    });
  };
  const boxes: Box[] = boxed.map(({ side, line }) => ({ side, pane: `${side}:page${line.page}`, rect: { x: line.run.x, y: line.run.y, w: line.run.w, h: line.run.h }, text: line.run.text, change: info.id, confidence: "text-match" }));
  for (const pg of pixel.pages) {
    for (const side of sides) {
      for (const r of pg.regions) boxes.push({ side, pane: `${side}:page${pg[side]}`, rect: { ...r }, change: info.id, confidence: "pixel" });
    }
  }
  const shownU = shownCapped.filter((c) => c.status === "U");
  for (const c of shownU) {
    const u = unpaired.find((x) => x.side === c.side && x.page === c.page)!;
    boxes.push({ side: u.side, pane: `${u.side}:page${u.page}`, rect: { x: 0, y: 0, w: u.w, h: u.h }, change: info.id, confidence: "pixel" });
  }

  if (boxed.length > 0) caveats.push("Boxes are lines of text that have no identical line on the other side, found by comparing the text of the whole document, not page against page.");
  if (pixel.pages.length > 0) {
    const differ = pixel.pages.some((p) => p.before !== p.after);
    caveats.push(`Boxes on ${pageRanges(pixel.pages.map((p) => p.before))}${differ ? ` (after side: ${pageRanges(pixel.pages.map((p) => p.after))})` : ""} come from comparing the two page pictures pixel by pixel, not from text: the text on those pages is the same, so the change is in how the page draws (a chart, picture, shape or colour). The box marks where the pixels differ.`);
  }
  for (const side of sides) {
    const us = shownU.filter((c) => c.side === side).map((c) => c.page);
    if (us.length > 0) caveats.push(`${cap(pageRanges(us))} on the ${side} side ${us.length === 1 ? "was" : "were"} ${side === "before" ? "removed" : "added"}: ${us.length === 1 ? "it has" : "they have"} no text and no page on the other side has the same picture, so the whole page is boxed, by pixels.`);
  }
  for (const g of account.groups) {
    if (!moves(g)) {
      const rs = (["before", "after"] as const).flatMap((side) => g[side].filter((n) => account[side].get(n) === "R").map((n) => `${side} page ${n}`));
      if (rs.length > 0) caveats.push(`${cap(rs.join(" and "))} ${rs.length === 1 ? "was" : "were"} not compared by pixels, because the text of ${rs.length === 1 ? "its" : "their"} partner page changed. Shapes and pictures that were added, removed or resized are boxed; a change of colour or fill there would not show.`);
      continue;
    }
    const parts = [g.before.length > 0 ? `before ${pageRanges(g.before)}` : "", g.after.length > 0 ? `after ${pageRanges(g.after)}` : ""].filter((x) => x !== "");
    caveats.push(`Page breaks moved between ${parts.join(" and ")}: the lines they share are unchanged but fall on different pages, so the pages in this group with no box are shown as "same text, page breaks moved" and their pictures were not compared. In plain words: nobody looked at those pictures, so a change to a picture, chart or fill on one of these pages could be there and would not show here.`);
  }
  if (hiddenCapped.length > 0) {
    const named = sides.map((side) => ({ side, pages: hiddenCapped.filter((c) => c.side === side).map((c) => c.page) })).filter((x) => x.pages.length > 0);
    caveats.push(`${hiddenCapped.length} more page${hiddenCapped.length === 1 ? "" : "s"} (${named.map((x) => `${x.side} ${pageRanges(x.pages)}`).join(", ")}) ${beVerb(hiddenCapped.length)} shown without a box, past the limit of ${MAX_UNPAIRED_SHOWN} whole-page boxes.`);
  }
  if (cut.length > 0) {
    const named = sides.map((side) => ({ side, pages: cut.flatMap((r) => (r[side] === null ? [] : [r[side]!])) })).filter((x) => x.pages.length > 0);
    caveats.push(`This document is long: the view lists at most ${MAX_PAGES_PER_SIDE} pages per side, and ${named.map((x) => `${x.side} ${pageRanges(x.pages)}`).join(" and ")} (${cut.length} page${cut.length === 1 ? "" : "s"} in line) ${cut.length === 1 ? "is" : "are"} left out. They carry no box.`);
  }
  if (skipped.length > 0) caveats.push(skippedLine());
  caveats.push(...(opts.caveats ?? []));
  return { change: info.id, file: info.file, engine, kind: "pages", before: pane("before", before, bp.length), after: pane("after", after, ap.length), boxes, caveats, ...(banner === undefined ? {} : { banner }) };
}

interface PageRow { before: number | null; after: number | null }

/**
 * Both sides' pages as one list of rows: partners share a row, an unpaired page sits alone (a placeholder opposite when `both`). Without `both` one side is absent and its pages are not paired.
 * Pages between two partners that no pairing claimed are lined up in order when `pairable` says both are text pages (T: edited, R: page breaks moved), so an edited page sits beside
 * its edited self; an added or removed page (U) and any leftover keeps its placeholder.
 */
export function alignPageRows(bp: PdfPage[], ap: PdfPage[], pairs: PagePair[], both: boolean, pairable: (side: "before" | "after", page: number) => boolean = () => false): PageRow[] {
  if (!both) {
    const n = Math.max(bp.length, ap.length);
    return Array.from({ length: n }, (_, i) => ({ before: bp[i]?.index ?? null, after: ap[i]?.index ?? null }));
  }
  const paired = { before: new Set(pairs.map((p) => p.before)), after: new Set(pairs.map((p) => p.after)) };
  const bi = bp.map((p) => p.index).sort((x, y) => x - y);
  const ai = ap.map((p) => p.index).sort((x, y) => x - y);
  const rows: PageRow[] = [];
  let b = 0;
  let a = 0;
  const flush = (untilB: number, untilA: number): void => {
    const gb: number[] = [];
    const ga: number[] = [];
    while (b < bi.length && bi[b]! < untilB) { if (!paired.before.has(bi[b]!)) gb.push(bi[b]!); b++; }
    while (a < ai.length && ai[a]! < untilA) { if (!paired.after.has(ai[a]!)) ga.push(ai[a]!); a++; }
    let i = 0;
    let j = 0;
    while (i < gb.length || j < ga.length) {
      const x = gb[i];
      const y = ga[j];
      if (x !== undefined && y !== undefined && pairable("before", x) && pairable("after", y)) { rows.push({ before: x, after: y }); i++; j++; }
      else if (x !== undefined && (y === undefined || !pairable("before", x))) { rows.push({ before: x, after: null }); i++; }
      else { rows.push({ before: null, after: y! }); j++; }
    }
  };
  for (const p of [...pairs].sort((x, y) => x.before - y.before)) {
    flush(p.before, p.after);
    rows.push({ before: p.before, after: p.after });
    b++; a++;
  }
  flush(Infinity, Infinity);
  return rows;
}
