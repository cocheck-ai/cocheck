import { pathKit } from "../../paths.ts";
import { defaultProfile } from "../../hosts/index.ts";
import { isSecretPath, secretLine } from "../../secret-files.ts";
import { HELPER_LANE, MAIN_LANE, OUTSIDE_LANE_ACTOR, UNSURE_LANE, UNSURE_LANE_ACTOR, byOf, hostName, laneKeyOf, laneOf, railActor, sideText, speakAs, type By } from "../attribution.ts";
import { SAME_CONTENT_AS, moreText, type RowCard } from "../notes.ts";
import type { Change, Timeline, TimelineCall, TimelineRequest, TimelineWake } from "../timeline.ts";
import { NOTICE_LABEL } from "../timeline.ts";
import { isLauncherTool, isReadOnlyMcpTool } from "../../credit-guard.ts";
import { callFailed, callFailedAndUnopenable, callFailedShared, couldNotOpen } from "../broken.ts";
import { attachFailureLines, type Failure, type FailureInput } from "./failure-line.ts";
import { baseOf, dirName, isOutside, treeRows, type TreeRow } from "./files-model.ts";

/**
 * The model of the g-rail review page: the timeline body in, the railroad and the moments out. Pure; the page script only draws it.
 *
 * Guarded here, not in the script: a secret file's moment carries its name line and nothing else (no view URL, no
 * label from inside the file, no tree), and every moment's view URL is built from that moment's own change key, so no moment can point
 * at another moment's picture.
 */

/**
 * "you", the main lane (`MAIN_LANE`), the outside lane and, when a change sits on it, the neutral lane (`attribution.ts`), or
 * a subagent's lane (`HELPER_LANE` and a number), numbered from 1 in the order the helpers first appear.
 */
export type ActorId = string;

export interface RailActor {
  id: ActorId;
  name: string;
  chip: string;
  color: string;
  main?: true;
  fromStart?: true;
  /** A helper's lane: the lane it branches off and merges back into, the stop ids where it does, and its agent type as the host named it. */
  parent?: ActorId;
  startId?: string | null;
  mergeId?: string | null;
  type?: string | null;
  /** On a resumed helper's later line, the id of the helper's first line; the legend lists the two as one helper. Absent otherwise. */
  group?: ActorId;
}

/** Lane colours for helpers, taken in turn; none of them is a colour the three fixed lanes use. */
const HELPER_COLORS = ["#e0a458", "#58b09c", "#d9777f", "#8aa6e0", "#b5c75b"];

/** The fixed lanes. The main lane's name and chip are the task's host; "Claude" here is only the default. */
export const ACTORS: readonly RailActor[] = [
  { id: "you", name: "You", chip: "Y", color: "#1c2740", fromStart: true },
  { id: MAIN_LANE, name: defaultProfile().displayName, chip: defaultProfile().chip, color: "#6fb0e3", main: true, fromStart: true },
  { ...OUTSIDE_LANE_ACTOR },
];

export interface RailNewFile {
  name: string;
  /** Null when the file is outside the work folder: the body does not say which folder. */
  folder: string | null;
  outside: boolean;
}


export interface RailRowNote {
  location: string;
  text: string;
}

export interface RailChange {
  key: string;
  file: string;
  kind: Change["kind"];
  /** The note beside the box: the change's own `note` when it has one, else the generic label. */
  note: string;
  /** Null for a secret file: nothing is fetched for it. */
  /** Per-cell notes, for boxes whose cell matches a row's location. Empty for a secret file. */
  rowNotes: RailRowNote[];
  /** When the format layer's list was capped, one sentence on how many changes have no note and where they are; null otherwise. */
  moreNote: string | null;
  /**
   * Always absent: no row carries a card, so the model no longer builds `cards`, `moreCards` or `extraCards`.
   * They stay typed only for view-v1's card words path, which review-server and about 15 page tests still feed, and a helper that is not to change.
   * They are to be removed together with that path.
   */
  cards?: RowCard[];
  moreCards?: number;
  extraCards?: RowCard[];
  /** A change too big to read cell by cell (`REWRITE_AT` places or more): the page draws one card, `note`, and no cell notes. */
  rewrite?: true;
  viewUrl: string | null;
  secret: boolean;
  /** The one sentence a secret file's moment shows. */
  secretLine: string | null;
  /** Plain words when every call credited with this change failed (error or non-zero exit in the hook record); null otherwise, and when the host does not report failures. */
  failed: string | null;
  /** The credit is not proven; the page shows the one word "Inferred" beside it. */
  inferred?: true;
  /** What the person asked for in the request this moment sits under. */
  ask: string | null;
  newFile: RailNewFile | null;
  treeBefore: TreeRow[] | null;
  treeAfter: TreeRow[] | null;
  /** One plain sentence the page shows at the top of the step: a deletion, with its path. Absent otherwise. */
  fact?: string;
}

/** The one line for a tracking stop made by a command in the session. */
export const TRACKING_STOPPED = "Tracking was stopped by a command in the session";

export interface RailStop {
  id: string;
  label: string;
  lane: ActorId | null;
  head: string;
  /** What the page's heading reads after the actor chip: a plain verb and a file name, no actor. Absent: the page shows `head`. */
  title?: string;
  /** A move or rename: the gone and the new record of one step shown as one. `from` and `to` are the paths; the stop's change is the new file's. Absent otherwise. */
  moved?: { from: string; to: string; kind: "moved" | "renamed"; /** The id of the gone record's stop, which no longer has a stop: verdict rows, history and sign-offs stored on it are carried onto this one (`carryMoved`). */ fromStop: string };
  /** The full path, shown on hover over the heading's file name. */
  path?: string;
  /** On a change step whose bare file name another step shares: the end of `label` (the distinguishing folders and the name) that the rail row keeps visible when it trims. Absent otherwise. */
  tail?: string;
  sub?: string;
  /** A change the page shows quietly (a muted row, diff still viewable): an outside change CoCheck guesses is the host app's own save, or a re-save its connector vouches changed nothing. Absent otherwise. */
  muted?: true;
  /**
   * a re-save the claiming connector vouches changed nothing, credited to no single call. It has no lane (`lane` is null), the
   * rail draws no row for it and no lane counts it; the Files view lists it as a muted version, on `lane`'s chip. Absent otherwise.
   */
  history?: { lane: ActorId };
  card?: { title: string; lines: Array<{ kind: "q" | "plain"; text: string }> };
  /** A request stop. The page shows this text, verbatim, as the stop's whole main area (no panes, no side card). */
  request?: { text: string; /** The words are not in the record; `text` says so. */ missing?: true };
  change?: RailChange;
  /** On a change stop that sits next to others from the same call, the call; the page draws one header over the run. Absent on a lone change.
   *  `failed` when a failure rides on the run: it is carried once, by the run's first change, not by each file. */
  call?: { id: string; text: string; failed?: true };
  /** On a change stop, every call credited with the change that is on record, in credit order: its id (the command route's key) and the same label a quiet call carries. No command text, ever: the page asks the command route for that on an explicit expand. Absent when no credited call is on record. */
  calls?: Array<{ id: string; text: string; noCommand?: true }>;
  /** The calls after this stop and before the next that changed no watched file, in record order. Not stops: the page draws one collapsed line, closed by default, and each id opens that call's command route. Absent when there are none.
   *  Each call names its lane; the page draws one quiet row per run of one actor's calls. */
  quiet?: { count: number; calls: QuietCall[] };
  /** The time (ms) the rail places the stop at, the key it sorts by; absent when nothing before it carries a time. The review's markers sit by it. */
  at?: number;
  /** On a failure group (a run of failed calls by one actor with no other step between them), each call: what it tried and the last line of its error. Absent on every other stop. */
  runs?: Array<{ id: string; text: string; error: string; output?: string }>;
  /** On a message or a helper's finish, who sent it, to whom, and its words, for the page's message card. Absent on every other stop.
   *  `helper` is set on a finish: the lane whose changed files the page lists under the report. */
  message?: { from: ActorId; to: ActorId | null; toName: string | null; lines: string[]; helper?: ActorId };
  /** An MCP write no installed connector handles: "logged, not diffed". The server, the tool's own name and the input field names the record holds; never a value (the call's input and response are kept sealed in the task's store, not on the stop; showing them is phase 3). The page draws an outbound paper-plane mark and a card from it. Absent on every other stop. */
  mcpWrite?: { server: string; tool: string; fields: string[] };
  /** on an MCP write stop, the call whose kept values the card route reads (`/review/mcp/<id>`), and `failed` when the host recorded the call as failed. Absent on every other stop. */
  mcpCall?: { id: string; failed?: true };
  /** a gap row. CoCheck knows what the call touched (a connector covers it) and could not capture what changed; `reason` is a plain sentence. Never shown for an unchanged or an unmatched call. Absent on every other stop. */
  gap?: { reason: string; /** Who and what: "<actor>: <tool> on <server>", for the row's second line. */ what: string };
  /** On a helper's start step, the brief the main agent gave it, as plain lines, and who said it (the host's name). No lines means no brief was recorded. Absent on every other stop. */
  brief?: { by: string; lines: string[]; withheld?: boolean; encrypted?: boolean };
  /** On a step whose text was withheld as secret-looking, the fields the person's own page can bring back from the host's transcript, by call id. Absent otherwise. */
  reveal?: Array<{ call: string; field: string }>;
  /** On a failed call's moment, the text to show (the first meaningful line of the host's words) and the host's own words. Absent on every other stop. */
  failure?: Failure;
}

/** One change to a file, as the Files view lists it. */
export interface RailFileVersion {
  /** The change's id (`RailChange.key`) and the id of its step, so the page opens the existing per-change view. */
  change: string;
  stop: string;
  /** The file's bytes after this change; empty for a secret file, whose hash is not shown. */
  sha: string;
  /** Whose version it is: the lane and the lane's chip. */
  lane: ActorId;
  chip: string;
  /** The time (ms) the rail places the change at; null when the record has none. */
  at: number | null;
  label: string;
  kind: Change["kind"];
  /** The maker's credit is not proven; the Files view shows the one word "Inferred" beside the maker. */
  inferred?: true;
  /** CoCheck holds this version's bytes (for a deleted file, the bytes it had before). Always true for a secret file: nothing is shown for it. */
  kept: boolean;
  /** a re-save its connector vouches changed nothing; the Files view draws it quietly. Absent otherwise. */
  muted?: true;
  secret?: true;
  /**
   * The versions of other files the producing call(s) read, each pinned to that file's latest version at or before the call opened. `file` indexes
   * `RailModel.files`; `p` is the version's position on the strip (1 = v1, 0 = Before task: the file as the task found it). `why` says how the call came to hold it: named in the script it ran, or opened in the same call. A file only looked at (a Read tool call) is in `looked`, never here.
   * Absent when none. A file the task did not change is listed only as a source (`RailFile.source`, `p` 0); it is never given versions.
   */
  inputs?: Array<{ file: number; p: number; why: "script" | "call" }>;
  /** Files the agent opened with the Read tool before this change: shown quietly, never an input and never behind a stale warning. */
  looked?: Array<{ file: number; p: number }>;
  /**
   * The inputs that changed after this version read them: `file`/`p` as in `inputs`, `newer` the position of the first later version with other bytes,
   * `newerLane`/`newerChip` its actor. Only the version that read the input carries it. A later version with the same bytes as the one read is no change.
   */
  stale?: Array<{ file: number; p: number; newer: number; newerLane: ActorId; newerChip: string }>;
  /**
   * CoCheck could not tell everything the script(s) that made this version read: a script's text is missing, or it opens a file by a path the text does not state.
   * On any version that has it; only the file's latest version counts it in the list. Absent otherwise.
   */
  unknownReads?: true;
}

