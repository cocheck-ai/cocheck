// Positive write evidence. The Python and Node write hooks (hooks/) append one JSON line per file a tagged Bash call's child opened
// for writing, renamed or removed, to `<home>/attribution/writes-<UTC date>.jsonl`. Each hook event reads what was appended since its
// folder's cursor and keeps, per changed path inside the folder, the calls that wrote it. Attribution consults this ahead of open-call
// windows (hook-adapter.ts, `#proven`); with no record for a path, or a record it cannot trust, the open-call rule is unchanged.
import { closeSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { evidenceDir } from "./tag.ts";

/** What a folder's state keeps. `byPath` keys are the adapter's own path form (absolute, symlinks resolved, NFC). */
export interface EvidenceState {
  /** Per log file name, the byte offset read to (always at a line end). */
  cursors: Record<string, number>;
  /** Per path, the calls whose children wrote it since it was last credited, and the newest record's time. */
  byPath: Record<string, { calls: string[]; at: number }>;
  /** Calls whose Python or Node children started some other program (or a shell): they wrote, or may have, where no hook sees. */
  unobserved?: string[];
}

interface WriteRecord {
  call: string;
  agent: string;
  path: string;
  /** "start" is a hooked child's proof that it loaded the hook and found the tag; its path is the interpreter. */
  op: "write" | "remove" | "spawn" | "start";
  ts: number;
  /** The writing process and (on a start record) its parent. */
  pid?: number;
  ppid?: number;
}

const LOG_NAME = /^writes-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Read at most this much of the logs in one event; the rest waits for the next. */
const READ_CAP_BYTES = 8 * 1024 * 1024;
/** Paths kept at most; the oldest go first. */
const PATHS_KEPT = 2_000;
/** Log files older than this many days are deleted by whichever event sees them. */
const LOG_DAYS_KEPT = 3;

const emptyEvidence = (): EvidenceState => ({ cursors: {}, byPath: {} });

function parseRecord(line: string): WriteRecord | undefined {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (d === null || typeof d !== "object" || d.v !== 1) return undefined;
  if (typeof d.call !== "string" || !ID.test(d.call) || typeof d.agent !== "string" || !ID.test(d.agent)) return undefined;
  if (typeof d.path !== "string" || (d.op !== "write" && d.op !== "remove" && d.op !== "spawn" && d.op !== "start")) return undefined;
  if (d.op !== "spawn" && d.op !== "start" && !path.isAbsolute(d.path)) return undefined;
  return { call: d.call, agent: d.agent, path: d.path, op: d.op, ts: typeof d.ts === "number" ? d.ts : 0, ...(Number.isInteger(d.pid) ? { pid: d.pid } : {}), ...(Number.isInteger(d.ppid) ? { ppid: d.ppid } : {}) };
}

/**
 * Reads every record appended since `st.cursors` and merges those whose path `keyOf` accepts (returns the folder's key for it) into
 * `st.byPath`. A log that shrank is read from its start. A missing directory is no evidence. Never throws for a bad line.
 */
export function readEvidence(home: string, st: EvidenceState, keyOf: (p: string) => string | undefined, nowMs: number, onRecord?: (r: WriteRecord, key: string | undefined) => void): void {
  const dir = evidenceDir(home);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => LOG_NAME.test(n)).sort();
  } catch {
    return;
  }
  const oldest = new Date(nowMs - LOG_DAYS_KEPT * 86_400_000).toISOString().slice(0, 10);
  let budget = READ_CAP_BYTES;
  const live = new Set<string>();
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.match(LOG_NAME)![1]! < oldest) {
      rmSync(file, { force: true });
      continue;
    }
    live.add(name);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    let from = st.cursors[name] ?? 0;
    if (from > size) from = 0;
    const len = Math.min(size - from, budget);
    if (len <= 0) {
      st.cursors[name] = from;
      continue;
    }
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    let got = 0;
    try {
      got = readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    const end = buf.subarray(0, got).lastIndexOf(0x0a);
    if (end < 0) {
      st.cursors[name] = from;
      continue;
    }
    budget -= end + 1;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      const r = parseRecord(line);
      if (!r) continue;
      onRecord?.(r, r.op === "spawn" || r.op === "start" ? undefined : keyOf(r.path));
      if (r.op === "start") continue;
      if (r.op === "spawn") {
        const un = (st.unobserved ??= []);
        if (!un.includes(r.call)) un.push(r.call);
        if (un.length > PATHS_KEPT) un.splice(0, un.length - PATHS_KEPT);
        continue;
      }
      const key = keyOf(r.path);
      if (key === undefined) continue;
      const hit = (st.byPath[key] ??= { calls: [], at: 0 });
      if (!hit.calls.includes(r.call)) hit.calls = [...hit.calls, r.call].sort();
      hit.at = Math.max(hit.at, r.ts);
    }
    st.cursors[name] = from + end + 1;
  }
  for (const name of Object.keys(st.cursors)) if (!live.has(name)) delete st.cursors[name];
  const keys = Object.keys(st.byPath);
  if (keys.length > PATHS_KEPT) {
    keys.sort((a, b) => st.byPath[a]!.at - st.byPath[b]!.at);
    for (const k of keys.slice(0, keys.length - PATHS_KEPT)) delete st.byPath[k];
  }
}

/** Starts a folder's cursors at the logs' current ends, so records written before the folder was first seen are never read. */
export function startEvidence(home: string): EvidenceState {
  const st = emptyEvidence();
  try {
    for (const name of readdirSync(evidenceDir(home))) {
      if (LOG_NAME.test(name)) st.cursors[name] = statSync(path.join(evidenceDir(home), name)).size;
    }
  } catch {
    // no logs yet
  }
  return st;
}

