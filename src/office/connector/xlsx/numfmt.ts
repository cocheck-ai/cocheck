/**
 * Excel number formats: the text a cell shows for a number under a format code, so the grid and the notes quote what Excel
 * quotes. Pure functions, no I/O except `systemLocale()`, which reads the Mac's region once.
 *
 * The rule that shapes everything here: a value is never shown in a wrong format. Anything this module cannot render exactly (a
 * condition on a negative number, an era or Buddhist-calendar code, a locale-dependent built-in with no known code, a date outside
 * Excel's range, ...) comes back with `exact: false` and the stored value as the text. It never guesses.
 *
 * Rounding follows Excel: the value is first cut to 15 significant digits (so 2.675 is 2.675, not 2.67499999...), then rounded half
 * away from zero in decimal. All digit work is on BigInt decimals, never on binary floats.
 */

export type DateSystem = 1900 | 1904;

export interface LocaleSpec {
  decimal: string;
  group: string;
  monthsLong: string[];
  monthsShort: string[];
  /** Sunday first. */
  daysLong: string[];
  daysShort: string[];
  /** The system short date as an Excel pattern, e.g. "m/d/yyyy" (US), "dd/mm/yyyy" (GB), "dd.mm.yyyy" (DE). Built-in id 14. */
  shortDate: string;
}

export interface FormatContext {
  dateSystem?: DateSystem;
  locale?: LocaleSpec;
}

export interface Shown {
  /** What the cell shows; the stored value as plain text when `exact` is false. */
  text: string;
  /** False when this module could not render the code exactly and `text` is the stored value (the "shown unformatted" case). */
  exact: boolean;
  /** True when the displayed text drops part of the stored value (rounding, hidden time of day, hidden date, ...). */
  lossy: boolean;
}

/** Codes CoCheck gives to the built-ins whose pattern is the Mac's region setting, so a code is never mistaken for a custom one. */
export const SYSTEM_SHORT_DATE = "system short date";
export const SYSTEM_SHORT_DATE_TIME = "system short date h:mm";

/** ECMA-376 18.8.30 built-ins with a fixed code, plus the en-US forms of the accounting ids 41-44. Ids 14 and 22 are the system short date. */
const BUILTIN: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
  5: '"$"#,##0_);\\("$"#,##0\\)', 6: '"$"#,##0_);[Red]\\("$"#,##0\\)', 7: '"$"#,##0.00_);\\("$"#,##0.00\\)', 8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: SYSTEM_SHORT_DATE, 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
  22: SYSTEM_SHORT_DATE_TIME,
  37: "#,##0_);(#,##0)", 38: "#,##0_);[Red](#,##0)", 39: "#,##0.00_);(#,##0.00)", 40: "#,##0.00_);[Red](#,##0.00)",
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
};

/** The code of a built-in number format id, or null when the id is locale-dependent with no code CoCheck can state (23-36, 50-58, unknown). */
export function builtinCode(id: number): string | null {
  return BUILTIN[id] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Locale

const pad2 = (n: number): string => String(n).padStart(2, "0");

const NAMES = new Map<string, LocaleSpec>();

/** The locale data Excel would use for a BCP-47 tag. Month and day names, the two separators and the short date come from ICU. */
export function localeFor(tag: string): LocaleSpec {
  const hit = NAMES.get(tag);
  if (hit) return hit;
  let spec: LocaleSpec;
  try {
    const month = (style: "long" | "short") => Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(tag, { month: style, timeZone: "UTC" }).format(Date.UTC(2001, i, 15)));
    // 2001-01-07 was a Sunday.
    const day = (style: "long" | "short") => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(tag, { weekday: style, timeZone: "UTC" }).format(Date.UTC(2001, 0, 7 + i)));
    const num = new Intl.NumberFormat(tag).formatToParts(1234567.5);
    const decimal = num.find((p) => p.type === "decimal")?.value ?? ".";
    const group = num.find((p) => p.type === "group")?.value ?? ",";
    // The short date (the locale's own short style, year widened to four digits): month 2, day 3 shows whether it pads (02/03) and the
    // order and separators of the parts.
    const parts = new Intl.DateTimeFormat(tag, { dateStyle: "short", timeZone: "UTC" }).formatToParts(Date.UTC(2001, 1, 3));
    const shortDate = parts
      .filter((p) => p.type !== "era")
      .map((p) => (p.type === "year" ? "yyyy" : p.type === "month" ? (p.value.length === 2 ? "mm" : "m") : p.type === "day" ? (p.value.length === 2 ? "dd" : "d") : p.value.replace(/[A-Za-z]/g, (c) => `\\${c}`)))
      .join("");
    spec = { decimal, group, monthsLong: month("long"), monthsShort: month("short"), daysLong: day("long"), daysShort: day("short"), shortDate };
  } catch {
    return EN_US;
  }
  NAMES.set(tag, spec);
  return spec;
}

export const EN_US: LocaleSpec = {
  decimal: ".", group: ",",
  monthsLong: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  daysLong: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  daysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  shortDate: "m/d/yyyy",
};

let system: LocaleSpec | undefined;

/**
 * The Mac's region as a locale, read once (`defaults read -g AppleLocale`; "en_US@rg=gbzzzz" is language en with region GB). Excel on a
 * Mac takes built-in ids 14 and 22, month and day names and the separators from here. Falls back to en-US when it cannot be read.
 * Ids 15-21 use their ECMA patterns with this locale's month and day names; they do not switch to a 24-hour or day-first order.
 */
