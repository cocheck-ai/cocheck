// Win32 only: which files a PowerShell or cmd command can write, read from its text alone, for `writeScope` (write-scope.ts). The same
// contract as the Git Bash reader there: the exact set of paths, or UNKNOWN (a thrown `WinUnknown`) for anything not fully understood, and
// UNKNOWN never excludes a call from a file.
//
// The bound. PowerShell: Set-Content, Add-Content, Out-File, New-Item -ItemType File|Directory, Copy-Item, Move-Item, Remove-Item,
// Rename-Item, with -Path/-LiteralPath/-Destination (named, unambiguous prefixes, or positional), `>`/`>>` redirection, a two-element pipeline
// from a literal string into Set-Content/Add-Content/Out-File with an explicit path, and `powershell(.exe)|pwsh(.exe) -Command` wrappers.
// cmd (reached only through a `cmd /c` wrapper): copy, move, del/erase, ren/rename, mkdir/md, type and echo with `>`/`>>`. Paths are
// literal drive forms (`C:\a\b`, `C:/a/b`) or relative, mapped to Git Bash's `/c/a/b` and held to `plainDrivePath` by the caller's resolver.
// Any variable, subexpression, script block, wildcard, comma list, backtick or caret escape, `%X%`, alias, unlisted cmdlet or parameter,
// parameter colon form, UNC or drive-relative path, comment or other construct: UNKNOWN. Names are read at face value: a profile alias
// or function that shadows a listed cmdlet is not seen (the same bound as the bash reader's).
import path from "node:path";

export class WinUnknown extends Error {}
function no(why: string): never {
  throw new WinUnknown(why);
}

interface WinTarget {
  path: string;
  tree: boolean;
  removes?: true;
}

export interface WinCtx {
  /** A path in the analyzer's POSIX shape (`/c/x` or relative with `/`), resolved against the cwd; throws when not a plain drive form. */
  resolve(p: string): string[];
  push(t: WinTarget): void;
  /** True only when the path is known, before the command ran, to be something other than a directory. */
  fileAtPre(p: string): boolean;
}

const MAX_DEPTH = 3;

/** A Windows path word as the analyzer's POSIX shape: `C:\a\b` and `C:/a/b` become `/c/a/b`; a relative `a\b` becomes `a/b`. */
function posixOf(p: string, cmd: boolean): string {
  if (p === "") no("empty path");
  if (/[*?[\]]/.test(p)) no("wildcard in a path");
  if (cmd && p.includes("/")) no("cmd path with a forward slash (a switch to cmd)");
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m) return `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`;
  if (/^[\\/]/.test(p)) no("root-relative or UNC path");
  if (/^[A-Za-z]:/.test(p)) no("drive-relative path");
  return p.replace(/\\/g, "/");
}

function resolveWin(ctx: WinCtx, p: string, cmd: boolean): string[] {
  return ctx.resolve(posixOf(p, cmd));
}

function push(ctx: WinCtx, paths: string[], tree: boolean, removes = false): void {
  for (const p of paths) ctx.push({ path: p, tree, ...(removes ? { removes: true as const } : {}) });
}

/** dest/<basename of src> for each resolved dest and src: what a copy or move writes when the destination is an existing directory. */
function intoDir(ctx: WinCtx, dests: string[], srcs: string[], tree: boolean): void {
  for (const d of dests) {
    for (const s of srcs) {
      const name = path.posix.basename(s);
      if (name === "" || name === "." || name === "..") no("source without a name");
      push(ctx, ctx.resolve(path.posix.join(d, name)), tree);
    }
  }
}

// ---------------------------------------------------------------- PowerShell

type PsTok = { k: "word"; s: string; quoted: boolean } | { k: "param"; name: string } | { k: "op"; op: string } | { k: "redir"; target: string | null };

const DELIM = /[ \t\r\n;|&<>]/;

