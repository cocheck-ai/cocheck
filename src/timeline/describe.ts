// One plain line per call: what the agent was doing. Pure, rule-based, no model.
// Sources, first that exists wins:
//  a. 'words'       the agent's own words recorded for the call (narration)
//  b. 'description' the short description the agent wrote on the call (Claude Code's `description`)
//  c. 'label'      CoCheck's plain translation of a non-shell tool call from the call's safe label fields (the tool input, as recorded)
//  c2. 'tool'      the same translation from the tool name and any input the record holds, when there is no label
//  d. 'shell'       CoCheck's plain translation of a shell command: its first command word and the files it names
// The raw command is never part of the line, and a shell call never reads its line from the label (whose Bash row holds the command).
// Lines from c, c2 and d are CoCheck's, and say so.

import { baseName as pathBaseName, words, WORDY, type Call } from "./runs.ts";
import { isUriSubject } from "../connector/subject.ts";
import { isShellTool } from "../credit-guard.ts";
import { toolEntryOf } from "../hosts/index.ts";
import { isMcpTool, type ToolLabel } from "../tool-label.ts";

/** A file name for a sentence; a connector's URI subject is its own name, never cut to its last segment. */
const baseName = (p: unknown): string => (typeof p === "string" && isUriSubject(p) ? p : pathBaseName(p));

/** The rule version a line carries. */
export const LINE_RULE = "lines/1";

export type LineSource = "words" | "description" | "label" | "tool" | "shell";

const firstSentence = (t: string): string => {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(t);
  return (m ? m[0] : t).replace(/\s+/g, " ").trim();
};
const clip = (s: string, n = 160): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const q = (s: unknown): string => `'${clip(String(s).replace(/\s+/g, " ").trim(), 60)}'`;
const listOf = (xs: string[], max = 3): string => {
  const a = [...new Set(xs.filter((x) => x.trim() !== ""))];
  if (a.length > max) return `${a.slice(0, max).join(", ")} and ${a.length - max} more`;
  return a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`;
};
const hostOf = (u: unknown): string | null => {
  try {
    return new URL(String(u)).host;
  } catch {
    return null;
  }
};

// ---- shell ----

// Split a command into words, keeping quoted strings whole (quotes removed). Good enough for reading, never for running.
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}
const FILEISH = (t: string): boolean => !t.startsWith("-") && !/^[a-z]+:\/\//i.test(t) && !/[<>|&;$`*?{}()=]/.test(t) && (/\//.test(t) || /\.[A-Za-z0-9]{1,6}$/.test(t)) && !/^\d+(\.\d+)*$/.test(t);
const SCRIPT: Record<string, string> = { python: "Python", python3: "Python", node: "Node", deno: "Deno", bun: "Bun", ruby: "Ruby", perl: "Perl", bash: "shell", sh: "shell", zsh: "shell", php: "PHP", Rscript: "R" };

// A heredoc body is the text being written, not commands; only its opening line is read.
const withoutHeredocBodies = (cmd: string): string => cmd.replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3(?=\n|$)/g, "$1");
// A word a command can start with: no flag, no quote, no substitution.
const COMMANDISH = /^[A-Za-z0-9_.+][A-Za-z0-9_.+-]*$/;
const LOOP_HEAD = /^(for|while|until|if|elif|case|select|function)$/;
const CLOSER = /^(done|fi|esac|\}|\)|\{|\()$/;

// Split at &&, ||, ; and newline (and | when asked) outside quotes, so a `;` inside a sed script or a newline inside `python -c "..."` stays in its segment.
function splitOutsideQuotes(cmd: string, pipes: boolean, quotes = true): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') cur += ch + (cmd[++i] ?? "");
      else {
        if (ch === quote) quote = "";
        cur += ch;
      }
      continue;
    }
    if (quotes && (ch === '"' || ch === "'")) quote = ch;
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
    } else if (ch === ";" || ch === "\n" || (pipes && ch === "|" && /\s/.test(cmd[i - 1] ?? "") && /\s/.test(cmd[i + 1] ?? ""))) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  // a quote left open (an apostrophe in `echo don't`) means the quote reading was wrong; split plainly instead.
  return quote && quotes ? splitOutsideQuotes(cmd, pipes, false) : out;
}

