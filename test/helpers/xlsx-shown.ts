import { round15 } from "../../src/office/connector/xlsx/numbers.ts";
import { builtinCode, showNumber, showText } from "../../src/office/connector/xlsx/numfmt.ts";

// How a cell value shows: the number format applied as the app applies it. No src module reads it (core does not format cell values), so it is a test helper. Its tests keep the
// connector's number-format rules (src/office/connector/xlsx/numfmt.ts) pinned through it.

/** What a date-ish number format shows: a calendar date (maybe with time), a time of day only, or elapsed time. */
type DateKind = "date" | "time" | "serial" | "elapsed-h" | "elapsed-m" | "elapsed-s";

/**
 * Classifies a number format the way Excel reads it. Built-in ids: 14-17, 22, 27-36 and 50-58 are
 * dates (27-36 and 50-58 are the locale-dependent ones), 18-21 and 47 are times, 45 is mm:ss
 * (a time), 46 is [h]:mm:ss (elapsed). A code is elapsed when it has a `[h]`, `[m]` or `[s]`
 * section, a date when it has a d or y token (or an m that is not a minute), a time when it only
 * has h, s, AM/PM or minute tokens. Quoted text, escaped characters, `[Red]`/`[$-409]` and
 * `General` are ignored. An m is a minute when the previous token is h or the next is s.
 */
const UNSOURCED_LOCALE_IDS: ReadonlySet<number> = new Set([32, 33, 34, 35, 52, 53, 55, 56]);

function dateKind(numFmt: unknown): DateKind | null {
  if (typeof numFmt === "number") {
    // Source gap: no offline ECMA-376 18.8.30 table or CJK-locale Excel fixture is available, so the
    // per-id kinds of the locale built-ins cannot be cited. The ids the reviewer flagged as times (32-35, 52,
    // 53, 55, 56) are not rendered as dates; they show the bare serial. The other locale ids stay dates, unsourced.
    if (UNSOURCED_LOCALE_IDS.has(numFmt)) return "serial";
    if ((numFmt >= 14 && numFmt <= 17) || numFmt === 22 || (numFmt >= 27 && numFmt <= 36) || (numFmt >= 50 && numFmt <= 58)) return "date";
    if ((numFmt >= 18 && numFmt <= 21) || numFmt === 45 || numFmt === 47) return "time";
    return numFmt === 46 ? "elapsed-h" : null;
  }
  if (typeof numFmt !== "string") return null;
  const first = (numFmt.split(";")[0] ?? "").replace(/"[^"]*"/g, "").replace(/\\.|_.|\*./g, "");
  const elapsed = /\[(h+|m+|s+)\]/i.exec(first);
  if (elapsed) return `elapsed-${elapsed[1]![0]!.toLowerCase()}` as DateKind;
  const bare = first.replace(/\[[^\]]*\]/g, "").replace(/am\/pm|a\/p/gi, "h");
  if (/^\s*general\s*$/i.test(bare)) return null;
  const tokens = bare.toLowerCase().match(/[dmyhs]+/g);
  if (!tokens) return null;
  if (tokens.some((t) => t[0] === "d" || t[0] === "y")) return "date";
  const hasMonth = tokens.some((t, i) => t[0] === "m" && tokens[i - 1]?.[0] !== "h" && tokens[i + 1]?.[0] !== "s");
  return hasMonth ? "date" : "time";
}

/** True when a number format is a date, time or elapsed-time format (see `dateKind`). */
export function isDateFormat(numFmt: unknown): boolean {
  return dateKind(numFmt) !== null;
}

/** The format code behind a number format given as a built-in id or as a code; a locale id with no known code gets a label no parser accepts. */
function codeOf(numFmt: unknown): string {
  if (typeof numFmt === "number") return builtinCode(numFmt) ?? `built-in format ${numFmt}`;
  return typeof numFmt === "string" && numFmt !== "" ? numFmt : "General";
}

/**
 * A value as the cell shows it: the number format applies as Excel applies it, so a date shows in the file's own pattern, a
 * percent as a percent, a currency with its symbol. Where the shown text drops part of the stored value (rounding, a hidden time of
 * day) the stored value follows in brackets: `3.1% (stored 0.0312)`. A format CoCheck cannot render exactly shows the stored value
 * marked `(shown unformatted)`, never a guess. Formulas as `=...`, and "(empty)" for nothing.
 */
export function formatValue(value: unknown, numFmt?: unknown, exact = false, dateSystem: 1900 | 1904 = 1900): string {
  if (value === null || value === undefined || value === "") {
    return "(empty)";
  }
  if (typeof value === "number") {
    const n = round15(value);
    const shown = showNumber(value, codeOf(numFmt), { dateSystem });
    if (!shown.exact) return `${String(n)} (shown unformatted)`;
    const stored = String(n);
    // The padding a code adds for alignment (`_)`, `?`) is not content: a note quotes the text without it.
    const text = shown.text.trim();
    return (exact || shown.lossy) && stored !== text ? `${text} (stored ${stored})` : text;
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "string") {
    return showText(value, codeOf(numFmt));
  }
  if (typeof value === "object" && "formula" in value) {
    const { value: v, formula } = value as { value?: unknown; formula?: unknown };
    const f = typeof formula === "string" && formula ? (formula.startsWith("=") ? formula : `=${formula}`) : "";
    const shown = formatValue(v, numFmt, exact, dateSystem);
    return f ? `${shown} (formula ${f})` : shown;
  }
  return JSON.stringify(value);
}

/**
 * Before and after text for one row. When the friendly formatting renders both sides the same
 * but the values differ (1 -> 1.000000001, 0 -> 0.000001), both fall back to the full 15
 * significant digits (exponent form for tiny numbers) so the change is visible.
 */
export function beforeAfterText(before: unknown, after: unknown, fmtBefore?: unknown, fmtAfter?: unknown, dateSystem: 1900 | 1904 = 1900): { before: string; after: string } {
  const text = { before: formatValue(before, fmtBefore, false, dateSystem), after: formatValue(after, fmtAfter, false, dateSystem) };
  if (text.before !== text.after) return text;
  const exact = { before: formatValue(before, fmtBefore, true, dateSystem), after: formatValue(after, fmtAfter, true, dateSystem) };
  return exact.before !== exact.after ? exact : text;
}
