// Migration X2: error values a change introduced, as spec v1.2 issues with `where` = the cell. Ported from core's checks/errors.ts, which ran
// on review_rows, onto the connector's own comparison: each after cell is paired with its before cell through the same row and column alignment
// the change list uses (diff.ts), so an inserted row or an added sheet has no before cell, and a recalculated (derived) cell is checked exactly
// like an edited one. An error is the reader's typed `{ error }` value, never text: a text cell that spells "#N/A" is not an error.
import type { Cell, Sheet, Value } from "./workbook.ts";

export interface ErrorIssue { text: string; side: "after"; where: string }

/** One after sheet and how to find the before cell of an after cell (undefined: none, the cell is new). */
export interface ErrorSheet { label: string; after: Sheet; beforeOf: (r: number, c: number) => Cell | undefined }

/** The most cell issues listed one by one; past it, one issue counts the rest. */
export const MAX_ERROR_ISSUES = 200;

const errorOf = (v: Value | undefined): string | null => (v !== null && v !== undefined && typeof v === "object" && typeof v.error === "string" ? v.error : null);

/** `#REF!` occurrences in formula text, ignoring string literals ("#REF!" typed as text is fine). */
export function brokenRefs(formula: string | null | undefined): number {
  return ((formula ?? "").replace(/"(?:[^"]|"")*"/g, '""').match(/#REF!/gi) ?? []).length;
}

const colName = (c: number): string => {
  let s = "";
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** The error values and broken references the change introduced, in sheet, row, column order. */
export function introducedErrors(sheets: readonly ErrorSheet[]): ErrorIssue[] {
  const out: ErrorIssue[] = [];
  let more = 0;
  for (const s of sheets) {
    if (s.after.kind !== "worksheet") continue;
    for (const r of [...s.after.rows.keys()].sort((x, y) => x - y)) {
      const row = s.after.rows.get(r)!;
      for (const c of [...row.keys()].sort((x, y) => x - y)) {
        const now = row.get(c)!;
        const was = s.beforeOf(r, c);
        const err = errorOf(now.v);
        const texts: string[] = [];
        if (err !== null && errorOf(was?.v) === null) texts.push(`Shows the error ${err}, which the change introduced.`);
        if (brokenRefs(now.f) > brokenRefs(was?.f)) texts.push("The formula now points at a reference that no longer exists (#REF!).");
        for (const text of texts) {
          if (out.length < MAX_ERROR_ISSUES) out.push({ text, side: "after", where: `${s.label}!${colName(c)}${r}` });
          else more++;
        }
      }
    }
  }
  if (more > 0) out.push({ text: `${more} more cell${more === 1 ? "" : "s"} now show an error value or a broken reference (#REF!) the change introduced.`, side: "after", where: "Workbook" });
  return out;
}
