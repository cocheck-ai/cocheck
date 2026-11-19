// The name each host gives a session itself, read for the home page. Best-effort and read-only: every file is opened with 'r' (the Codex
// database read-only and immutable, so SQLite creates no -shm or -wal beside it), the session id must match exactly, and only the title string
// leaves a reader (trimmed, one line, capped). Any missing, unreadable, oversized or corrupt file answers undefined and the caller falls back.
// Roots are injectable (tests pass a fixture folder); with no root the host's own folder is used, and under the node test runner an unset
// environment variable is refused rather than falling back to the real home, as the other readers here do.
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Longest title kept, in characters. */
export const TITLE_MAX = 120;

/** A session id that may name a file: plain characters only, never a path, never a dot-leading name. */
const SAFE_SESSION = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A title as shown: one line, control characters gone, trimmed, capped; undefined when nothing is left or the value is not text. */
export function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const one = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (one === "") return undefined;
  const chars = [...one];
  return chars.length <= TITLE_MAX ? one : `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…`;
}

const regularFile = (file: string): boolean => {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
};

const LINE_MAX = 256 * 1024;
const TAIL_BLOCK = 256 * 1024;
const TAIL_MAX = 64 * 1024 * 1024;

/** The lines of a file from its last to its first, read in blocks from the end, at most `TAIL_MAX` bytes. Over-long lines are skipped, never held. */
function* linesFromEnd(file: string): Generator<string> {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    let pos = size;
    let carry: Buffer = Buffer.alloc(0);
    const stop = Math.max(0, size - TAIL_MAX);
    while (pos > stop) {
      const n = Math.min(TAIL_BLOCK, pos - stop);
      pos -= n;
      const block = Buffer.alloc(n);
      readSync(fd, block, 0, n, pos);
      let buf = Buffer.concat([block, carry]);
      let end = buf.length;
      let at = buf.lastIndexOf(10, end - 1);
      while (at >= 0) {
        if (end - at - 1 > 0 && end - at - 1 <= LINE_MAX) yield buf.subarray(at + 1, end).toString("utf8");
        end = at;
        at = end === 0 ? -1 : buf.lastIndexOf(10, end - 1);
      }
      carry = buf.subarray(0, end).length > LINE_MAX * 2 ? Buffer.alloc(0) : Buffer.from(buf.subarray(0, end));
      buf = Buffer.alloc(0);
    }
    if (pos === 0 && carry.length > 0 && carry.length <= LINE_MAX) yield carry.toString("utf8");
  } catch {
    // unreadable: no more lines
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function claudeRoot(root?: string): string | undefined {
  if (root !== undefined) return root;
  if (!process.env.CLAUDE_CONFIG_DIR && process.env.NODE_TEST_CONTEXT) return undefined;
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects");
}

/**
 * Claude Code: the last `ai-title` record of `<projects>/<folder>/<session>.jsonl`. The file is named by the exact session id; a record that
 * names another session id is skipped (a resumed or forked transcript can hold several). Read from the end, so a long transcript is cheap.
 */
export function claudeSessionTitle(session: string, root?: string): string | undefined {
  try {
    if (!SAFE_SESSION.test(session)) return undefined;
    const base = claudeRoot(root);
    if (base === undefined) return undefined;
    const files: Array<{ file: string; mtime: number }> = [];
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = path.join(base, dir.name, `${session}.jsonl`);
      if (regularFile(file)) files.push({ file, mtime: lstatSync(file).mtimeMs });
    }
    // Every folder holding this exact file name is tried, the newest file first; the first to hold a title for this session wins.
    for (const { file } of files.sort((a, b) => b.mtime - a.mtime)) {
      for (const line of linesFromEnd(file)) {
        if (!line.includes('"ai-title"')) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const r = rec as { type?: unknown; sessionId?: unknown; aiTitle?: unknown } | null;
        if (r === null || typeof r !== "object" || r.type !== "ai-title") continue;
        if (r.sessionId !== undefined && r.sessionId !== session) continue;
        const title = cleanTitle(r.aiTitle);
        if (title !== undefined) return title;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function codexRoot(root?: string): string | undefined {
  if (root !== undefined) return root;
  if (!process.env.CODEX_HOME && process.env.NODE_TEST_CONTEXT) return undefined;
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

const INDEX_MAX = 16 * 1024 * 1024;

/** Codex: `thread_name` of the last `session_index.jsonl` line whose `id` is the thread, else `threads.title` of the newest `state_*.sqlite`. */
export function codexSessionTitle(session: string, root?: string): string | undefined {
  try {
    if (!UUID.test(session)) return undefined;
    const base = codexRoot(root);
    if (base === undefined) return undefined;
    const index = path.join(base, "session_index.jsonl");
    if (regularFile(index)) {
      let fd: number | undefined;
      try {
        fd = openSync(index, "r");
        if (fstatSync(fd).size <= INDEX_MAX) {
          let found: string | undefined;
          for (const line of readFileSync(fd, "utf8").split("\n")) {
            if (!line.includes(session)) continue;
            try {
              const r = JSON.parse(line) as { id?: unknown; thread_name?: unknown } | null;
              if (r !== null && typeof r === "object" && r.id === session) found = cleanTitle(r.thread_name) ?? found;
            } catch {
              // a damaged line names nothing
            }
          }
          if (found !== undefined) return found;
        }
      } catch {
        // fall through to the database
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    const states = readdirSync(base)
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(/\d+/.exec(b)![0]) - Number(/\d+/.exec(a)![0]));
    for (const name of states) {
      const file = path.join(base, name);
      if (!regularFile(file)) continue;
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(`file:${encodeURI(file).replace(/\?/g, "%3F").replace(/#/g, "%23")}?mode=ro&immutable=1`, { readOnly: true });
        const row = db.prepare("SELECT title FROM threads WHERE id = ?").get(session) as { title?: unknown } | undefined;
        const title = cleanTitle(row?.title);
        if (title !== undefined) return title;
      } catch {
        // no threads table, or not a database
      } finally {
        db?.close();
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function copilotRoot(root?: string): string | undefined {
  if (root !== undefined) return root;
  if (!process.env.COPILOT_HOME && process.env.NODE_TEST_CONTEXT) return undefined;
  return path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state");
}

const WORKSPACE_MAX = 1024 * 1024;
const ENTRY = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/;
const INDICATORS = "-?:,[]{}#&*!|>'\"%@`";
const PLAIN_NULLS: ReadonlySet<string> = new Set(["~", "null", "Null", "NULL", "---", "..."]);
const CONTROL_NOT_TAB = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { "0": "\u0000", a: "\u0007", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\u000b", f: "\f", r: "\r", e: "\u001b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: " ", L: " ", P: " " };

/** One double-quoted YAML scalar with its escapes decoded; undefined for any other escape, a surrogate code point, or a body that is not one. */
function doubleQuoted(raw: string): string | undefined {
  const m = /^"((?:[^"\\\u0000-\u0008\u000a-\u001f\u007f-\u009f]|\\[^])*)"(?:[ \t]+#.*)?$/.exec(raw);
  if (m === null) return undefined;
  let out = "";
  const body = m[1]!;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i]!;
    const width = e === "x" ? 2 : e === "u" ? 4 : e === "U" ? 8 : 0;
    if (width > 0) {
      const hex = body.slice(i + 1, i + 1 + width);
      if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return undefined;
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
      out += String.fromCodePoint(cp);
      i += width;
    } else if (Object.hasOwn(SIMPLE_ESCAPES, e)) out += SIMPLE_ESCAPES[e]!;
    else return undefined;
  }
  return out;
}

/** The decoded value text after `key:` for the strict grammar (double-quoted, single-quoted or plain, one line); undefined for anything else. */
function workspaceValue(rawValue: string | undefined): string | undefined {
  const raw = (rawValue ?? "").replace(/[ \t]+$/, "");
  if (raw === "") return undefined;
  if (raw.startsWith('"')) return doubleQuoted(raw);
  if (raw.startsWith("'")) {
    const m = /^'((?:[^'\u0000-\u0008\u000a-\u001f\u007f-\u009f]|'')*)'(?:[ \t]+#.*)?$/.exec(raw);
    return m === null ? undefined : m[1]!.replace(/''/g, "'");
  }
  const cut = raw.search(/[ \t]#/);
  const v = (cut < 0 ? raw : raw.slice(0, cut)).replace(/[ \t]+$/, "");
  if (v === "" || PLAIN_NULLS.has(v) || CONTROL_NOT_TAB.test(v) || /:(?:[ \t]|$)/.test(v)) return undefined;
  const first = v[0]!;
  if (INDICATORS.includes(first) && !("-?:".includes(first) && v.length > 1 && !/[ \t]/.test(v[1]!))) return undefined;
  return v;
}

/** The title in the text of a Copilot workspace.yaml for exactly `session`, or undefined. The file shape, keys and region of `id` and `name` are checked first; see the notes at the reader. */
function workspaceTitle(text: string, session: string): string | undefined {
  const lines = (text.startsWith("﻿") ? text.slice(1) : text).split(/\r\n|\r|\n/);
  const entries: Array<{ key: string; value: string | undefined; line: number }> = [];
  for (const [i, line] of lines.entries()) {
    if (/^[ \t]*$/.test(line) || line.startsWith("#") || line.startsWith(" ")) continue;
    const m = ENTRY.exec(line);
    if (m === null) return undefined;
    entries.push({ key: m[1]!, value: m[2], line: i });
  }
  const keys = entries.map((e) => e.key);
  if (new Set(keys).size !== keys.length) return undefined;
  const regionClean = (e: { line: number }, next: number): boolean => lines.slice(e.line + 1, next).every((l) => /^[ \t]*$/.test(l) || !l.startsWith(" "));
  const get = (key: string): string | undefined => {
    const at = entries.findIndex((e) => e.key === key);
    if (at < 0) return undefined;
    const e = entries[at]!;
    if (!regionClean(e, entries[at + 1]?.line ?? lines.length)) return undefined;
    return workspaceValue(e.value);
  };
  const id = get("id");
  if (id === undefined || id !== session) return undefined;
  return cleanTitle(get("name"));
}

/**
 * Copilot: `name` in `<session-state>/<session>/workspace.yaml`, read only if the file is a plain, flat key: value file (an exact definition,
 * see `workspaceTitle`), its `id` is exactly this session and `name` is one complete single-line scalar. The folder is keyed by the exact session id.
 * A file over 1 MiB, invalid UTF-8, or anything that is not that shape answers undefined and the card falls back to the first request.
 */
export function copilotSessionTitle(session: string, root?: string): string | undefined {
  try {
    if (!UUID.test(session)) return undefined;
    const base = copilotRoot(root);
    if (base === undefined) return undefined;
    const file = path.join(base, session, "workspace.yaml");
    if (!regularFile(file)) return undefined;
    const fd = openSync(file, "r");
    let bytes: Buffer;
    try {
      if (fstatSync(fd).size > WORKSPACE_MAX) return undefined;
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    return workspaceTitle(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), session);
  } catch {
    return undefined;
  }
}