/** A file the task changed, with its versions in time order. */
export interface RailFile {
  file: string;
  name: string;
  /** Enough of the folder to tell this file from another with the same name (the last folders of its path); absent when the name is alone. "top folder" for a file at the work folder's root. */
  where?: string;
  /** The file as the task found it: not there ("none", the task created it), held by CoCheck ("kept"), or there but its bytes were not kept ("lost"). A secret file is "kept": nothing is shown for it. */
  start: "none" | "kept" | "lost";
  versions: RailFileVersion[];
  /**
   * A file outside the work folder that nothing the person typed asked for (`askedOutside`): scratch. It stays in this list, after the changed files, so every index holds;
   * the page keeps it out of the main list and the folder trees, in a collapsed "Outside the folder" group, and it never carries a stale warning. An outside file the request names has no flag.
   */
  outside?: true;
  /** Set on every entry whose file is outside the work folder (flagged scratch or asked for): the entry's own address, so it never shares a key or a `#v=files&f=` hash with an in-folder file of the same name. Absent on in-folder files. */
  ref?: string;
  /**
   * A build or scratch file: it sits under a dot-folder (.deck_build/, .tmp_x/) in which every listed file was created during the task, and nothing the person typed names it.
   * It stays in this list (every index holds); the page shows it in a closed "Working files" group and the order ranks it below real files. Absent otherwise.
   */
  working?: true;
  /** This file's final bytes (not empty) equal a real (non-working) file's: "same bytes as <name> (<folder label>)". Nothing is merged: both stay listed. Absent otherwise. */
  sameAs?: string;
  /** A connector's subject (a Notion page, not a file): `name` is the whole subject. The page draws no file icon, no preview and no open-in-app action for it. Absent on every file. */
  connector?: { id: string; subject: string };
  /** A file the task read and never changed, listed below the changed files as a read-only entry: no versions, only "the file as the task found it" (its bytes are not kept). */
  source?: true;
}

export interface RailModel {
  task: number;
  folder: string | null;
  actors: RailActor[];
  stops: RailStop[];
  /** Every file the task changed, by last change (newest first), each with its versions in time order. Derived from the steps, so the Files view and the Steps view never disagree. */
  files: RailFile[];
  /** The calls before the first stop that changed no watched file. There is no start stop to ride on, so they sit at the origin marker. Absent when there are none. */
  quiet?: { count: number; calls: QuietCall[] };
}

/** A call that changed no watched file. `lane` is whose call it was (the main lane when the agent has no lane of its own). */
export interface QuietCall {
  id: string;
  text: string;
  /** The call ran no command: the page offers no "Show command" for it. */
  noCommand?: true;
  lane: ActorId;
}

interface Placed {
  change: Change;
  lane: ActorId;
  ask: string | null;
  /** Who made it (`change.by`), the one input to its lane and its words. */
  by: By;
  /** The lanes of its calls on record, in credit order, without repeats: what the neutral lane names. */
  keys: Array<{ key: string; type: string | null }>;
  /** The subagent that made the call, keyed by session and agent id so two sessions' agents never share a lane. Set only when every credited call is that agent's. */
  agent?: { key: string; type: string | null };
  /** Every call credited with the change ended in failure. */
  failed: boolean;
  /** The host's error text of the first failed credited call that has one. */
  error?: string | null;
  /** Some credited calls failed and others did not (or ended unknown): the lane keys of the failed ones, in credit order. Empty when none failed or all did. */
  sharedFailed: Array<{ key: string; type: string | null }>;
}

const VERB: Record<Change["kind"], string> = { created: "created", modified: "changed", deleted: "deleted" };
/** the side text of a re-save the claiming connector vouches changed nothing. */
export const SAVED_AGAIN_NOTHING_CHANGED = "saved again, nothing changed";
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** The note: {text, source: "rule"}. Absent falls back to the generic label. */
const textOf = (note: unknown): string | null => {
  if (typeof note === "string") return note.trim() === "" ? null : note.trim();
  const text = (note as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
};

// A pending preview's label only says the picture is still being drawn; the page shows its loading widget for that, so it is no note
// (the model is not rebuilt when the picture finishes, so the words would outlive the wait).
const noteOf = (change: Change): string => textOf((change as unknown as { note?: unknown }).note) ?? (change.generic?.pending === true ? "" : change.generic?.label) ?? "No label was recorded for this change.";

/** One tethered note per format row that has its own note. The page matches a row to a View box by the cell part of `location`. */
const rowNotesOf = (change: Change, speak: (text: string) => string = (t) => t): RailRowNote[] =>
  (change.format?.rows ?? []).flatMap((row) => {
    const text = textOf((row as unknown as { note?: unknown }).note);
    return text === null ? [] : [{ location: row.location, text: speak(text) }];
  });

/** A change shows as failed only when it has credited calls and every one of them is recorded as failed; a call that succeeded, or whose end is unknown, is never called failed. */
const failedChange = (by: By, outcomeOf: ReadonlyMap<string, string>): boolean =>
  by.calls.length > 0 && by.calls.every((id) => outcomeOf.get(id) === "failed");

/** A failed call that changed no file, which gets a moment of its own so a failure is never silent. */
interface FailedCall {
  call: TimelineCall;
  ask: string | null;
  agent?: { key: string; type: string | null };
}

/**
 * The one place a change gets its time on the rail. A change sits at the time it was observed (`change.at`), never at the start of
 * a call that spans other observations (a call left open across later steps would pull every one of its changes to its own start). A record
 * with no time for the change falls back to the call's start. A change never sorts before the start of the call that made it, so a time
 * earlier than that start is lifted to it. Joint and single-call changes follow the same rule.
 */
export const observedAt = (change: Pick<Change, "at">, callStart: number | null | undefined): number | null => {
  const start = callStart ?? null;
  if (change.at == null) return start;
  return start == null ? change.at : Math.max(change.at, start);
};

/**
 * Within one call, changes found at the same moment read in the order their files were written: by the modification time the
 * sweep captured, the file name only as a tiebreak. A group with any change that has no time (a record without one, a deleted file) keeps the
 * record's order, and so do changes found at different moments.
 */
export function inWriteOrder<T extends Pick<Change, "at" | "file" | "mtimeNs">>(changes: readonly T[], callStart: number | null | undefined): T[] {
  const out: T[] = [];
  for (let i = 0; i < changes.length; ) {
    const at = observedAt(changes[i]!, callStart);
    let j = i + 1;
    while (j < changes.length && observedAt(changes[j]!, callStart) === at) j++;
    const group = changes.slice(i, j);
    if (group.length > 1 && group.every((c) => c.mtimeNs !== undefined)) {
      group.sort((a, b) => {
        const x = BigInt(a.mtimeNs!), y = BigInt(b.mtimeNs!);
        return x < y ? -1 : x > y ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
      });
    }
    out.push(...group);
    i = j;
  }
  return out;
}

/** A message card is plain words; the model's markdown (headings, bold, bullets, links, code ticks) is dropped, its text kept. */
export function plain(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^(\s*)[-*+]\s+/, "$1- ")
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?=[^\w]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trimEnd();
}

/**
 * a message's lines as plain text. Fence markers are dropped and the code between them kept as it is (no inline syntax is read inside
 * code); a table's separator row is dropped and each other row reads as its cells joined by " · "; every other line goes through `plain`.
 */
