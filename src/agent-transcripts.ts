// Subagent files Claude Code keeps beside a session transcript: `<transcript dir>/<session_id>/subagents/agent-<agent_id>.meta.json`
// (the launching call's `toolUseId`) and `agent-<agent_id>.jsonl` (the agent's own transcript). Only ids are read from them, never words.
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { defaultProfile } from "./hosts/index.ts";
import type { RawOp } from "./timeline/runs.ts";
import { classifyToolResult, neverRan, resultRunsOn, type CallEvidence } from "./credit-guard.ts";

/**
 * A host-sent identifier kept only when it is a short plain string that starts with a letter, digit, underscore, colon or hyphen (so it
 * is never `.`, `..` or a dotfile when it is used in a path); anything else is no identifier (the call stays on the main line).
 */
export function cleanId(v: unknown, spaces = false): string | undefined {
  return typeof v === "string" && (spaces ? /^[\w:@-][\w.:@ -]{0,127}$/ : /^[\w:-][\w.:-]{0,127}$/).test(v) ? v : undefined;
}

/** Largest `.meta.json` read for a launcher; the real file is a few hundred bytes. */
const AGENT_META_MAX_BYTES = 16 * 1024;
/** Largest agent transcript read for tool_use ids. Real ones run to a few MB; a bigger file is no match (and its calls stay on the main line). */
export const AGENT_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
/** Longest single transcript line parsed; a longer one is skipped (its ids are not read). */
const LINE_MAX_BYTES = 8 * 1024 * 1024;
/** Most agent transcripts read for one session, and the most bytes read across them in one load. */
const MAX_AGENT_FILES = 200;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
/** Most project folders looked through when the task's own folder has no directory for a session. */
const MAX_PROJECT_DIRS = 2000;
const CHUNK = 1024 * 1024;

/** What an agent's meta file says: the launching call's tool_use id and whether the host started it in the background (`requestShape`). */
function readMeta(subagentsDir: string, agentId: string): { launcher: string | undefined; background: boolean } {
  const none = { launcher: undefined, background: false };
  try {
    const file = path.join(subagentsDir, defaultProfile().helpers!.metaFile(agentId));
    const st = lstatSync(file);
    if (!st.isFile() || st.size > AGENT_META_MAX_BYTES) return none;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const meta = JSON.parse(readFileSync(fd, "utf8")) as { toolUseId?: unknown; requestShape?: unknown };
      return { launcher: cleanId(meta?.toolUseId), background: meta?.requestShape === "background" };
    } finally {
      closeSync(fd);
    }
  } catch {
    return none;
  }
}

/** The tool_use id of the call that launched an agent, from its meta file; undefined on any problem (missing, a link, too large, bad JSON or id). */
export function readLauncher(subagentsDir: string, agentId: string): string | undefined {
  return readMeta(subagentsDir, agentId).launcher;
}

/**
 * Where Claude Code keeps its project folders: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. Under the node test runner
 * (`NODE_TEST_CONTEXT` is set in every test process) the `~/.claude` default is refused, so a test cannot read the real transcripts.
 */
export function defaultTranscriptsRoot(): string {
  return defaultProfile().helpers!.projectsRoot();
}

const isRealDir = (p: string): boolean => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

/** The path under `root` through `parts`, only when every component (project dir, session dir, subagents dir) is a real directory, never a link. */
function realDirUnder(root: string, ...parts: string[]): string | null {
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    if (!isRealDir(cur)) return null;
  }
  return cur;
}

/** The `subagents` folder of one session under the transcripts root: the task folder's project dir first, then any project dir that holds the session. */
function subagentsDirOf(root: string, folder: string | null, session: string): string | null {
  if (folder !== null) {
    const direct = realDirUnder(root, folder.replace(/[^A-Za-z0-9]/g, "-"), session, defaultProfile().helpers!.folderName);
    if (direct !== null) return direct;
  }
  try {
    for (const name of readdirSync(root).slice(0, MAX_PROJECT_DIRS)) {
      const candidate = realDirUnder(root, name, session, defaultProfile().helpers!.folderName);
      if (candidate !== null) return candidate;
    }
  } catch {
    // no such root
  }
  return null;
}

/**
 * Reads a file from byte `from` to its end in chunks, line by line, handing each line (without its newline) to `take`; a line longer than
 * LINE_MAX_BYTES is skipped. The file is opened without following a link. False when the file could not be read.
 */
