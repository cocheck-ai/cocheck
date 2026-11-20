// The Excel connector's answer to `diff`: its own change list (diff.ts) and one purposeful picture per change area. Excel draws every
// pixel: the connector only replaces the page setup of a throwaway copy (print area = the chosen areas with context, 100% zoom or the
// pair's shared zoom, gridlines and headings on, titles, headers, footers and breaks cleared), prints each changed sheet alone, and cuts
// each page to what Excel printed on it with an even 12 pt margin (the kit's `cropPdfPage`: the page drawn by this OS, cut by the pdf.js reader's rule). Before and after pieces of one
// change area share a picture `group` and are ordered by `order`; both sides print at the same zoom and are cut at the same 2 px a point,
// so the same cells are the same size side by side. No boxes yet: each picture records in `private` which cells it holds, where its
// top-left sits on Excel's page, the scale, and the printed row and column headings, so boxes can be placed exactly later.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CHANGES_SPEC } from "../../../../public-kit/helpers/spec.mjs";
import { unlistedChange } from "../nothing-changed.ts";
import { cropPdfPage, readDrawnPdfText, SIZE_TOLERANCE, type PdfTextPage as PdfPage } from "../../../../public-kit/helpers/pdf-text.mjs";
import { preflight } from "../shared/preflight.ts";
import { stageName, stagingExt, type OfficeApp } from "../apps.ts";
import { officePdfs, type ExportTarget, type TargetPdf } from "../office-job.ts";
import { ANSWER_BUDGET_BYTES, ConnectorError, DIFF_MS, NO_DRIVER_WHY, PENDING_RETRY, RESERVES, type OfficeDoc, type ProgramDeps } from "../program.ts";
import { MAX_PICTURE_BYTES, pngSize, stampRenderedBy } from "../pictures.ts";
import { planExcel, rangeText, sheetOf, type ExcelPlan, type PrintArea, type SheetPrint } from "./diff.ts";
import { decodePng } from "../../../../public-kit/helpers/png.mjs";
import { placePrintBoxes, type HeadingChar, type PictureHeadings } from "./print-boxes.ts";
import { applyLooks, type LookSide } from "./look.ts";
import { refusalWords } from "../refusal.ts";
import { structureIssues } from "../issues.ts";

/** Pad around what Excel printed, in points. */
export const CROP_PAD_PT = 12;
/** Pixels a PDF point: the helper's fixed scale. */
export const PX_PER_PT = 2;
/** The zoom the drivers set on the page (office-macos.ts, office-win.ps1): whole percent, 10 to 400, read back before the save. */
export const printZoom = (z: number): number => Math.max(10, Math.min(400, Math.round(z)));
/** The longest print-area text one target sets (Excel's own limit is 255 characters). */
const MAX_AREA_TEXT = 240;

export interface RegionPicture {
  id: string;
  side: "before" | "after";
  type: "image";
  src: string;
  label: string;
  width: number;
  height: number;
  group: string;
  order: number;
  private: Record<string, unknown>;
}

/** Cuts page `n` of `pdf` to what is printed on it. The PNG and where its top-left sits on the page, in page pixels; null on failure. */
export type Cropper = (pdf: Buffer, n: number) => Promise<{ png: Buffer; x: number; y: number; w: number; h: number; pageWidth: number; pageHeight: number } | { empty: true } | null>;
export type PageReader = (pdf: Buffer) => Promise<PdfPage[] | null>;

export const helperCropper: Cropper = (pdf, n) => cropPdfPage(pdf, n, CROP_PAD_PT);
export const helperPageReader: PageReader = async (pdf) => (await readDrawnPdfText(pdf)).pages;

