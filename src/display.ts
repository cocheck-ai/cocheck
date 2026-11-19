import path from "node:path";
import { escapeHtml } from "./html.ts";

/**
 * The one door to the review page, the sign-off view and the server's review responses.
 *
 * Text that is visible on those surfaces is a `Shown`, and `Shown` has few producers: the user's own typed words,
 * a reason that passed the gate's word test (src/reason.ts), file base names, counts, dates and times, cell places
 * and cell values, and labels written in CoCheck's code (a `words` template with no raw text in it). The render
 * functions take `Shown`, never `string`, so tsc rejects a raw ledger string at a call site (the tests pin this
 * proves it). A command, tool input, tool id, full path or any other text can reach the page only through
 * `detailsHtml`, which puts it inside a closed <details> element.
 */
declare const shownBrand: unique symbol;
export type Shown = string & { readonly [shownBrand]: true };

const mark = (text: string): Shown => text as Shown;

/** A label or sentence written in CoCheck's code. Its interpolations must themselves be `Shown` or numbers. */
export function words(parts: TemplateStringsArray, ...values: Array<Shown | number>): Shown {
  return mark(parts.reduce((out, part, i) => out + part + (i < values.length ? String(values[i]) : ""), ""));
}

/** Words the user typed: the captured request, a reviewer's name or note. The user may have typed anything. */
export function userText(text: string): Shown {
  return mark(text);
}

/** A reason that passed the gate's word test. Only `src/reason.ts` calls this. */
export function gatedReason(text: string): Shown {
  return mark(text);
}

/** Text CoCheck's own code wrote (a row's description, a check's label or notice, a file's display name). */
export function ownText(text: string): Shown {
  return mark(text);
}

/**
 * CoCheck-written prose that may name a path (a scan note, a check's error text, a sign-off blocker): every absolute
 * path in it is cut to its base name first. The two scan notes name a folder or file that may hold spaces, so they are
 * matched whole before the general token rule.
 */
export function ownProse(text: string): Shown {
  const cut = (p: string): string => path.basename(p.replace(/\\/g, "/")) || p;
  let out = text
    .replace(/^(\S.*?) (is [\d.,]+ ?\w+ \(limit )/, (_m, p: string, rest: string) => `${cut(p)} ${rest}`)
    .replace(/^folder (.+?) (has \d+ files|holds [\d.,]+ ?\w+ )/, (_m, p: string, rest: string) => `folder ${cut(p)} ${rest}`);
  out = out.replace(/(?<![\w.])(?:[A-Za-z]:[\\/]|~?\/)[^\s"'`<>|*?]*/g, (p) => cut(p.replace(/[.,;:)]+$/, "")) + (/[.,;:)]+$/.exec(p)?.[0] ?? ""));
  return mark(out);
}

/** A cell place (sheet and address) or a cell value as the file holds it. */
export function cellText(text: string): Shown {
  return mark(text);
}

/** What a file name may look like. A path scanned out of a command can be garbage (a code fragment); that is not a name. */
const FILE_NAME = /^[\p{L}\p{N} ._+,@#%~&'()\[\]-]{1,120}$/u;
export const UNNAMED_FILE = mark("a file");

/** A file's base name: the last path segment, never the folder. A segment that does not look like a file name becomes "a file". */
export function fileBase(filePath: string): Shown {
  const base = path.basename(filePath.replace(/\\/g, "/"));
  const opens = (base.match(/\(/g) ?? []).length;
  return FILE_NAME.test(base) && opens <= 1 && base !== "." && base !== ".." ? mark(base) : UNNAMED_FILE;
}

export function count(n: number): Shown {
  return mark(n.toLocaleString("en-US"));
}

export function plural(n: number, one: Shown, many: Shown): Shown {
  return mark(`${n.toLocaleString("en-US")} ${n === 1 ? one : many}`);
}

/** `2001-02-03 12:00:00 UTC`. */
export function utcMoment(ms: number): Shown {
  return mark(`${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`);
}

/** A date or time already formatted by CoCheck's own formatter. */
export function momentText(text: string): Shown {
  return mark(text);
}

export function joinShown(items: readonly Shown[], separator: Shown): Shown {
  return mark(items.join(separator));
}

const escape = escapeHtml;

/** HTML-escapes visible text. Takes `Shown` only. */
export function esc(text: Shown): string {
  return escape(text);
}

/**
 * The only way raw text (a command, a tool input or id, a full path, a hash) reaches the page: inside a closed
 * <details> element. Each entry is one escaped line (`pre` keeps a command's line breaks).
 */
export function detailsHtml(summary: Shown, lines: readonly string[], options: { pre?: boolean; cls?: string } = {}): string {
  const body = lines.map((l) => (options.pre === true ? `<pre class="small">${escape(l)}</pre>` : `<div class="muted small">${escape(l)}</div>`)).join("");
  return `<details class="raw${options.cls ? ` ${options.cls}` : ""}"><summary class="muted small">${escape(summary)}</summary>${body}</details>`;
}

export function capitalize(text: Shown): Shown {
  return mark(text.charAt(0).toUpperCase() + text.slice(1));
}
