// The hook journal. hook-cli.ts writes an index record for the raw event before anything that can fail (parsing, the folder check,
// the adapter), so an event that dies leaves a trace. Layout under the CoCheck home:
//   journal/<session>.jsonl          one JSON line per record, appended with a single O_APPEND write (atomic across processes)
// The index holds the event name, the id (the host's tool_use_id, else a deterministic synthetic one), the time, the byte size and the
// sha256 of the raw bytes; never a part of the body: raw event bodies are not written.
// Every function here may throw; the caller treats a journal failure as a note on stderr, never as a change to the hook's exit or ops.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { scrubPayloadBytes } from "./patch-secrets.ts";

const JOURNAL_VERSION = 1;
const FIELD_MAX = 128;

export interface JournalRef {
  home: string;
  /** The journal file's stem: a hash of the session id, "unknown" (no usable session id) or "unparsed". */
  session: string;
  id: string;
  synthetic: boolean;
  event: string;
  host: string;
  sha256: string;
  size: number;
}

/** The file stem of a session's own journal (a hash of its session id); the shared "unknown" and "unparsed" buckets do not match. */
export const JOURNAL_STEM = /^[0-9a-f]{16}$/;

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const clip = (s: string) => s.slice(0, FIELD_MAX).replace(/[^\x20-\x7e]/g, "?");
const journalDir = (home: string) => path.join(home, "journal");
const fileOf = (home: string, session: string) => path.join(journalDir(home), `${session}.jsonl`);

function line(home: string, session: string, record: Record<string, unknown>): void {
  appendFileSync(fileOf(home, session), `${JSON.stringify({ v: JOURNAL_VERSION, ...record })}\n`, { mode: 0o600 });
}

/** Writes the index record (never a body) for the raw bytes of one event. `host` is the --host argument, or "unknown". Parses the bytes only to name the record. */
export function journalEvent(home: string, raw: Buffer, host: string, now: () => number): JournalRef {
  // Idempotent: the hook entry already scrubbed these bytes, and a caller that did not still never gets a patch body on disk.
  const bytes = scrubPayloadBytes(raw);
  mkdirSync(journalDir(home), { recursive: true, mode: 0o700 });
  const hash = sha(bytes);
  let event = "unparseable";
  let session = "unparsed";
  let id: string | undefined;
  try {
    const obj = JSON.parse(bytes.toString("utf8")) as Record<string, unknown> | null;
    event = "unknown";
    session = "unknown";
    if (obj !== null && typeof obj === "object") {
      if (typeof obj.hook_event_name === "string") event = clip(obj.hook_event_name);
      if (typeof obj.session_id === "string" && obj.session_id !== "") session = sha(obj.session_id).slice(0, 16);
      if (typeof obj.tool_use_id === "string" && obj.tool_use_id !== "") id = clip(obj.tool_use_id);
    }
  } catch {
    // unparseable: the record says so
  }
  const synthetic = id === undefined;
  const ref: JournalRef = { home, session, id: id ?? `syn-${hash.slice(0, 16)}`, synthetic, event, host, sha256: hash, size: bytes.length };
  line(home, session, { k: "event", id: ref.id, synthetic, event, host, at: new Date(now()).toISOString(), size: ref.size, sha256: hash });
  return ref;
}

/** The journal file stem for a host session id. */
export const journalSessionKey = (sessionId: string): string => sha(sessionId).slice(0, 16);

/** Every parseable record of one session file (or a shared bucket), in order; a torn or foreign line is skipped. Missing file: no records. */
export function readJournalSession(home: string, session: string): Array<Record<string, any>> {
  let text: string;
  try {
    text = readFileSync(fileOf(home, session), "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, any>> = [];
  for (const l of text.split("\n")) {
    if (l === "") continue;
    try {
      const r = JSON.parse(l);
      if (r !== null && typeof r === "object") out.push(r);
    } catch {
      // a torn line says nothing
    }
  }
  return out;
}

/** The journal stem of the session a raw event names, or "-" when its bytes name none. */
export function sessionKeyOfBytes(bytes: Buffer): string {
  try {
    const o = JSON.parse(bytes.toString("utf8")) as Record<string, unknown> | null;
    if (o !== null && typeof o === "object" && typeof o.session_id === "string" && o.session_id !== "") return journalSessionKey(o.session_id);
  } catch {
    // no session
  }
  return "-";
}

/**
 * Whether the journal was unavailable for this session. The flag file holds one line per failure, `<iso time> <session key or -> <why>`.
 * A line naming the session counts. A line naming none ("-") counts for a session that began at or before it, so a clean session that began after it is not hit.
 */
export function journalDegraded(home: string, session: string, firstAt: string | undefined): boolean {
  let text: string;
  try {
    text = readFileSync(path.join(home, "journal.degraded"), "utf8");
  } catch {
    return false;
  }
  for (const l of text.split("\n")) {
    const [at, second] = l.split(" ");
    if (!at) continue;
    // Old lines were `<iso> <why>`: no session key, so they count as session-less.
    const key = second !== undefined && (second === "-" || /^[0-9a-f]{16}$/.test(second)) ? second : "-";
    if (key === session) return true;
    if (key === "-" && (firstAt === undefined || at >= firstAt)) return true;
  }
  return false;
}

/** A failure marker linked to the event's record. `error` is a class or a short message, never a part of the payload. */
export function journalFailure(ref: JournalRef, error: string, now: () => number): void {
  line(ref.home, ref.session, { k: "failure", ref: ref.id, sha256: ref.sha256, error: error.slice(0, 200), at: new Date(now()).toISOString() });
}

/** The ledger took the event. */
export function journalDone(ref: JournalRef, now: () => number): void {
  line(ref.home, ref.session, { k: "done", ref: ref.id, sha256: ref.sha256, at: new Date(now()).toISOString() });
}

/** The before side of a URI subject for the event's call, a sibling line of the event's record (same id). */
export function journalBeforeSide(ref: JournalRef, side: Record<string, string | null>, now: () => number): void {
  line(ref.home, ref.session, { k: "before-side", ref: ref.id, sha256: ref.sha256, side, at: new Date(now()).toISOString() });
}

/** The before side journaled for the call `callId` of a session file (the journal id of a call's events is its tool_use_id), the last one written; undefined when there is none. */
export function beforeSideOfCall(home: string, session: string, callId: string): Record<string, string | null> | undefined {
  const sides = readJournalSession(home, session).filter((r) => r.k === "before-side" && r.ref === callId && typeof r.side === "object" && r.side !== null);
  return sides.at(-1)?.side;
}

/** The start and end of a call as the journal saw them: the `at` of its PreToolUse and of its last PostToolUse record (the journal id of a call's events is its tool_use_id). Either is undefined when not journaled. */
export function callTimesOfCall(home: string, session: string, callId: string): { start: string | undefined; end: string | undefined } {
  const ev = readJournalSession(home, session).filter((r) => r.k === "event" && r.id === callId && typeof r.at === "string");
  return { start: ev.find((r) => r.event === "PreToolUse")?.at, end: ev.filter((r) => r.event === "PostToolUse").at(-1)?.at };
}

/** Best effort: a flag file with one line per run that found the journal unavailable, naming the session when the bytes do. */
export function noteDegraded(home: string, why: string, now: () => number, session = "-"): void {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(path.join(home, "journal.degraded"), `${new Date(now()).toISOString()} ${session} ${why.slice(0, 200).replace(/\s/g, "_")}\n`, { mode: 0o600 });
    chmodSync(path.join(home, "journal.degraded"), 0o600);
  } catch {
    // nowhere to say it
  }
}