// The segments that do something: `cd x &&`, env assignments, wrappers, loop headers and substitution leftovers are skipped.
function doingSegments(cmd: string, pipes = false): Array<{ words: string[]; text: string }> {
  const segs = splitOutsideQuotes(withoutHeredocBodies(String(cmd)), pipes)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Array<{ words: string[]; text: string }> = [];
  for (let s of segs) {
    // Leading `NAME=$(...)` assignments are dropped whole, or the command after them is lost with the substitution's words.
    s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\$\([^)]*\)|`[^`]*`|\S*)\s+)+(?=\S)/, "");
    const w = shellWords(s);
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!) ? !/\$\(|`/.test(w[0]!) : /^(sudo|time|nohup|env|exec|command|do|then|else)$/.test(w[0]!))) w.shift();
    if (!w.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!) || LOOP_HEAD.test(w[0]!) || CLOSER.test(w[0]!) || /^(cd|pushd|popd|export|set|source|\.)$/.test(w[0]!)) continue;
    if (!COMMANDISH.test(baseName(w[0]))) continue;
    out.push({ words: w, text: s });
  }
  return out;
}
// A look that changes nothing and rarely fails: a list, a read, a search, a print, a wait. A redirect makes it a write.
const HARMLESS = /^(ls|find|tree|fd|du|cat|head|tail|less|more|wc|bat|nl|grep|rg|ag|ack|echo|printf|pwd|which|type|sleep|true|test|date|file|stat)$/;
const harmless = (s: { words: string[]; text: string }): boolean => HARMLESS.test(baseName(s.words[0])) && !/(?:^|\s)>{1,2}/.test(s.text);

