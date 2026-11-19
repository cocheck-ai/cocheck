// A connector answers an empty `changes` only when it compared everything it can see. The built-in
// Office connectors' readers list nothing for some changes they do not model (conditional formats, validations, presProps), so an empty list from
// them is not yet an answer: it stands only when the two packages are byte-identical part by part (pptx: or differ only in saved-file details,
// the allow-list). Any other difference becomes one `described` change in the connector's own words, never "nothing changed".
import { differingParts, docxOnlySavedDetailsDiffer, pptxOnlySavedDetailsDiffer, xlsxOnlySavedDetailsDiffer } from "./shared/package-media.ts";
import type { OfficeApp } from "./apps.ts";

export interface UnlistedChange { id: string; mark: "described"; label: string; text: string; kind: string }

/** The one change to add to an empty list whose two states still differ in something the reader does not list; null when the empty list stands. */
export function unlistedChange(app: Pick<OfficeApp, "key" | "name" | "noun">, before: Buffer | null, after: Buffer | null, listed: number): UnlistedChange | null {
  // a created or deleted file is not "saved again", and a list with changes needs no vouching
  if (listed > 0 || before === null || after === null || before.equals(after)) return null;
  // Each app's plain re-save rewrites only its saved-file details (the allow-lists in package-media.ts); byte-identical parts pass all three
  const same = app.key === "powerpoint" ? pptxOnlySavedDetailsDiffer(before, after) : app.key === "excel" ? xlsxOnlySavedDetailsDiffer(before, after) : docxOnlySavedDetailsDiffer(before, after);
  if (same) return null;
  const parts = differingParts(before, after);
  const where = parts !== null && parts.length > 0 ? ` (differing: ${parts.join(", ")})` : "";
  return { id: "c1", mark: "described", label: "Whole file", text: `The ${app.noun} changed in ways this change list does not show${where}.`, kind: "unlisted" };
}
