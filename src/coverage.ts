// Per-session coverage. At Stop, the hook journal (what the host sent), the ledger ops (what CoCheck wrote) and the host transcript
// (what the agent did) are set side by side, and one row in session_coverage says whether anything fell between them. Three named
// buckets keep a session from being complete:
//   lost         an event the journal received that has no done line (a killed hook), or a call event that is done but has no op
//   failed       an event with a failure marker and no done line
//   host sent no event   a tool call in the transcript (or a subagent file) that the journal has no event for, once tracking began (calls
//                        before the first event-bearing call of their own file are untracked and owe none); the page cannot tell a denied
//                call from a dead hook, so this is its own line
//   expired      a call whose last op says expiry closed it: no Post came, so its outcome is unknown; a late Post takes it out
// Status is exactly one of complete, lossy, not recorded, not checked. Complete needs the transcript read, every bucket zero and an intact
// journal. Matching is by tool_use_id only, never by name or time. Claude transcripts and subagent files are read; a Codex session is "not checked".
// Reconciliation is idempotent: the whole session is recomputed and its row replaced.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AGENT_TRANSCRIPT_MAX_BYTES, cleanId } from "./agent-transcripts.ts";
import { findProfile, profileWithExtra } from "./hosts/index.ts";

/** The host whose transcripts hold the helper files read here. */
const helperHost = () => profileWithExtra("transcript-coverage");
import { journalDegraded, journalSessionKey, readJournalSession } from "./hook-journal.ts";
import type { CoverageStatus, Ledger, SessionCoverageRow } from "./ledger.ts";

const MAX_AGENT_FILES = 200;
const NAMES_MAX = 30;
const CALL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

export interface TranscriptCalls {
  /** "read": every file was read whole. Anything else: the ids are not a complete list and nothing may be called complete. */
  state: "read" | "missing" | "unreadable" | "too large" | "not read (host)";
  ids: Set<string>;
  /** Ids of calls the host refused as an unknown tool ("No such tool available"): they never ran, so no Post or op is owed for them. */
  rejected?: Set<string>;
  /** The ids of each transcript file in file order (the main transcript first, then each subagent file), for the per-file tracking cutoff. */
  files?: string[][];
}

/** Adds the ids of the tool_result blocks on this transcript line that the host answered with its unknown-tool refusal. */
function noteRejected(line: string, into: Set<string>): void {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const content = o?.message?.content;
  if (o?.type !== "user" || !Array.isArray(content)) return;
  for (const b of content) {
    if (b?.type !== "tool_result" || b.is_error !== true || typeof b.tool_use_id !== "string" || b.tool_use_id === "") continue;
    const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
    if (/^\s*(<tool_use_error>)?\s*(Error:\s*)?No such tool available:/.test(text)) into.add(b.tool_use_id);
  }
}

/** Reads one transcript file's tool_use ids; throws on a link, a non-file, a size over the cap or an I/O error. */
function idsOfFile(file: string, into: Set<string>, rejected: Set<string>, perFile: string[][]): void {
  const mine: string[] = [];
  perFile.push(mine);
  const st = lstatSync(file);
  if (!st.isFile()) throw new Error("not a regular file");
  if (st.size > AGENT_TRANSCRIPT_MAX_BYTES) throw new RangeError("too large");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    if (fstatSync(fd).size > AGENT_TRANSCRIPT_MAX_BYTES) throw new RangeError("too large");
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  for (const l of text.split("\n")) {
    if (!l.includes("tool_use")) continue;
    if (l.includes("No such tool available")) noteRejected(l, rejected);
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // a half-written last line
    }
    const content = o?.message?.content;
    if (o?.type !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "tool_use" && typeof b.id === "string" && b.id !== "") {
      into.add(b.id);
      mine.push(b.id);
    }
  }
}

/** Every assistant tool_use id of a Claude session: its transcript plus <transcript dir>/<session>/subagents/agent-*.jsonl. */
export function readClaudeCalls(transcriptPath: unknown, sessionId: string): TranscriptCalls {
  const ids = new Set<string>();
  const rejected = new Set<string>();
  const files: string[][] = [];
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return { state: "missing", ids, rejected };
  try {
    statSync(transcriptPath);
  } catch {
    return { state: "missing", ids, rejected };
  }
  try {
    idsOfFile(transcriptPath, ids, rejected, files);
    const sid = cleanId(sessionId);
    if (sid !== undefined) {
      const dir = helperHost().helpers!.dirOf(transcriptPath, sid);
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => helperHost().helpers!.transcriptName.test(n));
      } catch {
        // no subagents
      }
      if (names.length > MAX_AGENT_FILES) return { state: "unreadable", ids, rejected, files };
      for (const n of names) idsOfFile(path.join(dir, n), ids, rejected, files);
    }
  } catch (error) {
    return { state: error instanceof RangeError ? "too large" : "unreadable", ids, rejected, files };
  }
  return { state: "read", ids, rejected, files };
}

