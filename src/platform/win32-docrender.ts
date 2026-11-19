import type { Win32Deps } from "./win32.ts";
import type { DocRender } from "./types.ts";
import { createWindowsPdf, WINDOWS_PDF_SCRIPT } from "../../public-kit/helpers/pdf.mjs";

// Windows: the OS's own PDF reader (Windows.Data.Pdf, through powershell.exe, no new dependency). The backend is the published kit helper
// (public-kit/helpers/pdf.mjs), run on CoCheck's own process functions, so core and outside connectors draw pages with one script.

export const pdfScriptForTest = WINDOWS_PDF_SCRIPT;

export function createDocRender(d: Win32Deps): DocRender {
  return { pdf: createWindowsPdf(d) };
}
