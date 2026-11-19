// Test-only fakes for the built-in Office connectors: a driver that records every call and "exports" a stand-in PDF without any app,
// and a pager that turns that stand-in into one page of text and a real (tiny) PNG. Nothing here launches, scripts or signals Office.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { OfficeApp } from "../../src/office/connector/apps.ts";
import type { ExportOutcome, ExportTarget, OfficeExportDriver, TargetsOutcome } from "../../src/office/connector/office-job.ts";
import type { PdfPage, PdfRun } from "../../src/timeline/render/pdf-helper.ts";
import type { PdfPager } from "../../src/office/connector/pictures.ts";
import { rangeRect, readWorkbook, type Sheet } from "../../src/office/connector/excel/workbook.ts";
import { drawPage, type DrawnPage } from "./print-page.ts";
import { tempDirRemovedAtExit } from "./temp-dirs.ts";

export const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "office-connector");

export interface FakeOptions {
  /** The app is already open (the person's) when the job starts. */
  running?: boolean;
  /** What exportPdf does instead of writing the stand-in PDF. */
  exportAs?: "ok" | "timeout" | "throw" | "fail" | "no-pdf";
  /** Documents the app still holds at the end. */
  docsLeft?: number;
  pid?: number;
  /** exportPdf takes this long, honouring its timeout the way the real driver does (past it: timedOut). */
  delayMs?: number;
  /** documentCount and quit take this long, honouring their timeouts (past it: no answer). */
  cleanupDelayMs?: number;
  /** quit is asked but the app stays running. */
  quitIgnored?: boolean;
  /** What launch answers: the pid (default), or "not-ours" (the process found was not started by this launch). */
  launchAs?: "ours" | "not-ours";
  /** launch starts a real stand-in process (`sleep 300`) and answers its pid; kill sends it SIGKILL. */
  spawnApp?: boolean;
  /** Lines appended as things happen ("launched <pid>", "exporting"), for a test watching a child process. */
  reportFile?: string;
  /** Use this folder as the stage root instead of a new one. */
  stageRoot?: string;
  /** Blank documents a launched app opens by itself; documentCount closes them (as the driver's count script does) only when untitled and unmodified. */
  /** What appVersion answers (default "16.99.1"); "throw" makes it fail, "none" makes it answer nothing. */
  version?: string;
  blankDocs?: Array<{ name: string; untitled: boolean; saved: boolean }>;
}

export interface FakeCall { method: string; args: unknown[]; staged?: string[] }