/** Programs whose children carry a write hook (Python without -I/-E/-S, Node), and builtins and readers that write nothing without a redirect. */
const PYTHON = /^python(\d+(\.\d+)*)?$/;
const READERS = new Set(["cd", "echo", "printf", "true", "false", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "test", "[", "sleep", "wait", ":"]);

/** `command` split into simple commands at `&&`, `||`, `;`, `|`, `&` and newlines outside quotes; null when it holds a redirect, a substitution or an unclosed quote. */
function segments(command: string): string[][] | null {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let q: "'" | '"' | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (q === "'") {
      if (c === "'") q = null;
      else word += c;
      continue;
    }
    if (c === "`" || (c === "$" && command[i + 1] === "(")) return null;
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      inWord = true;
      continue;
    }
    if (c === ">" || c === "<") return null;
    if (c === "\\") {
      if (i + 1 < command.length) word += command[++i];
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < command.length && command[i] !== "\n") i++;
      endSeg();
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      endSeg();
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  if (q !== null) return null;
  endSeg();
  return out;
}

/**
 * Whether every write a Bash call could make goes through an observed channel: each simple command is Python (without -I, -E or -S, which
 * skip the hook) or Node, or a builtin or reader that writes nothing, and there is no redirect, substitution, `exec` or any other program.
 * A Python or Node child that starts another program is caught separately (a `spawn` record makes the call unobserved).
 */
export function observedOnly(command: string): boolean {
  const segs = segments(command);
  if (segs === null) return false;
  for (const seg of segs) {
    let i = 0;
    while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i]!)) i++;
    if (i >= seg.length) continue;
    const prog = path.basename(seg[i]!);
    if (READERS.has(prog)) continue;
    if (prog === "node") continue;
    if (PYTHON.test(prog)) {
      for (const a of seg.slice(i + 1)) {
        if (!a.startsWith("-") || a === "-") break;
        if (a === "-c" || a === "-m") break;
        if (/^-[A-Za-z]*[IES]/.test(a)) return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

/** What the strict rule needs to know of one open call. `mayWrite`: every window guard lets it be credited with the file at all. */
interface WriterFacts {
  tool: string;
  tagged: boolean;
  command: string;
  mayWrite: boolean;
  /** Its children provably carried the hook: a trusted "start" record, or any write it logged. Without it "logged nothing" proves nothing. */
  hooked: boolean;
}

/**
 * The strict rule behind the `WriteEvidence` seam: the calls whose children's writes to `file` were recorded, when they are
 * all among `candidates` (the calls open at the sweep) and every other candidate that may write the file could have written only where a
 * hook sees: a tagged Bash call whose command is Python, Node and non-writing builtins only (`observedOnly`), none of whose children
 * started another program (`unobserved`), whose children provably carried the hook (`hooked`), and whose command does not name the
 * file. Otherwise undefined: the window rule decides.
 */
export function strictWriters(file: string, candidates: readonly string[], writers: readonly string[] | undefined, factsOf: (id: string) => WriterFacts | undefined, unobserved: ReadonlySet<string>): string[] | undefined {
  if (writers === undefined || writers.length === 0 || !writers.every((w) => candidates.includes(w))) return undefined;
  const base = path.basename(file).toLowerCase();
  for (const id of candidates) {
    if (writers.includes(id)) continue;
    const c = factsOf(id);
    if (c === undefined) return undefined;
    if (!c.mayWrite) continue;
    if (c.tool !== "Bash" || !c.tagged || !c.hooked || !observedOnly(c.command) || c.command.toLowerCase().includes(base) || unobserved.has(id)) return undefined;
  }
  return [...writers].sort();
}

/** One proven write as an op records it (`provenWrites`): the file and the step it was found at (the adapter's step seq in its state, the ledger step id once the op is written). */
export interface ProvenWrite {
  path: string;
  step: number;
}

/**
 * The timeline's side of the seam: who the live adapter proved wrote `file` at the ledger step `stepId`, from the ops' `provenWrites`. Only
 * writers among `candidates`; undefined when no op proved a write of this file at that step.
 */
export function writeEvidenceFromOps(ops: ReadonlyArray<{ args?: Record<string, unknown>; args_json?: string | null }>): (file: string, candidates: readonly string[], stepId?: number | null) => readonly string[] | undefined {
  const byKey = new Map<string, Set<string>>();
  for (const op of ops) {
    let args = op.args;
    if (args === undefined && typeof op.args_json === "string") {
      try {
        args = JSON.parse(op.args_json);
      } catch {
        args = undefined;
      }
    }
    const call = args?.tool_use_id;
    const pw = args?.provenWrites;
    if (typeof call !== "string" || !Array.isArray(pw)) continue;
    for (const w of pw as unknown[]) {
      const p = (w as ProvenWrite)?.path;
      const step = (w as ProvenWrite)?.step;
      if (typeof p !== "string" || typeof step !== "number" || !Number.isInteger(step)) continue;
      const key = `${step}\0${p}`;
      (byKey.get(key) ?? byKey.set(key, new Set()).get(key)!).add(call);
    }
  }
  return (file, candidates, stepId) => {
    if (stepId === undefined || stepId === null) return undefined;
    const hit = byKey.get(`${stepId}\0${file}`);
    if (hit === undefined) return undefined;
    const writers = [...hit].sort();
    return writers.every((w) => candidates.includes(w)) ? writers : undefined;
  };
}
