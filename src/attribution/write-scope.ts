// Which files a Bash call can write, read from its command alone, so that a call that provably cannot have written a file is not
// credited with it (`cannotHaveWritten`, behind the `creditWithEvidence` seam).
//
// The analyzer is deliberately small. It returns the exact set of paths a command can write or remove (`targets`), or UNKNOWN for anything it
// does not fully understand. What must not happen is a wrong single owner (a review refuted the "writes only outside the folder"
// rule on python -c with env paths, xlwings saves, tar -xP, variable paths and symlinks), so every doubt is UNKNOWN, and UNKNOWN never
// excludes. Understood, and nothing else:
//   - curl with -o/--output FILE, or -O with a URL whose every value is known; read-only options from an allow-list. A curl config file
//     (~/.curlrc and kin) can add outputs, so the live probe refuses curl while one exists.
//   - rm, cp, mv, touch with literal operands; mkdir (creates directories, never changes a file); cd with a literal path.
//   - readers that have no way to write a file (echo, cat, head, tail, wc, grep, ls, tr, cut, test, ...), printf without -v, date +FORMAT.
//   - `for x in LIST`, `T=(...)` and `X=literal`, with `$x`, `${x}`, `${T[@]}` substitution; `{a,b}` brace expansion; `$(...)` whose
//     command is itself understood (its value is unknown text, allowed only inside double quotes and never in a path).
//   - redirects to /dev/null, fd duplication (2>&1), input from a file, here-strings, and heredocs feeding an understood command.
//   - Python or Node children carrying the write hook (`observed`): the caller credits them as unable to write only when the call is
//     tagged, its children logged no write and started no other program, and the hook's roots cover the file.
//   - `python -I -c CODE` (or `python -I -` fed by a heredoc) whose code passes a strict read-only allow-list (`strictReadOnlyPython`).
// Any variable not bound by an understood literal assignment or loop, any other program, any other redirect, `eval`, `bash x.sh`, `xargs`,
// `find`, `sed`, `tee`, `dd`, `tar`, an env prefix (`X=1 cmd`), a glob or `~` in a path, a `..` component: UNKNOWN.
// Paths resolve against the call's cwd (and against each `cd`, keeping the old directory too when the cd may have failed). The probe
// rejects any target whose directories hold a symlink the user could have made (`fsProbe`).
import { lstatSync, readlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { guardKit } from "../credit-guard.ts";
import type { PathKit } from "../paths.ts";
import { PS_WRAPPERS, WinUnknown, psWrapperScript, readPowerShell, type WinCtx } from "./write-scope-win.ts";

export interface Target {
  /** Absolute, lexically normalised. */
  path: string;
  /** The whole tree under `path` may change (rm -r, mv). */
  tree: boolean;
  /** The call removes it (rm, a mv source): a target missing at the sweep may have been a link the call took away. */
  removes?: true;
}

export type WriteScope =
  | { known: true; targets: Target[]; /** relies on hooked Python/Node children */ observed: boolean; /** which: each needs a trusted start record */ observedKinds?: Array<"python" | "node">; /** how many hooked interpreter processes the command starts at most, per kind */ runs?: { python: number; node: number }; /** runs curl */ curl: boolean }
  | { known: false; why: string };

class Unknown extends Error {}
function no(why: string): never {
  throw new Unknown(why);
}

// ---------------------------------------------------------------- words

type Part =
  | { t: "lit"; s: string; q: boolean }
  | { t: "var"; name: string; q: boolean }
  | { t: "special"; q: boolean }
  | { t: "sub"; list: Node; q: boolean };

interface Word {
  parts: Part[];
  /** `NAME=(...)`: the array's elements. */
  array?: Word[];
}

interface Redir {
  op: string;
  target?: Word;
  /** A heredoc's body: literal text (quoted delimiter) or text with variables. */
  body?: Word;
}

type Node =
  | { k: "list"; items: Array<{ node: Node; op: string }> }
  | { k: "pipe"; cmds: Node[] }
  | { k: "simple"; words: Word[]; redirs: Redir[] }
  | { k: "sub"; body: Node; redirs: Redir[] }
  | { k: "group"; body: Node; redirs: Redir[] }
  | { k: "for"; name: string; words: Word[]; body: Node; redirs: Redir[] }
  | { k: "if"; parts: Node[]; redirs: Redir[] };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["for", "in", "do", "done", "if", "then", "elif", "else", "fi", "while", "until", "case", "esac", "function", "select", "time", "coproc", "{", "}", "!", "[[", "]]"]);

/** The word's text when it is one unquoted literal, else undefined. */
const plainOf = (w: Word): string | undefined => (w.array === undefined && w.parts.length === 1 && w.parts[0]!.t === "lit" && !w.parts[0]!.q ? w.parts[0]!.s : undefined);
/** The word's text when every part is literal (quoted or not), else undefined. */
const literalOf = (w: Word): string | undefined => (w.array === undefined && w.parts.every((p) => p.t === "lit") ? w.parts.map((p) => (p as { s: string }).s).join("") : undefined);

type Tok = { k: "word"; w: Word } | { k: "op"; op: string } | { k: "redir"; r: Redir } | { k: "eof" };

