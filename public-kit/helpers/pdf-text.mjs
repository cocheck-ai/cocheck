// The platform-agnostic PDF reader (public-kit/spec/v1.md, "Helpers"): everything CoCheck's macOS helper (native/pdfpages.swift) does with a PDF
// except drawing it, in the helper's own shapes, on any OS Node runs on: page count and sizes, text runs (with per-letter `chars` on heading-shaped
// runs), the ordered paragraph finder (`--find`) and the page crop (`--crop`). Text comes from Mozilla pdf.js (text only: no canvas, no rendering),
// laid out by pdf-text-layout.mjs. The crop cuts the page picture drawn by pdf.mjs (this OS's own backend) to what is printed on it.
//
// pdf.js runs in a child process of the same Node (this file, started with CHILD_FLAG), kept warm between calls (see "the warm child" below): the
// bytes go over a pipe, never through a file; a time limit per call kills it; a 1 GB heap cap; an environment with nothing of the parent's in it
// (only what Windows needs to start a process). The parent checks every answer field by field before it returns it; anything malformed is null.
// Plain JavaScript on Node built-ins only; types in pdf-text.d.mts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { decodePng } from "./png.mjs";
import { pdfPageSizes, renderPdfPage } from "./pdf.mjs";
import { findInPages, glyphSpans, layoutPage, pageRuns, SCALE } from "./pdf-text-layout.mjs";

const TIMEOUT_MS = 30_000;
/** The first argument that makes this file the pdf.js child instead of a module. */
export const CHILD_FLAG = "--cocheck-pdf-text-child";
const SELF = fileURLToPath(import.meta.url);

/** The pdf.js build this reader loads: the copy CoCheck ships (dist/vendor/pdfjs beside public-kit/), else the pdfjs-dist package (a source checkout); null when neither is here. */
export function pdfJsPath() {
  const vendored = fileURLToPath(new URL("../../dist/vendor/pdfjs/pdf.min.mjs", import.meta.url));
  if (existsSync(vendored)) return vendored;
  try {
    const pkg = fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.min.mjs"));
    return existsSync(pkg) ? pkg : null;
  } catch {
    return null;
  }
}

/** Whether this reader can run here: pdf.js is installed. Any OS. */
export const pdfTextAvailable = () => pdfJsPath() !== null;

/** Only what Windows itself needs to start a process; nothing of the parent's (no NODE_OPTIONS, no recorder hooks). */
function childEnv() {
  const env = {};
  for (const k of ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// ---- the warm child: one pdf.js process per parent process, kept between calls ----
//
// Starting Node and loading pdf.js costs about 150 ms, more than reading an Office PDF, so the child is started on the first call and kept. Requests
// wait in the parent and go to the child one at a time (one JSON line on its stdin, the PDF inline as base64; one answer line back), so each call's
// time limit counts from when the child starts it, never from when it began waiting. The child keeps the last few PDFs it laid out (by the SHA-256
// of their bytes), so reading a PDF and then finding paragraphs in it parses it once. A call past its time limit kills the child (SIGKILL) and
// answers "timeout"; the calls still waiting go on to a fresh child. A child that dies for any other reason (a crash) costs the call it was working
// on one retry on a fresh child before it answers "failed". The child never holds the parent open: it is unreferenced whenever nothing is pending,
// and stopped after IDLE_MS without a request.

const IDLE_MS = 30_000;
let warm = null;
let nextId = 1;
/** Calls not yet sent, oldest first: { id, line, timeoutMs, done, retried }. */
const waiting = [];

function hold(w, on) {
  for (const h of [w.proc, w.proc.stdin, w.proc.stdout]) (on ? h?.ref : h?.unref)?.call(h);
}

function startChild() {
  const proc = spawn(process.execPath, ["--max-old-space-size=1024", SELF, CHILD_FLAG, "--serve"], { stdio: ["pipe", "pipe", "ignore"], env: childEnv(), windowsHide: true });
  const w = { proc, current: null, buf: "", idle: null, dead: false };
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    w.buf += chunk;
    for (let nl = w.buf.indexOf("\n"); nl >= 0; nl = w.buf.indexOf("\n")) {
      const line = w.buf.slice(0, nl);
      w.buf = w.buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const c = w.current;
      if (c === null || msg?.id !== c.id) continue;
      w.current = null;
      clearTimeout(c.timer);
      c.done(msg.error === undefined ? { out: msg.out, error: null } : { out: null, error: "failed" });
    }
    pump();
  });
  const gone = () => {
    if (w.dead) return;
    w.dead = true;
    if (warm === w) warm = null;
    clearTimeout(w.idle);
    const c = w.current;
    w.current = null;
    if (c !== null) {
      clearTimeout(c.timer);
      if (c.timedOut) c.done({ out: null, error: "timeout" });
      else if (!c.retried) { c.retried = true; waiting.unshift(c); }
      else c.done({ out: null, error: "failed" });
    }
    pump();
  };
  proc.on("exit", gone);
  proc.on("error", gone);
  proc.stdin.on("error", () => undefined);
  return w;
}

