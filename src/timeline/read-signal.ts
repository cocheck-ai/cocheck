// What a call read, for the Files view's "Built from" links. Mirrors write-signal.ts, and like it answers "no" when unsure. Only these count:
//   - the file_path of a Read tool call (certain, so not inferred);
//   - files named in the call's input, unless the call writes them (inferred);
//   - in script text the call runs (a script file an earlier call wrote or the stored version of it, a heredoc body, a -c/-e script): a string literal outside a comment or
//     docstring, wherever it sits (`ROOT / "data/x.csv"`, os.path.join, a function argument, open() for reading), unless every use of it is a write target (see `scriptReads`) (inferred).
// A file the script only writes (to_csv, save, open in w/a/x), or only mentions in a comment, is never an input.

import { SCRIPT_RUNNERS, callWritesFile, inlineScripts, parseShell, scriptsRun, scriptsWrittenBy, stringsOf, type CallText, type ScriptLookup } from "./write-signal.ts";

export interface ReadRef {
  /** The path as the call or script wrote it: absolute, or relative to the folder the script ran in. */
  path: string;
  /** True for a link parsed from a script or a name; false only for a Read tool call's file_path. */
  inferred: boolean;
  /** Where the link came from: a Read tool call ("read": looked at, never an input), a name in the call's own input ("call": opened in the same call), or a string in a script the call runs ("script": named in the script). */
  via: "read" | "call" | "script";
  /** Set by the timeline on a read that resolves to a file the task found and never changed (a source: it has no versions). */
  unchanged?: true;
}

export type ReadCall = CallText & { readPath?: string | null; named?: readonly string[] };