export function systemLocale(): LocaleSpec {
  // COCHECK_LOCALE (a BCP-47 tag such as en-GB) overrides the Mac's region; tests and anyone who wants a fixed reading use it.
  const forced = process.env.COCHECK_LOCALE;
  if (forced) return localeFor(forced);
  if (system) return system;
  let tag = "en-US";
  try {
    // Imported lazily so the pure formatter has no process dependency in tests that pass their own locale.
    const raw = (process.getBuiltinModule("node:child_process") as typeof import("node:child_process")).execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLocale"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /^([a-z]{2,3})(?:_([A-Za-z]{2}))?(?:@.*?\brg=([a-z]{2})zzzz)?/i.exec(raw);
    if (m) tag = `${m[1]!.toLowerCase()}-${(m[3] ?? m[2] ?? "US").toUpperCase()}`;
  } catch {
    // keep en-US
  }
  system = localeFor(tag);
  return system;
}

// ---------------------------------------------------------------------------------------------------------------------
// Code parsing

type Tok =
  /** `via` records how the text was written (quoted, backslash-escaped, `_x` padding, bare), so the oracle can cover each. */
  | { k: "lit"; s: string; via?: "quote" | "escape" | "pad" | "bare" }
  | { k: "ph"; c: "0" | "#" | "?" }
  | { k: "point" }
  | { k: "comma" }
  | { k: "pct" }
  | { k: "exp"; plus: boolean; digits: number }
  | { k: "gen" }
  | { k: "at" }
  | { k: "fill"; c: string }
  | { k: "slash" }
  | { k: "den"; n: number }
  | { k: "y" | "mo" | "d" | "h" | "mi" | "s"; n: number }
  | { k: "m?"; n: number }
  | { k: "ampm"; s: string }
  | { k: "el"; unit: "h" | "m" | "s"; n: number }
  | { k: "fs"; n: number };

interface Cond {
  op: "<" | "<=" | ">" | ">=" | "=" | "<>";
  n: number;
}

interface Section {
  toks: Tok[];
  cond: Cond | null;
  /** A `[$-xxx]` locale other than en-US: month and day names would differ, which this module does not render. */
  foreignLocale: boolean;
  /** The `[Red]` / `[Color3]` the section names: the text colour of what it shows. Lower case, no spaces. */
  color: string | null;
  /** The section carried a `[Red]`-style colour. */
  colors: boolean;
  /** The section carried a `[$...]` currency or locale tag. */
  currency: boolean;
}

class Unsupported extends Error {}