// Setup that rarely is the call's point: a folder made, a file touched.
const SETUP = /^(mkdir|touch)$/;
const setup = (s: { words: string[]; text: string }): boolean => SETUP.test(baseName(s.words[0]));
const RUNNER = /^(node|python3?|bash|sh|npx|deno|ruby)$/;
const unquote = (t: string): string => t.replace(/^['"]|['"]$/g, "");

/** Said of a chained call that failed when the error does not say which step it was. */
export const STEP_NOTE = "failed at a step in it";

const subOf = (s: { words: string[] }): string | undefined => s.words.slice(1).find((t) => !t.startsWith("-") && !FILEISH(t) && COMMANDISH.test(t));

/**
 * The segment the host's error text identifies, or null. Identified means, in order: a file or module the error names (one segment
 * only); a program plus its subcommand the error names ("git push", "git-push", a quoted script `test`; one segment only); a program the
 * error names that no other segment shares. A program shared by several segments (git add, git commit, git push; two node) is never
 * identified by its name alone, and a guess is never made.
 */
function namedByError(segs: Array<{ words: string[]; text: string }>, error: string): number | null {
  const err = error.toLowerCase();
  const esc = (w: string): string => w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (w: string): boolean => w.length >= 2 && new RegExp(`(?:^|[^A-Za-z0-9_.-])${esc(w)}(?![A-Za-z0-9_-])`).test(err);
  const only = (ix: number[]): number | null => (ix.length === 1 ? ix[0]! : null);
  // A name counts only whole ("memo" is not "memo.js": a folder made in the chain never matches a script of the same stem).
  const hasWhole = (w: string): boolean => has(w) && new RegExp(`(?:^|[^A-Za-z0-9_.-])${esc(w)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`).test(err);
  let byFile = segs.flatMap((s, i) => (s.words.slice(1).some((t) => FILEISH(t) && hasWhole(baseName(unquote(t)))) ? [i] : []));
  // A folder or file made by setup yields to a segment that really ran on a named file.
  if (byFile.some((i) => !setup(segs[i]!))) byFile = byFile.filter((i) => !setup(segs[i]!));
  // Several segments share the named file: the one whose own program prefixes a line of the error ("sed: 2: ...") is the one that failed,
  // else the first of them in the chain (an && chain stops at its first failure; later segments only carry knock-on errors).
  if (byFile.length > 1) {
    const own = byFile.filter((i) => new RegExp(`(?:^|\\n)\\s*${esc(baseName(segs[i]!.words[0]!))}:`).test(err));
    if (own.length === 1) return own[0]!;
    // no program owns a line of the error: the one segment that runs code (not one that edits or copies the file) is the one that failed.
    const runners = byFile.filter((i) => RUNNER.test(baseName(segs[i]!.words[0]!)));
    return runners.length === 1 ? runners[0]! : null;
  }
  if (byFile.length === 1) return byFile[0]!;
  const pool = byFile.length > 1 ? byFile : segs.map((_, i) => i);
  const bySub = pool.filter((i) => {
    const sub = subOf(segs[i]!);
    const head = baseName(segs[i]!.words[0]!);
    return !!sub && (new RegExp(`(?:^|[^A-Za-z0-9_.-])${esc(head)}[ -]${esc(sub)}(?![A-Za-z0-9_-])`).test(err) || new RegExp(`[\`'"]${esc(sub)}[\`'"]`).test(err) && has(head));
  });
  const s1 = only(bySub);
  if (s1 !== null) return s1;
  const heads = segs.map((s) => baseName(s.words[0]!));
  const byHead = pool.filter((i) => has(heads[i]!) && heads.filter((h) => h === heads[i]).length === 1);
  return only(byHead);
}

/**
 * The segment a call is named by. A call that worked is named by its main work: the first segment that does something, a folder made first
 * not counting while anything else ran. A failed call is named by a segment only when the host's error text identifies
 * it; otherwise null, and the caller names the whole call's main work and says it failed at a step in it. A single-segment call is its own.
 */
function mainSegment(cmd: string, failed = false, error: string | null = null): { words: string[]; text: string } | null {
  const none = { words: [], text: "" };
  if (!failed) {
    const segs = doingSegments(cmd);
    return segs.find((s) => !setup(s)) ?? segs[0] ?? none;
  }
  const segs = doingSegments(cmd, true);
  if (segs.length < 2) return segs[0] ?? none;
  const named = error ? namedByError(segs, error) : null;
  return named === null ? null : segs[named]!;
}

/** The segment of a chained call that failed, marked "named by the error" or "not identified"; null for a call of one segment. */
export function failedPart(cmd: string, error: string | null): string | null {
  if (doingSegments(cmd, true).length < 2) return null;
  const t = translateShell(cmd, [], true, error);
  return t.includes(STEP_NOTE) ? `not identified: the error does not say which step failed (the call's main work is: ${t.replace(`, ${STEP_NOTE}`, "")})` : `${t} (named by the error)`;
}

export function translateShell(cmd: string, named: string[] = [], failed = false, error: string | null = null): string {
  const seg = mainSegment(cmd, failed, error);
  // A failed chain whose error identifies no step is named by its main work, and says it failed at one.
  if (!seg) {
    const all = doingSegments(cmd, true);
    const main = all.find((x) => !setup(x) && !harmless(x)) ?? all.find((x) => !setup(x)) ?? all[0];
    return `${translateShell(main ? main.text : cmd, named)}, ${STEP_NOTE}`;
  }
  const { words: w, text } = seg;
  if (!w.length) return "Ran a shell command";
  const head = baseName(w[0]);
  const args = w.slice(1).filter((t) => t !== "");
  const pipeAt = args.findIndex((t) => t === "|");
  const own = pipeAt < 0 ? args : args.slice(0, pipeAt);
  // sed's first plain word is its script (s/a/b/), not a file.
  const script = head === "sed" && !own.some((t) => t === "-e" || t === "-f") ? own.find((t) => !t.startsWith("-")) : undefined;
  const files = [...own.filter((t) => t !== script && FILEISH(t)).map(baseName), ...named.map(baseName)].filter((f) => f !== "");
  const on = (fs: string[]): string => (fs.length ? ` on ${listOf(fs)}` : "");
  const app = /tell\s+application\s+(?:id\s+)?"([^"]+)"/i.exec(cmd)?.[1] ?? /tell\s+application\s+(?:id\s+)?'([^']+)'/i.exec(cmd)?.[1];
  const redirect = /(?:^|\s)>{1,2}\s*("?)([^\s"]+)\1/.exec(text)?.[2];

  if (head === "osascript") return app ? `Sent a command to ${app}${on(named.map(baseName))}` : "Ran an AppleScript";
  if (SCRIPT[head]) {
    const kind = SCRIPT[head]!;
    const a = kind === "shell" ? "a" : /^[AEIOU]/.test(kind) ? "an" : "a";
    if (own.some((t) => t === "-c" || t === "-e") || own[0] === "-" || /<</.test(text)) return `Ran ${a} short ${kind} program${on([...new Set(files)])}`;
    const prog = own.find((t) => !t.startsWith("-"));
    if (prog) return `Ran ${a} ${kind} script (${baseName(prog)})${on([...new Set(files.filter((f) => f !== baseName(prog)))])}`;
    return `Ran ${kind}`;
  }
  if (/^(ls|find|tree|fd|du)$/.test(head)) {
    const d = own.find((t) => !t.startsWith("-") && (FILEISH(t) || t === "."));
    return `Listed files in ${d ? (d === "." ? "the folder" : baseName(d.replace(/\/+$/, "")) || d) : "the folder"}`;
  }
  // `cat > memo.js <<EOF` writes the file; it does not read one.
  if (head === "cat" && redirect && baseName(redirect) !== "") return `Wrote to ${baseName(redirect)}`;
  if (/^(cat|head|tail|less|more|wc|bat|nl|xxd|hexdump|file|stat|unzip)$/.test(head) || (head === "sed" && !own.some((t) => /^-i/.test(t)))) return files.length ? `Read ${listOf(files)}` : "Read a file";
  if (head === "sed" || head === "perl") return files.length ? `Edited ${listOf(files)}` : "Edited a file";
  if (/^(grep|rg|ag|ack)$/.test(head)) return files.length ? `Searched in ${listOf(files)}` : "Searched the files";
  if (head === "cp" || head === "mv" || head === "ditto") {
    const fs = own.filter((t) => !t.startsWith("-"));
    const verb = head === "mv" ? "Moved" : "Copied";
    return fs.length >= 2 ? `${verb} ${listOf(fs.slice(0, -1).map(baseName))} to ${baseName(fs.at(-1)) || fs.at(-1)}` : `${verb} a file`;
  }
  if (head === "rm" || head === "trash" || head === "rmdir") return files.length ? `Deleted ${listOf(files)}` : "Deleted files";
  if (head === "mkdir") return files.length || own.some((t) => !t.startsWith("-")) ? `Made the folder ${baseName(own.filter((t) => !t.startsWith("-"))[0])}` : "Made a folder";
  if (head === "touch") return files.length ? `Created ${listOf(files)}` : "Created a file";
  if (head === "open") return app || own.includes("-a") ? `Opened ${listOf(files) || "an app"}${own.includes("-a") ? " in " + own[own.indexOf("-a") + 1] : ""}` : files.length ? `Opened ${listOf(files)}` : "Opened something";
  if (head === "apply_patch" || head === "patch") return files.length ? `Changed ${listOf(files)} with a patch` : "Applied a patch";
  if (head === "curl" || head === "wget") {
    const u = own.map(hostOf).find(Boolean);
    return u ? `Downloaded from ${u}` : "Downloaded something";
  }
  if ((head === "echo" || head === "printf" || head === "tee") && (redirect || (head === "tee" && files.length))) return `Wrote to ${baseName(redirect ?? files[0])}`;
  if (head === "echo" || head === "printf") return "Printed a message";
  // `uv run x.py` is the script it runs, not the runner.
  if (head === "uv" && own[0] === "run") {
    const rest = own.slice(1);
    const at = rest.findIndex((t) => SCRIPT[baseName(t)] !== undefined || FILEISH(t));
    return at < 0 ? "Ran a program" : translateShell(rest.slice(at).join(" "), named);
  }
  if (/^(git|npm|pnpm|yarn|pip|pip3|brew|cargo|go|make|docker|uv)$/.test(head)) {
    const sub = own.find((t) => !t.startsWith("-"));
    return `Ran ${head}${sub && !FILEISH(sub) ? " " + sub : ""}${on([...new Set(files)])}`;
  }
  if (head === "sleep") return "Waited";
  if (head === "kill" || head === "pkill" || head === "killall") return "Stopped a running program";
  return `Ran ${head}${on([...new Set(files)])}`;
}

