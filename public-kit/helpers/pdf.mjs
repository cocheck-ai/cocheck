// The PDF page rasterizer CoCheck itself uses (public-kit/spec/v1.md, "Helpers"): page n of a PDF as a PNG, at two pixels per point.
// Per OS: on macOS the pdfpages program CoCheck ships (dist/helpers/pdfpages, PDFKit); on Windows the OS's own PDF reader (Windows.Data.Pdf through
// powershell.exe). Elsewhere there is no backend and the answer is null. Every run works on a private temp copy of the bytes, never on the caller's
// file, with a timeout that kills it. Plain JavaScript on Node built-ins only; types in pdf.d.mts.
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 30_000;
const MAX_OUT = 32 * 1024 * 1024;

/** Where the macOS backend looks for pdfpages: COCHECK_PDF_HELPER when set, otherwise the copy CoCheck installs (dist/helpers/pdfpages beside public-kit/). */
export function pdfpagesPath() {
  return process.env.COCHECK_PDF_HELPER ?? fileURLToPath(new URL("../../dist/helpers/pdfpages", import.meta.url));
}

// The Windows script text is constant; the file names reach it as base64 on stdin (a path may hold any character, including non-ASCII).
// Windows.Data.Pdf sizes are in 1/96 inch; CoCheck's pages are pixels at two per point (1/72 inch), so 2 * 72 / 96 = 1.5.
export const WINDOWS_PDF_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$in=([Console]::In.ReadToEnd() -split '\\r?\\n')",
  "$mode=$in[0]; $src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($in[1]))",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]",
  "$null=[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]",
  "$null=[Windows.Data.Pdf.PdfPageRenderOptions,Windows.Data.Pdf,ContentType=WindowsRuntime]",
  "$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]",
  "$ext=[System.WindowsRuntimeSystemExtensions]",
  "$op=($ext.GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
  "$act=($ext.GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'})[0]",
  "function AwaitOp($o,$t){$k=$op.MakeGenericMethod($t).Invoke($null,@($o));$k.Wait(-1)|Out-Null;$k.Result}",
  "$f=AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($src)) ([Windows.Storage.StorageFile])",
  "$d=AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($f)) ([Windows.Data.Pdf.PdfDocument])",
  "function Dim($p){@([int][math]::Round($p.Size.Width*1.5),[int][math]::Round($p.Size.Height*1.5))}",
  "function Draw($n,$out){$p=$d.GetPage([uint32]($n-1)); $z=Dim $p; $o=New-Object Windows.Data.Pdf.PdfPageRenderOptions; $o.DestinationWidth=[uint32]$z[0]; $o.DestinationHeight=[uint32]$z[1]; $s=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream; $act.Invoke($null,@($p.RenderToStreamAsync($s,$o))).Wait(-1)|Out-Null; $s.Seek(0); $r=[System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($s); $tmp=$out+'.part'; $fs=[IO.File]::Create($tmp); $r.CopyTo($fs); $fs.Close(); [IO.File]::Delete($out); [IO.File]::Move($tmp,$out); $script:r=$r; $script:s=$s; $script:p=$p}",
  "if($mode -eq 'pages'){",
  "  for($i=0;$i -lt $d.PageCount;$i++){$p=$d.GetPage([uint32]$i);$z=Dim $p;[Console]::Out.Write(''+($i+1)+' '+$z[0]+' '+$z[1]+[char]10);$p.Dispose()}",
  "} elseif($mode -eq 'pngs'){",
  "  for($k=2;$k -lt $in.Count;$k++){ if($in[$k].Trim() -eq ''){continue}; $q=$in[$k].Trim() -split ' '; try{ $n=[int]$q[0]; $out=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($q[1])); Draw $n $out; [Console]::Out.Write('PNG-OK '+$n+[char]10); [Console]::Out.Flush(); $r.Dispose(); $s.Dispose(); $p.Dispose() }catch{} }",
  "} else {",
  "  $n=[int]$in[2]; $out=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($in[3]))",
  "  Draw $n $out; [Console]::Out.Write('PNG-OK'+[char]10); [Console]::Out.Flush(); $r.Dispose(); $s.Dispose(); $p.Dispose()",
  "}",
].join("; ").replace(/\{; /g, "{ ").replace(/; \}/g, " }").replace(/; \} else \{; /g, " } else { ");

const POWERSHELL = "powershell.exe";
const PS_BASE = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