class Parser {
  i = 0;
  private pending: Redir[] = [];
  private buf: Tok[] = [];
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  // ---- lexer ----
  private skipBlanks(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t") this.i++;
      else if (c === "\\" && this.s[this.i + 1] === "\n") this.i += 2;
      else if (c === "#") {
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
      } else return;
    }
  }

  peek(): Tok {
    if (this.buf.length === 0) this.buf.push(this.lex());
    return this.buf[0]!;
  }

  next(): Tok {
    const t = this.peek();
    this.buf.shift();
    return t;
  }

  private lex(): Tok {
    this.skipBlanks();
    const s = this.s;
    if (this.i >= s.length) {
      if (this.pending.length > 0) no("heredoc without its body");
      return { k: "eof" };
    }
    const c = s[this.i]!;
    const two = s.slice(this.i, this.i + 2);
    if (c === "\n") {
      this.i++;
      this.readBodies();
      return { k: "op", op: "\n" };
    }
    if (two === "&&" || two === "||" || two === "|&" || two === ";;") {
      this.i += 2;
      if (two === ";;") no("case");
      return { k: "op", op: two };
    }
    if (two === "&>") return this.redir("");
    if (c === ";" || c === "&" || c === "|" || c === ")") {
      this.i++;
      return { k: "op", op: c };
    }
    if (c === "(") {
      if (s[this.i + 1] === "(") no("arithmetic command");
      this.i++;
      return { k: "op", op: "(" };
    }
    if (c === "<" || c === ">") return this.redir("");
    // a word; digits right before a redirect are its fd
    const m = /^\d+(?=[<>])/.exec(s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return this.redir(m[0]);
    }
    return { k: "word", w: this.word(false) };
  }

  private redir(fd: string): Tok {
    const s = this.s;
    const ops = ["&>>", "<<<", "<<-", ">>", ">|", "<<", "<>", ">&", "<&", "&>", "<", ">"];
    const op = ops.find((o) => s.startsWith(o, this.i))!;
    this.i += op.length;
    if ((op === "<" || op === ">") && s[this.i] === "(") no("process substitution");
    this.skipBlanks();
    const w = this.word(true);
    if (w.parts.length === 0) no("redirect without a target");
    const r: Redir = { op: fd + op, target: w };
    if (op === "<<" || op === "<<-") {
      const delim = literalOf(w);
      if (delim === undefined || delim === "") no("heredoc delimiter is not literal");
      (r as Redir & { delim?: string; quoted?: boolean; strip?: boolean }).delim = delim;
      (r as Redir & { quoted?: boolean }).quoted = w.parts.some((p) => p.t === "lit" && p.q);
      (r as Redir & { strip?: boolean }).strip = op === "<<-";
      this.pending.push(r);
    }
    return { k: "redir", r };
  }

  /** Reads the bodies of the heredocs started on the line just ended. */
  private readBodies(): void {
    for (const r of this.pending) {
      const { delim, quoted, strip } = r as Redir & { delim: string; quoted: boolean; strip: boolean };
      const lines: string[] = [];
      for (;;) {
        if (this.i >= this.s.length) no("heredoc never ends");
        let end = this.s.indexOf("\n", this.i);
        if (end < 0) end = this.s.length;
        let line = this.s.slice(this.i, end);
        this.i = Math.min(end + 1, this.s.length);
        if (strip) line = line.replace(/^\t+/, "");
        if (line === delim) break;
        lines.push(line);
      }
      const text = lines.length === 0 ? "" : lines.join("\n") + "\n";
      r.body = quoted ? { parts: [{ t: "lit", s: text, q: true }] } : bodyWord(text);
    }
    this.pending = [];
  }

  /** One word. `redirTarget`: stop before another redirect operator. */
  private word(redirTarget: boolean): Word {
    const s = this.s;
    const parts: Part[] = [];
    const lit = (t: string, q: boolean) => {
      const last = parts[parts.length - 1];
      if (last && last.t === "lit" && last.q === q) last.s += t;
      else parts.push({ t: "lit", s: t, q });
    };
    const start = this.i;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "<" || c === ">" || c === ")") break;
      if (c === "(") {
        // NAME=( ... ): an array
        const sofar = parts.length === 1 && parts[0]!.t === "lit" && !parts[0]!.q ? parts[0]!.s : undefined;
        if (!redirTarget && sofar !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(sofar) && this.i - start === sofar.length) {
          this.i++;
          const els: Word[] = [];
          for (;;) {
            while (this.i < s.length && /[ \t\n]/.test(s[this.i]!)) this.i++;
            if (this.i >= s.length) no("array never closes");
            if (s[this.i] === ")") {
              this.i++;
              break;
            }
            if (s[this.i] === "#") no("comment in an array");
            const w = this.word(true);
            if (w.parts.length === 0) no("odd array element");
            els.push(w);
          }
          return { parts, array: els };
        }
        no("parenthesis inside a word");
      }
      if (c === "\\") {
        if (s[this.i + 1] === "\n") {
          this.i += 2;
          continue;
        }
        if (this.i + 1 >= s.length) no("trailing backslash");
        lit(s[this.i + 1]!, true);
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) no("unclosed quote");
        lit(s.slice(this.i + 1, end), true);
        this.i = end + 1;
        continue;
      }
      if (c === '"') {
        this.i++;
        lit("", true);
        for (;;) {
          if (this.i >= s.length) no("unclosed quote");
          const d = s[this.i]!;
          if (d === '"') {
            this.i++;
            break;
          }
          if (d === "\\") {
            const e = s[this.i + 1];
            if (e === "$" || e === "`" || e === '"' || e === "\\") {
              lit(e, true);
              this.i += 2;
            } else if (e === "\n") this.i += 2;
            else {
              lit("\\", true);
              this.i++;
            }
            continue;
          }
          if (d === "$" || d === "`") {
            const p = this.dollar(true);
            if (p) {
              parts.push(p);
              continue;
            }
          }
          lit(d, true);
          this.i++;
        }
        continue;
      }
      if (c === "$" || c === "`") {
        const p = this.dollar(false);
        if (p) {
          parts.push(p);
          continue;
        }
      }
      if (c === "~" && this.i === start) {
        parts.push({ t: "special", q: false });
        this.i++;
        continue;
      }
      if (c === "=" && this.i === start && s[this.i + 1] !== undefined && !/[ \t\n;&|)]/.test(s[this.i + 1]!)) no("zsh =command expansion");
      lit(c, false);
      this.i++;
    }
    return { parts };
  }

  /** `$name`, `${name}`, `${name[@]}`, `$?`-style specials, `$(...)` and backticks; null for a lone `$`. */
  private dollar(q: boolean): Part | null {
    const s = this.s;
    if (s[this.i] === "`") {
      let j = this.i + 1;
      let inner = "";
      for (;;) {
        if (j >= s.length) no("unclosed backtick");
        if (s[j] === "\\" && j + 1 < s.length) {
          inner += s[j + 1];
          j += 2;
          continue;
        }
        if (s[j] === "`") break;
        inner += s[j];
        j++;
      }
      this.i = j + 1;
      return { t: "sub", list: parse(inner), q };
    }
    const n = s[this.i + 1];
    if (n === "'" || n === '"') no("$'...' or $\"...\" quoting");
    if (n === "(") {
      if (s[this.i + 2] === "(") no("arithmetic expansion");
      const end = matchParen(s, this.i + 1);
      const inner = s.slice(this.i + 2, end);
      this.i = end + 1;
      return { t: "sub", list: parse(inner), q };
    }
    if (n === "{") {
      const end = s.indexOf("}", this.i + 2);
      if (end < 0) no("unclosed ${");
      const inner = s.slice(this.i + 2, end);
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[@*]\])?$/.exec(inner);
      if (!m) no(`parameter expansion \${${inner}}`);
      this.i = end + 1;
      return { t: "var", name: m![1]!, q };
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(this.i + 1))!;
      this.i += 1 + m[0].length;
      return { t: "var", name: m[0], q };
    }
    if (n !== undefined && /[0-9?$!#@*-]/.test(n)) {
      this.i += 2;
      return { t: "special", q };
    }
    return null;
  }

  // ---- grammar ----
  parseList(stop: (t: Tok) => boolean): Node {
    const items: Array<{ node: Node; op: string }> = [];
    for (;;) {
      let t = this.peek();
      while (t.k === "op" && (t.op === "\n" || t.op === ";")) {
        this.next();
        t = this.peek();
      }
      if (t.k === "eof" || stop(t)) break;
      const node = this.parsePipe();
      const sep = this.peek();
      if (sep.k === "op" && (sep.op === "&&" || sep.op === "||" || sep.op === ";" || sep.op === "&" || sep.op === "\n")) {
        this.next();
        items.push({ node, op: sep.op });
      } else {
        items.push({ node, op: ";" });
        if (!(sep.k === "eof" || stop(sep))) no("unexpected token");
        break;
      }
    }
    return { k: "list", items };
  }

  private parsePipe(): Node {
    const t = this.peek();
    if (t.k === "word" && plainOf(t.w) === "!") this.next();
    const cmds = [this.parseCommand()];
    for (;;) {
      const p = this.peek();
      if (p.k === "op" && (p.op === "|" || p.op === "|&")) {
        this.next();
        while (this.peek().k === "op" && (this.peek() as { op: string }).op === "\n") this.next();
        cmds.push(this.parseCommand());
      } else break;
    }
    return cmds.length === 1 ? cmds[0]! : { k: "pipe", cmds };
  }

  private isWord(t: Tok, w: string): boolean {
    return t.k === "word" && plainOf(t.w) === w;
  }

  private expectWord(w: string): void {
    const t = this.next();
    if (!this.isWord(t, w)) no(`expected ${w}`);
  }

  private redirs(): Redir[] {
    const out: Redir[] = [];
    while (this.peek().k === "redir") out.push((this.next() as { r: Redir }).r);
    return out;
  }

  private parseCommand(): Node {
    const t = this.peek();
    if (t.k === "op" && t.op === "(") {
      this.next();
      const body = this.parseList((x) => x.k === "op" && x.op === ")");
      if (!(this.next() as { op?: string }).op) no("unclosed subshell");
      return { k: "sub", body, redirs: this.redirs() };
    }
    if (t.k === "word") {
      const w = plainOf(t.w);
      if (w === "{") {
        this.next();
        const body = this.parseList((x) => this.isWord(x, "}"));
        this.expectWord("}");
        return { k: "group", body, redirs: this.redirs() };
      }
      if (w === "for") {
        this.next();
        const nameTok = this.next();
        const name = nameTok.k === "word" ? plainOf(nameTok.w) : undefined;
        if (name === undefined || !NAME.test(name)) no("for without a plain name");
        let n = this.peek();
        while (n.k === "op" && n.op === "\n") {
          this.next();
          n = this.peek();
        }
        if (!this.isWord(n, "in")) no("for without in");
        this.next();
        const words: Word[] = [];
        for (;;) {
          const x = this.next();
          if (x.k === "op" && (x.op === ";" || x.op === "\n")) break;
          if (x.k !== "word") no("odd for list");
          words.push((x as { w: Word }).w);
        }
        let d = this.peek();
        while (d.k === "op" && (d.op === "\n" || d.op === ";")) {
          this.next();
          d = this.peek();
        }
        this.expectWord("do");
        const body = this.parseList((x) => this.isWord(x, "done"));
        this.expectWord("done");
        return { k: "for", name: name!, words, body, redirs: this.redirs() };
      }
      if (w === "if") {
        this.next();
        const parts: Node[] = [this.parseList((x) => this.isWord(x, "then"))];
        this.expectWord("then");
        for (;;) {
          parts.push(this.parseList((x) => this.isWord(x, "elif") || this.isWord(x, "else") || this.isWord(x, "fi")));
          const k = this.next();
          if (this.isWord(k, "fi")) break;
          if (this.isWord(k, "else")) {
            parts.push(this.parseList((x) => this.isWord(x, "fi")));
            this.expectWord("fi");
            break;
          }
          if (!this.isWord(k, "elif")) no("odd if");
          parts.push(this.parseList((x) => this.isWord(x, "then")));
          this.expectWord("then");
        }
        return { k: "if", parts, redirs: this.redirs() };
      }
      if (w !== undefined && RESERVED.has(w)) no(`shell keyword ${w}`);
    }
    const words: Word[] = [];
    const redirs: Redir[] = [];
    for (;;) {
      const x = this.peek();
      if (x.k === "word") {
        if (words.length > 0 && x.w.array !== undefined) no("array outside an assignment");
        words.push(x.w);
        this.next();
      } else if (x.k === "redir") {
        redirs.push(x.r);
        this.next();
      } else break;
    }
    if (words.length === 0 && redirs.length === 0) no("empty command");
    return { k: "simple", words, redirs };
  }
}