const quoteSheet = (n: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && !/^[A-Z]{1,3}\d+$/i.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
const abs = (r: PrintArea["rect"]): string => rangeText(r).split(":").map((a) => a.replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2")).join(":");

interface TargetJob { target: ExportTarget; sheet: SheetPrint; areas: PrintArea[] }

/** The print jobs of one side: each worksheet's areas in batches whose print-area text stays under Excel's limit; each chart sheet once. */
export function targetsOf(sheets: SheetPrint[]): TargetJob[] {
  const out: TargetJob[] = [];
  for (const sp of sheets) {
    if (sp.kind === "chartsheet") { out.push({ target: { sheet: sp.name, kind: "chartsheet", zoom: 100, landscape: true }, sheet: sp, areas: [] }); continue; }
    let batch: PrintArea[] = [];
    const flush = (): void => { if (batch.length) out.push({ target: { sheet: sp.name, kind: "worksheet", area: batch.map((a) => abs(a.rect)).join(","), zoom: sp.zoom, landscape: sp.landscape }, sheet: sp, areas: batch }); batch = []; };
    for (const a of sp.areas) {
      if (batch.length && [...batch, a].map((x) => abs(x.rect)).join(",").length > MAX_AREA_TEXT) flush();
      batch.push(a);
    }
    flush();
  }
  return out;
}

const COLS = /^[A-Z]{1,3}(?: [A-Z]{1,3})*$/;
const colNum = (s: string): number => [...s].reduce((v, ch) => v * 26 + ch.charCodeAt(0) - 64, 0);

/** The printed headings of a page: row numbers down the left (leftmost digit runs), and the column letters along the top. */
export function headingsOf(page: PdfPage): { rows: { n: number; y: number; h: number; chars?: HeadingChar[] }[]; cols?: { text: string; x: number; y: number; w: number; h: number; chars?: HeadingChar[] } } {
  const digits = page.runs.filter((r) => /^\d+$/.test(r.text));
  const left = digits.length ? Math.min(...digits.map((r) => r.x)) : 0;
  const rows = digits.filter((r) => Math.abs(r.x - left) <= 2 * PX_PER_PT + r.w).map((r) => ({ n: Number(r.text), y: r.y, h: r.h, ...(r.chars ? { chars: r.chars } : {}) })).sort((p, q) => p.y - q.y);
  const colRuns = page.runs.filter((r) => COLS.test(r.text)).sort((p, q) => p.y - q.y);
  const c = colRuns[0];
  return { rows, ...(c ? { cols: { text: c.text, x: c.x, y: c.y, w: c.w, h: c.h, ...(c.chars ? { chars: c.chars } : {}) } } : {}) };
}

/** Which area each page shows: by its first printed row and column; pages are in print-area order, so the index is the fallback. */
export function pagesToAreas(pages: PdfPage[], areas: PrintArea[]): { area: PrintArea; page: number; more: number }[] {
  const out: { area: PrintArea; page: number; more: number }[] = [];
  const used = new Set<number>();
  const taken = new Set<PrintArea>();
  pages.forEach((pg, i) => {
    const h = headingsOf(pg);
    const r = h.rows[0]?.n, c = h.cols ? colNum(h.cols.text.split(" ")[0]!) : undefined;
    const hit = r === undefined ? undefined : areas.find((a) => !taken.has(a) && a.rect.r1 <= r && r <= a.rect.r2 && (c === undefined || (a.rect.c1 <= c && c <= a.rect.c2)));
    if (hit) { out.push({ area: hit, page: i + 1, more: 0 }); taken.add(hit); used.add(i); }
    else if (r !== undefined) { const prev = out[out.length - 1]; if (prev && prev.area.rect.r1 <= r && r <= prev.area.rect.r2) { prev.more++; used.add(i); } }
  });
  if (out.length === 0 && pages.length === areas.length) return areas.map((a, i) => ({ area: a, page: i + 1, more: 0 }));
  return out;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A page's headings moved into the cropped picture's own pixels. */
function inPicture(h: ReturnType<typeof headingsOf>, ox: number, oy: number): PictureHeadings {
  const mv = (cs: HeadingChar[] | undefined): { chars: HeadingChar[] } | Record<string, never> => (cs ? { chars: cs.map((c) => ({ ...c, x: c.x - ox, y: c.y - oy })) } : {});
  return { rows: h.rows.map((r) => ({ n: r.n, y: r.y - oy, h: r.h, ...mv(r.chars) })), ...(h.cols ? { cols: { ...h.cols, x: h.cols.x - ox, y: h.cols.y - oy, ...mv(h.cols.chars) } } : {}) };
}

/** What the print route says about boxes for one side: the boxes and the words for changes it could not box, and the pictures every planned change of which is boxed. */
export interface PrintLook { boxes: LookSide["boxes"]; unplaced: LookSide["unplaced"]; allBoxed: Set<string> }

/** Pictures for one side's printed targets. Each picture's planned changes are boxed from the page's own lines (print-boxes.ts) or named in `look.unplaced` with the reason. */
export async function regionPictures(side: "before" | "after", jobs: TargetJob[], results: TargetPdf[], plan: ExcelPlan, deps: { crop: Cropper; pages: PageReader }, late: () => boolean): Promise<{ pictures: RegionPicture[]; caveats: string[]; look: PrintLook }> {
  const pictures: RegionPicture[] = [];
  const caveats: string[] = [];
  const look: PrintLook = { boxes: [], unplaced: [], allBoxed: new Set() };
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!, res = results[i];
    const where = `${cap(side)}: ${job.sheet.name}`;
    if (res === undefined || !("pdf" in res)) { caveats.push(`${where}: not drawn: ${res && "why" in res ? res.why : "Excel did not print it"}.`); continue; }
    if (late()) { caveats.push(`${where}: not drawn: out of time.`); continue; }
    const pages = await deps.pages(res.pdf);
    if (pages === null || pages.length === 0) { caveats.push(`${where}: Excel's PDF ${pages === null ? "could not be read" : "has no pages"}, so no picture is shown.`); continue; }
    if (job.target.kind === "chartsheet") {
      const cut = await deps.crop(res.pdf, 1);
      if (cut === null || "empty" in cut) { caveats.push(`${where}: Excel printed nothing for this chart sheet.`); continue; }
      const size = pngSize(cut.png) ?? { width: cut.w, height: cut.h };
      pictures.push({ id: `${side}:${job.sheet.group}:0`, side, type: "image", src: `data:image/png;base64,${cut.png.toString("base64")}`, label: `${cap(side)} - ${quoteSheet(job.sheet.name)} (chart sheet)`, ...size, group: job.sheet.group!, order: 0, private: { sheet: job.sheet.name, chartSheet: true, origin: { x: cut.x, y: cut.y }, page: { width: cut.pageWidth, height: cut.pageHeight }, scale: PX_PER_PT } });
      continue;
    }
    // the print area Excel read back: touching ranges merged at set time would shift the page-to-area map, so it is reported
    if (res.readBack !== undefined && res.readBack.split(",").length !== job.areas.length) caveats.push(`${where}: Excel merged some print areas (it read back ${res.readBack}); pictures were matched by their printed headings.`);
    const map = pagesToAreas(pages, job.areas);
    for (const m of map) {
      if (m.more > 0) caveats.push(`${where}!${rangeText(m.area.rect)} printed on ${m.more + 1} pages; only its first page is shown.`);
      const cut = await deps.crop(res.pdf, m.page);
      if (cut === null || "empty" in cut) { caveats.push(`${where}!${rangeText(m.area.rect)}: Excel printed nothing for this area.`); continue; }
      if (cut.png.length > MAX_PICTURE_BYTES) { caveats.push(`${where}!${rangeText(m.area.rect)}: the picture is over the size limit, so it is not shown.`); continue; }
      const size = pngSize(cut.png) ?? { width: cut.w, height: cut.h };
      const h = inPicture(headingsOf(pages[m.page - 1]!), cut.x, cut.y);
      const range = rangeText(m.area.rect);
      const id = `${side}:${m.area.group}:${m.area.order}`;
      const px = decodePng(cut.png);
      const pg = pages[m.page - 1]!;
      const sameSize = Math.abs(pg.width - cut.pageWidth) <= SIZE_TOLERANCE && Math.abs(pg.height - cut.pageHeight) <= SIZE_TOLERANCE;
      const placed = px === undefined
        ? m.area.boxes.map((b) => ({ change: b.change, why: "not marked: the picture could not be read" }))
        : !sameSize
        ? m.area.boxes.map((b) => ({ change: b.change, why: "not marked: the page text and the page picture disagree on the page's size" }))
        : placePrintBoxes({ pixels: px, headings: h, region: m.area.rect, sheet: sheetOf(job.sheet), pages: m.more + 1, boxes: m.area.boxes, pxPerPt: PX_PER_PT * printZoom(job.target.zoom) / 100 });
      for (const p of placed) {
        if ("rect" in p) look.boxes.push({ change: p.change, picture: id, rect: p.rect, ...(p.clipped ? { clipped: true as const } : {}) });
        else look.unplaced.push({ change: p.change, side, why: p.why });
      }
      if (placed.length > 0 && placed.every((p) => "rect" in p)) look.allBoxed.add(id);
      pictures.push({
        id,
        side,
        type: "image",
        src: `data:image/png;base64,${cut.png.toString("base64")}`,
        label: `${cap(side)} - ${quoteSheet(job.sheet.name)}!${range}`,
        ...size,
        group: m.area.group,
        order: m.area.order,
        private: { sheet: job.sheet.name, range, rect: m.area.rect, zoom: job.sheet.zoom, scale: PX_PER_PT, origin: { x: cut.x, y: cut.y }, page: { width: cut.pageWidth, height: cut.pageHeight }, headings: h },
      });
    }
    const shown = new Set(map.map((m) => m.area));
    for (const a of job.areas) if (!shown.has(a)) caveats.push(`${where}!${rangeText(a.rect)}: no printed page could be matched to this area, so it is not shown.`);
  }
  return { pictures, caveats, look };
}

/** v1 change objects, in the plan's order. */
function v1Changes(plan: ExcelPlan): OfficeDoc["changes"] {
  return plan.changes.map((c) => ({ id: c.id, mark: c.mark, label: c.label, ...(c.before !== undefined ? { before: c.before } : {}), ...(c.after !== undefined ? { after: c.after } : {}), ...(c.text !== undefined ? { text: c.text } : {}), ...(c.lines?.length ? { lines: c.lines } : {}), ...(c.parent !== undefined ? { parent: c.parent } : {}), ...(c.causedBy !== undefined ? { causedBy: c.causedBy } : {}), kind: c.kind, ...(c.private ? { private: c.private } : {}) })) as OfficeDoc["changes"];
}

async function readSide(file: string): Promise<Buffer | null> {
  const b = await readFile(file);
  return b.length === 0 ? null : b;
}

interface Print { pending?: string; prompted: Map<"before" | "after", { kind: "prompt" | "refused"; why: string }>; pictures: RegionPicture[]; caveats: string[]; failed: string[]; hang?: string; looks: Record<"before" | "after", PrintLook> }
const emptyLooks = (): Print["looks"] => ({ before: { boxes: [], unplaced: [], allBoxed: new Set() }, after: { boxes: [], unplaced: [], allBoxed: new Set() } });
interface Sheets { before: SheetPrint[]; after: SheetPrint[] }

/** Excel's print route for `sheets`: one officePdfs call (its own launch), the pages cut into pictures. */
async function printRun(app: OfficeApp, c: Ctx, sheets: Sheets): Promise<Print> {
  const { deps, now, plan } = c;
  const jobs = { before: targetsOf(sheets.before), after: targetsOf(sheets.after) };
  const sides = (["before", "after"] as const).filter((s) => (s === "before" ? c.before : c.after) !== null && jobs[s].length > 0).map((s) => {
    const file = s === "before" ? c.beforeFile : c.afterFile;
    return { side: s, file, name: stageName(file, s, app), targets: jobs[s].map((j) => j.target) };
  });
  const out: Print = { prompted: new Map(), pictures: [], caveats: [], failed: [], looks: emptyLooks() };
  // The open-watch rule runs while Excel's open of a staged copy is pending (windows {pid} only; no Screen Recording grant is read or asked)
  const printWin = await deps.windows?.().catch(() => null) ?? null;
  let job: Awaited<ReturnType<typeof officePdfs>>;
  try {
    job = await officePdfs(app, sides, { driver: deps.driver!, lockPath: deps.lockPath, deadline: c.deadline, cleanupBy: c.cleanupBy, ...(printWin !== null ? { windows: printWin.helper } : {}), ...(deps.promptTickMs !== undefined ? { promptTickMs: deps.promptTickMs } : {}), ...(deps.promptHoldMs !== undefined ? { promptHoldMs: deps.promptHoldMs } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.lockWaitMs !== undefined ? { lockWaitMs: deps.lockWaitMs } : {}), ...(deps.goneWaitMs !== undefined ? { goneWaitMs: deps.goneWaitMs } : {}), ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}) });
  } finally {
    await printWin?.close().catch(() => undefined);
  }
  if (job.pending === true) return { ...out, pending: job.why };
  const late = (): boolean => now() >= c.drawBy;
  for (const s of job.sides) {
    if ("targets" in s) {
      const got = await regionPictures(s.side, jobs[s.side], s.targets, plan, { crop: deps.crop ?? helperCropper, pages: deps.pages ?? helperPageReader }, late);
      out.pictures.push(...got.pictures);
      out.caveats.push(...got.caveats);
      out.looks[s.side].boxes.push(...got.look.boxes);
      out.looks[s.side].unplaced.push(...got.look.unplaced);
      for (const id of got.look.allBoxed) out.looks[s.side].allBoxed.add(id);
    } else if ("caveat" in s) {
      if (!out.caveats.includes(s.caveat)) out.caveats.push(s.caveat); // a sentence about this computer, once per file
    } else if ("why" in s && "prompt" in s && s.prompt === true) {
      out.prompted.set(s.side, { kind: "prompt", why: s.why });
    } else if ("why" in s) {
      out.failed.push(`${cap(s.side)}: not drawn: ${s.why.replace(/\.$/, "")}.`);
      if (("hang" in s) && s.hang === true) out.hang = s.why;
    }
  }
  return out;
}

