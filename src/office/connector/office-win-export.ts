// The Windows Office driver's exports: exportPdf and openDocuments over the PowerShell
// host (office-win.ps1, "# --- export ops ---"), and the PDF printer Word and Excel are pointed at. Windows-specific by name
// (platform-specific code lives in a module whose name says so).
// The printer: Word and Excel draw their PDF through a printer, and the person's default may be a network printer that is asleep or gone
// (the laptop's RICOH cost Word 51 s). So each is pointed at a local PDF printer for this instance only: Microsoft Print to PDF, else
// Microsoft XPS Document Writer, read from HKCU Devices by the host and picked here. Its full name is '<printer> <on> <port>' with the
// app's own word for "on" (taken from its current ActivePrinter, e.g. German 'auf'). With no such printer, or a redirect that did not
// take, Word and Excel export nothing and say so; PowerPoint saves its PDF without a printer and is unaffected.
import type { OfficeApp, OfficeAppKey } from "./apps.ts";
import type { ExportOutcome, ExportTarget, TargetResult, TargetsOutcome } from "./office-job.ts";
import { RESTRICTED_WHY, type HostReply, type WinHost } from "./office-win.ts";

/** The host's caveat codes, in the reviewer's words. */
export const NO_PDF_PRINTER_SENTENCE = "No local PDF printer (Microsoft Print to PDF) is installed, so Word and Excel pages can't be drawn.";
export const RESTRICTED_SENTENCE = "PowerShell is restricted by policy on this computer, so Office pages can't be drawn.";
/** The PDF printer is installed but the Office copy would not take it (its read-back name differs, e.g. a localized Office). */
export const PRINTER_SETUP_SENTENCE = "CoCheck couldn't set up its PDF printer in this copy of Office, so pictures of Word and Excel pages may need an English-language Office for now.";
/** The host did not answer hello for a reason other than a detected policy refusal. */
export const HOST_NOT_STARTED_SENTENCE = "PowerShell didn't start in time or failed to start on this computer (it may be slow, missing or blocked by policy), so Office pages can't be drawn.";
export const CAVEAT_SENTENCES: Record<"no-local-pdf-printer" | "pdf-printer-setup-failed" | "powershell-restricted", string> = {
  "pdf-printer-setup-failed": PRINTER_SETUP_SENTENCE,
  "no-local-pdf-printer": NO_PDF_PRINTER_SENTENCE,
  "powershell-restricted": RESTRICTED_SENTENCE,
};

/** The local PDF printers, in order of preference. */
export const PDF_PRINTERS = ["Microsoft Print to PDF", "Microsoft XPS Document Writer"] as const;

export interface PdfPrinter {
  /** The bare printer name (Word reads its ActivePrinter back as this). */
  name: string;
  /** '<name> <on> <port>', what Word's FilePrintSetup and Excel's ActivePrinter are given (Excel reads back exactly this). */
  full: string;
}

/** The app's word for "on" in its ActivePrinter string ('<printer> <on> <port>'), else 'on'. */
export function onWord(active: string): string {
  const m = /\s(\S+)\s+\S+:$/.exec(active.trim());
  return m ? m[1]! : "on";
}

/** The local PDF printer from HKCU Devices values ({name: 'winspool,Ne03:'}), named with the app's own "on"; null when none is installed. */
export function pickPdfPrinter(devices: Record<string, string>, active: string): PdfPrinter | null {
  for (const name of PDF_PRINTERS) {
    const value = devices[name];
    if (typeof value !== "string") continue;
    const port = value.split(",")[1]?.trim();
    if (!port) continue;
    return { name, full: `${name} ${onWord(active)} ${port}` };
  }
  return null;
}

/** A WinHost.call timeout ("the PowerShell host did not answer <op> in <n> ms"). */
const isTimeout = (why: string): boolean => /^the PowerShell host did not answer \S+ in \d+ ms$/.test(why);

