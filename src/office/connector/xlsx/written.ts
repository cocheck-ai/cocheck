import { createHash } from "node:crypto";
import { isCellError } from "./types.ts";
import { colToNum } from "./formula.ts";

/**
 * The one place CoCheck decides whether a cell holds what it wrote. Review attribution (the xlsx
 * layer's `explains`, which `fixed` resolutions also go through) asks `holds`, or compares
 * `cellHash`es of the same keys.
 *
 * Keys are typed. The observed side (the reader's value/formula pair, or an AppleScript read-back)
 * is taken exactly as stored and never coerced: text "7" is text, not the number 7. There are four
 * value types:
 *
 * - Blank: null, undefined and "" are one key.
 * - Number: compared at 15 significant digits, the precision Excel keeps; digits past that are
 *   float noise from the round trip (0.30000000000000004 in the file is 0.3).
 * - Boolean: by value.
 * - Text: exact, no trimming or case folding.
 * - Error (`CellError`, the reader's `t="e"`): by code, and never equal to text: a stored #N/A
 *   does not hold a written "#N/A".
 * - Formula: by `canonicalFormula`, Excel's stored spelling (see there), except that a this-row
 *   reference without a table name matches the same reference in any table (see `sameFormula`).
 *
 * The written side follows one rule: a written string goes raw only if Excel stores it as a
 * non-text value whose own display spelling is byte-identical to the string; everything else goes
 * as text (`textForm`, an apostrophe prefix Excel stores as text without showing it). Erring toward
 * text is always safe: the prefix on a string Excel would have kept as text anyway is harmless.
 * In practice that allows exactly two kinds of raw string:
 *
 * - "TRUE" and "FALSE", exactly: Excel's display spelling of the booleans it stores. "true",
 *   "False", "TRUE " go as text (observed live: "true" sent raw was stored as TRUE).
 * - `isExactNumber` strings: a plain decimal spelling in JS canonical form with at most 15
 *   significant digits, so the number Excel stores spells exactly the string ("10", "0.5", "-2").
 *
 * For those the stored number or boolean is the primary key, and the exact text is also accepted
 * (a cell formatted as Text keeps it as typed). Everything else, "hello", "#N/A" (observed live:
 * sent raw it was stored as the error), "00123", "1e3", "5%", "Mar 3", a leading apostrophe, is
 * keyed by its exact text only.
 *
 * `asText(s)` marks a string that must go as text even when the rule would send it raw: a
 * `write_range` rollback restoring a prior text "7" or "TRUE". It is keyed by its exact text only.
 */

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Whether Excel's stored number for `s` spells exactly `s`: a plain decimal in JS canonical form
 * (which rules out leading zeros, trailing fractional zeros, "+" and ".5") with at most 15
 * significant digits, leading zeros not counted and integer trailing zeros counted (conservative:
 * "100000000000000000000" goes as text though Excel would keep 1E+20 exactly).
 */
function isExactNumber(s: string): boolean {
  return PLAIN_DECIMAL.test(s) && String(Number(s)) === s && s.replace(/\D/g, "").replace(/^0+/, "").length <= 15;
}

/** "TRUE" or "FALSE" exactly: what Excel shows for the booleans it stores. */
function isBooleanSpelling(s: string): boolean {
  return s === "TRUE" || s === "FALSE";
}

/** A string that must be sent, and held, as text: see `asText`. */
export interface AsText {
  readonly asText: string;
}

/** Marks `s` to go as text unconditionally (a rollback restoring prior text). */
export function asText(s: string): AsText {
  return { asText: s };
}

function isAsText(v: unknown): v is AsText {
  return typeof v === "object" && v !== null && typeof (v as AsText).asText === "string";
}

/**
 * Whether a written string goes as text: everything but "", a formula, an `isExactNumber` string
 * and exact "TRUE"/"FALSE".
 */
export function needsTextForm(s: string): boolean {
  return !(s === "" || s.startsWith("=") || isExactNumber(s) || isBooleanSpelling(s));
}

