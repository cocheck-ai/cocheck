// Requests, runs and CoCheck's reading, from the ledger record alone. Pure: ops and file_states rows in, plain data out.
// Nothing here knows a file format, a tool name or a particular run. Rules (spec of record):
//  - The call is the atom. A call's target = the files named in its input plus the files whose state changed while it was
//    open (a background call stays open until Stop by construction, so for it only the changes credited to it count; a change
//    credited to another session's call is never this session's).
//  - A request belongs to one session. A session's turn is everything up to its own Stop; the prompt ops logged inside that
//    turn give its request text(s). Held prompts re-logged at another session's round close are the same request.
//  - A run is a maximal stretch of consecutive calls in one session and one request. It ends at the first of: an observed
//    change to a file in its target; a call with a non-empty target that shares nothing with the run's target so far; a new
//    request; the end of the request. Calls with an empty target never start a run: they join the open run, or the next one.
//  - Guideposts ("CoCheck's reading") come from these rules only. They never quote the agent and never set credit.
//
// Request order and lanes (the tests pin each):
//  - A request's order is read under CoCheck's own names too: the prompt op's `requests: [{seq, at, firstStep}]`.
//  - A call carries `startSeq` and `toolLabel`, when the record has them.
//  - With a submit `seq` on every request text and a `startSeq` on every call, a call belongs to the last request submitted
//    before it started, and calls and requests sort by those counters. Without them the time and step rules apply.
//  - A subagent's calls (`agent_id` on the call op) belong to the request its first call belongs to, wherever they start, so a
//    request submitted while an agent is still running never takes the agent's calls. A call with no agent id is never moved.
//  - A run never mixes lanes: the main line and each subagent are cut into runs apart, and a request's runs are listed in
//    the order their first calls started.
//  - That holds across turns: the Stop that cut the ledger's turn does not decide it. An agent's calls that run on after a
//    Stop stay with the request that launched it, not the prompt that wakes the session later.
import { pathKit } from "../paths.ts";
import { reportsFailureEvents, toolNameOf } from "../hosts/index.ts";
import type { ToolLabel, WithheldRecord } from "../tool-label.ts";
import { isLauncherTool, type CallEvidence, type EvidenceKind } from "../credit-guard.ts";

const EVIDENCE_KINDS: ReadonlySet<string> = new Set<EvidenceKind>(["result", "interrupted", "turn", "blocked", "denied"]);
/** An op's `ended` ({at, kind}) when well formed, else null. */
function endedOf(v: unknown): CallEvidence | null {
  const e = v as { at?: unknown; kind?: unknown } | null;
  return e !== null && typeof e === "object" && typeof e.at === "number" && Number.isFinite(e.at) && typeof e.kind === "string" && EVIDENCE_KINDS.has(e.kind) ? { at: e.at, kind: e.kind as EvidenceKind } : null;
}

export interface RawOp {
  id: number;
  tool?: string;
  intent?: string;
  args?: Record<string, unknown>;
  args_json?: string | null;
}

export interface RawState {
  id: number;
  step_id?: number | null;
  task_id?: number;
  file_path: string;
  sha256: string;
  prev_sha256: string | null;
  phase?: string;
  calls_open_json?: string | string[] | null;
  credited_json?: string | string[] | null;
  size?: number;
  kept?: string;
  note?: string;
  /** The file's modification time at the sweep, in ns; absent when the sweep did not record it. */
  mtime_ns?: string | null;
  /** What the credit stands on (`file_states.credit_basis`); absent or null when none was recorded. */
  credit_basis?: string | null;
  /** The connector id when `file_path` is a URI subject; absent for a built-in file. */
  connector?: string | null;
  /** the connector's version and spec at capture, and the sha256 of the frozen change list it served; absent on a row older than schema 7. */
  connector_version?: string | null;
  connector_spec?: string | null;
  changes_sha256?: string | null;
  /** where the review process's read of this row's change list stands (absent: the row was never read that way), and why it failed. */
  capture?: "pending" | "captured" | "failed" | null;
  capture_reason?: string | null;
  capture_detail?: string | null;
  /** "ask again" answers so far, and the latest one's change-store hash while the capture is pending. */
  capture_tries?: number;
  capture_try_sha?: string | null;
  /** the hook recorded this row with no connector and the review process read its change list later, with the built-in that claims the file now (`connector`). */
  read_later?: true;
  /** When the step that recorded this state ran (the steps row's `ts`), when known. */
  ts?: string | null;
}

export interface Narration {
  source?: string;
  label?: string;
  text?: string;
  sameAs?: string;
}

export interface Call {
  id: string;
  session: string | null;
  host: string | null;
  tool: string | null;
  description: string;
  command: string;
  openedAt: number | null;
  closedAt: number | null;
  closedBy: string | null;
  /** The host's error text for a call that failed (the op's `error`); null on a call that did not fail and on ops written before the field. */
  error: string | null;
  /** The failure was read from the output text (the host sends no failure signal), so it proves nothing about the other calls. */
  errorInferred: boolean;
  background: boolean;
  /** The call waited on helpers (the op's `waits`): it wrote nothing and is never credited. Absent on ops written before the field. */
  waits?: boolean;
  /** How the call ended, as the adapter read it from the host's transcript (the op's `ended`); null when the record has none. */
  ended: CallEvidence | null;
  narration: Narration | null;
  input: unknown;
  /** The label as stored on the call op: {fields, dropped?, inputFields?}. Null when the record has none. */
  toolLabel: ToolLabel | null;
  startSeq: number | null;
  /** Files (relative to the watched folder) the call rewrote with the bytes they already had (the op's `sameBytesRewrites`); absent on ops written before the field and when none. */
  rewrote?: string[];
  /** The subagent that made the call (the hook payload's `agent_id` and `agent_type`). Null on the main line and on ops written before the field. */
  agentId: string | null;
  agentType: string | null;
  /**
   * For a subagent's call, the first call the record holds from that same agent in that session. A request owns an agent's
   * calls by where this one started, so a later request never claims them. Absent on the main line.
   */
  laneHead?: Call;
  /** The tool_use_id of the main-stream call that launched the agent (`launch_tool_use_id` on the op), when the adapter could read it. */
  launchId: string | null;
  /** The call that directly launched this agent (the lane's launcher), for an agent's call whose launch id the record holds. Not followed up the chain, unlike `placeBy`. */
  launcherCall?: Call;
  /**
   * The call whose request owns this agent call: the call that launched the agent when the record holds it, else the lane
   * head. Absent on the main line and on a lane's own head with no launcher.
   */
  placeBy?: Call;
  /** For an agent's call made after a SendMessage resumed the agent, the latest such SendMessage before it. Absent otherwise. */
  resumedBy?: Call;
  named: Set<string>;
  stepIds: Set<number>;
  opIds: number[];
  firstOp: number;
  /** Set by buildRuns: 1-based position in its request. */
  index?: number;
  /** Set by buildRuns: the files named plus the changes observed while the call ran. */
  target?: Set<string>;
}