function readLines(file: string, from: number, take: (line: Buffer) => void, limit = Infinity): boolean {
  return readLinesTo(file, from, take, limit) !== null;
}

/** As `readLines`, reading at most `limit` bytes; the byte offset just past the last whole line read (where to go on), or null on failure. */
function readLinesTo(file: string, from: number, take: (line: Buffer) => void, limit = Infinity): number | null {
  let fd: number | undefined;
  let done = from;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry: Buffer[] = [];
    let carried = 0;
    let skipping = false;
    let pos = from;
    for (;;) {
      const want = Math.min(CHUNK, from + limit - pos);
      if (want <= 0) return done > from ? done : pos; // a single line longer than the limit is passed over
      const n = readSync(fd, buf, 0, want, pos);
      if (n === 0) break;
      const base = pos;
      pos += n;
      let start = 0;
      for (let nl = buf.indexOf(10, start); nl !== -1 && nl < n; nl = buf.indexOf(10, start)) {
        if (!skipping) {
          carry.push(Buffer.from(buf.subarray(start, nl)));
          take(carry.length === 1 ? carry[0]! : Buffer.concat(carry));
        }
        carry = [];
        carried = 0;
        skipping = false;
        start = nl + 1;
        done = base + start;
      }
      if (start < n && !skipping) {
        carry.push(Buffer.from(buf.subarray(start, n)));
        carried += n - start;
        if (carried > LINE_MAX_BYTES) {
          skipping = true;
          carry = [];
          carried = 0;
        }
      }
    }
    if (!skipping && carried > 0 && limit === Infinity) take(Buffer.concat(carry));
    return limit === Infinity ? pos : done;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Ids per transcript file, kept by what the file was when read; a transcript only grows, so an unchanged size and mtime is the same ids.
const idCache = new Map<string, Set<string> | null>();
const ID_CACHE_MAX = 256;

/**
 * The tool_use ids an agent transcript holds: the `id` of each `tool_use` block in an assistant message, kept only as a plain id. Read in
 * chunks, line by line; a line is parsed only when it mentions tool_use, and nothing but the ids survives the parse. A line that does not
 * parse, or claims another session, gives no ids. null when the file is not a plain regular file within the size cap.
 */
function toolUseIds(file: string, session: string, budget: { left: number }): Set<string> | null {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > AGENT_TRANSCRIPT_MAX_BYTES) return null;
  const key = `${file}\u0000${session}\u0000${st.size}\u0000${st.mtimeMs}`;
  if (idCache.has(key)) return idCache.get(key)!;
  if (st.size > budget.left) return null;
  budget.left -= st.size;
  const ids = new Set<string>();
  const take = (line: Buffer): void => {
    if (line.length > LINE_MAX_BYTES || !line.includes('"tool_use"')) return;
    try {
      const o = JSON.parse(line.toString("utf8")) as { type?: unknown; sessionId?: unknown; message?: { role?: unknown; content?: unknown } };
      if (typeof o.sessionId === "string" && o.sessionId !== session) return;
      if (o.type !== "assistant" && o.message?.role !== "assistant") return;
      if (!Array.isArray(o.message?.content)) return;
      for (const block of o.message.content as Array<{ type?: unknown; id?: unknown }>) {
        const id = block?.type === "tool_use" ? cleanId(block.id) : undefined;
        if (id !== undefined) ids.add(id);
      }
    } catch {
      // a line that does not parse gives no ids
    }
  };
  const ok = readLines(file, 0, take);
  const out = ok ? ids : null;
  if (idCache.size >= ID_CACHE_MAX) idCache.delete(idCache.keys().next().value!);
  idCache.set(key, out);
  return out;
}

export interface AgentSource {
  /** Where Claude Code keeps its project folders (`~/.claude/projects`). */
  root: string;
  /** The task's watched folder, whose project dir is looked in first. */
  folder: string | null;
}

/**
 * Ops without an agent id get their subagent lanes from the transcripts. A call op with no `agent_id` is matched, by its `tool_use_id`, against the tool_use
 * ids in its own session's subagent transcripts. A match stamps the op in the returned copy with that agent's id and its launcher (the
 * `toolUseId` of the agent's meta file), so the subagent placement works as for a stamped op. Stored ops are never rewritten: this is a new
 * array, and an op it does not change is the same object.
 *
 * Refusals: an op that already has an `agent_id` (any non-null value) is left alone; an id two agents' transcripts both hold matches
 * neither; only the op's own session's folder is read; a missing or unreadable folder, a link, an oversized file or a parse failure is no
 * match; nothing from a transcript but tool_use ids and the meta file's `toolUseId` is read.
 */