/**
 * What to hand Excel for a written string: apostrophe-prefixed when `needsTextForm`, and always
 * for an `AsText` (unless empty, which is a blank either way).
 */
export function textForm(s: string | AsText): string {
  if (isAsText(s)) {
    return s.asText === "" ? "" : `'${s.asText}`;
  }
  return needsTextForm(s) ? `'${s}` : s;
}

function numberKey(n: number): string {
  const rounded = Number(n.toPrecision(15));
  return `n:${Object.is(rounded, -0) ? 0 : rounded}`;
}

/** The key of a typed cell value, taken as stored. */
function valueKey(v: unknown): string {
  if (v === null || v === undefined || v === "") {
    return "blank";
  }
  if (typeof v === "number") {
    return numberKey(v);
  }
  if (typeof v === "boolean") {
    return `b:${v}`;
  }
  if (isCellError(v)) {
    return `e:${v.error}`;
  }
  return `s:${String(v)}`;
}

/**
 * Every key a written literal may be stored under, primary (what Excel stores in a General cell)
 * first. A string starting with "=" is a formula.
 */
export function writtenKeys(v: unknown): string[] {
  if (isAsText(v)) {
    return [valueKey(v.asText)];
  }
  if (typeof v !== "string" || v === "") {
    return [valueKey(v)];
  }
  if (v.startsWith("=")) {
    return [`f:${canonicalFormula(v)}`];
  }
  if (isExactNumber(v)) {
    return [numberKey(Number(v)), valueKey(v)];
  }
  if (isBooleanSpelling(v)) {
    return [`b:${v === "TRUE"}`, valueKey(v)];
  }
  return [valueKey(v)];
}

/**
 * What `write_range` records for one written cell: the `cellHash` of its one key, or of each key
 * when it has several (numeric or TRUE/FALSE text).
 */
export function writtenHash(v: unknown): string | string[] {
  const keys = writtenKeys(v).map(cellHash);
  return keys.length === 1 ? keys[0]! : keys;
}

/**
 * Whether a cell observed as `value`/`formula` holds what a recorded `writtenHash` stands for. A
 * formula is also tried with its this-row table names dropped, so a recorded `[@Amount]` holds the
 * file's `Sales[[#This Row],[Amount]]`. Hashes can't do `sameFormula`'s per-reference match: a
 * written formula that names the table on some this-row references and not others only holds
 * when the stored one names the same tables on the same references (a false mismatch, never a
 * false match).
 */
export function holdsHash(recorded: unknown, value: unknown, formula: string | null | undefined): boolean {
  const keys = [observedKey(value, formula)];
  if (formula !== null && formula !== undefined) {
    keys.push(`f:${joinParts(formulaParts(formula), false)}`);
  }
  return keys.map(cellHash).some((observed) => (Array.isArray(recorded) ? recorded.includes(observed) : recorded === observed));
}

/** Key of a cell as observed: a formula cell by its formula, else by its value, never coerced. */
export function observedKey(value: unknown, formula: string | null | undefined): string {
  if (formula !== null && formula !== undefined) {
    return `f:${canonicalFormula(formula)}`;
  }
  return valueKey(value);
}

/** Whether a cell observed as `value`/`formula` holds the literal `written`. */
export function holds(written: unknown, value: unknown, formula: string | null | undefined): boolean {
  if (typeof written === "string" && written.startsWith("=") && formula !== null && formula !== undefined) {
    return sameFormula(written, formula);
  }
  return writtenKeys(written).includes(observedKey(value, formula));
}

/**
 * Compact per-key hash `write_range` records in the ledger instead of the raw values (dropped
 * from `args_json`): 16 hex chars (64 bits) of sha256 over the canonical key.
 */
export function cellHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

type Token =
  | { kind: "str"; text: string }
  | { kind: "sheet"; name: string }
  | { kind: "bracket"; text: string }
  | { kind: "word"; text: string }
  | { kind: "ws" }
  | { kind: "op"; text: string };