/** Sends the next waiting call when the child is free; holds the parent while anything is pending, else lets it go and stops the child once idle. */
function pump() {
  if (warm !== null && warm.current !== null) return;
  if (waiting.length === 0) {
    if (warm !== null) {
      const w = warm;
      hold(w, false);
      clearTimeout(w.idle);
      w.idle = setTimeout(() => w.proc.kill("SIGKILL"), IDLE_MS);
      w.idle.unref?.();
    }
    return;
  }
  if (warm === null) warm = startChild();
  const w = warm;
  clearTimeout(w.idle);
  hold(w, true);
  const c = waiting.shift();
  w.current = c;
  c.timedOut = false;
  c.timer = setTimeout(() => { c.timedOut = true; w.proc.kill("SIGKILL"); }, c.timeoutMs);
  w.proc.stdin.write(c.line);
}

/** One request to the warm child: `{ out, error }`, never rejects. */
function ask(op, bytes, extra, timeoutMs) {
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.push({ id, line: `${JSON.stringify({ id, op, pdf: Buffer.from(bytes).toString("base64"), ...extra })}\n`, timeoutMs, done: resolve, retried: false });
    pump();
  });
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const validRect = (r) => typeof r === "object" && r !== null && finite(r.x) && finite(r.y) && finite(r.w) && finite(r.h) && r.w >= 0 && r.h >= 0;
const validPage = (p, i) => typeof p === "object" && p !== null && p.index === i + 1 && finite(p.width) && finite(p.height) && p.width > 0 && p.height > 0;
const validRun = (r) => validRect(r) && typeof r.text === "string" && (r.chars === undefined || (Array.isArray(r.chars) && r.chars.every((c) => validRect(c) && typeof c.c === "string")));

/**
 * Every page's size (pixels at two per point) and text runs, as the helper prints them. `{ pages, error }`: pages null when the PDF cannot be read
 * (damaged, locked, not a PDF) or pdf.js is not here (`error: "failed"`), or the time limit stopped it (`error: "timeout"`).
 */
export async function readPdfText(bytes, options = {}) {
  if (!pdfTextAvailable()) return { pages: null, error: "failed" };
  const { out, error } = await ask("read", bytes, {}, options.timeoutMs ?? TIMEOUT_MS);
  if (out === null) return { pages: null, error };
  const ok = Array.isArray(out.pages) && out.pages.every((p, i) => validPage(p, i) && Array.isArray(p.runs) && p.runs.every(validRun));
  return ok ? { pages: out.pages, error: null } : { pages: null, error: "failed" };
}

/**
 * Where each paragraph sits on the PDF's pages, as the helper's `--find` answers: `queries` is every paragraph of the document in document order
 * ({ id, text, want?, spans? }). Null when pdf.js is not here, the PDF cannot be read, the time limit stopped it, or the answer is malformed.
 */
export async function findPdfParagraphs(bytes, queries, options = {}) {
  if (!pdfTextAvailable() || !Array.isArray(queries)) return null;
  const { out } = await ask("find", bytes, { queries }, options.timeoutMs ?? TIMEOUT_MS);
  if (out === null || !Array.isArray(out.pages) || !out.pages.every(validPage) || !Array.isArray(out.results) || out.results.length !== queries.length) return null;
  const ok = out.results.every((r, i) => typeof r === "object" && r !== null && r.id === (typeof queries[i]?.id === "string" ? queries[i].id : "") && typeof r.found === "boolean" && typeof r.pagebreak === "boolean"
    && Array.isArray(r.segments) && r.segments.every((s) => Number.isInteger(s.page) && s.page >= 1 && s.page <= out.pages.length && validRect(s.rect) && Array.isArray(s.highlights) && s.highlights.every(validRect)));
  return ok ? { pages: out.pages, results: out.results } : null;
}