const WRITE_CALL = /\.\s*(?:save|saveAs|SaveAs|SaveAs2|SaveCopyAs|to_csv|to_excel|to_json|to_pickle|to_parquet|write_text|write_bytes|write|writelines|savefig)\s*\(/g;
const OPEN_CALL = /(?<!\w)open\s*\(/g;
const LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const EXCEL_WRITER = /(?<!\w)(?:pd\.|pandas\.)?ExcelWriter\s*\(/g;
const blank = (t: string): string => t.replace(/[^\n]/g, " ");

/** Blanks triple-quoted strings (docstrings) and `#` comments (outside quotes), keeping every index where it was. */
function withoutComments(script: string): string {
  const noDocs = script.replace(/("""|''')[\s\S]*?\1/g, blank);
  return noDocs.split("\n").map((line) => {
    let q = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (q) { if (ch === "\\") i++; else if (ch === q) q = ""; }
      else if (ch === "'" || ch === '"') q = ch;
      else if (ch === "#") return line.slice(0, i) + blank(line.slice(i));
    }
    return line;
  }).join("\n");
}

/** The index just past the call's matching ")" where `from` is just after its "("; -1 when unbalanced. */
function endOf(text: string, from: number): number {
  let depth = 1, q = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === "\\") i++; else if (ch === q) q = ""; continue; }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") { if (--depth === 0) return i + 1; }
  }
  return -1;
}

/** Where the receiver of a method call begins, given the index of the "." before the method: `Path("o.csv")` in `Path("o.csv").write_text(..)`, or `p` in `p.write_text(..)`. */
function receiverStart(text: string, dot: number): number {
  let i = dot;
  if (text[i - 1] === ")") {
    let depth = 0, k = i - 1;
    for (; k >= 0; k--) { if (text[k] === ")") depth++; else if (text[k] === "(" && --depth === 0) break; }
    if (k < 0) return dot;
    i = k;
  }
  while (i > 0 && /[\w.]/.test(text[i - 1]!)) i--;
  return i;
}

const plainPath = (p: string): boolean => p.trim() !== "" && !/[$*?`~{}\\%\[\]]/.test(p);

/**
 * The paths a script reads: every string literal outside a comment or docstring that is not only ever a write target. A literal is a write when it sits in the
 * arguments of a save / to_csv / to_excel / write_text call or an open() in w, a or x mode, or is assigned to a name (`OUT = ROOT / "x"`) whose every use is such an
 * argument (a name never used counts as written unless a call set it). Whatever else a literal is part of (`ROOT / "data/x.csv"`, os.path.join, a function argument, open() for reading) is a read.
 * The caller drops strings that name no changed file, so a literal that is no path costs nothing.
 */
export function scriptReads(script: string): string[] {
  const text = withoutComments(script);
  // the same text with the inside of every string blanked, so a name inside a string or f-string is not a use
  const code = text.replace(LITERAL, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
  const spans: Array<[number, number]> = [];
  for (const m of code.matchAll(WRITE_CALL)) { const e = endOf(code, m.index! + m[0].length); if (e > 0) spans.push([receiverStart(code, m.index!), e]); }
  for (const m of code.matchAll(EXCEL_WRITER)) { const e = endOf(code, m.index! + m[0].length); if (e > 0) spans.push([m.index!, e]); }
  for (const m of code.matchAll(OPEN_CALL)) {
    const start = m.index! + m[0].length, e = endOf(code, start);
    if (e < 0) continue;
    const args = text.slice(start, e - 1);
    // `Path("x").open("w")`: the file is the receiver and the mode is the first argument
    const method = code[m.index! - 1] === ".";
    const mode = /\bmode\s*=\s*(['"])([^'"]*)\1/.exec(args)?.[2] ?? (method ? /^\s*(['"])([^'"]*)\1/ : /^[^,]*,\s*(['"])([^'"]*)\1/).exec(args)?.[2] ?? "";
    if (/[wax]/.test(mode)) spans.push([method ? receiverStart(code, m.index! - 1) : m.index!, e]);
  }
  const inWrite = (i: number): boolean => spans.some(([a, b]) => i >= a && i < b);
  const lineAt = (i: number): { start: number; end: number } => {
    const nl = text.indexOf("\n", i);
    return { start: text.lastIndexOf("\n", i - 1) + 1, end: nl < 0 ? text.length : nl };
  };
  // a name never used is written only when its value is a bare string or path expression; one set by a call (`rows = read_csv("x")`) is read there
  const writtenOnly = (name: string, called: boolean): boolean => {
    const uses = [...code.matchAll(new RegExp(`(?<![\\w.])${name}(?!\\w)(?!\\s*=(?!=))`, "g"))];
    return uses.length === 0 ? !called : uses.every((u) => inWrite(u.index!));
  };
  const out = new Set<string>();
  for (const m of text.matchAll(LITERAL)) {
    const at = m.index!, path = m[2]!;
    if (!plainPath(path) || inWrite(at)) continue;
    const { start, end } = lineAt(at);
    const assign = /^\s*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/.exec(text.slice(start, end));
    if (assign && start + assign[0].length <= at && writtenOnly(assign[1]!, code.slice(start + assign[0].length, at).includes("("))) continue;
    out.add(path);
  }
  return [...out];
}

// "couldn't tell what this script read". A script is unreadable here when a file-opening call in it (open, Path(..).open, read_text / read_bytes, read_*, load_workbook) names a path
// that is not a literal, a name assigned only such values, or a function parameter whose every call passes one (alone, never inside a join). Loop variables, f-strings and joins with
// parameters or loop names are all "unknown". A write-mode open is not a read and is not judged.

/** Splits at top-level occurrences of any of `seps` (single characters), keeping quotes and brackets whole. */
function splitTop(text: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0, q = "", from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === "\\") i++; else if (ch === q) q = ""; continue; }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && seps.includes(ch)) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out;
}

const PLAIN_LITERAL = /^[rRbBuU]{0,2}(['"])(?:\\.|(?!\1)[^\\\n])*\1$/;
const PATH_WRAPPERS = /^(?:(?:os\.path\.)?(?:join|abspath|expanduser|normpath|realpath|dirname)|(?:pathlib\.)?(?:Pure|Windows|Posix)?Path|str|os\.fspath)\s*\(([\s\S]*)\)$/;
const NOT_STATIC = /sys\.argv|input\s*\(|environ|getenv/;

/** Whether the script's text opens only files whose paths it states itself (see the block above). */
export function scriptReadsUnknown(script: string): boolean {
  const text = withoutComments(script);
  const code = text.replace(LITERAL, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
  const defined = new Set([...code.matchAll(/\bdef\s+(\w+)/g)].map((m) => m[1]!));
  const handles = new Set([...code.matchAll(/\bas\s+(\w+)/g)].map((m) => m[1]!));
  const assignments = (name: string): string[] => [...text.matchAll(new RegExp(`^[ \\t]*${name}[ \\t]*(?::[^=\\n]+)?=(?!=)[ \\t]*(.+)$`, "gm"))].map((m) => m[1]!);
  const callArgs = (fn: string): string[][] => [...code.matchAll(new RegExp(`(?<![\\w.])${fn}\\s*\\(`, "g"))].filter((m) => !/\bdef\s+$/.test(code.slice(Math.max(0, m.index! - 8), m.index!))).flatMap((m) => {
    const start = m.index! + m[0].length, e = endOf(code, start);
    return e < 0 ? [] : [splitTop(text.slice(start, e - 1), ",").map((a) => a.trim())];
  });
  const paramOf = (name: string): { fn: string; pos: number } | null => {
    for (const m of code.matchAll(/\bdef\s+(\w+)\s*\(/g)) {
      const e = endOf(code, m.index! + m[0].length);
      if (e < 0) continue;
      const pos = splitTop(text.slice(m.index! + m[0].length, e - 1), ",").map((a) => a.trim().split(/[:=\s]/)[0]).indexOf(name);
      if (pos >= 0) return { fn: m[1]!, pos };
    }
    return null;
  };
  const known = (expr: string, whole: boolean, depth: number): boolean => {
    let e = expr.trim();
    if (depth > 6 || e === "") return false;
    while (e.startsWith("(") && endOf(e, 1) === e.length) e = e.slice(1, -1).trim();
    if (PLAIN_LITERAL.test(e)) return true;
    const parts = splitTop(e, "/+");
    if (parts.length > 1) return parts.every((x) => known(x, false, depth + 1));
    e = e.replace(/(?:\.(?:parent|name|stem|suffix)|\.(?:resolve|absolute|expanduser)\(\))+$/, "");
    if (e === "__file__" || e === "Path.cwd()" || e === "os.getcwd()" || e === "Path()") return true;
    const wrap = PATH_WRAPPERS.exec(e);
    if (wrap) return splitTop(wrap[1]!, ",").map((a) => a.trim()).filter((a) => a !== "").every((a) => known(a, false, depth + 1));
    if (!/^[A-Za-z_]\w*$/.test(e)) return false;
    const set = assignments(e);
    if (set.length > 0) return set.every((rhs) => !NOT_STATIC.test(rhs) && known(rhs, false, depth + 1));
    if (!whole) return false;
    const prm = paramOf(e);
    if (!prm) return false;
    const calls = callArgs(prm.fn);
    return calls.length > 0 && calls.every((a) => (a[prm.pos] !== undefined ? known(a[prm.pos]!, false, depth + 1) : false));
  };
  const firstArg = (args: string): string => {
    const first = splitTop(args, ",")[0]!.trim();
    const kw = /^(?:file|filename|fname|path|filepath_or_buffer|io|filepath)\s*=\s*([\s\S]*)$/.exec(first);
    return kw ? kw[1]! : first;
  };
  const isHandle = (a: string): boolean => /^(?:io\.)?(?:StringIO|BytesIO)\b/.test(a) || (/^[A-Za-z_]\w*$/.test(a) && handles.has(a));
  const check = (path: string, whole = true): boolean => path.trim() === "" || isHandle(path.trim()) || known(path, whole, 0);
  const MODULES = new Set(["io", "gzip", "bz2", "lzma", "codecs"]);
  for (const m of code.matchAll(OPEN_CALL)) {
    const start = m.index! + m[0].length, e = endOf(code, start);
    if (e < 0) return true;
    const args = text.slice(start, e - 1);
    if (code[m.index! - 1] === ".") {
      const dot = m.index! - 1, rs = receiverStart(code, dot);
      const receiver = text.slice(rs, dot).trim();
      const mode = /\bmode\s*=\s*(['"])([^'"]*)\1/.exec(args)?.[2] ?? /^\s*(['"])([^'"]*)\1/.exec(args)?.[2] ?? "";
      const viaModule = MODULES.has(receiver) || (/^[A-Za-z_][\w.]*$/.test(receiver) && assignments(receiver.split(".")[0]!).length === 0 && !handles.has(receiver) && args.trim() !== "" && !/^\s*['"][rwabxt+U]*['"]\s*(?:,|$)/.test(args));
      if (viaModule) { const mm = /\bmode\s*=\s*(['"])([^'"]*)\1/.exec(args)?.[2] ?? /^[^,]*,\s*(['"])([^'"]*)\1/.exec(args)?.[2] ?? ""; if (!/[wax]/.test(mm) && !check(firstArg(args))) return true; continue; }
      if (/[wax]/.test(mode)) continue;
      if (!check(receiver)) return true;
    } else {
      const mode = /\bmode\s*=\s*(['"])([^'"]*)\1/.exec(args)?.[2] ?? /^[^,]*,\s*(['"])([^'"]*)\1/.exec(args)?.[2] ?? "";
      if (/[wax]/.test(mode)) continue;
      if (!check(firstArg(args))) return true;
    }
  }
  for (const m of code.matchAll(/(?<![\w])(?:[\w.]*\.)?(read_\w+|load_workbook)\s*\(/g)) {
    if (defined.has(m[1]!)) continue;
    const start = m.index! + m[0].length, e = endOf(code, start);
    if (e < 0) return true;
    if (!check(firstArg(text.slice(start, e - 1)))) return true;
  }
  for (const m of code.matchAll(/\.\s*(?:read_text|read_bytes)\s*\(/g)) {
    const rs = receiverStart(code, m.index!);
    if (!check(text.slice(rs, m.index!))) return true;
  }
  return false;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Whether the command runs a script file by a plain path: not `-m <module>`, and not a path held in a variable or glob (`$SK/scripts/x.py`), which the task did not write. */
function runsFileByPath(words: string[]): boolean {
  const at = words.findIndex((w) => SCRIPT_RUNNERS.test(w.slice(w.lastIndexOf("/") + 1)));
  const rest = words.slice(at + 1);
  const i = rest.findIndex((w) => !w.startsWith("-") && w !== "<");
  return i >= 0 && rest[i - 1] !== "-m" && !/[$*?`{}\\]/.test(rest[i]!);
}

// A call that runs a program whose reads CoCheck does not judge is "unknown". A command counts only through its first word, after env, sudo, time, nohup, exec, VAR=x, npx, uv run, poetry run, xargs
// and find -exec (`headsOf`); a runner named later in a command (`which node python3`) is an argument. Python, Node, Deno, Bun, tsx and ts-node are judged by their text; a shell script file, piped code,
// `source` of anything but a venv activate script, eval, ruby, perl, php, Rscript, swift, npm run/test, yarn, pnpm, make, just, go run, cargo run, npx of anything but tsx/ts-node, an interpreter
// fed by a pipe, a runner reached through xargs or find -exec with no script text, and an osascript that is not only harmless `tell application` lines (`osaIsHarmless`) are unknown.

const SHELLS = /^(?:bash|sh|zsh|dash|ksh)$/;
const SCRIPT_EXT = /\.(?:py|js|mjs|cjs|ts|mts|sh|bash|zsh|rb|pl|php|R|r|lua|scpt)$/;
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const NOT_PLAIN = /[$*?`{}\\]/;

type Lang = "py" | "js" | "other";
const langOfRunner = (w: string): Lang => { const b = baseName(w); return /^python[\d.]*$/.test(b) ? "py" : /^(?:node|nodejs|deno|bun|tsx|ts-node(?:-esm|-script)?)$/.test(b) ? "js" : "other"; };
const langOfFile = (name: string, text: string): Lang => {
  if (/\.py$/.test(name)) return "py";
  if (/\.(?:js|mjs|cjs|ts|mts)$/.test(name)) return "js";
  const she = /^#!(.*)/.exec(text);
  return she ? (/python/.test(she[1]!) ? "py" : /\b(?:node|deno|bun|tsx|ts-node)\b/.test(she[1]!) ? "js" : "other") : "other";
};

/** Strips `//` and `/* *\/` comments outside quotes, keeping every index where it was. */
function withoutJsComments(script: string): string {
  let out = "", q = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!, nx = script[i + 1];
    if (q) { out += ch; if (ch === "\\" && i + 1 < script.length) out += script[++i]!; else if (ch === q) q = ""; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; out += ch; continue; }
    if (ch === "/" && nx === "/") { while (i < script.length && script[i] !== "\n") { out += " "; i++; } if (i < script.length) out += "\n"; continue; }
    if (ch === "/" && nx === "*") { const e = script.indexOf("*/", i + 2), stop = e < 0 ? script.length : e + 2; out += blank(script.slice(i, stop)); i = stop - 1; continue; }
    out += ch;
  }
  return out;
}

const JS_LITERAL = /^(?:(['"])(?:\\.|(?!\1)[^\\\n])*\1|`[^`$]*`)$/;
const JS_READS = /(?<![\w$])(?:readFileSync|readFile|createReadStream|openSync)\s*\(|(?<![\w$])fs(?:p|\.promises)?\.open\s*\(/g;
const JS_SPAWN = /['"`](?:node:)?child_process['"`]|(?<![\w$.])(?:execSync|execFileSync|spawnSync)\s*\(|\b(?:Bun\.spawn|Deno\.(?:run|Command))\b/;

/** Whether a Node script's text reads files it does not name: a read call (readFileSync, readFile, createReadStream, openSync) whose path is not a literal, a name assigned only such values, or `path.join` of them; or a child process. */
export function jsReadsUnknown(script: string): boolean {
  const text = withoutJsComments(script);
  if (JS_SPAWN.test(text)) return true;
  let code = "", q = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === "\\") { code += "  "; i++; } else if (ch === q) { q = ""; code += ch; } else code += " "; continue; }
    if (ch === "'" || ch === '"' || ch === "`") q = ch;
    code += ch;
  }
  const assignments = (name: string): string[] => [...text.matchAll(new RegExp(`^[ \\t]*(?:(?:const|let|var)[ \\t]+)?${name.replace(/\$/g, "\\$")}[ \\t]*=(?!=)[ \\t]*(.+?);?[ \\t]*$`, "gm"))].map((m) => m[1]!);
  const known = (expr: string, depth: number): boolean => {
    let e = expr.trim();
    if (depth > 6 || e === "") return false;
    while (e.startsWith("(") && endOf(e, 1) === e.length) e = e.slice(1, -1).trim();
    if (JS_LITERAL.test(e)) return true;
    const plus = splitTop(e, "+");
    if (plus.length > 1) return plus.every((x) => known(x, depth + 1));
    if (e === "__dirname" || e === "__filename" || e === "process.cwd()") return true;
    const join = /^(?:path(?:\.posix)?\.)?(?:join|resolve|normalize|dirname|basename)\s*\(([\s\S]*)\)$/.exec(e);
    if (join) return splitTop(join[1]!, ",").map((a) => a.trim()).filter((a) => a !== "").every((a) => known(a, depth + 1));
    if (!/^[A-Za-z_$][\w$]*$/.test(e)) return false;
    const set = assignments(e);
    return set.length > 0 && set.every((rhs) => !/process\.argv|process\.env|readline|prompt\s*\(/.test(rhs) && known(rhs, depth + 1));
  };
  for (const m of code.matchAll(JS_READS)) {
    const start = m.index! + m[0].length, e = endOf(code, start);
    if (e < 0) return true;
    if (!known(splitTop(text.slice(start, e - 1), ",")[0]!, 0)) return true;
  }
  return false;
}

const OSA_WORD = "(?:active|front|first|last|every|documents?|workbooks?|windows?|presentations?|\\d+|\"[^\"\\\\]*\")";
const OSA_CLOSE = new RegExp(`^close(?:\\s+${OSA_WORD}(?:\\s+${OSA_WORD})*)?(?:\\s+saving\\s+no)?$`, "i");
const OSA_STMT = (stmt: string): boolean => /^(?:quit|activate)$/i.test(stmt) || OSA_CLOSE.test(stmt);

/** Whether AppleScript text (the `-e` literals joined by newlines) is only `tell application "<literal>"` lines or blocks of quit, activate and close statements, with no comment. */
export function osaIsHarmless(script: string): boolean {
  if (/--|#|\(\*/.test(script)) return false;
  let depth = 0, seen = false;
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    seen = true;
    const one = /^tell\s+application\s+"[^"\\]*"\s+to\s+(.+)$/i.exec(line);
    if (one) { if (depth !== 0 || !OSA_STMT(one[1]!)) return false; continue; }
    if (/^tell\s+application\s+"[^"\\]*"$/i.test(line)) { if (depth !== 0) return false; depth = 1; continue; }
    if (/^end\s+tell$/i.test(line)) { if (depth !== 1) return false; depth = 0; continue; }
    if (depth !== 1 || !OSA_STMT(line)) return false;
  }
  return seen && depth === 0;
}

interface Head {
  /** The words from the program that runs. */
  words: string[];
  /** Reached through xargs or find -exec, so the arguments it gets are not in the text. */
  wrapped: boolean;
  /** The command runs something CoCheck cannot see (npx of any other package). */
  unknown: boolean;
}

const SHELL_KEYWORD = /^(?:do|then|else|elif|if|while|until|!|\{|time|nohup|exec|command|builtin)$/;
const ASSIGN_WORD = /^[A-Za-z_]\w*=/;
/** Wrappers that run the words after their own flags: the flags that take a value as the next word. */
const WRAPPERS: Record<string, RegExp> = { sudo: /^-[ughpCDRTU]$/, timeout: /^-[ks]$/, nice: /^-n$/, caffeinate: /^-[tw]$/, arch: /^$/, setsid: /^$/, stdbuf: /^$/ };
const UV_VALUE = /^--?(?:with|python|p|w|project|directory|with-requirements|env-file|extra|group|package|from)$/;

/** The programs a command runs, after env, sudo, time, nohup, exec, VAR=x, npx, uv run, poetry run, xargs and find -exec are looked through. Several `-exec` of one find give several. */
function headsOf(words: string[], wrapped = false, depth = 0): Head[] {
  let w = words.slice();
  for (let guard = 0; guard < 16; guard++) {
    while (w.length > 0 && (ASSIGN_WORD.test(w[0]!) || SHELL_KEYWORD.test(w[0]!))) w.shift();
    const h = baseName(w[0] ?? "");
    if (h === "env") {
      w.shift();
      while (w.length > 0 && (w[0]!.startsWith("-") || ASSIGN_WORD.test(w[0]!))) { const o = w.shift()!; if (/^(?:-u|-C|-S|--unset|--chdir)$/.test(o)) w.shift(); }
      continue;
    }
    if (Object.hasOwn(WRAPPERS, h)) {
      w.shift();
      while (w.length > 0 && w[0]!.startsWith("-")) { const o = w.shift()!; if (WRAPPERS[h]!.test(o)) w.shift(); }
      if (h === "timeout") w.shift();
      continue;
    }
    if (h === "npx") {
      w.shift();
      while (w.length > 0 && w[0]!.startsWith("-")) { const o = w.shift()!; if (/^(?:-c|--call)$/.test(o)) return [{ words: w, wrapped, unknown: true }]; if (/^(?:-p|--package)$/.test(o)) w.shift(); }
      if (!/^(?:tsx|ts-node(?:-esm|-script)?)$/.test(baseName(w[0] ?? ""))) return [{ words: w, wrapped, unknown: true }];
      continue;
    }
    if ((h === "uv" || h === "poetry") && w[1] === "run") {
      w = w.slice(2);
      while (w.length > 0 && w[0]!.startsWith("-") && w[0] !== "--") { const o = w.shift()!; if (UV_VALUE.test(o)) w.shift(); }
      if (w[0] === "--") w.shift();
      if (/\.py$/.test(w[0] ?? "")) w.unshift("python3");
      continue;
    }
    if (h === "xargs") {
      w.shift();
      while (w.length > 0 && w[0]!.startsWith("-")) { const o = w.shift()!; if (/^-[IJLnPsdEa]$/.test(o)) w.shift(); }
      wrapped = true;
      continue;
    }
    if (h === "find" && depth < 4) {
      const out: Head[] = [];
      for (let i = 0; i < w.length; i++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(w[i]!)) continue;
        let e = i + 1;
        while (e < w.length && w[e] !== ";" && w[e] !== "+") e++;
        out.push(...headsOf(w.slice(i + 1, e), true, depth + 1));
        i = e;
      }
      return out.length > 0 ? out : [{ words: w, wrapped, unknown: false }];
    }
    break;
  }
  return [{ words: w, wrapped, unknown: false }];
}

/** A program that builds or runs project scripts CoCheck cannot read. */
function runsProjectScripts(w: string[]): boolean {
  const b = baseName(w[0] ?? "");
  const sub = w.slice(1).find((x) => !x.startsWith("-")) ?? "";
  if (b === "npm") return /^(?:run|run-script|test|t|tst|start|exec|x|rum|urn)$/.test(sub);
  if (/^(?:yarn|pnpm|make|gmake|just)$/.test(b)) return true;
  return (b === "go" || b === "cargo") && sub === "run";
}

const VENV_ACTIVATE = /(?:^|\/)\.?venv\/bin\/activate$/;

/** Whether a shell is given a file to run, by any path (a variable path is a script CoCheck cannot read either), or input read from a file. */
function shellRunsFile(words: string[]): boolean {
  return words.slice(1).some((w) => !w.startsWith("-") && w !== "<");
}

interface CallScripts {
  run: { commands: string[]; scripts: string[] };
  missing: string[];
  /** Script texts with the language that runs them, for the unknown-reads judgement. */
  typed: Array<{ text: string; lang: Lang }>;
  /** A program ran whose reads have no reader here (a shell script file, an interpreter without a reader, a launched script of such a kind). */
  unjudged: boolean;
}

/** The scripts a call runs: a script file (the stored text), a heredoc fed to an interpreter, a -c/-e script; and the names of script files it runs whose text is not known. */
function scriptsOfCall(call: ReadCall, lookup?: ScriptLookup): CallScripts {
  const input = call.input as Record<string, unknown> | null | undefined;
  const commands = [call.command ?? "", ...(input && typeof input === "object" && typeof input.command === "string" ? [input.command] : [])];
  const scripts: string[] = [];
  const missing: string[] = [];
  const typed: CallScripts["typed"] = [];
  let unjudged = false;
  const sameCall = new Map(scriptsWrittenBy(call).map((w) => [w.name, w.text]));
  const addTyped = (text: string, lang: Lang): void => { scripts.push(text); if (lang === "other") unjudged = true; else typed.push({ text, lang }); };
  // the program a command runs, judged by what it is: its text when it is Python or Node text, unknown when CoCheck cannot read what it reads
  const judge = (hd: Head, piped: boolean, depth: number): void => {
    if (hd.unknown) { unjudged = true; return; }
    const w = hd.words;
    const head = w[0] ?? "";
    const b = baseName(head);
    if (/^(?:source|\.)$/.test(head)) { if (w[1] === undefined || !VENV_ACTIVATE.test(w[1])) unjudged = true; return; }
    if (b === "eval" || /^(?:swift|swiftc)$/.test(b) || runsProjectScripts(w)) { unjudged = true; return; }
    if (b === "osascript") {
      const lits: string[] = [];
      let only = !piped;
      for (let i = 1; i < w.length; i++) { if (w[i] === "-e" && i + 1 < w.length) lits.push(w[++i]!); else only = false; }
      scripts.push(...lits);
      if (!only || lits.length === 0 || !osaIsHarmless(lits.join("\n"))) unjudged = true;
      return;
    }
    if (SHELLS.test(b)) {
      if (piped) unjudged = true;
      const cflag = w.findIndex((x, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
      if (cflag >= 0) { if (w[cflag + 1] !== undefined && depth < 3) walk(w[cflag + 1]!, depth + 1); else unjudged = true; return; }
      // a script file, whatever its path, or code read from a file
      if (shellRunsFile(w)) unjudged = true;
      return;
    }
    if (SCRIPT_RUNNERS.test(b)) {
      const lang = langOfRunner(head);
      if (piped) unjudged = true;
      const inline = inlineScripts(w);
      for (const s of inline) addTyped(s, lang);
      const names = scriptsRun(w);
      for (const name of names) {
        const latest = sameCall.get(name) ?? lookup?.(name).at(-1);
        if (latest !== undefined) addTyped(latest, lang);
        else if (runsFileByPath(w)) missing.push(name);
      }
      if (lang === "other") unjudged = true;
      if (hd.wrapped && inline.length === 0 && names.length === 0) unjudged = true;
      return;
    }
    if (head.includes("/") && !NOT_PLAIN.test(head)) {
      const name = baseName(head);
      const latest = sameCall.get(name) ?? lookup?.(name).at(-1);
      if (latest !== undefined) addTyped(latest, langOfFile(name, latest));
      else if (SCRIPT_EXT.test(name)) missing.push(name);
    }
  };
  const walk = (text: string, depth: number): void => {
    const parsed = parseShell(text);
    parsed.commands.forEach((c) => { for (const hd of headsOf(c.words)) judge(hd, c.piped === true, depth); });
    // a heredoc is read only when it feeds an interpreter (`python3 - <<EOF`); one written into a file (`cat > build.py <<EOF`) is a script being made, not run
    parsed.bodies.forEach((body, i) => {
      const owner = parsed.commands[parsed.owners[i]!];
      if (!owner) return;
      const hd = headsOf(owner.words)[0];
      const b = baseName(hd?.words[0] ?? "");
      if (hd === undefined) return;
      if (b === "osascript") { scripts.push(body); unjudged = true; }
      else if (SCRIPT_RUNNERS.test(b)) addTyped(body, langOfRunner(hd.words[0]!));
      else if (SHELLS.test(b) && depth < 3) walk(body, depth + 1);
    });
  };
  for (const text of commands) walk(text, 0);
  return { run: { commands, scripts }, missing, typed, unjudged };
}

/** Whether the call ran a script whose text is missing, a program CoCheck cannot read, or a script whose file-opening calls name a path the text does not state. */
export function callReadsUnknown(call: ReadCall, lookup?: ScriptLookup): boolean {
  const { missing, typed, unjudged } = scriptsOfCall(call, lookup);
  return unjudged || missing.length > 0 || typed.some((t) => (t.lang === "py" ? scriptReadsUnknown(t.text) : jsReadsUnknown(t.text)));
}

/** What one call read. `lookup` gives the text of script files the call may run (newest last). */
export function callReads(call: ReadCall, lookup?: ScriptLookup): ReadRef[] {
  const RANK = { read: 0, call: 1, script: 2 } as const;
  const out = new Map<string, ReadRef["via"]>();
  const add = (path: string, via: ReadRef["via"]): void => {
    if (path === "") return;
    const had = out.get(path);
    if (had === undefined || RANK[via] > RANK[had]) out.set(path, via);
  };
  const { commands, scripts } = scriptsOfCall(call, lookup).run;
  scripts.push(...stringsOf(call.input, new Set(["command", "file_path", "notebook_path", "path", "content", "new_string", "old_string"])));
  // A script that only compares what it opens and writes nothing makes nothing from it: its files are looked at, never inputs. A shell redirect or tee in the command voids that (its output goes somewhere).
  const redirects = commands.some((c) => REDIRECT_OUT.test(stripScripts(c, scripts)));
  const checks = redirects ? [] : scripts.filter(checksOnly);
  const rest = [...commands.map((c) => stripScripts(c, checks)), ...scripts.filter((t) => !checks.includes(t))].join("\n");
  // a path as the text may hold it: whole, or its last two or more segments (`$D/output/x.xlsx` for the absolute path of that file)
  const holds = (text: string, f: string): boolean => { const seg = f.split("/"); for (let k = 0; k <= seg.length - 2; k++) if (text.includes(seg.slice(k).join("/"))) return true; return false; };
  const onlyChecked = (f: string): boolean => checks.some((t) => holds(t, f)) && !holds(rest, f);
  if (call.tool === "Read" && typeof call.readPath === "string") add(call.readPath, "read");
  if (!call.tool || !WRITE_TOOLS.has(call.tool)) {
    for (const f of call.named ?? []) if (call.tool !== "Read" && !callWritesFile(call, f, lookup) && !onlyChecked(f)) add(f, "call");
  }
  for (const s of scripts) if (!checks.includes(s)) for (const p of scriptReads(s)) add(p, "script");
  // the script file a call runs is an input of what the call makes, whether or not its text is known
  for (const text of commands) for (const c of parseShell(text).commands) for (const hd of headsOf(c.words)) if (!hd.unknown) for (const name of scriptsRun(hd.words)) add(name, "script");
  return [...out].map(([path, via]) => ({ path, via, inferred: via !== "read" }));
}

// A shell redirect to a file (not /dev/null, not an fd dup) or tee: the command's output goes somewhere, so a script in it is not a check
const REDIRECT_OUT = /(?:^|[^<>&\w-])\d?>>?\s*(?!\/dev\/null|&)[^\s&|;)]|\btee\b/;
const stripScripts = (command: string, scripts: readonly string[]): string => scripts.reduce((c, s) => (s.length > 0 ? c.split(s).join(" ") : c), command);
// Compare-only is an ALLOW-list, not a list of write forms to rule out. A Python script is compare-only only when every statement (split at top-level newlines and `;`) is
//   - an import;
//   - `name = <read>(plain args)`: load_workbook, read_*, open (no write mode), loadtxt, genfromtxt, load, optionally `.read()` / `.readlines()`;
//   - `print(<expr>)`, `assert <expr>` or a bare `filecmp.cmp(..)`, where <expr> holds a comparison (== != filecmp.cmp .equals assert*Equal) and every call in it is a read or one of the plain helpers below.
// Anything else (any other call, a loop, `with`, `if`, a def, an assignment from a non-read, a Node script) is not compare-only, so its inputs stay.
const COMPARES = /==|!=|filecmp\.cmp|\.equals\s*\(|assert\w*Equal\w*\s*\(/;
const READER = /^(?:[\w.]+\.)?(?:load_workbook|read_\w+|open|loadtxt|genfromtxt|load)$/;
const HELPER = /^(?:all|any|len|sorted|list|set|tuple|dict|str|repr|bool|int|float|range|zip|enumerate|iter_rows|iter_cols|values|items|keys|read|readlines|hexdigest|sha1|sha256|md5|cmp|equals|assert\w*Equal\w*)$/;
const WRITE_MODE = /\bmode\s*=\s*['"][^'"]*[wax+]|^[^,]*,\s*['"][^'"]*[wax+]/;

/** The call names in an expression (strings blanked), each with its argument text; null when a call is not an allowed read or helper. */
function plainCalls(expr: string): boolean {
  const code = expr.replace(LITERAL, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
  for (const m of code.matchAll(/([A-Za-z_][\w.]*)\s*\(/g)) {
    const name = m[1]!, last = name.slice(name.lastIndexOf(".") + 1);
    const end = endOf(code, m.index! + m[0].length);
    if (end < 0) return false;
    if (READER.test(name)) { if (WRITE_MODE.test(expr.slice(m.index! + m[0].length, end - 1))) return false; continue; }
    if (name === "filecmp.cmp" || HELPER.test(last)) continue;
    return false;
  }
  return !/:=|\blambda\b|\byield\b|\bawait\b/.test(code);
}

/** A script that only compares what it opens: see the allow-list above. */
function checksOnly(script: string): boolean {
  const text = withoutComments(script);
  if (!COMPARES.test(text) || /\\\s*$/m.test(text)) return false;
  const statements = splitTop(text, "\n;").map((x) => x.trim()).filter((x) => x !== "");
  if (statements.length === 0) return false;
  return statements.every((st) => {
    if (/^(?:import|from)\s+[\w.]+(?:\s+import\s+[\w., *]+|(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)$/.test(st)) return true;
    const assign = /^[A-Za-z_]\w*\s*=(?!=)\s*([\s\S]+)$/.exec(st);
    if (assign) {
      const rhs = assign[1]!.trim().replace(/\.(?:read|readlines)\(\)$/, "");
      const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(rhs);
      return call !== null && READER.test(call[1]!) && endOf(rhs, call[0].length) === rhs.length && plainCalls(rhs);
    }
    const shown = /^print\s*\(([\s\S]*)\)$/.exec(st)?.[1] ?? /^assert\s+([\s\S]+)$/.exec(st)?.[1] ?? (/^filecmp\.cmp\s*\(/.test(st) ? st : null);
    return shown !== null && COMPARES.test(shown) && plainCalls(shown);
  });
}