interface Ctx { deps: ProgramDeps; now: () => number; plan: ExcelPlan; before: Buffer | null; after: Buffer | null; beforeFile: string; afterFile: string; deadline: number; cleanupBy: number; drawBy: number }

/** Groups by rank; the size budget drops the lowest-ranked groups whole, never a side of one. Sets doc.pictures or doc.status. */
function ship(app: OfficeApp, doc: OfficeDoc, plan: ExcelPlan, all: RegionPicture[], failed: string[], hang: string | undefined, allBoxed: ReadonlySet<string>): RegionPicture[] {
  const rank = new Map(plan.groups.map((g, i) => [g.id, i] as const));
  all.sort((x, y) => (rank.get(x.group) ?? 1e9) - (rank.get(y.group) ?? 1e9) || (x.side === y.side ? 0 : x.side === "before" ? -1 : 1) || x.order - y.order);
  let budget = ANSWER_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(doc));
  const kept: RegionPicture[] = [];
  const dropped = new Set<string>();
  for (const g of plan.groups) {
    const mine = all.filter((p) => p.group === g.id);
    const cost = mine.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p)), 0);
    if (cost > budget) { if (mine.length) dropped.add(g.id); continue; }
    budget -= cost;
    kept.push(...mine);
  }
  if (dropped.size) doc.caveats.push(`${dropped.size} change area${dropped.size === 1 ? " is" : "s are"} not pictured: the answer would be over its size limit.`);
  // a print-page picture where any change is unplaced says so, so a reader never takes the unmarked page for "nothing changed here"; one whose every change is boxed does not
  for (const p of kept) if (!allBoxed.has(p.id)) doc.caveats.push(`${p.label}: changes are not marked on this picture.`);
  if (kept.length > 0) doc.pictures = kept as unknown as OfficeDoc["pictures"];
  else doc.status = { kind: hang !== undefined ? "hang" : "unavailable", evidence: hang ?? (failed[0] ?? doc.caveats[doc.caveats.length - 1] ?? `${app.name} drew no pictures`) };
  return kept;
}