export function fakeDriver(o: FakeOptions = {}): { driver: OfficeExportDriver; calls: FakeCall[]; stageRoot: string } {
  const stageRoot = o.stageRoot ?? tempDirRemovedAtExit("office-fake-stage-");
  const calls: FakeCall[] = [];
  let running = o.running === true;
  let pid = o.pid ?? 4242;
  const report = (line: string): void => { if (o.reportFile !== undefined) appendFileSync(o.reportFile, `${line}\n`); };
  const wait = (ms: number, limit: number): Promise<boolean> => new Promise((r) => setTimeout(() => r(ms <= limit), Math.min(ms, limit)));
  const docs = (o.blankDocs ?? []).map((d) => ({ ...d }));
  const driver: OfficeExportDriver = {
    stageRoot: () => stageRoot,
    pager: { pages: (pdf) => fakePager.pages(pdf), png: (pdf, n) => fakePager.png(pdf, n) },
    async appVersion() { if (o.version === "throw") throw new Error("no plist"); return o.version === "none" ? undefined : (o.version ?? "16.99.1"); },
    async isRunning(app) { calls.push({ method: "isRunning", args: [app.key] }); return running; },
    async launch(app) {
      calls.push({ method: "launch", args: [app.key] });
      running = true;
      if (o.launchAs === "not-ours") return "not-ours";
      if (o.spawnApp === true) {
        const child = spawn("sleep", ["300"], { stdio: "ignore", detached: false });
        child.unref();
        pid = child.pid!;
      }
      report(`launched ${pid}`);
      return pid;
    },
    async ready(app) { calls.push({ method: "ready", args: [app.key] }); return true; },
    async exportPdf(app: OfficeApp, input: string, pdf: string, timeoutMs: number): Promise<ExportOutcome> {
      calls.push({ method: "exportPdf", args: [app.key, input, pdf], staged: readdirSync(path.dirname(input)) });
      report("exporting");
      if (o.delayMs !== undefined && !(await wait(o.delayMs, timeoutMs))) return { ok: false, timedOut: true, why: "no answer" };
      if (o.exportAs === "throw") throw new Error("fake export blew up");
      if (o.exportAs === "timeout") return { ok: false, timedOut: true, why: "no answer" };
      if (o.exportAs === "fail") return { ok: false, timedOut: false, why: `${app.name} could not open this file (it answered error -50)` };
      if (o.exportAs === "no-pdf") return { ok: true };
      writeFileSync(pdf, `%PDF-fake ${app.key} ${createHash("sha256").update(readFileSync(input)).digest("hex")}`);
      return { ok: true };
    },
    // Excel's per-sheet print jobs: the same options shape the outcome; each target's stand-in PDF names its sheet and print area, so the
    // fake page reader below can answer pages with Excel-like printed headings
    async exportTargets(app: OfficeApp, input: string, targets: ExportTarget[], pdfs: string[], timeoutMs: number): Promise<TargetsOutcome> {
      calls.push({ method: "exportTargets", args: [app.key, input, targets.map((t) => `${t.sheet}|${t.area ?? ""}`)], staged: readdirSync(path.dirname(input)) });
      report("exporting");
      if (o.delayMs !== undefined && !(await wait(o.delayMs, timeoutMs))) return { ok: false, timedOut: true, why: "no answer" };
      if (o.exportAs === "throw") throw new Error("fake export blew up");
      if (o.exportAs === "timeout") return { ok: false, timedOut: true, why: "no answer" };
      if (o.exportAs === "fail") return { ok: false, timedOut: false, why: `${app.name} could not open this file (it answered error -50)` };
      if (o.exportAs !== "no-pdf") targets.forEach((t, i) => {
        const bytes = readFileSync(input), sha = createHash("sha256").update(bytes).digest("hex");
        // The page reader and cropper draw Excel-like print pages from the file's own sizes (print-page.ts), so the print route can place boxes in the fake world
        if (app.key === "excel" && t.kind === "worksheet") { try { const sh = readWorkbook(bytes).sheets.find((x) => x.name === t.sheet && x.kind === "worksheet"); if (sh) FAKE_SHEETS.set(sha, sh); } catch { /* the fake draws the old tiny page */ } }
        writeFileSync(pdfs[i]!, `%PDF-fake ${app.key} ${sha} ${t.kind} ${t.area ?? "-"}`);
      });
      return { ok: true, results: targets.map((t) => ({ ok: true as const, ...(t.area ? { readBack: t.area } : {}) })) };
    },
    async documentCount(app, timeoutMs) {
      calls.push({ method: "documentCount", args: [app.key] });
      if (o.cleanupDelayMs !== undefined && !(await wait(o.cleanupDelayMs, timeoutMs))) return null;
      for (const d of [...docs]) if (d.untitled && d.saved) { calls.push({ method: "closeBlank", args: [d.name] }); docs.splice(docs.indexOf(d), 1); }
      return (o.docsLeft ?? 0) + docs.length;
    },
    async quit(app, timeoutMs) {
      calls.push({ method: "quit", args: [app.key] });
      if (o.cleanupDelayMs !== undefined && !(await wait(o.cleanupDelayMs, timeoutMs))) return;
      if (o.quitIgnored !== true) running = false;
    },
    kill(p, signal) {
      calls.push({ method: "kill", args: signal === undefined ? [p] : [p, signal] });
      if (o.spawnApp === true) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
      running = false;
    },
  };
  return { driver, calls, stageRoot };
}

/** A real 1x1 RGB PNG whose colour comes from `seed`, so equal inputs give equal bytes and different inputs different bytes. */
export function tinyPng(seed: string, width = 1, height = 1): Buffer {
  const h = createHash("sha256").update(seed).digest();
  const chunk = (type: string, data: Buffer): Buffer => {
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, h[0])]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Reads the fake driver's stand-in PDF as one page. */
export const fakePager: PdfPager = {
  async pages(pdf) { const t = pdf.toString("latin1"); return t.startsWith("%PDF-fake ") ? [t] : null; },
  async png(pdf) { return tinyPng(pdf.toString("latin1")); },
};

