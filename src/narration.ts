import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { profileOf, type HostKey } from "./hosts/index.ts";

/**
 * Narration: the agent's own words on a call and its closing claim, read from the host's session file.
 *
 * Definition. Narration is the agent's assistant text and nothing else. It is stored on the call (or, for the closing
 * claim, on the round's Stop) and labelled as the agent's own words. It never sets grouping, credit or row order, and it
 * never replaces, hides, merges or reorders a recorded row: this module returns text, and the adapter only attaches it
 * to an op it was writing anyway.
 *
 * Claude Code: the transcript is JSONL with one content block per line. The text blocks since the previous tool_use belong
 * to the next tool_use; further tool_use blocks of the same API message (parallel calls) point at the first call.
 * Codex: the session rollout is JSONL; an `AgentMessage` item holds the agent's words and a `CommandExecution` item carries
 * the ledger's `exec-<uuid>` id. The messages since the previous `CommandExecution` (or the start of the turn) belong to it;
 * a `final_answer` message is the closing claim, not narration.
 *
 * Never read: tool results and user text. Lines are recognised by a cheap type test; tool-result and user lines are
 * never parsed, and the tests plant sentinel text in them.
 *
 * Bounded and quiet: a read starts at a byte offset kept in the adapter's state, covers at most `maxBytes`, stops at the last
 * complete line (a half-written line waits for the next event) and at a time deadline. A missing, rotated, truncated, garbled
 * or reformatted file yields "no narration recorded"; nothing here throws.
 */

/** The host a session file belongs to. How its lines are read is the host profile's (`src/hosts/`). */
type NarrationHost = HostKey;

/** What an op or a Stop records. `none` is the honest "nothing to show"; the text is never empty. */
export interface Narration {
  source: "agent" | "none";
  /** Set when `source` is `agent`. */
  label?: string;
  /** The words (cut with `cut()`), or "no narration recorded". Absent on a pointer. */
  text?: string;
  /** A parallel call: the tool_use_id of the call in the same message that holds the text. */
  sameAs?: string;
}

const NO_NARRATION = "no narration recorded";
const NARRATION_LABEL = "the agent's own words";

/** The longest narration on one call, and the longest closing claim, in characters. */
export const NARRATION_MAX = 2000;
export const CLOSING_MAX = 4000;
/** Calls whose narration a cursor remembers; the oldest go first. */
const ENTRIES_KEPT = 64;
/** The most one event reads, in bytes, and the longest it works. */
export const READ_CAP_BYTES = 256 * 1024;
export const READ_BUDGET_MS = 150;

export const none = (): Narration => ({ source: "none", text: NO_NARRATION });

/** `reason`: the host's own per-call reason (Copilot's intentionSummary). `call`: the request the words belong to, for a host whose hook stdin has no call id; `taken` marks it claimed by a Pre. */
export type Entry = { text: string; reason?: string; call?: { name: string; argsKey: string }; taken?: true } | { sameAs: string };

/** A session's place in its host file. Lives in the adapter's state.json, so it is plain JSON. */
export interface NarrationCursor {
  /** The file the offset belongs to; another path starts a new cursor. */
  path: string;
  /** Bytes of the file already read, always at a line start. */
  offset: number;
  /** The next read begins inside a line longer than the read cap: drop up to its first newline. */
  skip: boolean;
  /** Assistant text since the previous call, in order. */
  pending: string[];
  /** Claude: the API message the last tool_use belonged to, and the first call of it that held text (null: none held any). */
  msg?: { id: string; first: string | null };
  /** Per tool_use_id, what was found; unlisted means no narration. */
  byId: Record<string, Entry>;
  order: string[];
  /** Codex: the latest final answer of the current turn. */
  closing?: string;
  /** The file is one helper's own transcript, whose lines are all sidechain lines and all that helper's words. */
  agent?: true;
}

/** A cursor read back from state.json is trusted only if it has the shape this version writes. */
export function validCursor(c: unknown): c is NarrationCursor {
  const x = c as Partial<NarrationCursor> | null;
  return x !== null && typeof x === "object" && typeof x.path === "string" && typeof x.offset === "number" && x.offset >= 0 && typeof x.skip === "boolean" && Array.isArray(x.pending) && Array.isArray(x.order) && x.byId !== null && typeof x.byId === "object";
}

export function newCursor(file: string, agent = false): NarrationCursor {
  return { path: file, offset: 0, skip: false, pending: [], byId: {}, order: [], ...(agent ? { agent: true as const } : {}) };
}

