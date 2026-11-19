/**
 * Format-neutral shapes shared by every reader/diff pair (xlsx today, pptx/docx later).
 * A format's reader module produces a `WorkbookSnapshot`; a format's diff module turns two
 * snapshots into `DiffRow[]`. Nothing in here is xlsx-specific - sheet/cell language is generic
 * enough to cover "slide/shape" or "page/paragraph" later without renaming these fields.
 */

/**
 * An error value (`<c t="e">`), e.g. `{ error: "#N/A" }`: a fourth value type beside number,
 * boolean and text, so an error never compares equal to text that spells the same. Always built
 * by `cellError`, which interns one frozen object per code, so `===` compares errors by code.
 */
export interface CellError {
  readonly error: string;
}

const CELL_ERRORS = new Map<string, CellError>();

/** The one `CellError` for `code`. */
export function cellError(code: string): CellError {
  let e = CELL_ERRORS.get(code);
  if (e === undefined) {
    e = Object.freeze({ error: code });
    CELL_ERRORS.set(code, e);
  }
  return e;
}

/** Whether `v` is a `CellError`. */
export function isCellError(v: unknown): v is CellError {
  return typeof v === "object" && v !== null && typeof (v as CellError).error === "string";
}

/** A cell value: text, number, boolean, error, or `null` for blank. */
export type CellValue = string | number | boolean | CellError | null;

/** A single cell's resolved state at the moment a snapshot was taken. */
export interface CellSnapshot {
  /** Column-row address, e.g. "B3". Always uppercase, no sheet qualifier. */
  address: string;
  /**
   * The value a viewer sees: the literal for a non-formula cell, or the cached last-calculated
   * result for a formula cell. `null` means the cell is blank (no `<v>`). An error is a
   * `CellError`, never its text.
   */
  value: CellValue;
  /**
   * Formula text without the leading "=", or `null` if the cell isn't a formula. Shared
   * formulas (`<f t="shared">`) are expanded to their per-cell text here - callers never see
   * the compact shared form.
   */
  formula: string | null;
  /** Resolved number format code, e.g. `"General"` or `"$"#,##0.00"`. Never a bare numFmtId. */
  numFmt: string;
}

/** One sheet's cells, keyed by address for O(1) lookup during diffing. */
export interface SheetSnapshot {
  name: string;
  cells: Map<string, CellSnapshot>;
  /** The sheet's state in the file; absent means visible. */
  state?: "hidden" | "veryHidden";
}

/** Excel's two date systems: serial 1 is 1900-01-01 or 1904-01-02. */
export type DateSystem = 1900 | 1904;

export interface WorkbookSnapshot {
  sheets: SheetSnapshot[];
  /** The workbook's date system (absent means 1900): 1904 when `<workbookPr date1904>` is on, else 1900. Decides what a date serial means. */
  dateSystem?: DateSystem;
}

/**
 * `value`   - a cell's displayed/cached value changed (including a formula cell's cached
 *              result changing because inputs elsewhere moved, even though its own formula
 *              text didn't change) or its number format changed.
 * `formula` - a cell's formula text changed in a way that isn't explained by a row/column
 *              shift already reported as a `structure` row (e.g. a range endpoint grew).
 * `structure` - rows were inserted or deleted. `cell` holds a range like `"3:3"`. Rows added
 *              below the sheet's previous last row are not an insertion and are reported only as
 *              their new cells. A formula whose text changed solely because a row insert/delete
 *              (in any sheet) moved its references, with no range changing size, is not reported
 *              at all; its value/number-format changes, if any, still show as `value`.
 */
export type DiffKind = "value" | "formula" | "structure";

export interface DiffRow {
  sheet: string;
  /** Cell address (e.g. "D5") for `value`/`formula` rows; a row-range token (e.g. "3:3") for `structure` rows. */
  cell: string;
  kind: DiffKind;
  valueBefore?: CellValue;
  valueAfter?: CellValue;
  formulaBefore?: string | null;
  formulaAfter?: string | null;
  numFmtBefore?: string;
  numFmtAfter?: string;
  /** Set by the xlsx layer on rows of a 1904-system workbook only; the review page reads dates with it. */
  dateSystem?: DateSystem;
  /**
   * On a `formula` row whose cell moved with a row/column shift: the text Excel's shift alone would
   * have left (`formulaBefore` with its refs moved), so a hand edit on top reads against it.
   */
  expectedFormulaAfterShift?: string;
  /** Human-readable context for `structure` rows (e.g. "row inserted") or other non-obvious rows. */
  note?: string;
}