export function plainLines(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of lines) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence === null && mark) { fence = mark[1]![0]!; continue; }
    if (fence !== null) {
      if (mark && mark[1]![0] === fence && /^\s*(`{3,}|~{3,})\s*$/.test(raw)) fence = null;
      else if (raw.trim() !== "") out.push(raw.trimEnd());
      continue;
    }
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw) && raw.includes("|")) continue;
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      const cells = raw.trim().slice(1, -1).split("|").map((c) => plain(c.trim())).filter((c) => c !== "");
      if (cells.length > 0) out.push(cells.join(" · "));
      continue;
    }
    const line = plain(raw);
    if (line.trim() !== "") out.push(line);
  }
  return out;
}

/** A raw agent id (a long run of letters and digits with at least one digit), which is never shown as a name. */
const looksLikeId = (s: string | null): boolean => s !== null && /^[a-z0-9]{12,}$/i.test(s) && /\d/.test(s);

/** What a request stop shows when the record holds no words for it. */
const NO_REQUEST_TEXT = "The words of this request were not recorded.";

/** Counts calls of `buildRailModel` in this process; a test reads it to show an unchanged poll builds nothing. */
export const railBuildStats = { builds: 0 };

export interface RailOptions {
  /** Whether an installed connector handles this MCP call (`connector/installed-match.ts`). Absent: none does, so every MCP write gets its stop (the safe direction). */
  connectorFor?: (server: string, tool: string) => boolean;
}

export function buildRailModel(timeline: Timeline, opts: RailOptions = {}): RailModel {
  railBuildStats.builds++;
  const failures = new Map<string, FailureInput>();
  // No start stop. The page opens on the first step that needs a verdict; the origin is a marker on the rail, not a stop.
  const stops: RailStop[] = [];
  let originQuiet: QuietCall[] = [];
  const seen = new Set<string>();
  const callOf = new Map<string, { id: string; text: string }>();
  // Everything that happened, in the order the timeline holds it, each with the time the record gives it. An item without a time takes
  // the time of the item before it, so a stable sort by time never moves it away from its neighbours.
  type Entry = { at: number | null; request: TimelineRequest } | { at: number | null; placed: Placed } | { at: number | null; wake: { w: TimelineWake; session: string | null; lane?: RailActor; key?: string; type?: string | null; said?: string | null } } | { at: number | null; send: { call: TimelineCall; session: string | null; key: string; type: string | null; lane?: ActorId } } | { at: number | null; launch: string; req: string | null; bg: boolean } | { at: number | null; reply: { text: string; id: string } } | { at: number | null; trackstop: { id: string } } | { at: number | null; start: { call: TimelineCall; session: string | null; key: string; type: string | null; launch: string; lane?: ActorId } } | { at: number | null; failure: FailedCall } | { at: number | null; quiet: { id: string; text: string; key: string; noCommand?: true } } | { at: number | null; mcpWrite: { call: TimelineCall; session: string | null; key: string; type: string | null; mcp: NonNullable<TimelineCall["mcp"]>; lane?: ActorId } } | { at: number | null; gap: { call: TimelineCall; session: string | null; key: string; type: string | null; reason: string; lane?: ActorId } };
  const entries: Entry[] = [];
  const outcomeOf = new Map<string, string>();
  const errorOf = new Map<string, string | null>();
  const labelOf = new Map<string, string>();
  const noCommandIds = new Set<string>();
  for (const request of timeline.requests) for (const run of request.runs) for (const call of run.calls) {
    outcomeOf.set(call.id, call.outcome);
    errorOf.set(call.id, call.error);
    labelOf.set(call.id, call.line?.text || call.tool || "A call");
    if (call.noCommand) noCommandIds.add(call.id);
  }
  // What the lanes need from every call: the agent it belongs to, the call that launched that agent, and the agent's type.
  const agentOfCall = new Map<string, string>();
  const launcherOfAgent = new Map<string, string>();
  const typeOfAgent = new Map<string, string | null>();
  const sendIds = new Set<string>();
  // Each agent's lane segments by the time their first call started, so a finish lands on the segment the agent was last working in.
  const segsOf = new Map<string, Array<{ start: number; key: string }>>();
  const sk = (session: string | null | undefined, id: string): string => `${session ?? ""}\u0000${id}`;
  // An agent resumed by a SendMessage draws the resumed work as a line of its own, forked from the SendMessage: its key is the agent's plus the SendMessage's.
  const RESUME = "\u0000resume:";
  const segKey = (session: string | null | undefined, agentId: string, resumedBy: string | undefined): string => (resumedBy === undefined ? sk(session, agentId) : sk(session, agentId) + RESUME + resumedBy);
  const baseKeyOf = (key: string): string => key.split(RESUME)[0]!;
  // The main lane is named for the task's host; a change's lanes come from the calls `change.by` names, never from where it is listed.
  const mainHost = timeline.host ?? (timeline.hosts?.length === 1 ? timeline.hosts[0]! : null);
  const laneOfCall = new Map<string, { key: string; type: string | null }>();
  for (const request of timeline.requests) for (const run of request.runs) for (const call of run.calls) {
    laneOfCall.set(call.id, { key: call.agent ? segKey(request.session, call.agent.id, call.resumedBy) : laneKeyOf(request.session, undefined), type: call.agent?.type ?? null });
  }
  const keysOf = (by: By, fallback: { key: string; type: string | null } | null): Placed["keys"] => {
    const found = by.calls.map((id) => laneOfCall.get(id)).filter((k): k is Placed["keys"][number] => k !== undefined);
    const all = found.length === 0 && by.kind === "call" && fallback !== null ? [fallback] : found;
    return all.filter((k, i) => all.findIndex((x) => x.key === k.key) === i);
  };
  const place = (change: Change, ask: string | null, host: string | null, fallback: { key: string; type: string | null } | null): Placed => {
    const by = byOf(change, host);
    const keys = keysOf(by, fallback);
    // Failed only when every credited call on record failed. The host's error text of the first failed one that has one.
    const failed = failedChange(by, outcomeOf);
    // A change shared with calls that did not fail still carries the failure of the ones that did, naming them.
    const failedIds = failed ? [] : by.calls.filter((id) => outcomeOf.get(id) === "failed");
    const sharedFailed = failedIds.map((id) => laneOfCall.get(id)).filter((k): k is Placed["keys"][number] => k !== undefined).filter((k, i, all) => all.findIndex((x) => x.key === k.key) === i);
    const errorIds = failed ? by.calls : failedIds;
    const error = errorIds.length > 0 ? (errorIds.map((id) => errorOf.get(id) ?? null).find((e) => e !== null) ?? null) : null;
    const own = by.kind === "call" && keys.length === 1 && keys[0]!.key !== MAIN_LANE ? keys[0]! : undefined;
    return { change, lane: laneOf(by, MAIN_LANE), ask, by, keys, failed, error, sharedFailed, ...(own ? { agent: own } : {}) };
  };
  for (const request of timeline.requests) {
    const ask = request.texts[0]?.text ?? null;
    entries.push({ at: request.at ?? null, request });
    for (const run of request.runs) {
      for (const call of run.calls) {
        // A launch is a point on the spawner's line (no stop of its own): a lane it starts leaves the line from there.
        // Foreground launches count too, and a launch made by Claude (no agent on the call) names the request that owns it.
        // So is a SendMessage, which starts the resumed line of the agent it wakes.
        if (call.tool === "SendMessage") sendIds.add(sk(request.session, call.id));
        if ((isLauncherTool(call.tool) || call.tool === "SendMessage") && call.start != null) entries.push({ at: call.start, launch: sk(request.session, call.id), req: call.agent ? null : request.id, bg: call.tool === "SendMessage" || call.background === true });
        if (call.agent) {
          const key = segKey(request.session, call.agent.id, call.resumedBy);
          agentOfCall.set(sk(request.session, call.id), key);
          if (!typeOfAgent.has(key)) typeOfAgent.set(key, call.agent.type);
          if (call.start != null) segsOf.set(sk(request.session, call.agent.id), [...(segsOf.get(sk(request.session, call.agent.id)) ?? []), { start: call.start, key }]);
          const via = call.resumedBy ?? call.launchedBy;
          if (via && !launcherOfAgent.has(key)) launcherOfAgent.set(key, sk(request.session, via));
        }
        for (const change of inWriteOrder(call.changes, call.start)) {
          if (seen.has(change.id)) continue;
          seen.add(change.id);
          const placed = place(change, ask, call.host ?? mainHost, laneOfCall.get(call.id) ?? null);
          // A step links the call that made it only when that call alone is credited; a joint step ("can't tell which") links none,
          // never the one candidate it happens to be listed under (each "?" step then linked one helper's call for another helper's files).
          const single = placed.by.kind === "call" && placed.by.calls.length === 1 && placed.by.calls[0] === call.id;
          if (call.line?.text && single) callOf.set(change.id, { id: sk(request.session, call.id), text: call.line.text });
          entries.push({ at: observedAt(change, call.start), placed });
        }
        // A message with words is a moment of its own, on the sender's lane; one the record holds no words for stays a quiet call.
        const said = call.send !== undefined && (call.send.text !== null || call.send.summary !== null || call.send.withheld === true);
        if (said && call.outcome !== "failed" && call.changes.length === 0) {
          const lane = laneOfCall.get(call.id)!;
          entries.push({ at: call.start ?? null, send: { call, session: request.session, key: lane.key, type: lane.type } });
        } else if (isLauncherTool(call.tool) && call.outcome !== "failed" && call.changes.length === 0 && call.start != null) {
          // Starting a helper is a step on the spawner's lane, not a quiet call.
          const lane = laneOfCall.get(call.id)!;
          entries.push({ at: call.start, start: { call, session: request.session, key: lane.key, type: lane.type, launch: sk(request.session, call.id) } });
        } else if (call.mcp !== undefined && !isReadOnlyMcpTool(call.tool ?? "") && !(opts.connectorFor?.(call.mcp.server, call.mcp.tool) ?? false)) {
          // a failed write is this stop too, drawn "Attempted, failed: <reason>" (the reason is on the card).
          // A connector call that is not read-only (an unknown shape is a write, credit-guard's one predicate) and that no installed connector handles: a stop of its own, never a file change, whether or not credit-guard credited it a file change (a file stop may still name the call).
          const lane = laneOfCall.get(call.id)!;
          entries.push({ at: call.start ?? null, mcpWrite: { call, session: request.session, key: lane.key, type: lane.type, mcp: call.mcp } });
        } else if (call.outcome !== "failed" && call.changes.length === 0) entries.push({ at: call.start ?? null, quiet: { id: call.id, text: call.line?.text || call.tool || "A call", key: laneOfCall.get(call.id)!.key, ...(call.noCommand ? { noCommand: true as const } : {}) } });
        if (call.captureGap !== undefined) {
          // a failed known-subject capture is a row of its own, beside whatever the call is otherwise drawn as.
          const lane = laneOfCall.get(call.id)!;
          entries.push({ at: call.start ?? null, gap: { call, session: request.session, key: lane.key, type: lane.type, reason: call.captureGap.reason } });
        }
        if (call.outcome === "failed" && call.changes.length === 0 && !(call.mcp !== undefined && !isReadOnlyMcpTool(call.tool ?? "") && !(opts.connectorFor?.(call.mcp.server, call.mcp.tool) ?? false))) {
          const agent = call.agent ? { key: sk(request.session, call.agent.id), type: call.agent.type } : undefined;
          entries.push({ at: call.end ?? call.start ?? null, failure: { call, ask, ...(agent ? { agent } : {}) } });
        }
      }
    }
    // Each turn's closing message is a step on Claude's lane, after that turn's calls (its time is the turn's stop).
    for (const x of request.replies ?? []) entries.push({ at: x.at ?? null, reply: { text: x.line.text, id: `${request.id}-${(request.replies ?? []).indexOf(x)}` } });
  }
  // A tracking stop is a mark of its own, at the time the command ran.
  for (const request of timeline.requests) (request.trackingStops ?? []).forEach((t, i) => entries.push({ at: t.at, trackstop: { id: `${request.id}-${i}` } }));
  // A wake is an entry of its own (never a request), at the time the notification came, after the request's calls so a tie keeps the order.
  for (const request of timeline.requests) for (const w of request.wakes ?? []) entries.push({ at: w.at ?? null, wake: { w, session: request.session } });
  // A helper's finish is a wake that no notification announced. When a notification for the same agent follows, the finish's words
  // join that wake instead, so a plain helper still reads "Helper n finished" once.
  for (const request of timeline.requests) for (const f of request.finishes ?? []) {
    const said = f.text?.text ?? null;
    const wake = entries.find((e): e is Extract<Entry, { wake: unknown }> => "wake" in e && e.wake.session === request.session && e.wake.w.agentId === f.agentId && e.wake.said === undefined && (e.at === null || f.at === null || e.at >= f.at));
    if (wake) {
      wake.wake.said = said;
      continue;
    }
    const segs = (segsOf.get(sk(request.session, f.agentId)) ?? []).filter((x) => f.at === null || x.start <= f.at);
    const key = segs.length > 0 ? segs.reduce((a, b) => (b.start >= a.start ? b : a)).key : segKey(request.session, f.agentId, undefined);
    entries.push({ at: f.at ?? null, wake: { w: { launch: "", agentId: f.agentId, at: f.at, status: "completed", summary: null }, session: request.session, key, type: f.agentType, said } });
  }
  for (const change of timeline.unplaced) {
    if (seen.has(change.id)) continue;
    seen.add(change.id);
    entries.push({ at: change.at ?? null, placed: place(change, null, mainHost, null) });
  }
  let carried = Number.NEGATIVE_INFINITY;
  const keyed = entries.map((e, i) => {
    carried = e.at ?? carried;
    return { e, i, key: carried };
  });
  keyed.sort((x, y) => x.key - y.key || x.i - y.i);
  const ordered = keyed.map((k) => k.e);
  const timeOf = new Map(keyed.map((k) => [k.e, k.key]));
  const placed: Placed[] = ordered.flatMap((e) => ("placed" in e ? [e.placed] : []));
  // Each subagent that made a change gets a numbered lane, in the order it first appears. A change with no agent stays on Claude's line.
  // So does a woken background agent, even when it changed no file; a helper's spawner is the lane of the agent that launched it.
  const helpers = new Map<string, RailActor>();
  const launcherKeyOf = new Map<string, string>();
  const keyOfLane = new Map<ActorId, string>();
  const withChange = new Set<string>();
  // A helper credited with a change, alone or with others, is never called a helper that changed no file.
  for (const p of placed) for (const k of p.keys) if (k.key !== MAIN_LANE) withChange.add(k.key);
  const numberOf = new Map<string, number>();
  const laneFor = (key: string, type: string | null, launcher: string | undefined): RailActor => {
    let h = helpers.get(key);
    if (!h) {
      // A resumed line takes its agent's number, name and colour, so it reads as the same helper; its id is its own.
      const base = baseKeyOf(key);
      if (!numberOf.has(base)) numberOf.set(base, numberOf.size + 1);
      const n = numberOf.get(base)!;
      const again = base === key ? 0 : [...helpers.keys()].filter((k) => baseKeyOf(k) === base && k !== base).length + 1;
      h = { id: `${HELPER_LANE}${n}${again > 0 ? `r${again}` : ""}`, name: `Helper ${n}`, chip: String(n), color: HELPER_COLORS[(n - 1) % HELPER_COLORS.length]!, parent: MAIN_LANE, type, ...(again > 0 ? { group: `${HELPER_LANE}${n}` } : {}) };
      helpers.set(key, h);
      keyOfLane.set(h.id, key);
      const l = launcher ?? launcherOfAgent.get(key);
      if (l !== undefined) launcherKeyOf.set(h.id, l);
    }
    return h;
  };
  const failureLane = new Map<string, ActorId>();
  const walkLanes = (laneFor: (key: string, type: string | null, launcher: string | undefined) => RailActor): void => {
  for (const e of ordered) {
    if ("placed" in e && e.placed.agent) e.placed.lane = laneFor(e.placed.agent.key, e.placed.agent.type, undefined).id;
    // A change on the neutral lane names each helper it is credited to by its lane, so each gets its number in the same order.
    else if ("placed" in e) {
      for (const k of e.placed.keys) if (k.key !== MAIN_LANE) laneFor(k.key, k.type, undefined);
    } else if ("failure" in e && e.failure.agent) failureLane.set(e.failure.call.id, laneFor(e.failure.agent.key, e.failure.agent.type, undefined).id);
    else if ("wake" in e) {
      const { w, session } = e.wake;
      const key = e.wake.key ?? (w.agentId !== null ? segKey(session, w.agentId, sendIds.has(sk(session, w.launch)) ? w.launch : undefined) : sk(session, `launch:${w.launch}`));
      e.wake.lane = laneFor(key, typeOfAgent.get(key) ?? typeOfAgent.get(baseKeyOf(key)) ?? e.wake.type ?? null, w.launch === "" ? undefined : sk(session, w.launch));
    } else if ("send" in e) {
      const { key, type } = e.send;
      e.send.lane = key === MAIN_LANE ? MAIN_LANE : laneFor(key, type, undefined).id;
    } else if ("mcpWrite" in e) {
      const { key, type } = e.mcpWrite;
      e.mcpWrite.lane = key === MAIN_LANE ? MAIN_LANE : laneFor(key, type, undefined).id;
    } else if ("gap" in e) {
      const { key, type } = e.gap;
      e.gap.lane = key === MAIN_LANE ? MAIN_LANE : laneFor(key, type, undefined).id;
    }
  }
  };
  // "Helper n" is the nth helper launched. A dry walk finds the helpers that will get a lane; those are numbered by the order of the
  // calls that launched them (a resumed helper keeps its base agent's number), then any with no recorded launch call, in first-seen order.
  const seenBases: string[] = [];
  walkLanes((key) => {
    const base = baseKeyOf(key);
    if (!seenBases.includes(base)) seenBases.push(base);
    return { id: "", name: "", chip: "", color: "", parent: MAIN_LANE, type: null } as RailActor;
  });
  const launchedBases: string[] = [];
  for (const e of ordered) if ("start" in e) for (const [key, l] of launcherOfAgent) if (l === e.start.launch && key === baseKeyOf(key) && seenBases.includes(key) && !launchedBases.includes(key)) launchedBases.push(key);
  for (const b of [...launchedBases, ...seenBases.filter((b) => !launchedBases.includes(b))]) numberOf.set(b, numberOf.size + 1);
  walkLanes(laneFor);
  // A start step sits on its spawner's lane only when that helper has a lane for other reasons; a spawner with no lane falls back to
  // Claude, as it does for the launch itself (spawnerOf), so a start never gives a helper a lane of its own.
  for (const e of ordered) if ("start" in e) e.start.lane = e.start.key === MAIN_LANE ? MAIN_LANE : (helpers.get(e.start.key)?.id ?? MAIN_LANE);
  /** The lane of whoever made the launching call: that agent's lane, else (a parent with no lane) its own launcher's, up the chain to Claude. */
  const spawnerOf = (launcher: string | undefined, self: ActorId): ActorId => {
    let k = launcher;
    for (let depth = 0; k !== undefined && depth < 16; depth++) {
      const agentKey = agentOfCall.get(k);
      if (agentKey === undefined) return MAIN_LANE;
      const lane = helpers.get(agentKey);
      if (lane && lane.id !== self) return lane.id;
      k = launcherOfAgent.get(agentKey);
    }
    return MAIN_LANE;
  };
  for (const h of helpers.values()) h.parent = spawnerOf(launcherKeyOf.get(h.id), h.id);
  /** The names of a change's lanes, in credit order: the host's for the main lane (the call's own host, else the task's), "Helper n" for a helper's. */
  const namesOf = (p: Placed): string[] => [...new Set(p.keys.map((k) => (k.key === MAIN_LANE ? hostName(p.by.host) : helpers.get(k.key)!.name)))];
  const wakeStops = new Map<ActorId, string[]>();
  const laneName = (id: ActorId): string | null => (id === MAIN_LANE ? hostName(mainHost) : ([...helpers.values()].find((x) => x.id === id)?.name ?? null));
  // A helper that changed no file gets one step on its own lane, built when it starts (right after "Started Helper n") so its calls
  // follow it and it is timed at the launch. The heading cannot say "changed no file" yet: the helper has not finished. A helper with no
  // start step (resumed, or no call of the launch recorded) still gets it, at its wake.
  const idled = new Set<ActorId>();
  const pushIdle = (h: RailActor): void => {
    if (idled.has(h.id) || withChange.has(keyOfLane.get(h.id)!) || stops.some((s) => s.lane === h.id)) return;
    idled.add(h.id);
    stops.push({
      id: stableId("idle", keyOfLane.get(h.id) ?? h.id), // By the agent's own key, not its lane's number
      label: `Helper ${h.chip}`,
      lane: h.id,
      head: `Helper ${h.chip} at work`,
      title: "At work",
    });
  };
  // Helpers a wake will merge back: only those get the step (a foreground helper that changed nothing and was not woken has no lane).
  const woken = new Set<ActorId>();
  for (const e of ordered) if ("wake" in e && e.wake.lane) woken.add(e.wake.lane.id);
  // Lanes that already hold a step of their own (a message, a failure, a nested start) need no extra one.
  const busy = new Set<ActorId>([...failureLane.values()]);
  for (const e of ordered) {
    if ("send" in e && e.send.lane) busy.add(e.send.lane);
    else if ("mcpWrite" in e && e.mcpWrite.lane) busy.add(e.mcpWrite.lane);
    else if ("gap" in e && e.gap.lane) busy.add(e.gap.lane);
    else if ("start" in e && e.start.lane) busy.add(e.start.lane);
  }
  let next = 0;
  let asked = 0;
  // These ids name the step by what it is (its launching call, its agent and time, its request), never by a running count, so a call
  // that started earlier and is recorded later cannot renumber the steps after it. A repeat of the same key takes a suffix.
  const usedIds = new Set<string>();
  const stableId = (kind: string, key: string): string => {
    const base = `${kind}-${key.replace(/\u0000/g, ":")}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}~${n}`;
    usedIds.add(id);
    return id;
  };
  const launchedAt = new Map<string, number>();
  const launchReq = new Map<string, string>();
  const backgroundLaunch = new Set<string>();
  for (const e of ordered) {
    const firstNew = stops.length;
    if ("quiet" in e) {
      // No stop. The call rides on the stop before it; before the first stop it rides on the origin.
      // On its agent's lane when that agent has one; an agent that only looked around has none, and its calls sit on the main lane.
      const q: QuietCall = { id: e.quiet.id, text: e.quiet.text, ...(e.quiet.noCommand ? { noCommand: true as const } : {}), lane: e.quiet.key === MAIN_LANE ? MAIN_LANE : (helpers.get(e.quiet.key)?.id ?? MAIN_LANE) };
      const last = stops[stops.length - 1];
      if (last === undefined) {
        originQuiet = [...originQuiet, q];
        continue;
      }
      const calls = [...(last.quiet?.calls ?? []), q];
      last.quiet = { count: calls.length, calls };
      continue;
    }
    if ("launch" in e) {
      launchedAt.set(e.launch, stops.length);
      if (e.bg) backgroundLaunch.add(e.launch);
      if (e.req !== null) launchReq.set(e.launch, `req-${e.req}`);
    }
    else if ("failure" in e) pushFailure(stops, e.failure, failureLane.get(e.failure.call.id) ?? MAIN_LANE, hostName(e.failure.call.host ?? mainHost), failures, groupOf);
    else if ("request" in e) {
      const request = e.request;
      stops.push({
        id: `req-${request.id}`,
        label: "Your request",
        lane: "you",
        // Counted from 1 in the order shown, whatever index the record carries (it can start at 0).
        head: `You made request ${asked + 1}`,
        title: `Made request ${++asked}`,
        // A request whose words are not in the record says so, never an empty box.
        request: request.texts.length === 0 ? { text: NO_REQUEST_TEXT, missing: true } : { text: request.texts.map((t) => t.text).join("\n\n") },
      });
    } else if ("wake" in e) {
      const { w } = e.wake;
      const h = e.wake.lane!;
      const n = h.chip;
      pushIdle(h);
      const said = w.status !== "completed" ? ` (${w.status})` : "";
      // A summary that only restates the finish ('Agent "x" finished') adds nothing; the heading says it once.
      const restates = (t: string | null): boolean => t !== null && /^Agent\b.*\b(finished|completed)\.?$/i.test(t.trim());
      const id = w.launch === "" ? stableId("finish", `${w.agentId ?? ""}@${w.at ?? ""}`) : stableId("wake", `${w.launch}@${w.at ?? ""}`);
      // What the helper itself last said (its SubagentStop), after the notification's summary when there is one.
      const last = e.wake.said ?? null;
      const gist = w.summary ?? (last === null ? null : (last.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 140));
      const lines = [...(w.summary ? [w.summary] : []), ...(last === null || last === w.summary ? [] : last.split("\n").filter((l) => l.trim() !== ""))];
      stops.push({
        id,
        label: `Helper ${n} finished`,
        lane: h.parent!,
        head: `Helper ${n} finished${said}${gist && !restates(gist) ? `: ${gist}` : ""}`,
        title: `Finished${said}${gist && !restates(gist) ? `: ${gist}` : ""}`,
        card: { title: `Helper ${n} finished${said}`, lines: plainLines(lines).map((text) => ({ kind: "plain" as const, text })) },
        // The report is a message from the helper to the lane it joins.
        message: { from: h.id, to: h.parent!, toName: laneName(h.parent!), lines: plainLines(lines), helper: h.id },
      });
      wakeStops.set(h.id, [...(wakeStops.get(h.id) ?? []), id]);
    } else if ("reply" in e) {
      const lines = plainLines(e.reply.text.split("\n"));
      stops.push({
        id: stableId("reply", e.reply.id),
        label: "Reply",
        lane: MAIN_LANE,
        head: `${hostName(mainHost)} replied`,
        title: "Replied",
        card: { title: `${hostName(mainHost)} replied`, lines: lines.map((text) => ({ kind: "plain" as const, text })) },
        message: { from: MAIN_LANE, to: "you", toName: "you", lines },
      });
    } else if ("trackstop" in e) {
      // The record holds only that a command in the session switched tracking off. The skill has the agent run that command when the
      // person asks, so it cannot say who decided: the words claim no more than the command.
      stops.push({ id: stableId("trackstop", e.trackstop.id), label: "Tracking stopped", lane: MAIN_LANE, head: TRACKING_STOPPED, title: TRACKING_STOPPED });
    } else if ("start" in e) {
      // "Started Helper 2 to build the deck". The helper is the agent whose calls name this call as their launcher.
      const { call, session } = e.start;
      const made = [...helpers.entries()].find(([k]) => baseKeyOf(k) === k && launcherOfAgent.get(k) === e.start.launch);
      // The launch's own description, whatever form its line took; the "Started a helper agent: ..." form is read too.
      const what = (call.purpose ?? call.line.text.match(/^Started a helper agent: (.+)$/)?.[1] ?? "").trim();
      const name = made ? made[1].name : "a helper";
      // A bare task name ("recipe", "poem_writer") reads as a label, not as the end of "to ...": "Started Helper 2: recipe".
      const startTitle = `Started ${name}${what ? (/^\S+$/.test(what) ? `: ${what}` : ` to ${what.charAt(0).toLowerCase()}${what.slice(1)}`) : ""}`;
      stops.push({
        id: stableId("start", e.start.launch),
        label: `Started ${name}`,
        lane: e.start.lane!,
        head: startTitle,
        title: startTitle,
        brief: { by: hostName(call.host ?? mainHost), lines: plainLines((call.brief ?? "").split("\n").filter((l) => l.trim() !== "")), ...(call.briefWithheld ? { withheld: true } : {}), ...(call.briefEncrypted ? { encrypted: true } : {}) },
        ...(call.briefWithheld && call.revealable?.includes("prompt") ? { reveal: [{ call: call.id, field: "prompt" }] } : {}),
      });
      void session;
      // The helper's line leaves from this step.
      launchedAt.set(e.start.launch, stops.length);
      if (made && woken.has(made[1].id) && !busy.has(made[1].id)) pushIdle(made[1]);
    } else if ("mcpWrite" in e) {
      const { call, mcp, lane } = e.mcpWrite;
      const h = lane === MAIN_LANE ? undefined : [...helpers.values()].find((x) => x.id === lane);
      const from = h ? h.name : hostName(call.host ?? mainHost);
      const spoken = (n: string): string => n.replace(/_/g, " ");
      stops.push({
        id: stableId("mcp", sk(e.mcpWrite.session, call.id)),
        label: spoken(mcp.tool),
        lane: lane!,
        head: `${from} sent ${spoken(mcp.tool)} to ${spoken(mcp.server)} (logged, not diffed)`,
        title: `Sent ${spoken(mcp.tool)} to ${spoken(mcp.server)}`,
        mcpWrite: { server: mcp.server, tool: mcp.tool, fields: [...mcp.inputFields] },
        mcpCall: { id: call.id, ...(call.outcome === "failed" ? { failed: true as const } : {}) },
      });
    } else if ("gap" in e) {
      const { call, lane, reason } = e.gap;
      const h = lane === MAIN_LANE ? undefined : [...helpers.values()].find((x) => x.id === lane);
      const from = h ? h.name : hostName(call.host ?? mainHost);
      const what = call.mcp === undefined ? "a call" : `${call.mcp.tool.replace(/_/g, " ")} on ${call.mcp.server.replace(/_/g, " ")}`;
      stops.push({
        id: stableId("gap", sk(e.gap.session, call.id)),
        label: "Not captured",
        lane: lane!,
        head: reason,
        title: `Not captured: ${reason}`,
        gap: { reason, what: `${from}: ${what}` },
      });
    } else if ("send" in e) {
      // A message between Claude and a helper, either way, with what it said.
      const { call, lane } = e.send;
      const h = lane === MAIN_LANE ? undefined : [...helpers.values()].find((x) => x.id === lane);
      const from = h ? h.name : hostName(call.host ?? mainHost);
      const to = call.send!.to;
      const summary = call.send!.summary;
      const text = call.send!.text;
      // Said plainly on the card when the record withheld the message (or its content or summary) whole.
      const withheldLine = call.send!.withheld ? ["This message was withheld because it looked like it held a secret."] : [];
      const gist = summary ?? (text === null ? null : (text.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 140));
      // The recipient as a lane when the record names one: a helper whose agent type is the name, else a helper's own spawner
      // (a teammate's "team-lead"). A name that matches nothing stays a name.
      // A recipient that is a helper's agent id resolves to that helper too, never shown raw.
      const byId = to === null ? undefined : (helpers.get(sk(e.send.session, to)) ?? [...helpers.entries()].find(([k]) => baseKeyOf(k) === sk(e.send.session, to))?.[1]);
      const named = to === null ? [] : [...helpers.values()].filter((x) => x.type === to && !x.group);
      const toLane = byId ? byId.id : named.length === 1 ? named[0]!.id : h ? h.parent! : null;
      const toName = byId ? byId.name : named.length === 1 ? named[0]!.name : looksLikeId(to) ? "a helper" : to;
      stops.push({
        id: stableId("msg", sk(e.send.session, e.send.call.id)),
        label: toName ? `Message to ${toName}` : "Message",
        lane: lane!,
        head: `${from} sent a message${toName ? ` to ${toName}` : ""}${gist ? `: ${plain(gist)}` : ""}`,
        title: `Sent a message${toName ? ` to ${toName}` : ""}${gist ? `: ${plain(gist)}` : ""}`,
        card: { title: `${from} sent a message${toName ? ` to ${toName}` : ""}`, lines: plainLines([...(summary && text !== null && text !== summary ? [summary] : []), ...(text === null ? [] : text.split("\n").filter((l) => l.trim() !== "")), ...withheldLine]).map((t) => ({ kind: "plain" as const, text: t })) },
        message: { from: lane!, to: toLane, toName: toLane !== null ? laneName(toLane) : toName, lines: plainLines([...(text === null ? (summary === null ? [] : [summary]) : text.split("\n").filter((l) => l.trim() !== "")), ...withheldLine]) },
        ...(call.send!.withheld && call.revealable !== undefined ? { reveal: call.revealable.filter((f) => ["message", "content", "summary"].includes(f)).map((field) => ({ call: call.id, field })) } : {}),
      });
      // A helper the message resumed leaves from this step, not from the stop before it, as a start step does for a launch.
      launchedAt.set(sk(e.send.session, call.id), stops.length);
    } else {
      pushChange(stops, e.placed, timeline, placed, next++, namesOf(e.placed), failures, e.placed.sharedFailed.length > 0 ? [...new Set(e.placed.sharedFailed.map((k) => (k.key === MAIN_LANE ? hostName(e.placed.by.host) : helpers.get(k.key)!.name)))] : []);
    }
    const at = timeOf.get(e);
    if (at !== undefined && Number.isFinite(at)) for (let i = firstNew; i < stops.length; i++) stops[i]!.at = at;
  }
  pairMoves(stops, placed, failures);
  tellStopsApart(stops);
  // A change step names the calls credited with it, so the page can show what each did and offer its command. A change nobody's call made carries none.
  const creditedOf = new Map<string, string[]>();
  for (const p of placed) creditedOf.set(p.change.id, p.by.calls);
  for (const s of stops) {
    if (!s.change) continue;
    const calls = (creditedOf.get(s.change.key) ?? []).filter((id) => labelOf.has(id)).map((id) => ({ id, text: labelOf.get(id)!, ...(noCommandIds.has(id) ? { noCommand: true as const } : {}) }));
    if (calls.length > 0) s.calls = calls;
  }
  // Consecutive change stops from one call share its name. A lone change carries its call too.
  for (let i = 0; i < stops.length; ) {
    const c = stops[i]!.change ? callOf.get(stops[i]!.change!.key) : undefined;
    let j = i + 1;
    while (c !== undefined && j < stops.length && stops[j]!.change && callOf.get(stops[j]!.change!.key)?.id === c.id) j++;
    if (c !== undefined && j - i > 1) {
      // A failure on the run attaches once, to the run: its first failed change keeps it, and the files after it carry none.
      const at = stops.slice(i, j).findIndex((s) => s.change!.failed !== null);
      for (let k = i; k < j; k++) {
        stops[k]!.call = at < 0 ? c : { ...c, failed: true };
        if (at >= 0 && k > i + at) {
          stops[k]!.change!.failed = null;
          failures.delete(stops[k]!.id);
        }
      }
    }
    // A lone file stop links to its crediting call too, on whatever lane (a header is drawn only over a run of two or more).
    else if (c !== undefined) stops[i]!.call = c;
    i = j;
  }
  // A helper's line branches off its parent's last stop before its first stop and merges into the parent's next stop after its last one.
  const indexOf = (id: string): number => stops.findIndex((s) => s.id === id);
  const lanes = [...helpers.values()];
  const firstOf = new Map(lanes.map((h) => [h.id, stops.findIndex((s) => s.lane === h.id)]));
  const lastOf = new Map(lanes.map((h) => [h.id, stops.reduce((m, s, i) => (s.lane === h.id ? i : m), -1)]));
  const start = new Map<ActorId, number>();
  /**
   * The stop a line leaves from when it branches off `lane` before stop `before`: the lane's own last stop before it. A helper lane with
   * no stop that early (its first moment comes later) has not branched yet, so its own branch point moves up to the same place, taken
   * from its parent in turn; the line then leaves from the parent's branch point. Null when no lane up the chain has a stop that early.
   */
  const leaveFrom = (lane: ActorId, before: number, depth = 0): number | null => {
    let own = -1;
    for (let i = before - 1; i >= 0; i--) if (stops[i]!.lane === lane) { own = i; break; }
    if (own >= 0) return own;
    const h = lanes.find((x) => x.id === lane);
    if (!h || depth > 16) return null;
    const up = leaveFrom(h.parent!, before, depth + 1);
    if (up === null) return null;
    if (!start.has(h.id) || up < start.get(h.id)!) start.set(h.id, up);
    return up;
  };
  /**
   * The stop of the request that owns the launching call, as an index before `before`. Null when Claude did not make the call
   * (a helper did), when the request has no stop, or when a wake came after the request (that turn has no request of its own).
   */
  const requestStopFor = (launchKey: string | undefined, before: number): number | null => {
    const id = launchKey === undefined ? undefined : launchReq.get(launchKey);
    const at = id === undefined ? -1 : indexOf(id);
    if (at < 0 || at >= before) return null;
    for (let i = at + 1; i < before; i++) if (stops[i]!.id.startsWith("wake-")) return null;
    return at;
  };
  for (const h of lanes) {
    // A helper runs alongside its spawner, so its line leaves from the spawner's last stop at or before the launch.
    // A launch is a point whether the helper runs in the background or the foreground, so both anchor at it, not at the first
    // stop; and when Claude launched it, the line leaves no higher than the request that owns the launching call. A lane without a
    // recorded launch leaves from just before the first moment.
    const key = launcherKeyOf.get(h.id);
    const launched = launchedAt.get(key ?? "");
    // A lane with no stop of its own (firstOf -1) leaves from its launch, never from before everything.
    const first = firstOf.get(h.id)!;
    const before = launched === undefined ? first : first < 0 ? launched : Math.min(launched, first);
    let up = leaveFrom(h.parent!, before);
    const owner = launched === undefined ? null : requestStopFor(key, before);
    if (owner !== null && (up === null || owner > up)) up = owner;
    // No spawner stop and no owning request before a background launch: the line leaves from the origin (a marker, so the lane is
    // drawn from the start rather than from a stop), never a plain line and never an unrelated request. A foreground helper in that place
    // stays a plain line.
    if (up === null && launched !== undefined && backgroundLaunch.has(key!)) h.fromStart = true;
    if (up !== null && (!start.has(h.id) || up < start.get(h.id)!)) start.set(h.id, up);
  }
  for (const h of lanes) {
    const last = lastOf.get(h.id)!;
    // The parent is Claude or the helper that launched this one. A woken helper merges at the first wake after its last stop (an
    // agent woken again keeps the later wakes as stops on the spawner's line); one never woken merges at the parent's next stop.
    const woken = wakeStops.get(h.id) ?? [];
    const mergeWake = woken.find((id) => indexOf(id) > last) ?? woken[0];
    h.startId = start.has(h.id) ? stops[start.get(h.id)!]!.id : null;
    h.mergeId = mergeWake ?? stops.slice(last + 1).find((s) => s.lane === h.parent)?.id ?? null;
  }
  // The main lane is the task's host ("The agent" when nothing names one); the neutral lane is listed only when a change sits on it.
  const fixed = ACTORS.map((a): RailActor => (a.id === MAIN_LANE ? { ...a, name: hostName(mainHost), chip: mainHost ? hostName(mainHost)[0]! : "A" } : { ...a }));
  if (stops.some((s) => s.lane === UNSURE_LANE)) fixed.splice(fixed.findIndex((a) => a.id === MAIN_LANE) + 1, 0, { ...UNSURE_LANE_ACTOR });
  const actors = [...fixed, ...helpers.values()];
  const model: RailModel = { task: timeline.task, folder: timeline.folder, actors, stops, files: filesOf(stops, placed, actors, timeline), ...(originQuiet.length > 0 ? { quiet: { count: originQuiet.length, calls: originQuiet } } : {}) };
  // The failed moments get their line last, once the whole run is known.
  attachFailureLines(model, failures);
  return model;
}

/**
 * The outside files the person asked for. The rule is structural: an outside file is asked for when its file name stands as a whole word in a request the person typed
 * (the timeline cuts a path outside the folder to its file name, so naming the path and naming the file read the same). A name with a space is cut whole to "[outside path]" in the
 * request, so it can't be matched: any typed request holding that mark counts such a name as asked (it errs toward listing a file, never toward hiding one). Anything else outside is scratch.
 */
export function askedOutside(timeline: Timeline): (file: string) => boolean {
  const typed = timeline.requests.flatMap((r) => r.texts.filter((l) => l.source === "user" && l.label !== NOTICE_LABEL).map((l) => l.text.toLowerCase()));
  const cutMark = typed.some((t) => t.includes("[outside path]"));
  const wordIn = (t: string, name: string): boolean => {
    for (let at = t.indexOf(name); at >= 0; at = t.indexOf(name, at + 1)) {
      const before = at === 0 ? "" : t[at - 1]!, after = t[at + name.length] ?? "";
      if (!/[\w.\-]/.test(before) && !/[\w-]/.test(after) && !(after === "." && /\w/.test(t[at + name.length + 1] ?? ""))) return true;
    }
    return false;
  };
  return (file) => {
    const name = baseOf(file).toLowerCase();
    return (/\s/.test(name) && cutMark) || typed.some((t) => wordIn(t, name));
  };
}

/**
 * The one key every per-file structure uses for a change. An outside path reaches the body as its bare file name, so the name alone would merge it with an in-folder file of that name.
 * The outside key starts with NUL, which no real path holds, so it never equals an in-folder path (even one named "[outside] x"). Outside files of one name in different directories share a key: the body cannot tell them apart.
 */
export const entryKey = (change: { file: string; outside?: boolean }): string => ((change.outside ?? isOutside(change.file)) ? "\u0000outside\u0000" : "") + change.file;

/** The files list, from the change steps in the order the rail holds them (time order). A secret file is listed under its name line, by its own path, and carries no hash. */
function filesOf(stops: readonly RailStop[], placed: readonly Placed[], actors: readonly RailActor[], timeline: Timeline): RailFile[] {
  const byId = new Map(placed.map((p) => [p.change.id, p.change]));
  const out = new Map<string, RailFile>();
  const asked = askedOutside(timeline);
  for (const s of stops) {
    const rc = s.change, change = rc ? byId.get(rc.key) : undefined;
    // a re-save of no single call has no lane, and is listed here, muted, on the lane it would have had.
    const vLane = s.lane ?? s.history?.lane ?? null;
    if (!rc || !change || vLane === null) continue;
    // An outside path reaches the body as its bare file name, so the key must say it is outside; otherwise it merges with an in-folder file of that name. Outside files of one name in different directories stay one entry (the body cannot tell them apart).
    const away = !rc.secret && (change.outside ?? isOutside(change.file));
    const key = away ? entryKey(change) : change.file;
    let f = out.get(key);
    if (!f) out.set(key, (f = { file: rc.file, name: rc.secret ? rc.file : change.diff !== undefined ? change.file : baseOf(change.file), ...(change.diff !== undefined && !rc.secret ? { connector: { id: change.diff.connector, subject: change.file } } : {}), ...(away ? { ref: "/outside/" + change.file } : {}), ...((change.outside ?? isOutside(change.file)) && !rc.secret && !asked(change.file) ? { outside: true as const } : {}), start: rc.secret ? "kept" : change.kind === "created" ? "none" : change.before?.stored === true ? "kept" : "lost", versions: [] }));
    f.versions.push({
      change: rc.key,
      stop: s.id,
      sha: rc.secret ? "" : (change.after?.sha256 ?? ""),
      lane: vLane,
      chip: actors.find((a) => a.id === vLane)?.chip ?? (vLane === OUTSIDE_LANE_ACTOR.id ? OUTSIDE_LANE_ACTOR.chip : vLane === UNSURE_LANE_ACTOR.id ? UNSURE_LANE_ACTOR.chip : "?"),
      at: s.at ?? change.at ?? null,
      label: cap(VERB[change.kind]),
      kind: change.kind,
      kept: rc.secret || (change.kind === "deleted" ? change.before?.stored === true : change.after?.stored === true),
      ...(change.inferred === true && !rc.secret ? { inferred: true as const } : {}),
      ...(rc.secret ? { secret: true as const } : {}),
      ...(s.muted === true && change.resave === true ? { muted: true as const } : {}),
    });
  }
  const files = [...out.values()];
  markWorking(files, asked);
  tellApart(files);
  const sources = attachInputs(files, placed, timeline);
  const sorted = byLastChange(files);
  // Sources go below every changed file; their inputs were numbered -1, -2, ... until the changed files had their final places
  sorted.forEach((f) => f.versions.forEach((v) => { v.inputs?.forEach((i) => { if (i.file < 0) i.file = sorted.length - 1 - i.file; }); v.looked?.forEach((i) => { if (i.file < 0) i.file = sorted.length - 1 - i.file; }); }));
  sorted.push(...sources);
  tellApart(sorted);
  markSameAs(sorted);
  return sorted;
}

/** The sha-256 of zero bytes: an empty file is never "the same bytes" as another. */
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Flags build and scratch files: every listed file under some dot-folder of the path was created in the task, and the request does not name the file. A pre-existing file in the folder (a changed .github/workflows/ci.yml) keeps the whole folder real. */
function markWorking(files: RailFile[], asked: (file: string) => boolean): void {
  const dotPrefixes = (f: RailFile): string[] => {
    const segs = dirName(f.file).split("/").filter((x) => x !== "");
    return segs.flatMap((seg, i) => (seg.startsWith(".") && seg !== "." && seg !== ".." ? [segs.slice(0, i + 1).join("/")] : []));
  };
  const inFolder = files.filter((f) => !f.outside && f.ref === undefined && !f.versions[0]?.secret && !isOutside(f.file));
  const allNew = new Map<string, boolean>();
  for (const f of inFolder) for (const d of dotPrefixes(f)) allNew.set(d, (allNew.get(d) ?? true) && f.start === "none");
  for (const f of inFolder) if (dotPrefixes(f).some((d) => allNew.get(d)) && !asked(f.file)) f.working = true;
}

/** The final bytes of a non-empty file equal a real file's: say so on the label, merge nothing. */
function markSameAs(files: RailFile[]): void {
  const finalSha = (f: RailFile): string => {
    const v = f.versions[f.versions.length - 1];
    return !v || v.secret || v.kind === "deleted" || f.outside || f.source || f.ref !== undefined ? "" : v.sha;
  };
  for (const f of files) {
    const sha = finalSha(f);
    if (sha === "" || sha === EMPTY_SHA) continue;
    const twin = files.find((g) => g !== f && !g.working && finalSha(g) === sha);
    if (twin) {
      const dir = dirName(twin.file).split("/").filter((x) => x !== "").join("/");
      f.sameAs = "same bytes as " + twin.name + " (" + (dir === "" ? "top folder" : dir) + ")";
    }
  }
}

/**
 * The files by the time of their last version, newest first; ties by path; a file whose last version has no time after the timed ones.
 * In groups first: files deleted during the task, then the rest, then working files, then outside files; the order by last change holds within
 * each group. (The office-deliverables group is deleted, not replaced.)
 * `inputs[].file` and `stale[].file` index the list, so they are renumbered with it. (A placeholder order until files are ranked by importance.)
 */
function byLastChange(files: RailFile[]): RailFile[] {
  const last = (f: RailFile): number | null => f.versions[f.versions.length - 1]?.at ?? null;
  const group = (f: RailFile): number => {
    const v = f.versions[f.versions.length - 1];
    return f.outside ? 4 : f.working ? 3 : v?.kind === "deleted" ? 1 : 2;
  };
  const order = files.map((_, i) => i).sort((a, b) => {
    const ga = group(files[a]!), gb = group(files[b]!);
    if (ga !== gb) return ga - gb;
    const x = last(files[a]!), y = last(files[b]!);
    if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
    return files[a]!.file < files[b]!.file ? -1 : files[a]!.file > files[b]!.file ? 1 : 0;
  });
  const to = new Map(order.map((old, now) => [old, now]));
  for (const f of files) for (const v of f.versions) {
    v.inputs?.forEach((i) => { if (i.file >= 0) i.file = to.get(i.file)!; });
    v.looked?.forEach((i) => { if (i.file >= 0) i.file = to.get(i.file)!; });
    v.stale?.forEach((s) => { s.file = to.get(s.file)!; });
  }
  return order.map((i) => files[i]!);
}

/** Files that share a name get the fewest trailing folders of their paths that make every one of them differ (the whole folder at worst). A secret file is never listed this way. */
function tellApart(files: RailFile[]): void {
  const groups = new Map<string, RailFile[]>();
  for (const f of files) if (!f.versions[0]?.secret) groups.set(f.name, [...(groups.get(f.name) ?? []), f]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const dirs = group.map((f) => (f.outside || f.ref !== undefined || isOutside(f.file) ? ["outside the folder"] : dirName(f.file).split("/").filter((x) => x !== "")));
    const most = Math.max(...dirs.map((d) => d.length));
    const label = (d: string[], k: number): string => (d.length === 0 ? "top folder" : d.slice(-k).join("/"));
    let k = 1;
    while (k < most && new Set(dirs.map((d) => label(d, k))).size < group.length) k++;
    group.forEach((f, i) => { f.where = label(dirs[i]!, k); });
  }
}

/** The file (index) a read path stands for: a path relative to the watched folder (the timeline cuts absolute ones to that), or a shorter one that ends a listed file's path. Ambiguous or unknown: null. */
function resolveRead(path: string, files: readonly RailFile[]): number | null {
  let rel = path;
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (pathKit().isAbs(rel) || rel.split("/").includes("..")) return null;
  const hits = files.flatMap((f, i) => (f.ref === undefined && (f.file === rel || f.file.endsWith("/" + rel)) ? [i] : []));
  return hits.length === 1 ? hits[0]! : null;
}

/** Each version's inputs, from the reads of the call(s) credited with the change. */
function attachInputs(files: RailFile[], placed: readonly Placed[], timeline: Timeline): RailFile[] {
  const sources: RailFile[] = [];
  const ordered: TimelineCall[] = [];
  for (const r of timeline.requests) for (const run of r.runs) ordered.push(...run.calls);
  const indexOf = new Map(ordered.map((c, i) => [c.id, i]));
  const agentOf = (c: TimelineCall): string => c.agent?.id ?? "";
  type Ref = { path: string; via: "read" | "call" | "script"; at: number; unchanged?: true };
  /** What the producing call itself read (inputs: named in its script or opened in the call) and the Read tool calls its agent made since its previous call that changed a file (looked at). Each read sits at the time of the call that made it. */
  const readsOf = (id: string): { own: Ref[]; looked: Ref[] } => {
    const at = indexOf.get(id);
    if (at === undefined) return { own: [], looked: [] };
    const me = ordered[at]!;
    const own: Ref[] = [], looked: Ref[] = [];
    const take = (c: TimelineCall, into: Ref[]): void => { if (c.start !== null) for (const r of c.reads ?? []) (r.via === "read" ? looked : into).push({ ...r, at: c.start }); };
    take(me, own);
    for (let i = at - 1; i >= 0; i--) {
      const c = ordered[i]!;
      if (agentOf(c) !== agentOf(me)) continue;
      if (c.changes.length > 0) break;
      if (c.tool === "Read") take(c, looked);
    }
    return { own, looked };
  };
  const byChange = new Map(placed.map((p) => [p.change.id, p]));
  for (const file of files) for (const v of file.versions) {
    if ((byChange.get(v.change)?.by.calls ?? []).some((id) => { const at = indexOf.get(id); return at !== undefined && ordered[at]!.readsUnknown === true; })) v.unknownReads = true;
  }
  // A file a call changed is that call's output, never its input, by whatever signal credited the change (the record, the write-signal pass, the script's write forms): the rule is structural, not per-syntax.
  const wroteFiles = new Map<string, Set<number>>();
  files.forEach((file, fi) => file.versions.forEach((v) => { for (const id of byChange.get(v.change)?.by.calls ?? []) wroteFiles.set(id, (wroteFiles.get(id) ?? new Set<number>()).add(fi)); }));
  files.forEach((file, fi) => {
    file.versions.forEach((v, vi) => {
      const found = new Map<string, { file: number; p: number; why: "script" | "call" }>();
      const seen = new Map<string, { file: number; p: number }>();
      for (const id of byChange.get(v.change)?.by.calls ?? []) {
        const { own, looked } = readsOf(id);
        const place = (ref: Ref): { key: string; file: number; p: number } | null => {
          const target = resolveRead(ref.path, files);
          if (ref.unchanged && target === null) {
            // The file as the task found it; negative until byLastChange has placed the changed files
            let k = sources.findIndex((x) => x.file === ref.path);
            if (k < 0) { k = sources.length; sources.push({ file: ref.path, name: baseOf(ref.path), start: "lost", versions: [], source: true }); }
            return { key: `s${k}`, file: -1 - k, p: 0 };
          }
          if (target === null || files[target]!.versions.some((x) => x.secret) || wroteFiles.get(id)?.has(target)) return null;
          const versions = files[target]!.versions;
          let k = -1;
          versions.forEach((x, i) => { if (x.at !== null && x.at <= ref.at) k = i; });
          // no version yet: the file counts as an input only when the task found it already there
          const p = k >= 0 ? k + 1 : versions[0]!.kind === "created" ? null : 0;
          if (p === null || (target === fi && p > vi)) return null;
          return { key: `${target}:${p}`, file: target, p };
        };
        for (const ref of own) {
          const at = place(ref);
          if (at === null || ref.via === "read") continue;
          const prev = found.get(at.key);
          found.set(at.key, { file: at.file, p: at.p, why: prev?.why === "script" || ref.via === "script" ? "script" : "call" });
        }
        for (const ref of looked) { const at = place(ref); if (at !== null) seen.set(at.key, { file: at.file, p: at.p }); }
      }
      // a file the change was built from is not also "looked at"
      for (const key of found.keys()) seen.delete(key);
      if (found.size > 0) v.inputs = [...found.values()];
      if (seen.size > 0) v.looked = [...seen.values()];
    });
  });
  /**
   * The input's last version with other bytes than the read (the change that made the output out of date) is answered when a call that
   * rewrote the output's file with the bytes it already had came with it or after it: the call made that version, or started at or after its time.
   * A rewrite before that change, or no rewrite, leaves the output stale. Records made before the op field answer as they did.
   */
  const reproduced = (out: RailFile, versions: RailFile["versions"], p: number, read: string | null): boolean => {
    let last = -1;
    versions.forEach((x, j) => { if (j >= p && (read === null || (x.sha !== "" && x.sha !== read))) last = j; });
    const newer = versions[last];
    if (newer === undefined) return false;
    const madeNewer = new Set(byChange.get(newer.change)?.by.calls ?? []);
    return ordered.some((c) => (c.rewrote ?? []).includes(out.file) && (madeNewer.has(c.id) || (c.start !== null && newer.at !== null && c.start >= newer.at)));
  };
  for (const file of files) for (const v of file.versions) {
    // Only the file's latest version is judged; one the file later superseded shows nothing
    if (v !== file.versions[file.versions.length - 1]) continue;
    const stale: NonNullable<RailFileVersion["stale"]> = [];
    // Scratch outside the folder neither warns nor is warned about
    if (file.outside) continue;
    for (const i of v.inputs ?? []) {
      if (i.file < 0 || files[i.file]!.outside) continue; // A source never changed, so it is never stale
      const versions = files[i.file]!.versions;
      // Before task (p 0) has no hash here: any version after it is a change. Otherwise only different bytes count, and bytes back to what was read are no change.
      const read = i.p === 0 ? null : versions[i.p - 1]!.sha;
      if (read === "") continue;
      const k = versions.findIndex((x, j) => j >= i.p && (read === null || (x.sha !== "" && x.sha !== read)));
      if (k >= 0 && (read === null || versions[versions.length - 1]!.sha !== read) && !reproduced(file, versions, i.p, read)) stale.push({ file: i.file, p: i.p, newer: k + 1, newerLane: versions[k]!.lane, newerChip: versions[k]!.chip });
    }
    if (stale.length > 0) v.stale = stale;
  }
  return sources;
}

/** "1 run failed", "3 runs failed": a failure group's label, which carries its count. */
const runsFailed = (n: number): string => `${n} ${n === 1 ? "run" : "runs"} failed`;
const NO_ERROR_TEXT = "The run reported a failure with no error text or exit code.";

/**
 * The failure group a failed call joins: the last failure stop on its lane, when every stop after that one is another lane's
 * failure. A change, a request, a message or a finish ends the run; a call that changed nothing never makes a stop, so it does not.
 */
function groupOf(stops: RailStop[], lane: ActorId): RailStop | undefined {
  for (let k = stops.length - 1; k >= 0; k--) {
    const s = stops[k]!;
    if (s.runs === undefined) return undefined;
    if (s.lane === lane) return s;
  }
  return undefined;
}

/** The moment of a failed call that changed no file: who ran it, what it was, and the host's own words about the failure.
 *  A run of them by one actor is one step, "N runs failed", listing each call; the first call's id names the step. */
function pushFailure(stops: RailStop[], item: FailedCall, lane: ActorId, main: string, failures: Map<string, FailureInput>, join: typeof groupOf): void {
  const { call } = item;
  // A failed call is a call on record, so it is on the main lane or a helper's; never outside the agents.
  const who = lane.startsWith(HELPER_LANE) ? `Helper ${parseInt(lane.slice(HELPER_LANE.length), 10)}` : main;
  // The step is named by its line, or by the tool when the line is blank; never by a bare "A call".
  const what = call.line?.text?.trim() || call.tool || "A call";
  const said = typeof call.error === "string" && call.error.trim() !== "" ? call.error.trim().split("\n").filter((l) => l.trim() !== "").slice(0, 6) : [];
  // The whole output (masked) sits behind the row's "Show output" when it says more than the error line.
  const full = (call.errorFull ?? call.error ?? "").trim();
  const run = { id: call.id, text: what, error: said.length > 0 ? said[said.length - 1]! : NO_ERROR_TEXT, ...(full !== "" && full !== said[said.length - 1] ? { output: full } : {}) };
  const group = join(stops, lane);
  if (group !== undefined) {
    const runs = [...group.runs!, run];
    const prev = failures.get(group.id)!;
    group.runs = runs;
    group.label = runsFailed(runs.length);
    group.head = `${who}: ${runsFailed(runs.length)}`;
    group.title = runsFailed(runs.length);
    group.card = { title: runsFailed(runs.length), lines: runs.map((r) => ({ kind: "plain" as const, text: `${r.text}: ${r.error}` })) };
    failures.set(group.id, {
      raw: `${prev.raw}\n\n${said.length > 0 ? call.error!.trim() : NO_ERROR_TEXT}`,
      hasText: prev.hasText || said.length > 0,
    });
    return;
  }
  failures.set(`fail-${call.id}`, {
    raw: said.length > 0 ? call.error!.trim() : NO_ERROR_TEXT,
    hasText: said.length > 0,
  });
  stops.push({
    id: `fail-${call.id}`,
    label: runsFailed(1),
    lane,
    runs: [run],
    head: `${who} ran a call that failed: ${what}`,
    title: `Failed: ${what}`,
    // No subtitle and no "no file changed" sentence; the page draws `runs` as the step's body.
    card: { title: `Failed: ${what}`, lines: (said.length > 0 ? said : [NO_ERROR_TEXT]).map((text) => ({ kind: "plain" as const, text })) },
  });
}

/** From this many changed places, a change is drawn as one card, not cell by cell (a CSV re-pull gave "24883 more changes"). Below it the five notes and the one "more changes" line stand. */
export const REWRITE_AT = 500;
/** The one line of a change too big to read place by place: how many places changed, and in which place when the reader names one place for all it left out.
 *  Worded from the reader's own place name, not from the file's ending. */
function bigChange(change: Change, name: string): string {
  const f = change.format!;
  const places = new Set((f.moreIn ?? []).map((m) => m.place));
  const one = places.size === 1 ? [...places][0] : null;
  const where = one ? `'${one.replace(/'/g, "''")}'` : name;
  return `${f.rows.length + f.more} changes in ${where}.`;
}