/** One side of the print route as a LookSide, so applyLooks writes the v1 `boxes` and `unplaced`: a change expected on this side with no box and no reason of its own is "not pictured". */
function printSide(side: "before" | "after", shipped: RegionPicture[], got: PrintLook, plan: ExcelPlan): LookSide {
  const mine = shipped.filter((p) => p.side === side);
  const out: LookSide = { pictures: mine, boxes: got.boxes, unplaced: [] };
  const placed = new Set(got.boxes.map((b) => b.change));
  for (const c of plan.changes) {
    if (!(side === "before" ? c.mark !== "added" : c.mark !== "removed") || placed.has(c.id)) continue;
    const reasons = got.unplaced.filter((u) => u.change === c.id).map((u) => u.why);
    if (reasons.length) { out.unplaced.push({ change: c.id, side, why: [...new Set(reasons)].join("; ") }); continue; }
    const own = (c.private?.unplaced as { before?: string; after?: string } | undefined)?.[side];
    if (own !== undefined) out.unplaced.push({ change: c.id, side, why: own });
    else if (c.kind === "derived") out.unplaced.push({ change: c.id, side, why: "derived: recalculated because another cell changed, not marked" });
    else if (c.mark !== "described") out.unplaced.push({ change: c.id, side, why: "not pictured" });
  }
  return out;
}