// ---- non-shell tools ----

/** A skill's name without its prefix: "anthropic-skills:pdf" is "pdf". The core names no product. */
const skillName = (raw: string): string => raw.slice(raw.lastIndexOf(":") + 1).trim();

export function translateTool(tool: unknown, input: unknown, named: string[] = [], host?: string | null): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const f = i.file_path ?? i.path ?? i.notebook_path ?? named[0] ?? null;
  const file = f ? baseName(f) : null;
  const t = String(tool ?? "");
  // A sentence by the tool's class in its host's table; a file tool is described only when its input has the file-tool shape the sentence reads.
  const entry = toolEntryOf(host, t);
  switch (entry?.class === "launcher" || (entry?.fileInput === true && entry.class !== "read") || entry?.class === "read" ? entry.class : undefined) {
    case "read":
      return file ? `Read ${file}` : "Read a file";
    case "edit":
      return file ? `Edited ${file}` : "Edited a file";
    case "write":
      return file ? `Wrote ${file}` : "Wrote a file";
    case "notebook-edit":
      return file ? `Edited the notebook ${file}` : "Edited a notebook";
    case "launcher": {
      const what = i.description ?? i.task_name;
      return what ? `Started a helper agent: ${what}` : (i.subagent_type ?? i.agent_type) ? `Started a helper agent (${i.subagent_type ?? i.agent_type})` : "Started a helper agent";
    }
  }
  switch (t) {
    case "Glob":
      return i.pattern ? `Looked for files matching ${q(i.pattern)}` : "Looked for files";
    case "Grep":
      return i.pattern ? `Searched the files for ${q(i.pattern)}` : "Searched the files";
    case "Skill":
      return i.skill || i.name ? `Loaded ${skillName(String(i.skill ?? i.name))} instructions` : "Loaded instructions";
    case "ToolSearch":
      return "Looked up a tool";
    case "WebFetch": {
      const h = hostOf(i.url);
      return h ? `Opened ${h}` : "Opened a web page";
    }
    case "WebSearch":
      return i.query ? `Searched the web for ${q(i.query)}` : "Searched the web";
    case "TodoWrite":
      return "Updated its to-do list";
    case "AskUserQuestion":
      return "Asked you a question";
    case "TaskStop":
    case "KillShell":
    case "KillBash":
      return "Stopped a running task";
    case "BashOutput":
    case "TaskOutput":
      return "Checked on a running command";
    case "ExitPlanMode":
      return "Presented its plan";
    case "SendMessage":
    case "send_message":
      return "Sent a message";
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(t);
  const files = named.map(baseName);
  const what = i.name ?? i.query ?? i.pattern;
  if (mcp) return `Used ${mcp[2]!.replace(/_/g, " ")} from ${mcp[1]!.replace(/_/g, " ")}${what ? " for " + q(what) : ""}${files.length ? " on " + listOf(files) : ""}`;
  return `Used ${t || "a tool"}${files.length ? " on " + listOf(files) : ""}`;
}