/** A new file's note without "X created <file> in the <folder> folder", which the heading and the folder tree already say: what it holds, or nothing. */
function createdDetail(note: string): string {
  const at = note.indexOf(" created ");
  const w = at < 0 ? -1 : note.indexOf(" with ", at);
  if (at < 0) return note;
  // The literal same-content sentence (strict evidence only) is not what the heading says, so it stays.
  const twin = note.indexOf(SAME_CONTENT_AS);
  if (w < 0) return twin < 0 ? "" : note.slice(twin);
  const rest = note.slice(w + " with ".length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function pushChange(stops: RailStop[], item: Placed, timeline: Timeline, all: Placed[], index: number, laneNames: string[], failures: Map<string, FailureInput>, sharedFailedNames: string[]): void {
    const { change, lane, ask, by } = item;
    const sharedFailure = sharedFailedNames.length > 0 && !(change.generic?.secret === true || isSecretPath(change.file));
    const secret = change.generic?.secret === true || isSecretPath(change.file);
    const name = change.diff !== undefined && !secret ? change.file : baseOf(change.file);
    // The maker's name, the side text and the lane all come from `change.by` (`attribution.ts`).
    const actor = railActor(by, laneNames);
    const who = actor;
    // A helper's notes start with "Helper <n>", the lane's own name, not the host's; a joint's with the names of its lanes.
    const speak = (text: string): string => speakAs(text, by, actor);
    const sub = sideText(by, laneNames);
    // A failed call (A) whose file the reader could not open after (B) reads as one sentence; each alone keeps its own line.
    const joined = item.failed && !secret && change.generic?.unopened?.some((u) => u.side === "after") === true;
    const before = change.generic?.unopened?.find((u) => u.side === "before");
    const created = change.kind === "created";
    // A change too big to read cell by cell is one line; a new file's note keeps only what the heading does not say.
    const rewrite = !secret && !joined && change.kind === "modified" && change.format !== null && change.format.rows.length + change.format.more >= REWRITE_AT;
    // A deleted file says so at the top of its step, with its path; the before view stays.
    const fact = change.kind === "deleted" && !secret ? `Deleted: ${change.file} no longer exists after this step.${change.before?.stored === true ? " Before shows its last content." : ""}` : undefined;
    const note = secret ? "" : joined ? `${callFailedAndUnopenable(change.file, change.kind)}${before ? ` ${couldNotOpen(change.file, "before", before.why)}` : ""}` : rewrite ? bigChange(change, name) : created ? createdDetail(speak(noteOf(change))) : speak(noteOf(change));
    // The files that exist before this moment: every file whose first change is earlier, and every file not created in this task.
    const createdAt = new Map<string, number>();
    // A file whose first change in the task is its creation did not exist at the task's start.
    const firstKind = new Map<string, Change["kind"]>();
    const history = new Map<string, Array<[number, boolean]>>();
    all.forEach((p, k) => {
      const ek = entryKey(p.change);
      if (!firstKind.has(ek)) firstKind.set(ek, p.change.kind);
      if (p.change.kind === "created" && !createdAt.has(ek)) createdAt.set(ek, k);
      // The moments of each file at which it was deleted or came back, in order: a file whose latest change before a moment is a deletion is not in that moment's tree.
      const ev = history.get(ek);
      if (ev) ev.push([k, p.change.kind === "deleted"]);
      else history.set(ek, [[k, p.change.kind === "deleted"]]);
    });
    const secretFiles = new Set(all.filter((p) => p.change.generic?.secret === true).map((p) => entryKey(p.change)));
    // An outside file is never in a folder tree (its folder is unknown), whatever the other new files' trees draw. It is dropped by its own key, so an in-folder file of the same name stays.
    const names = [...new Set(all.filter((p) => !(p.change.outside ?? isOutside(p.change.file)) && !isSecretPath(p.change.file) && !secretFiles.has(entryKey(p.change))).map((p) => p.change.file))];
    // ...and it is back once a later change recreates it (the latest change before `at` is not a deletion).
    const deletedBefore = (f: string, at: number): boolean => {
      const ev = history.get(f);
      let last: [number, boolean] | undefined;
      for (const e of ev ?? []) if (e[0] < at) last = e;
      return last !== undefined && last[1];
    };
    const existing = (at: number): string[] => names.filter((f) => (!createdAt.has(f) || createdAt.get(f)! < at) && !deletedBefore(f, at));
    const outside = change.outside ?? isOutside(change.file);
    // An outside path reaches the body as a bare file name, so its folder is unknown and its tree is not drawn (it would sit in the wrong one).
    const newFile: RailNewFile | null = created && !secret && change.diff === undefined ? { name, folder: outside ? null : dirName(change.file) === "" ? "work" : baseOf(dirName(change.file)), outside } : null;
    const rc: RailChange = {
      key: change.id,
      file: secret ? secretLine(change.file) : change.file,
      kind: change.kind,
      note,
      rowNotes: secret || rewrite ? [] : rowNotesOf(change, speak),
      moreNote: !secret && !rewrite && change.format && change.format.more > 0 ? moreText(change.format.more, change.format.moreIn ?? []) : null,
      ...(rewrite ? { rewrite: true as const } : {}),
      viewUrl: secret ? null : `/timeline/${timeline.task}/view/${encodeURIComponent(change.id)}`,
      ...(change.inferred === true && !secret ? { inferred: true as const } : {}),
      secret,
      secretLine: secret ? secretLine(change.file) : null,
      failed: item.failed && !secret && !joined ? callFailed(change.file, change.kind, item.error ?? null) : sharedFailure ? callFailedShared(change.file, change.kind, sharedFailedNames, item.error ?? null) : null,
      ask,
      newFile,
      treeBefore: newFile && !newFile.outside ? treeRows(existing(index), change.file, "before") : null,
      treeAfter: newFile && !newFile.outside ? treeRows(existing(index + 1).concat(change.file), change.file, "after") : null,
      ...(fact !== undefined ? { fact } : {}),
    };
    if ((item.failed || sharedFailure) && !secret) {
      const text = typeof item.error === "string" && item.error.trim() !== "" ? item.error.trim() : null;
      failures.set(`chg-${change.id}`, {
        raw: text ?? (sharedFailure ? callFailedShared(change.file, change.kind, sharedFailedNames, null) : callFailed(change.file, change.kind, null)),
        hasText: text !== null,
      });
    }
    // a re-save the claiming connector vouches changed nothing. One call credited: it stays on that lane, muted. Anyone else: no lane stop.
    const resave = change.resave === true && !secret;
    const ownLane = by.kind === "call";
    stops.push({
      id: `chg-${change.id}`,
      label: secret ? "Secret file" : `${cap(VERB[change.kind])} ${name}`,
      lane: resave && !ownLane ? null : lane,
      head: secret ? secretLine(change.file) : `${who} ${VERB[change.kind]} ${change.file}`,
      // The heading names the file by its path relative to the watched folder (an outside file's record holds its bare name only).
      ...(secret ? {} : { title: `${cap(VERB[change.kind])} ${change.file}`, path: change.file }),
      ...(resave ? { sub: SAVED_AGAIN_NOTHING_CHANGED } : sub !== undefined ? { sub } : {}),
      ...(by.probably !== undefined || resave ? { muted: true as const } : {}),
      ...(resave && !ownLane && lane !== null ? { history: { lane } } : {}),
      change: rc,
    });
}

/**
 * A move or rename is one step. Within one recorded step (one sweep), exactly one file went gone and exactly one new file appeared with the
 * same non-empty bytes: the two records become one "Moved a to b" (or "Renamed a to b", same folder) step, kept at the new file's place. The new
 * file's change carries the step; the gone record leaves the rail. Never paired: different steps, a copy (the old file is not gone, so there is
 * no gone record), several files with the same bytes, an empty file, a secret or outside path, the same path.
 */
/** One created or deleted record, as `movePairs` reads it: the stop id, the recorded step, the path (inside the folder, not secret) and the bytes (created: after, deleted: before). */
export interface MoveRecord { id: string; step: number | null; file: string; kind: "created" | "deleted"; sha: string }
/**
 * The rule, over plain records so the review index (which has no timeline) applies the same one: within one step, exactly one deleted and exactly
 * one created record with the same non-empty, non-empty-file bytes, on different paths. Returns each pair's gone and new record.
 */
export function movePairs(recs: readonly MoveRecord[]): Array<{ gone: MoveRecord; made: MoveRecord }> {
  const steps = new Map<number, MoveRecord[]>();
  for (const r of recs) if (r.step !== null && r.sha !== "" && r.sha !== EMPTY_SHA) steps.set(r.step, [...(steps.get(r.step) ?? []), r]);
  const out: Array<{ gone: MoveRecord; made: MoveRecord }> = [];
  for (const list of steps.values()) {
    for (const g of list.filter((r) => r.kind === "deleted")) {
      const same = list.filter((r) => r.sha === g.sha);
      const made = same.filter((r) => r.kind === "created");
      if (same.filter((r) => r.kind === "deleted").length !== 1 || made.length !== 1 || made[0]!.file === g.file) continue;
      out.push({ gone: g, made: made[0]! });
    }
  }
  return out;
}

function pairMoves(stops: RailStop[], placed: readonly Placed[], failures: Map<string, FailureInput>): void {
  const byKey = new Map(placed.map((p) => [p.change.id, p.change]));
  const recs: MoveRecord[] = [];
  const stopOf = new Map<string, RailStop>();
  for (const stop of stops) {
    const rc = stop.change;
    const change = rc ? byKey.get(rc.key) : undefined;
    if (!rc || !change || rc.secret || change.step === null || (change.outside ?? isOutside(change.file)) || change.diff !== undefined) continue;
    if (change.kind !== "deleted" && change.kind !== "created") continue;
    recs.push({ id: stop.id, step: change.step, file: change.file, kind: change.kind, sha: (change.kind === "deleted" ? change.before?.sha256 : change.after?.sha256) ?? "" });
    stopOf.set(stop.id, stop);
  }
  const drop = new Set<RailStop>();
  for (const { gone, made } of movePairs(recs)) {
    const g = { stop: stopOf.get(gone.id)!, file: gone.file }, m = { stop: stopOf.get(made.id)!, file: made.file };
    const rename = dirName(m.file) === dirName(g.file);
    const verb = rename ? "Renamed" : "Moved";
    const who = m.stop.head.slice(0, m.stop.head.length - ` created ${m.file}`.length);
    const text = `${verb} ${g.file} to ${m.file}`;
    m.stop.label = `${verb} ${baseOf(m.file)}`;
    m.stop.head = `${who} ${verb.toLowerCase()} ${g.file} to ${m.file}`;
    m.stop.title = text;
    m.stop.moved = { from: g.file, to: m.file, kind: rename ? "renamed" : "moved", fromStop: g.stop.id };
    m.stop.change!.note = `${text}.`;
    drop.add(g.stop);
    failures.delete(g.stop.id);
  }
  if (drop.size > 0) for (let i = stops.length - 1; i >= 0; i--) if (drop.has(stops[i]!)) stops.splice(i, 1);
}

/**
 * Change steps that share a bare file name name it by the fewest trailing folders that tell them apart (the Files view's rule), and carry
 * that end of the label as `tail`, which the rail row keeps visible when it trims. A name no other step shares keeps its bare label.
 */
function tellStopsApart(stops: RailStop[]): void {
  const shown = stops.filter((s) => s.change !== undefined && !s.change.secret && s.path !== undefined);
  const groups = new Map<string, string[]>();
  for (const s of shown) {
    const n = baseOf(s.path!);
    const g = groups.get(n) ?? [];
    if (!g.includes(s.path!)) g.push(s.path!);
    groups.set(n, g);
  }
  const shownAs = new Map<string, string>();
  for (const [name, paths] of groups) {
    if (paths.length < 2) continue;
    const dirs = paths.map((p) => dirName(p).split("/").filter((x) => x !== ""));
    const most = Math.max(...dirs.map((d) => d.length));
    const label = (d: string[], k: number): string => d.slice(-k).join("/");
    let k = 1;
    while (k < most && new Set(dirs.map((d) => label(d, k))).size < paths.length) k++;
    paths.forEach((p, i) => { const where = label(dirs[i]!, k); shownAs.set(p, where === "" ? name : `${where}/${name}`); });
  }
  for (const s of shown) {
    const as = shownAs.get(s.path!), name = baseOf(s.path!);
    if (as === undefined || !s.label.endsWith(name)) continue;
    s.label = s.label.slice(0, -name.length) + as;
    s.tail = as;
  }
}