function failed(app: OfficeApp, r: Extract<HostReply, { ok: false }>, what: string): Extract<ExportOutcome, { ok: false }> {
  const caveat = (r as { caveat?: unknown }).caveat;
  if (caveat === "no-local-pdf-printer") return { ok: false, timedOut: false, why: NO_PDF_PRINTER_SENTENCE, caveat: NO_PDF_PRINTER_SENTENCE };
  if (caveat === "pdf-printer-setup-failed") return { ok: false, timedOut: false, why: PRINTER_SETUP_SENTENCE, caveat: PRINTER_SETUP_SENTENCE };
  if (r.why === RESTRICTED_WHY || caveat === "powershell-restricted") return { ok: false, timedOut: false, why: RESTRICTED_SENTENCE, caveat: RESTRICTED_SENTENCE };
  if (isTimeout(r.why)) return { ok: false, timedOut: true, why: `${app.name} did not answer in time` };
  if (r.why === "not launched") return { ok: false, timedOut: false, why: `${app.name} was not started by this job` };
  return { ok: false, timedOut: false, why: `${app.name} could not ${what} (${r.why})` };
}

/** exportPdf and openDocuments for winOfficeDriver, over `host`. */
export function exportMethods(host: WinHost): {
  exportPdf(app: OfficeApp, input: string, pdf: string, timeoutMs: number): Promise<ExportOutcome>;
  openDocuments(app: OfficeApp, timeoutMs: number): Promise<string[] | null>;
  exportTargets(app: OfficeApp, input: string, targets: ExportTarget[], pdfs: string[], timeoutMs: number): Promise<TargetsOutcome>;
} {
  // the printer is worked out once per app per host (the host redirects Word once, before its first document)
  const printers = new Map<OfficeAppKey, PdfPrinter | null>();
  // the printer for Word or Excel, asked of the host once; a failed ask is the reply to return
  async function printerFor(app: OfficeApp, deadline: number): Promise<{ printer: PdfPrinter | null } | Extract<HostReply, { ok: false }>> {
    if (!printers.has(app.key)) {
      const r = await host.call("pdfPrinter", { app: app.key }, Math.max(1, deadline - Date.now()));
      if (!r.ok) return r;
      const devices = r.devices !== null && typeof r.devices === "object" ? (r.devices as Record<string, string>) : {};
      printers.set(app.key, pickPdfPrinter(devices, typeof r.active === "string" ? r.active : ""));
    }
    return { printer: printers.get(app.key) ?? null };
  }
  return {
    async exportTargets(app, input, targets, pdfs, timeoutMs): Promise<TargetsOutcome> {
      if (app.key !== "excel") return { ok: false, timedOut: false, why: `${app.name} cannot print sheets one by one` };
      const deadline = Date.now() + timeoutMs;
      const got = await printerFor(app, deadline);
      if (!("printer" in got)) return failed(app, got, "be asked for its printer");
      const r = await host.call("exportTargets", { app: app.key, input, targets, pdfs, printer: got.printer }, Math.max(1, deadline - Date.now()));
      if (!r.ok) return failed(app, r, "print its sheets");
      const raw = Array.isArray(r.results) ? (r.results as { ok?: unknown; why?: unknown; readBack?: unknown }[]) : [];
      const results: TargetResult[] = targets.map((_, i): TargetResult => {
        const x = raw[i];
        if (x?.ok === true) return { ok: true, ...(typeof x.readBack === "string" && x.readBack !== "" ? { readBack: x.readBack } : {}) };
        if (x?.ok === false) return { ok: false, why: `${app.name} could not set up this sheet for printing (${String(x.why)})` };
        return { ok: false, why: `${app.name} did not print this sheet` };
      });
      return { ok: true, results };
    },
    async exportPdf(app, input, pdf, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let printer: PdfPrinter | null = null;
      if (app.key !== "powerpoint") {
        const got = await printerFor(app, deadline);
        if (!("printer" in got)) return failed(app, got, "be asked for its printer");
        printer = got.printer;
      }
      // with no printer the host answers the caveat for Word and Excel and opens nothing
      const r = await host.call("exportPdf", { app: app.key, input, pdf, printer }, Math.max(1, deadline - Date.now()));
      return r.ok ? { ok: true } : failed(app, r, "save its PDF");
    },
    async openDocuments(app, timeoutMs) {
      const r = await host.call("openDocuments", { app: app.key }, timeoutMs);
      if (!r.ok || !Array.isArray(r.names)) return null;
      return r.names.map(String);
    },
  };
}