const WORD_CHAR = /[\p{L}\p{N}_.$\\?]/u;
const PREFIX = /^(?:_xlfn\.|_xlws\.|_xlpm\.)+/i;
const NUMBER_LITERAL = /^(\d+\.?\d*|\.\d+)(E[+-]?\d+)?$/i;

/** Splits formula text into string literals, sheet qualifiers, bracketed refs, words and operators. */
function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === '"') {
          if (body[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      tokens.push({ kind: "str", text: body.slice(i, j + 1) });
      i = j + 1;
    } else if (ch === "'") {
      let j = i + 1;
      let name = "";
      while (j < body.length) {
        if (body[j] === "'") {
          if (body[j + 1] === "'") {
            name += "'";
            j += 2;
            continue;
          }
          break;
        }
        name += body[j];
        j++;
      }
      // A quoted name is always a sheet qualifier; its "!" is part of it.
      i = body[j + 1] === "!" ? j + 2 : j + 1;
      tokens.push({ kind: "sheet", name });
    } else if (ch === "[") {
      // Structured refs nest brackets, and "'" escapes the next character inside them.
      let depth = 0;
      let j = i;
      while (j < body.length) {
        const c = body[j]!;
        if (c === "'") {
          j += 2;
          continue;
        }
        if (c === "[") depth++;
        if (c === "]" && --depth === 0) break;
        j++;
      }
      tokens.push({ kind: "bracket", text: body.slice(i, j + 1) });
      i = j + 1;
    } else if (/\s/.test(ch)) {
      let j = i;
      while (j < body.length && /\s/.test(body[j]!)) j++;
      tokens.push({ kind: "ws" });
      i = j;
    } else if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < body.length && WORD_CHAR.test(body[j]!)) j++;
      // A number's exponent sign ("1E+3") is part of the number, not an operator.
      if (/^(\d+\.?\d*|\.\d+)E$/i.test(body.slice(i, j)) && /[+-]\d/.test(body.slice(j, j + 2))) {
        j++;
        while (j < body.length && /\d/.test(body[j]!)) j++;
      }
      // An unquoted sheet qualifier, including a 3-D span "Sheet1:Sheet3!"; "#REF!" is an error.
      const span = /^:[\p{L}\p{N}_.]+(?=!)/u.exec(body.slice(j));
      if (span) {
        j += span[0].length;
      }
      if (body[j] === "!" && body[i - 1] !== "#") {
        tokens.push({ kind: "sheet", name: body.slice(i, j) });
        i = j + 1;
      } else {
        tokens.push({ kind: "word", text: body.slice(i, j) });
        i = j;
      }
    } else {
      tokens.push({ kind: "op", text: ch });
      i++;
    }
  }
  return tokens;
}

const CELL_REF = /^(\$?)([A-Z]{1,3})(\$?)(\d+)$/;
const COL_REF = /^(\$?)([A-Z]{1,3})$/;
const ROW_REF = /^(\$?)(\d+)$/;

/**
 * Case fold for what Excel compares case-insensitively in a formula (sheet names, defined and
 * function names, structured-ref columns): each character upper-cased alone, and kept as is when
 * its upper case is more than one character. Whole-string `toUpperCase` applies full case mapping
 * ("ß" -> "SS"), which Excel does not do: 'Straße' and 'STRASSE' are different sheets. Not
 * `toLocaleUpperCase`, so the result doesn't depend on the host locale (Turkish dotted i).
 * UNCERTAIN, not checked live: whether Excel equates "ß" with capital "ẞ"; here they differ.
 */
function foldCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += [...up].length === 1 ? up : ch;
  }
  return out;
}

/**
 * `a:b` as Excel stores it, top-left first: each axis is ordered independently, carrying its "$"
 * with it (`C9:C7` -> `C7:C9`, `B:A` -> `A:B`, `9:7` -> `7:9`). Undefined when not a range.
 */