/** The Windows backend over the given process functions (CoCheck passes its own; `windowsPdf()` passes Node's). */
export function createWindowsPdf(d) {
  const system32 = () => path.win32.join(d.env.SystemRoot || d.env.windir || "C:\\Windows", "System32");

  /** Runs a program to its end; on timeout kills the whole tree (never a negative pid). Never rejects. */
  function runTree(command, args, o) {
    return new Promise((resolve) => {
      let child;
      try {
        child = d.spawn(command, args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
      } catch (error) {
        resolve({ status: null, stdout: "", timedOut: false, error });
        return;
      }
      let out = "";
      let timedOut = false;
      let done = false;
      let hard;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(hard);
        resolve({ status: r.status, stdout: out, timedOut, ...(r.error === undefined ? {} : { error: r.error }) });
      };
      const killTree = () => {
        if (child.pid === undefined) return;
        try {
          d.run(path.win32.join(system32(), "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000 });
        } catch {
          // already gone
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
        // taskkill failed to end it: stop waiting rather than hang the caller
        hard = setTimeout(() => finish({ status: null }), 5_000);
        hard.unref?.();
      }, o.timeoutMs);
      child.on("error", (error) => finish({ status: null, error }));
      child.stdout?.on("data", (c) => {
        if (out.length < MAX_OUT) out += c.toString();
      });
      child.on("close", (code) => finish({ status: code }));
      if (o.input !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(o.input);
      }
    });
  }

  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const ps = (input, timeoutMs) => runTree(path.win32.join(system32(), "WindowsPowerShell", "v1.0", POWERSHELL), [...PS_BASE, WINDOWS_PDF_SCRIPT], { input, timeoutMs });

  return {
    available: () => d.exists(path.win32.join(system32(), "WindowsPowerShell", "v1.0", POWERSHELL)),
    textRuns: false,
    pdfjs: true,
    engine: "Windows PDF",
    async pages(file, timeoutMs) {
      const r = await ps(`pages\n${b64(file)}\n`, timeoutMs);
      if (r.timedOut) return "timeout";
      if (r.error !== undefined || r.status !== 0) return "failed";
      // one "index width height" line per page
      const pages = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => /^(\d+) (\d+) (\d+)$/.exec(l.trim()));
      if (pages.length === 0 || pages.some((m) => m === null)) return "failed";
      const sized = pages.map((m) => ({ index: Number(m[1]), width: Number(m[2]), height: Number(m[3]) }));
      return sized.every((p, i) => p.index === i + 1 && p.width > 0 && p.height > 0) ? { pages: sized } : "failed";
    },
    async png(file, n, out, timeoutMs) {
      if (!Number.isSafeInteger(n) || n < 1) return "failed";
      const r = await ps(`png\n${b64(file)}\n${n}\n${b64(out)}\n`, timeoutMs);
      if (r.timedOut) return "timeout";
      // powershell.exe crashes at exit (0xC0000005) after a finished write, so the exit status is not trusted; the marker is printed only after the rename.
      return r.error === undefined && /(^|\n)PNG-OK\r?\n/.test(r.stdout) && d.exists(out) ? "ok" : "failed";
    },
    /**
     * Several pages of one file in one powershell.exe call. `items` is [{ n, out }]. A page is "ok" only when its own "PNG-OK <n>" line (printed after the
     * rename) is in the output, read even when the run timed out, and the file exists; every other page is "failed".
     */
    async pngs(file, items, timeoutMs) {
      const ok = items.every((i) => Number.isSafeInteger(i.n) && i.n >= 1);
      if (!ok || items.length === 0) return items.map(() => "failed");
      const r = await ps(`pngs\n${b64(file)}\n${items.map((i) => `${i.n} ${b64(i.out)}\n`).join("")}`, timeoutMs);
      const marked = new Set();
      for (const m of r.stdout.matchAll(/^PNG-OK (\d+)\r?$/gm)) marked.add(Number(m[1]));
      return items.map((i) => (marked.has(i.n) && d.exists(i.out) ? "ok" : "failed"));
    },
  };
}

/** The Windows backend over Node's own process functions. */
export function windowsPdf() {
  return createWindowsPdf({ env: process.env, spawn, exists: existsSync, run: (command, args, options) => spawnSync(command, args, { ...options, encoding: "utf8" }) });
}

async function withCopy(bytes, use) {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-pdf-"));
  try {
    const file = path.join(dir, "state.pdf");
    await writeFile(file, bytes, { mode: 0o600 });
    return await use(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const runPdfpages = (program, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(program, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUT, encoding: "buffer", env: { PATH: "/usr/bin:/bin" } }, (err) => resolve(err === null));
  });

/** The macOS backend: the pdfpages program at `program` (default `pdfpagesPath()`), the same shape as the Windows one. */
export function macPdf(program = pdfpagesPath()) {
  const run = (args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(program, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUT, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }, (err, stdout) =>
        resolve({ ok: err === null, stdout: String(stdout ?? ""), timedOut: err !== null && err.killed === true }));
    });
  return {
    available: () => existsSync(program),
    textRuns: false,
    pdfjs: true,
    engine: "macOS PDFKit",
    async pages(file, timeoutMs) {
      const r = await run([file, "--sizes"], timeoutMs);
      if (r.timedOut) return "timeout";
      if (!r.ok) return "failed";
      const pages = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => /^(\d+) (\d+) (\d+)$/.exec(l.trim()));
      if (pages.length === 0 || pages.some((m) => m === null)) return "failed";
      const sized = pages.map((m) => ({ index: Number(m[1]), width: Number(m[2]), height: Number(m[3]) }));
      return sized.every((p, i) => p.index === i + 1 && p.width > 0 && p.height > 0) ? { pages: sized } : "failed";
    },
    async png(file, n, out, timeoutMs) {
      const r = await run([file, "--png", String(n), out], timeoutMs);
      return r.timedOut ? "timeout" : r.ok && existsSync(out) ? "ok" : "failed";
    },
  };
}