/** Pixels two page sizes may differ by and still be the same page (each side rounds its own size). */
export const SIZE_TOLERANCE = 2;
/** Whether a reader's pages are the drawer's pages: the same count, each size within SIZE_TOLERANCE. */
export function samePages(pages, drawn) {
  return pages.length === drawn.length && pages.every((p, i) => p.index === drawn[i].index && finite(p.width) && finite(p.height) && Math.abs(p.width - drawn[i].width) <= SIZE_TOLERANCE && Math.abs(p.height - drawn[i].height) <= SIZE_TOLERANCE);
}

/**
 * `readPdfText`, checked against the pages this OS draws (pdf.mjs `pdfPageSizes`, `options.backend` to choose the drawer): the runs sit on the
 * pictures only when pdf.js's pages are the drawer's (count, and sizes within SIZE_TOLERANCE). `{ pages, error, textRuns }`: the drawer's pages, with
 * pdf.js's runs when they agree and none when they do not (`textRuns: false`, no box can be placed); pages null when the drawer cannot read the PDF
 * or stops on its time limit. Where this OS has no drawer, pdf.js's pages unchecked (nothing is drawn to be wrong about).
 */
export async function readDrawnPdfText(bytes, options = {}) {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const [text, drawn] = await Promise.all([readPdfText(bytes, { timeoutMs }), pdfPageSizes(bytes, { ...(options.backend !== undefined ? { backend: options.backend } : {}), timeoutMs })]);
  if (drawn === null) return { ...text, textRuns: text.pages !== null };
  if (drawn === "timeout" || drawn === "failed") return { pages: null, error: drawn, textRuns: false };
  const same = text.pages !== null && samePages(text.pages, drawn.pages);
  return { pages: drawn.pages.map((p, i) => ({ index: p.index, width: p.width, height: p.height, runs: same ? text.pages[i].runs : [] })), error: null, textRuns: same };
}

/** An 8-bit RGBA PNG of `rgba` (fixed filter and level: the same pixels always give the same bytes). */
export function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(data, crc32(Buffer.from(type, "latin1"))) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A pixel counts as printed when any of red, green and blue is under this (the helper's rule). */
const INK = 245;

/**
 * The box around every printed pixel of an RGBA picture (any of red, green, blue under 245 once the pixel is laid on white, so a backend that
 * leaves the page transparent reads the same as one that draws it on white), grown by `padPx` and clamped to the picture; null for a picture
 * with nothing printed. The helper's `--crop` rule.
 */
export function inkBox(px, padPx) {
  const { width: pw, height: ph, rgba } = px;
  const onWhite = (v, a) => (v * a + 255 * (255 - a)) / 255;
  let x0 = pw, y0 = ph, x1 = -1, y1 = -1;
  for (let y = 0; y < ph; y++) {
    const row = y * pw * 4;
    for (let x = 0; x < pw; x++) {
      const p = row + x * 4, a = rgba[p + 3];
      if (onWhite(rgba[p], a) < INK || onWhite(rgba[p + 1], a) < INK || onWhite(rgba[p + 2], a) < INK) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const cx = Math.max(0, x0 - padPx), cy = Math.max(0, y0 - padPx), cx1 = Math.min(pw - 1, x1 + padPx), cy1 = Math.min(ph - 1, y1 + padPx);
  return { x: cx, y: cy, w: cx1 - cx + 1, h: cy1 - cy + 1 };
}

/**
 * Page `n` (1-based) cut to what is printed on it, grown by `padPt` points on every side, at two pixels per point, as the helper's `--crop`: the PNG
 * and where its top-left sits on the page, in page pixels; `{ empty: true }` for a blank page; null when the page cannot be drawn here (pdf.mjs has
 * no backend on this OS, or it failed) or its picture cannot be read. The page is drawn by `options.render` (default pdf.mjs `renderPdfPage`).
 */
export async function cropPdfPage(bytes, n, padPt, options = {}) {
  if (!Number.isSafeInteger(n) || n < 1 || !finite(padPt) || padPt < 0) return null;
  const render = options.render ?? ((b, k) => renderPdfPage(b, k, { timeoutMs: options.timeoutMs ?? TIMEOUT_MS }));
  const png = await render(bytes, n).catch(() => null);
  if (png === null) return null;
  const px = decodePng(png);
  if (px === undefined) return null;
  const box = inkBox(px, Math.round(padPt * SCALE));
  if (box === null) return { empty: true };
  const cut = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) px.rgba.copy(cut, y * box.w * 4, ((box.y + y) * px.width + box.x) * 4, ((box.y + y) * px.width + box.x + box.w) * 4);
  return { png: encodePng(box.w, box.h, cut), ...box, pageWidth: px.width, pageHeight: px.height };
}

// ---- the child: pdf.js in this process, JSON on stdout ----

/**
 * Each font's advance widths (per 1000 em) by character, read from the page's operator list (the glyphs pdf.js shows), keyed by the font's loaded
 * name (the `fontName` of a text item): where a character sits inside an item. A character shown with two widths in one font is left out.
 */
function glyphWidths(pdfjs, ops) {
  const out = {};
  if (ops === null) return out;
  try {
    const { OPS } = pdfjs;
    let font = null;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.setFont) font = typeof args?.[0] === "string" ? args[0] : null;
      else if (fn === OPS.showText && font !== null && Array.isArray(args?.[0])) {
        const map = (out[font] ??= {});
        for (const g of args[0]) {
          if (typeof g !== "object" || g === null || typeof g.unicode !== "string" || g.unicode.length !== 1 || !Number.isFinite(g.width)) continue;
          const had = map[g.unicode];
          if (had === undefined) map[g.unicode] = g.width;
          else if (had !== null && Math.abs(had - g.width) > 1e-6) map[g.unicode] = null;
        }
      }
    }
  } catch {
    return {};
  }
  for (const m of Object.values(out)) for (const [c, w] of Object.entries(m)) if (w === null) delete m[c];
  return out;
}

