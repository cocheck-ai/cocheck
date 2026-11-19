// When several open calls are credited with one change, which of them shows a write signal for the file. CoCheck never sees which
// process wrote a file, so this reads the call's own command and input text, and only for signs that the text writes the file:
//   - a redirect or tee target; the destination of cp, mv, touch, install, sed -i, dd of=, curl -o, wget -O;
//   - the file named inside a save or write call in script text, as a literal or as a name whose latest assignment is that literal (heredoc bodies, -c/-e scripts, script fields of a tool input);
//   - the file_path of a Write or Edit tool call;
// A changed file that was deleted narrows by a delete signal instead (`callDeletesFile`): rm, unlink, or a delete call in script text, for the file named in full or by a plain relative name, never a glob or variable, and not after a `cd` out of its folder.
//   - a script file the call runs (`node memo.js`, `python3 build.py`) that an earlier call of the same agent wrote whole (a Write call, or a heredoc into the file),
//     when that script text names the file in a save or write call. Only the latest whole write of that file name counts; a later partial edit is not seen.
// A name inside a read-only command (ls, cat, grep, head, tail, open, file, stat, wc) or in read-only script text is no signal. A path
// with a variable in the path text, a glob or `..` in it, or a full path in another folder, is no match. When unsure the answer is "no signal", and the
// caller leaves the change joint: a joint change claims no maker, a wrong narrowing claims the wrong one.

export type CallText = { tool?: string | null; command?: string | null; input?: unknown };

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const SCRIPT_RUNNERS = /^(python[\d.]*|node|nodejs|ruby|perl|php|deno|bun|Rscript|osascript|tsx|ts-node(?:-esm|-script)?)$/;
const SCRIPT_FLAGS = new Set(["-c", "-e", "-E", "-p", "--eval", "--command"]);
const DEST_ALL = new Set(["touch"]);
const DEST_LAST = new Set(["cp", "mv", "install", "ln", "rsync", "scp"]);

/** Whether a path as written in a command or script (`token`) is the file `file` (an absolute path). */
import { pathKit } from "../paths.ts";
function pathIs(token: string, file: string): boolean {
  const kit = pathKit();
  // A backslash is a separator where the platform says so (Windows), and a quoting character elsewhere.
  const backslashSeparates = kit.baseName("a\\b") === "b";
  if (token === "" || (backslashSeparates ? /[$*?`~{}\[\]]/ : /[$*?`~{}\\\[\]]/).test(token)) return false;
  const tok = backslashSeparates ? token.replace(/\\/g, "/") : token;
  const f = kit.canon(file);
  const name = kit.baseName(f);
  if (name === "" || !kit.key(tok).endsWith(kit.key(name))) return false;
  if (kit.isAbs(tok)) return kit.same(tok, f);
  let rest = tok;
  while (rest.startsWith("./")) rest = rest.slice(2);
  if (kit.key(rest) === kit.key(name)) return true;
  if (rest.split("/").includes("..")) return false;
  return rest.slice(0, rest.length - name.length).endsWith("/") && kit.key(f).endsWith("/" + kit.key(rest));
}

interface Parsed {
  /** Simple commands, each as words; `redirects` are the targets of `>`, `>>`, `>|`. */
  commands: Array<{ words: string[]; redirects: string[]; piped?: boolean }>;
  /** Heredoc bodies, as script text. */
  bodies: string[];
  /** For each body, the command it feeds (an index into `commands`), or -1 when none was read. */
  owners: number[];
}