/** The index of the `)` closing the `(` at `open`, skipping quotes and nested parentheses. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", j + 1);
      if (e < 0) no("unclosed quote");
      j = e;
      continue;
    }
    if (c === '"') {
      let k = j + 1;
      while (k < s.length && s[k] !== '"') k += s[k] === "\\" ? 2 : 1;
      if (k >= s.length) no("unclosed quote");
      j = k;
      continue;
    }
    if (c === "#" || c === "<" && s[j + 1] === "<") no("comment or heredoc inside $(...)");
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return no("unclosed $(");
}

/** A heredoc body with an unquoted delimiter: variables are expanded, a command substitution would run (refused). */
function bodyWord(text: string): Word {
  if (/`|\$\(/.test(text)) no("command substitution in a heredoc");
  const parts: Part[] = [];
  let lit = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length && "$`\\\n".includes(text[i + 1]!)) {
      if (text[i + 1] !== "\n") lit += text[i + 1];
      i++;
      continue;
    }
    if (c === "$") {
      const rest = text.slice(i + 1);
      let m: RegExpExecArray | null;
      if ((m = /^\{([A-Za-z_][A-Za-z0-9_]*)(\[[@*]\])?\}/.exec(rest)) || (m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest))) {
        parts.push({ t: "lit", s: lit, q: true }, { t: "var", name: m[1]!, q: true });
        lit = "";
        i += m[0].length;
        continue;
      }
      if (rest.startsWith("{")) no("parameter expansion in a heredoc");
      if (/^[0-9?$!#@*-]/.test(rest)) {
        parts.push({ t: "lit", s: lit, q: true }, { t: "special", q: true });
        lit = "";
        i++;
        continue;
      }
    }
    lit += c;
  }
  parts.push({ t: "lit", s: lit, q: true });
  return { parts };
}

function parse(s: string): Node {
  const p = new Parser(s);
  const node = p.parseList(() => false);
  if (p.peek().k !== "eof") no("trailing tokens");
  return node;
}

// ---------------------------------------------------------------- evaluation

type Bind = { vals: string[]; arr: boolean; /** elements as written, duplicates included (a loop's iterations) */ count?: number } | "taint";
interface State {
  /** Possible working directories; null when unknown. */
  cwds: string[] | null;
  vars: Map<string, Bind>;
  /** Win32 Git Bash: a path is known only as a plain `/c/seg/seg` drive form (`plainDrivePath`); anything else is unknown. */
  win?: true;
}
interface Outcome {
  ok: State;
  fail: State;
}

const CAP = 4096;
const uniq = (xs: string[]): string[] => [...new Set(xs)];

function union(...ss: State[]): State {
  const cwds = ss.some((s) => s.cwds === null) ? null : uniq(ss.flatMap((s) => s.cwds!));
  const names = new Set(ss.flatMap((s) => [...s.vars.keys()]));
  const vars = new Map<string, Bind>();
  for (const n of names) {
    const bs = ss.map((s) => s.vars.get(n));
    if (bs.some((b) => b === undefined || b === "taint")) vars.set(n, "taint");
    else {
      const arr = (bs[0] as { arr: boolean }).arr;
      if (bs.some((b) => (b as { arr: boolean }).arr !== arr)) vars.set(n, "taint");
      else {
        const vals = uniq(bs.flatMap((b) => (b as { vals: string[] }).vals));
        if (vals.length > CAP) no("too many values");
        vars.set(n, { vals, arr, count: Math.max(...bs.map((b) => (b as { count?: number; vals: string[] }).count ?? (b as { vals: string[] }).vals.length)) });
      }
    }
  }
  return { cwds, vars, ...(ss.some((s) => s.win === true) ? { win: true as const } : {}) };
}
const same = (o: Outcome): Outcome => o;
const both = (s: State): Outcome => ({ ok: s, fail: s });
const key = (s: State): string => JSON.stringify([s.cwds?.slice().sort() ?? null, [...s.vars.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v === "taint" ? v : [v.arr, v.vals.slice().sort()]])]);

interface Ctx {
  targets: Target[];
  observed: boolean;
  kinds: Set<"python" | "node">;
  /** Hooked interpreter processes counted so far, per kind (an upper bound: every branch counts). */
  runs: { python: number; node: number };
  /** Iterations of the loops around the command being read. */
  mult: number;
  /** False on a loop body's later passes (they settle state, they do not run it again). */
  counting: boolean;
  curl: boolean;
  /** Still true while every command read so far is a read-only form (`isReadOnlyCommand`); false at any command that can change the disk or runs code. */
  pure: boolean;
  /** A listed read-only program (`READ_ONLY_VERBS`) was read: a command of nothing but echo, printf, test and the like is not called read-only. */
  reader: boolean;
  /** Pre-time probe: a cd whose directory exists cannot fail. */
  pre?: PathProbe;
}

/** What a word can expand to. */
interface Exp {
  /** Every field it can produce (all alternatives and all fields of a brace expansion). Empty when `unknown`. */
  vals: string[];
  /** Holds text the analyzer cannot know (a command substitution, `$?`, a variable assigned from one). */
  unknown: boolean;
  /** Some of that unknown text is unquoted: it can split into several arguments or glob. */
  unquotedUnknown: boolean;
  /** An unquoted glob character. */
  glob: boolean;
  /** The literal text before the first part that is not literal. */
  prefix: string;
}

/** Bash brace expansion of one word (`a{b,c}` gives `ab`, `ac`); throws on a sequence or past the cap. */
export function braceExpand(s: string): string[] {
  // the first `{` whose matching `}` holds a top-level comma
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    const commas: number[] = [];
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") {
        depth--;
        if (depth === 0) break;
      } else if (s[j] === "," && depth === 1) commas.push(j);
    }
    if (j >= s.length) return [s];
    const inner = s.slice(i + 1, j);
    if (commas.length === 0) {
      if (inner.includes("..")) no("brace sequence");
      continue;
    }
    const alts: string[] = [];
    let from = i + 1;
    for (const c of [...commas, j]) {
      alts.push(s.slice(from, c));
      from = c + 1;
    }
    const pre = s.slice(0, i);
    const post = s.slice(j + 1);
    const out = alts.flatMap((a) => braceExpand(pre + a + post));
    if (out.length > CAP) no("too many brace values");
    return out;
  }
  return [s];
}

