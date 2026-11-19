/**
 * Cell-reference arithmetic for formula text: shifting a formula by a row/column delta (used
 * to expand shared formulas from their master cell, and to detect that a formula only changed
 * because the row it lives on shifted) and normalizing a formula to a signature relative to its
 * own cell (used by the diff's row-alignment step to tell "shifted, unchanged" from "actually
 * edited").
 *
 * Reference handling:
 * - Unqualified refs (`A1`, `$A$1`, `B2:C9`) are always treated as local to the formula's own
 *   sheet and shifted/normalized.
 * - Sheet-qualified refs (`Sheet2!A1`, `'My Sheet'!$B$3`) are left untouched UNLESS the caller
 *   passes `ownSheetName` and it matches the qualifier - a ref to another sheet doesn't move
 *   when *this* sheet's rows shift, so touching it would be a bug, not a feature.
 * - Refs inside double-quoted string literals (`="A1"`, `CONCATENATE("A1", B2)`) are never
 *   touched - the `A1` there is text, not a reference.
 *
 * Whole-row (`3:3`, `$3:$3`, `3:5`) and whole-column (`A:A`, `$A:$A`, `A:C`) references are
 * recognized alongside single-cell refs: each side of the range is shifted/normalized
 * independently (row deltas only for row ranges, column deltas only for column ranges), with the
 * same sheet-qualifier and string-literal rules as single-cell refs.
 *
 * Known gaps: defined names aren't recognized as such (a bare name that happens to look like a
 * cell reference in a foreign-sheet-qualified position is still just skipped as "foreign",
 * which is safe); sheet-name matching is case-sensitive (Excel's isn't).
 */

/** A bare (unqualified) sheet name: letters/digits/underscore/dot, no leading digit required by us - good enough since Excel enforces its own naming rules upstream. */
const BARE_SHEET_NAME = `[A-Za-z_][A-Za-z0-9_.]*`;
/** A single-quoted sheet name, with `''` as the escape for a literal quote inside it. */
const QUOTED_SHEET_NAME = `'(?:[^']|'')*'`;

/**
 * Optional `Sheet1!` / `'My Sheet'!` qualifier (named group `q`, captured without the trailing
 * `!`), then one of: a single-cell ref, a whole-row range (`3:3`), or a whole-column range
 * (`A:A`) - each alternative uses its own named groups so the replace callback can tell which
 * shape matched.
 */
const REF_RE = new RegExp(
  `(?:(?<q>${QUOTED_SHEET_NAME}|${BARE_SHEET_NAME})!)?` +
    `(?:` +
    `(?<cellDCol>\\$?)(?<cellCol>[A-Z]{1,3})(?<cellDRow>\\$?)(?<cellRow>[0-9]+)` +
    `|(?<rowD1>\\$?)(?<row1>[0-9]+):(?<rowD2>\\$?)(?<row2>[0-9]+)` +
    `|(?<colD1>\\$?)(?<col1>[A-Z]{1,3}):(?<colD2>\\$?)(?<col2>[A-Z]{1,3})` +
    `)`,
  "g",
);

export function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

export function numToCol(num: number): string {
  let n = num;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function isRefBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = text[index - 1];
  return !/[A-Za-z0-9_]/.test(prev!);
}

/**
 * A match like `LOG10` at the very start of a formula (or right after an operator) passes the
 * leading-boundary check the same way a genuine 3-letter-column reference like `AAA1` would -
 * there's no character before it to disambiguate. The tell is what comes *after*: a cell
 * reference is never immediately followed by `(`, but a function call always is (`LOG10(`,
 * `SUM(`). Reject the match in that case so it's left as plain formula text.
 */
function isFunctionCall(text: string, matchEnd: number): boolean {
  return text[matchEnd] === "(";
}