/** A small shell reader: quotes, separators, redirects and heredocs. Anything it cannot read contributes nothing. */
export function parseShell(text: string): Parsed {
  const commands: Parsed["commands"] = [];
  const bodies: string[] = [];
  const owners: number[] = [];
  const lines = text.split("\n");
  let cur: Parsed["commands"][number] = { words: [], redirects: [] };
  const end = (): void => {
    if (cur.words.length > 0 || cur.redirects.length > 0) commands.push(cur);
    cur = { words: [], redirects: [] };
  };
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]!;
    const pending: string[] = [];
    let word = "";
    let has = false;
    let redirect = false;
    const push = (): void => {
      if (!has) return;
      if (redirect) cur.redirects.push(word);
      else cur.words.push(word);
      word = "";
      has = false;
      redirect = false;
    };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === "'" || ch === '"') {
        // a quote runs on over lines until it closes, as in a shell (`python3 -c "` then the script lines); in double quotes a backslash escapes `"`, `\`, `$` and a backtick
        let j = i + 1;
        for (;;) {
          let close = -1;
          for (let k = j; k < line.length; k++) {
            if (ch === '"' && line[k] === "\\" && /["\\$`]/.test(line[k + 1] ?? "")) { word += line.slice(j, k) + line[k + 1]!; j = k + 2; k++; continue; }
            if (line[k] === ch) { close = k; break; }
          }
          if (close >= 0) { word += line.slice(j, close); i = close; break; }
          word += line.slice(j);
          if (li + 1 >= lines.length) { i = line.length; break; }
          word += "\n";
          line = lines[++li]!;
          j = 0;
        }
        has = true;
      } else if (ch === "\\" && i + 1 < line.length) {
        word += line[++i]!;
        has = true;
      } else if (ch === "#" && !has) break;
      else if (/\s/.test(ch)) push();
      else if (ch === ";" || ch === "|" || ch === "&") {
        if (ch === "&" && line[i + 1] === ">") {
          push();
          i += line[i + 2] === ">" ? 2 : 1;
          redirect = true;
          continue;
        }
        push();
        end();
        const pipe = ch === "|" && line[i + 1] !== "|";
        while (line[i + 1] === ch) i++;
        if (pipe) cur.piped = true;
      } else if (ch === ">") {
        if (/^\d+$/.test(word)) { word = ""; has = false; }
        push();
        if (line[i + 1] === "&") { i++; word = "&"; has = true; continue; }
        if (line[i + 1] === ">" || line[i + 1] === "|") i++;
        redirect = true;
      } else if (ch === "<") {
        if (line[i + 1] === "<" && line[i + 2] !== "<") {
          const m = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line.slice(i));
          if (m) {
            pending.push(m[2]!);
            i += m[0].length - 1;
            push();
            continue;
          }
        }
        // an input redirect's file is read, never written: the "<" marks it for `plain` filters, and it is not a write target
        push();
        if (line[i + 1] === "<") i++;
        cur.words.push("<");
      } else {
        word += ch;
        has = true;
      }
    }
    push();
    // a "&" target is a file-descriptor duplicate (`2>&1`), not a file
    cur.redirects = cur.redirects.filter((r) => !/^&\d*-?$/.test(r) && r !== "&");
    if (pending.length > 0) {
      const hadCommand = cur.words.length > 0 || cur.redirects.length > 0;
      end();
      for (const tag of pending) {
        const body: string[] = [];
        for (li++; li < lines.length && lines[li]!.trim() !== tag; li++) body.push(lines[li]!);
        bodies.push(body.join("\n"));
        owners.push(hadCommand ? commands.length - 1 : -1);
      }
    } else if (!/\\$/.test(line) && !/(\|\||&&|\|)\s*$/.test(line)) end();
  }
  end();
  return { commands, bodies, owners };
}

export const stringsOf = (value: unknown, skip: ReadonlySet<string>, out: string[] = [], depth = 0): string[] => {
  if (typeof value === "string") out.push(value);
  else if (depth < 8 && Array.isArray(value)) for (const v of value) stringsOf(v, skip, out, depth + 1);
  else if (depth < 8 && value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) if (!skip.has(k)) stringsOf(v, skip, out, depth + 1);
  return out;
};