function expand(w: Word, st: State, ctx: Ctx): Exp {
  if (w.array !== undefined) no("array word");
  let unknown = false;
  let unquotedUnknown = false;
  let glob = false;
  let prefix = "";
  let prefixOpen = true;
  // A variable has one value within a word: its values are enumerated once per word, not once per occurrence. Each variable's domain holds
  // its values, an array's elements joined (zsh's "$T"), and the blank-split pieces of a scalar (bash's unquoted $x): a superset.
  const domains = new Map<string, string[]>();
  for (const p of w.parts) {
    if (prefixOpen && p.t === "lit") prefix += p.s;
    else prefixOpen = false;
    if (p.t === "sub") {
      evalNode(p.list, st, ctx);
      unknown = true;
      if (!p.q) unquotedUnknown = true;
    } else if (p.t === "special") {
      unknown = true;
      if (!p.q) unquotedUnknown = true;
    } else if (p.t === "var") {
      const b = st.vars.get(p.name);
      if (b === undefined) no(`$${p.name} is not bound in the command`);
      if (b === "taint") {
        unknown = true;
        if (!p.q) unquotedUnknown = true;
        continue;
      }
      let vals = b.arr ? [...b.vals, b.vals.join(" ")] : b.vals;
      vals = uniq(vals.flatMap((v) => (/\s/.test(v) ? [v, ...v.split(/\s+/).filter((x) => x !== "")] : [v])));
      if (!p.q && vals.some((v) => /[*?[]/.test(v))) glob = true;
      domains.set(p.name, vals);
    } else if (!p.q && /[*?[]/.test(p.s)) glob = true;
  }
  if (unknown) return { vals: [], unknown, unquotedUnknown, glob, prefix };
  let combos: Array<Map<string, string>> = [new Map()];
  for (const [name, vals] of domains) {
    combos = combos.flatMap((c) => vals.map((v) => new Map(c).set(name, v)));
    if (combos.length > CAP) no("too many values");
  }
  const out: string[] = [];
  for (const c of combos) {
    let alts: string[] = [""];
    for (const p of w.parts) {
      const vals = p.t === "var" ? [c.get(p.name)!] : p.t === "lit" ? (p.q || !p.s.includes("{") ? [p.s] : braceExpand(p.s)) : [""];
      const next: string[] = [];
      for (const x of alts) for (const v of vals) next.push(x + v);
      alts = next;
      if (alts.length > CAP) no("too many values");
    }
    out.push(...alts);
    if (out.length > CAP * 4) no("too many values");
  }
  return { vals: uniq(out), unknown, unquotedUnknown, glob, prefix };
}

/** A word every value of which is known, as its values; UNKNOWN otherwise. */
function known(e: Exp, what: string): string[] {
  if (e.unknown || e.glob) no(`${what} is not literal`);
  return e.vals;
}

/**
 * Fail-closed: on win32 a path is read only as `/<one drive letter>/seg/seg...` where every segment is a plain name. Anything that
 * Windows or Git Bash may resolve to a file by another route (8.3 short names `PROGRA~1`, trailing dots or spaces, `:` streams, `%`, wildcards,
 * device names, `/cygdrive`, msys mounts `/tmp` `/usr` `/home` `/dev` `/proc`, `//host`, any non-drive root) makes the command unknown.
 */
const PLAIN_SEG = /^(?![ .]*$)[^\\~:%*?"<>|\0-\x1f]*[^\\~:%*?"<>|\0-\x1f. ]$/;
const DEVICE_SEG = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
export function plainDrivePath(p: string): boolean {
  const m = /^\/([A-Za-z])((?:\/[^/]+)*)\/?$/.exec(p);
  if (m === null) return false;
  return m[2]!.split("/").slice(1).every((seg) => PLAIN_SEG.test(seg) && !DEVICE_SEG.test(seg));
}

function resolveIn(st: State, p: string): string[] {
  if (p === "") no("empty path");
  if (p.startsWith("~")) no("~ path");
  if (p.split("/").includes("..")) no(".. in a path");
  let out: string[];
  if (p.startsWith("/")) out = [path.posix.normalize(p)]; // The analysis runs in POSIX shape; a win32 cwd and file are mapped to it first (`posixForm`)
  else {
    if (st.cwds === null) no("relative path with an unknown working directory");
    out = st.cwds!.map((c) => path.posix.resolve(c, p));
  }
  if (st.win === true && !out.every(plainDrivePath)) no("win32 path that is not a plain drive form");
  return out;
}

function addTargets(ctx: Ctx, st: State, e: Exp, tree: boolean, what: string, removes = false): void {
  for (const v of known(e, what)) {
    if (v.startsWith("-")) no(`${what} looks like an option`);
    for (const p of resolveIn(st, v)) ctx.targets.push({ path: p, tree, ...(removes ? { removes: true as const } : {}) });
  }
}

/** Short-option clusters: each letter in `flags` stands alone, each in `withArg` takes the rest of the word or the next word. */
function options(args: Exp[], flags: string, withArg: string, longs: Record<string, "flag" | "arg"> = {}): { opts: Array<{ o: string; v?: Exp }>; rest: Exp[] } {
  // GNU tools and curl take options after operands too, so every argument that may be an option is read as one
  const opts: Array<{ o: string; v?: Exp }> = [];
  const rest: Exp[] = [];
  const lit = (x: string): Exp => ({ vals: [x], unknown: false, unquotedUnknown: false, glob: false, prefix: x });
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.unquotedUnknown) no("unquoted unknown argument");
    if (a.unknown) {
      if (a.prefix === "" || a.prefix.startsWith("-")) no("an argument that may be an option");
      rest.push(a);
      continue;
    }
    if (a.vals.length !== 1) {
      if (a.vals.some((v) => v.startsWith("-"))) no("an option from an expansion");
      rest.push(a);
      continue;
    }
    const v = a.vals[0]!;
    if (v === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!v.startsWith("-") || v === "-") {
      rest.push(a);
      continue;
    }
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      const name = eq < 0 ? v : v.slice(0, eq);
      const kind = longs[name];
      if (kind === undefined) no(`option ${name}`);
      if (kind === "flag") {
        if (eq >= 0) no(`option ${name}=`);
        opts.push({ o: name });
      } else if (eq >= 0) opts.push({ o: name, v: lit(v.slice(eq + 1)) });
      else {
        const nv = args[++i];
        if (nv === undefined) no(`option ${name} without its value`);
        opts.push({ o: name, v: nv });
      }
      continue;
    }
    for (let k = 1; k < v.length; k++) {
      const c = v[k]!;
      if (flags.includes(c)) {
        opts.push({ o: "-" + c });
        continue;
      }
      if (withArg.includes(c)) {
        const restOf = v.slice(k + 1);
        if (restOf !== "") opts.push({ o: "-" + c, v: lit(restOf) });
        else {
          const nv = args[++i];
          if (nv === undefined) no(`option -${c} without its value`);
          opts.push({ o: "-" + c, v: nv });
        }
        break;
      }
      no(`option -${c}`);
    }
  }
  return { opts, rest };
}

/** Readers that have no way at all to write a file, whatever their arguments. */
/** Variables that change how the shell splits, finds programs or directories, or whether a child carries the write hook. */
const DANGEROUS_VARS = /^(IFS|PATH|CDPATH|HOME|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|GLOBIGNORE|POSIXLY_CORRECT|FPATH|CURL_HOME|XDG_CONFIG_HOME|TMPDIR|PYTHON\w*|NODE_\w*|LD_\w*|DYLD_\w*|COCHECK_\w*)$/;
/** Interpreters a program word may name: bare (found on PATH) or absolute under these system folders; `./python3`, a venv's or a user path is not one. */
const SYSTEM_BIN = /^\/(usr\/bin|bin|usr\/local\/bin|opt\/homebrew\/bin)\/[^/]+$/;
/** Where a hooked child's interpreter (its start record's path) may live to be trusted. */
const TRUSTED_INTERPRETER = /^\/(usr\/bin|bin|usr\/local\/(bin|Cellar|opt)|opt\/homebrew\/(bin|Cellar|opt)|Library\/Frameworks\/Python\.framework|Library\/Developer\/CommandLineTools|Applications\/Xcode\.app)\//;
const trustedInterpreter = (p: string): boolean => TRUSTED_INTERPRETER.test(p) && !p.split("/").includes("..");

const READERS = new Set(["echo", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "ls", "true", "false", ":", "pwd", "sleep", "wait", "test", "[", "tr", "cut", "basename", "dirname", "break", "continue"]);
const PYTHON = /^python(\d+(\.\d+)*)?$/;

const CURL_LONG: Record<string, "flag" | "arg"> = {
  "--silent": "flag", "--show-error": "flag", "--fail": "flag", "--fail-with-body": "flag", "--location": "flag", "--head": "flag", "--include": "flag",
  "--insecure": "flag", "--globoff": "flag", "--compressed": "flag", "--verbose": "flag", "--get": "flag", "--http1.1": "flag", "--http2": "flag",
  "--no-progress-meter": "flag", "--progress-bar": "flag", "--remote-name": "flag", "--create-dirs": "flag", "--raw": "flag",
  "--user-agent": "arg", "--header": "arg", "--referer": "arg", "--max-time": "arg", "--connect-timeout": "arg", "--request": "arg", "--retry": "arg",
  "--retry-delay": "arg", "--retry-max-time": "arg", "--range": "arg", "--proxy": "arg", "--data": "arg", "--data-raw": "arg", "--data-binary": "arg",
  "--data-urlencode": "arg", "--cookie": "arg", "--write-out": "arg", "--max-filesize": "arg", "--url": "arg", "--output": "arg", "--user": "arg",
};

