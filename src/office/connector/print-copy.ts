// The bytes an app prints from: CoCheck's own rewrite of the side's file, or null for the plain copy. Keyed by app; null whenever there is nothing
// to rewrite or the rewrite cannot be done safely, and then the plain copy is sent and no claim is made.
import type { OfficeAppKey } from "./apps.ts";
import { excelPrintCopy } from "./excel/print-setup.ts";
import type { PrintCopyOptions } from "./print-copy-cap.ts";
import { wordPrintCopyDetail } from "./word-print-copy.ts";

export interface PrintCopy {
  bytes: Buffer;
  /** Word: the copy has the file's comments taken out (the page says so). */
  commentsHidden?: true;
}

export function printCopy(app: OfficeAppKey, bytes: Buffer, opts?: PrintCopyOptions): PrintCopy | null {
  if (app === "excel") { const b = excelPrintCopy(bytes, opts); return b === null ? null : { bytes: b }; }
  if (app === "word") { const r = wordPrintCopyDetail(bytes, opts); return r === null ? null : { bytes: r.bytes, ...(r.hidden ? { commentsHidden: true as const } : {}) }; }
  return null;
}
