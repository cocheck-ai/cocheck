// Whether a shell command names a file it may have written. Read when several calls were open over a write and nothing else tells
// them apart: the one call whose command names the file is credited (still inferred: the basis is `named`, never proof). Pure: no I/O.
import path from "node:path";
import { braceExpand, isReadOnlyCommand } from "./write-scope.ts";

/** A word with its brace expansion spelled out (`yahoo_{a,b}.json` names both files); a sequence or an over-long one is kept as written. */
const spelled = (w: string): string[] => {
  try {
    return braceExpand(w);
  } catch {
    return [w];
  }
};

/** The basename `base` (lower case) appears in `text` with no word character, dot or dash just before it. */
export function textNamesBase(text: string, base: string): boolean {
  if (base === "") return false;
  const t = text.toLowerCase();
  for (let i = t.indexOf(base); i >= 0; i = t.indexOf(base, i + 1)) {
    if (i === 0 || !/[\w.-]/.test(t[i - 1]!)) return true;
  }
  return false;
}

/**
 * Whether the shell word `w` names `file`: its basename appears in the word at a name boundary, and any literal directories written
 * before it match the file's own parent directories (so `lnk/a.json` does not name `raw/a.json`). Directories up to a `.`, `..`, `~`
 * or a `$` variable are unknown and match anything.
 */
function wordNamesFile(w: string, file: string): boolean {
  const base = path.basename(file).toLowerCase();
  const t = w.toLowerCase();
  const parents = path.dirname(file).toLowerCase().split(/[\\/]+/).filter((x) => x !== "");
  for (let i = t.indexOf(base); i >= 0; i = t.indexOf(base, i + 1)) {
    if (i > 0 && /[\w.-]/.test(t[i - 1]!)) continue;
    const before = t.slice(0, i);
    if (before !== "" && !before.endsWith("/") && !before.endsWith("\\")) return true; // `--out=a.json`, `>a.json`: no directory written
    const dir = before.slice(Math.max(...["=", ":", ">", "<", "(", "@"].map((c) => before.lastIndexOf(c))) + 1);
    let segs = dir.split(/[\\/]+/).filter((x) => x !== "");
    const cut = segs.findLastIndex((x) => x === "." || x === ".." || x.startsWith("~") || x.includes("$"));
    segs = segs.slice(cut + 1);
    if (segs.length <= parents.length && segs.every((x, k) => x === parents[parents.length - segs.length + k])) return true;
  }
  return false;
}

const SEPARATORS = /\n|&&|\|\||;|\|/;
const WORD = /"([^"]*)"|'([^']*)'|(\S+)/g;
const words = (seg: string): string[] => [...seg.matchAll(WORD)].map((m) => m[1] ?? m[2] ?? m[3]!);
const bare = (w: string): string => path.posix.basename(w).toLowerCase().replace(/\.(py|exe|bin)$/, "");

/** The program a simple command runs, skipping env assignments and a Python interpreter in front of a script. */
function program(ws: string[]): { name: string; args: string[] } | undefined {
  let i = 0;
  while (i < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]!)) i++;
  if (i >= ws.length) return undefined;
  let name = bare(ws[i]!);
  if (/^python[\d.]*$/.test(name)) {
    let j = i + 1;
    while (j < ws.length && ws[j]!.startsWith("-")) j++;
    if (j < ws.length) {
      name = bare(ws[j]!);
      i = j;
    }
  }
  return { name, args: ws.slice(i + 1) };
}

// pdftoppm (poppler) options that take a value; every other `-x` word is a flag.
const PDFTOPPM_ARG = new Set(["f", "l", "r", "rx", "ry", "scale-to", "scale-to-x", "scale-to-y", "x", "y", "W", "H", "opw", "upw", "jpegopt", "tiffcompression", "freetype", "aa", "aaVector", "thinlinemode", "displayprofile", "defaultgrayprofile", "defaultrgbprofile", "defaultcmykprofile", "sep"]);
const PDFTOPPM_EXT: Record<string, string> = { png: "png", jpeg: "jpg", jpegcmyk: "jpg", tiff: "tif", mono: "pbm", gray: "pgm" };