function curl(args: Exp[], st: State, ctx: Ctx): void {
  ctx.curl = true;
  const { opts, rest } = options(args, "sSfLIikgvGNq#", "AHemXurxdbwo", CURL_LONG);
  const urls: Exp[] = [...rest];
  let remote = false;
  let globoff = false;
  for (const { o, v } of opts) {
    if (o === "-o" || o === "--output") {
      const vals = known(v!, "curl output");
      if (vals.some((x) => x.includes("#"))) no("curl output with #N");
      const real = vals.filter((x) => x !== "-");
      if (real.length > 0) addTargets(ctx, st, { ...v!, vals: real }, false, "curl output");
    } else if (o === "-O" || o === "--remote-name") remote = true;
    else if (o === "-g" || o === "--globoff") globoff = true;
    else if (o === "--url") urls.push(v!);
    else if (o === "-w" || o === "--write-out") {
      if (v!.unknown || v!.vals.some((x) => x.includes("%output{") || x.startsWith("@"))) no("curl --write-out to a file");
    } else if (v !== undefined && v.unquotedUnknown) no("unquoted unknown curl option value");
  }
  for (const u of urls) {
    if (u.unquotedUnknown) no("unquoted unknown curl argument");
    if (u.unknown ? u.prefix.startsWith("-") || u.prefix === "" : u.vals.some((x) => x.startsWith("-"))) no("curl argument that may be an option");
  }
  if (remote) {
    for (const u of urls) {
      for (const url of known(u, "curl -O URL")) {
        if (!globoff && /[{}[\]]/.test(url)) no("curl URL glob with -O");
        const base = url.replace(/[?#].*$/, "").replace(/^[a-z]+:\/\/[^/]*/i, "").split("/").pop() ?? "";
        if (base === "" || base === "." || base === "..") no("curl -O without a file name");
        for (const p of resolveIn(st, base)) ctx.targets.push({ path: p, tree: false });
      }
    }
  }
}

// ---- strict read-only Python (for `python -I`, which carries no write hook) ----

const PY_MODULES = new Set(["json", "sys", "datetime", "math", "re", "csv", "statistics"]);
const PY_BANNED = /\b(os|shutil|subprocess|pathlib|io|eval|exec|compile|globals|locals|vars|getattr|setattr|delattr|importlib|builtins|modules|breakpoint|help|write|writelines|writer|DictWriter|save|savefig|dump|to_csv|to_excel|to_json|to_pickle|truncate|remove|unlink|rename|replace|mkdir|makedirs|rmdir|system|popen|spawn|fork|kill|chmod|chown|symlink|link|open_code|file)\b/;

/** Skips a Python string literal starting at `i` (at its quote); returns the index after it. */
function skipPyString(code: string, i: number): number {
  const q = code[i]!;
  const triple = code.startsWith(q.repeat(3), i);
  let j = i + (triple ? 3 : 1);
  for (; j < code.length; j++) {
    if (code[j] === "\\") {
      j++;
      continue;
    }
    if (triple ? code.startsWith(q.repeat(3), j) : code[j] === q) return j + (triple ? 3 : 1);
    if (!triple && code[j] === "\n") no("unclosed Python string");
  }
  return no("unclosed Python string");
}

/** The top-level arguments of the call whose `(` is at `open`. */
function pyArgs(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let j = open; j < code.length; j++) {
    const c = code[j]!;
    if (c === "'" || c === '"') {
      j = skipPyString(code, j) - 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(code.slice(from, j));
        return args.map((a) => a.trim()).filter((a, k, all) => !(a === "" && k === all.length - 1));
      }
    } else if (c === "," && depth === 1) {
      args.push(code.slice(from, j));
      from = j + 1;
    }
  }
  return no("unclosed Python call");
}

/**
 * Whether `code` (run with `python -I`, so neither the cwd nor PYTHON* variables reach sys.path) can only read: imports limited to
 * json, sys, datetime, math, re, csv and statistics; every open() with one argument or an explicit read mode; no dunder, no non-ASCII
 * (identifiers are NFKC-folded), and none of a list of names that reach files, programs or arbitrary objects (os, shutil, subprocess,
 * pathlib, io, eval, exec, getattr, compile, globals, write, save, dump, sys.modules, ...). The text is scanned whole, strings included,
 * so an f-string cannot hide a call; a false "no" only keeps a call a suspect.
 */