const DATE_KINDS = new Set(["y", "mo", "d", "h", "mi", "s", "el", "ampm", "fs"]);
const COLOR = /^(?:black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)$/i;
const LITERAL_CHARS = new Set([" ", "$", "-", "+", "(", ")", ":", "!", "^", "&", "'", "~", "{", "}", "<", ">", "=", " "]);

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      if (end < 0) throw new Unsupported();
      cur += code.slice(i, end + 1);
      i = end;
    } else if (c === "\\" || c === "_" || c === "*") {
      cur += c + (code[i + 1] ?? "");
      i++;
    } else if (c === "[") {
      const end = code.indexOf("]", i + 1);
      if (end < 0) throw new Unsupported();
      cur += code.slice(i, end + 1);
      i = end;
    } else if (c === ";") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseSection(src: string): Section {
  const toks: Tok[] = [];
  let cond: Cond | null = null;
  let foreignLocale = false;
  let color: string | null = null;
  let colors = false;
  let currency = false;
  const push = (t: Tok): void => void toks.push(t);
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const rest = src.slice(i);
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      push({ k: "lit", s: src.slice(i + 1, end), via: "quote" });
      i = end;
    } else if (c === "\\") {
      if (i + 1 >= src.length) throw new Unsupported();
      push({ k: "lit", s: src[i + 1]!, via: "escape" });
      i++;
    } else if (c === "_") {
      if (i + 1 >= src.length) throw new Unsupported();
      push({ k: "lit", s: " ", via: "pad" });
      i++;
    } else if (c === "*") {
      if (i + 1 >= src.length) throw new Unsupported();
      // How many times a fill repeats depends on the column width, so only the space fill (accounting) is drawn.
      if (src[i + 1] !== " ") throw new Unsupported();
      push({ k: "fill", c: src[i + 1]! });
      i++;
    } else if (c === "[") {
      const end = src.indexOf("]", i);
      const inner = src.slice(i + 1, end);
      i = end;
      let m: RegExpExecArray | null;
      if (COLOR.test(inner)) {
        color = inner.toLowerCase().replace(/\s+/g, "");
        colors = true;
        continue;
      }
      if ((m = /^\$([^-\]]*)(?:-([0-9a-fA-F]+))?$/.exec(inner))) {
        currency = true;
        if (m[1]) push({ k: "lit", s: m[1], via: "bare" });
        if (m[2] !== undefined && !/^0*409$/i.test(m[2])) foreignLocale = true;
      } else if ((m = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(inner))) {
        if (cond) throw new Unsupported();
        cond = { op: m[1] as Cond["op"], n: Number(m[2]) };
      } else if ((m = /^(h+|m+|s+)$/i.exec(inner))) {
        push({ k: "el", unit: m[1]![0]!.toLowerCase() as "h" | "m" | "s", n: m[1]!.length });
      } else throw new Unsupported();
    } else if (/^general/i.test(rest)) {
      push({ k: "gen" });
      i += 6;
    } else if (/^(?:am\/pm|a\/p)/i.test(rest)) {
      const s = /^(?:am\/pm|a\/p)/i.exec(rest)![0];
      if (s !== s.toUpperCase() && s !== s.toLowerCase()) throw new Unsupported();
      // LibreOffice writes "A/P" as a lower-case a/p and "am/pm" as upper-case AM/PM; Excel's documentation says it follows the case.
      // With no real-Excel reading to settle it, only the spellings both agree on are drawn: AM/PM and a/p.
      if (s === "A/P" || s === "am/pm") throw new Unsupported();
      push({ k: "ampm", s });
      i += s.length - 1;
    } else if (c === "0" || c === "#" || c === "?") {
      push({ k: "ph", c });
    } else if (c === ".") {
      const prev = toks[toks.length - 1];
      const zeros = /^\.(0+)/.exec(rest);
      if (prev && prev.k === "s" && zeros) {
        push({ k: "fs", n: zeros[1]!.length });
        i += zeros[1]!.length;
      } else if (prev && prev.k === "el" && prev.unit === "s" && zeros) {
        push({ k: "fs", n: zeros[1]!.length });
        i += zeros[1]!.length;
      } else push({ k: "point" });
    } else if (c === ",") push({ k: "comma" });
    else if (c === "%") push({ k: "pct" });
    else if (c === "@") push({ k: "at" });
    else if (c === "/") {
      push({ k: "slash" });
      const den = /^\/([1-9]\d*)/.exec(rest);
      if (den) {
        push({ k: "den", n: Number(den[1]) });
        i += den[1]!.length;
      }
    } else if ((c === "E" || c === "e") && /^[Ee][+-]/.test(rest)) {
      const zeros = /^[Ee][+-](0+)/.exec(rest);
      if (!zeros) throw new Unsupported();
      push({ k: "exp", plus: rest[1] === "+", digits: zeros[1]!.length });
      i += 1 + zeros[1]!.length;
    } else if (/^[ymdhs]/i.test(c)) {
      const run = new RegExp(`^${c}+`, "i").exec(rest)![0];
      const kind = c.toLowerCase();
      push({ k: kind === "m" ? "m?" : (kind === "y" ? "y" : kind === "d" ? "d" : kind === "h" ? "h" : "s") as "y", n: run.length });
      i += run.length - 1;
    } else if (LITERAL_CHARS.has(c) || /\p{Sc}/u.test(c)) {
      push({ k: "lit", s: c, via: "bare" });
    } else throw new Unsupported();
  }
  // A lone "m" token is a minute after an hour or before a second, otherwise a month.
  const dateIdx = toks.map((t, i) => (DATE_KINDS.has(t.k) || t.k === "m?" ? i : -1)).filter((i) => i >= 0);
  for (const i of dateIdx) {
    const t = toks[i]!;
    if (t.k !== "m?") continue;
    const before = toks[dateIdx[dateIdx.indexOf(i) - 1] ?? -1];
    const after = toks[dateIdx[dateIdx.indexOf(i) + 1] ?? -1];
    const minute = (before !== undefined && (before.k === "h" || (before.k === "el" && before.unit === "h"))) || (after !== undefined && (after.k === "s" || (after.k === "el" && after.unit === "s")));
    toks[i] = { k: minute ? "mi" : "mo", n: t.n };
  }
  // In a date or time section the slash, comma and digits of a would-be fraction are plain separators.
  if (toks.some((t) => DATE_KINDS.has(t.k))) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.k === "slash") toks[i] = { k: "lit", s: "/" };
      else if (t.k === "den") toks[i] = { k: "lit", s: String(t.n) };
      else if (t.k === "comma") toks[i] = { k: "lit", s: "," };
      else if (t.k === "point") toks[i] = { k: "lit", s: "." };
    }
  }
  return { toks, cond, foreignLocale, color, colors, currency };
}

interface Parsed {
  sections: Section[];
}

const parsedCache = new Map<string, Parsed | null>();