function psLex(s: string): PsTok[] {
  if (/[\u2013-\u2015\u2018-\u201f]/.test(s)) no("PowerShell smart quote or dash");
  const out: PsTok[] = [];
  let i = 0;
  const atBoundary = (): boolean => i === 0 || /[ \t\r\n;|&]/.test(s[i - 1]!);
  const endOfToken = (): void => {
    if (i < s.length && !DELIM.test(s[i]!)) no("PowerShell token joined to another");
  };
  const readValue = (): { s: string; quoted: boolean } => {
    const c = s[i]!;
    if (c === "'") {
      let v = "";
      i++;
      for (;;) {
        if (i >= s.length) no("unclosed quote");
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += s[i++];
      }
      endOfToken();
      return { s: v, quoted: true };
    }
    if (c === '"') {
      let v = "";
      i++;
      for (;;) {
        if (i >= s.length) no("unclosed quote");
        const d = s[i]!;
        if (d === "$" || d === "`") no("expansion or escape inside a double-quoted string");
        if (d === '"') {
          if (s[i + 1] === '"') {
            v += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += d;
        i++;
      }
      endOfToken();
      return { s: v, quoted: true };
    }
    let v = "";
    while (i < s.length && !DELIM.test(s[i]!)) {
      const d = s[i]!;
      if (/[(){}[\],`$@'"]/.test(d)) no(`PowerShell ${d} in a bare word`);
      v += d;
      i++;
    }
    if (v === "") no("empty PowerShell token");
    if (v.startsWith("#")) no("PowerShell comment");
    if (v === "--%") no("PowerShell stop-parsing token");
    return { s: v, quoted: false };
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\r" || c === "\n" || c === ";") {
      out.push({ k: "op", op: ";" });
      i++;
      continue;
    }
    if (c === "|") {
      if (s[i + 1] === "|") {
        out.push({ k: "op", op: ";" });
        i += 2;
      } else {
        out.push({ k: "op", op: "|" });
        i++;
      }
      continue;
    }
    if (c === "&") {
      if (s[i + 1] !== "&") no("PowerShell call or background operator");
      out.push({ k: "op", op: ";" });
      i += 2;
      continue;
    }
    if (c === "<") no("PowerShell input redirect");
    const r = /^([1-6*])?>(>)?/.exec(s.slice(i));
    if (r && (c === ">" || atBoundary())) {
      if (!atBoundary()) no("redirect joined to a word");
      i += r[0].length;
      if (s[i] === "&") {
        if (!/^&[12](?=$|[ \t\r\n;|])/.test(s.slice(i))) no("odd redirect duplication");
        i += 2;
        continue;
      }
      while (s[i] === " " || s[i] === "\t") i++;
      if (i >= s.length || DELIM.test(s[i]!)) no("redirect without a target");
      if (/^\$null(?=$|[ \t\r\n;|&<>])/i.test(s.slice(i))) {
        i += 5;
        out.push({ k: "redir", target: null });
        continue;
      }
      out.push({ k: "redir", target: readValue().s });
      continue;
    }
    const v = readValue();
    if (!v.quoted && v.s.startsWith("-") && /^-[A-Za-z_?]/.test(v.s)) {
      if (!/^-[A-Za-z_][A-Za-z0-9_]*$/.test(v.s)) no(`PowerShell parameter form ${v.s}`);
      out.push({ k: "param", name: v.s.slice(1) });
    } else out.push({ k: "word", ...v });
  }
  return out;
}

type Kind = "path" | "lpath" | "dest" | "value" | "flag" | "name" | "type" | "deny";
interface Spec {
  params: Record<string, Kind>;
  aliases: Record<string, string>;
  positional: string[];
}

const COMMON: Record<string, Kind> = {
  Verbose: "flag", Debug: "flag", ErrorAction: "value", WarningAction: "value", InformationAction: "value", ProgressAction: "value",
  ErrorVariable: "deny", WarningVariable: "deny", InformationVariable: "deny", OutVariable: "deny", OutBuffer: "deny", PipelineVariable: "deny",
  WhatIf: "flag", Confirm: "flag", UseTransaction: "deny",
};
const COMMON_ALIASES: Record<string, string> = {
  vb: "Verbose", db: "Debug", ea: "ErrorAction", wa: "WarningAction", infa: "InformationAction", proga: "ProgressAction", ev: "ErrorVariable",
  wv: "WarningVariable", iv: "InformationVariable", ov: "OutVariable", ob: "OutBuffer", pv: "PipelineVariable", wi: "WhatIf", cf: "Confirm", usetx: "UseTransaction",
};
const spec = (params: Record<string, Kind>, aliases: Record<string, string>, positional: string[]): Spec => ({ params: { ...params, ...COMMON }, aliases: { ...aliases, ...COMMON_ALIASES }, positional });
const LP = { PSPath: "LiteralPath", LP: "LiteralPath" };
const CONTENT = spec({ Path: "path", LiteralPath: "lpath", Value: "value", Encoding: "value", NoNewline: "flag", Force: "flag", PassThru: "flag", AsByteStream: "flag", Filter: "deny", Include: "deny", Exclude: "deny", Credential: "deny", Stream: "deny" }, LP, ["Path", "Value"]);
const CMDLETS: Record<string, Spec> = {
  "set-content": CONTENT,
  "add-content": CONTENT,
  "out-file": spec({ FilePath: "path", LiteralPath: "lpath", Encoding: "value", Append: "flag", Force: "flag", NoClobber: "flag", Width: "value", NoNewline: "flag", InputObject: "value" }, { ...LP, Path: "FilePath", NoOverwrite: "NoClobber" }, ["FilePath", "Encoding"]),
  "new-item": spec({ Path: "path", Name: "name", ItemType: "type", Value: "value", Force: "flag", Credential: "deny" }, { Type: "ItemType", Target: "Value" }, ["Path"]),
  "copy-item": spec({ Path: "path", LiteralPath: "lpath", Destination: "dest", Container: "flag", Force: "flag", Recurse: "flag", PassThru: "flag", Filter: "deny", Include: "deny", Exclude: "deny", Credential: "deny", FromSession: "deny", ToSession: "deny" }, LP, ["Path", "Destination"]),
  "move-item": spec({ Path: "path", LiteralPath: "lpath", Destination: "dest", Force: "flag", PassThru: "flag", Filter: "deny", Include: "deny", Exclude: "deny", Credential: "deny" }, LP, ["Path", "Destination"]),
  "remove-item": spec({ Path: "path", LiteralPath: "lpath", Recurse: "flag", Force: "flag", Filter: "deny", Include: "deny", Exclude: "deny", Credential: "deny", Stream: "deny" }, LP, ["Path"]),
  "rename-item": spec({ Path: "path", LiteralPath: "lpath", NewName: "name", Force: "flag", PassThru: "flag", Credential: "deny" }, LP, ["Path", "NewName"]),
};

/** A parameter token's canonical name: an exact name or alias, else the one name whose names or aliases it is a prefix of; anything else UNKNOWN. */
function paramName(sp: Spec, tok: string): string {
  const t = tok.toLowerCase();
  const all: Array<[string, string]> = [...Object.keys(sp.params).map((n) => [n, n] as [string, string]), ...Object.entries(sp.aliases)];
  const exact = all.find(([n]) => n.toLowerCase() === t);
  if (exact) return exact[1];
  const hits = new Set(all.filter(([n]) => n.toLowerCase().startsWith(t)).map(([, c]) => c));
  if (hits.size !== 1) no(`PowerShell parameter -${tok} is unknown or ambiguous`);
  return [...hits][0]!;
}

type Words = Array<Extract<PsTok, { k: "word" } | { k: "param" }>>;

/** Binds a listed cmdlet's arguments: named first, then positionals in order. Each value is a single literal word. */
function bind(sp: Spec, words: Words): Map<string, string | true> {
  const got = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.k === "word") {
      pos.push(w.s);
      continue;
    }
    const name = paramName(sp, w.name);
    const kind = sp.params[name]!;
    if (kind === "deny") no(`PowerShell parameter -${name}`);
    if (got.has(name)) no(`PowerShell parameter -${name} given twice`);
    if (kind === "flag") {
      got.set(name, true);
      continue;
    }
    const v = words[++i];
    if (v === undefined || v.k !== "word") no(`PowerShell parameter -${name} without a value`);
    if (!v.quoted && v.s.startsWith("-")) no(`PowerShell value of -${name} looks like a parameter`);
    got.set(name, v.s);
  }
  let k = 0;
  for (const p of pos) {
    while (k < sp.positional.length && got.has(sp.positional[k]!)) k++;
    if (k >= sp.positional.length) no("PowerShell positional argument with no parameter");
    got.set(sp.positional[k]!, p);
    k++;
  }
  return got;
}

function psCmdlet(cmd: string, words: Words, ctx: WinCtx, piped: boolean): void {
  const sp = CMDLETS[cmd]!;
  const got = bind(sp, words);
  const str = (n: string): string | undefined => {
    const v = got.get(n);
    return typeof v === "string" ? v : undefined;
  };
  const pathParam = cmd === "out-file" ? "FilePath" : "Path";
  if (got.has(pathParam) && got.has("LiteralPath")) no("both -Path and -LiteralPath");
  const p = str(pathParam) ?? str("LiteralPath");
  if (p === undefined) no(`${cmd} without a literal path`);
  if (piped && !["set-content", "add-content", "out-file"].includes(cmd)) no(`pipeline into ${cmd}`);
  const src = resolveWin(ctx, p!, false);
  switch (cmd) {
    case "set-content":
    case "add-content":
    case "out-file":
      push(ctx, src, false);
      return;
    case "new-item": {
      const type = str("ItemType")?.toLowerCase();
      if (type !== "file" && type !== "directory") no("New-Item without -ItemType File or Directory");
      const name = str("Name");
      if (name !== undefined && /^[A-Za-z]:|^[\\/]/.test(name)) no("New-Item -Name that is a path");
      const where = name === undefined ? src : src.flatMap((s) => ctx.resolve(path.posix.join(s, posixOf(name, false))));
      // a directory changes no file (as mkdir): its path is checked, nothing is written
      if (type === "file") push(ctx, where, false);
      return;
    }
    case "remove-item":
      push(ctx, src, true, true);
      return;
    case "rename-item": {
      const nn = str("NewName");
      if (nn === undefined || /[\\/:]/.test(nn) || nn === "." || nn === "..") no("Rename-Item without a plain -NewName");
      push(ctx, src, true, true);
      for (const s of src) push(ctx, ctx.resolve(path.posix.join(path.posix.dirname(s), posixOf(nn!, false))), true);
      return;
    }
    case "copy-item":
    case "move-item": {
      const d = str("Destination");
      if (d === undefined) no(`${cmd} without a literal -Destination`);
      const dests = resolveWin(ctx, d!, false);
      const tree = cmd === "move-item" || got.get("Recurse") === true;
      // the source is read, not written (a copy); a move takes it away
      if (cmd === "move-item") push(ctx, src, true, true);
      push(ctx, dests, tree);
      intoDir(ctx, dests, src, tree);
      return;
    }
  }
}

export const PS_WRAPPERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const CMD_WRAPPERS = new Set(["cmd", "cmd.exe"]);

/**
 * The script a `powershell|pwsh [options] -Command <words>` wrapper runs (its words joined by spaces, as the host does), from the words
 * after the program name. `fromGitBash`: the words came through Git Bash, which rewrites arguments that look like POSIX paths, so any word
 * piece starting with `/` or holding `=` is UNKNOWN.
 */
export function psWrapperScript(args: string[], fromGitBash: boolean): string {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!.toLowerCase();
    if (a === "-noprofile" || a === "-nop" || a === "-noninteractive" || a === "-noni" || a === "-nologo" || a === "-nol") continue;
    if (a === "-executionpolicy" || a === "-ep" || a === "-ex" || a === "-exec") {
      if (!/^(bypass|unrestricted|remotesigned)$/i.test(args[++i] ?? "")) no("powershell -ExecutionPolicy value");
      continue;
    }
    if (a === "-command" || a === "-c") break;
    no(`powershell option ${args[i]}`);
  }
  const rest = args.slice(i + 1);
  if (i >= args.length || rest.length === 0) no("powershell without -Command and a script");
  for (const a of rest) {
    if (a === "" || a.includes('"')) no("powershell -Command word with a double quote");
    if (/\s/.test(a) && a.endsWith("\\")) no("powershell -Command word ending in a backslash");
    if (a.startsWith("{") || a === "-") no("powershell -Command script block or stdin");
    if (fromGitBash && (a.includes("=") || a.split(/\s+/).some((x) => /^['"]?\//.test(x)))) no("Git Bash would rewrite a path-like argument");
  }
  return rest.join(" ");
}

/** The line a `cmd [/d] [/q] /c <words>` wrapper runs, from the words after the program name: words joined, a word with blanks quoted, then cmd's own outer-quote strip. */
function cmdWrapperLine(args: string[]): string {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!.toLowerCase();
    if (a === "/d" || a === "/q") continue;
    if (a === "/c") break;
    no(`cmd option ${args[i]}`);
  }
  const rest = args.slice(i + 1);
  if (i >= args.length || rest.length === 0) no("cmd without /c and a command");
  for (const a of rest) {
    if (a === "" || a.includes('"')) no("cmd /c word with a double quote");
    if (/\s/.test(a) && a.endsWith("\\")) no("cmd /c word ending in a backslash");
  }
  const line = rest.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  // cmd /c: a line that starts with a quote loses that quote and the last one (the quoted text is never an executable's name here: it
  // starts with a listed built-in and holds a blank)
  if (line.startsWith('"')) {
    const last = line.lastIndexOf('"');
    return line.slice(1, last) + line.slice(last + 1);
  }
  return line;
}

/** Reads a PowerShell script (several statements); every write goes to `ctx`. */
export function readPowerShell(script: string, ctx: WinCtx, depth = 0): void {
  if (depth > MAX_DEPTH) no("wrappers nested too deep");
  const toks = psLex(script);
  const stmts: PsTok[][] = [[]];
  for (const t of toks) {
    if (t.k === "op" && t.op === ";") stmts.push([]);
    else stmts[stmts.length - 1]!.push(t);
  }
  let any = false;
  for (const st of stmts) {
    if (st.length === 0) continue;
    any = true;
    const elems: PsTok[][] = [[]];
    for (const t of st) {
      if (t.k === "op") elems.push([]);
      else elems[elems.length - 1]!.push(t);
    }
    if (elems.some((e) => e.length === 0)) no("empty pipeline element");
    if (elems.length > 2) no("PowerShell pipeline of more than two elements");
    elems.forEach((e, n) => {
      for (const t of e) if (t.k === "redir" && t.target !== null) push(ctx, resolveWin(ctx, t.target, false), false);
      const words = e.filter((t): t is Words[number] => t.k === "word" || t.k === "param");
      if (words.length === 0) no("redirect without a command");
      const head = words[0]!;
      if (head.k === "word" && head.quoted) {
        // a literal string: printed (or piped into the sink that follows)
        if (n !== 0 || words.length !== 1) no("PowerShell expression");
        return;
      }
      if (head.k !== "word") no("PowerShell statement starting with a parameter");
      const name = head.s.toLowerCase();
      const rest = words.slice(1);
      if (name in CMDLETS) {
        if (n === 1 && !(elems[0]!.length > 0 && elems[0]!.every((t) => t.k === "redir" || (t.k === "word" && t.quoted)))) no("pipeline from something other than a literal string");
        psCmdlet(name, rest, ctx, n === 1);
        return;
      }
      if (elems.length !== 1) no(`pipeline with ${head.s}`);
      if (rest.some((w) => w.k === "word" && w.quoted && /\s/.test(w.s) && w.s.endsWith("\\"))) no("wrapper word ending in a backslash");
      const values = rest.map((w) => (w.k === "param" ? `-${w.name}` : w.s));
      if (PS_WRAPPERS.has(name)) return readPowerShell(psWrapperScript(values, false), ctx, depth + 1);
      if (CMD_WRAPPERS.has(name)) return readCmd(cmdWrapperLine(values), ctx, depth + 1);
      no(`PowerShell command ${head.s}`);
    });
  }
  if (!any) no("empty PowerShell script");
}

// ---------------------------------------------------------------- cmd

type CmdTok = { k: "word"; s: string } | { k: "sep" } | { k: "redir"; target: string };

function cmdLex(s: string): CmdTok[] {
  if (/[%!^()<,;=@]/.test(s)) no("cmd expansion, escape, group or separator character");
  const out: CmdTok[] = [];
  let i = 0;
  const word = (): string => {
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) no("unclosed quote");
      const v = s.slice(i + 1, end);
      i = end + 1;
      if (i < s.length && !/[ \t&|>]/.test(s[i]!)) no("cmd quoted text joined to a word");
      if (v === "") no("empty cmd word");
      return v;
    }
    let v = "";
    while (i < s.length && !/[ \t&|>"]/.test(s[i]!)) v += s[i++];
    if (s[i] === '"') no("cmd quote inside a word");
    if (s[i] === ">" && /[0-9]$/.test(v)) no("cmd word ending in a digit before a redirect");
    return v;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") no("cmd line break");
    if (c === "&") {
      i += s[i + 1] === "&" ? 2 : 1;
      out.push({ k: "sep" });
      continue;
    }
    if (c === "|") {
      if (s[i + 1] !== "|") no("cmd pipe");
      i += 2;
      out.push({ k: "sep" });
      continue;
    }
    const r = /^([0-9])?>(>)?/.exec(s.slice(i));
    if (r && (c === ">" || i === 0 || /[ \t]/.test(s[i - 1]!))) {
      i += r[0].length;
      if (s[i] === "&") {
        if (!/^&[12](?=$|[ \t&|])/.test(s.slice(i))) no("odd cmd redirect duplication");
        i += 2;
        continue;
      }
      while (s[i] === " " || s[i] === "\t") i++;
      if (i >= s.length || /[&|>]/.test(s[i]!)) no("cmd redirect without a target");
      out.push({ k: "redir", target: word() });
      continue;
    }
    if (/[0-9]/.test(c) && s[i + 1] === ">") no("cmd handle digit joined to a word");
    out.push({ k: "word", s: word() });
  }
  return out;
}

/** Reads a cmd line (commands joined by &, && or ||); every write goes to `ctx`. */
function readCmd(line: string, ctx: WinCtx, depth = 0): void {
  if (depth > MAX_DEPTH) no("wrappers nested too deep");
  const toks = cmdLex(line);
  const cmds: CmdTok[][] = [[]];
  for (const t of toks) {
    if (t.k === "sep") cmds.push([]);
    else cmds[cmds.length - 1]!.push(t);
  }
  if (cmds.some((c) => c.length === 0)) no("empty cmd command");
  for (const c of cmds) {
    for (const t of c) {
      if (t.k !== "redir") continue;
      if (t.target.toLowerCase() === "nul") continue;
      push(ctx, resolveWin(ctx, t.target, true), false);
    }
    const words = c.filter((t): t is { k: "word"; s: string } => t.k === "word").map((t) => t.s);
    if (words.length === 0) no("cmd redirect without a command");
    const name = words[0]!.toLowerCase();
    const args = words.slice(1);
    const opts = args.filter((a) => a.startsWith("/")).map((a) => a.toLowerCase());
    const ops = args.filter((a) => !a.startsWith("/"));
    const only = (allowed: string[]) => {
      for (const o of opts) if (!allowed.includes(o)) no(`cmd ${name} option ${o}`);
    };
    switch (name) {
      case "echo":
      case "type":
        // print only; a redirect above is the write
        continue;
      case "mkdir":
      case "md":
        only([]);
        if (ops.length === 0) no("mkdir without a directory");
        for (const o of ops) resolveWin(ctx, o, true);
        continue;
      case "del":
      case "erase":
        only(["/p", "/f", "/q"]);
        if (ops.length === 0) no("del without a path");
        // a directory operand deletes the files in it
        for (const o of ops) push(ctx, resolveWin(ctx, o, true), true, true);
        continue;
      case "ren":
      case "rename": {
        only([]);
        if (ops.length !== 2 || /[\\/:]/.test(ops[1]!)) no("ren without a source and a plain new name");
        const src = resolveWin(ctx, ops[0]!, true);
        push(ctx, src, true, true);
        for (const s of src) push(ctx, ctx.resolve(path.posix.join(path.posix.dirname(s), posixOf(ops[1]!, true))), true);
        continue;
      }
      case "copy":
      case "move": {
        only(name === "copy" ? ["/y", "/-y", "/v", "/b", "/d", "/n", "/z"] : ["/y", "/-y"]);
        if (ops.length !== 2 || ops.some((o) => o.includes("+"))) no(`${name} without one source and one destination`);
        const src = resolveWin(ctx, ops[0]!, true);
        const dests = resolveWin(ctx, ops[1]!, true);
        // copy of a directory copies the files in it: the destination is a tree unless the source is known to be a file
        const tree = name === "move" || !src.every((s) => ctx.fileAtPre(s));
        if (name === "move") push(ctx, src, true, true);
        push(ctx, dests, tree);
        intoDir(ctx, dests, src, tree);
        continue;
      }
    }
    no(`cmd command ${words[0]}`);
  }
}