export function backfillAgentLanes(ops: RawOp[], source: AgentSource): RawOp[] {
  return markBackgroundLaunchers(backfillAgentIds(ops, source), source);
}

/**
 * A launch the host ran in the background without saying so in the Agent input is told by its agent's meta file
 * (`requestShape: "background"`, beside the `toolUseId` of the launching call). Each Agent or Task op of the session whose call id is
 * such a `toolUseId` is returned with `background: true`, in a new array (stored ops are never rewritten; an unchanged op is the same
 * object). Nothing but `toolUseId` and `requestShape` is read, from the session's own folder only; a missing folder, a link, an
 * oversized or unparsable file, or any other shape (a foreground agent has no `requestShape`) changes nothing.
 */
function markBackgroundLaunchers(ops: RawOp[], source: AgentSource): RawOp[] {
  const wanted = new Map<string, Array<{ at: number; id: string; a: Record<string, unknown> }>>();
  ops.forEach((op, at) => {
    if (typeof op.args_json !== "string" || !op.args_json.includes("tool_use_id")) return;
    try {
      const a = JSON.parse(op.args_json) as Record<string, unknown>;
      const session = cleanId(a?.session_id);
      const tool = typeof a?.tool_name === "string" ? a.tool_name : op.tool;
      if (a === null || typeof a !== "object" || session === undefined || typeof a.tool_use_id !== "string" || a.background === true) return;
      if (tool !== "Agent" && tool !== "Task") return;
      wanted.set(session, [...(wanted.get(session) ?? []), { at, id: a.tool_use_id, a }]);
    } catch {
      // not a call op
    }
  });
  if (wanted.size === 0) return ops;
  const out = [...ops];
  for (const [session, list] of wanted) {
    const dir = subagentsDirOf(source.root, source.folder, session);
    if (dir === null) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => defaultProfile().helpers!.metaName.test(n)).sort().slice(0, MAX_AGENT_FILES);
    } catch {
      continue;
    }
    const background = new Set<string>();
    for (const name of names) {
      const agentId = cleanId(defaultProfile().helpers!.idOfMeta(name));
      if (agentId === undefined) continue;
      const m = readMeta(dir, agentId);
      if (m.background && m.launcher !== undefined) background.add(m.launcher);
    }
    for (const { at, id, a } of list) if (background.has(id)) out[at] = { ...ops[at]!, args_json: JSON.stringify({ ...a, background: true }) };
  }
  return out;
}

function backfillAgentIds(ops: RawOp[], source: AgentSource): RawOp[] {
  const wanted = new Map<string, Array<{ at: number; id: string }>>();
  const parsed = new Map<number, Record<string, unknown>>();
  ops.forEach((op, at) => {
    if (typeof op.args_json !== "string" || !op.args_json.includes("tool_use_id")) return;
    try {
      const a = JSON.parse(op.args_json) as Record<string, unknown>;
      const session = cleanId(a?.session_id);
      if (a === null || typeof a !== "object" || session === undefined || typeof a.tool_use_id !== "string") return;
      if (a.agent_id !== undefined && a.agent_id !== null) return;
      parsed.set(at, a);
      wanted.set(session, [...(wanted.get(session) ?? []), { at, id: a.tool_use_id }]);
    } catch {
      // not a call op
    }
  });
  if (wanted.size === 0) return ops;
  const out = [...ops];
  for (const [session, list] of wanted) {
    const dir = subagentsDirOf(source.root, source.folder, session);
    if (dir === null) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => defaultProfile().helpers!.transcriptName.test(n)).sort().slice(0, MAX_AGENT_FILES);
    } catch {
      continue;
    }
    const owner = new Map<string, string | null>();
    const budget = { left: MAX_SESSION_BYTES };
    for (const name of names) {
      const agentId = cleanId(defaultProfile().helpers!.idOfTranscript(name));
      if (agentId === undefined) continue;
      for (const id of toolUseIds(path.join(dir, name), session, budget) ?? []) owner.set(id, owner.has(id) && owner.get(id) !== agentId ? null : agentId);
    }
    const launchers = new Map<string, string | undefined>();
    for (const { at, id } of list) {
      const agentId = owner.get(id);
      if (agentId === undefined || agentId === null) continue;
      if (!launchers.has(agentId)) launchers.set(agentId, readLauncher(dir, agentId));
      const launcher = launchers.get(agentId);
      out[at] = { ...ops[at]!, args_json: JSON.stringify({ ...parsed.get(at)!, agent_id: agentId, ...(launcher === undefined ? {} : { launch_tool_use_id: launcher }) }) };
    }
  }
  return out;
}