/** Cuts text to `max` characters, saying so when it cuts. Blank text is "". */
export function cut(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}... (${t.length} characters)`;
}

export function remember(cur: NarrationCursor, id: string, entry: Entry | undefined): void {
  if (entry === undefined) return;
  if (!(id in cur.byId)) cur.order.push(id);
  cur.byId[id] = entry;
  while (cur.order.length > ENTRIES_KEPT) delete cur.byId[cur.order.shift()!];
}

/** The text a pending list makes: its parts in order, cut. */
export function joined(pending: string[], max: number): string {
  return cut(pending.join("\n\n"), max);
}

/**
 * Reads what the file gained since the cursor's offset and folds it into the cursor. Never throws, never reads more than
 * `READ_CAP_BYTES`, and leaves the cursor as it was when the file cannot be read.
 */
export function advance(host: NarrationHost, cur: NarrationCursor, opts: { maxBytes?: number; budgetMs?: number; forward?: true } = {}): void {
  const maxBytes = opts.maxBytes ?? READ_CAP_BYTES;
  const deadline = performance.now() + (opts.budgetMs ?? READ_BUDGET_MS);
  let fd: number | undefined;
  try {
    // Nothing may block: a FIFO, a socket or a device named *.jsonl would hang an open or a read forever. Refuse anything that is
    // not a regular file before opening, and open non-blocking so a swap between this check and the open still returns at once.
    if (!statSync(cur.path).isFile()) return;
    fd = openSync(cur.path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return;
    if (stat.size < cur.offset) {
      // The file is shorter than what was read: rotated or truncated. Start again from what is there.
      cur.offset = 0;
      cur.skip = false;
      cur.pending = [];
      cur.msg = undefined;
      cur.closing = undefined;
    }
    let start = cur.offset;
    let skip = cur.skip;
    if (opts.forward !== true && stat.size - start > maxBytes) {
      // Too far behind to read it all: the newest bytes are what the next call needs. Begin mid-file, at a line start.
      start = stat.size - maxBytes;
      skip = true;
      cur.pending = [];
      cur.msg = undefined;
    }
    const want = Math.min(maxBytes, stat.size - start);
    if (want <= 0) return;
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let pos = 0;
    if (skip) {
      const nl = buf.indexOf(10, 0);
      if (nl < 0 || nl >= got) {
        // Still inside the long line: step over everything read.
        cur.offset = start + got;
        cur.skip = true;
        return;
      }
      pos = nl + 1;
    }
    cur.skip = false;
    const fold = profileOf(host).narration.foldLine;
    let lines = 0;
    for (;;) {
      const nl = buf.indexOf(10, pos);
      if (nl < 0 || nl >= got) break;
      if (pos < nl) {
        fold(cur, buf.toString("utf8", pos, nl));
      }
      pos = nl + 1;
      if (++lines % 64 === 0 && performance.now() > deadline) break;
    }
    if (pos === 0 && got >= maxBytes) {
      // No newline in a full window: a line longer than the cap. Step over it and drop the rest of it next time.
      cur.offset = start + got;
      cur.skip = true;
      return;
    }
    cur.offset = start + pos;
  } catch {
    // An unreadable file is "no narration recorded", not an error.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/**
 * For a call that has no words yet at its Post or close. Reads on from the cursor's place window by window instead of
 * jumping to the newest bytes, so lines written just after the call's Pre are not stepped over when the file has since grown past
 * the cap. Bounded by the read budget (`budgetMs`, so a caller that reads again after it shares one budget between the two reads); what it cannot reach in time stays for the next event, whose plain `advance` takes over.
 */
export function advanceForward(host: NarrationHost, cur: NarrationCursor, opts: { budgetMs?: number } = {}): void {
  const deadline = performance.now() + (opts.budgetMs ?? READ_BUDGET_MS);
  for (;;) {
    const before = cur.offset;
    advance(host, cur, { forward: true, budgetMs: Math.max(1, deadline - performance.now()) });
    let size = before;
    try {
      size = statSync(cur.path).size;
    } catch {
      return;
    }
    if (cur.offset === before || cur.offset >= size || performance.now() > deadline) return;
  }
}

/** What the cursor holds for a call: its words, a pointer to the parallel call that holds them, or none. */
export function lookup(cur: NarrationCursor | undefined, id: string): Narration {
  const e = cur?.byId[id];
  if (e === undefined) return none();
  if ("sameAs" in e) return { source: "agent", label: NARRATION_LABEL, sameAs: e.sameAs };
  if (e.text === "") return none();
  return { source: "agent", label: NARRATION_LABEL, text: e.text };
}

/** The host's own reason for a call, when the cursor holds one. */
export function reasonOf(cur: NarrationCursor | undefined, id: string): string | undefined {
  const e = cur?.byId[id];
  return e !== undefined && "reason" in e && e.reason !== undefined && e.reason !== "" ? e.reason : undefined;
}

/** For a host with no call id on stdin: the oldest request in the cursor, by tool and argument key, no Pre has claimed yet and `taken` does not hold. Claims it. */
export function claimRequest(cur: NarrationCursor | undefined, name: string, argsKey: string, taken: ReadonlySet<string>): string | undefined {
  if (!cur) return undefined;
  for (const id of cur.order) {
    const e = cur.byId[id];
    if (e === undefined || "sameAs" in e || e.taken === true || e.call === undefined || taken.has(id)) continue;
    if (e.call.name !== name || e.call.argsKey !== argsKey) continue;
    e.taken = true;
    return id;
  }
  return undefined;
}

/** At a call's Pre: the host's words that wait unbound in the cursor go to this call (a host with no such step claims nothing). */
export function claimAtPre(host: NarrationHost, cur: NarrationCursor | undefined, id: string): void {
  if (cur) profileOf(host).narration.claimAtPre?.(cur, id);
}

/** The closing claim at a Stop: the host's own last message when it sent one, else what the file holds. */
export function closingClaim(host: NarrationHost, cur: NarrationCursor | undefined, fromPayload: unknown): Narration {
  const given = typeof fromPayload === "string" ? cut(fromPayload, CLOSING_MAX) : "";
  const text = given !== "" ? given : profileOf(host).narration.closing(cur);
  return text === "" ? none() : { source: "agent", label: NARRATION_LABEL, text };
}

/** After a Stop: the words up to here are spent. */
export function spend(cur: NarrationCursor | undefined): void {
  if (!cur) return;
  cur.pending = [];
  cur.closing = undefined;
  cur.msg = undefined;
}
