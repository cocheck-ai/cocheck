// Pure line editing of Codex's config.toml hooks. No TOML library: CoCheck only appends whole lines,
// tags each one with a trailing marker comment, and removes exactly the tagged lines.
//
// Marker: every line CoCheck adds ends with ` # cocheck`; remove drops exactly the marked lines.
//   `# cocheck-eof # cocheck`    sentinel added when the file lacked a final newline; remove drops it and
//                                the newline CoCheck added before it.
// Limits: line-based, so a multi-line string value that looks like a table header or key can fool it.
// CoCheck never edits a line of the person's: it writes no `[features]` block and no `hooks = true` (Codex's hooks feature is on by
// default). A `hooks = false` the person wrote is theirs and stays; it keeps Codex from running any hook.

const MARK = " # cocheck";
const MARKED_RE = / # cocheck$/;
const SENTINEL = `# cocheck-eof${MARK}`;

const body = (line: string): string => line.replace(/\r?\n$/, "");
const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const isMarked = (line: string): boolean => MARKED_RE.test(body(line));

function detectEol(text: string): string {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

function tomlString(s: string): string {
  const esc = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${esc}"`;
}

export function hasCoCheckHooks(toml: string): boolean {
  return splitLines(toml).some((l) => /^\s*\[\[hooks\.[A-Za-z]+\]\]/.test(l) && isMarked(l));
}

function cocheckEvents(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    const m = /^\s*\[\[hooks\.([A-Za-z]+)\]\]/.exec(body(l));
    if (m && isMarked(l)) out.add(m[1]);
  }
  return out;
}

export function addCoCheckHooks(
  toml: string,
  opts: { command: (event: string) => string; events: string[] },
): { toml: string; changed: boolean } {
  const eol = detectEol(toml);
  const lines = splitLines(toml);
  const have = cocheckEvents(lines);
  const missing = opts.events.filter((e, i) => !have.has(e) && opts.events.indexOf(e) === i);
  if (missing.length === 0) return { toml, changed: false };

  let fixedEof = false;
  if (lines.length > 0 && !/\n$/.test(lines[lines.length - 1])) {
    lines[lines.length - 1] += eol;
    fixedEof = true;
  }
  if (fixedEof) lines.push(`${SENTINEL}${eol}`);
  for (const e of missing) {
    lines.push(
      `[[hooks.${e}]]${MARK}${eol}`,
      `[[hooks.${e}.hooks]]${MARK}${eol}`,
      `type = "command"${MARK}${eol}`,
      `command = ${tomlString(opts.command(e))}${MARK}${eol}`,
    );
  }
  return { toml: lines.join(""), changed: true };
}

export function removeCoCheckHooks(toml: string): { toml: string; changed: boolean } {
  const lines = splitLines(toml);
  if (!lines.some(isMarked)) return { toml, changed: false };
  const out: string[] = [];
  for (const line of lines) {
    const b = body(line);
    if (!MARKED_RE.test(b)) {
      out.push(line);
      continue;
    }
    if (b === SENTINEL) {
      // CoCheck added the newline before this line; the original file did not end with one.
      if (out.length > 0) out[out.length - 1] = body(out[out.length - 1]);
      continue;
    }
  }
  return { toml: out.join(""), changed: true };
}

/** Events in `events` that have no CoCheck table in the config text. */
export function missingCoCheckEvents(toml: string, events: readonly string[]): string[] {
  const have = cocheckEvents(splitLines(toml));
  return events.filter((e) => !have.has(e));
}

/**
 * Why `addCoCheckHooks` cannot be used on this config, or undefined. CoCheck writes `[[hooks.X]]` array tables; a config that already
 * defines hooks as a `[hooks]` / `[hooks.X]` table or as root `hooks.X = [...]` keys would become invalid TOML (a key defined twice). `[hooks.state...]` is exempt.
 * Line-based, like the rest of this file: a multi-line string that looks like a header can fool it.
 */
export function inlineHooksProblem(toml: string): string | undefined {
  let inRoot = true;
  for (const line of splitLines(toml)) {
    const b = body(line);
    // Codex's own trust records live in `[hooks.state]` and `[hooks.state."<key>"]`; `state` is no event array, so it coexists with `[[hooks.X]]`.
    if (/^\s*\[\s*hooks\s*\]/.test(b)) return "a [hooks] table";
    if (/^\s*\[\s*hooks\s*\.\s*(?!state\s*[\].])/.test(b)) return "a [hooks] table";
    if (/^\s*\[/.test(b)) {
      inRoot = false;
      continue;
    }
    if (inRoot && /^\s*hooks\s*(=|\.\s*(?!state\s*[.=]))/.test(b)) return "hooks keys at the top level";
  }
  return undefined;
}