export interface State extends Omit<RawState, "credited_json" | "calls_open_json"> {
  credited: string[];
  open: string[];
  change: boolean;
}

interface Text {
  text: string;
  seq: number | null;
  at: number | null;
  step: number | null;
  /** Set (at read time) when the text is a background agent's wake: it is never a request. */
  wakes?: Wake[];
}

/** A helper's SubagentStop: the host said the helper finished, with its last message (already redacted and cut by the hook). */
export interface Finish {
  session: string | null;
  seq: number | null;
  at: number | null;
  agentId: string;
  agentType: string | null;
  text: string | null;
  /** The host that wrote the Stop op (its own `host`); null on an op written before the field. */
  host: string | null;
}

/** One turn's closing message with the time its Stop came. A request keeps every one, in order. */
export interface Reply {
  closing: Narration;
  at: number | null;
  /** The host that wrote the Stop op; null on an op written before the field. */
  host: string | null;
}

/** A background agent's wake: the host's `<task-notification>` prompt that names a launcher call recorded in the same session. The launcher may be a SendMessage that resumed the agent. */
export interface Wake {
  session: string | null;
  seq: number | null;
  at: number | null;
  /** The launching call's tool_use id, from `<tool-use-id>`. */
  toolUseId: string;
  /** The launching call. */
  launcher: Call;
  /** The woken agent's id, when any of its calls carries the launcher id; for a SendMessage launcher, the notification's task id (the agent's id). Else null. */
  agentId: string | null;
  /** `<status>` kept only as a plain word, else null. */
  status: string | null;
  /** `<summary>`, untouched here (the timeline scrubs and clamps it), else null. */
  summary: string | null;
}

type Event =
  | { type: "prompt"; opId: number; session: string | null; texts: Text[]; earlier: number }
  | { type: "stop"; opId: number; session: string | null; at: number | null; closing: Narration | null; host: string | null }
  | { type: "trackstop"; opId: number; session: string | null; at: number | null }
  | ({ type: "finish"; opId: number } & Finish)
  | { type: "call"; opId: number; session: string | null; call: Call };

export interface Reading {
  position: string;
  phase: string;
  caption: string;
  attempts: string;
  lookups: number;
  failed: number | null;
}

export interface RequestReading {
  position: string;
  session: string | null;
  placement: string;
  texts: string | null;
}

export interface Request {
  session: string | null;
  texts: string[];
  captured: boolean;
  placement: "recorded" | "inferred";
  calls: Call[];
  closing: Narration | null;
  /** Every turn's closing message this request owns, in order; `closing` is the last of them. */
  replies: Reply[];
  /** The helpers that finished (SubagentStop) for this request, in the order they came. */
  finishes: Finish[];
  firstOp: number | null;
  anchor: number | null;
  anchorSeq: number | null;
  /** The wakes of background agents this request owns (a woken agent belongs to the request that owns its launcher call). */
  wakes: Wake[];
  /** Where a shell command in the session switched tracking off (`cocheck track stop`), in record order. Absent when none did. */
  trackingStops?: Array<{ at: number | null }>;
  index: number;
  id: string;
  runs: Run[];
  reading: RequestReading;
}

export interface Run {
  request: Request;
  session: string | null;
  calls: Call[];
  target: Set<string>;
  endsInChange: boolean;
  changes: Array<{ state: State; call: Call }>;
  changed: Set<string>;
  phase: string;
  index: number;
  id: string;
  failuresReported: boolean;
  reading: Reading;
}

export interface RunsResult {
  requests: Request[];
  runs: Run[];
  calls: Map<string, Call>;
  states: State[];
  observed: Map<string, State[]>;
  sessions: Array<string | null>;
}