/**
 * pdftoppm `[options] <pdf> [<prefix>]`: the input it reads, and whether `base` is one of the pages it writes. Poppler names a page
 * `<prefix>-<n>.<ext>` with `n` zero-padded to the digits of the document's last page (unknown here, so any padding), or
 * `<prefix>.<ext>` with `-singlefile`; `-f`/`-l` bound `n` when they are literal numbers.
 */
function pdftoppm(args: string[], base: string): { reads: string[]; writes: boolean } {
  const opts = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.length > 1 && a.startsWith("-")) {
      const o = a.replace(/^--?/, "");
      if (PDFTOPPM_ARG.has(o)) opts.set(o, args[++i] ?? "");
      else opts.set(o, "");
    } else pos.push(a);
  }
  const [input, prefix] = pos;
  const reads = input === undefined ? [] : [input];
  if (prefix === undefined || prefix === "-") return { reads, writes: false };
  const ext = Object.keys(PDFTOPPM_EXT).find((k) => opts.has(k));
  const want = ext === undefined ? "ppm" : PDFTOPPM_EXT[ext]!;
  const p = path.posix.basename(prefix).toLowerCase();
  if (opts.has("singlefile")) return { reads, writes: base === `${p}.${want}` };
  if (!base.startsWith(`${p}-`) || !base.endsWith(`.${want}`)) return { reads, writes: false };
  const num = base.slice(p.length + 1, base.length - want.length - 1);
  if (!/^\d+$/.test(num)) return { reads, writes: false };
  const n = Number(num);
  const lit = (k: string): number | undefined => (/^\d+$/.test(opts.get(k) ?? "") ? Number(opts.get(k)) : undefined);
  const first = lit("f");
  const last = lit("l");
  return { reads, writes: n >= 1 && (first === undefined || n >= first) && (last === undefined || n <= last) };
}

/** soffice/libreoffice `--convert-to <ext>[:filter] [--outdir d] <inputs>`: the inputs it reads, and whether `base` is an input's stem with the new extension. */
function soffice(args: string[], base: string): { reads: string[]; writes: boolean } {
  let to: string | undefined;
  const inputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--convert-to" || a === "-convert-to") to = (args[++i] ?? "").split(":")[0]!.toLowerCase();
    else if (a === "--outdir" || a === "-outdir") i++;
    else if (!a.startsWith("-")) inputs.push(a);
  }
  if (to === undefined || to === "") return { reads: [], writes: false };
  const writes = inputs.some((f) => {
    const b = path.posix.basename(f).toLowerCase();
    const dot = b.lastIndexOf(".");
    return `${dot > 0 ? b.slice(0, dot) : b}.${to}` === base;
  });
  return { reads: inputs, writes };
}

/**
 * Whether `command` names `file` as something it may have written: a word of it holds the file's basename (with any literal directories
 * before it matching the file's own), or a converter the command runs writes that name (pdftoppm pages, soffice --convert-to). Reads
 * are not names: a part of the command made only of read-only forms (cat, head, ls, grep...) and a converter's own input are left out.
 * Bound: the command is split on shell separators and whitespace by text, not parsed; a name inside a script the command runs, or built
 * from a variable, is not seen; a basename in any other position still counts (a program that only reads it outside the forms above
 * takes the credit).
 */
export function commandNamesFile(command: string, file: string): boolean {
  const base = path.basename(file).toLowerCase();
  if (base === "" || command === "") return false;
  for (const seg of command.split(SEPARATORS)) {
    if (seg.trim() === "" || isReadOnlyCommand(seg)) continue;
    const ws = words(seg);
    const prog = program(ws.filter((w) => !/^\d*[<>]/.test(w)));
    const rule = prog?.name === "pdftoppm" ? pdftoppm : prog?.name === "soffice" || prog?.name === "libreoffice" ? soffice : undefined;
    const { reads, writes } = rule === undefined ? { reads: [], writes: false } : rule(prog!.args, base);
    if (writes) return true;
    const readSet = new Set(reads);
    if (ws.some((w) => !readSet.has(w) && spelled(w).some((x) => wordNamesFile(x, file)))) return true;
  }
  return false;
}