function orderedRange(a: string, b: string): [string, string] | undefined {
  const ca = CELL_REF.exec(a);
  const cb = CELL_REF.exec(b);
  if (ca && cb) {
    const [colA, colB] = colToNum(ca[2]!) <= colToNum(cb[2]!) ? [ca, cb] : [cb, ca];
    const [rowA, rowB] = Number(ca[4]) <= Number(cb[4]) ? [ca, cb] : [cb, ca];
    return [`${colA[1]}${colA[2]}${rowA[3]}${rowA[4]}`, `${colB[1]}${colB[2]}${rowB[3]}${rowB[4]}`];
  }
  const xa = COL_REF.exec(a);
  const xb = COL_REF.exec(b);
  if (xa && xb) {
    return colToNum(xa[2]!) <= colToNum(xb[2]!) ? [a, b] : [b, a];
  }
  const ra = ROW_REF.exec(a);
  const rb = ROW_REF.exec(b);
  if (ra && rb) {
    return Number(ra[2]) <= Number(rb[2]) ? [a, b] : [b, a];
  }
  return undefined;
}

const THIS_ROW_COLUMN = [/^\[@\[(.*)\]\]$/s, /^\[@([^[\]]+)\]$/s, /^\[\[#This Row\],\s*\[(.*)\]\]$/is];
const THIS_ROW_WHOLE = /^(?:\[@\]|\[#This Row\]|\[\[#This Row\]\])$/i;

/**
 * A this-row structured reference in one spelling, without its table name: a column
 * (`[@Col]`, `[@[Col]]`, `[[#This Row],[Col]]`) is `[@[COL]]`, the whole row (`[@]`,
 * `[#This Row]`, `[[#This Row]]`) is `[#THIS ROW]`. Undefined when not a this-row reference.
 */
function thisRowRef(bracket: string): string | undefined {
  if (THIS_ROW_WHOLE.test(bracket)) return "[#THIS ROW]";
  for (const re of THIS_ROW_COLUMN) {
    const m = re.exec(bracket);
    if (m) return `[@[${foldCase(m[1]!)}]]`;
  }
  return undefined;
}

/** A canonical this-row reference and the table it names ("" when unqualified). */
interface ThisRow {
  table: string;
  ref: string;
}

type Part = string | ThisRow;

function joinParts(parts: Part[], withTables: boolean): string {
  return parts.map((p) => (typeof p === "string" ? p : withTables ? p.table + p.ref : p.ref)).join("");
}

/**
 * Whether two formulas are the same in Excel's stored spelling (`canonicalFormula`), except that a
 * this-row reference without a table name matches the same reference in any table: `[@Amount]`
 * matches `Sales[[#This Row],[Amount]]` and `Costs[@Amount]`, which don't match each other. Excel's
 * AppleScript read-back gives the bare shorthand for a reference to the cell's own table, and the
 * file always names the table, so neither side can be required to.
 */
export function sameFormula(a: string, b: string): boolean {
  const pa = formulaParts(a);
  const pb = formulaParts(b);
  return (
    pa.length === pb.length &&
    pa.every((x, i) => {
      const y = pb[i]!;
      if (typeof x === "string" || typeof y === "string") return x === y;
      return x.ref === y.ref && (x.table === "" || y.table === "" || x.table === y.table);
    })
  );
}

/** Whether a token can end (`side` "left") or start ("right") an operand, for the space operator. */
function operandEdge(t: Token | undefined, side: "left" | "right"): boolean {
  if (!t || t.kind === "ws") return false;
  if (t.kind === "op") return side === "left" ? t.text === ")" : t.text === "(";
  if (t.kind === "sheet") return side === "right";
  return true;
}

/**
 * Formula text in Excel's stored spelling, so the text written, the AppleScript read-back and the
 * file's `<f>` compare equal when Excel stored what was written:
 *
 * - leading "=" dropped (the file stores none);
 * - `_xlfn.`/`_xlws.`/`_xlpm.` prefixes dropped (the file has them on newer functions, the
 *   read-back doesn't: live on Excel 16.113, `XLOOKUP` read back bare, saved as `_xlfn.XLOOKUP`);
 * - words (function names, references, names) case-folded (`foldCase`);
 * - number literals by value at 15 digits (`.5` and `0.50` are `0.5`);
 * - sheet qualifiers quoted or not alike (`'Inputs'!` is `Inputs!`), case-folded (Excel sheet
 *   names are case-insensitive), with their inner whitespace kept (`'Q1 Plan'` is not `'Q1Plan'`);
 * - ranges ordered top-left first (`C9:C7` is `C7:C9`);
 * - whitespace dropped, except one space between two operands (Excel's intersection operator).
 *
 * - bracketed structured references case-folded: Excel respells `Table1[amount]` to the header's
 *   case, `Table1[Amount]`;
 * - this-row references in one spelling: `[@Col]`, `[@[Col Name]]` and `[[#This Row],[Col]]` are
 *   `[@[COL]]`, and `[@]`, `[#This Row]` and `[[#This Row]]` are `[#THIS ROW]`, each after its
 *   case-folded table name if it has one (`Sales[@Amount]` is `SALES[@[AMOUNT]]`, not
 *   `COSTS[@[AMOUNT]]`). The shorthand without a table name Excel reads back is `[@[AMOUNT]]`;
 *   `holds` and `holdsHash` match it against any table (see `sameFormula`);
 * - spill references in one spelling: `A1#` is the file's `_xlfn.ANCHORARRAY(A1)`, sheet
 *   qualifier included.
 *
 * The this-row and spill file spellings are the ones expected from Excel's file format; they still need a live check.
 *
 * String literals are kept verbatim.
 */
export function canonicalFormula(text: string): string {
  return joinParts(formulaParts(text), true);
}

/** `canonicalFormula` as parts, each this-row reference kept apart with its table. */
function formulaParts(text: string): Part[] {
  const body = text.startsWith("=") ? text.slice(1) : text;
  const tokens = tokenize(body);
  const out: Part[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.kind) {
      case "str":
        out.push(t.text);
        break;
      case "bracket": {
        const ref = thisRowRef(t.text);
        if (ref === undefined) {
          out.push(foldCase(t.text));
          break;
        }
        const table = tokens[i - 1]?.kind === "word" ? (out.pop() as string) : "";
        out.push({ table, ref });
        break;
      }
      case "sheet":
        out.push(`'${foldCase(t.name).replace(/'/g, "''")}'!`);
        break;
      case "op":
        out.push(t.text);
        break;
      case "ws":
        if (operandEdge(tokens[i - 1], "left") && operandEdge(tokens[i + 1], "right")) {
          out.push(" ");
        }
        break;
      case "word": {
        const word = t.text.replace(PREFIX, "");
        const next = tokens[i + 1];
        if (next?.kind === "op" && next.text === "#" && CELL_REF.test(foldCase(word))) {
          const sheet = tokens[i - 1]?.kind === "sheet" ? (out.pop() as string) : "";
          out.push(`ANCHORARRAY(${sheet}${foldCase(word)})`);
          i++;
          break;
        }
        out.push(NUMBER_LITERAL.test(word) ? String(Number(Number(word).toPrecision(15))) : foldCase(word));
        break;
      }
    }
  }
  // Order `ref:ref` ranges; `out` holds one entry per non-dropped token, so ":" sits between its operands.
  for (let i = 1; i + 1 < out.length; i++) {
    const [a, b] = [out[i - 1], out[i + 1]];
    if (out[i] === ":" && typeof a === "string" && typeof b === "string") {
      const ordered = orderedRange(a, b);
      if (ordered) {
        [out[i - 1], out[i + 1]] = ordered;
        i++;
      }
    }
  }
  return out;
}