/** How many laid-out PDFs the child keeps (a diff reads two sides, then finds in them). */
const CACHE_SIZE = 4;

/** Every page of the PDF in `data`, laid out; throws when pdf.js cannot open it (damaged, locked, not a PDF). */
async function layOut(pdfjs, data) {
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: SCALE });
      const tc = await page.getTextContent({ disableNormalization: true });
      const items = tc.items.filter((it) => typeof it.str === "string");
      const ops = await page.getOperatorList().catch(() => null);
      pages.push(layoutPage({ viewport: { width: vp.width, height: vp.height, transform: [...vp.transform] }, items, styles: tc.styles, widths: glyphWidths(pdfjs, ops), offsets: (ops === null ? null : glyphSpans(ops, pdfjs.OPS, items)) ?? undefined }));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** The child: one request per stdin line ({ id, op: "read" | "find", pdf: base64, queries? }), one answer per stdout line, in order. */
async function childMain(args) {
  // pdf.js writes its warnings with console.log; stdout carries only the answers
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...a) => console.error(...a);
  console.warn = (...a) => console.error(...a);
  if (args[0] !== "--serve") { process.stderr.write("usage: pdf-text.mjs --cocheck-pdf-text-child --serve\n"); process.exit(3); }
  const lib = pdfJsPath();
  if (lib === null) { process.stderr.write("pdf.js is not installed\n"); process.exit(2); }
  const pdfjs = await import(pathToFileURL(lib).href);
  // in-process "worker": pdf.js uses this handler instead of starting a Worker or loading workerSrc
  globalThis.pdfjsWorker = await import(pathToFileURL(path.join(path.dirname(lib), "pdf.worker.min.mjs")).href);
  pdfjs.GlobalWorkerOptions.workerSrc = "";
  const cache = new Map();
  const pagesOf = async (data) => {
    const key = createHash("sha256").update(data).digest("hex");
    let hit = cache.get(key);
    if (hit === undefined) {
      hit = await layOut(pdfjs, data).then((pages) => ({ pages }), () => ({ pages: null }));
      cache.set(key, hit);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    }
    return hit.pages;
  };
  const answer = async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const reply = (body) => write(`${JSON.stringify({ id: req.id, ...body })}\n`);
    try {
      const pages = await pagesOf(new Uint8Array(Buffer.from(String(req.pdf ?? ""), "base64")));
      if (pages === null) return reply({ error: "cannot open (damaged or locked)" });
      if (req.op === "read") return reply({ out: { pages: pages.map((p, i) => ({ index: i + 1, width: p.width, height: p.height, runs: pageRuns(p) })) } });
      if (req.op === "find" && Array.isArray(req.queries)) return reply({ out: findInPages(pages, req.queries) });
      return reply({ error: "bad request" });
    } catch (e) {
      return reply({ error: String(e?.message ?? e) });
    }
  };
  let chain = Promise.resolve();
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => { chain = chain.then(() => answer(line)); });
  process.stdin.on("end", () => chain.then(() => process.exit(0)));
}

const isMain = (() => {
  if (process.argv[2] !== CHILD_FLAG || process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(SELF); } catch { return false; }
})();
if (isMain) await childMain(process.argv.slice(3));