/** Pages of a fake per-sheet PDF: one per print range, each with Excel-like printed headings (row numbers down the left, letters on top). */
/** The sheet each fake Excel PDF (by the sha of its input) was printed from. */
const FAKE_SHEETS = new Map<string, Sheet>();
const OX = 12, OY = 12;
const fakeDrawn = (pdf: Buffer, n: number): DrawnPage | undefined => {
  const m = /^%PDF-fake excel (\S+) worksheet (\S+)$/.exec(pdf.toString("latin1"));
  const sheet = m && FAKE_SHEETS.get(m[1]!);
  const rect = m && rangeRect(m[2]!.split(",")[n - 1]?.replace(/\$/g, "") ?? "");
  return sheet && rect ? drawPage(sheet, rect, { seed: m![1]! }) : undefined;
};
/** The page reader of a fake world whose Excel pages are drawn like real print pages (print-page.ts), so boxes can be placed; any other PDF is answered as by `fakePageReader`. */
export const drawnPageReader = async (pdf: Buffer): Promise<PdfPage[] | null> => {
  const m = /^%PDF-fake \S+ \S+ (\S+) (\S+)$/.exec(pdf.toString("latin1"));
  if (!m) return null;
  if (m[1] === "worksheet" && fakeDrawn(pdf, 1) !== undefined) {
    const mv = (cs?: { c: string; x: number; y: number; w: number; h: number }[]) => (cs ? { chars: cs.map((c) => ({ ...c, x: c.x + OX, y: c.y + OY })) } : {});
    return m[2]!.split(",").map((_, i): PdfPage => {
      const hd = fakeDrawn(pdf, i + 1)!.headings;
      return { index: i + 1, width: 1224, height: 1584, runs: [{ text: hd.cols!.text, x: hd.cols!.x + OX, y: hd.cols!.y + OY, w: hd.cols!.w, h: hd.cols!.h, ...mv(hd.cols!.chars) }, ...hd.rows.map((r) => ({ text: String(r.n), x: 32 + OX, y: r.y + OY, w: 9 * String(r.n).length, h: r.h, ...mv(r.chars) }))] };
    });
  }
  return fakePageReader(pdf);
};
export const fakePageReader = async (pdf: Buffer): Promise<PdfPage[] | null> => {
  const m = /^%PDF-fake \S+ \S+ (\S+) (\S+)$/.exec(pdf.toString("latin1"));
  if (!m) return null;
  if (m[1] === "chartsheet") return [{ index: 1, width: 1584, height: 1224, runs: [{ text: "Chart", x: 100, y: 100, w: 50, h: 20 }] }];
  const col = (x: string): number => [...x].reduce((v, ch) => v * 26 + ch.charCodeAt(0) - 64, 0);
  const name = (c: number): string => { let s = ""; while (c > 0) { const k = (c - 1) % 26; s = String.fromCharCode(65 + k) + s; c = (c - 1 - k) / 26; } return s; };
  return m[2]!.split(",").map((rng, i) => {
    const [a, b] = rng.replace(/\$/g, "").split(":");
    const p = /^([A-Z]+)(\d+)$/.exec(a!)!, q = /^([A-Z]+)(\d+)$/.exec(b ?? a!)!;
    const runs: PdfRun[] = [{ text: Array.from({ length: col(q[1]!) - col(p[1]!) + 1 }, (_, k) => name(col(p[1]!) + k)).join(" "), x: 130, y: 37, w: 600, h: 27 }];
    for (let r = Number(p[2]); r <= Number(q[2]); r++) runs.push({ text: String(r), x: 42, y: 65 + (r - Number(p[2])) * 28, w: 35, h: 27 });
    return { index: i + 1, width: 1224, height: 1584, runs };
  });
};
/** A crop of a fake page: a tiny PNG seeded by the PDF and the page, at a fixed origin. */
export const drawnCropper = async (pdf: Buffer, n: number): Promise<{ png: Buffer; x: number; y: number; w: number; h: number; pageWidth: number; pageHeight: number }> => { const d = fakeDrawn(pdf, n); if (d) return { png: d.png, x: OX, y: OY, w: d.pixels.width, h: d.pixels.height, pageWidth: 1224, pageHeight: 1584 }; return fakeCropper(pdf, n); };
export const fakeCropper = async (pdf: Buffer, n: number): Promise<{ png: Buffer; x: number; y: number; w: number; h: number; pageWidth: number; pageHeight: number }> => ({ png: tinyPng(`${pdf.toString("latin1")}#${n}`, 2, 2), x: 12, y: 12, w: 2, h: 2, pageWidth: 1224, pageHeight: 1584 });

/** The five state pairs of `cocheck connector test` for one ending, in a new folder: create, edit, delete, no-change, malformed. */
export function statePairs(ext: string): string {
  const dir = tempDirRemovedAtExit(`office-states-${ext.slice(1)}-`);
  const v1 = readFileSync(path.join(FIXTURES, `v1${ext}`)), v2 = readFileSync(path.join(FIXTURES, `v2${ext}`));
  const w = (n: string, b: Buffer | string): void => writeFileSync(path.join(dir, n), b);
  w("create.before.json", ""); w("create.after.json", v2);
  w("edit.before.json", v1); w("edit.after.json", v2);
  w("delete.before.json", v1); w("delete.after.json", "");
  w("no-change.before.json", v1); w("no-change.after.json", v1);
  w("malformed.before.json", v1); w("malformed.after.json", v2.subarray(0, Math.floor(v2.length / 2)));
  return dir;
}