/** Overwrites the session's row with "not checked" (zeros, transcript not read), so an older "complete" cannot stand. */
export function markNotChecked(ledger: Ledger, host: string, sessionId: string, reason: string, now: () => number = Date.now): void {
  ledger.saveSessionCoverage({
    sessionId, host, checkedAt: new Date(now()).toISOString(), status: "not checked", reason, events: 0, ops: 0, calls: null, lost: 0, failed: 0, noEvent: 0, unmatched: 0, unattributed: 0, expired: 0,
    names: { lost: [], failed: [], noEvent: [], unmatched: [], expired: [] },
  });
}

/** The time of the newest journal event of the session, or undefined when it has none. */
export function newestEventAt(home: string, sessionId: string): string | undefined {
  let newest: string | undefined;
  for (const r of readJournalSession(home, journalSessionKey(sessionId))) if (r.k === "event" && typeof r.at === "string" && (newest === undefined || r.at > newest)) newest = r.at;
  return newest;
}

const cut = (xs: Iterable<string>): string[] => {
  const all = [...xs].sort();
  return all.length <= NAMES_MAX ? all : [...all.slice(0, NAMES_MAX), `and ${all.length - NAMES_MAX} more`];
};

interface ReconcileInput {
  home: string;
  ledger: Ledger;
  host: string;
  sessionId: string;
  transcriptPath?: string;
  now?: () => number;
  /** Ops the adapter holds for this session while it has no task (not in the ledger yet); counted as recorded. */
  parkedOps?: Array<{ toolUseId?: string; closedBy?: string }>;
}