const MODE = /^\s*(ANSWER|PLAN|EXECUTE|SURVEY|DEEP-DIVE|REMEMBER|IDEATE|CRITIQUE|DEBATE|TUTOR)\b[.:]?\s*/; // a mode label (and one "." or ":" right after it), not words
/** Text with at least one letter or digit; "." and "..." are not words. */
export const WORDY = /[\p{L}\p{N}]/u;
export const words = (t: unknown): string => String(t ?? "").replace(MODE, "").trim();
export const baseName = (p: unknown): string => pathKit().baseName(String(p ?? ""));
const json = <T>(v: unknown, d: T): T => {
  if (v == null || v === "") return d;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return d;
  }
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pl = (n: number, w: string, ws = w + "s"): string => `${n} ${n === 1 ? w : ws}`;
const listOf = (xs: Iterable<string>, max = 3): string => {
  const a = [...xs];
  if (a.length > max) return `${a.slice(0, max).join(", ")} and ${a.length - max} more`;
  return a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`;
};
// A host whose profile says it sends a failure event for a failed call (`capabilities.failureEvent`): a call it closes with none succeeded.
// Any host whose record holds a failed call also counts.
const NOTE = / \[(joint attribution|cells found)[^\]]*\]$/;

/** The rule version a run carries, so two days' timelines can be compared knowing whether the cut moved. */
export const RUN_RULE = "runs/1";

type Args = Record<string, unknown>;

// The request's submit order, if the record carries it. CoCheck's own record is a list of `{seq, at, firstStep}` on the
// prompt op.
function readOrder(a: Args, n: number): { seq: Array<number | null>; at: Array<number | null>; step: Array<number | null> } {
  const none = (): Array<number | null> => Array.from({ length: n }, () => null);
  const listed = Array.isArray(a.requests) ? (a.requests as unknown[]) : null;
  if (listed && listed.length === n) {
    const field = (k: string): Array<number | null> => listed.map((q) => num((q as Args | null)?.[k]));
    const seq = field("seq").map((s) => (s != null && s > 0 ? s : null));
    return { seq, at: field("at"), step: field("firstStep") };
  }
  return { seq: none(), at: none(), step: none() };
}

/** A stored agent id or type: a non-empty string, else null (the call is on the main line). */
function plainId(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Reads the stored label shape; anything else (a string, a stray object) is no label. */
function readToolLabel(raw: unknown): ToolLabel | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const fields: Record<string, string | string[]> = {};
  if (r.fields !== null && typeof r.fields === "object" && !Array.isArray(r.fields)) {
    for (const [k, v] of Object.entries(r.fields as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) fields[k] = v.trim();
      else if (Array.isArray(v)) {
        const list = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
        if (list.length) fields[k] = list;
      }
    }
  }
  const inputFields = Array.isArray(r.inputFields) ? r.inputFields.filter((x): x is string => typeof x === "string") : undefined;
  // Only the fact that a brief was withheld is kept (never a value), so the page can say so.
  const droppedRaw = r.dropped !== null && typeof r.dropped === "object" && !Array.isArray(r.dropped) ? (r.dropped as Record<string, unknown>) : undefined;
  // A withheld message, content or summary is said so too (the reason only, never a value).
  const droppedKept: Record<string, string> = {};
  for (const k of ["prompt", "message", "content", "summary"]) if (typeof droppedRaw?.[k] === "string") droppedKept[k] = (droppedRaw[k] as string).slice(0, 200);
  const dropped = Object.keys(droppedKept).length > 0 ? droppedKept : undefined;
  // The way back for a withheld field (family, hash, locator), kept as stored: strings only, never a value.
  const withheldRaw = r.withheld !== null && typeof r.withheld === "object" && !Array.isArray(r.withheld) ? (r.withheld as Record<string, unknown>) : undefined;
  const withheld: Record<string, WithheldRecord> = {};
  for (const [k, v] of Object.entries(withheldRaw ?? {})) {
    const w = v as { family?: unknown; sha256?: unknown; locator?: { file?: unknown; id?: unknown } } | null;
    if (w === null || typeof w !== "object" || typeof w.family !== "string" || typeof w.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(w.sha256)) continue;
    const loc = w.locator;
    withheld[k] = { family: w.family.slice(0, 40), sha256: w.sha256, ...(loc !== null && typeof loc === "object" && typeof loc.file === "string" && typeof loc.id === "string" ? { locator: { file: loc.file, id: loc.id } } : {}) };
  }
  if (Object.keys(fields).length === 0 && !inputFields?.length && !dropped) return null;
  return { fields, ...(inputFields?.length ? { inputFields } : {}), ...(dropped ? { dropped } : {}), ...(Object.keys(withheld).length > 0 ? { withheld } : {}) };
}

// ---- wakes ----

const WAKE_START = "<task-notification>";
const WAKE_END = "</task-notification>";
const PLAIN_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

/** One block's head (its own top level, before any `<result>` or `<usage>`): the tool-use id, the status word and the summary. Null when it has no plain tool-use id. */
function parseHead(head: string): { toolUseId: string; taskId: string | null; status: string | null; summary: string | null } | null {
  const id = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(head)?.[1]?.trim();
  if (id === undefined || !PLAIN_ID.test(id)) return null;
  const task = /<task-id>([^<]*)<\/task-id>/.exec(head)?.[1]?.trim();
  const status = /<status>\s*([A-Za-z_-]{1,20})\s*<\/status>/.exec(head)?.[1] ?? null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(head)?.[1]?.trim() ?? null;
  return { toolUseId: id, taskId: task !== undefined && PLAIN_ID.test(task) ? task : null, status, summary: summary === "" ? null : summary };
}

/**
 * Parses a wake prompt as a sequence of top-level blocks (docs/timeline.md, "Background agent wakes"). Null when the prompt does not start
 * with a block. A block opens at the start of the prompt or right after the previous block's closing tag (whitespace between). Its head is
 * everything up to the first `<result>`, `<usage>` or closing tag; fields are read from the head only. After a `<result>`/`<usage>` the rest
 * is an opaque span: opening tags in it count up; a closing tag preceded by `</result>` or `</usage>` counts down, or, at depth 0, ends the
 * block. A closing tag preceded by anything else is content. If the span never balances, the block runs to the end of the prompt. Text after the last block is `rest`.
 */
export function parseBlocks(text: string): { blocks: Array<{ toolUseId: string; taskId: string | null; status: string | null; summary: string | null } | null>; rest: string } | null {
  if (!text.startsWith(WAKE_START)) return null;
  const blocks: Array<ReturnType<typeof parseHead>> = [];
  let pos = 0;
  for (;;) {
    const bodyStart = pos + WAKE_START.length;
    const ends = [text.indexOf("<result>", bodyStart), text.indexOf("<usage>", bodyStart), text.indexOf(WAKE_END, bodyStart)].filter((i) => i >= 0);
    const headEnd = ends.length ? Math.min(...ends) : text.length;
    blocks.push(parseHead(text.slice(bodyStart, headEnd)));
    let end = text.length;
    if (text.startsWith(WAKE_END, headEnd)) end = headEnd + WAKE_END.length;
    else if (headEnd < text.length) {
      let depth = 0;
      for (const m of text.slice(headEnd).matchAll(/<task-notification>|<\/task-notification>/g)) {
        if (m[0] === WAKE_START) depth++;
        else if (/<\/(result|usage)>\s*$/.test(text.slice(0, headEnd + m.index!))) {
          if (depth === 0) {
            end = headEnd + m.index! + WAKE_END.length;
            break;
          }
          depth--;
        }
      }
    }
    const tail = text.slice(end).trimStart();
    if (tail.startsWith(WAKE_START)) {
      pos = text.length - tail.length;
      continue;
    }
    return { blocks, rest: tail.trim() };
  }
}

/**
 * Marks the prompt texts that are wakes. A text is parsed into its top-level blocks (`parseBlocks`); it must start with a block. Each block
 * needs a launcher call in its own session (a call of the Agent, Task or SendMessage tool, or one an agent's calls name as their launcher) to be a wake of
 * its own; a block that fails that is dropped, and its text is shown nowhere. A text with no valid block stays a request, whole. When a wake
 * prompt has text after its last block, that text becomes a request of its own (same stamp) and the block text is never shown.
 */
function markWakes(events: Event[], calls: Map<string, Call>): void {
  const named = new Set<string>();
  for (const c of calls.values()) if (c.agentId !== null && c.launchId !== null) named.add(c.session + "\u0000" + c.launchId);
  for (const e of events) {
    if (e.type !== "prompt") continue;
    const out: Text[] = [];
    for (const t of e.texts) {
      out.push(t);
      const parsed = parseBlocks(t.text);
      if (parsed === null) continue;
      const wakes: Wake[] = [];
      for (const w of parsed.blocks) {
        if (w === null) continue;
        const launcher = calls.get(w.toolUseId);
        if (launcher === undefined || launcher.session !== e.session) continue;
        if (!(isLauncherTool(launcher.tool) || launcher.tool === "SendMessage" || named.has(launcher.session + "\u0000" + launcher.id))) continue;
        const agent = [...calls.values()].filter((c) => c.session === e.session && c.agentId !== null && c.launchId === w.toolUseId).sort((x, y) => (x.startSeq ?? Infinity) - (y.startSeq ?? Infinity) || x.firstOp - y.firstOp)[0];
        // A SendMessage that resumed an agent is no Agent call, so no agent carries its id; the notification's task id names the agent.
        const woken = agent?.agentId ?? (launcher.tool === "SendMessage" ? w.taskId : null);
        wakes.push({ session: e.session, seq: t.seq, at: t.at, toolUseId: w.toolUseId, launcher, agentId: woken, status: w.status, summary: w.summary });
      }
      if (wakes.length === 0) continue;
      t.wakes = wakes;
      if (parsed.rest !== "") out.push({ text: parsed.rest, seq: t.seq, at: t.at, step: t.step });
    }
    e.texts = out;
  }
}

// ---- the record, normalised ----

/** An Agent or Task call whose input says `run_in_background: true` is a background launch (the meta-file case is read in agent-transcripts.ts). */
function launchedInBackground(tool: unknown, input: unknown): boolean {
  return (tool === "Agent" || tool === "Task") && typeof input === "object" && input !== null && (input as { run_in_background?: unknown }).run_in_background === true;
}

export function readRecord(ops: RawOp[], fileStates: RawState[]): { calls: Map<string, Call>; events: Event[]; states: State[] } {
  const calls = new Map<string, Call>();
  const events: Event[] = []; // in op order
  const firstSteps = new Map<number, number>();
  for (const o of [...ops].sort((x, y) => x.id - y.id)) {
    const a: Args = o.args ?? json<Args>(o.args_json, {});
    const session = typeof a.session_id === "string" ? a.session_id : null;
    if (a.hookEvent === "RequestFirstStep") {
      // A request written at its round's first call is told its first step by this op, once the step exists.
      for (const q of Array.isArray(a.requests) ? (a.requests as unknown[]) : []) {
        const seq = num((q as Args | null)?.seq);
        const step = num((q as Args | null)?.firstStep);
        if (seq != null && seq > 0 && step != null) firstSteps.set(seq, step);
      }
      continue;
    }
    if (a.hookEvent === "UserPromptSubmit") {
      const texts = ((a.prompts as unknown[]) ?? []).map(String);
      const order = readOrder(a, texts.length);
      events.push({
        type: "prompt",
        opId: o.id,
        session,
        texts: texts.map((t, i) => ({ text: t, seq: order.seq[i] ?? null, at: order.at[i] ?? null, step: order.step[i] ?? null })),
        earlier: num(a.earlier) ?? 0,
      });
      continue;
    }
    if (a.hookEvent === "SubagentStop") {
      const agentId = plainId(a.agent_id);
      if (agentId === null) continue;
      const f = (a.finish ?? {}) as { text?: unknown };
      events.push({ type: "finish", opId: o.id, session, seq: num(a.seq), at: num(a.at), agentId, agentType: plainId(a.agent_type), text: typeof f.text === "string" && f.text.trim() !== "" ? f.text : null, host: typeof a.host === "string" ? a.host : null });
      continue;
    }
    if (a.hookEvent === "TrackingStopped") {
      events.push({ type: "trackstop", opId: o.id, session, at: num(a.at) });
      continue;
    }
    if (a.hookEvent === "Stop") {
      events.push({ type: "stop", opId: o.id, session, at: num(a.at), closing: (a.closing as Narration | undefined) ?? null, host: typeof a.host === "string" ? a.host : null });
      continue;
    }
    if (typeof a.lateNarrationFor === "string") {
      // Words that reached the host's file after the call closed. They fill a call that has none; words the call has are never replaced.
      const late = calls.get(a.lateNarrationFor);
      const n = a.narration as Narration | undefined;
      if (late !== undefined && late.narration?.source !== "agent" && n?.source === "agent") late.narration = n;
      continue;
    }
    if (!a.tool_use_id) continue;
    const id = String(a.tool_use_id);
    let c = calls.get(id);
    if (!c) {
      const description = String(a.description ?? "").trim();
      let command = String(o.intent ?? "").replace(NOTE, "").replace(NOTE, "");
      if (description && command.endsWith(" - " + description)) command = command.slice(0, -(description.length + 3));
      const label = readToolLabel(a.toolLabel);
      // A record stored before its host's tool names were separated at ingest is read by the tool's own name too.
      const reported = typeof a.tool_name === "string" ? a.tool_name : (o.tool ?? null);
      const tool = reported === null ? null : toolNameOf(typeof a.host === "string" ? a.host : null, reported);
      c = {
        id,
        session,
        host: typeof a.host === "string" ? a.host : null,
        tool,
        description,
        command,
        openedAt: num(a.openedAt),
        closedAt: num(a.closedAt),
        closedBy: typeof a.closedBy === "string" ? a.closedBy : null,
        error: a.closedBy === "failure" && typeof a.error === "string" && a.error !== "" ? a.error : null,
        errorInferred: a.closedBy === "failure" && a.errorInferred === true,
        background: a.background === true || launchedInBackground(tool, a.tool_input ?? a.toolInput ?? a.input),
        ...(a.waits === true ? { waits: true } : {}),
        ended: endedOf(a.ended),
        narration: (a.narration as Narration | undefined) ?? null,
        input: a.tool_input ?? a.toolInput ?? a.input ?? null,
        toolLabel: label,
        startSeq: num(a.startSeq),
        agentId: plainId(a.agent_id),
        agentType: plainId(a.agent_type),
        launchId: plainId(a.launch_tool_use_id),
        named: new Set((a.namedFiles as string[] | undefined) ?? []),
        stepIds: new Set(),
        opIds: [],
        firstOp: o.id,
      };
      calls.set(id, c);
      events.push({ type: "call", opId: o.id, session, call: c });
    }
    if (c.ended === null) c.ended = endedOf(a.ended);
    if (a.closedBy === "failure") {
      c.closedBy = "failure";
      if (typeof a.error === "string" && a.error !== "") c.error = a.error;
      if (a.errorInferred === true) c.errorInferred = true;
    }
    else if (a.closedBy === "post" && c.closedBy === "expiry") {
      // The Post came after expiry closed the call; the host's word replaces the expiry outcome.
      c.closedBy = "post";
      c.closedAt = num(a.closedAt) ?? c.closedAt;
    }
    for (const f of (a.namedFiles as string[] | undefined) ?? []) c.named.add(f);
    for (const s of (a.steps as number[] | undefined) ?? []) c.stepIds.add(s);
    if (Array.isArray(a.sameBytesRewrites)) {
      const more = (a.sameBytesRewrites as unknown[]).filter((x): x is string => typeof x === "string");
      if (more.length > 0) c.rewrote = [...new Set([...(c.rewrote ?? []), ...more])];
    }
    c.opIds.push(o.id);
  }
  // A parallel call's words are its sibling's: `sameAs` names the first call of the same host message, so the sibling must be in the
  // same session and the same lane (main line or agent) and must hold words of its own. Anything else keeps the call without words.
  for (const c of calls.values()) {
    const n = c.narration;
    if (n?.source !== "agent" || n.sameAs === undefined || n.text !== undefined) continue;
    const from = calls.get(n.sameAs);
    const t = from?.narration;
    if (from === undefined || from === c || from.session !== c.session || from.agentId !== c.agentId || t?.source !== "agent" || t.text === undefined) continue;
    c.narration = { source: "agent", ...(t.label === undefined ? {} : { label: t.label }), text: t.text, sameAs: n.sameAs };
  }
  // Each agent's first call in a session heads its lane. An agent id with no agent type still has a lane; a call with no agent id never does.
  const heads = new Map<string, Call>();
  for (const c of [...calls.values()].sort((x, y) => (x.startSeq ?? Infinity) - (y.startSeq ?? Infinity) || x.firstOp - y.firstOp)) {
    if (c.agentId === null) continue;
    const key = `${c.session}\u0000${c.agentId}`;
    const head = heads.get(key);
    if (head === undefined) heads.set(key, c);
    else c.laneHead = head;
  }
  // A lane's launcher is the call named by the first launch id any of its calls carries. The lane's calls are placed by it
  // (through the launcher's own anchor when the launcher is itself an agent's call); with none in the record, by the lane head.
  const launchers = new Map<string, Call>();
  for (const c of [...calls.values()].sort((x, y) => (x.startSeq ?? Infinity) - (y.startSeq ?? Infinity) || x.firstOp - y.firstOp)) {
    if (c.agentId === null || c.launchId === null) continue;
    const key = `${c.session}\u0000${c.agentId}`;
    const found = calls.get(c.launchId);
    if (!launchers.has(key) && found && found.session === c.session && found.agentId !== c.agentId) launchers.set(key, found);
  }
  markWakes(events, calls);
  for (const c of calls.values()) if (c.agentId !== null) {
    const l = launchers.get(`${c.session}\u0000${c.agentId}`);
    if (l !== undefined) c.launcherCall = l;
  }
  // An agent resumed by a SendMessage does its later work for the request that sent it. The recipient is the SendMessage's own `to`
  // when the record holds its input, else the task id of the notification that SendMessage launched.
  const resumes = new Map<string, Call[]>();
  const noteResume = (session: string | null, agentId: string | null, send: Call): void => {
    if (agentId === null) return;
    const key = `${session}\u0000${agentId}`;
    const list = resumes.get(key) ?? [];
    if (!list.includes(send)) resumes.set(key, [...list, send]);
  };
  for (const c of calls.values()) {
    const to = c.tool === "SendMessage" && typeof c.input === "object" && c.input !== null ? plainId((c.input as { to?: unknown }).to) : null;
    noteResume(c.session, to, c);
  }
  for (const e of events) if (e.type === "prompt") for (const t of e.texts) for (const w of t.wakes ?? []) if (w.launcher.tool === "SendMessage") noteResume(w.session, w.agentId, w.launcher);
  const startedBefore = (a: Call, b: Call): boolean => {
    if (a.startSeq != null && b.startSeq != null) return a.startSeq < b.startSeq;
    if (a.openedAt != null && b.openedAt != null && a.openedAt !== b.openedAt) return a.openedAt < b.openedAt;
    return a.firstOp < b.firstOp;
  };
  const anchorOf = (c: Call, depth = 0): Call => {
    if (c.agentId === null || depth > 8) return c;
    const via = launchers.get(`${c.session}\u0000${c.agentId}`) ?? c.laneHead;
    return via === undefined || via === c ? c : anchorOf(via, depth + 1);
  };
  for (const c of calls.values()) if (c.agentId !== null) {
    const a = anchorOf(c);
    if (a !== c) c.placeBy = a;
    const sent = (resumes.get(`${c.session}\u0000${c.agentId}`) ?? []).filter((s) => s !== c && startedBefore(s, c)).sort((x, y) => (startedBefore(x, y) ? 1 : -1))[0];
    if (sent !== undefined) {
      c.resumedBy = sent;
      c.placeBy = anchorOf(sent);
    }
  }
  const firstStep = Math.min(...fileStates.map((s) => s.step_id ?? s.id), Infinity);
  const states: State[] = [...fileStates]
    .sort((a, b) => a.id - b.id)
    .map((s) => {
      const credited = json<string[]>(s.credited_json, []);
      const open = json<string[]>(s.calls_open_json, []);
      // The baseline (every file copied at the task's first event) is not a change; any other state is one (a new file included).
      const baseline = !s.prev_sha256 && !credited.length && (s.step_id ?? s.id) === firstStep;
      return { ...s, credited, open, change: !baseline };
    });
  if (firstSteps.size > 0) {
    for (const e of events) {
      if (e.type !== "prompt") continue;
      for (const t of e.texts) if (t.step == null && t.seq != null && firstSteps.has(t.seq)) t.step = firstSteps.get(t.seq)!;
    }
  }
  return { calls, events, states };
}

// ---- requests ----

const timeOf = (c: Call): number | null => c.openedAt ?? c.closedAt;
function orderCalls(list: Call[]): Call[] {
  if (list.length > 0 && list.every((c) => c.startSeq != null)) return [...list].sort((a, b) => a.startSeq! - b.startSeq! || a.firstOp - b.firstOp);
  const timed = list.every((c) => timeOf(c) != null);
  return [...list].sort((a, b) => (timed ? timeOf(a)! - timeOf(b)! : 0) || a.firstOp - b.firstOp);
}

// Prompt ops inside one turn re-log the session's held prompts: the same texts, possibly with newer ones after them.
function mergeTexts(acc: Text[], texts: Text[]): void {
  if (texts.every((t) => t.seq != null)) {
    for (const t of texts) if (!acc.some((x) => x.seq === t.seq)) acc.push(t);
    return;
  }
  let k = Math.min(acc.length, texts.length);
  for (; k > 0; k--) if (acc.slice(-k).every((x, i) => x.text === texts[i]!.text)) break;
  acc.push(...texts.slice(k));
}

interface Seg {
  calls: Call[];
  prompts: Array<Extract<Event, { type: "prompt" }>>;
  stop: Extract<Event, { type: "stop" }> | null;
  firstOp: number | null;
}

// A session's requests when every request text carries its submit `seq` and every call its `startSeq`. A call belongs to the
// last request the session submitted before the call started, whichever Stop cut the ledger's turn around it: an agent's calls that
// run on after a Stop are written into the next turn's ops, and a prompt that wakes the session is stamped after they started, so the
// turn's ops alone would hand them to the wake. A call that started before the session's first request has none and sits in a
// request with no text. A turn's closing claim stays with the request its last prompt made (else its last call's). Null when the
// record lacks a stamp, which leaves the per-turn placement below.
function requestsBySeq(session: string | null, segs: Seg[]): Request[] | null {
  const texts: Array<{ t: Text; opId: number }> = [];
  // A wake is not a request; it is kept apart, once per submit stamp (held prompts are re-logged).
  const wakes: Wake[] = [];
  for (const seg of segs) {
    for (const p of seg.prompts) {
      for (const t of p.texts) {
        if (t.wakes) {
          for (const w of t.wakes) if (!wakes.some((x) => x.seq === w.seq && x.toolUseId === w.toolUseId)) wakes.push(w);
        } else if (t.text.trim() && !texts.some((x) => x.t.seq === t.seq)) texts.push({ t, opId: p.opId });
      }
    }
  }
  const calls = segs.flatMap((seg) => seg.calls);
  if (texts.length === 0 || texts.some((x) => x.t.seq == null) || wakes.some((w) => w.seq == null) || calls.some((c) => c.startSeq == null)) return null;
  texts.sort((a, b) => a.t.seq! - b.t.seq!);
  wakes.sort((a, b) => a.seq! - b.seq!);
  const mk = (t: Text | null, opId: number | null): Request => ({ session, texts: t ? [t.text] : [], captured: t !== null, placement: "recorded", calls: [] as Call[], closing: null, replies: [] as Reply[], finishes: [] as Finish[], wakes: [] as Wake[], firstOp: opId, anchor: t?.at ?? null, anchorSeq: t?.seq ?? null }) as Request;
  const orphan = mk(null, null);
  const reqs = texts.map((x) => mk(x.t, x.opId));
  const ownerOf = new Map<Call, Request>();
  for (const c of orderCalls(calls)) {
    const at = (c.placeBy ?? c).startSeq!;
    let i = -1;
    while (i + 1 < texts.length && texts[i + 1]!.t.seq! < at) i++;
    let r = i < 0 ? orphan : reqs[i]!;
    // Work after a wake (and before the next request) belongs to the request that owns the woken agent.
    let j = -1;
    while (j + 1 < wakes.length && wakes[j + 1]!.seq! < at) j++;
    // Not for a helper's launch or work: those belong to the latest real request before the launching call, never to a notification.
    const helperWork = c.agentId !== null || isLauncherTool(c.tool) || c.tool === "SendMessage";
    if (!helperWork && j >= 0 && wakes[j]!.seq! > (i < 0 ? Number.NEGATIVE_INFINITY : texts[i]!.t.seq!)) r = ownerOf.get(wakes[j]!.launcher) ?? r;
    r.calls.push(c);
    r.firstOp = Math.min(r.firstOp ?? c.firstOp, c.firstOp);
    ownerOf.set(c, r);
  }
  for (const w of wakes) {
    // The request that owns the launcher call owns the wake; failing that, the one in force when the wake came.
    let i = -1;
    while (i + 1 < texts.length && texts[i + 1]!.t.seq! < w.seq!) i++;
    (ownerOf.get(w.launcher) ?? (i < 0 ? orphan : reqs[i]!)).wakes.push(w);
  }
  for (const seg of segs) {
    const last = seg.prompts.flatMap((p) => p.texts).filter((t) => t.text.trim() && !t.wakes).at(-1);
    const owner = last ? reqs[texts.findIndex((x) => x.t.seq === last.seq)] : ownerOf.get(seg.calls.at(-1) as Call);
    if (owner && seg.stop) keepReply(owner, seg.stop);
  }
  return orphan.calls.length > 0 || orphan.wakes.length > 0 ? [orphan, ...reqs] : reqs;
}

/** A turn's reply joins its request's replies (none is overwritten); `closing` stays the latest one. */
function keepReply(r: Request, stop: Extract<Event, { type: "stop" }>): void {
  r.closing = stop.closing;
  if (stop.closing !== null) r.replies.push({ closing: stop.closing, at: stop.at, host: stop.host });
}

function requestsOf(rec: { events: Event[] }): Request[] {
  const sessions = [...new Set(rec.events.map((e) => e.session))];
  const out: Request[] = [];
  for (const session of sessions) {
    const segs: Seg[] = [];
    let cur: Seg = { calls: [], prompts: [], stop: null, firstOp: null };
    for (const e of rec.events.filter((x) => x.session === session)) {
      cur.firstOp ??= e.opId;
      if (e.type === "call") cur.calls.push(e.call);
      else if (e.type === "prompt") cur.prompts.push(e);
      else if (e.type === "stop") {
        cur.stop = e;
        segs.push(cur);
        cur = { calls: [], prompts: [], stop: null, firstOp: null };
      }
    }
    if (cur.calls.length || cur.prompts.length) segs.push(cur);
    const placed = requestsBySeq(session, segs);
    if (placed) {
      out.push(...placed);
      continue;
    }
    const mine = (): Request[] => out.filter((r) => r.session === session);
    const ownerOfWake = (w: Wake): Request | undefined => mine().find((r) => r.calls.includes(w.launcher)) ?? mine().at(-1);
    for (const seg of segs) {
      const texts: Text[] = [];
      const turnWakes: Wake[] = [];
      for (const p of seg.prompts) {
        mergeTexts(texts, p.texts.filter((t) => t.text.trim() && !t.wakes));
        for (const t of p.texts) for (const w of t.wakes ?? []) if (!turnWakes.some((x) => x.seq === w.seq && x.toolUseId === w.toolUseId)) turnWakes.push(w);
      }
      const calls = orderCalls(seg.calls);
      // A turn a wake opened has no request of its own: its calls and its closing belong to the request that owns the woken agent.
      const woken = texts.length === 0 && turnWakes.length > 0 ? ownerOfWake(turnWakes[0]!) : undefined;
      if (woken) {
        woken.calls = orderCalls([...woken.calls, ...calls]);
        woken.wakes.push(...turnWakes);
        if (seg.stop) keepReply(woken, seg.stop);
        continue;
      }
      if (!calls.length && !texts.length) continue; // a chat-only Stop: no round, nothing to show
      const mk = (ts: Text[], cs: Call[], placement: "recorded" | "inferred"): Request =>
        ({ session, texts: ts.map((t) => t.text), captured: ts.length > 0, placement, calls: cs, closing: null, replies: [] as Reply[], finishes: [] as Finish[], wakes: [] as Wake[], firstOp: seg.firstOp, anchor: ts[0]?.at ?? null, anchorSeq: ts[0]?.seq ?? null }) as Request;
      const many = texts.length > 1;
      const bySeq = many && texts.every((t) => t.seq != null) && calls.every((c) => c.startSeq != null);
      const byAt = many && texts.every((t) => t.at != null);
      const byStep = many && texts.every((t) => t.step != null);
      let reqs: Request[];
      if (bySeq || byAt || byStep) {
        // Recorded order: each call goes to the last request submitted before it opened (or before its first step).
        const key = (call: Call): number | null => {
          const c = call.placeBy ?? call; // An agent's calls go where its launcher (else its first call) went
          return bySeq ? c.startSeq : byAt ? c.openedAt : c.stepIds.size ? Math.min(...c.stepIds) : null;
        };
        const submitted = (t: Text): number => (bySeq ? t.seq! : byAt ? t.at! : t.step!);
        const groups: Call[][] = texts.map(() => []);
        const groupOf = new Map<Call, number>();
        const laneGroup = new Map<string, number>();
        let i = 0;
        for (const c of calls) {
          // An agent's call goes to the group of its launcher (else of its lane's first placed call), whatever the pointer
          // has reached; the pointer moves for the other calls only.
          const lane = c.agentId === null ? null : `${c.session}\u0000${c.agentId}`;
          const fixed = c.placeBy !== undefined && groupOf.has(c.placeBy) ? groupOf.get(c.placeBy)! : lane !== null ? laneGroup.get(lane) : undefined;
          let g = fixed;
          if (g === undefined) {
            const k = key(c);
            if (k != null) while (i + 1 < texts.length && submitted(texts[i + 1]!) <= k) i++;
            g = i;
          }
          if (lane !== null && !laneGroup.has(lane)) laneGroup.set(lane, g);
          groupOf.set(c, g);
          groups[g]!.push(c);
        }
        reqs = texts.map((t, j) => mk([t], groups[j]!, "recorded"));
      } else {
        const anchored = texts.length === 1 && (texts[0]!.seq != null || texts[0]!.at != null || texts[0]!.step != null);
        reqs = [mk(texts, calls, anchored ? "recorded" : "inferred")];
      }
      if (seg.stop) keepReply(reqs.at(-1)!, seg.stop);
      out.push(...reqs);
      for (const w of turnWakes) ownerOfWake(w)?.wakes.push(w);
    }
  }
  // A helper's finish belongs to the request that owns the helper's calls; with none on record, to the latest request submitted
  // before it (by seq, else by time), else the session's last.
  for (const e of rec.events) {
    if (e.type !== "finish") continue;
    const mine = out.filter((r) => r.session === e.session);
    const own = mine.find((r) => r.calls.some((c) => c.agentId === e.agentId));
    const before = (key: (r: Request) => number | null, at: number | null): Request | undefined => (at === null ? undefined : mine.filter((r) => key(r) !== null && key(r)! <= at).at(-1));
    const owner = own ?? before((r) => r.anchorSeq, e.seq) ?? before((r) => r.anchor, e.at) ?? mine.at(-1);
    owner?.finishes.push({ session: e.session, seq: e.seq, at: e.at, agentId: e.agentId, agentType: e.agentType, text: e.text, host: e.host });
  }
  // A tracking stop goes to the latest request of its session submitted (or started) before it, else the session's last.
  for (const e of rec.events) {
    if (e.type !== "trackstop") continue;
    const mine = out.filter((r) => r.session === e.session);
    const started = (r: Request): number | null => r.anchor ?? r.calls[0]?.openedAt ?? null;
    const owner = (e.at === null ? undefined : mine.filter((r) => started(r) !== null && started(r)! <= e.at!).at(-1)) ?? mine.at(-1);
    if (owner) (owner.trackingStops ??= []).push({ at: e.at });
  }
  const seqKey = (r: Request): number | null => r.anchorSeq ?? r.calls[0]?.startSeq ?? null;
  const first = (r: Request): number | null => (r.calls[0] ? timeOf(r.calls[0]) : r.anchor);
  if (out.length > 0 && out.every((r) => seqKey(r) != null)) out.sort((a, b) => seqKey(a)! - seqKey(b)! || a.firstOp! - b.firstOp!);
  else {
    const timed = out.every((r) => first(r) != null);
    out.sort((a, b) => (timed ? first(a)! - first(b)! : 0) || a.firstOp! - b.firstOp!);
  }
  out.forEach((r, i) => {
    r.index = i;
    r.id = "r" + String(i + 1).padStart(3, "0");
  });
  return out;
}

// ---- runs ----

export function buildRuns(ops: RawOp[], fileStates: RawState[]): RunsResult {
  const rec = readRecord(ops, fileStates);
  const requests = requestsOf(rec);
  const changes = rec.states.filter((s) => s.change);
  // What each call observed: the changes credited to it, plus (unless it runs in the background) those found while it was open.
  const observed = new Map<string, State[]>();
  // A change credited to another session's call is that session's: runs never mix sessions, so it is not observed here.
  const sessionOf = (id: string): string | null | undefined => rec.calls.get(id)?.session;
  const mine = (s: State, c: Call): boolean => !s.credited.length || s.credited.some((id) => sessionOf(id) === c.session);
  for (const c of rec.calls.values()) observed.set(c.id, changes.filter((s) => s.credited.includes(c.id) || (!c.background && s.open.includes(c.id) && mine(s, c))));
  const targetOf = (c: Call): Set<string> => new Set([...c.named, ...observed.get(c.id)!.map((s) => s.file_path)]);
  const failsReported = (session: string | null): boolean => [...rec.calls.values()].some((c) => c.session === session && ((c.closedBy === "failure" && !c.errorInferred) || reportsFailureEvents(c.host)));

  const runs: Run[] = [];
  for (const r of requests) {
    r.runs = [];
    r.calls.forEach((c, k) => {
      c.index = k + 1;
      c.target = targetOf(c);
    });
    // One lane per agent id plus the main line; a run never mixes lanes. With no agent id in the record this is one pass.
    const lanes = new Map<string | null, Call[]>();
    for (const c of r.calls) lanes.set(c.agentId, [...(lanes.get(c.agentId) ?? []), c]);
    const made: Run[] = [];
    for (const laneCalls of lanes.values()) {
      let run: Run | null = null;
      let pending: Call[] = [];
      const close = (): void => {
        if (run) made.push(run);
        run = null;
      };
      const open = (first: Call): void => {
        run = { request: r, session: r.session, calls: [...pending, first], target: new Set(), endsInChange: false } as Run;
        pending = [];
      };
      for (const c of laneCalls) {
        if (!c.target!.size) {
          if (run) (run as Run).calls.push(c);
          else pending.push(c);
          continue;
        }
        if (run && ![...c.target!].some((f) => (run as Run).target.has(f))) close();
        if (run) (run as Run).calls.push(c);
        else open(c);
        const cur = run as unknown as Run;
        for (const f of c.target!) cur.target.add(f);
        if (observed.get(c.id)!.some((s) => cur.target.has(s.file_path))) {
          cur.endsInChange = true;
          close();
        }
      }
      close();
      if (pending.length) {
        run = { request: r, session: r.session, calls: pending, target: new Set(), endsInChange: false } as Run;
        pending = [];
        close();
      }
    }
    made.sort((x, y) => x.calls[0]!.index! - y.calls[0]!.index!);
    for (const run of made) {
      r.runs.push(run);
      runs.push(run);
    }
  }

  // Changes per run, and the phase, which looks at the session's earlier and later runs.
  for (const run of runs) {
    run.changes = [];
    for (const c of run.calls) for (const s of observed.get(c.id)!) if (!run.changes.some((x) => x.state === s)) run.changes.push({ state: s, call: c });
    run.changed = new Set(run.changes.map((x) => x.state.file_path));
  }
  runs.forEach((run, i) => {
    const same = runs.filter((x) => x.session === run.session);
    const at = same.indexOf(run);
    const before = same.slice(0, at);
    const after = same.slice(at + 1);
    const hits = (xs: Run[]): boolean => xs.some((x) => [...run.target].some((f) => x.changed.has(f)));
    const onTarget = (c: Call): Set<string> => (c.target!.size ? c.target! : run.target);
    const retried = run.calls.some((c, j) => c.closedBy === "failure" && run.calls.slice(j + 1).some((d) => d.target!.size && [...onTarget(c)].some((f) => d.target!.has(f))));
    run.phase = run.endsInChange || run.changed.size ? "changing" : retried ? "failed and retrying" : hits(after) ? "trying" : hits(before) ? "checking" : "looking";
    run.index = run.request.runs.indexOf(run);
    run.id = "u" + String(i + 1).padStart(3, "0");
    run.failuresReported = failsReported(run.session);
  });

  const sessions = [...new Set(requests.map((r) => r.session))];
  for (const r of requests) r.reading = readingOfRequest(r, requests, sessions);
  for (const run of runs) run.reading = readingOfRun(run, requests);
  return { requests, runs, calls: rec.calls, states: rec.states, observed, sessions };
}

// ---- CoCheck's reading, in words ----

const sessionTag = (s: string | null): string => (s == null ? "unknown session" : `session …${String(s).slice(-6)}`);

function readingOfRequest(r: Request, requests: Request[], sessions: Array<string | null>): RequestReading {
  return {
    position: `request ${r.index + 1} of ${requests.length}`,
    session: sessions.length > 1 ? sessionTag(r.session) : null,
    placement: r.placement === "recorded" ? "placed by its recorded submit order" : "placed before its first run (inferred: the record carries no submit order)",
    texts: r.texts.length > 1 && r.placement === "inferred" ? `${r.texts.length} requests sent in one turn; the record does not say which calls answer which, so they are shown together` : null,
  };
}

function readingOfRun(run: Run, requests: Request[]): Reading {
  const r = run.request;
  const N = r.calls.length;
  const k0 = run.calls[0]!.index!;
  const k1 = run.calls.at(-1)!.index!;
  const position = `request ${r.index + 1} of ${requests.length}, run ${run.index + 1} of ${r.runs.length}, ${k0 === k1 ? `call ${k0}` : `calls ${k0}–${k1}`} of ${N}`;
  const onTarget = run.calls.filter((c) => c.target!.size);
  const lookups = run.calls.length - onTarget.length;
  const named = [...new Set(run.calls.flatMap((c) => [...c.named]))].map(baseName);
  const tail = lookups ? ` and ${pl(lookups, "lookup")}` : "";
  let caption = named.length
    ? `worked on ${listOf([...new Set(named)])} across ${pl(onTarget.length, "call")}${tail}`
    : `the agent didn't name what it was working on (${onTarget.length ? pl(onTarget.length, "call") + tail : pl(lookups, "lookup")})`;
  const firsts = new Map<string, number>(); // file -> first call index that observed its change
  for (const x of run.changes) {
    const f = x.state.file_path;
    if (!firsts.has(f) || x.call.index! < firsts.get(f)!) firsts.set(f, x.call.index!);
  }
  const byCall = new Map<number, string[]>();
  for (const [f, k] of firsts) {
    if (!byCall.has(k)) byCall.set(k, []);
    byCall.get(k)!.push(baseName(f));
  }
  for (const [k, fs] of [...byCall].sort((a, b) => a[0] - b[0])) caption += `; ${listOf(fs)} first changed at call ${k}`;
  if (!firsts.size) caption += "; no file changed";
  const failed = onTarget.filter((c) => c.closedBy === "failure").length;
  const attempts = !onTarget.length
    ? "no call on a target"
    : run.failuresReported
      ? `${pl(onTarget.length, "call")} on the target, ${failed} failed`
      : `${pl(onTarget.length, "call")} on the target; this host doesn't report failures`;
  return { position, phase: run.phase, caption: caption[0]!.toUpperCase() + caption.slice(1), attempts, lookups, failed: run.failuresReported ? failed : null };
}

// The agent's own words recorded within a run, in call order, and each call's fallback label.
export function wordsOfRun(run: Run): Array<{ call: number; text: string }> {
  const out: Array<{ call: number; text: string }> = [];
  for (const c of run.calls) {
    const t = c.narration?.source === "agent" ? words(c.narration.text) : "";
    if (t && WORDY.test(t) && out.at(-1)?.text !== t) out.push({ call: c.index!, text: t });
  }
  return out;
}
export const labelOf = (c: Call): string => c.description || c.command || c.tool || "call";