const pendingDoc = (doc: OfficeDoc, why: string): OfficeDoc => ({ ...doc, pendingRetry: PENDING_RETRY, caveats: [...doc.caveats, why] });

/** The answer to `diff` for Excel. */
export async function answerExcel(app: OfficeApp, beforeFile: string, afterFile: string, deps: ProgramDeps): Promise<OfficeDoc> {
  const now = deps.now ?? Date.now;
  const r = deps.reserves ?? RESERVES;
  const drawBy = now() + (deps.diffMs ?? DIFF_MS) - r.marginMs;
  const cleanupBy = drawBy - r.drawMs;
  const deadline = cleanupBy - r.cleanupMs;
  const [before, after] = await Promise.all([readSide(beforeFile), readSide(afterFile)]);
  if (before === null && after === null) return { spec: CHANGES_SPEC, changes: [], caveats: [] };
  for (const [side, bytes] of [["before", before], ["after", after]] as const) {
    if (bytes === null) continue;
    const p = preflight(bytes, `${side}${stagingExt(app, side === "before" ? beforeFile : afterFile)}`);
    if (p.action === "skip") throw new ConnectorError("unreadable-file", `The ${side} file is not a ${app.noun} ${app.name} can open: ${p.reason}`);
  }
  let plan: ExcelPlan;
  try {
    plan = planExcel(before, after);
  } catch (error) {
    throw new ConnectorError("unreadable-file", `The workbook could not be read: ${(error as Error).message}`);
  }
  const doc: OfficeDoc = { spec: CHANGES_SPEC, changes: v1Changes(plan), caveats: [...plan.caveats] };
  // migration X1, X2 (spec v1.2 `issues`): what Excel would ask to repair in the after state, then the error values this change introduced
  const issues = [...structureIssues(after, `after${stagingExt(app, afterFile)}`), ...plan.issues];
  if (issues.length > 0) doc.issues = issues;
  // the nothing-changed rule (spec v1.2): an empty list stands only when the packages match part by part
  const unlisted = unlistedChange(app, before, after, doc.changes.length);
  if (unlisted !== null) doc.changes.push(unlisted);
  if (before !== null && after !== null && before.equals(after)) return doc;
  if (plan.before.length === 0 && plan.after.length === 0) return doc;
  if (deps.driver === undefined) {
    doc.caveats.unshift(deps.noDriverWhy ?? NO_DRIVER_WHY(app));
    return doc;
  }
  const c: Ctx = { deps, now, plan, before, after, beforeFile, afterFile, deadline, cleanupBy, drawBy };
  // The route: Excel's own print pages, the only one. A review never asks for a grant.
  const pr = await printRun(app, c, plan);
  if (pr.pending !== undefined) return pendingDoc(doc, pr.pending);
  const sidesHere = (["before", "after"] as const).filter((s) => (s === "before" ? before : after) !== null);
  doc.caveats.push(...pr.caveats, ...refusalWords(app, pr.prompted, sidesHere, true).caveats, ...pr.failed);
  const shipped = ship(app, doc, plan, pr.pictures, pr.failed, pr.hang, new Set([...pr.looks.before.allBoxed, ...pr.looks.after.allBoxed]));
  if (shipped.length > 0) applyLooks(doc, (["before", "after"] as const).map((side) => printSide(side, shipped, pr.looks[side], plan)), plan);
  // the finding at the spec's level (refusal.ts)
  const rw = refusalWords(app, pr.prompted, sidesHere, (doc.pictures ?? []).length > 0);
  if (rw.status !== undefined) doc.status = rw.status;
  if (rw.standIns.length > 0) doc.pictures = [...(doc.pictures ?? []), ...rw.standIns] as unknown as OfficeDoc["pictures"];
  await stampRenderedBy(doc, app, deps.driver);
  return doc;
}