/** Sets the journal, the ledger and the transcript side by side for one session and rewrites its coverage row. */
export function reconcileSession(input: ReconcileInput): SessionCoverageRow {
  const { home, ledger, host, sessionId } = input;
  const records = readJournalSession(home, journalSessionKey(sessionId));

  // Events by body hash, so a duplicate delivery counts once.
  const events = new Map<string, { id: string; event: string; synthetic: boolean }>();
  const done = new Set<string>();
  const failed = new Set<string>();
  for (const r of records) {
    if (typeof r.sha256 !== "string") continue;
    if (r.k === "event") events.set(r.sha256, { id: String(r.id), event: String(r.event), synthetic: r.synthetic === true });
    else if (r.k === "done") done.add(r.sha256);
    else if (r.k === "failure") failed.add(r.sha256);
  }
  const eventIds = new Set<string>();
  for (const e of events.values()) if (CALL_EVENTS.has(e.event) && !e.synthetic) eventIds.add(e.id);

  // Ops of this session. A truncated stand-in carries no session id past its preview, so it counts when its call id is one of ours.
  const transcript: TranscriptCalls = findProfile(host)?.coverage?.readCalls(input.transcriptPath, sessionId) ?? { state: "not read (host)", ids: new Set() };
  const opIds = new Set<string>();
  let opCount = 0;
  const lastClosedBy = new Map<string, string | undefined>();
  for (const o of ledger.sessionOpRows(sessionId)) {
    const mine = o.truncated ? o.sessionId === sessionId || (o.toolUseId !== undefined && (eventIds.has(o.toolUseId) || transcript.ids.has(o.toolUseId))) : o.sessionId === sessionId;
    if (!mine) continue;
    opCount++;
    if (o.toolUseId !== undefined) {
      opIds.add(o.toolUseId);
      // Rows come in op order, so the last op of a call is how it ended (a Post after expiry writes a later op); a "late" op carries cells only.
      if (o.closedBy !== "late") lastClosedBy.set(o.toolUseId, o.closedBy);
    }
  }
  for (const o of input.parkedOps ?? []) {
    opCount++;
    if (o.toolUseId !== undefined) {
      opIds.add(o.toolUseId);
      if (o.closedBy !== "late") lastClosedBy.set(o.toolUseId, o.closedBy);
    }
  }
  const expired = new Set([...lastClosedBy].filter(([, by]) => by === "expiry").map(([id]) => id));

  const lost = new Set<string>();
  const failedNames = new Set<string>();
  for (const [sha, e] of events) {
    const name = `${e.event} ${e.id}`;
    if (done.has(sha)) continue;
    (failed.has(sha) ? failedNames : lost).add(name);
  }
  // A call event that was handled but left no op: its Post (or a Pre the Stop closed) must have written one.
  const failedIds = new Set([...events].filter(([sha]) => !done.has(sha) && failed.has(sha)).map(([, e]) => e.id));
  for (const [sha, e] of events) {
    if (!done.has(sha) || e.synthetic || !CALL_EVENTS.has(e.event)) continue;
    if (!opIds.has(e.id) && !failedIds.has(e.id) && !(transcript.rejected?.has(e.id) ?? false)) lost.add(`${e.event} ${e.id}`);
  }

  const noEvent = new Set<string>();
  const unmatched = new Set<string>();
  if (transcript.state === "read") {
    // Tracking begins with the first call that has a journal event, so the calls before it IN THE SAME FILE (the Skill call,
    // `cocheck track start`) were made untracked and owe no event. Each file (the main transcript, each subagent file) has its own cutoff,
    // by position in that file, never by id string. A file with no event-bearing call counts all its calls, and so does a journal with no
    // call event at all (the answer without ops; with ops that is lossy, without ops "not recorded" takes over).
    for (const file of transcript.files ?? [[...transcript.ids]]) {
      const first = file.findIndex((id) => eventIds.has(id));
      for (const id of file.slice(first === -1 ? 0 : first)) if (!eventIds.has(id)) noEvent.add(id);
    }
    for (const id of opIds) if (!transcript.ids.has(id)) unmatched.add(id);
  }

  let unattributed = 0;
  for (const bucket of ["unknown", "unparsed"]) for (const r of readJournalSession(home, bucket)) if (r.k === "event" || r.k === "failure") unattributed++;

  const degraded = journalDegraded(home, journalSessionKey(sessionId), records.find((r) => typeof r.at === "string")?.at);
  const calls = transcript.state === "read" ? transcript.ids.size : null;
  const bad = lost.size + failedNames.size + noEvent.size + expired.size;
  let status: CoverageStatus;
  let reason = "";
  if (transcript.state === "read" && transcript.ids.size > 0 && opIds.size === 0) {
    status = "not recorded";
    reason = "the transcript shows tool calls but the ledger holds none for this session";
  } else if (bad > 0 || degraded) {
    status = "lossy";
    reason = bad > 0 ? (expired.size > 0 && lost.size + failedNames.size + noEvent.size === 0 ? "some calls were closed by expiry with no result recorded" : "some hook events were lost, failed or never sent") : "the hook journal was unavailable on some run";
  } else if (transcript.state !== "read") {
    status = "not checked";
    reason = transcript.state === "not read (host)" ? "this host's transcripts are not read" : `the transcript was ${transcript.state}`;
  } else {
    status = "complete";
  }

  const row: SessionCoverageRow = {
    sessionId, host, checkedAt: new Date((input.now ?? Date.now)()).toISOString(), status, reason, events: events.size, ops: opCount, calls,
    lost: lost.size, failed: failedNames.size, noEvent: noEvent.size, unmatched: unmatched.size, unattributed, expired: expired.size,
    names: { lost: cut(lost), failed: cut(failedNames), noEvent: cut(noEvent), unmatched: cut(unmatched), expired: cut(expired) },
  };
  ledger.saveSessionCoverage(row);
  return row;
}

const n = (x: number) => x.toLocaleString("en-US");

/** Plain-words lines for sign-off and verify: one summary line per session, then the calls behind any non-zero bucket. */
export function sessionCoverageLines(sessionIds: string[], rows: Map<string, SessionCoverageRow>, newest: Map<string, string | undefined> = new Map()): string[] {
  const out: string[] = [];
  for (const sid of sessionIds) {
    const short = sid.slice(0, 8);
    const r = rows.get(sid);
    if (r === undefined) {
      out.push(`session ${short}: not checked (no Stop has reconciled it yet).`);
      continue;
    }
    const since = newest.get(sid);
    if (since !== undefined && since > r.checkedAt) {
      out.push(`session ${short}: not checked (events since last check) - last reconciled ${r.checkedAt} as ${r.status}, but the journal has events from ${since}.`);
      continue;
    }
    const counts = `${n(r.events)} events, ${n(r.ops)} ops, ${r.calls === null ? "transcript not read" : `${n(r.calls)} transcript calls`}, ${n(r.lost)} lost, ${n(r.failed)} failed, ${n(r.noEvent)} host sent no event${r.expired > 0 ? `, ${n(r.expired)} closed by expiry with no result` : ""}`;
    out.push(`session ${short}: ${r.status}${r.reason === "" ? "" : ` (${r.reason})`} - ${counts}; checked ${r.checkedAt}.`);
    for (const [label, names] of [["lost", r.names.lost], ["failed", r.names.failed], ["host sent no event", r.names.noEvent], ["closed by expiry with no result", r.names.expired]] as const) {
      for (const name of names) out.push(`  ${label}: ${name}`);
    }
    if (r.unattributed > 0) out.push(`  ${n(r.unattributed)} journal records name no session.`);
  }
  return out;
}