const WRITE_CALL = /(?:\.|\b)(save|saveAs|saveSync|write|writeFile|writeFileSync|writeText|write_text|write_bytes|to_excel|to_csv|to_pickle|to_json|dump|SaveAs|SaveAs2|SaveCopyAs|createWriteStream)\s*\(([^)\n]*)/g;
const OPEN_WRITE = /\bopen\s*\(\s*([^,)\n]*)\s*,\s*['"][wax][bt+]*['"]/g;
const LITERAL = /['"`]([^'"`\n]+)['"`]/g;

const ASSIGN = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*([-+*/%|&^]?)=(?![=>])\s*([^\n]*)/g;
const SOLE_LITERAL = /^(['"`])([^'"`\n]*)\1\s*(?:[;,]|$)/;
const IDENT = /(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$(])/g;

/** Whether script text names the file as the target of a save or write call, by a literal or by a name last assigned that literal. */
function scriptWrites(script: string, file: string): boolean {
  const literalIs = (region: string): boolean => {
    for (const m of region.matchAll(LITERAL)) if (pathIs(m[1]!.trim(), file)) return true;
    return false;
  };
  // every assignment in the script, in order; a name holds a path only when its latest assignment before the write is a lone string literal
  const assigns = [...script.matchAll(ASSIGN)].map((m) => ({ at: m.index!, name: m[1]!, path: m[2] === "" ? (SOLE_LITERAL.exec(m[3]!)?.[2] ?? null) : null }));
  const namedIs = (region: string, before: number): boolean => {
    for (const m of region.replace(LITERAL, " ").matchAll(IDENT)) {
      const last = assigns.filter((a) => a.name === m[0] && a.at < before).at(-1);
      if (last?.path != null && pathIs(last.path.trim(), file)) return true;
    }
    return false;
  };
  for (const m of script.matchAll(WRITE_CALL)) if (literalIs(m[2]!) || namedIs(m[2]!, m.index!)) return true;
  for (const m of script.matchAll(OPEN_WRITE)) if (literalIs(m[1]!) || namedIs(m[1]!, m.index!)) return true;
  return false;
}

/** The words of a command that follow a script flag, as script text (`python3 -c "..."`). */
export function inlineScripts(words: string[]): string[] {
  const at = words.findIndex((w) => SCRIPT_RUNNERS.test(w.slice(w.lastIndexOf("/") + 1)));
  if (at < 0) return [];
  return words.flatMap((w, i) => (i > at && SCRIPT_FLAGS.has(words[i - 1]!) ? [w] : []));
}

function commandWrites(words: string[], redirects: string[], file: string): boolean {
  if (redirects.some((r) => pathIs(r, file))) return true;
  const w = words[0] === "sudo" || words[0] === "command" ? words.slice(1) : words;
  const prog = (w[0] ?? "").slice((w[0] ?? "").lastIndexOf("/") + 1);
  const args = w.slice(1);
  const plain = args.filter((a) => !a.startsWith("-") && a !== "<");
  if (prog === "tee") return plain.some((a) => pathIs(a, file));
  if (DEST_ALL.has(prog)) return plain.some((a) => pathIs(a, file));
  if (DEST_LAST.has(prog)) return plain.length >= 2 && pathIs(plain.at(-1)!, file);
  if (prog === "sed") return args.some((a) => /^-[A-Za-z]*i/.test(a) || a === "--in-place" || a.startsWith("--in-place=")) && plain.length >= 2 && pathIs(plain.at(-1)!, file);
  if (prog === "dd") return args.some((a) => a.startsWith("of=") && pathIs(a.slice(3), file));
  if (prog === "curl") return args.some((a, i) => (args[i - 1] === "-o" || args[i - 1] === "--output") && pathIs(a, file));
  if (prog === "wget") return args.some((a, i) => (args[i - 1] === "-O" || args[i - 1] === "--output-document") && pathIs(a, file));
  return false;
}

const DELETE_CALL = /(?:\.|\b)(remove|removeSync|unlink|unlinkSync|rm|rmSync)\s*\(([^)\n]*)/g;
const PATH_UNLINK = /\bPath\s*\(([^)\n]*)\)\s*\.\s*unlink\s*\(/g;

/** Whether script text names the file as the target of a delete call (`os.remove("a")`, `fs.unlinkSync("a")`, `Path("a").unlink()`), by a literal or by a name last assigned that literal. */
function scriptDeletes(script: string, file: string): boolean {
  const literalIs = (region: string): boolean => {
    for (const m of region.matchAll(LITERAL)) if (pathIs(m[1]!.trim(), file)) return true;
    return false;
  };
  const assigns = [...script.matchAll(ASSIGN)].map((m) => ({ at: m.index!, name: m[1]!, path: m[2] === "" ? (SOLE_LITERAL.exec(m[3]!)?.[2] ?? null) : null }));
  const namedIs = (region: string, before: number): boolean => {
    for (const m of region.replace(LITERAL, " ").matchAll(IDENT)) {
      const last = assigns.filter((a) => a.name === m[0] && a.at < before).at(-1);
      if (last?.path != null && pathIs(last.path.trim(), file)) return true;
    }
    return false;
  };
  for (const m of script.matchAll(DELETE_CALL)) if (literalIs(m[2]!) || namedIs(m[2]!, m.index!)) return true;
  for (const m of script.matchAll(PATH_UNLINK)) if (literalIs(m[1]!) || namedIs(m[1]!, m.index!)) return true;
  return false;
}

/** The words of a command that follow `rm` or `unlink`, with the files it names; `cdOut` says an earlier `cd` left the file's folder or could not be read. */
function commandDeletes(words: string[], file: string, cdOut: boolean): boolean {
  const w = words[0] === "sudo" || words[0] === "command" ? words.slice(1) : words;
  const prog = (w[0] ?? "").slice((w[0] ?? "").lastIndexOf("/") + 1);
  if (prog !== "rm" && prog !== "unlink") return false;
  const ended = w.indexOf("--");
  const plain = w.slice(1).filter((a, i) => (!a.startsWith("-") || (ended >= 0 && i + 1 > ended)) && a !== "<" && a !== "--");
  return plain.some((a) => pathIs(a, file) && !(cdOut && !pathKit().isAbs(a)));
}

/** Whether the call's own command or input text shows it deleting `file`: `rm`, `rm -f`, `unlink`, and delete calls in script text. A glob, a variable or another file is no signal. */
export function callDeletesFile(call: CallText, file: string, lookup?: ScriptLookup): boolean {
  const input = call.input as Record<string, unknown> | null | undefined;
  const commands = [call.command ?? "", ...(input && typeof input === "object" && typeof input.command === "string" ? [input.command] : [])];
  const scripts = stringsOf(call.input, new Set(["command", "file_path", "notebook_path", "path"]));
  const dir = file.slice(0, file.lastIndexOf("/"));
  for (const text of commands) {
    const parsed = parseShell(text);
    let cdOut = false;
    for (const c of parsed.commands) {
      if (c.words[0] === "cd" || c.words[0] === "pushd") {
        const target = c.words.slice(1).find((a) => !a.startsWith("-"));
        if (target === undefined || target.replace(/\/+$/, "") !== dir) cdOut = true;
      }
      if (commandDeletes(c.words, file, cdOut)) return true;
      if (inlineScripts(c.words).some((s) => scriptDeletes(s, file))) return true;
      if (lookup) for (const name of scriptsRun(c.words)) {
        const latest = lookup(name).at(-1);
        if (latest !== undefined && scriptDeletes(latest, file)) return true;
      }
    }
    if (parsed.bodies.some((b) => scriptDeletes(b, file))) return true;
  }
  return scripts.some((s) => scriptDeletes(s, file));
}

/** The text of script files by file name, as earlier calls of the same agent wrote them whole; the newest write of a name is last. */
export type ScriptLookup = (name: string) => string[];

const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** The script files (file name and whole text) one call wrote: a Write tool's content, or a heredoc into `cat > file` or `tee file`. */
export function scriptsWrittenBy(call: CallText): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const input = call.input as Record<string, unknown> | null | undefined;
  if (call.tool === "Write" && input && typeof input === "object" && typeof input.file_path === "string" && typeof input.content === "string") out.push({ name: baseOf(input.file_path), text: input.content });
  const commands = [call.command ?? "", ...(input && typeof input === "object" && typeof input.command === "string" ? [input.command] : [])];
  for (const text of commands) {
    const parsed = parseShell(text);
    parsed.bodies.forEach((body, i) => {
      const owner = parsed.commands[parsed.owners[i]!];
      if (!owner) return;
      const prog = baseOf(owner.words[0] ?? "");
      const targets = prog === "cat" || prog === "" ? owner.redirects : prog === "tee" ? owner.words.slice(1).filter((a) => !a.startsWith("-")) : [];
      for (const t of targets) if (t !== "" && !/[*?`{}\\\[\]]/.test(t)) out.push({ name: baseOf(t), text: body });
    });
  }
  return out;
}

/** The script files a command runs: `node memo.js` and the like, the first plain word after the runner. Inline scripts (-c, -e) are read elsewhere. */
export function scriptsRun(words: string[]): string[] {
  const at = words.findIndex((w) => SCRIPT_RUNNERS.test(baseOf(w)));
  if (at < 0) return [];
  const rest = words.slice(at + 1);
  if (rest.some((w) => SCRIPT_FLAGS.has(w))) return [];
  const name = rest.find((w) => !w.startsWith("-") && w !== "<");
  return name === undefined || /[$*?`{}\\]/.test(baseOf(name)) ? [] : [baseOf(name)];
}

/** Whether the call's own command or input text shows it writing `file`. `lookup` gives the text of script files the call may run. */
export function callWritesFile(call: CallText, file: string, lookup?: ScriptLookup): boolean {
  const input = call.input as Record<string, unknown> | null | undefined;
  if (call.tool && WRITE_TOOLS.has(call.tool) && input && typeof input === "object") {
    for (const k of ["file_path", "notebook_path", "path"]) if (typeof input[k] === "string" && pathIs(input[k] as string, file)) return true;
  }
  const commands = [call.command ?? "", ...(input && typeof input === "object" && typeof input.command === "string" ? [input.command] : [])];
  const scripts = stringsOf(call.input, new Set(["command", "file_path", "notebook_path", "path"]));
  for (const text of commands) {
    const parsed = parseShell(text);
    for (const c of parsed.commands) {
      if (commandWrites(c.words, c.redirects, file)) return true;
      if (inlineScripts(c.words).some((s) => scriptWrites(s, file))) return true;
      if (lookup) for (const name of scriptsRun(c.words)) {
        const latest = lookup(name).at(-1);
        if (latest !== undefined && scriptWrites(latest, file)) return true;
      }
    }
    if (parsed.bodies.some((b) => scriptWrites(b, file))) return true;
  }
  return scripts.some((s) => scriptWrites(s, file));
}

/**
 * When several calls are credited with one change, it goes to one call alone only if exactly one of them shows a write signal for the
 * file. None, or two or more, or a call with no record, leaves the credit as recorded.
 */
export function creditedAfterWriteSignal(credited: readonly string[], file: string, callOf: (id: string) => CallText | undefined, scriptsOf?: (id: string) => ScriptLookup | undefined, deleted = false): string[] {
  if (credited.length < 2) return [...credited];
  const records = credited.map((id) => callOf(id));
  if (records.some((r) => r === undefined)) return [...credited];
  // For a deleted file the signal is a delete (`rm`, `unlink`, a delete call), not a write
  const writing = credited.filter((_, i) => (deleted ? callDeletesFile : callWritesFile)(records[i]!, file, scriptsOf?.(credited[i]!)));
  return writing.length === 1 ? writing : [...credited];
}
