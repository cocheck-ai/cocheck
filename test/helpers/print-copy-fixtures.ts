// Fixtures: a workbook with the real pageSetup shapes (built from the repo's v1.xlsx plus a media binary), and the commented Word pair
// (word-comments-*.docx: the repo's W1 pair with comments, a reply, a resolved comment, commentsExtended, tracked changes, header, footer, footnotes, media).
import { readFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

export const FX = path.join(import.meta.dirname, "..", "fixtures", "office-connector");
export const read = (name: string): Buffer => readFileSync(path.join(FX, name));
export const parts = (b: Buffer): Record<string, Uint8Array> => unzipSync(new Uint8Array(b));
export const zip = (p: Record<string, Uint8Array>): Buffer => Buffer.from(zipSync(p as Zippable));
export const text = (p: Record<string, Uint8Array>, n: string): string => strFromU8(p[n]!);
export const put = (p: Record<string, Uint8Array>, n: string, s: string): Record<string, Uint8Array> => ({ ...p, [n]: strToU8(s) });

export const SHEET_SETUP = '<pageSetup paperSize="9" orientation="landscape" errors="blank" horizontalDpi="300"/>';
export const NESTED_SETUP = '<pageSetup paperSize="8" errors="dash"/>';

/** v1.xlsx with print settings on the sheet and in a custom view, and a binary part. */
export function xlsxWithPrintSetup(): Buffer {
  const p = parts(read("v1.xlsx"));
  let sheet = text(p, "xl/worksheets/sheet1.xml");
  sheet = sheet.replace("<pageMargins", `<customSheetViews><customSheetView guid="{00000000-0000-0000-0000-000000000001}">${NESTED_SETUP}</customSheetView></customSheetViews><pageMargins`);
  sheet = sheet.replace("</worksheet>", `${SHEET_SETUP}</worksheet>`);
  const media = new Uint8Array(300).map((_, i) => (i * 7) & 255);
  return zip({ ...put(p, "xl/worksheets/sheet1.xml", sheet), "xl/media/logo.png": media });
}