// ---- the line ----

type LineCall = Pick<Call, "tool" | "description" | "command" | "named" | "narration" | "input" | "closedBy"> & { background?: boolean } & { host?: string | null } & { error?: string | null } & { toolLabel?: ToolLabel | null };

// The label's fields as a tool input. `command` is never read from it: only a shell call has one, and a shell call never gets here.
// A list (paths) reads as its first entry. Null when the label holds no field, so a tool known only by its input field names stays "Used <tool>".
function labelInput(label: ToolLabel | null | undefined): Record<string, string> | null {
  if (!label) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(label.fields)) {
    if (k === "command") continue;
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === "string" && one) out[k] = one;
  }
  return Object.keys(out).length ? out : null;
}

export const isShell = (c: Pick<Call, "tool" | "command"> & { host?: string | null }): boolean => isShellTool(String(c.tool ?? ""), c.host) || (!!c.command && c.command !== c.tool && !c.tool);

const REFUSED_LINE = "The host refused this call; nothing ran";
const NO_RESULT_SHELL = "Ran a command; no result recorded";

export interface Line {
  text: string;
  source: LineSource;
  command?: string | null;
}

export function lineOf(c: LineCall): Line {
  // The host refused the call before running it: nothing ran, whatever the command or the agent's words say.
  if (c.closedBy === "refused") return { text: REFUSED_LINE, source: isShell(c) ? "shell" : "tool", command: c.command && c.command !== c.tool ? c.command : null };
  const said = c.narration?.source === "agent" ? words(c.narration.text) : "";
  // Words with no letter or digit in the line they would show ("." left after a mode label, "...", "-") are not the agent's words; the next source speaks.
  const saidLine = said ? clip(firstSentence(said), 220) : "";
  if (WORDY.test(saidLine)) return { text: saidLine, source: "words" };
  // A connector's description is an input value; ledgers written before this fix may hold one.
  if (c.description && WORDY.test(c.description) && !isMcpTool(c.tool ?? undefined)) return { text: c.description.trim(), source: "description" };
  const named = [...(c.named ?? [])];
  // A call that no Post closed (expiry, or Stop on a call that did not run in the background, whose Post came at its launch) has no result: never "Wrote to", never a success, whatever its command says.
  if (c.closedBy === "expiry" || (c.closedBy === "stop" && !c.background)) {
    const shell = isShell(c);
    return { text: shell ? NO_RESULT_SHELL : `Called ${c.tool || "a tool"}; no result recorded`, source: shell ? "shell" : "tool", command: shell ? c.command || null : c.command && c.command !== c.tool ? c.command : null };
  }
  if (isShell(c)) return { text: translateShell(c.command ?? "", named, c.closedBy === "failure", c.error ?? null), source: "shell", command: c.command || null };
  const fromLabel = labelInput(c.toolLabel);
  if (fromLabel) return { text: translateTool(c.tool, fromLabel, named, c.host), source: "label", command: c.command && c.command !== c.tool ? c.command : null };
  return { text: translateTool(c.tool, c.input, named, c.host), source: "tool", command: c.command && c.command !== c.tool ? c.command : null };
}