/** This OS's drawing backend: Windows' own reader on Windows, pdfpages on macOS, none elsewhere. */
export function osPdf() {
  return process.platform === "win32" ? windowsPdf() : process.platform === "darwin" ? macPdf() : null;
}

/**
 * Draws `pages` (1-based) of the PDF at `file` into `outDir` as `page-<n>.png` with this OS's batch backend (`windows`: default the Windows one on
 * Windows, none elsewhere), in one reader call. One entry per requested page, in order: `{ page, out, status }`, status "ok" only for a page the reader
 * reported finished; on a timeout the pages already finished stay "ok" and the rest are "failed". With no batch backend every page is "failed".
 */
export async function renderPdfPages(file, pages, outDir, timeoutMs = TIMEOUT_MS, windows = process.platform === "win32" ? windowsPdf() : null) {
  const items = pages.map((n) => ({ n, out: path.join(outDir, `page-${n}.png`) }));
  let statuses;
  try {
    statuses = windows !== null && typeof windows.pngs === "function" ? await windows.pngs(file, items, timeoutMs) : items.map(() => "failed");
  } catch {
    statuses = items.map(() => "failed");
  }
  return items.map((i, k) => ({ page: i.n, out: i.out, status: statuses[k] === "ok" ? "ok" : "failed" }));
}

/**
 * The pages of the PDF in `bytes` as PNG buffers through one batch call (`renderPdfPages` on a private temp copy): a Map of page to bytes, null for a
 * page that was not finished or could not be read. `options.windows` and `options.timeoutMs` as for `renderPdfPage`; with no batch backend, null for all.
 */
export async function renderPdfBytesPages(bytes, pages, options = {}) {
  const windows = options.windows !== undefined ? options.windows : process.platform === "win32" ? windowsPdf() : null;
  return withCopy(bytes, async (file, dir) => {
    const drawn = await renderPdfPages(file, pages, dir, options.timeoutMs ?? TIMEOUT_MS, windows);
    const result = new Map();
    for (const d of drawn) result.set(d.page, d.status === "ok" ? await readFile(d.out).catch(() => null) : null);
    return result;
  });
}

/**
 * Each page's size (pixels at two per point) as this OS's backend draws it (`options.backend`, default `osPdf()`): the sizes a reader's pages must
 * have for its rectangles to sit on the pictures. `{ pages }`, or "timeout" / "failed", or null when there is no backend here.
 */
export async function pdfPageSizes(bytes, options = {}) {
  const backend = options.backend !== undefined ? options.backend : osPdf();
  if (backend === null) return null;
  return withCopy(bytes, (file) => backend.pages(file, options.timeoutMs ?? TIMEOUT_MS));
}

/**
 * Page `n` (1-based) of the PDF in `bytes` as a PNG, or null when it cannot be drawn here (no backend, a damaged or locked PDF, no such page, the time
 * limit). `options.windows` picks an OS backend (default: the Windows one on Windows, none elsewhere; null for none); without one, the pdfpages
 * program at `options.pdfpages` (default `pdfpagesPath()`) draws the page.
 */
export async function renderPdfPage(bytes, n, options = {}) {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const windows = options.windows !== undefined ? options.windows : process.platform === "win32" ? windowsPdf() : null;
  return withCopy(bytes, async (file, dir) => {
    const png = path.join(dir, "page.png");
    const ok = windows !== null ? (await windows.png(file, n, png, timeoutMs)) === "ok" : await runPdfpages(options.pdfpages ?? pdfpagesPath(), [file, "--png", String(n), png], timeoutMs);
    return ok ? readFile(png).catch(() => null) : null;
  });
}