// ---- A call's end, from the host's transcripts ----

/**
 * Collects end evidence (`CallEvidence`, credit-guard.ts) from transcript lines. Per tool_use id: its tool_result (time and kind), else the
 * first later turn of the same agent (an assistant message with another message id, in the same lane of the file). A background Bash keeps
 * only evidence that it never ran: its result comes back while its process still runs. Nothing but ids, times, the error flag and the
 * first characters of an error result is read.
 */
export class EvidenceCollector {
  readonly #uses = new Map<string, { msg: string | null; at: number; lane: string; background: boolean }>();
  readonly #results = new Map<string, CallEvidence>();
  readonly #turns = new Map<string, Array<{ msg: string | null; at: number }>>();
  readonly #runsOn = new Set<string>();

  take(line: Buffer | string): void {
    const text = typeof line === "string" ? line : line.toString("utf8");
    if (!text.includes('"tool_result"') && !text.includes('"assistant"')) return;
    let o: { type?: unknown; timestamp?: unknown; isSidechain?: unknown; agentId?: unknown; message?: { id?: unknown; role?: unknown; content?: unknown } };
    try {
      o = JSON.parse(text);
    } catch {
      return;
    }
    const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(at)) return;
    const lane = `${o.isSidechain === true ? 1 : 0}:${typeof o.agentId === "string" ? o.agentId : ""}`;
    const content = Array.isArray(o.message?.content) ? (o.message!.content as Array<Record<string, unknown>>) : [];
    if (o.type === "assistant" || o.message?.role === "assistant") {
      const msg = typeof o.message?.id === "string" ? o.message.id : null;
      const turns = this.#turns.get(lane) ?? [];
      turns.push({ msg, at });
      this.#turns.set(lane, turns);
      for (const b of content) {
        const id = b?.type === "tool_use" ? cleanId(b.id) : undefined;
        if (id === undefined || this.#uses.has(id)) continue;
        const input = (b.input ?? {}) as { run_in_background?: unknown };
        this.#uses.set(id, { msg, at, lane, background: b.name === "Bash" && input?.run_in_background === true });
      }
      return;
    }
    for (const b of content) {
      const id = b?.type === "tool_result" ? cleanId(b.tool_use_id) : undefined;
      if (id === undefined || this.#results.has(id)) continue;
      const c = b.content;
      const head = typeof c === "string" ? c.slice(0, 400) : Array.isArray(c) ? c.map((x) => (typeof (x as { text?: unknown })?.text === "string" ? (x as { text: string }).text : "")).join(" ").slice(0, 400) : "";
      // a call the host moved to the background goes on past this result: it gives no end
      if (resultRunsOn(head)) {
        this.#runsOn.add(id);
        continue;
      }
      this.#results.set(id, { at, kind: classifyToolResult(head, b.is_error === true) });
    }
  }

  /** The evidence per tool_use id, for the ids in `only` when given. */
  evidence(only?: ReadonlySet<string>): Map<string, CallEvidence> {
    const out = new Map<string, CallEvidence>();
    const ids = new Set([...this.#uses.keys(), ...this.#results.keys()]);
    for (const id of ids) {
      if (only && !only.has(id)) continue;
      if (this.#runsOn.has(id)) continue;
      const use = this.#uses.get(id);
      const result = this.#results.get(id);
      if (use?.background) {
        if (neverRan(result)) out.set(id, result!);
        continue;
      }
      if (result) {
        out.set(id, result);
        continue;
      }
      if (!use) continue;
      const next = (this.#turns.get(use.lane) ?? []).find((t) => t.at > use.at && t.msg !== null && t.msg !== use.msg);
      if (next) out.set(id, { at: next.at, kind: "turn" });
    }
    return out;
  }
}

/** Most bytes of one transcript read live for end evidence at one event; the next event goes on from where this one stopped. */
const EVIDENCE_READ_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Live: the end evidence for `ids` in one transcript, read from byte `from` to its end, at most EVIDENCE_READ_MAX_BYTES at a time; `next` is
 * where the next read goes on (just past the last whole line read), so a long session is read once, in steps, never skipped. A link, a
 * missing file, or a file that shrank gives nothing and leaves `next` at `from` (the calls stay open: the safe direction).
 */
export function evidenceSince(file: string, from: number, ids: ReadonlySet<string>): { found: Map<string, CallEvidence>; next: number } {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size < from) return { found: new Map(), next: from };
  } catch {
    return { found: new Map(), next: from };
  }
  const c = new EvidenceCollector();
  const next = readLinesTo(file, from, (line) => c.take(line), EVIDENCE_READ_MAX_BYTES);
  return next === null ? { found: new Map(), next: from } : { found: c.evidence(ids), next };
}

/** The main transcript of one session under the transcripts root: the task folder's project dir first, then any project dir that holds it. */
function sessionFileOf(root: string, folder: string | null, session: string): string | null {
  const isFile = (p: string): boolean => {
    try {
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (folder !== null) {
    const dir = realDirUnder(root, folder.replace(/[^A-Za-z0-9]/g, "-"));
    if (dir !== null && isFile(path.join(dir, `${session}.jsonl`))) return path.join(dir, `${session}.jsonl`);
  }
  try {
    for (const name of readdirSync(root).slice(0, MAX_PROJECT_DIRS)) {
      const dir = realDirUnder(root, name);
      if (dir !== null && isFile(path.join(dir, `${session}.jsonl`))) return path.join(dir, `${session}.jsonl`);
    }
  } catch {
    // no such root
  }
  return null;
}

/**
 * End evidence for the calls of recorded ops, from their sessions' transcripts (the main file and every subagent file), so a timeline
 * of a ledger written before the adapter recorded it re-renders with calls that never ran, or had ended, closed. In memory only. A session
 * whose files are missing, links or over the size caps gives nothing for its calls.
 */
// Evidence per transcript file, kept by what the file was when read (a transcript only grows).
const evidenceCache = new Map<string, Map<string, CallEvidence>>();
const EVIDENCE_CACHE_MAX = 256;

export function callEvidenceOf(ops: RawOp[], source: AgentSource): Map<string, CallEvidence> {
  const bySession = new Map<string, Set<string>>();
  for (const op of ops) {
    if (typeof op.args_json !== "string" || !op.args_json.includes("tool_use_id")) continue;
    try {
      const a = JSON.parse(op.args_json) as Record<string, unknown>;
      const session = cleanId(a?.session_id);
      const id = cleanId(a?.tool_use_id);
      if (session === undefined || id === undefined) continue;
      bySession.set(session, (bySession.get(session) ?? new Set()).add(id));
    } catch {
      // not a call op
    }
  }
  const out = new Map<string, CallEvidence>();
  const budget = { left: MAX_SESSION_BYTES };
  const read = (file: string, ids: Set<string>): void => {
    let key: string;
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > AGENT_TRANSCRIPT_MAX_BYTES) return;
      key = `${file}\u0000${st.size}\u0000${st.mtimeMs}`;
      if (!evidenceCache.has(key)) {
        if (st.size > budget.left) return;
        budget.left -= st.size;
      }
    } catch {
      return;
    }
    let all = evidenceCache.get(key);
    if (all === undefined) {
      const c = new EvidenceCollector();
      if (!readLines(file, 0, (line) => c.take(line))) return;
      all = c.evidence();
      if (evidenceCache.size >= EVIDENCE_CACHE_MAX) evidenceCache.delete(evidenceCache.keys().next().value!);
      evidenceCache.set(key, all);
    }
    for (const [id, ev] of all) if (ids.has(id) && !out.has(id)) out.set(id, ev);
  };
  for (const [session, ids] of bySession) {
    const main = sessionFileOf(source.root, source.folder, session);
    if (main !== null) read(main, ids);
    const dir = subagentsDirOf(source.root, source.folder, session);
    if (dir === null) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => defaultProfile().helpers!.transcriptName.test(n)).sort().slice(0, MAX_AGENT_FILES);
    } catch {
      continue;
    }
    for (const name of names) read(path.join(dir, name), ids);
  }
  return out;
}