function parseCode(code: string): Parsed | null {
  if (parsedCache.has(code)) return parsedCache.get(code)!;
  let out: Parsed | null;
  try {
    const parts = splitSections(code);
    if (parts.length > 4) throw new Unsupported();
    out = { sections: parts.map(parseSection) };
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    out = null;
  }
  if (parsedCache.size > 2000) parsedCache.clear();
  parsedCache.set(code, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Decimal arithmetic

/** A non-negative decimal: `int` x 10^-`scale`. */
interface Dec {
  int: bigint;
  scale: number;
}

/** The value cut to 15 significant digits, the way Excel reads a double. */
function toDec(abs: number): Dec {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(abs.toPrecision(15))!;
  const frac = m[2] ?? "";
  return { int: BigInt(m[1]! + frac), scale: frac.length - Number(m[3] ?? 0) };
}

/** Rounds half up to `places` decimals. `dropped` is true when the rounding removed a non-zero part. */
function roundTo(d: Dec, places: number): { int: bigint; dropped: boolean } {
  if (d.scale <= places) return { int: d.int * 10n ** BigInt(places - d.scale), dropped: false };
  const div = 10n ** BigInt(d.scale - places);
  const q = d.int / div;
  const r = d.int % div;
  return { int: r * 2n >= div ? q + 1n : q, dropped: r !== 0n };
}

const shift = (d: Dec, by: number): Dec => ({ int: d.int, scale: d.scale - by });

// ---------------------------------------------------------------------------------------------------------------------
// General

/** Excel's General: up to 11 characters, switching to scientific for 1e11 and above or below 1e-4. Column width is not modelled. */
function general(abs: number, loc: LocaleSpec): { text: string; lossy: boolean } {
  if (abs === 0) return { text: "0", lossy: false };
  const d = toDec(abs);
  const digits = d.int.toString();
  let e10 = digits.length - 1 - d.scale;
  const sci = (): { text: string; lossy: boolean } => {
    let r = roundTo({ int: d.int, scale: d.scale + e10 }, 5);
    if (r.int >= 1_000_000n) {
      e10 += 1;
      r = roundTo({ int: d.int, scale: d.scale + e10 }, 5);
    }
    const s = r.int.toString().padStart(6, "0");
    const mant = (s[0]! + "." + s.slice(1)).replace(/\.?0+$/, "").replace(".", loc.decimal);
    return { text: `${mant}E${e10 < 0 ? "-" : "+"}${pad2(Math.abs(e10))}`, lossy: r.dropped || /[1-9]/.test(s.slice(6)) };
  };
  if (e10 >= 11 || e10 < -4) return sci();
  const places = e10 >= 0 ? Math.max(0, 9 - e10) : 9;
  const r = roundTo(d, places);
  const s = r.int.toString().padStart(places + 1, "0");
  const ip = s.slice(0, s.length - places);
  if (ip.length > 11) return sci();
  const fp = s.slice(s.length - places).replace(/0+$/, "");
  return { text: ip + (fp ? loc.decimal + fp : ""), lossy: r.dropped };
}

// ---------------------------------------------------------------------------------------------------------------------
// Numbers

function hasKind(toks: Tok[], pred: (t: Tok) => boolean): boolean {
  return toks.some(pred);
}

const isDateTok = (t: Tok): boolean => DATE_KINDS.has(t.k);

function bestFraction(frac: number, maxDen: number): { n: number; d: number } {
  let best = { n: Math.round(frac), d: 1 };
  let err = Math.abs(frac - best.n);
  for (let d = 2; d <= maxDen; d++) {
    const n = Math.round(frac * d);
    const e = Math.abs(frac - n / d);
    if (e < err - 1e-12) {
      best = { n, d };
      err = e;
    }
  }
  return best;
}

/** Fills the integer digit placeholders in `toks` (right to left) with `digits`, honouring `#`, `0`, `?` and the thousands flag. */
function placeInts(pieces: Array<{ tok: Tok; out: string }>, digits: string, grouped: boolean, loc: LocaleSpec): void {
  const phs = pieces.filter((p) => p.tok.k === "ph");
  const stripped = digits.replace(/^0+/, "");
  for (let r = 0; r < phs.length; r++) {
    const ph = phs[phs.length - 1 - r]!;
    const c = (ph.tok as { c: string }).c;
    const dig = stripped[stripped.length - 1 - r];
    ph.out = dig ?? (c === "0" ? "0" : c === "?" ? " " : "");
  }
  const extra = stripped.length > phs.length ? stripped.slice(0, stripped.length - phs.length) : "";
  if (phs.length > 0) phs[0]!.out = extra + phs[0]!.out;
  if (grouped) {
    // A separator goes before every third emitted digit, counted from the right, when something is emitted to its left.
    const total = phs.reduce((n, p) => n + [...p.out].length, 0);
    let seen = 0;
    for (const p of phs) {
      let s = "";
      for (const ch of [...p.out]) {
        if (seen > 0 && (total - seen) % 3 === 0) s += loc.group;
        s += ch;
        seen++;
      }
      p.out = s;
    }
  }
}

interface NumberRender {
  text: string;
  lossy: boolean;
  /** Every digit shown is zero after rounding: Excel then drops the implicit minus of a negative number ("0", not "-0"). */
  zero?: boolean;
}

function renderNumber(sec: Section, abs: number, loc: LocaleSpec): NumberRender | null {
  const toks = sec.toks;
  const dec0 = toDec(abs);
  let lossy = false;
  let roundedZero = false;
  const out = (pieces: Array<{ tok: Tok; out: string }>): string => pieces.map((p) => p.out).join("");
  const pieces = toks.map((tok) => ({ tok, out: tok.k === "lit" ? tok.s : "" }));

  // General inside a section: the General text of the value with the section's literals around it.
  if (hasKind(toks, (t) => t.k === "gen")) {
    // "General" mixed with digit placeholders, dates or text ("0.0General") has no output Excel is known to give.
    if (toks.some((t) => t.k !== "gen" && t.k !== "lit" && t.k !== "fill")) return null;
    const g = general(abs, loc);
    for (const p of pieces) if (p.tok.k === "gen") p.out = g.text;
    return { text: out(pieces), lossy: g.lossy };
  }
  const phCount = toks.filter((t) => t.k === "ph").length;
  // An exponent with no digit placeholder to scale has no output Excel is known to give.
  if (phCount === 0 && toks.some((t) => t.k === "exp")) return null;
  const slashAt = toks.findIndex((t) => t.k === "slash");
  const hasAt = hasKind(toks, (t) => t.k === "at");
  if (phCount === 0 && slashAt < 0) {
    // Literals only (or "@" with a number): "@" takes the General text.
    if (hasAt) {
      const g = general(abs, loc);
      for (const p of pieces) if (p.tok.k === "at") p.out = g.text;
      lossy = g.lossy;
    }
    return { text: out(pieces), lossy };
  }
  if (hasAt) return null;

  const pcts = toks.filter((t) => t.k === "pct").length;
  for (const p of pieces) if (p.tok.k === "pct") p.out = "%";
  const expIdx = toks.findIndex((t) => t.k === "exp");

  // Fractions: "# ?/?", "?/8", "# ??/??".
  if (slashAt >= 0) {
    if (expIdx >= 0 || toks.some((t) => t.k === "point" || t.k === "comma")) return null;
    let numEnd = slashAt;
    let numStart = numEnd;
    while (numStart > 0 && toks[numStart - 1]!.k === "ph") numStart--;
    if (numStart === numEnd) return null;
    const afterTok = toks[slashAt + 1];
    let denEnd = slashAt + 1;
    let fixed: number | null = null;
    if (afterTok?.k === "den") {
      fixed = afterTok.n;
      denEnd = slashAt + 2;
    } else {
      while (denEnd < toks.length && toks[denEnd]!.k === "ph") denEnd++;
      if (denEnd === slashAt + 1) return null;
    }
    if (toks.slice(numStart, numEnd).some((t) => (t as { c: string }).c === "#")) return null;
    if (fixed === null && toks.slice(slashAt + 1, denEnd).some((t) => (t as { c: string }).c !== "?")) return null;
    const intPieces = pieces.filter((p, i) => i < numStart && p.tok.k === "ph");
    if (pieces.some((p, i) => i < numStart && p.tok.k !== "ph" && p.tok.k !== "lit" && p.tok.k !== "pct" && p.tok.k !== "fill")) return null;
    const v = shift(dec0, 2 * pcts);
    const x = Number(v.int) / 10 ** v.scale;
    const whole = intPieces.length > 0 ? Math.floor(x) : 0;
    const f = intPieces.length > 0 ? x - whole : x;
    let n: number, d: number;
    if (fixed !== null) {
      d = fixed;
      n = Math.round(f * d);
    } else {
      const maxDen = 10 ** (denEnd - slashAt - 1) - 1;
      ({ n, d } = bestFraction(f, maxDen));
    }
    let w = whole;
    if (intPieces.length > 0 && n >= d) {
      w += Math.floor(n / d);
      n -= Math.floor(n / d) * d;
    }
    lossy = Math.abs(f - n / d) > 1e-9;
    placeInts(intPieces, w === 0 ? "" : String(w), false, loc);
    // A value of exactly zero shows "0" even under "#" (LibreOffice and Excel agree); a bare fraction like 1/2 leaves the whole part blank.
    if (intPieces.length > 0 && w === 0 && n === 0) intPieces[intPieces.length - 1]!.out = "0";
    const numLen = numEnd - numStart;
    const denLen = fixed === null ? denEnd - slashAt - 1 : String(fixed).length;
    const whole0 = intPieces.length > 0 && n === 0;
    const numText = whole0 ? " ".repeat(numLen) : String(n).padStart(numLen, " ");
    const denText = whole0 ? " ".repeat(denLen) : fixed === null ? String(d).padEnd(denLen, " ") : String(d);
    for (let i = numStart; i < numEnd; i++) pieces[i]!.out = "";
    pieces[numStart]!.out = numText;
    pieces[slashAt]!.out = whole0 ? " " : "/";
    if (fixed !== null) pieces[slashAt + 1]!.out = denText;
    else {
      for (let i = slashAt + 1; i < denEnd; i++) pieces[i]!.out = "";
      pieces[slashAt + 1]!.out = denText;
    }
    return { text: out(pieces), lossy };
  }

  // Locate the decimal point and classify placeholders and commas.
  const pointAt = toks.findIndex((t) => t.k === "point");
  const intEnd = expIdx >= 0 ? (pointAt >= 0 && pointAt < expIdx ? pointAt : expIdx) : pointAt >= 0 ? pointAt : toks.length;
  const fracEnd = expIdx >= 0 ? expIdx : toks.length;
  const lastPh = toks.map((t, i) => (i < fracEnd ? t.k : "")).lastIndexOf("ph");
  const firstPh = toks.findIndex((t) => t.k === "ph");
  let grouped = false;
  let scaleCommas = 0;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.k !== "comma") continue;
    // Before the first digit placeholder a comma means nothing Excel documents; between two it groups thousands; after the last it divides by 1000.
    if (firstPh < 0 || i < firstPh) return null;
    if (i > lastPh) scaleCommas++;
    else if (pointAt >= 0 && i > pointAt) return null;
    else grouped = true;
  }
  const fracToks: number[] = [];
  for (let i = pointAt >= 0 ? pointAt + 1 : fracEnd; i < fracEnd; i++) if (toks[i]!.k === "ph") fracToks.push(i);
  const places = fracToks.length;
  const intPieces = pieces.filter((p, i) => i < intEnd && p.tok.k === "ph");
  let v = shift(dec0, 2 * pcts - 3 * scaleCommas);
  let expText = "";

  if (expIdx >= 0) {
    const ex = toks[expIdx] as Extract<Tok, { k: "exp" }>;
    const n = Math.max(1, intPieces.length);
    const nd = v.int.toString().length;
    let e10 = v.int === 0n ? 0 : nd - 1 - v.scale;
    let E = v.int === 0n ? 0 : Math.floor(e10 / n) * n;
    let r = roundTo({ int: v.int, scale: v.scale + E }, places);
    // Rounding can carry the mantissa to one more integer digit than the placeholders hold.
    if (v.int !== 0n && r.int.toString().length > n + places) {
      E += n;
      r = roundTo({ int: v.int, scale: v.scale + E }, places);
    }
    e10 = E;
    lossy = r.dropped;
    const s = r.int.toString().padStart(places + 1, "0");
    placeInts(intPieces, s.slice(0, s.length - places), false, loc);
    fillFrac(pieces, fracToks, s.slice(s.length - places));
    expText = (E < 0 ? "-" : ex.plus ? "+" : "") + String(Math.abs(E)).padStart(ex.digits, "0");
    pieces[expIdx]!.out = "E" + expText;
  } else {
    const r = roundTo(v, places);
    lossy = r.dropped;
    roundedZero = r.int === 0n;
    const s = r.int.toString().padStart(places + 1, "0");
    placeInts(intPieces, s.slice(0, s.length - places), grouped, loc);
    fillFrac(pieces, fracToks, s.slice(s.length - places));
  }
  if (pointAt >= 0) pieces[pointAt]!.out = loc.decimal;
  return { text: out(pieces), lossy, zero: roundedZero };
}