export interface LineGroup {
  text: string;
  source: LineSource;
  members: Array<{ text: string; source: LineSource; failed: boolean; index: number; id?: string; command: string | null }>;
  line: string;
  failed: boolean;
  from: number;
  to: number;
}

// Consecutive calls with the same line become one: "Tried 3 times: ..." when any failed, else "... (3 times)".
export function groupLines(calls: Array<LineCall & { index?: number; id?: string }>): LineGroup[] {
  const out: Array<Partial<LineGroup> & Pick<LineGroup, "text" | "source" | "members">> = [];
  for (const c of calls) {
    const l = { ...lineOf(c), failed: c.closedBy === "failure", index: c.index!, id: c.id, command: c.command && c.command !== c.tool ? c.command : null };
    const prev = out.at(-1);
    if (prev && prev.text === l.text && prev.source === l.source) {
      prev.members.push(l);
      continue;
    }
    out.push({ text: l.text, source: l.source, members: [l] });
  }
  for (const g of out) {
    const n = g.members.length;
    const bad = g.members.filter((m) => m.failed).length;
    const allBadFirst = bad && g.members.slice(0, bad).every((m) => m.failed);
    const didnt = g.text.includes(STEP_NOTE) ? "" : " (didn't work)";
    if (n === 1) g.line = g.text + (bad ? didnt : "");
    else if (!bad) g.line = `${g.text} (${n} times)`;
    else g.line = `Tried ${n} times: ${g.text}` + (bad === n ? " (didn't work)" : allBadFirst ? ` (the first ${bad === 1 ? "" : bad + " "}didn't work)`.replace("first  ", "first ") : ` (${bad} didn't work)`);
    g.failed = bad === n;
    g.from = g.members[0]!.index;
    g.to = g.members.at(-1)!.index;
  }
  return out as LineGroup[];
}

export const SOURCE_NOTE: Record<LineSource, string> = {
  words: "the agent's words",
  description: "the agent's short description",
  label: "CoCheck's plain translation, from the tool call's recorded label",
  tool: "CoCheck's plain translation",
  shell: "CoCheck's plain translation of the command",
};