function unquoteSheetName(raw: string): string {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

interface CellRefParts {
  kind: "cell";
  /** The original qualifier text plus `!`, or `""` for an unqualified (local) ref - prepend verbatim to the rebuilt ref. */
  qualifierPrefix: string;
  dollarCol: string;
  colLetters: string;
  dollarRow: string;
  rowDigits: string;
  /**
   * For the unqualified end of a qualified range (`D1` in `Sheet2!C1:D1`), the range's
   * qualifier (unquoted): that end points into the same sheet as the start, not the formula's own.
   */
  rangeSheet?: string;
}
interface RowRangeParts {
  kind: "rowRange";
  qualifierPrefix: string;
  dollar1: string;
  row1: string;
  dollar2: string;
  row2: string;
}
interface ColRangeParts {
  kind: "colRange";
  qualifierPrefix: string;
  dollar1: string;
  col1: string;
  dollar2: string;
  col2: string;
}
type RefParts = CellRefParts | RowRangeParts | ColRangeParts;

/**
 * Walks `formula` outside of any double-quoted string literal, rewriting each reference (a
 * single cell, or a whole-row/whole-column range) `build` should touch - a local ref, or one
 * qualified with `ownSheetName` - and leaving every other reference - foreign-sheet-qualified, or
 * any qualified ref when `ownSheetName` isn't given - untouched.
 */
function transformFormula(formula: string, ownSheetName: string | undefined, build: (parts: RefParts) => string, includeForeign = false): string {
  if (!formula.includes('"')) return transformSegment(formula, ownSheetName, build, includeForeign);
  return splitOutsideStrings(formula)
    .map((seg) => (seg.isString ? seg.text : transformSegment(seg.text, ownSheetName, build, includeForeign)))
    .join("");
}

function transformSegment(text: string, ownSheetName: string | undefined, build: (parts: RefParts) => string, includeForeign: boolean): string {
  // The qualifier and end offset of the last qualified single-cell ref, so the unqualified end of
  // `Sheet2!C1:D1` can be told apart from a genuinely local ref.
  let lastQualified: { qualifier: string; end: number } | undefined;
  return text.replace(REF_RE, (match: string, ...rest: unknown[]) => {
    // REF_RE has named groups, so the callback's trailing arguments are always (offset, string, groups).
    const offset = rest[rest.length - 3] as number;
    const groups = rest[rest.length - 1] as Record<string, string | undefined>;
    if (!isRefBoundary(text, offset)) return match;

    const qualifier = groups.q;
    const rangeSheet =
      qualifier === undefined && lastQualified !== undefined && lastQualified.end === offset - 1 && text[offset - 1] === ":"
        ? unquoteSheetName(lastQualified.qualifier)
        : undefined;
    lastQualified = qualifier !== undefined && groups.cellCol !== undefined ? { qualifier, end: offset + match.length } : undefined;
    const qualifierPrefix = qualifier === undefined ? "" : `${qualifier}!`;
    const isForeign = !includeForeign && qualifier !== undefined && (ownSheetName === undefined || unquoteSheetName(qualifier) !== ownSheetName);

    if (groups.cellCol !== undefined) {
      if (isFunctionCall(text, offset + match.length)) return match; // function name, not a ref
      if (isForeign) return match;
      return build({
        kind: "cell",
        qualifierPrefix,
        dollarCol: groups.cellDCol!,
        colLetters: groups.cellCol!,
        dollarRow: groups.cellDRow!,
        rowDigits: groups.cellRow!,
        ...(rangeSheet !== undefined ? { rangeSheet } : {}),
      });
    }
    if (groups.row1 !== undefined) {
      if (isForeign) return match;
      return build({
        kind: "rowRange",
        qualifierPrefix,
        dollar1: groups.rowD1!,
        row1: groups.row1!,
        dollar2: groups.rowD2!,
        row2: groups.row2!,
      });
    }
    // groups.col1 !== undefined
    if (isForeign) return match;
    return build({
      kind: "colRange",
      qualifierPrefix,
      dollar1: groups.colD1!,
      col1: groups.col1!,
      dollar2: groups.colD2!,
      col2: groups.col2!,
    });
  });
}

/** Splits `formula` into alternating outside/inside-string-literal segments so ref rewriting never touches text inside `"..."`. `""` inside a string is Excel's escape for a literal quote. */
function splitOutsideStrings(formula: string): Array<{ text: string; isString: boolean }> {
  const segments: Array<{ text: string; isString: boolean }> = [];
  let i = 0;
  let bufStart = 0;
  while (i < formula.length) {
    if (formula[i] === '"') {
      if (i > bufStart) segments.push({ text: formula.slice(bufStart, i), isString: false });
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      segments.push({ text: formula.slice(i, j), isString: true });
      i = j;
      bufStart = j;
      continue;
    }
    i += 1;
  }
  if (bufStart < formula.length) segments.push({ text: formula.slice(bufStart), isString: false });
  return segments;
}

/**
 * Rewrites every row number in `formula` - local refs and refs qualified with any sheet, `$`
 * or not, since an inserted/deleted row moves absolute refs too - through `mapRow(sheetName,
 * row)`. `sheetName` is the ref's target sheet (its qualifier, or `ownSheetName` when unqualified).
 * Columns are left alone. This mirrors what Excel does to formula text on a row insert/delete.
 * `spanPreserved` is false when any range (`A1:A9`, `3:5`) would cover a different number of rows
 * after the mapping - an insert inside a range grows it, which is a real change to what the
 * formula covers, not a pure shift.
 */
export function remapFormulaRows(
  formula: string,
  ownSheetName: string,
  mapRow: (sheetName: string, row: number) => number,
): { text: string; spanPreserved: boolean } {
  return remapFormulaRefs(formula, ownSheetName, mapRow, (_sheet, col) => col);
}

/**
 * `remapFormulaRows` for rows and columns at once: every row number goes through `mapRow` and
 * every column through `mapCol` (1-based column numbers), each keyed by the ref's target sheet.
 * Whole-row ranges map rows only, whole-column ranges columns only. `spanPreserved` is false when
 * any range would cover a different number of rows or columns after the mapping.
 */
export function remapFormulaRefs(
  formula: string,
  ownSheetName: string,
  mapRow: (sheetName: string, row: number) => number,
  mapCol: (sheetName: string, col: number) => number,
): { text: string; spanPreserved: boolean } {
  let spanPreserved = true;
  const sheetOf = (prefix: string): string => (prefix === "" ? ownSheetName : unquoteSheetName(prefix.slice(0, -1)));
  const text = transformFormula(
    formula,
    ownSheetName,
    (parts) => {
      if (parts.kind === "cell") {
        const { qualifierPrefix, dollarCol, colLetters, dollarRow, rowDigits } = parts;
        const sheet = parts.rangeSheet ?? sheetOf(qualifierPrefix);
        return `${qualifierPrefix}${dollarCol}${numToCol(mapCol(sheet, colToNum(colLetters)))}${dollarRow}${mapRow(sheet, Number(rowDigits))}`;
      }
      if (parts.kind === "rowRange") {
        const { qualifierPrefix, dollar1, row1, dollar2, row2 } = parts;
        const sheet = sheetOf(qualifierPrefix);
        const m1 = mapRow(sheet, Number(row1));
        const m2 = mapRow(sheet, Number(row2));
        if (m2 - m1 !== Number(row2) - Number(row1)) spanPreserved = false;
        return `${qualifierPrefix}${dollar1}${m1}:${dollar2}${m2}`;
      }
      const { qualifierPrefix, dollar1, col1, dollar2, col2 } = parts;
      const sheet = sheetOf(qualifierPrefix);
      const c1 = colToNum(col1);
      const c2 = colToNum(col2);
      const m1 = mapCol(sheet, c1);
      const m2 = mapCol(sheet, c2);
      if (m2 - m1 !== c2 - c1) spanPreserved = false;
      return `${qualifierPrefix}${dollar1}${numToCol(m1)}:${dollar2}${numToCol(m2)}`;
    },
    true,
  );
  // Cell-to-cell ranges (`D2:D4`) match as two separate cell refs above, so check their spans here.
  const rangeRe = new RegExp(`(?:(${QUOTED_SHEET_NAME}|${BARE_SHEET_NAME})!)?\\$?([A-Z]{1,3})\\$?([0-9]+):\\$?([A-Z]{1,3})\\$?([0-9]+)`, "g");
  for (const seg of splitOutsideStrings(formula)) {
    if (seg.isString) continue;
    for (const m of seg.text.matchAll(rangeRe)) {
      const sheet = m[1] === undefined ? ownSheetName : unquoteSheetName(m[1]);
      const c1 = colToNum(m[2]!);
      const r1 = Number(m[3]);
      const c2 = colToNum(m[4]!);
      const r2 = Number(m[5]);
      if (mapRow(sheet, r2) - mapRow(sheet, r1) !== r2 - r1) spanPreserved = false;
      if (mapCol(sheet, c2) - mapCol(sheet, c1) !== c2 - c1) spanPreserved = false;
    }
  }
  return { text, spanPreserved };
}

/**
 * Shifts every relative (non-`$`) reference component in `formula` by `dCol`/`dRow`. Used to
 * expand a shared formula's master text into the text a follower cell would show, and to
 * translate a formula when the rows above it shift (insert/delete). `ownSheetName`, when given,
 * lets a same-sheet-qualified ref (`Sheet1!A1` written on Sheet1 itself) be shifted like a local
 * one; omit it to leave every qualified ref untouched. `includeForeign` shifts every qualified ref
 * too, which is what expanding a shared formula needs: a fill-down of `=Data!B1*2` reads `Data!B2*2`.
 */
export function shiftFormula(formula: string, dCol: number, dRow: number, ownSheetName?: string, includeForeign = false): string {
  return transformFormula(formula, ownSheetName, (parts) => {
    if (parts.kind === "cell") {
      const { qualifierPrefix, dollarCol, colLetters, dollarRow, rowDigits } = parts;
      const newCol = dollarCol ? colLetters : numToCol(colToNum(colLetters) + dCol);
      const newRow = dollarRow ? rowDigits : String(Number(rowDigits) + dRow);
      return `${qualifierPrefix}${dollarCol}${newCol}${dollarRow}${newRow}`;
    }
    if (parts.kind === "rowRange") {
      const { qualifierPrefix, dollar1, row1, dollar2, row2 } = parts;
      const newRow1 = dollar1 ? row1 : String(Number(row1) + dRow);
      const newRow2 = dollar2 ? row2 : String(Number(row2) + dRow);
      return `${qualifierPrefix}${dollar1}${newRow1}:${dollar2}${newRow2}`;
    }
    const { qualifierPrefix, dollar1, col1, dollar2, col2 } = parts;
    const newCol1 = dollar1 ? col1 : numToCol(colToNum(col1) + dCol);
    const newCol2 = dollar2 ? col2 : numToCol(colToNum(col2) + dCol);
    return `${qualifierPrefix}${dollar1}${newCol1}:${dollar2}${newCol2}`;
  }, includeForeign);
}

/**
 * Rewrites `formula` (which lives at `originAddress`) into an R1C1-relative signature: each
 * local reference becomes `R[dRow]C[dCol]` relative to the origin cell, with absolute (`$`)
 * components rendered as a fixed `R<row>C<col>`. Two formulas that differ only by a uniform
 * row/column shift produce identical signatures; a formula whose range genuinely grew or
 * shrunk does not. See `shiftFormula` for what `ownSheetName` does to qualified refs. Foreign-sheet
 * refs stay literal A1 text unless `includeForeign` is set, which makes them relative too (for
 * judging a copied-across formula whose inputs sit on another sheet, e.g. `Assumptions!E18`).
 */
export function toRelativeSignature(formula: string, originAddress: string, ownSheetName?: string, includeForeign = false): string {
  const origin = parseAddress(originAddress);
  return transformFormula(formula, ownSheetName, (parts) => {
    if (parts.kind === "cell") {
      const { qualifierPrefix, dollarCol, colLetters, dollarRow, rowDigits } = parts;
      const col = colToNum(colLetters);
      const row = Number(rowDigits);
      const colPart = dollarCol ? `C${col}` : `C[${col - origin.col}]`;
      const rowPart = dollarRow ? `R${row}` : `R[${row - origin.row}]`;
      return `${qualifierPrefix}${rowPart}${colPart}`;
    }
    if (parts.kind === "rowRange") {
      const { qualifierPrefix, dollar1, row1, dollar2, row2 } = parts;
      const r1 = Number(row1);
      const r2 = Number(row2);
      const part1 = dollar1 ? `R${r1}` : `R[${r1 - origin.row}]`;
      const part2 = dollar2 ? `R${r2}` : `R[${r2 - origin.row}]`;
      return `${qualifierPrefix}${part1}:${part2}`;
    }
    const { qualifierPrefix, dollar1, col1, dollar2, col2 } = parts;
    const c1 = colToNum(col1);
    const c2 = colToNum(col2);
    const part1 = dollar1 ? `C${c1}` : `C[${c1 - origin.col}]`;
    const part2 = dollar2 ? `C${c2}` : `C[${c2 - origin.col}]`;
    return `${qualifierPrefix}${part1}:${part2}`;
  }, includeForeign);
}

/**
 * A `toRelativeSignature` result with every local reference's column part dropped (`R[0]C[-1]`
 * becomes `R[0]C`, `C[1]:C3` becomes `C:C`), so a formula whose refs only moved sideways with a
 * column insert/delete - including one whose refs cross the inserted column - keeps its
 * signature. Foreign-sheet refs are literal A1 text in a signature and are left as they are.
 */
export function withoutColumns(signature: string): string {
  return signature.replace(/(R(?:\[-?\d+\]|\d+))C(?:\[-?\d+\]|\d+)/g, "$1C").replace(/C(?:\[-?\d+\]|\d+):C(?:\[-?\d+\]|\d+)/g, "C:C");
}

export function parseAddress(address: string): { col: number; row: number } {
  const match = /^([A-Z]{1,3})([0-9]+)$/.exec(address);
  if (!match) {
    throw new Error(`not a cell address: ${address}`);
  }
  return { col: colToNum(match[1]!), row: Number(match[2]) };
}

/** A rectangle of cells a formula refers to: one cell, a range, or a whole row/column (bounded by the sheet's maximum). */
export interface FormulaRef {
  /** The target sheet, unquoted: the ref's qualifier, or the formula's own sheet when unqualified. */
  sheet: string;
  c1: number;
  r1: number;
  c2: number;
  r2: number;
}

const MAX_ROW = 1048576;
const MAX_COL = 16384;

/**
 * Every reference `formula` makes, with ranges (`A1:B5`, `Sheet2!C1:D4`) read as one region and
 * whole-row/whole-column refs bounded by the sheet's size. Same string-literal, boundary and
 * function-name rules as the shift logic above.
 *
 * `unresolved` is true when the formula also depends on something this can't resolve to cells:
 * a defined name (or any bare identifier), `INDIRECT`/`OFFSET`, a table or external-workbook ref
 * (`Table1[Col]`, `[1]Sheet!A1`), a spill ref (`A1#`), or a 3-D ref (`Sheet1:Sheet3!A1`). The refs
 * returned are then only part of what the formula reads.
 */
export function extractFormulaRefs(formula: string, ownSheetName: string): { refs: FormulaRef[]; unresolved: boolean } {
  const refs: FormulaRef[] = [];
  let unresolved = false;
  for (const seg of splitOutsideStrings(formula)) {
    if (seg.isString) continue;
    const text = seg.text;
    let blank = text;
    const blankOut = (start: number, end: number): void => {
      blank = blank.slice(0, start) + " ".repeat(end - start) + blank.slice(end);
    };
    const valid: Array<{ m: RegExpMatchArray; start: number; end: number }> = [];
    for (const m of text.matchAll(REF_RE)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!isRefBoundary(text, start)) continue;
      if (m.groups!.cellCol !== undefined && isFunctionCall(text, end)) continue;
      valid.push({ m, start, end });
    }
    for (let i = 0; i < valid.length; i++) {
      const { m, start, end } = valid[i]!;
      const g = m.groups!;
      const sheet = g.q !== undefined ? unquoteSheetName(g.q) : ownSheetName;
      let endAt = end;
      if (g.cellCol !== undefined) {
        const c1 = colToNum(g.cellCol);
        const r1 = Number(g.cellRow);
        const next = valid[i + 1];
        if (next !== undefined && next.start === end + 1 && text[end] === ":" && next.m.groups!.cellCol !== undefined && next.m.groups!.q === undefined) {
          const c2 = colToNum(next.m.groups!.cellCol);
          const r2 = Number(next.m.groups!.cellRow);
          refs.push({ sheet, c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) });
          endAt = next.end;
          i++;
        } else {
          refs.push({ sheet, c1, r1, c2: c1, r2: r1 });
        }
      } else if (g.row1 !== undefined) {
        const a = Number(g.row1);
        const b = Number(g.row2);
        refs.push({ sheet, c1: 1, r1: Math.min(a, b), c2: MAX_COL, r2: Math.max(a, b) });
      } else {
        const a = colToNum(g.col1!);
        const b = colToNum(g.col2!);
        refs.push({ sheet, c1: Math.min(a, b), r1: 1, c2: Math.max(a, b), r2: MAX_ROW });
      }
      blankOut(start, endAt);
    }
    // What's left is operators, numbers, error literals and anything the ref scan couldn't place.
    const rest = blank.replace(/#[A-Z0-9/?]+[!?]?/g, " ");
    if (/[#[\]]/.test(rest)) unresolved = true;
    for (const m of rest.matchAll(/(?<![A-Za-z0-9_.$])[A-Za-z_][A-Za-z0-9_.]*/g)) {
      const after = rest.slice(m.index! + m[0].length).trimStart();
      const word = m[0].toUpperCase();
      if (after.startsWith("(")) {
        if (word === "INDIRECT" || word === "OFFSET") unresolved = true;
      } else if (word !== "TRUE" && word !== "FALSE") {
        unresolved = true;
      }
    }
  }
  return { refs, unresolved };
}