function fillFrac(pieces: Array<{ tok: Tok; out: string }>, idx: number[], digits: string): void {
  const lastNonZero = digits.search(/0*$/);
  idx.forEach((pi, j) => {
    const c = (pieces[pi]!.tok as { c: string }).c;
    const trailing = j >= lastNonZero;
    pieces[pi]!.out = c === "0" ? digits[j]! : trailing ? (c === "?" ? " " : "") : digits[j]!;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Dates and times

function civil(serial: number, system: DateSystem): { y: number; m: number; d: number } {
  if (system === 1900 && serial < 61) {
    if (serial === 0) return { y: 1900, m: 1, d: 0 };
    if (serial === 60) return { y: 1900, m: 2, d: 29 };
  }
  const epoch = system === 1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const dt = new Date(epoch + serial * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function renderDate(sec: Section, abs: number, system: DateSystem, loc: LocaleSpec): NumberRender | null {
  const toks = sec.toks;
  if (hasKind(toks, (t) => t.k === "ph" || t.k === "exp" || t.k === "gen" || t.k === "at" || t.k === "pct")) return null;
  const hasName = hasKind(toks, (t) => (t.k === "mo" && t.n >= 3) || (t.k === "d" && t.n >= 3) || t.k === "ampm");
  if (sec.foreignLocale && hasName) return null;
  const fsd = Math.max(0, ...toks.map((t) => (t.k === "fs" ? t.n : 0)));
  const scale = 10 ** fsd;
  const perDay = 86_400 * scale;
  const total = Math.round(abs * perDay);
  // A value within rounding distance of a boundary the format does not show (a minute, an hour, a day) is shown differently by a
  // formatter that rounds to the second and one that truncates; Excel's choice there is unverified, so such a cell is unformatted.
  if (!hasKind(toks, (t) => t.k === "s" || t.k === "fs" || (t.k === "el" && t.unit === "s"))) {
    if (Math.floor(Math.round(abs * 86_400) / 60) !== Math.floor(Math.round(abs * 86_400_000) / 60_000)) return null;
  }
  const day = Math.floor(total / perDay);
  const rem = total - day * perDay;
  const hasDateTok = hasKind(toks, (t) => t.k === "y" || t.k === "mo" || t.k === "d");
  const hasElapsed = hasKind(toks, (t) => t.k === "el");
  const limit = system === 1904 ? 2_957_003 : 2_958_465;
  if ((hasDateTok && day > limit) || (day > limit && !hasElapsed)) return null;
  if (hasElapsed && total > 1e15) return null;
  const hasAmpm = hasKind(toks, (t) => t.k === "ampm");
  const ymd = civil(day, system);
  const wd = system === 1904 ? (day + 5) % 7 : (((day - 1) % 7) + 7) % 7;
  const hour = Math.floor(rem / (3600 * scale));
  const minute = Math.floor((rem % (3600 * scale)) / (60 * scale));
  const second = Math.floor((rem % (60 * scale)) / scale);
  const sub = rem % scale;
  let text = "";
  for (const t of toks) {
    switch (t.k) {
      case "lit": text += t.s; break;
      case "fill": break;
      case "y": text += t.n <= 2 ? pad2(ymd.y % 100) : String(ymd.y).padStart(4, "0"); break;
      case "mo": text += t.n === 1 ? String(ymd.m) : t.n === 2 ? pad2(ymd.m) : t.n === 3 ? loc.monthsShort[ymd.m - 1]! : t.n === 4 ? loc.monthsLong[ymd.m - 1]! : [...loc.monthsLong[ymd.m - 1]!][0]!; break;
      case "d": text += t.n === 1 ? String(ymd.d) : t.n === 2 ? pad2(ymd.d) : t.n === 3 ? loc.daysShort[wd]! : loc.daysLong[wd]!; break;
      case "h": {
        const h = hasAmpm ? hour % 12 || 12 : hour;
        text += t.n === 1 ? String(h) : pad2(h);
        break;
      }
      case "mi": text += t.n === 1 ? String(minute) : pad2(minute); break;
      case "s": text += t.n === 1 ? String(second) : pad2(second); break;
      case "fs": text += loc.decimal + String(sub).padStart(fsd, "0").slice(0, t.n); break;
      case "ampm": {
        const pm = hour >= 12;
        const long = /^am\/pm$/i.test(t.s);
        const w = long ? (pm ? "PM" : "AM") : pm ? "P" : "A";
        text += t.s === t.s.toLowerCase() ? w.toLowerCase() : w;
        break;
      }
      case "el": {
        const unit = t.unit === "h" ? 3600 * scale : t.unit === "m" ? 60 * scale : scale;
        text += String(Math.floor(total / unit)).padStart(t.n, "0");
        break;
      }
      default: return null;
    }
  }
  // The elapsed unit also fixes what the following h/m/s mean: [h]:mm:ss shows minutes and seconds within the hour, as coded above
  // through rem of the whole day; for elapsed formats those are taken from the total instead.
  if (hasElapsed) {
    const el = toks.find((t) => t.k === "el") as Extract<Tok, { k: "el" }>;
    const lead = el.unit === "h" ? 3600 * scale : el.unit === "m" ? 60 * scale : scale;
    const within = total % lead;
    const mm = Math.floor(within / (60 * scale));
    const ss = Math.floor((within % (60 * scale)) / scale);
    text = "";
    for (const t of toks) {
      if (t.k === "lit") text += t.s;
      else if (t.k === "fill") continue;
      else if (t.k === "el") text += String(Math.floor(total / lead)).padStart(t.n, "0");
      else if (t.k === "mi") text += t.n === 1 ? String(mm) : pad2(mm);
      else if (t.k === "s") text += t.n === 1 ? String(ss) : pad2(ss);
      else if (t.k === "fs") text += loc.decimal + String(within % scale).padStart(fsd, "0").slice(0, t.n);
      else return null;
    }
  }
  // Loss: the smallest unit shown against what is stored.
  const hasTime = hasKind(toks, (t) => t.k === "h" || t.k === "mi" || t.k === "s" || t.k === "fs" || t.k === "el");
  let unit = perDay;
  if (hasKind(toks, (t) => t.k === "h")) unit = 3600 * scale;
  if (hasKind(toks, (t) => t.k === "mi")) unit = 60 * scale;
  if (hasKind(toks, (t) => t.k === "s" || t.k === "el" && t.unit === "s")) unit = scale;
  if (hasKind(toks, (t) => t.k === "fs")) unit = 1;
  const reference = hasElapsed ? total : rem;
  let lossy = Math.abs(abs * perDay - total) > 1e-6 || (hasTime ? reference % unit !== 0 : rem !== 0);
  if (!hasTime && hasDateTok && !hasKind(toks, (t) => t.k === "d") && ymd.d !== 1) lossy = true;
  if (!hasDateTok && !hasElapsed && day > 0) lossy = true;
  if (hasTime && !hasElapsed && !hasKind(toks, (t) => t.k === "h") && hour > 0) lossy = true;
  return { text, lossy };
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry points

function cmp(c: Cond, v: number): boolean {
  switch (c.op) {
    case "<": return v < c.n;
    case "<=": return v <= c.n;
    case ">": return v > c.n;
    case ">=": return v >= c.n;
    case "=": return v === c.n;
    default: return v !== c.n;
  }
}

/** The stored number as plain text, for the unformatted case. */
function plain(v: number): string {
  return String(v);
}

const unformatted = (v: number): Shown => ({ text: plain(v), exact: false, lossy: false });

/**
 * The text a number shows under a format code. Built-in ids 14 and 22 arrive as `SYSTEM_SHORT_DATE` / `SYSTEM_SHORT_DATE_TIME` and
 * take the Mac's short date. A code this module cannot render exactly returns the stored value with `exact: false`.
 */
export function showNumber(value: number, code: string, ctx: FormatContext = {}): Shown {
  const { color: _color, ...shown } = showNumberColored(value, code, ctx);
  return shown;
}

/** `showNumber` plus the colour the chosen section names: a colour word (`red`) or `colorN`; absent when the section names none. */
export function showNumberColored(value: number, code: string, ctx: FormatContext = {}): Shown & { color?: string } {
  if (!Number.isFinite(value)) return unformatted(value);
  const loc = ctx.locale ?? systemLocale();
  const system = ctx.dateSystem ?? 1900;
  let effective = code;
  if (code === SYSTEM_SHORT_DATE) effective = loc.shortDate;
  else if (code === SYSTEM_SHORT_DATE_TIME) effective = `${loc.shortDate} h:mm`;
  if (/^general$/i.test(effective.trim())) {
    const g = general(Math.abs(value), loc);
    return { text: (value < 0 ? "-" : "") + g.text, exact: true, lossy: g.lossy };
  }
  if (effective.trim() === "") return unformatted(value);
  const parsed = parseCode(effective);
  if (!parsed) return unformatted(value);
  const secs = parsed.sections;
  const numeric = secs.length === 4 ? secs.slice(0, 3) : secs;
  const conditional = numeric.some((s) => s.cond !== null);
  let sec: Section | undefined;
  let negative = false;
  if (!conditional) {
    // A section that holds "@" is the text section and not a number section, unless it is the only one.
    const nums = numeric.length > 1 ? numeric.filter((s) => !hasKind(s.toks, (t) => t.k === "at")) : numeric;
    if (nums.length === 1) {
      sec = nums[0];
      negative = value < 0;
    } else if (nums.length === 2) {
      sec = value < 0 ? nums[1] : nums[0];
      negative = false;
    } else {
      sec = value < 0 ? nums[1] : value === 0 ? nums[2] : nums[0];
    }
  } else {
    if (value < 0) return unformatted(value);
    for (let i = 0; i < numeric.length; i++) {
      const s = numeric[i]!;
      if (s.cond === null) {
        if (i !== numeric.length - 1) return unformatted(value);
        sec = s;
      } else if (cmp(s.cond, value)) {
        sec = s;
        break;
      }
    }
    if (!sec) return unformatted(value);
  }
  if (!sec) return unformatted(value);
  const abs = Math.abs(value);
  const isDate = hasKind(sec.toks, isDateTok);
  if (isDate && (value < 0 || negative)) return unformatted(value);
  const r = isDate ? renderDate(sec, abs, system, loc) : renderNumber(sec, abs, loc);
  if (!r) return unformatted(value);
  // A single section shows a leading minus for a negative number (also in front of literals such as "$").
  return { text: (negative && r.zero !== true ? "-" : "") + r.text, exact: true, lossy: r.lossy, ...(sec.color !== null ? { color: sec.color } : {}) };
}

/** The text a string shows under a format code: the text section (the fourth, or the one holding "@"), else the string as it is. */
export function showText(value: string, code: string): string {
  return showTextColored(value, code).text;
}

/** `showText` plus the colour the text section names. */
export function showTextColored(value: string, code: string): { text: string; color?: string } {
  if (code === "General" || code === "@" || code === "") return { text: value };
  const parsed = parseCode(code);
  if (!parsed) return { text: value };
  const secs = parsed.sections;
  const sec = secs.length === 4 ? secs[3] : secs.find((s) => hasKind(s.toks, (t) => t.k === "at"));
  if (!sec) return { text: value };
  let out = "";
  for (const t of sec.toks) {
    if (t.k === "lit") out += t.s;
    else if (t.k === "at") out += value;
    else if (t.k === "fill") continue;
    else return { text: value };
  }
  return { text: out, ...(sec.color !== null ? { color: sec.color } : {}) };
}

/**
 * Every kind of format token the parser accepts, in the finest grain whose output differs. Each must have at least one case in the
 * LibreOffice or real-Excel oracle (test/numfmt-oracle.test.ts enumerates this list and fails on a gap); a token kind added
 * to the parser without an oracle case is a failing test, not a silent guess.
 */
export const ACCEPTED_TOKEN_KINDS: readonly string[] = [
  "lit:quote", "lit:escape", "lit:pad", "lit:bare", "ph:0", "ph:#", "ph:?", "point", "comma", "pct", "exp:+", "exp:-", "gen", "at", "fill", "slash", "den",
  "y:2", "y:4", "mo:1", "mo:2", "mo:3", "mo:4", "mo:5", "d:1", "d:2", "d:3", "d:4", "h:1", "h:2", "mi:1", "mi:2", "s:1", "s:2",
  "ampm:AM/PM", "ampm:a/p", "el:h", "el:m", "el:s", "fs",
  "sections:1", "sections:2", "sections:3", "sections:4", "cond", "color", "currency",
];

/** The token kinds (labels from `ACCEPTED_TOKEN_KINDS`) a code uses; empty for a code that does not parse. */
export function tokenKindsOf(code: string): Set<string> {
  const out = new Set<string>();
  const parsed = parseCode(code);
  if (!parsed) return out;
  out.add(`sections:${parsed.sections.length}`);
  for (const sec of parsed.sections) {
    if (sec.cond) out.add("cond");
    if (sec.colors) out.add("color");
    if (sec.currency) out.add("currency");
    for (const t of sec.toks) {
      switch (t.k) {
        case "lit": out.add(`lit:${t.via ?? "bare"}`); break;
        case "ph": out.add(`ph:${t.c}`); break;
        case "exp": out.add(t.plus ? "exp:+" : "exp:-"); break;
        case "y": out.add(t.n <= 2 ? "y:2" : "y:4"); break;
        case "mo": out.add(`mo:${Math.min(t.n, 5)}`); break;
        case "d": out.add(`d:${Math.min(t.n, 4)}`); break;
        case "h": case "mi": case "s": out.add(`${t.k}:${Math.min(t.n, 2)}`); break;
        case "ampm": out.add(`ampm:${t.s}`); break;
        case "el": out.add(`el:${t.unit}`); break;
        case "m?": break;
        default: out.add(t.k);
      }
    }
  }
  return out;
}