export function strictReadOnlyPython(code: string): boolean {
  if (/[^\x00-\x7f]/.test(code) || code.includes("__")) return false;
  if (PY_BANNED.test(code)) return false;
  if (/\bfile\s*=/.test(code)) return false;
  // rebinding the standard streams turns print() into a file write
  if (/\b(sys\s*\.\s*)?(stdout|stderr|stdin)\s*(=(?!=)|:=)/.test(code)) return false;
  let rest = code.replace(/\bfrom\s+([A-Za-z_][\w.]*)\s+import\b/g, (_m, mod: string) => {
    if (!PY_MODULES.has(mod.split(".")[0]!)) throw new Unknown(`import from ${mod}`);
    return " ";
  });
  for (const m of rest.matchAll(/\bimport\s+([^\n;]+)/g)) {
    for (const item of m[1]!.split(",")) {
      const mod = item.trim().split(/\s+as\s+/)[0]!.trim();
      if (!/^[A-Za-z_][\w.]*$/.test(mod) || !PY_MODULES.has(mod.split(".")[0]!)) return false;
    }
  }
  if (/\bfrom\b/.test(rest.replace(/(['"]).*?\1/g, ""))) return false;
  for (const m of code.matchAll(/\bopen\b/g)) {
    const at = m.index!;
    if (/\.\s*$/.test(code.slice(0, at))) return false;
    const after = /^\s*\(/.exec(code.slice(at + 4));
    if (!after) return false;
    const args = pyArgs(code, at + 4 + after[0].length - 1);
    if (args.some((a) => a.startsWith("*"))) return false;
    if (args.length === 1 && !args[0]!.includes("=")) continue;
    if (args.length === 2 && /^(['"])(r|rb|rt|br|tr)\1$/.test(args[1]!) && !args[0]!.includes("=")) continue;
    return false;
  }
  rest = "";
  return true;
}

function python(name: string, args: Exp[], stdin: Exp | undefined, ctx: Ctx): void {
  // flags up to the script: -I/-E/-S keep the write hook out (no PYTHONPATH, or no site), so such a run must pass the strict check
  let isolated = false;
  let iso = false;
  let code: Exp | undefined;
  let script: "none" | "stdin" | "file" | "module" = "none";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.unquotedUnknown) no("unquoted unknown python argument");
    if (a.unknown || a.vals.length !== 1) {
      if (a.vals.some((v) => v.startsWith("-"))) no("a python option from an expansion");
      script = "file";
      break;
    }
    const v = a.vals[0]!;
    if (v === "-") {
      script = "stdin";
      break;
    }
    if (!v.startsWith("-")) {
      script = "file";
      break;
    }
    let done = false;
    for (let k = 1; k < v.length && !done; k++) {
      const c = v[k]!;
      if ("IES".includes(c)) {
        isolated = true;
        if (c === "I") iso = true;
      } else if ("suBOqbdv".includes(c)) continue;
      else if (c === "W" || c === "X") {
        if (k === v.length - 1) i++;
        done = true;
      } else if (c === "c") {
        code = k === v.length - 1 ? args[++i] : { vals: [v.slice(k + 1)], unknown: false, unquotedUnknown: false, glob: false, prefix: "" };
        if (code === undefined) no("python -c without code");
        script = "none";
        done = true;
        i = args.length;
      } else if (c === "m") {
        script = "module";
        done = true;
        i = args.length;
      } else no(`python option -${c}`);
    }
  }
  if (!isolated) {
    // a hooked run must be one whose hook can be proven per process: plain python3/python only (python3.7 has no audit hook, a versioned
    // name may be another installation)
    if (name !== "python3" && name !== "python") no(`hooked interpreter ${name}: only python3 or python`);
    ctx.observed = true;
    ctx.kinds.add("python");
    countRun(ctx, "python");
    return;
  }
  if (!iso) no("python -E or -S without -I");
  const text = code ?? (script === "stdin" || script === "none" ? stdin : undefined);
  if (text === undefined || script === "file" || script === "module") no("python -I running a file, a module or piped code");
  if (text!.unknown) no("python -I code is not literal");
  for (const c of text!.vals) if (!strictReadOnlyPython(c)) no("python -I code outside the read-only allow-list");
}

/** The plain readers (no option of theirs writes) that make a command read-only; echo, printf, test, pwd and date are only glue beside them. */
const READ_ONLY_VERBS = new Set(["cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "ls"]);
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show"]);

/**
 * `less`, `rg`, `stat`, `file` and `git status|diff|log|show` read and never write a file of the task, unless an option says otherwise
 * (less -o/-O/--log-file/+command, rg --pre/--hostname-bin, file -C, git --output/--ext-diff/--textconv). Every argument must be fully literal
 * (a variable could hold an option), and `git` takes no global option before its subcommand. Anything else is UNKNOWN.
 */
function readOnlyProgram(base: string, args: Exp[]): void {
  if (args.some((a) => a.unknown || a.unquotedUnknown)) no(`${base} with an argument that is not literal`);
  const words = args.flatMap((a) => a.vals);
  const flags = words.filter((w) => w.startsWith("-") || w.startsWith("+"));
  const short = (w: string, letters: string): boolean => /^-[^-]/.test(w) && [...w.slice(1)].some((c) => letters.includes(c));
  switch (base) {
    case "less":
      if (flags.some((w) => w.startsWith("+") || short(w, "oO") || /^--(log-file|LOG-FILE|lesskey|lesskey-file)/i.test(w))) no("less option that writes or runs");
      return;
    case "rg":
      if (flags.some((w) => /^--(pre|hostname-bin)/.test(w))) no("rg option that runs a program");
      return;
    case "file":
      if (flags.some((w) => short(w, "C") || w === "--compile")) no("file -C");
      return;
    case "git":
      if (words.length === 0 || !GIT_READ_ONLY.has(words[0]!)) no("git subcommand outside status, diff, log and show");
      if (flags.some((w) => /^--(output|ext-diff|textconv|open-files-in-pager|exec-path)/.test(w))) no("git option that writes or runs a program");
      return;
  }
}

/**
 * Whether `command` is made only of read-only forms (wc, cat, head, tail, less, grep, rg, ls, stat, file, git status|diff|log|show, with
 * echo, printf, test, pwd, date only as glue beside one of them) with no output redirection to a file, no pipe to a writer, no in-place flag. An output redirect to a file,
 * `tee`, `sed`, `xargs`, `find` and any program or construct the parser does not understand are UNKNOWN, so the answer is false. The bound:
 * the command's words are taken at face value (a shell alias or function that shadows `cat` is not seen).
 */
export function isReadOnlyCommand(command: string): boolean {
  if (command.trim() === "") return false;
  try {
    const st: State = { cwds: null, vars: new Map() };
    const ctx: Ctx = { targets: [], observed: false, kinds: new Set(), runs: { python: 0, node: 0 }, mult: 1, counting: true, curl: false, pure: true, reader: false };
    evalNode(parse(command), st, ctx);
    return ctx.pure && ctx.reader && ctx.targets.length === 0 && !ctx.observed && !ctx.curl;
  } catch {
    return false;
  }
}

const MAX_RUNS = 256;
function countRun(ctx: Ctx, kind: "python" | "node"): void {
  if (!ctx.counting) return;
  ctx.runs[kind] += ctx.mult;
  if (ctx.runs[kind] > MAX_RUNS) no("too many interpreter runs");
}

/** At most how many times a `for` runs its body: literal words brace-expanded, a lone variable its elements (or blank-split pieces). */
function iterations(words: Word[], st: State, ctx: Ctx): number {
  let n = 0;
  for (const w of words) {
    const parts = w.parts.filter((p) => !(p.t === "lit" && p.s === ""));
    if (parts.length === 1 && parts[0]!.t === "var") {
      const v = parts[0]!;
      const b = st.vars.get(v.name);
      if (b === undefined || b === "taint") no("for list is not literal");
      const raw = b.count ?? b.vals.length;
      n += b.arr ? raw : v.q ? 1 : Math.max(raw, ...b.vals.map((x) => x.split(/\s+/).filter((y) => y !== "").length));
      continue;
    }
    n += Math.max(1, expand(w, st, ctx).vals.length);
  }
  return n;
}

function evalSimple(n: Extract<Node, { k: "simple" }>, st: State, ctx: Ctx): Outcome {
  let stdin: Exp | undefined;
  for (const r of n.redirs) stdin = checkRedir(r, st, ctx) ?? stdin;
  const assigns: Word[] = [];
  let i = 0;
  for (; i < n.words.length; i++) {
    const w = n.words[i]!;
    const first = w.parts[0];
    if (first && first.t === "lit" && !first.q && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.s)) assigns.push(w);
    else break;
  }
  const words = n.words.slice(i);
  if (words.length === 0) {
    const vars = new Map(st.vars);
    for (const w of assigns) {
      const first = w.parts[0] as { s: string };
      const name = first.s.slice(0, first.s.indexOf("="));
      if (DANGEROUS_VARS.test(name)) no(`assignment to ${name}`);
      if (w.array !== undefined) {
        const exps = w.array.map((e) => expand(e, st, ctx));
        vars.set(name, exps.some((e) => e.unknown || e.glob) ? "taint" : { vals: uniq(exps.flatMap((e) => e.vals)), arr: true, count: exps.reduce((n, e) => n + Math.max(1, e.vals.length), 0) });
        continue;
      }
      const rest: Word = { parts: [{ t: "lit", s: first.s.slice(name.length + 1), q: true }, ...w.parts.slice(1)] };
      const e = expand(rest, st, ctx);
      vars.set(name, e.unknown ? "taint" : { vals: e.vals, arr: false });
    }
    return both({ ...st, vars });
  }
  if (assigns.length > 0) no("environment prefix on a command");
  const prog = plainOf(words[0]!);
  if (prog === undefined || (prog !== "[" && /[*?[{$]/.test(prog))) no("program name is not literal");
  const args = words.slice(1).map((w) => expand(w, st, ctx));
  const base = prog!.includes("/") ? path.posix.basename(prog!) : prog!;
  const sys = !prog!.includes("/") || /^\/(usr\/)?bin\/[^/]+$/.test(prog!);
  if (PYTHON.test(base) || base === "node") {
    if (prog!.includes("/") && !SYSTEM_BIN.test(prog!)) no(`interpreter ${prog} outside the system folders`);
    ctx.pure = false;
    if (base === "node") {
      if (args.some((a) => a.unquotedUnknown)) no("unquoted unknown node argument");
      ctx.observed = true;
      ctx.kinds.add("node");
      countRun(ctx, "node");
    } else python(base, args, stdin, ctx);
    return both(st);
  }
  if (!sys) no(`program ${prog}`);
  if (READERS.has(base)) {
    if (READ_ONLY_VERBS.has(base)) ctx.reader = true;
    return both(st);
  }
  switch (base) {
    case "printf":
      if (args[0] && (args[0].unquotedUnknown || args[0].vals.some((v) => v.startsWith("-v")) || (args[0].unknown && args[0].prefix.startsWith("-")))) no("printf -v");
      return both(st);
    case "date":
      for (const a of args) if (a.unknown || a.vals.some((v) => !(v.startsWith("+") || v === "-u"))) no("date with an argument that may set the clock");
      return both(st);
    case "cd": {
      if (args.length !== 1) no("cd without one literal path");
      const dirs = known(args[0]!, "cd path");
      if (dirs.some((d) => d.startsWith("-"))) no("cd option");
      // a bare relative cd may go through an inherited CDPATH: only an absolute path or ./ is read
      // POSIX-shaped analysis (a win32 Git Bash command's `/c/x` is absolute here)
      if (dirs.some((d) => !d.startsWith("/") && !d.startsWith("./"))) no("cd to a relative path without ./");
      const next = uniq(dirs.flatMap((d) => resolveIn(st, d)));
      const ok: State = { ...st, cwds: next };
      // a cd into a directory that exists before the command runs (checked at the call's Pre) does not fail
      const cannotFail = ctx.pre !== undefined && next.every((d) => ctx.pre!.dirExists(d));
      return { ok, fail: cannotFail ? ok : st };
    }
    case "mkdir": {
      ctx.pure = false;
      const { rest } = options(args, "pv", "m");
      for (const r of rest) known(r, "mkdir operand");
      return both(st);
    }
    case "rm": {
      ctx.pure = false;
      const { opts, rest } = options(args, "fFrRidvI", "");
      const tree = opts.some((o) => o.o === "-r" || o.o === "-R");
      for (const r of rest) addTargets(ctx, st, r, tree, "rm operand", true);
      return both(st);
    }
    case "touch": {
      ctx.pure = false;
      const { rest } = options(args, "acmhf", "tdr");
      for (const r of rest) addTargets(ctx, st, r, false, "touch operand");
      return both(st);
    }
    case "cp":
    case "mv": {
      ctx.pure = false;
      const { rest } = options(args, base === "cp" ? "fipvnX" : "fivn", "");
      if (rest.length < 2) no(`${base} without a source and a destination`);
      const dst = rest[rest.length - 1]!;
      const srcs = rest.slice(0, -1);
      const tree = base === "mv";
      addTargets(ctx, st, dst, tree, `${base} destination`);
      for (const s of srcs) {
        const vals = known(s, `${base} source`);
        if (vals.some((v) => v.startsWith("-"))) no(`${base} source looks like an option`);
        if (tree) addTargets(ctx, st, s, true, "mv source", true);
        for (const d of known(dst, `${base} destination`)) {
          for (const v of vals) {
            const name = path.posix.basename(v);
            if (name === "" || name === "." || name === "..") no(`${base} source without a name`);
            for (const p of resolveIn(st, d)) {
              const to = path.posix.join(p, name);
              if (st.win === true && !plainDrivePath(to)) no("win32 path that is not a plain drive form");
              ctx.targets.push({ path: to, tree });
            }
          }
        }
      }
      return both(st);
    }
    case "curl":
      ctx.pure = false;
      curl(args, st, ctx);
      return both(st);
    // More read-only programs, each only without the options that make it write or run another program; any other option is UNKNOWN, as before
    case "less":
    case "rg":
    case "stat":
    case "file":
    case "git":
      readOnlyProgram(base, args);
      ctx.reader = true;
      return both(st);
  }
  return no(`program ${base}`);
}

/** Checks one redirect; returns the stdin a heredoc or here-string gives the command, if any. */
function checkRedir(r: Redir, st: State, ctx: Ctx): Exp | undefined {
  const op = r.op.replace(/^\d+/, "");
  if (op === "<<" || op === "<<-") return expand(r.body!, st, ctx);
  const t = expand(r.target!, st, ctx);
  if (op === "<<<") return t;
  if (op === "<") return undefined;
  if (op === ">&" || op === "<&") {
    if (!t.unknown && t.vals.length === 1 && /^(\d+|-)$/.test(t.vals[0]!)) return undefined;
    return no("redirect to a file with >&");
  }
  if (op === ">" || op === ">>" || op === ">|" || op === "&>" || op === "&>>") {
    if (!t.unknown && !t.glob && t.vals.length === 1 && t.vals[0] === "/dev/null") return undefined;
    return no("output redirect to a file");
  }
  return no(`redirect ${r.op}`);
}

function withRedirs(redirs: Redir[], st: State, ctx: Ctx, run: () => Outcome): Outcome {
  for (const r of redirs) checkRedir(r, st, ctx);
  return run();
}

function evalNode(n: Node, st: State, ctx: Ctx): Outcome {
  switch (n.k) {
    case "list": {
      let R: Outcome = both(st);
      let prev = ";";
      for (const { node, op } of n.items) {
        if (prev === "&&") {
          const r = evalNode(node, R.ok, ctx);
          R = { ok: r.ok, fail: union(r.fail, R.fail) };
        } else if (prev === "||") {
          const r = evalNode(node, R.fail, ctx);
          R = { ok: union(r.ok, R.ok), fail: r.fail };
        } else R = evalNode(node, union(R.ok, R.fail), ctx);
        prev = op;
      }
      return R;
    }
    case "pipe": {
      const outs = n.cmds.map((c) => evalNode(c, st, ctx));
      return both(union(st, ...outs.flatMap((o) => [o.ok, o.fail])));
    }
    case "simple":
      return evalSimple(n, st, ctx);
    case "sub":
      return withRedirs(n.redirs, st, ctx, () => {
        const o = evalNode(n.body, st, ctx);
        return both(union(st, o.ok, o.fail));
      });
    case "group":
      return withRedirs(n.redirs, st, ctx, () => same(evalNode(n.body, st, ctx)));
    case "for":
      return withRedirs(n.redirs, st, ctx, () => {
        const vals = uniq(n.words.flatMap((w) => known(expand(w, st, ctx), "for list")));
        const bind: Bind = vals.length > 0 ? { vals, arr: false } : "taint";
        const set = (s: State): State => ({ ...s, vars: new Map(s.vars).set(n.name, bind) });
        let cur = set(st);
        const mult = ctx.mult;
        const counting = ctx.counting;
        ctx.mult = mult * iterations(n.words, st, ctx);
        try {
          for (let k = 0; ; k++) {
            if (k > 4) no("loop state does not settle");
            if (k > 0) ctx.counting = false;
            const o = evalNode(n.body, cur, ctx);
            const next = set(union(cur, o.ok, o.fail));
            if (key(next) === key(cur)) break;
            cur = next;
          }
        } finally {
          ctx.mult = mult;
          ctx.counting = counting;
        }
        return both(cur);
      });
    case "if":
      return withRedirs(n.redirs, st, ctx, () => {
        let all: State[] = [st];
        let input = st;
        for (const p of n.parts) {
          const o = evalNode(p, input, ctx);
          all = [...all, o.ok, o.fail];
          input = union(...all);
        }
        return both(input);
      });
  }
}

/**
 * The paths `command` can write or remove, run from `cwd` (null when unknown: then any relative path is UNKNOWN), or UNKNOWN with why.
 * An empty command is UNKNOWN: a record that lost its command proves nothing.
 */
export function writeScope(command: string, cwd: string | null, opts: { pre?: PathProbe; kit?: PathKit; /** The host ran the command in PowerShell (its tool says so); absent: a POSIX shell, Git Bash on win32 */ shell?: "powershell" } = {}): WriteScope {
  if (command.trim() === "") return { known: false, why: "no command" };
  const kit = opts.kit ?? guardKit();
  try {
    // PowerShell is read only on win32, and only the bounded forms of write-scope-win.ts; elsewhere it is unknown, never excluded
    if (opts.shell === "powershell" && !isWin(kit)) no("PowerShell command");
    // A Git Bash command that is one `powershell|pwsh -Command ...` call is read as the PowerShell it runs
    const wrapped = opts.shell === undefined && isWin(kit) ? gitBashPowerShell(command) : undefined;
    // Otherwise on win32 a Git Bash command is read in its own `/c/Users/...` form; a Windows-form path word (`C:\x`, `C:/x`) means the command
    // may be PowerShell or cmd run by a shell the host did not name: unknown, never excluded
    if (wrapped === undefined && opts.shell === undefined && isWin(kit) && /(^|[\s"'=(<>|;&])[A-Za-z]:[\\/]/.test(command)) no("Windows-form path in the command");
    const pcwd = cwd === null ? null : posixForm(cwd, kit);
    if (isWin(kit) && pcwd !== null && !plainDrivePath(path.posix.normalize(pcwd))) no("win32 cwd that is not a plain drive form");
    const st: State = { cwds: pcwd !== null && pcwd.startsWith("/") && !pcwd.split("/").includes("..") ? [path.posix.normalize(pcwd)] : null, vars: new Map(), ...(isWin(kit) ? { win: true as const } : {}) };
    const ctx: Ctx = { targets: [], observed: false, kinds: new Set(), runs: { python: 0, node: 0 }, mult: 1, counting: true, curl: false, pure: true, reader: false, ...(opts.pre ? { pre: opts.pre } : {}) };
    const win: WinCtx = {
      resolve: (p) => resolveIn(st, p),
      push: (t) => ctx.targets.push(t),
      fileAtPre: (p) => opts.pre !== undefined && opts.pre.exists(p) && !opts.pre.dirExists(p),
    };
    if (opts.shell === "powershell") readPowerShell(command, win);
    else if (wrapped !== undefined) readPowerShell(wrapped, win);
    else evalNode(parse(command), st, ctx);
    // at the Pre, before anything ran: every target's directories exist and hold no link the user could repoint, and no target is a link
    if (opts.pre) for (const t of ctx.targets) if (opts.pre.canonical(t.path) === undefined || !opts.pre.dirExists(path.posix.dirname(t.path))) no(`target ${t.path} is not where it reads at the Pre`);
    const seen = new Set<string>();
    const targets = ctx.targets.filter((t) => {
      const k = `${t.tree ? 1 : 0}${t.removes ? 1 : 0}${t.path}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { known: true, targets, observed: ctx.observed, ...(ctx.kinds.size > 0 ? { observedKinds: [...ctx.kinds].sort() } : {}), runs: { ...ctx.runs }, curl: ctx.curl };
  } catch (e) {
    if (e instanceof Unknown || e instanceof WinUnknown) return { known: false, why: e.message };
    return { known: false, why: "analyzer error" };
  }
}

/**
 * The PowerShell script of a Git Bash command that is exactly one `powershell(.exe)|pwsh(.exe) [options] -Command WORDS` call with
 * fully literal words and no redirect; undefined for any other command (read as Git Bash). A wrapper word that cannot be read is UNKNOWN.
 */
function gitBashPowerShell(command: string): string | undefined {
  let node: Node;
  try {
    node = parse(command);
  } catch {
    return undefined;
  }
  if (node.k !== "list" || node.items.length !== 1) return undefined;
  const n = node.items[0]!.node;
  if (n.k !== "simple" || n.words.length === 0) return undefined;
  const prog = plainOf(n.words[0]!)?.toLowerCase();
  if (prog === undefined || !PS_WRAPPERS.has(prog)) return undefined;
  if (n.redirs.length > 0) no("redirect on a powershell wrapper");
  const words = n.words.slice(1).map((w) => literalOf(w));
  if (words.some((w) => w === undefined)) no("powershell wrapper word that is not literal");
  return psWrapperScript(words as string[], true);
}

// ---------------------------------------------------------------- the exclusion

/** What the write hooks saw of a call's Python and Node children. */
export interface ObservedFacts {
  /** The call carried the per-call tag. */
  tagged: boolean;
  /** Writes and removals its children logged inside the task folder. */
  wrote: number;
  /** A child started another program (a `spawn` record). */
  spawned: boolean;
  /** The hook's registered roots cover the file in question (so a write of it would have been logged). */
  covered: boolean;
  /** The start records of the call's children: each loaded the hook and found the tag. */
  starts?: StartRecord[];
}

/** One hooked process's start record: its interpreter, pid, and parent pid (any may be absent). */
export interface StartRecord {
  path: string;
  pid: number;
  ppid?: number;
}

/**
 * Whether every hooked interpreter process the command starts provably carried the hook: per kind, as many start records from distinct
 * pids as the command can start (`scope.runs`), not counting a record whose parent is another hooked process of the call (a child it
 * started), each from an interpreter in a system folder, and none of that kind from anywhere else. A command with no hooked runs needs none.
 */
export function hooksProven(scope: WriteScope, starts: readonly StartRecord[]): boolean {
  if (!scope.known) return false;
  const runs = scope.runs ?? { python: scope.observed ? Infinity : 0, node: scope.observed ? Infinity : 0 };
  const pids = new Set(starts.map((r) => r.pid));
  for (const kind of ["python", "node"] as const) {
    if (runs[kind] === 0) continue;
    const mine = starts.filter((r) => (kind === "node" ? path.posix.basename(r.path) === "node" : PYTHON.test(path.posix.basename(r.path))));
    if (!mine.every((r) => trustedInterpreter(r.path) && Number.isInteger(r.pid))) return false;
    const top = new Set(mine.filter((r) => r.ppid === undefined || !pids.has(r.ppid) || r.ppid === r.pid).map((r) => r.pid));
    if (top.size < runs[kind]) return false;
  }
  return true;
}

/** The file system as the exclusion may trust it. */
export interface PathProbe {
  /** The real location a write to `p` lands at, or undefined when a symlink the user could have made (or a hard link) may redirect it. */
  canonical(p: string): string | undefined;
  /** A curl config file exists, which can add outputs no command line shows. */
  curlConfig(): boolean;
  /** Something (anything, a link included) is at `p`. */
  exists(p: string): boolean;
  /** `p` is a directory, reached as `canonical` allows. */
  dirExists(p: string): boolean;
}

/** For recorded drives, whose paths are no longer there to look at: every path as written, no curl config. */
export const lexicalProbe: PathProbe = { canonical: (p) => path.posix.normalize(p), curlConfig: () => false, exists: () => true, dirExists: () => true };

const MAX_HOPS = 16;

/** The filesystem calls `fsProbe` makes, so a test can supply a fake keyed by the platform's own path form. */
export interface ProbeFs {
  lstat(p: string): { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; uid: number; nlink: number };
  readlink(p: string): string;
  exists(p: string): boolean;
}

/**
 * The live probe. A directory symlink is followed only when root owns it (/tmp -> /private/tmp on macOS): the user cannot repoint it. Any
 * other symlink on the way, a target that is itself a symlink, or a target file with more than one hard link is undefined. A path that
 * does not exist (yet, or any more) is taken as written from the first missing directory on.
 */
export function fsProbe(env: NodeJS.ProcessEnv = process.env, kit: PathKit = guardKit(), fsx: ProbeFs = { lstat: lstatSync, readlink: readlinkSync, exists: existsSync }): PathProbe {
  // On win32 the analyzer's paths are Git Bash's `/c/x`; every filesystem call takes the kit's native form (`C:\x`), and no symlink is followed
  // (Windows reports uid 0 for every file, so the root-owned test cannot tell a link the user made)
  const win = isWin(kit);
  const nat = (p: string): string => (win ? kit.native(p) : p);
  const lstatSync = (p: string) => fsx.lstat(nat(p));
  const existsSync = (p: string) => fsx.exists(nat(p));
  return {
    canonical(p: string): string | undefined {
      let parts = path.posix.normalize(p).split("/").filter((x) => x !== "");
      let hops = 0;
      let cur = "/";
      if (win) {
        // only a drive path (`/c/...`) is read; a UNC or other form is undefined
        if (!/^\/[A-Za-z](\/|$)/.test(path.posix.normalize(p))) return undefined;
        cur = `/${parts[0]!.toLowerCase()}`;
        parts = parts.slice(1);
      }
      for (let i = 0; i < parts.length; i++) {
        const next = path.posix.join(cur, parts[i]!);
        const last = i === parts.length - 1;
        let st;
        try {
          st = lstatSync(next);
        } catch {
          // a missing file is taken as written; a missing directory is not (it existed at the Pre: something took it away, a link perhaps)
          return last ? next : undefined;
        }
        if (st.isSymbolicLink()) {
          if (last || win || st.uid !== 0 || ++hops > MAX_HOPS) return undefined;
          let to: string;
          try {
            to = fsx.readlink(next);
          } catch {
            return undefined;
          }
          // A real POSIX symlink read by lstat on the running OS (fsProbe never resolves on win32: unknown there)
          const abs = to.startsWith("/") ? to : path.posix.join(cur, to);
          parts = [...path.posix.normalize(abs).split("/").filter((x) => x !== ""), ...parts.slice(i + 1)];
          cur = "/";
          i = -1;
          continue;
        }
        if (last) return st.isFile() && st.nlink > 1 ? undefined : next;
        if (!st.isDirectory()) return undefined;
        cur = next;
      }
      return cur;
    },
    exists(p: string): boolean {
      try {
        lstatSync(p);
        return true;
      } catch {
        return false;
      }
    },
    dirExists(p: string): boolean {
      // walked as a directory component (so root's /tmp link is followed), never as a final one
      const c = this.canonical(path.posix.join(p, ".cocheck-probe"));
      if (c === undefined) return false;
      try {
        return lstatSync(path.posix.dirname(c)).isDirectory();
      } catch {
        return false;
      }
    },
    curlConfig(): boolean {
      if (win) {
        const h = env.USERPROFILE ?? env.HOME ?? "";
        if (!h) return true;
        const w = [env.CURL_HOME && path.posix.join(env.CURL_HOME, ".curlrc"), env.CURL_HOME && path.posix.join(env.CURL_HOME, "_curlrc"), env.APPDATA && path.posix.join(env.APPDATA, "_curlrc"), path.posix.join(h, ".curlrc"), path.posix.join(h, "_curlrc"), path.posix.join(h, ".config", "curlrc")];
        return w.some((c) => typeof c === "string" && c !== "" && fsx.exists(isWin(kit) ? kit.native(c) : c));
      }
      const home = env.HOME ?? "";
      const cands = [env.CURL_HOME && path.join(env.CURL_HOME, ".curlrc"), env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, "curlrc"), home && path.join(home, ".config", "curlrc"), home && path.join(home, ".curlrc")];
      if (!home) return true;
      return cands.some((c) => typeof c === "string" && c !== "" && existsSync(c));
    },
  };
}

const isWin = (kit: PathKit): boolean => kit.isAbs("C:/");

/**
 * An absolute path in the one POSIX shape the analyzer reads. On win32 that is Git Bash's `/c/Users/x` (drive letter lower case); a
 * non-win32 path is unchanged. A relative path comes back as written.
 */
function posixForm(p: string, kit: PathKit): string {
  if (!isWin(kit) || !kit.isAbs(p)) return p;
  const c = kit.canon(p);
  return /^[A-Za-z]:/.test(c) ? `/${c[0]!.toLowerCase()}${c.slice(2)}` : c;
}

const fold = (p: string, kit: PathKit): string => kit.key(path.posix.normalize(posixForm(p, kit)).normalize("NFC"));

/**
 * Whether a call with this write scope provably cannot have written or removed `file`: its scope is known, every Python or Node child it
 * relies on was observed writing nothing and starting nothing where the hook covers the file, no curl config can add an output, every
 * target is where it reads (`probe`), and none of them is the file or a tree holding it. Anything less is false: the call stays a suspect.
 */
export function cannotHaveWritten(file: string, scope: WriteScope, facts: ObservedFacts | undefined, probe: PathProbe, kit: PathKit = guardKit()): boolean {
  if (!scope.known || !kit.isAbs(file)) return false;
  // a command that writes nothing at all (readers only: `ls`, `echo`, `sleep`, `cat`) is never excluded: that is where a shell alias or
  // function from the user's snapshot would hide, and where a record's command may not be what ran. Only a command whose writes the analyzer
  // has read (its targets, or its hooked children) can be shown not to have written a file.
  if (scope.targets.length === 0 && !scope.observed) return false;
  if (scope.observed && !(facts !== undefined && facts.tagged && facts.wrote === 0 && !facts.spawned && facts.covered)) return false;
  // "logged no write" proves nothing for a child whose hook never loaded: each kind of hooked child the command runs needs a start
  // record for this call, from an interpreter in a system folder, and every start record of that kind must be one
  if (scope.observed && !hooksProven(scope, facts?.starts ?? [])) return false;
  if (scope.curl && probe.curlConfig()) return false;
  const f = fold(file, kit);
  const removed = scope.targets.filter((t) => t.removes);
  for (const t of scope.targets) {
    const real = probe.canonical(t.path);
    if (real === undefined) return false;
    // gone at the sweep and removed by this very call: it may have been a link (or a hard link) to the file when it was written
    if (!probe.exists(t.path) && removed.some((r) => r.path === t.path || t.path.startsWith(r.path.replace(/\/$/, "") + "/"))) {
      if (scope.targets.some((w) => !w.removes && (w.path === t.path || w.path.startsWith(t.path + "/")))) return false;
    }
    for (const p of [t.path, real]) {
      const fp = fold(p, kit);
      if (fp === f || (t.tree && (f.startsWith(fp.endsWith("/") ? fp : fp + "/") || fp === "/"))) return false;
    }
  }
  return true;
}
