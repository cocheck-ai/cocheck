import { keepCallValues } from "./connector/frozen.ts";
import { hasSealHeader, openBytes, sha256Hex, writeSealed } from "./seal.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type BigIntStats, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanId, evidenceSince, readLauncher } from "./agent-transcripts.ts";
import { isPatchTool, isWithheldSection } from "./patch-secrets.ts";
import { EVIDENCE_SLACK_MS, creditWithEvidence, guardKit, isInternalAgentCall, isLauncherTool, isWaitTool, launcherMayCredit, neverRan, runsOnAfterResult, samePath, toolMayCredit, isShellTool, toolNeverWrites, waitsOnHelpers, writeTargetsOf, editTargetsOf, reportedEditsOf, type CallEvidence, type WriteEvidence } from "./credit-guard.ts";
import { withFileLock } from "./file-lock.ts";
import { claimedFor, claimedLayer, cutShortReason, MOVED_WHILE_READ, type Claimed } from "./connector/claimed.ts";
import { connectorClaimsFor, fileConnectorIdentity } from "./connector/installed-match.ts";
import { builtinClaims } from "./connector/builtins.ts";
import type { FileCapture } from "./connector/file-capture.ts";
import { nudgeFileCapture } from "./connector/local-process.ts";
import { isDeliveryPath, isHomePath } from "./region-delivery.ts";
import { isPythonEnvironment, isWatchedFolderFile, MAX_FOLDER_BYTES, MAX_FOLDER_FILES, MAX_WALK_ENTRIES, SKIPPED_FOLDERS, DELIVERY_FOLDER } from "./formats/files/scan.ts";
import { isSecretPath, secretLine } from "./secret-files.ts";
import { EMPTY_SHA } from "./secret-hashes.ts";
import { secretRuleInBytes } from "./secret-scan.ts";
import { foldFolder, isInsideFolded, resolveFolder as realish } from "./registry.ts";
import { sha256Stream } from "./fingerprint.ts";
import { ensureStoreDir, mbText, removeEmptyStoreDir, removePreviews, STATE_FILE_CAP_BYTES, storeDirOf, storedShas, TASK_STORE_CAP_BYTES } from "./states.ts";
import { openLedger, TOOL_FAILED, TOOL_NOT_RUN, type Ledger } from "./ledger.ts";
import { profileOf } from "./hosts/index.ts";
import { exitFailureText } from "./timeline/rollout-failures.ts";
import { assertNormalized, normalize, type HookHost, type NormalizedEvent } from "./normalize.ts";
import { advance, advanceForward, claimAtPre, READ_BUDGET_MS, claimRequest, closingClaim, cut, CLOSING_MAX, lookup, newCursor, none, reasonOf, spend, validCursor, type Narration, type NarrationCursor } from "./narration.ts";
import { normalizePathForCompare, pathKit, type PathKit } from "./paths.ts";
import { isMcpTool, looksSecret, toolLabel, type ToolLabel } from "./tool-label.ts";
import { parseFollowUpMarker } from "./timeline/rail/send-back.ts";
import { HOOK_SESSION_MARK, hookFolderOf, TaskError, TaskStore, NO_OPEN_TASK, type SubmitSummary } from "./tasks.ts";
import { readEvidence, startEvidence, strictWriters, type EvidenceState, type ProvenWrite } from "./attribution/evidence.ts";
import { cannotHaveWritten, fsProbe, hooksProven, isReadOnlyCommand, writeScope, type PathProbe, type StartRecord, type WriteScope } from "./attribution/write-scope.ts";
import { commandNamesFile, textNamesBase } from "./attribution/names.ts";
import { rootsFile } from "./attribution/tag.ts";
import { creditBasisOf, hostReportedEdit, type ProofMethod } from "./attribution/basis.ts";
import { reconstructAll, RECONSTRUCT_MAX_BYTES, type ReportedEdit } from "./attribution/reconstruct.ts";
import type { TagSetting } from "./attribution/tag.ts";

/**
 * Host-hook adapter. Claude Code and Codex call it from PreToolUse, PostToolUse, PostToolUseFailure and
 * Stop hooks; each call is a short-lived process, so everything it knows lives in `<home>/hooks/<key>/`: a
 * last-known copy of every workbook in the task folder and a small state file. The key is the task folder from the
 * hook command (`HookOptions.folder`, never `payload.cwd`) and the host, not the session, so two sessions working in one folder share one state and one task. The ledger, the
 * diff and the review page are the existing ones; this file only decides which ops to log and which files they name (it reads no format).
 *
 * Attribution, safe direction first. A change is credited only to calls open when a sweep finds it, jointly with
 * every one of them: at a Post (or PostToolUseFailure), or at a Pre that runs while other calls are open. With no
 * call open (a Pre, Stop, or a Post whose Pre was never seen or whose call expired) it is "not from an agent call": the
 * record never says a person made it, since an autosave or a sync client lands there too. No op names it, the round shows it
 * `unlogged`. An open call closes on its
 * Post, on its failure event, on Stop (its own session's), or 10 minutes after its Pre; a Bash call with
 * `run_in_background` skips the Post and stays open to Stop or expiry.
 *
 * Credit only on evidence: a call is credited only while nothing says it is done or could not have written the file. A call whose
 * tool_result is in its agent's transcript (read at every event) is credited by that event's sweep and no later one; one blocked by a
 * PreToolUse hook or denied is credited with nothing; a call whose work can outlive its result (background, `&`, nohup, osascript...) is
 * never closed that way. A tool that cannot write (WebFetch, WebSearch, ToolSearch, Skill, TodoWrite, read-only MCP tools, besides Read,
 * Glob, Grep and SendMessage) is never credited, nor an Agent launch while a call of its helper is open (credit-guard.ts). The open list
 * itself is never narrowed: a change no call may claim while calls were open reads "during agent calls", never "outside the agents".
 *
 * - Pre: sweeps (diffs every workbook against its copy, refreshes the copy), gives what moved to the open calls
 *   (hand edits when none is open), opens the call.
 * - Post / PostToolUseFailure: sweeps, logs one op per changed workbook (the host's tool name, `tool_use_id`,
 *   command plus description as intent) naming the changed file. A call that changes nothing logs an op with
 *   no file. Calls open at the same time share every change a Post finds while they overlap: each op names
 *   all of them in `jointWith` and in its intent.
 * - Stop: sweeps (hand edits), closes the session's open calls with only what other calls' Posts gave them
 *   jointly, then cuts the round (`TaskStore.submit`).
 *
 * Crash safety. A sweep never deletes a copy: it stages the new copy, points the state at it and lists the old
 * one as garbage. The state (with the ops still to log, the `outbox`) is written atomically; only then are the
 * ops written to the ledger and the garbage deleted. A kill between any two steps leaves a state the next
 * event can read: the sweep repeats (nothing was lost) or the outbox is flushed with a per-op key so no op is
 * logged twice. `HookOptions.fault` lets a test throw at a named step.
 *
 * Per-step file state. Every file in the task folder, of any type, is copied at the task's first event (under the
 * scan caps) into the task's store, `<home>/tasks/<id>/states/<sha256>`, whole and once per hash. A sweep stat-filters (size,
 * mtime, ctime, inode) and copies only what moved, with a full hash at Stop and at the Pre and Post of a call that names the file. A
 * sweep that changed any file queues one step row, written in the same flush as the ops of the calls open at that sweep, with
 * one state event per changed file (sha, previous sha, Pre/Post/Stop, calls open). The step's ledger id is the key ops and
 * states share; `state.seq` stays the idempotency key only. The last-known copy of a file is its newest stored state, so a sweep
 * never deletes one: size caps (25 MB a file, 1 GB a task) and the sign-off and expiry rules in `states.ts` do, and each says why.
 *
 * Unreadable files. A workbook that fails to parse at a sweep (half-written, corrupt) is a real state: its bytes are
 * kept, the state event says "could not read at this point", and its file-level change is credited to the calls open at that
 * sweep. The last readable copy stays the diff base and the file is read again at every sweep. At the first readable sweep, if
 * the hash is the unreadable state's own (the reader failed, not the file) the cell changes go to the calls that were open
 * when it was unreadable and to nobody else; if the hash moved in between, the change is joint with the calls open now and
 * labelled "changed while unreadable, during call X and after". A call that closed in between gets a late op. Never a hand
 * edit by default; a file repaired before the next sweep still leaves the unreadable state on the record.
 *
 * A workbook that appears after the first Pre is not baselined: the round reports it as a new
 * file, and the call whose Post sees it is credited with its cells. One that disappears is credited to the
 * call as a file-level change and shows as a row.
 *
 * Known limits: a hand edit made while an agent call is running is credited to that call (nothing in the
 * hook payloads tells them apart). A call that inserts rows or columns shifts cells the op recorded by their
 * new address, so a later shift is not followed. A workbook created before any workbook existed in the
 * folder has no task to log to until one is touched.
 */

const WALK_CAPPED = "(walk stopped at the entry cap)";

export type { HookHost } from "./normalize.ts";

/**
 * The fields of a host hook payload as the two hosts send it; both send more. Only `normalize` (normalize.ts) reads them: the hook is
 * hook-adapter.ts consume a NormalizedEvent, and `handleHook` is the wrapper that accepts a raw payload for callers that hold one.
 */
export interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  /**
   * Claude Code sends these on every hook that fires inside a subagent and leaves them out on the main thread (field names
   * read from the Claude Code 2.1.296 hook schema; no live payload has been captured). Codex sends neither, so its calls stay on the main line.
   */
  agent_id?: string;
  agent_type?: string;
  /** PostToolUseFailure only (Claude Code): the host's error text, e.g. "Exit code 3" plus the call's stderr. Its payload has no `tool_response`. */
  error?: string;
  /** PostToolUseFailure only: the call was stopped by the user, not failed by the tool. */
  is_interrupt?: boolean;
  /** PostToolUse: the tool's result. Read only for the host's own error flag (`is_error` / `isError` true), never for its content. */
  tool_response?: unknown;
  /** The host's session file (Claude Code's transcript, Codex's rollout); read only for narration, never for tool results or user text. */
  transcript_path?: string;
  /** Stop only, when the host sends it: the agent's final message. */
  last_assistant_message?: string;
  /** UserPromptSubmit only: the user's text. Claude Code's shape is recorded; Codex's is assumed to match (unverified). */
  prompt?: string;
}

export interface HookOptions {
  host: HookHost;
  /** The CoCheck home. The CLI resolves it with `resolveAdapterHome`; the adapter never defaults it. */
  home: string;
  /**
   * Which files a connector claims (the hook's one test, with no workbook layer in it). Absent: the connectors of
   * `home` (built-in and installed, per the type setting). Tests pass their own.
   */
  claimed?: Claimed;
  /** Test seam: why a claimed file's bytes are cut short (`cutShortReason` when absent). */
  cutShort?: (bytes: Uint8Array, file: string) => string | undefined;
  /**
   * The task folder: the `--folder` argument of the hook command, or `CLAUDE_PROJECT_DIR`. State is keyed on it and
   * workbooks are scanned in it; `payload.cwd` is never used, so an agent that cd's keeps one baseline.
   */
  folder: string;
  /**
   * Outside watching, default on. On: a workbook a call names outside `folder` is baselined at its Pre and diffed
   * at its Post, and every other outside path it names is recorded for the page. Off: nothing outside is copied, diffed
   * or named; the op keeps only a count of calls that touched outside paths.
   */
  outsideWatching?: boolean;
  /**
   * Default on: one task (and one state) per session. Off: one task and state per folder shared by every session
   * (tests of the shared-state rules use it; it is also the way back should per-session tasks need rolling back).
   */
  perSession?: boolean;
  /** Test seam: the path kit the credit guards compare with; defaults to the running platform's (`guardKit()`). A test passes the win32 kit on any OS. */
  guardKit?: PathKit;
  /** The clock in epoch ms; tests inject one to pass the 10-minute expiry. */
  now?: () => number;
  /** Test seam: the size and scan caps, which default to the ones in `states.ts` and `formats/files/scan.ts`. */
  caps?: { fileBytes?: number; taskBytes?: number; scanFiles?: number; scanBytes?: number; claimedFiles?: number; claimedBytes?: number; walkEntries?: number; pendingFiles?: number; parkedSessions?: number; parkedOps?: number };
  /** Where Codex keeps its session rollouts, used when the payload names no `transcript_path`. Defaults to `~/.codex/sessions`; tests point it at a temp tree. */
  codexSessions?: string;
  /** Test seam: called with a step name ("after-sweep", "after-save", "after-flush"); a throw simulates a kill there. */
  fault?: (step: string) => void;
  /**
   * The event is a held helper call replayed after its helper finished (a VS Code helper's calls wait for the link to the main session).
   * Its Pre only registers the call: the folder already holds what the helper wrote, so a sweep at the Pre would hand it to whoever else is
   * open. The Post's sweep credits it to the open calls, and the launcher is not among them while a call of its helper is.
   */
  heldReplay?: boolean;
  /** The per-call tag setting (`--attribution-tag`, `COCHECK_ATTRIBUTION_TAG`). `off`: no write evidence is read. Absent reads as `auto`. */
  attributionTag?: TagSetting;
  /** This Pre's call is tagged (the CLI prints its tag once the event is recorded). */
  taggedCall?: boolean;
}

export interface HookResult {
  /** Stop only: the round the turn closed, when the folder had workbooks. */
  summary?: SubmitSummary;
}

/** Calls open longer than this are dropped: their Post or failure event is not coming. */
const OPEN_EXPIRY_MS = 10 * 60_000;
/** How far before a call's Pre its transcript is read for its tool_result. */
const TRANSCRIPT_LOOKBACK_BYTES = 64 * 1024;

/** `p` with symlinks resolved as far as it exists, the rest appended: a path that does not exist yet still resolves through its real parent. */
interface ShellSeg {
  words: Array<{ text: string; redirect: boolean }>;
  /** Subshells `(` opened just before this segment. */
  enter: number;
  /** Subshells `)` closed just after this segment. */
  exit: number;
}

/**
 * A command's words, split into segments at `;`, `|`, `&` and newlines; quotes group, a redirect marks the next word.
 * A `(` at a word start opens a subshell and a `)` while one is open closes it; both are recorded on the segments.
 */
function shellSegments(text: string): ShellSeg[] {
  const segs: ShellSeg[] = [{ words: [], enter: 0, exit: 0 }];
  let depth = 0;
  const cur = () => segs[segs.length - 1]!;
  const fresh = () => {
    if (cur().words.length > 0 || cur().exit > 0) segs.push({ words: [], enter: 0, exit: 0 });
  };
  let word = "";
  let has = false;
  let redirect = false;
  let quote = "";
  const flush = () => {
    if (has) {
      cur().words.push({ text: word, redirect });
      redirect = false;
    }
    word = "";
    has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i]!;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i]!;
      has = true;
    } else if (c === ">" || c === "<") {
      if (/^\d+$/.test(word) || word === "&") {
        word = "";
        has = false;
      }
      flush();
      redirect = true;
    } else if (c === ";" || c === "|" || c === "&" || c === "\n") {
      flush();
      redirect = false;
      fresh();
    } else if (c === "(" && !has) {
      fresh();
      cur().enter++;
      depth++;
    } else if (c === ")" && depth > 0) {
      flush();
      cur().exit++;
      depth--;
    } else if (/\s/.test(c)) flush();
    else {
      word += c;
      has = true;
    }
  }
  flush();
  return segs;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The outside-watching setting: `--outside-watching on|off` wins over `COCHECK_OUTSIDE_WATCHING`; on when neither says off. */
export function parseOutsideWatching(argv: string[], env: NodeJS.ProcessEnv): boolean {
  const i = argv.indexOf("--outside-watching");
  const raw = (i >= 0 ? argv[i + 1] : env.COCHECK_OUTSIDE_WATCHING)?.trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

/** Never the default `~/.cocheck`, a symlink to it, or a path inside it: a probe or a test must not write into the real data directory. */
export function resolveAdapterHome(env: NodeJS.ProcessEnv, defaultHome: string): string {
  const home = env.COCHECK_HOME;
  if (!home) {
    throw new Error(`COCHECK_HOME is unset; the hook adapter refuses the default ${defaultHome}. Point COCHECK_HOME at a probe home.`);
  }
  const def = foldFolder(realish(defaultHome));
  for (const candidate of [foldFolder(realish(home)), foldFolder(path.resolve(home).normalize("NFC"))]) {
    if (isInsideFolded(candidate, def)) {
      throw new Error(`COCHECK_HOME ${home} is the default ${defaultHome} or inside it; the hook adapter refuses it. Point COCHECK_HOME at a probe home.`);
    }
  }
  return home;
}

/**
 * The tool_use_id of the call that launched a subagent. Claude Code writes `agent-<agent_id>.meta.json` in
 * `<transcript dir>/<session_id>/subagents/`; only its `toolUseId` field is read (as a plain id), never the agent's own transcript.
 * Any problem (no transcript path, no file, a link, too large, bad JSON, bad id) is no launcher.
 */
function agentLauncher(host: HookHost, transcriptPath: unknown, sessionId: string, agentId: string): string | undefined {
  const helpers = profileOf(host).helpers;
  if (helpers === undefined || typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) || cleanId(sessionId) === undefined) return undefined;
  return readLauncher(helpers.dirOf(transcriptPath, sessionId), agentId);
}

/** A changed file, as one op names it (no cells; the connector says what changed inside a claimed file). */
interface Entry {
  path: string;
  /** The tool_use_ids open when the change was seen. */
  with: string[];
  /** The `seq` of the step (sweep) that found the change. */
  step?: number;
  /** The call whose own Post saw the change; absent when a Pre or Stop saw it. */
  origin?: string;
  /** Set on the one entry of a file that is a byte-exact copy of an earlier state. */
  copyOf?: CopyClaim;
  /** The file's state in words, when it matters to the reader (cut short, or changed while cut short). */
  note?: string;
}

/** Appends without spreading: a spread of a large array overflows the call stack past about 125k items. */
function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

/** The tracker's stand-in for a directory it cannot resolve. Internal: never written to the page, ledger or state. */
const UNKNOWN_DIR_NAME = "\0cocheck-unknown-dir";
const isUnknownDir = (p: string): boolean => p.includes(UNKNOWN_DIR_NAME);

interface OpenCall {
  tool: string;
  named: string[];
  session: string;
  /** The Pre's command and description, which become the intent of whatever op the call ends up with. */
  command: string;
  description: string;
  /** The safe label taken from the tool input (absent in a held state from before it). */
  toolLabel?: ToolLabel;
  /** The subagent that made the call, when the hook payload names one. Absent means the main line. */
  agentId?: string;
  agentType?: string;
  /** The tool_use_id of the main-stream call that launched the agent, from the agent's `.meta.json`. Absent when the file is missing or unreadable. */
  launchToolUseId?: string;
  /** The launch above was found by the helper's own prompt link (not by being the only launch open). */
  linkedLaunch?: true;
  /** The main agent's latest request in this session when the call was seen (redacted, cut to a reason's length); only for a host whose narration is a reason source. Absent for a helper's call. */
  turnPrompt?: string;
  /** Epoch ms of the Pre. */
  at: number;
  /** A host whose hook stdin carries no call id: the profile's key of the call's arguments, which its Post is matched on (with the session and tool). */
  argsKey?: string;
  /** Set on a call kept in an unreadable state's owners once its failure event is recorded; it is credited with no later change. */
  failed?: true;
  /** The `state.seq` the Pre was stamped with, the call's place in the order it shares with requests (absent for a call whose Pre was not seen). */
  startSeq?: number;
  /** Paths outside the task folder the call names (outside watching on); capped. */
  outside?: string[];
  /** True when the call names no path at all (outside watching on). */
  pathUnknown?: boolean;
  /** Outside watching off: how many outside paths the call named. Their names are never kept. */
  outsideCount?: number;
  /** Outside watching on: the cwd, when the host ran the call outside the folder. */
  workedIn?: string;
  /** A Claude Code call with run_in_background: a Bash stays open past its Post, until Stop or expiry; an Agent/Task launcher does not, its agent's own calls carry its work. */
  background?: boolean;
  /** The files (absolute, inside the task folder) the call's own tool input names as write targets: a Write/Edit/create path, an apply_patch header. */
  writes?: string[];
  /** The absolute paths a host file-edit tool's own input reported (as written, inside the folder); absent for any other call and for a relative path. */
  edits?: string[];
  /** What the call's own input says it did to each file it names (`reportedEditsOf`); a file with none is never proven by this call. */
  reported?: ReportedEdit[];
  /** A patch tool's input as the adapter read it: shapes and counts only, never text or paths (kept so a patch that is not credited can be explained). */
  patchRead?: { input: string; quoted: boolean; cwd: string; named: number; inside: number; reported: number };
  /** A shell call whose command is a known read-only form with no redirect to a file, no writing pipe and no in-place flag: it never takes write credit. */
  readOnly?: true;
  /** The call waits on helpers (Copilot `read_agent` with `wait: true`); it writes nothing, so it never holds a helper's credit. */
  waits?: true;
  /** The agent's own words on the call, or "no narration recorded". Context for the reader: it never sets grouping or credit. */
  narration?: Narration;
  /** The transcript that will hold the call's tool_result, and where in it to start looking (its size at the Pre, less a margin). Claude Code only. */
  transcript?: { file: string; from: number };
  /** The transcript showed the call done (or never run). From then on it is credited with nothing, but the sweep at which this was seen. */
  ended?: CallEvidence;
  /** The call's command carries the per-call tag, so its Python and Node children's writes are recorded. */
  tagged?: true;
  /** Files positive write evidence credited to this call alone (or with its fellow writers), with the sweep's time; on its op. */
  provenWrites?: ProvenWrite[];
  /** Files (watched-folder-relative) whose stat moved at this call's Post sweep with the bytes of their last state: a same-bytes rewrite, noted on the op; no state is made for it. */
  sameBytes?: string[];
  /** The paths the call's command can write (attribution/write-scope.ts), read at its Pre from the command as it ran. */
  scope?: WriteScope;
  /** Writes and removals inside the folder its Python and Node children logged, and whether one started another program. */
  hookWrote?: number;
  hookSpawned?: true;
  /** Its children's start records (each loaded the hook and found the tag), one per pid; capped. */
  hookStarts?: StartRecord[];
}

/** An op decided but not yet in the ledger. `key` makes the write idempotent across a kill. */
/** Closed calls without words that wait for a late sentence, at most. */
const LATE_NARRATION_KEPT = 64;

interface OutboxOp {
  key: string;
  tool: string;
  args: Record<string, unknown>;
  intent: string;
  /** The call never ran (the host refused it, or it had a Pre and no Post at Stop); the ledger row is `TOOL_NOT_RUN`. */
  notRun?: boolean;
  /** The call ended in failure (the host's failure event or its error flag); the ledger row is `TOOL_FAILED` with `args.error` as its error text. */
  failed?: boolean;
  /** A session's first prompt: it opens the task when none is open, so the request shows before the first call. */
  opens?: true;
  /** The follow-up line the opening prompt carried, read from the typed text before it was cut. Checked against the ledger when the op is written. */
  follows?: { task: number; id: number; nonce: string };
}

interface State {
  /** path -> the last-known state: its stored copy (empty when only a fingerprint was kept), hash and stat. */
  files: Record<string, Tracked>;
  /** True once the workbooks present at the first event have been baselined; later arrivals are new files. */
  init: boolean;
  open: Record<string, OpenCall>;
  /** Changes a Post found while this call was also open, waiting for the call's own Post, by tool_use_id. */
  pending: Record<string, Entry[]>;
  seq: number;
  /** Copies the state no longer points at, deleted once the state that says so is saved. */
  garbage: string[];
  outbox: OutboxOp[];
  /** Recently closed tool_use_ids, so a late or repeated Post for one logs nothing more. */
  closed: string[];
  /** Tool_use_ids the expiry closed with no Post. A Post that comes later for one replaces the expiry outcome; any other late Post logs nothing more. */
  expired: string[];
  /** Closed calls whose op says "no narration recorded", by tool_use_id (newest last, capped). A later read of the session file that finds the call's words adds them as a record of their own. Absent until one is recorded. */
  lateNarr?: Record<string, { session: string; agentId?: string }>;
  /** Steps queued for the ledger, written in the flush that writes the ops. */
  stepOutbox: OutboxStep[];
  /** What a cap dropped from the held starting copy, unowned changes, parked ops or parked sessions, by the client it concerns (`*`: the folder). Written into the next task that opens (an op and a file note), then cleared. */
  dropNotes?: Record<string, string[]>;
  /** Ops of a session that has no task yet, kept (newest SESSION_OPS_KEPT) until its first credited change opens one; dropped with the session if it never writes. */
  parked?: Record<string, OutboxOp[]>;
  /** While no session has a task, the folder's starting copy and the changes nobody is credited with; the first task to open begins with them, as the one task of a folder did on main. */
  pendingStart?: { starts?: OutboxStep[]; unowned: OutboxStep[] };
  /** The session of every call seen (newest last, capped): a call that has closed is still known to belong to its session. */
  callSession?: Record<string, string>;
  /** Per open call, the steps (by `seq`) found while it was open; they become its op's `steps`. */
  callSteps: Record<string, number[]>;
  /** The step counter; the idempotency key of a step write (not `seq`, which keys the ops). */
  stepSeq: number;
  /** Stored states to delete (a per-file size cap), done after the state that lists them is saved. */
  drops: Array<{ sha: string; reason: string }>;
  /** Workbooks outside the task folder a call named while outside watching was on. */
  outside: string[];
  /** File states seen, by SHA-256 of their bytes (newest last, capped): a new workbook with these bytes is a copy. */
  seen: Record<string, { name: string; asOf: string }>;
  /** Per session, the prompts held for the round its calls will close (at most PROMPTS_KEPT, newest). */
  held: Record<string, Held>;
  /** Sessions that made a call since the last round closed. */
  called: string[];
  /** A host with no call id on stdin: per session, how many synthetic ids have been given (at most SESSIONS_KEPT sessions). */
  ordinals?: Record<string, number>;
  /** Sessions in which a helper made a call since the last main Stop (absent until one is). */
  helped?: string[];
  /** Per session, where the host's session file was last read to; at most SESSIONS_KEPT, oldest first out. */
  narr: Record<string, NarrationCursor>;
  /** Folders (relative to the watched folder, `/` separated) whose skip is already in the record: each is said once. Absent until one is recorded. */
  skipped?: string[];
  /** SHA-256 of every secret-named file's bytes seen in this task: a state with one of these hashes is secret whatever its name. Absent until one is recorded. */
  secretShas?: string[];
  /** Stored states to delete because their bytes turned out to be a secret's, done (and recorded in words) by `settleStore`. */
  purge?: string[];
  /** Positive write evidence from tagged Bash calls' children (attribution/evidence.ts). Absent until one is recorded. */
  writeEvidence?: EvidenceState;
  /** Tagged calls that closed, newest last (at most CLOSED_WRITERS_KEPT): a child of one may write after its Post, and its tag then credits the write to it. */
  closedWriters?: Record<string, OpenCall>;
  /**
   * App tails. A call whose command may leave an app running past its result
   * (`runsOnAfterResult`: osascript, `open`, `&`, nohup, setsid) stays a suspect after its Post for the files its command names, until the
   * same session's next call opens, the session's Stop, or `until` (the open-call expiry), whichever comes first.
   */
  tails?: Record<string, { call: OpenCall; until: number }>;
}

/**
 * A session's held prompts. `seqs`, `ats` and `firsts` run parallel to `prompts`: the `state.seq` each was stamped with at
 * submit (0 when the state predates the stamp), the wall time at submit, and the `stepSeq` of the first step this session queued
 * after it (null until one exists). A tracked session's first prompt opens its task and every typed prompt is written when submitted; the three are written on the prompt op.
 */
interface Held {
  prompts: string[];
  dropped: number;
  seqs?: number[];
  ats?: Array<number | "unknown">;
  firsts?: Array<number | null>;
  /** The highest stamp already logged at another session's round close. A call-less turn logs only the prompts past it, so a request is never logged twice. */
  logged?: number;
  /** The highest stamp already written to the ledger mid-round, before its round's first step. The round's close writes only the prompts past it. */
  early?: number;
}

/**
 * The claimed allowance. At the task's first event, files a connector claims are copied whole up to these caps, separate
 * from the general scan caps (500 files, 200 MB), which keep applying to every other file. Past them a claimed file is kept as its hash,
 * with the reason in words, never a hard stop; a call that names it later copies it at its Pre.
 */
const CLAIMED_ALLOWANCE_FILES = 2000;
const CLAIMED_ALLOWANCE_BYTES = 1024 * 1024 * 1024;

/** A tracked file's newest state. `kept` is "hash" when only a fingerprint was kept (over the scan caps). */
interface Tracked {
  copy: string;
  sha: string;
  size?: number;
  mtimeNs?: string;
  ino?: string;
  /** Status-change time. Unlike mtime a program cannot set it, so any write moves it: it keeps a same-mtime rewrite from passing the stat filter. */
  ctimeNs?: string;
  /** The hash of the file's first state in this task; a size cap never drops it. */
  first?: string;
  kept?: "whole" | "hash";
  /** The state's bytes are a secret's (by the file's name or by hash): never stored, previewed or shown. */
  secret?: true;
  /** Set while the file's newest state is bytes the layer could not read. `copy` and `sha` are those bytes. */
  unreadable?: Unreadable;
}

/**
 * An unreadable state, which is a real state: its bytes are kept and it is credited at the sweep that saw it. It remembers
 * the last readable state (`base`, the file the cells are diffed against later; null for a file that was never readable)
 * and every call that was open at a sweep that saw the file unreadable, with what the call's op needs, so the cells can go
 * to the call that made it even after it closed.
 */
interface Unreadable {
  reason: string;
  base: { copy: string; sha: string } | null;
  calls: Record<string, OpenCall>;
}

/** One changed file at one step, as the ledger records it. */
interface StateChange {
  path: string;
  sha: string;
  prev: string | null;
  size: number;
  kept: "whole" | "hash" | "gone";
  note: string;
  /** The file's modification time at the sweep (ns); absent for a deleted file and in records written before it was kept. */
  mtimeNs?: string;
  /** The calls this file's change is credited to; absent: the step's. A later readable sweep credits the calls that made the unreadable state. */
  credited?: string[];
  /** What the credit stands on, decided where the credit was (`creditBasisOf`); absent in a state saved before it existed. */
  basis?: ProofMethod;
}

interface OutboxStep {
  seq: number;
  phase: "Pre" | "Post" | "Stop";
  /** Calls open at the sweep: context only. */
  callsOpen: string[];
  /** The calls the sweep's change was credited to (the Pre or Post logic decided): empty for a baseline or a change nobody owns. */
  credited: string[];
  files: StateChange[];
  /** A starting copy: credited to nobody, never routed to a session's task (a task opened later takes its baseline from the files' earlier states). */
  baseline?: true;
}

const EMPTY_STATE: State = { files: {}, init: false, open: {}, pending: {}, seq: 0, garbage: [], outbox: [], stepOutbox: [], callSteps: {}, stepSeq: 0, drops: [], closed: [], expired: [], outside: [], seen: {}, held: {}, called: [], narr: {} };

/** File states remembered for copy matching; the oldest go first. */
const SEEN_KEPT = 64;

/** Longest request or narration kept as a row's fallback reason, in characters (the page cuts to its own length). */
const REASON_FALLBACK_MAX = 400;

/** Longest prompt kept on a round's op, in characters. */
const PROMPT_MAX = 8000;
/** The error text kept for a failed call, in characters; the ledger's own byte cap applies on top. */
const ERROR_TEXT_MAX = 2000;
/** Stored when the host reported a failure and sent no words. */
const FAILED_NO_TEXT = "The host reported a failure and sent no error text.";
/** A background launch of an agent is not a job that writes files: its work arrives through the agent's own hooked calls. */
/** A call whose only work is waiting on helpers (Codex `wait_agent`, Copilot `read_agent` with `wait: true`); it writes nothing, so it never shares a helper's credit. */
const isWaitCall = (c: { tool: string; waits?: true }): boolean => c.waits === true || isWaitTool(c.tool);

/** Most prompts a session keeps for a round; older ones are counted, not kept. */
const PROMPTS_KEPT = 3;
/** Sessions whose held prompts and called marks are kept; the session with the oldest held prompt goes first. */
const SESSIONS_KEPT = 20;

/** Files of the folder's pending starting copy and of its unowned changes held while no session has a task. */
const PENDING_FILES_KEPT = 5000;

/** Ops a session with no task yet keeps parked. */
const SESSION_OPS_KEPT = 64;

/** How many closed tool_use_ids the state remembers. */
const CLOSED_KEEP = 500;/** Tagged calls kept after their close, so a write their child makes later is credited to them. */
const CLOSED_WRITERS_KEPT = 64;
/** A closed call's write record credits a write found at most this long after the record (Stop can come minutes after a call). */
const LATE_WRITE_WINDOW_MS = 5 * 60_000;
/** App tails kept at once; the oldest goes first. */
const TAILS_KEPT = 64;
/** The side text of a change credited through an app tail. */
export const TAIL_NOTE = "found after the call that names it ended; credited to that call because the app it ran may still have been saving";

/** How a call ended, recorded on its op (`closedBy`) and shown in the review page's per-call drill-down. */
type ClosedBy = "post" | "failure" | "stop" | "expiry" | "ghost-post" | "late" | "refused";

/**
 * Throws unless `folder` is an absolute path to an existing directory. A wrong folder must fail loudly: scanning
 * nothing would log nothing and look like a quiet run. The CLI turns the throw into exit 1.
 */
function assertTaskFolder(folder: string): void {
  if (!path.isAbsolute(folder)) {
    throw new Error(`task folder "${folder}" is relative; pass an absolute path in --folder or CLAUDE_PROJECT_DIR`);
  }
  let stat;
  try {
    stat = statSync(folder);
  } catch {
    throw new Error(`task folder ${folder} does not exist; check --folder or CLAUDE_PROJECT_DIR`);
  }
  if (!stat.isDirectory()) throw new Error(`task folder ${folder} is not a directory; check --folder or CLAUDE_PROJECT_DIR`);
}

/**
 * A hook task's client, one per session: `<host>-hook:<folder>?session=<id>`. A resumed session keeps its id, so it stays in its task.
 * No usable session id (absent, empty, not a string): the folder-only name (the one `perSession: false` uses for every session).
 */
export function hookClientName(host: string, folder: string, session: unknown): string {
  const plain = typeof session === "string" ? session.trim().replace(/[^A-Za-z0-9_.-]/g, "_") : "";
  const id = plain.length > 128 ? `h-${createHash("sha256").update(plain).digest("hex").slice(0, 32)}` : plain;
  return id === "" ? `${host}-hook:${folder}` : `${host}-hook:${folder}${HOOK_SESSION_MARK}${id}`;
}

const stateKeyOf = (client: string): string => createHash("sha256").update(client).digest("hex").slice(0, 16);

/** Takes the host's raw payload: normalizes it with `options.host`, then `handleEvent`. */
export async function handleHook(payload: HookPayload, options: HookOptions): Promise<HookResult> {
  return handleEvent(normalize(options.host, payload), options);
}

export async function handleEvent(ev: NormalizedEvent, options: HookOptions): Promise<HookResult> {
  assertNormalized(ev);
  const { home } = options;
  const host = ev.host;
  assertTaskFolder(options.folder);
  const folder = realish(options.folder);
  // One observation state per folder (copies, baselines, open calls of every session, one lock); the task a session's work lands in is chosen when it is logged.
  const folderClient = `${host}-hook:${folder}`;
  const client = hookClientName(host, folder, options.perSession === false ? undefined : ev.session);
  const key = stateKeyOf(folderClient);
  const dir = path.join(home, "hooks", key);
  await mkdir(path.join(dir, "copies"), { recursive: true, mode: 0o700 });
  const startedAt = performance.now();
  // The tasks that got a pending file capture; the review process is nudged after the lock is let go, so a slow nudge never holds the folder.
  const captureTasks = new Set<number>();
  const result = await withFileLock(
    path.join(dir, "state.lock"),
    async () => {
      const ledger = openLedger(home);
      try {
        const claimed = options.claimed ?? claimedFor(home);
        const tasks = new TaskStore(ledger, home, [claimedLayer(claimed)]);
        const ctx = new Context(ev, { ...options, claimed }, folder, client, folderClient, dir, ledger, tasks);
        ctx.captureTasks = captureTasks;
        ctx.markStart(startedAt);
        await ctx.load();
        await ctx.recover();
        ctx.loadWriteEvidence();
        let submit = false;
        ctx.bindCall();
        switch (ev.kind) {
          case "tool-pre":
            await ctx.pre();
            break;
          case "tool-post":
          case "tool-failure":
            await ctx.post();
            break;
          case "stop":
            await ctx.stop();
            submit = true;
            break;
          case "subagent-stop":
            await ctx.subagentStop();
            break;
          case "prompt":
            await ctx.prompt();
            break;
          default:
            return {};
        }
        ctx.settleWriteEvidence();
        await ctx.save();
        options.fault?.("after-save");
        await ctx.flush(false);
        options.fault?.("after-flush");
        // An MCP call's input and response are kept (scanned, capped, sealed) in the task's store.
        if ((ev.kind === "tool-post" || ev.kind === "tool-failure") && typeof ev.toolName === "string" && ev.toolName.startsWith("mcp__") && typeof ev.toolUseId === "string" && ev.toolUseId !== "") {
          try {
            const keptTask = tasks.currentTaskId(client);
            if (keptTask !== undefined) await keepCallValues(home, keptTask, { call: ev.toolUseId, tool: ev.toolName, input: ev.toolInput, response: ev.toolResponse ?? (ev.failure === undefined ? undefined : { error: ev.failure.raw }) });
          } catch {
            // the call is recorded without its values; the hook's own work goes on
          }
        }
        await ctx.cleanup();
        await ctx.settleStore();
        return submit ? await ctx.submit() : {};
      } finally {
        ledger.close();
      }
    },
    STATE_LOCK_OPTIONS,
  );
  if (captureTasks.size > 0) await nudgeFileCapture(home, [...captureTasks]);
  return result;
}

/** Heartbeat: a hook that runs past staleMs is alive, so a waiter must not take its lock over and write state.json beside it. */
export const STATE_LOCK_OPTIONS = { staleMs: 60_000, timeoutMs: 60_000, heartbeatMs: 15_000, ownerOnly: true } as const;

/**
 * `cocheck track stop` ends the session's stretch of work. The switch removal drops the turn's own Stop (it arrives untracked), so
 * the hook writes one mark into the session's current task: the same effect on the live flag as a Stop. It records no prompt, no call and
 * no text, only the session and the time. A session with no task yet has nothing to end.
 */
export function markTrackingStopped(home: string, host: string, folder: string, session: string, now: () => number = Date.now): void {
  const client = hookClientName(host, realish(folder), session);
  const ledger = openLedger(home);
  try {
    const taskId = ledger.latestTaskForClient(client);
    if (taskId === undefined) return;
    ledger.recordOp({ taskId, tool: "hook", args: { hookOpKey: `tracking-stopped#${now()}`, hookAdapter: 1, hookEvent: "TrackingStopped", host, session_id: session, at: clockOrUnknown(now()) }, intent: "tracking stopped", clientName: client, durationMs: 0, resultCode: "OK" });
  } finally {
    ledger.close();
  }
}

/**
 * The ops of `sessionId` that are held, not yet in the ledger, because the session has no task yet (it made no change). Session coverage
 * counts them as recorded: the adapter has them, and they are written the moment the session's task opens. Empty when the folder has no state.
 */
export function parkedOpsOf(home: string, host: string, folder: string, sessionId: string): Array<{ toolUseId?: string; closedBy?: string }> {
  try {
    const dir = path.join(home, "hooks", stateKeyOf(`${host}-hook:${realish(folder)}`));
    const saved = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as { parked?: Record<string, OutboxOp[]> };
    return Object.values(saved.parked ?? {}).flat().filter((op) => op.args.session_id === sessionId).map((op) => ({
      ...(typeof op.args.tool_use_id === "string" ? { toolUseId: op.args.tool_use_id } : {}),
      ...(typeof op.args.closedBy === "string" ? { closedBy: op.args.closedBy } : {}),
    }));
  } catch {
    return [];
  }
}

/** An epoch-ms reading, or "unknown" when the clock gave nothing usable. */
function clockOrUnknown(ms: number): number | "unknown" {
  return Number.isFinite(ms) && ms > 0 ? ms : "unknown";
}

/** The ledger column is an integer NOT NULL: a known time is at least 1 ms, unknown is -1, never 0. -1 means unknown and must be excluded from any aggregate (an SQL AVG would count it as a number). */
function ledgerDurationOf(processingMs: unknown): number {
  return typeof processingMs === "number" && processingMs > 0 ? Math.max(1, Math.round(processingMs)) : -1;
}

/** `copyOf`: the workbook is new and holds exactly the bytes of a file state the adapter saw earlier; it has no rows. */
type Swept = {
  file: string;
  gone?: boolean;
  copyOf?: CopyClaim;
  /** The file was unreadable and now reads. Its cells belong to these calls (open at a sweep that saw it unreadable), even if closed. */
  owners?: string[];
  ownerCalls?: Record<string, OpenCall>;
  /** True: the hash is the unreadable state's own, so the cells are the owners' alone. False: it moved, so calls open now share them. */
  exact?: boolean;
  /** The state in words: "could not read at this point" or "changed while unreadable, during call X and after". */
  label?: string;
};

/** A file captured by a sweep. `fresh`: its bytes were new to the store. */
interface Staged {
  copy: string;
  sha: string;
  size: number;
  mtimeNs: string;
  ino: string;
  ctimeNs: string;
  fresh: boolean;
  kept: "whole" | "hash";
  /** The bytes are a secret's (the file's name, or the hash of a secret-named file's bytes): nothing was stored. */
  secret?: true;
  /** Why a file that could have been kept whole is a fingerprint only (it alone is past the task's disk budget). */
  hashReason?: string;
  /** Why the bytes are a secret's when the name is not: the text holds a value a gitleaks rule finds. */
  secretWhy?: string;
  /** A claimed file whose bytes are cut short (`cutShortReason`): why. Such a state is never a diff base. */
  cutShort?: string;
}

/** True when the path is itself a symbolic link (not followed). */
function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** What an op records about a copy it made: whose bytes, and when. The review checks the hash against the file it finds. */
interface CopyClaim {
  name: string;
  sha256: string;
  asOf: string;
}

class Context {
  #ev: NormalizedEvent;
  readonly #opts: HookOptions;
  /** Whether a connector claims a file, the hook's one generic predicate (read once per event). */
  readonly #claimed: Claimed;
  get #guardKit(): PathKit {
    return this.#opts.guardKit ?? guardKit();
  }
  readonly #folder: string;
  readonly #client: string;
  /** The folder-only client every session shared before the change; `#client` equals it for an event with no session id or with `perSession` off. */
  readonly #folderClient: string;
  /** Tasks are per session; false is the folder-only shape (every op to `#client`'s task, a task opened at the first event). */
  readonly #split: boolean;
  readonly #dir: string;
  readonly #ledger: Ledger;
  readonly #tasks: TaskStore;
  #state: State = structuredClone(EMPTY_STATE);
  #startedAt = performance.now();
  /** The outbox was emptied since the last save, so the saved state still lists ops that are in the ledger. */
  #flushed = false;
  /** The `seq` of the step the latest sweep queued, if it changed any file. */
  #lastStep: number | undefined;
  /** Files the current sweep found rewritten with the bytes they already had (stat moved, hash equal), as relative paths. */
  #rewrites = new Set<string>();
  /** This Stop's own sweep found no change. */
  #stopSweptNothing = false;
  /** A new state was written to the store in this event, so the per-task cap is checked. */
  #storedNew = false;
  #tmpN = 0;
  /** Files whose write evidence a sweep used in this event, dropped from the state before it is saved. */
  #evidenceUsed = new Set<string>();

  constructor(ev: NormalizedEvent, opts: HookOptions, folder: string, client: string, folderClient: string, dir: string, ledger: Ledger, tasks: TaskStore) {
    this.#ev = ev;
    this.#folderClient = folderClient;
    this.#split = client !== folderClient;
    this.#opts = opts;
    this.#claimed = opts.claimed ?? claimedFor(opts.home);
    this.#folder = folder;
    this.#client = client;
    this.#dir = dir;
    this.#ledger = ledger;
    this.#tasks = tasks;
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  /** Monotonic ms since the event began (to 0.01 ms), or "unknown" if the monotonic clock misbehaves. Never 0. */
  #processingMs(): number | "unknown" {
    const ms = performance.now() - this.#startedAt;
    return Number.isFinite(ms) && ms >= 0 ? Math.max(0.01, Math.round(ms * 100) / 100) : "unknown";
  }

  /**
   * A host whose hook stdin carries no call id (its profile has `calls`): gives the event one. At a Pre, the id the host's session file
   * names for the same tool and arguments (oldest not yet claimed), else a synthetic per-session ordinal. At a Post or failure, the oldest
   * open call of the same session, tool and arguments; none open leaves the event without an id, which credits nothing to any call.
   */
  bindCall(): void {
    const calls = profileOf(this.#ev.host).calls;
    const kind = this.#ev.kind;
    const { session, toolName } = this.#ev;
    if (calls === undefined || this.#ev.toolUseId || (kind !== "tool-pre" && kind !== "tool-post" && kind !== "tool-failure")) return;
    if (typeof session !== "string" || typeof toolName !== "string") return;
    const key = calls.argsKey(this.#ev.toolInput);
    let id: string | undefined;
    // A Pre that found no request (the host had not flushed it yet) took a synthetic id; once the request is in the file the call takes its real id.
    this.#rebindOpen(session);
    if (kind === "tool-pre") {
      const taken = new Set([...Object.keys(this.#state.open), ...this.#state.closed, ...this.#state.expired]);
      id = claimRequest(this.#narrationCursor(), toolName, key, taken);
      if (id === undefined) {
        const ordinals = (this.#state.ordinals ??= {});
        const n = (ordinals[session] ?? 0) + 1;
        delete ordinals[session];
        ordinals[session] = n;
        for (const old of Object.keys(ordinals).slice(0, -SESSIONS_KEPT)) delete ordinals[old];
        id = calls.syntheticId(session, n);
      }
    } else {
      // A helper's Post joins its own Pre, never another agent's open call of the same tool and arguments.
      const agent = cleanId(this.#ev.agentId);
      const open = Object.entries(this.#state.open).filter(([, c]) => c.session === session && c.tool === toolName && c.argsKey === key && c.agentId === agent);
      open.sort((a, b) => (a[1].startSeq ?? 0) - (b[1].startSeq ?? 0));
      id = open[0]?.[0];
    }
    if (id !== undefined) this.#ev = { ...this.#ev, toolUseId: id };
  }

  /**
   * Every open call of `session` that still holds a synthetic id (oldest first) takes the real id of the unclaimed request
   * for its tool and arguments, if the file holds one now. Run at every Pre, Post and failure before a step is written, so no step
   * is written with a synthetic id once the real one is knowable.
   */
  #rebindOpen(session: string): void {
    const cursor = this.#narrationCursor();
    if (cursor === undefined) return;
    const open = Object.entries(this.#state.open).filter(([id, c]) => c.session === session && c.argsKey !== undefined && !(id in cursor.byId));
    open.sort((a, b) => (a[1].startSeq ?? 0) - (b[1].startSeq ?? 0));
    for (const [id, c] of open) {
      const taken = new Set([...Object.keys(this.#state.open), ...this.#state.closed, ...this.#state.expired]);
      const real = claimRequest(cursor, c.tool, c.argsKey!, taken);
      if (real !== undefined) this.#rename(id, real);
    }
  }

  /** Moves everything keyed by or naming the call `id` to `real`: the open call, its entries and steps, the steps queued, the unreadable states' owners. */
  #rename(id: string, real: string): void {
    const state = this.#state;
    const move = <T>(m: Record<string, T>): void => {
      if (id in m) {
        m[real] = m[id]!;
        delete m[id];
      }
    };
    const swap = (list: string[]): string[] => [...new Set(list.map((x) => (x === id ? real : x)))].sort();
    move(state.open);
    move(state.pending);
    move(state.callSteps);
    if (state.callSession !== undefined) move(state.callSession);
    for (const list of Object.values(state.pending)) for (const e of list) e.with = swap(e.with);
    for (const step of state.stepOutbox) {
      step.callsOpen = swap(step.callsOpen);
      if (step.credited !== undefined) step.credited = swap(step.credited);
      for (const f of step.files) if (f.credited !== undefined) f.credited = swap(f.credited);
    }
    for (const f of Object.values(state.files)) if (f.unreadable !== undefined) move(f.unreadable.calls);
  }

  /** Called by handleHook as the event starts, so lock wait and ledger open count as adapter time. */
  markStart(mark: number): void {
    this.#startedAt = mark;
  }

  async load(): Promise<void> {
    try {
      this.#state = { ...structuredClone(EMPTY_STATE), ...JSON.parse(await readFile(path.join(this.#dir, "state.json"), "utf8")) };
      // Hand-edit tracking is not done here; a state saved by an earlier build may still carry the field, which goes on the next save.
      delete (this.#state as State & { handEdits?: unknown }).handEdits;
    } catch {
      this.#state = structuredClone(EMPTY_STATE);
    }
  }

  /**
   * Makes good what a killed event left: ops saved but not logged are logged (once), garbage the state no longer
   * references is deleted, and so are copies no state ever pointed at (staged by a sweep that died before its save).
   */
  async recover(): Promise<void> {
    await this.flush(true);
    await this.cleanup();
    await this.#adoptCopies();
    const keep = new Set(Object.values(this.#state.files).flatMap((f) => [path.basename(f.copy), ...(f.unreadable?.base ? [path.basename(f.unreadable.base.copy)] : [])]));
    // The states a waiting starting copy and the unowned changes held for the first task name stay until that task opens.
    for (const step of [...(this.#state.pendingStart?.starts ?? []), ...(this.#state.pendingStart?.unowned ?? [])]) {
      for (const f of step.files) for (const sha of [f.sha, f.prev]) if (sha) keep.add(sha);
    }
    for (const name of await readdir(path.join(this.#dir, "copies")).catch(() => [] as string[])) {
      if (!keep.has(name)) await rm(path.join(this.#dir, "copies", name), { force: true });
    }
    // A copy a killed event had staged but never listed: it was written under a temporary name.
    for (const name of await readdir(this.#storeDir()).catch(() => [] as string[])) {
      if (name.startsWith(".tmp-")) await rm(path.join(this.#storeDir(), name), { force: true });
    }
    await this.settleStore();
  }

  /** The folder the next copy goes to: the task's store, or (no open task yet) the folder-keyed holding folder. */
  #storeDir(): string {
    // With per-session tasks every copy goes to the folder's one holding place; a task's store gets its copies when its steps are written.
    if (this.#split) return path.join(this.#dir, "copies");
    const taskId = this.#tasks.currentTaskId(this.#client);
    return taskId === undefined ? path.join(this.#dir, "copies") : storeDirOf(this.#opts.home, taskId);
  }

  /** Moves last-known copies held in the folder-keyed holding place (`hooks/<key>/copies`, used before a task opens) into the task's store, named by hash. */
  async #adoptCopies(): Promise<void> {
    if (this.#split) return;
    const taskId = this.#tasks.currentTaskId(this.#client);
    if (taskId === undefined) return;
    const store = storeDirOf(this.#opts.home, taskId);
    let moved = false;
    for (const tracked of Object.values(this.#state.files)) {
      if (tracked.copy === "" || path.dirname(tracked.copy) === store || !existsSync(tracked.copy)) continue;
      await ensureStoreDir(this.#opts.home, taskId);
      const target = path.join(store, tracked.sha);
      if (!existsSync(target)) {
        // An old copy is plaintext (or already sealed): either way the target is ciphertext, written whole or not at all.
        const old = await readFile(tracked.copy);
        await writeSealed(target, hasSealHeader(old) ? openBytes(old, tracked.copy, this.#opts.home) : old);
      }
      this.#state.garbage.push(tracked.copy);
      tracked.copy = target;
      moved = true;
    }
    if (moved) {
      await this.save();
      await this.cleanup();
    }
  }

  /**
   * Applies the size caps to the store: deletes the states queued by the per-file cap, then, if the task's store is past
   * the per-task cap, the oldest states that are neither a file's first nor its current one. Each deletion is recorded
   * with its reason first, so the page can say it.
   */
  async settleStore(): Promise<void> {
    // With per-session tasks the stored states are in each task's own store, so the caps are kept for every open task of the folder, not only this event's.
    const taskIds = this.#split ? [...new Set(this.#openClients().flatMap((c) => this.#tasks.currentTaskId(c) ?? []))] : [this.#tasks.currentTaskId(this.#client)].flatMap((id) => (id === undefined ? [] : [id]));
    const purge = this.#state.purge ?? [];
    if (purge.length > 0) {
      // Bytes that turned out to be a secret's: deleted from every place a copy goes, with their previews, and the removal said in words.
      const dirs = [path.join(this.#dir, "copies"), this.#storeDir(), ...taskIds.map((id) => storeDirOf(this.#opts.home, id)), ...(this.#split ? this.#ledger.tasksForFamily(this.#folderClient).map((id) => storeDirOf(this.#opts.home, id)) : [])];
      for (const sha of purge) for (const dir of new Set(dirs)) await rm(path.join(dir, sha), { force: true });
      if (taskIds.length > 0) {
        for (const taskId of taskIds) {
          this.#ledger.recordStateRemovals(taskId, purge.map((sha256) => ({ sha256, reason: "these bytes are those of a secret file, so the stored copy and its previews were deleted and only the hash is kept" })));
          await removePreviews(this.#opts.home, taskId, purge);
        }
        this.#state.purge = [];
        await this.save();
      }
    }
    if (taskIds.length === 0) return;
    const home = this.#opts.home;
    const alive = new Set<string>();
    for (const t of Object.values(this.#state.files)) {
      alive.add(t.sha);
      if (t.first !== undefined) alive.add(t.first);
      if (t.unreadable?.base) alive.add(t.unreadable.base.sha);
    }
    const remove = async (taskId: number, shas: string[], reason: string): Promise<void> => {
      if (shas.length === 0) return;
      this.#ledger.recordStateRemovals(taskId, shas.map((sha256) => ({ sha256, reason })));
      for (const sha of shas) await rm(path.join(storeDirOf(home, taskId), sha), { force: true });
      await removePreviews(home, taskId, shas);
      if (storedShas(home, taskId).size === 0) removeEmptyStoreDir(home, taskId);
    };
    if (this.#state.drops.length > 0) {
      const byReason = new Map<string, string[]>();
      for (const d of this.#state.drops) if (!alive.has(d.sha)) byReason.set(d.reason, [...(byReason.get(d.reason) ?? []), d.sha]);
      for (const taskId of taskIds) {
        for (const [reason, shas] of byReason) await remove(taskId, this.#split ? shas.filter((sha) => existsSync(path.join(storeDirOf(home, taskId), sha))) : shas, reason);
      }
      this.#state.drops = [];
      await this.save();
    }
    if (!this.#storedNew) return;
    const cap = this.#opts.caps?.taskBytes ?? TASK_STORE_CAP_BYTES;
    for (const taskId of taskIds) {
      const stored = storedShas(home, taskId);
      // A state whose change list the review process has not captured yet is never evicted, neither side of it: once its
      // bytes go, that step's change list is lost for good. The budget stays over until the capture lands or fails; it never stops the task.
      const uncaptured = new Set<string>();
      for (const row of this.#ledger.fileStatesForTask(taskId)) {
        if (row.capture !== "pending") continue;
        uncaptured.add(row.sha256);
        if (row.prevSha256 !== null) uncaptured.add(row.prevSha256);
      }
      let total = [...stored.values()].reduce((a, b) => a + b, 0);
      if (total <= cap) continue;
      const doomed: string[] = [];
      // The order states go in. Middle states only (a file's first and current are alive): the largest unclaimed files first,
      // then the other unclaimed ones, and files a connector claims last (`claimed(file)`, no extension list), each tier oldest first.
      const office = (p: string): boolean => this.#claimed(p);
      const seen = new Set<string>();
      const candidates: Array<{ sha: string; size: number; office: boolean; at: number }> = [];
      for (const row of this.#ledger.fileStatesForTask(taskId)) {
        const size = stored.get(row.sha256);
        if (size === undefined || alive.has(row.sha256) || uncaptured.has(row.sha256) || row.kept !== "whole" || seen.has(row.sha256)) continue;
        seen.add(row.sha256);
        candidates.push({ sha: row.sha256, size, office: office(row.filePath), at: candidates.length });
      }
      candidates.sort((x, y) => Number(x.office) - Number(y.office) || (x.office ? 0 : y.size - x.size) || x.at - y.at);
      for (const c of candidates) {
        if (total <= cap) break;
        stored.delete(c.sha);
        doomed.push(c.sha);
        total -= c.size;
      }
      await remove(taskId, doomed, `this task's stored file states passed ${mbText(cap)}: the states between each file's first and current one were deleted, largest files no connector reads first and files a connector reads last, and only their hashes are kept`);
      if (total <= cap) continue;
      // Still over with every middle state gone. A file's first and current states go next, largest first, unclaimed files before
      // claimed ones. The current state of a claimed file stays on disk until its next state lands, so its connector can compare it.
      const ends: Array<{ sha: string; size: number; office: boolean }> = [];
      const taken = new Set<string>();
      const live = new Set<string>();
      for (const [file, t] of Object.entries(this.#state.files)) if (this.#claimed(file) || t.unreadable !== undefined) live.add(t.sha);
      for (const [file, t] of Object.entries(this.#state.files)) {
        for (const sha of [t.first, t.sha]) {
          if (sha === undefined || taken.has(sha) || t.secret === true) continue;
          const size = stored.get(sha);
          if (size === undefined || live.has(sha) || uncaptured.has(sha) || sha === t.unreadable?.base?.sha) continue;
          taken.add(sha);
          ends.push({ sha, size, office: office(file) });
        }
      }
      ends.sort((x, y) => Number(x.office) - Number(y.office) || y.size - x.size);
      const gone: string[] = [];
      for (const e of ends) {
        if (total <= cap) break;
        gone.push(e.sha);
        total -= e.size;
      }
      if (gone.length === 0) continue;
      await remove(taskId, gone, `this task's stored file states still passed ${mbText(cap)} after the states between were deleted, so a first or current state was deleted too, largest files no connector reads first and files a connector reads last, and only its hash is kept (the current state of a file a connector reads stays until its next state is saved, so it can be compared)`);
      const goneSet = new Set(gone);
      for (const t of Object.values(this.#state.files)) if (goneSet.has(t.sha) && t.copy !== "") t.copy = "";
      await this.save();
    }
  }

  async save(): Promise<void> {
    const file = path.join(this.#dir, "state.json");
    await writeFile(`${file}.tmp`, JSON.stringify(this.#state), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    this.#flushed = false;
  }

  /** The tasks this hook wrote a pending file capture into; the review process is nudged to read them once the hook's work is done. */
  captureTasks = new Set<number>();

  /**
   * Writes the outbox to the ledger. `dedupe`: the outbox came off disk, so some of it may already be there.
   * With per-session tasks each op goes to the task of the session that owns it, and each step to the sessions its changes are credited to.
   */
  async flush(dedupe: boolean): Promise<void> {
    if (this.#state.outbox.length === 0 && this.#state.stepOutbox.length === 0) return;
    if (!this.#split) {
      await this.#writeTo(this.#client, this.#tasks.currentTaskId(this.#client), this.#state.stepOutbox, this.#state.outbox, dedupe);
    } else {
      await this.#route(dedupe);
    }
    this.#state.outbox = [];
    this.#state.stepOutbox = [];
    this.#flushed = true;
  }

  /** The session an op belongs to: the one its args name, else the event's. */
  #sessionOfOp(op: OutboxOp): string {
    const s = op.args.session_id;
    return typeof s === "string" ? s : this.#ev.session;
  }

  /** The session a call belongs to, closed or not (undefined when the record of it is gone). */
  #sessionOfCall(id: string): string | undefined {
    return this.#state.open[id]?.session ?? this.#state.callSession?.[id];
  }

  /** Remembers which session a call belongs to, for as long as the record of it may be asked about (newest CLOSED_KEEP). */
  #noteSession(id: string, session: string): void {
    const map = (this.#state.callSession ??= {});
    if (map[id] === session) return;
    delete map[id];
    map[id] = session;
    for (const old of Object.keys(map).slice(0, -CLOSED_KEEP)) delete map[old];
  }

  /** The client whose task a call is logged in: its session's. */
  #clientOfCall(id: string): string | undefined {
    const session = this.#sessionOfCall(id);
    return session === undefined ? undefined : this.#clientOf(session);
  }

  #clientOf(session: string): string {
    return hookClientName(this.#ev.host, this.#folder, session);
  }

  /** An op that records a change to a file: it opens its session's task. A call that changed nothing, a prompt or a claim does not. */
  #opChanges(op: OutboxOp): boolean {
    return typeof op.args.path === "string";
  }

  /**
   * The routing. An op goes to the task of its own session (a call's op, a joint one too: each call has its own op naming the
   * calls it shared the change with). A step goes to the sessions of the calls its changes are credited to. A change credited to no
   * call (the user in Excel, an outside process) goes to every session of the folder that has an open task; with no task anywhere
   * it waits in `pendingStart`, and the first task to open begins with the folder's starting copy and those changes, which is what
   * the one task of a folder recorded on main (it started at the first event). A session with no task yet keeps its ops parked
   * until its first credited change opens one, and its task then starts with them. A joint change also writes a stub op for each
   * call of another session, so the page shows that call as "another session" instead of a call it has no record of.
   */
  async #route(dedupe: boolean): Promise<void> {
    const state = this.#state;
    const work = new Map<string, { steps: OutboxStep[]; ops: OutboxOp[] }>();
    const slot = (client: string) => work.get(client) ?? (work.set(client, { steps: [], ops: [] }), work.get(client)!);
    for (const op of state.outbox) slot(this.#clientOf(this.#sessionOfOp(op))).ops.push(op);
    const pending = (state.pendingStart ??= { unowned: [] });
    const pendingCap = this.#opts.caps?.pendingFiles ?? PENDING_FILES_KEPT;
    const opsCap = this.#opts.caps?.parkedOps ?? SESSION_OPS_KEPT;
    const sessionsCap = this.#opts.caps?.parkedSessions ?? SESSIONS_KEPT;
    const openClients = this.#openClients();
    for (const step of state.stepOutbox) {
      if (step.baseline === true) {
        // A starting copy: the folder's first waits for the first task; a later one (an outside workbook a call names) goes to the calls' sessions, or waits with the first.
        const callers = [...new Set(step.callsOpen.flatMap((id) => this.#clientOfCall(id) ?? []))].filter((c) => openClients.includes(c));
        if (callers.length > 0) for (const client of callers) slot(client).steps.push(step);
        else if (openClients.length === 0) {
          const held = (pending.starts ??= []);
          if (held.reduce((n, x) => n + x.files.length, 0) + step.files.length <= pendingCap) held.push(step);
          else this.#drop("*", `the folder's starting copy of ${step.files.length} files was too large to hold before a task opened (limit ${pendingCap} files); this task's starting copy is rebuilt from the files as they stood before its first change`);
        }
        continue;
      }
      const per = new Map<string, StateChange[]>();
      const unowned: StateChange[] = [];
      for (const f of step.files) {
        const credited = f.credited ?? step.credited;
        const owners = [...new Set(credited.flatMap((id) => this.#clientOfCall(id) ?? []))];
        const clients = owners.length > 0 ? owners : openClients;
        if (clients.length === 0) unowned.push(f);
        for (const client of clients) per.set(client, [...(per.get(client) ?? []), f]);
      }
      for (const [client, files] of per) slot(client).steps.push({ ...step, files });
      if (unowned.length > 0) {
        if (pending.unowned.length < pendingCap) pending.unowned.push({ ...step, files: unowned });
        else this.#drop("*", `${unowned.length} changes nobody's agent made were found before a task opened and not kept (limit ${pendingCap} held changes): ${unowned.slice(0, 3).map((f) => this.#rel(f.path)).join(", ")}${unowned.length > 3 ? ", ..." : ""}`);
      }
    }
    const parked = (state.parked ??= {});
    for (const [client, w] of work) {
      let taskId = this.#tasks.currentTaskId(client);
      const changes = w.steps.length > 0 || w.ops.some((op) => this.#opChanges(op) || op.opens === true);
      let ops = w.ops;
      let steps = w.steps;
      if (taskId === undefined) {
        if (!changes) {
          const keep = [...(parked[client] ?? [])];
          for (const op of ops) if (!keep.some((k) => k.key === op.key)) keep.push(op);
          delete parked[client];
          parked[client] = keep.slice(-opsCap);
          if (keep.length > opsCap) this.#drop(client, `${keep.length - opsCap} earlier calls and prompts of this session were dropped before its task opened (only the newest ${opsCap} are kept)`);
          continue;
        }
        // The task begins with the folder's starting copy (the one taken at the first event, else the files as they stood before this change) and what changed unowned since.
        const held = pending.starts ?? [];
        const first = held.length > 0 || pending.unowned.length > 0;
        const start = held.length > 0 ? held : [this.#startStep(steps)].flatMap((x) => (x === undefined ? [] : [x]));
        steps = [...start, ...(first ? pending.unowned : []), ...steps];
        taskId = await this.#openTask(client, steps);
        ops = [...(parked[client] ?? []).filter((p) => !ops.some((o) => o.key === p.key)), ...ops];
        delete parked[client];
        delete pending.starts;
        pending.unowned = [];
        // What the caps dropped while this task could not yet hold it is said in the task itself: an op, and on the first file's state.
        const notes = [...(state.dropNotes?.[client] ?? []), ...(state.dropNotes?.["*"] ?? [])];
        if (state.dropNotes !== undefined) (delete state.dropNotes[client], delete state.dropNotes["*"]);
        if (notes.length > 0) {
          const first = steps.find((x) => x.files.length > 0);
          if (first !== undefined) first.files = first.files.map((f, i) => (i === 0 ? { ...f, note: [f.note, `held record dropped: ${notes.join("; ")}`].filter((x) => x).join("; ") } : f));
          ops = [{ key: `dropped#${++state.seq}`, tool: "hook", args: { hookAdapter: 1, hookEvent: "Dropped", host: this.#ev.host, session_id: this.#ev.session, notes }, intent: "held record dropped before this task opened" }, ...ops];
        }
      }
      await this.#materialize(taskId, steps);
      const stubs = this.#otherSessionCalls(client, steps, ops);
      await this.#writeTo(client, taskId, steps, [...stubs, ...ops], dedupe);
    }
    const evicted = Object.keys(parked).slice(0, Math.max(0, Object.keys(parked).length - sessionsCap));
    for (const client of evicted) {
      this.#drop("*", `a session's ${parked[client]!.length} parked calls were dropped before any task opened for it (only the newest ${sessionsCap} sessions are kept)`);
      delete parked[client];
    }
  }

  /** Remembers that a cap dropped something held for `key` (a client, or `*` for the folder), to say so in the next task that opens (at most 20 notes). */
  #drop(key: string, text: string): void {
    const notes = ((this.#state.dropNotes ??= {})[key] ??= []);
    if (notes.length < 20) notes.push(text);
    else if (notes.length === 20) notes.push("more drops followed and are not listed");
  }

  /** The clients of this folder (the folder-only one included) that have an open task now. */
  #openClients(): string[] {
    const out = new Set<string>();
    for (const id of this.#ledger.tasksForFamily(this.#folderClient)) {
      const client = this.#ledger.taskClient(id);
      if (typeof client === "string" && this.#tasks.currentTaskId(client) !== undefined) out.add(client);
    }
    return [...out];
  }

  /**
   * The starting copy of a task that opens after the folder's first: every tracked file as it stood before this task's first change
   * (a file the steps change at its `prev`, a file they create not at all), so the task's first states link to it.
   */
  #startStep(steps: OutboxStep[]): OutboxStep | undefined {
    const before = new Map<string, string | null>();
    for (const step of steps) for (const f of step.files) if (!before.has(f.path)) before.set(f.path, f.prev);
    const files: StateChange[] = [];
    for (const [file, t] of Object.entries(this.#state.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const sha = before.has(file) ? before.get(file)! : t.sha;
      if (sha === null || t.secret === true) continue;
      files.push({ path: file, sha, prev: null, size: t.size ?? 0, kept: t.kept ?? "whole", note: "" });
    }
    if (files.length === 0) return undefined;
    return { seq: ++this.#state.stepSeq, phase: "Pre", callsOpen: [], credited: [], files, baseline: true };
  }

  /**
   * Opens `client`'s task at its first credited change. Each changed file joins it with the baseline it had before the change (the stored
   * copy of that state, or "missing" for a file the change created), so the task's first round compares with the right bytes.
   */
  async #openTask(client: string, steps: OutboxStep[]): Promise<number> {
    let taskId: number | undefined;
    // The state a file had before the task's own steps changed it: the first step that changes it names it (null: the change created it). A starting copy names none.
    const before = new Map<string, string | null | undefined>();
    const changedSeen = new Set<string>();
    for (const step of steps) for (const f of step.files) if (!before.has(f.path) || (step.baseline !== true && before.get(f.path) === undefined && !changedSeen.has(f.path))) {
      if (step.baseline === true) before.set(f.path, undefined);
      else (before.set(f.path, f.prev), changedSeen.add(f.path));
    }
    const seen = new Set<string>();
    for (const step of steps) {
      for (const f of step.files) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        if (f.kept === "gone") continue;
        const prev = before.get(f.path);
        let source: string | undefined;
        let temp: string | undefined;
        if (prev !== null && prev !== undefined) {
          const copy = this.#findCopy(prev);
          if (copy !== undefined) {
            temp = path.join(this.#dir, `.base-${process.pid}-${++this.#tmpN}`);
            await mkdir(temp, { recursive: true, mode: 0o700 });
            source = path.join(temp, path.basename(f.path));
            const bytes = await readFile(copy);
            await writeFile(source, hasSealHeader(bytes) ? openBytes(bytes, copy, this.#opts.home) : bytes, { mode: 0o600 });
          }
        }
        try {
          taskId = await this.#tasks.touch(client, f.path, prev === null ? { missing: true } : source === undefined ? undefined : { source });
        } finally {
          if (temp !== undefined) await rm(temp, { recursive: true, force: true });
        }
      }
    }
    if (taskId === undefined) taskId = await this.#tasks.touch(client, [...Object.keys(this.#state.files)][0] ?? this.#folder);
    return taskId;
  }

  /** Where the stored bytes with this hash are: the holding place, or the store of any task of this folder. */
  #findCopy(sha: string): string | undefined {
    const dirs = [path.join(this.#dir, "copies"), ...this.#ledger.tasksForFamily(this.#folderClient).map((id) => storeDirOf(this.#opts.home, id))];
    for (const dir of dirs) {
      const file = path.join(dir, sha);
      if (existsSync(file)) return file;
    }
    return undefined;
  }

  /** Puts the stored states a task's steps name into the task's own store (a copy of the bytes, already ciphertext), so the page reads them there. */
  async #materialize(taskId: number, steps: OutboxStep[]): Promise<void> {
    const store = storeDirOf(this.#opts.home, taskId);
    for (const step of steps) {
      for (const f of step.files) {
        if (f.kept !== "whole") continue;
        for (const sha of [f.sha, f.prev]) {
          if (!sha || existsSync(path.join(store, sha))) continue;
          const from = this.#findCopy(sha);
          if (from === undefined) continue;
          await ensureStoreDir(this.#opts.home, taskId);
          await copyFile(from, path.join(store, sha));
          await chmod(path.join(store, sha), 0o600).catch(() => {});
          this.#storedNew = true;
        }
      }
    }
  }

  /**
   * The ops that stand in for the calls of other sessions a change was shared with: no words of theirs, only that a call of another session
   * overlapped. One per call per task (the key makes it once).
   */
  #otherSessionCalls(client: string, steps: OutboxStep[], ops: OutboxOp[]): OutboxOp[] {
    const ids = new Set<string>();
    for (const step of steps) for (const id of step.credited) ids.add(id);
    for (const op of ops) if (Array.isArray(op.args.jointWith)) for (const id of op.args.jointWith as unknown[]) if (typeof id === "string") ids.add(id);
    const out: OutboxOp[] = [];
    for (const id of [...ids].sort()) {
      const owner = this.#sessionOfCall(id);
      if (owner === undefined || this.#clientOfCall(id) === client) continue;
      out.push({
        key: `other#${id}`,
        tool: "hook",
        args: { hookAdapter: 1, hookEvent: "OtherSessionCall", tool_use_id: id, closedBy: "post", host: this.#ev.host, session_id: owner, tool_name: "another session", jointWith: [id], steps: [], namedFiles: [], ownPaths: [], description: "", anotherSession: true },
        intent: "a call from another session",
      });
    }
    return out;
  }

  /** Writes `steps` and `ops` to the ledger under `client`, in `taskId` (none: nothing is written, as before). */
  async #writeTo(client: string, taskId: number | undefined, steps: OutboxStep[], ops: OutboxOp[], dedupe: boolean): Promise<void> {
    if (taskId === undefined) return;
    // Steps first: an op names the ledger id of the step it was credited at. Both writes are idempotent across a kill.
    const stepIds = new Map<number, number>();
    const connectorOf = connectorClaimsFor(this.#opts.home, builtinClaims());
    for (const step of steps) {
      // A change to a connector-claimed file is recorded with the connector's identity and a pending capture. The hook never starts the
      // connector: the review process reads the change list from the sealed sides and freezes it (file-capture.ts settleFileCapture).
      const captured = new Map<string, FileCapture>();
      if (!step.baseline) {
        for (const f of step.files) {
          const id = connectorOf(f.path);
          if (id === undefined || (f.kept !== "whole" && f.kept !== "gone")) continue;
          const identity = fileConnectorIdentity(this.#opts.home, id);
          if (identity !== undefined) captured.set(f.path, identity);
        }
      }
      const files = step.files.map((f) => {
        const credited = f.credited ?? step.credited ?? [];
        // A change nobody is credited with is not from a person either: nothing in the hook payloads says who made it.
        const unowned = f.prev === null || credited.length > 0 ? "" : step.callsOpen.length === 0 ? "not from an agent call" : "calls were still open, but none can be shown to have made it";
        const connector = connectorOf(f.path);
        return { filePath: f.path, sha256: f.sha, prevSha256: f.prev, size: f.size, kept: f.kept, note: [f.note, unowned].filter((x) => x).join("; "), credited, ...(connector === undefined ? {} : { connector }), ...(captured.has(f.path) ? { ...captured.get(f.path)!, capturePending: true } : {}), ...(f.mtimeNs === undefined ? {} : { mtimeNs: f.mtimeNs }), ...(f.basis !== undefined ? { creditBasis: f.basis } : credited.length === 0 ? { creditBasis: "unattributed" as const } : {}) };
      });
      stepIds.set(step.seq, this.#ledger.recordStep({ taskId, client, seq: step.seq, phase: step.phase, callsOpen: step.callsOpen, credited: step.credited ?? [], files }));
      if (captured.size > 0) this.captureTasks.add(taskId);
    }
    const idOf = (seq: number): number[] => {
      const id = stepIds.get(seq) ?? this.#ledger.stepIdBySeq(taskId, client, seq);
      return id === undefined ? [] : [id];
    };
    const known = dedupe || ops.some((o) => o.key.startsWith("other#")) ? new Set(this.#ledger.okOpsForTask(taskId, 0, this.#ledger.maxOpId()).map((o) => opKeyOf(o.argsJson))) : new Set<string | undefined>();
    for (const op of ops) {
      if (known.has(op.key)) continue;
      // The key goes first: when the ledger cuts oversized args to a stand-in, the first 1 KB survives as its preview.
      const seqs = Array.isArray(op.args.steps) ? (op.args.steps as number[]) : undefined;
      const proven = Array.isArray(op.args.provenWrites) ? (op.args.provenWrites as ProvenWrite[]) : undefined;
      const requests = Array.isArray(op.args.requests) ? (op.args.requests as Array<{ seq: number; at: number | "unknown"; firstStepSeq: number | null }>) : undefined;
      const args = {
        ...op.args,
        ...(seqs === undefined ? {} : { steps: seqs.flatMap(idOf) }),
        // Each proven write names the ledger id of the step it was found at, as `steps` does.
        ...(proven === undefined ? {} : { provenWrites: proven.flatMap((w) => idOf(w.step).map((id) => ({ path: w.path, step: id }))) }),
        // Each request names the ledger id of the first step written after it in its session, null when none exists.
        ...(requests === undefined ? {} : { requests: requests.map((r) => ({ seq: r.seq, at: r.at, firstStep: r.firstStepSeq === null ? null : (idOf(r.firstStepSeq)[0] ?? null) })) }),
      };
      this.#ledger.recordOp({ taskId, tool: op.tool || "hook", args: { hookOpKey: op.key, ...args }, intent: op.intent, clientName: client, durationMs: ledgerDurationOf(op.args.processingMs), resultCode: op.failed ? TOOL_FAILED : op.notRun ? TOOL_NOT_RUN : "OK", ...(op.failed ? { errorText: typeof op.args.error === "string" ? op.args.error : FAILED_NO_TEXT } : {}) });
      if (op.opens === true && op.follows !== undefined) this.#link(taskId, client, op.follows);
    }
  }

  /**
   * The task opened with a follow-up line. It is linked to the send-back only when the line is true: the send-back exists, the line's
   * task and nonce are the recorded ones, it was made on another task, and that task's folder is this task's folder. Anything else writes nothing.
   * Only the link is written: the send-back's own task and the two tasks' clients are untouched.
   */
  #link(taskId: number, client: string, mark: { task: number; id: number; nonce: string }): void {
    const sb = this.#ledger.originById(mark.id);
    if (sb === undefined || sb.nonce === null || sb.nonce !== mark.nonce || sb.taskId !== mark.task || sb.taskId === taskId) return;
    const there = hookFolderOf(this.#ledger.taskClient(sb.taskId));
    const here = hookFolderOf(client);
    if (there === null || here === null) return;
    const kit = pathKit();
    if (normalizePathForCompare(kit.native(there)) !== normalizePathForCompare(kit.native(here))) return;
    this.#ledger.appendFollow(taskId, sb.id);
  }

  /** Deletes the garbage copies, then saves the state without them. Runs only after a save that lists them. */
  async cleanup(): Promise<void> {
    if (this.#state.garbage.length === 0 && !this.#flushed) return;
    for (const copy of this.#state.garbage) await rm(copy, { force: true });
    this.#state.garbage = [];
    await this.save();
  }

  #on(): boolean {
    return this.#opts.outsideWatching !== false;
  }

  #isOutside(p: string): boolean {
    const kit = pathKit();
    const f = normalizePathForCompare(kit.native(this.#folder));
    const q = normalizePathForCompare(kit.native(p));
    return !kit.same(q, f) && !kit.inside(f, q);
  }

  /** The payload's cwd when it is absolute, else the task folder (a relative path means where the host ran it). */
  #cwd(): string {
    return this.#ev.cwd && path.isAbsolute(this.#ev.cwd) ? this.#ev.cwd : this.#folder;
  }

  /**
   * Every path-like token the call names, resolved against the working directory in effect where the token sits: the
   * payload's cwd, moved by `cd`, `pushd` and `git -C` inside the command (a subshell's `cd` does not leak out). Path
   * fields of the input, and the words of its strings (absolute, `~`, `.`, `..`, `./x`, `../x`, `a/b`, `*.xlsx`,
   * redirect targets). `raw` is the token as written. A cp/mv destination that is a directory contributes the source
   * names inside it. `unknown` is set when a token or a directory is built from a variable the payload cannot resolve.
   * `cwds` is every working directory the call was in; `outsideWords` the words written while it was outside.
   */
  #scan(input: unknown = this.#ev.toolInput): { items: Array<{ raw: string; abs: string }>; unknown: boolean; cwds: string[]; outsideWords: Set<string> } {
    const start = this.#cwd();
    const items: Array<{ raw: string; abs: string }> = [];
    const cwds = [start];
    const outsideWords = new Set<string>();
    let unknown = false;
    // A directory the command cannot resolve is treated as outside: nothing built on it can be shown to be inside.
    // An internal value only; #touch turns it into `unknown`, so it never reaches the page, ledger or state.
    const UNKNOWN_DIR = path.join(path.parse(start).root, UNKNOWN_DIR_NAME);
    const resolveIn = (cwd: string, t: string): string | undefined => {
      if (/^\$\{?HOME\}?(?=\/|$)/.test(t)) t = t.replace(/^\$\{?HOME\}?/, "~");
      if (t.includes("$") || t.includes("`")) {
        unknown = true;
        return undefined;
      }
      if (t === "~" || t.startsWith("~/")) return realish(path.join(homedir(), t.slice(2)));
      return realish(pathKit().isAbs(t) ? pathKit().native(t) : path.resolve(cwd, t));
    };
    const addIn = (cwd: string, raw: string, force = false) => {
      const t = /^\.+$/.test(raw) ? raw : raw.replace(/[.,:;]+$/, "");
      if (t === "" || t.startsWith("/dev/") || t === "/dev" || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return;
      const pathLike = force || t === "~" || t === "." || t === ".." || t.includes("/") || /\.xls[xm]$/i.test(t);
      if (!pathLike) return;
      const abs = cwd === UNKNOWN_DIR && !pathKit().isAbs(t) && t !== "~" && !t.startsWith("~/") ? UNKNOWN_DIR : resolveIn(cwd, t);
      if (abs !== undefined) items.push({ raw: t, abs });
    };
    const strings: string[] = [];
    const walk = (v: unknown, key = ""): void => {
      if (typeof v === "string") {
        if (/^(file_?path|path|notebook_?path)$/i.test(key)) addIn(start, v, true);
        else strings.push(v);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(input);
    // The directory a `cd` / `pushd` / `git -C` argument names, from `cwd`; UNKNOWN_DIR when it cannot be resolved.
    const moveTo = (cwd: string, arg: string | undefined): string => {
      if (arg === undefined) return realish(homedir());
      if (arg === "-") {
        unknown = true;
        return UNKNOWN_DIR;
      }
      const abs = cwd === UNKNOWN_DIR && !pathKit().isAbs(arg) && !arg.startsWith("~") ? undefined : resolveIn(cwd, arg);
      if (abs === undefined) {
        unknown = true;
        return UNKNOWN_DIR;
      }
      return abs;
    };
    for (const text of strings) {
      let cwd = start;
      const stack: string[] = [];
      for (const seg of shellSegments(text)) {
        for (let k = 0; k < seg.enter; k++) stack.push(cwd);
        const words = seg.words;
        const plain = words.filter((w) => !w.redirect && !w.text.startsWith("-")).map((w) => w.text);
        // `git -C dir ...` runs this segment in dir; `cd` / `pushd` move every later segment.
        let segCwd = cwd;
        if (plain[0] === "git") {
          const ci = words.findIndex((w) => w.text === "-C");
          if (ci >= 0 && words[ci + 1]) segCwd = moveTo(cwd, words[ci + 1]!.text);
        }
        if (!cwds.includes(segCwd)) cwds.push(segCwd);
        const outsideHere = this.#isOutside(segCwd);
        words.forEach((w, wi) => {
          if (outsideHere && wi > 0) outsideWords.add(w.text);
          // A flag is skipped unless it carries a value (`--out=/x`).
          if (!w.text.startsWith("-")) addIn(segCwd, w.text, w.redirect);
          else if (w.text.includes("=")) addIn(segCwd, w.text.slice(w.text.indexOf("=") + 1));
          // Paths written inside a longer word (code in quotes, `Path(x)`).
          for (const m of w.text.matchAll(/(?<![\w.~:\/$}-])((?:~|\.{1,2})?\/[^\s'"`;|&<>(){}\[\],=*?\\]+)/g)) addIn(segCwd, m[1]!);
          for (const m of w.text.matchAll(/(?<![\w.~:\/$}-])((?:\.\.?\/)?[\w@+-][\w@+.-]*(?:\/[\w@+.-]+)+|[\w@+.-]+\.xls[xm])(?![\w\/])/gi)) addIn(segCwd, m[1]!);
        });
        // cp/mv: a destination that is a directory (`..`, `~`, an existing directory, a trailing slash) receives the sources by name.
        if ((plain[0] === "cp" || plain[0] === "mv") && plain.length >= 3) {
          const dest = plain[plain.length - 1]!;
          const destAbs = segCwd === UNKNOWN_DIR && !pathKit().isAbs(dest) ? UNKNOWN_DIR : resolveIn(segCwd, dest);
          if (destAbs !== undefined && (dest.endsWith("/") || dest === ".." || dest === "." || dest === "~" || isDir(destAbs))) {
            for (const src of plain.slice(1, -1)) if (!src.includes("$")) items.push({ raw: dest, abs: realish(path.join(destAbs, path.basename(src))) });
          }
        }
        if (plain[0] === "cd" || plain[0] === "pushd") {
          cwd = moveTo(cwd, plain[1]);
          if (!cwds.includes(cwd)) cwds.push(cwd);
        }
        for (let k = 0; k < seg.exit; k++) cwd = stack.pop() ?? cwd;
      }
    }
    // An apply_patch header names its file whole, spaces included; the word scan above cuts it at each space, so the pieces (a folder the call
    // never touched, a path made relative to the cwd) are dropped and the header's own path is taken instead. A Windows header (`C:\Users\...`)
    // is taken whole too: the word scan reads each backslash as a shell escape, so the path it records names no real file.
    for (const h of writeTargetsOf(this.#ev.toolName, input)) {
      if (!/[\s\\]/.test(h) ||!(pathKit().isAbs(h) || h.startsWith("~/"))) continue;
      const pieces = new Set(h.split(/\s+/).map((w) => w.replace(/[.,:;]+$/, "")));
      for (let k = items.length - 1; k >= 0; k--) if (pieces.has(items[k]!.raw)) items.splice(k, 1);
      addIn(start, h, true);
    }
    return { items, unknown, cwds, outsideWords };
  }

  /** Every path the call names, resolved; the cwd is not one of them (the page says where the agent worked, once). */
  #refs(): string[] {
    return [...new Set(this.#scan().items.map((i) => i.abs))].filter((r) => !isUnknownDir(r));
  }

  /**
   * The one definition of "touched outside": the call's working directory at any point (payload, `cd`, `pushd`,
   * `git -C`) is outside the folder, or a path token, resolved against the directory in effect where it sits, is.
   * Counting, listing and redaction all follow from this.
   */
  #touch(): { touched: boolean; paths: string[]; outsideCwds: string[]; unknown: boolean; refs: string[]; words: Set<string>; raws: Set<string>; hidden: number } {
    const scan = this.#scan();
    const allRefs = [...new Set(scan.items.map((i) => i.abs))];
    // A path or directory that is the marker is "path unknown": still outside-or-unknown, never listed.
    const hidden = allRefs.filter(isUnknownDir).length + (scan.cwds.some(isUnknownDir) ? 1 : 0);
    const refs = allRefs.filter((r) => !isUnknownDir(r));
    const paths = refs.filter((r) => this.#isOutside(r));
    const outsideCwds = scan.cwds.filter((c) => !isUnknownDir(c) && this.#isOutside(c));
    const raws = new Set(scan.items.filter((i) => !isUnknownDir(i.abs) && this.#isOutside(i.abs)).map((i) => i.raw));
    return { touched: paths.length > 0 || outsideCwds.length > 0 || hidden > 0, paths, outsideCwds, unknown: scan.unknown || hidden > 0, refs, words: scan.outsideWords, raws, hidden };
  }

  /** What the call's op records about its outside reach, for the page. */
  #reach(): Pick<OpenCall, "outside" | "pathUnknown" | "outsideCount" | "workedIn"> {
    const t = this.#touch();
    if (!this.#on()) return t.touched ? { outsideCount: Math.max(1, t.paths.length + t.hidden) } : {};
    const worked = t.outsideCwds[0];
    return {
      ...(t.paths.length > 0 ? { outside: t.paths.slice(0, 25) } : {}),
      ...(t.unknown || t.refs.length === 0 ? { pathUnknown: true } : {}),
      ...(worked !== undefined ? { workedIn: realish(worked) } : {}),
    };
  }

  /** Outside watching off: the text with every outside path token, and every word written from an outside directory, replaced. */
  #redact(text: string): string {
    if (this.#on() || text === "") return text;
    const t = this.#touch();
    const raws = new Set([...t.raws, ...t.words]);
    let out = text;
    for (const raw of [...raws].sort((x, y) => y.length - x.length)) {
      if (raw === "") continue;
      const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(String.raw`(?<![\w./~$-])${esc}(?![\w./-])`, "g"), "[outside path]");
    }
    return out;
  }

  /**
   * Every file under the task folder the watch tracks, any type, subfolders included: `whole` are copied; `hashOnly` are
   * past the scan caps (500 files, 200 MB across the tree, as `scanFolder` has them) and keep a fingerprint only, with the reason
   * in words; `secret` are secret files by name, which keep a hash and a size and never count against the caps. `skipped` are
   * the version-control and dependency folders not entered, relative to the folder. A symbolic link is never followed. Files a
   * connector claims have their own allowance (`CLAIMED_ALLOWANCE_FILES`, `CLAIMED_ALLOWANCE_BYTES`) and never use up the
   * scan caps of the other files.
   */
  #listing(): { whole: string[]; hashOnly: Map<string, string>; secret: string[]; skipped: string[]; capped: boolean } {
    const maxEntries = this.#opts.caps?.walkEntries ?? MAX_WALK_ENTRIES;
    let seen = 0;
    let capped = false;
    const maxFiles = this.#opts.caps?.scanFiles ?? MAX_FOLDER_FILES;
    const maxBytes = this.#opts.caps?.scanBytes ?? MAX_FOLDER_BYTES;
    const found: Array<{ file: string; size: number }> = [];
    const secret: string[] = [];
    const skipped: string[] = [];
    // The CoCheck data home is CoCheck's own wherever it sits (a home inside the watched folder holds sealed states and Open before copies): never entered, no skip note. Matched by device and inode, so a link or case alias of it is the same folder.
    let homeId: { dev: number; ino: number } | undefined;
    try {
      const h = statSync(this.#opts.home);
      homeId = { dev: h.dev, ino: h.ino };
    } catch {
      // no home folder yet: nothing to skip
    }
    const isHome = (full: string): boolean => {
      if (homeId === undefined) return false;
      try {
        const st = lstatSync(full);
        return st.dev === homeId.dev && st.ino === homeId.ino;
      } catch {
        return false;
      }
    };
    const walk = (dir: string): void => {
      if (capped) return;
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // unreadable folder: nothing to track in it this sweep
      }
      for (const entry of entries) {
        if (++seen > maxEntries) {
          capped = true;
          return;
        }
        const full = path.join(dir, entry.name);
        // lstat semantics throughout: a symbolic link, to a file or a folder, is not followed, so bytes outside the folder are never read into the store.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (isHome(full)) continue;
          if (dir === this.#folder && entry.name === DELIVERY_FOLDER) continue; // CoCheck's own delivery copies: not watched, no skip note
          if (SKIPPED_FOLDERS.has(entry.name) || isPythonEnvironment(full)) skipped.push(this.#rel(full));
          else walk(full);
          continue;
        }
        if (!isWatchedFolderFile(full)) continue;
        try {
          const st = lstatSync(full);
          if (!st.isFile()) continue;
          if (isSecretPath(entry.name)) secret.push(full.normalize("NFC"));
          else found.push({ file: full.normalize("NFC"), size: st.size });
        } catch {
          // gone between the listing and the stat
        }
      }
    };
    walk(this.#folder);
    const byName = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
    found.sort((x, y) => byName(x.file, y.file));
    const whole: string[] = [];
    const hashOnly = new Map<string, string>();
    let bytes = 0;
    let files = 0;
    const claimedFiles = this.#opts.caps?.claimedFiles ?? CLAIMED_ALLOWANCE_FILES;
    const claimedMax = this.#opts.caps?.claimedBytes ?? CLAIMED_ALLOWANCE_BYTES;
    let claimedBytes = 0;
    let claimedCount = 0;
    for (const { file, size } of found) {
      if (this.#claimed(file)) {
        // A connector claims it: its own allowance, so its connector has both sides of a later change, re-saves included.
        if (size > claimedMax) hashOnly.set(file, `not copied: it is ${mbText(size)}, over the ${mbText(claimedMax)} kept for files a connector reads, so only its hash is kept`);
        else if (claimedCount >= claimedFiles) hashOnly.set(file, `not copied: the folder has more than ${claimedFiles} files a connector reads, so only this file's hash is kept`);
        else if (claimedBytes + size > claimedMax) hashOnly.set(file, `not copied: the folder holds more than ${mbText(claimedMax)} of files a connector reads, so only this file's hash is kept`);
        else {
          whole.push(file);
          claimedBytes += size;
          claimedCount += 1;
        }
        continue;
      }
      if (size > maxBytes) hashOnly.set(file, `not copied: it is ${mbText(size)}, over the ${mbText(maxBytes)} watch limit, so only its fingerprint is kept`);
      else if (files >= maxFiles) hashOnly.set(file, `not copied: the folder has more than ${maxFiles} files, so only this file's fingerprint is kept`);
      else if (bytes + size > maxBytes) hashOnly.set(file, `not copied: the folder holds more than ${mbText(maxBytes)}, so only this file's fingerprint is kept`);
      else {
        whole.push(file);
        bytes += size;
        files += 1;
      }
    }
    return { whole, hashOnly, secret: secret.sort(byName), skipped: skipped.sort(byName), capped };
  }

  /** A path under the watched folder, relative to it and `/` separated: how the record names a file or folder in words. */
  #rel(file: string): string {
    return pathKit().rel(this.#folder, file) ?? path.relative(this.#folder, file).split(path.sep).join("/");
  }

  /** Whether `file` is inside the watched folder (not the folder itself). */
  #inFolder(file: string): boolean {
    return pathKit().inside(this.#folder, file);
  }

  /** A secret file by name, inside the watched folder: its bytes are never copied, previewed, diffed or read past the hash. */
  #isSecret(file: string): boolean {
    return this.#inFolder(file) && isSecretPath(this.#rel(file));
  }

  /**
   * "A secret file was changed: <relative path>" for a secret file, then `rest`; the plain `rest` for any other file. The line
   * names the file and nothing of what is in it.
   */
  #noted(file: string, rest: string, bytes = false, why?: string): string {
    if (this.#isSecret(file)) return [secretLine(this.#rel(file)), rest].filter((x) => x).join("; ");
    if (!bytes) return rest;
    const name = this.#inFolder(file) ? this.#rel(file) : path.basename(file);
    return [secretLine(name), why ?? "its bytes are those of a secret file, so only its hash and size are kept", rest].filter((x) => x).join("; ");
  }

  /** What replaced a tracked file by a link, if anything: the file itself or a folder it sits in. Not followed at any depth. */
  #linkOnPath(file: string, cache: Map<string, boolean>): "file" | "folder" | undefined {
    if (!this.#inFolder(file)) return undefined;
    if (isSymlink(file)) return "file";
    for (let dir = path.dirname(file); dir !== this.#folder && this.#inFolder(dir); dir = path.dirname(dir)) {
      let link = cache.get(dir);
      if (link === undefined) {
        link = isSymlink(dir);
        cache.set(dir, link);
      }
      if (link) return "folder";
    }
    return undefined;
  }

  /** Each skipped folder is said once in the record, in words (an op of its own: it belongs to no call and no file). */
  #saySkips(skipped: string[], capped = false): void {
    if (capped && !(this.#state.skipped ??= []).includes(WALK_CAPPED)) {
      this.#state.skipped.push(WALK_CAPPED);
      this.#state.outbox.push({
        key: `skip#${++this.#state.seq}`,
        tool: "hook",
        args: { hookAdapter: 1, hookEvent: "Skip", host: this.#ev.host, session_id: this.#ev.session, skipped: [{ folder: WALK_CAPPED, note: `CoCheck stopped listing the folder after ${this.#opts.caps?.walkEntries ?? MAX_WALK_ENTRIES} entries, so files past that point are not tracked; open the session in a smaller project folder` }] },
        intent: "folders not watched",
      });
    }
    const said = (this.#state.skipped ??= []);
    const fresh = skipped.filter((d) => !said.includes(d));
    if (fresh.length === 0) return;
    said.push(...fresh);
    this.#state.outbox.push({
      key: `skip#${++this.#state.seq}`,
      tool: "hook",
      args: {
        hookAdapter: 1,
        hookEvent: "Skip",
        host: this.#ev.host,
        session_id: this.#ev.session,
        skipped: fresh.map((folder) => ({ folder, note: `${folder} was skipped: CoCheck does not watch version-control, dependency or environment folders (a Python environment is found by its pyvenv.cfg or conda-meta), so nothing in it is copied or tracked` })),
      },
      intent: "folders not watched",
    });
  }

  /** The event's place in a step row: Pre, Post (a failure counts) or Stop. */
  #phase(): "Pre" | "Post" | "Stop" {
    const k = this.#ev.kind;
    return k === "tool-pre" || k === "prompt" ? "Pre" : k === "stop" || k === "subagent-stop" ? "Stop" : "Post";
  }

  /** The first event only: joins every workbook present to the task (baseline snapshot) and copies every watched file; a folder with no workbook starts a task all the same. */
  async #baseline(): Promise<void> {
    if (this.#state.init) return;
    const listing = this.#listing();
    const books = [...listing.whole, ...listing.hashOnly.keys()].filter((f) => this.#claimed(f));
    // With per-session tasks no task opens here: a session's task opens at its first credited change, from the states this baseline copies.
    if (!this.#split) {
      for (const file of books) await this.#tasks.touch(this.#client, file);
      // No workbook is not an error: the task opens on any file of the folder (or the folder itself when it is empty), and every file is tracked like any other.
      if (books.length === 0) await this.#tasks.touch(this.#client, [...listing.whole, ...listing.hashOnly.keys(), ...listing.secret][0] ?? this.#folder);
    }
    const changes: StateChange[] = [];
    for (const file of [...listing.whole, ...listing.hashOnly.keys(), ...listing.secret].sort()) {
      const note = listing.hashOnly.get(file);
      const secret = this.#isSecret(file);
      let st: BigIntStats;
      try {
        st = statSync(file, { bigint: true });
      } catch {
        continue; // gone since the listing
      }
      try {
        const staged = await this.#capture(file, st, note !== undefined, secret);
        this.#state.files[file] = { copy: staged.copy, sha: staged.sha, size: staged.size, mtimeNs: staged.mtimeNs, ino: staged.ino, ctimeNs: staged.ctimeNs, first: staged.sha, kept: staged.kept, ...(staged.secret ? { secret: true as const } : {}) };
        changes.push({
          path: file,
          sha: staged.sha,
          prev: null,
          size: staged.size,
          kept: staged.kept,
          mtimeNs: staged.mtimeNs,
          note: secret ? `A secret file is in the folder: ${this.#rel(file)}; only its hash and size are kept` : staged.secret ? this.#noted(file, "", true, staged.secretWhy) : [note ?? staged.hashReason, this.#sizeNote(staged.size)].filter((x) => x).join("; "),
        });
        if (this.#claimed(file)) this.#remember(file, staged.sha, "the start of the task");
      } catch (error) {
        // A claimed file whose copy fails at the start is kept as its hash, with the reason in words, and the task goes on.
        // Any other file is simply not tracked yet.
        if (!this.#claimed(file)) continue;
        let sha: string;
        try {
          sha = await sha256Stream(file);
        } catch {
          continue; // not even readable now: not tracked yet, like any other file
        }
        const why = `not copied: the copy at the start of the task failed (${error instanceof Error ? error.message : String(error)}), so only its hash is kept`;
        this.#state.files[file] = { copy: "", sha, size: Number(st.size), mtimeNs: String(st.mtimeNs), ino: String(st.ino), ctimeNs: String(st.ctimeNs), first: sha, kept: "hash" };
        changes.push({ path: file, sha, prev: null, size: Number(st.size), kept: "hash", mtimeNs: String(st.mtimeNs), note: why });
        this.#remember(file, sha, "the start of the task");
      }
    }
    this.#queueStep(changes, [], true);
    this.#saySkips(listing.skipped, listing.capped);
    this.#state.init = true;
  }

  /** Outside watching on: a workbook this call names outside the folder joins the task now, before the call can write it. */
  async #baselineOutside(): Promise<void> {
    if (!this.#on()) return;
    const changes: StateChange[] = [];
    for (const ref of this.#refs()) {
      if (!this.#isOutside(ref) || !this.#claimed(ref) || this.#state.outside.includes(ref)) continue;
      if (!this.#split) await this.#tasks.touch(this.#client, ref);
      this.#state.outside.push(ref);
      if (existsSync(ref)) {
        const st = statSync(ref, { bigint: true });
        const staged = await this.#capture(ref, st, false);
        this.#state.files[ref] = { copy: staged.copy, sha: staged.sha, size: staged.size, mtimeNs: staged.mtimeNs, ino: staged.ino, ctimeNs: staged.ctimeNs, first: staged.sha, kept: staged.kept, ...(staged.secret ? { secret: true as const } : {}) };
        changes.push({ path: ref, sha: staged.sha, prev: null, size: staged.size, kept: staged.kept, note: staged.secret ? this.#noted(ref, "", true, staged.secretWhy) : this.#sizeNote(staged.size), mtimeNs: staged.mtimeNs });
        if (!staged.secret) this.#remember(ref, staged.sha, this.#asOf());
      }
    }
    this.#queueStep(changes, Object.keys(this.#state.open).sort(), true);
  }

  /** Notes the bytes of a file state, so a later new workbook holding exactly them is recognised as a copy. */
  #remember(file: string, sha: string, asOf: string): void {
    if (sha in this.#state.seen) return;
    this.#state.seen[sha] = { name: path.basename(file), asOf };
    const keys = Object.keys(this.#state.seen);
    for (const k of keys.slice(0, Math.max(0, keys.length - SEEN_KEPT))) delete this.#state.seen[k];
  }

  /** Where in the task a sweep's state sits, for "copy of x as of ...". */
  #asOf(): string {
    const id = this.#ev.toolUseId;
    if (!id) return "the end of the round";
    return this.#ev.kind === "tool-pre" ? `before call ${id}` : `call ${id}`;
  }

  /** The words a state over the per-file cap carries on its event. */
  #sizeNote(size: number): string {
    const cap = this.#opts.caps?.fileBytes ?? STATE_FILE_CAP_BYTES;
    return size > cap ? `over ${mbText(cap)} (${mbText(size)}): only this file's first and current state are kept, the states between are hashes only` : "";
  }

  /**
   * Queues one step for the changes a sweep found, if any; `open` are the calls open at the sweep. Sets `#lastStep`.
   * `baseline` marks a starting copy, which is credited to nobody and never a request's first step.
   */
  #queueStep(changes: StateChange[], open: string[], baseline = false): void {
    if (changes.length === 0) return;
    const seq = ++this.#state.stepSeq;
    this.#state.stepOutbox.push({ seq, phase: this.#phase(), callsOpen: open, credited: [], files: changes, ...(baseline ? { baseline: true as const } : {}) });
    this.#lastStep = seq;
    // A request's first step is the first non-baseline step this session's hooks wrote while every call open at the sweep had
    // started after it. A step found with a call open that started before the request (it may be that call's), or with none open
    // (a hand edit), is not it.
    const held = this.#state.held[this.#ev.session];
    if (held && !baseline) {
      const starts = open.flatMap((id) => {
        const call = this.#state.open[id];
        return call !== undefined && call.session === this.#ev.session ? [call.startSeq ?? 0] : [];
      });
      const earliest = starts.length === 0 ? 0 : Math.min(...starts);
      const seqs = held.seqs ?? [];
      const firsts = (held.firsts ??= held.prompts.map(() => null));
      const filled: number[] = [];
      for (let i = 0; i < firsts.length; i++) if (firsts[i] === null && earliest > (seqs[i] ?? 0)) (firsts[i] = seq), filled.push(i);
      // A request written at its round's first call could not name its first step yet; the step names it in an op of its own.
      const late = filled.filter((i) => (seqs[i] ?? 0) > 0 && this.#written(held, seqs[i] ?? 0));
      if (late.length > 0) {
        this.#state.outbox.push({
          key: `firststep#${seq}`,
          tool: "hook",
          args: { hookAdapter: 1, hookEvent: "RequestFirstStep", host: this.#ev.host, session_id: this.#ev.session, requests: late.map((i) => ({ seq: seqs[i] ?? 0, at: held.ats?.[i] ?? "unknown", firstStepSeq: seq })) },
          intent: "request first step",
        });
      }
    }
  }

  /**
   * The main agent's first call of a round writes the session's held prompts not yet in the ledger, before the call's own ops,
   * so a page opened mid-round shows the request whether or not the call changes a file. `early` marks them written: the round's
   * close writes only what is past it, so a request is in the ledger once. The step that follows is found later by the page (the op
   * names no first step), as for a step found after Stop.
   */
  #logEarly(held: Held, opens = false, follows?: { task: number; id: number; nonce: string }): void {
    const seqs = held.seqs ?? [];
    const idx = held.prompts.map((_, i) => i).filter((i) => !this.#written(held, seqs[i] ?? 0));
    if (idx.length === 0) return;
    // The follow-up line counts only on the task's first typed prompt: the one just typed, with no earlier typed prompt waiting to be written.
    const first = idx.find((i) => !held.prompts[i]!.startsWith("<task-notification>"));
    const link = opens && follows !== undefined && first === held.prompts.length - 1 ? { follows } : {};
    this.#state.outbox.push({
      key: `prompt#${++this.#state.seq}`,
      tool: "hook",
      args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: this.#ev.host, session_id: this.#ev.session, at: clockOrUnknown(this.#now()), earlier: held.dropped, prompts: idx.map((i) => held.prompts[i]!), requests: idx.map((i) => ({ seq: seqs[i] ?? 0, at: held.ats?.[i] ?? "unknown", firstStepSeq: held.firsts?.[i] ?? null })) },
      intent: "user prompt",
      ...(opens ? { opens: true as const } : {}),
      ...link,
    });
    held.early = Math.max(held.early ?? 0, ...idx.map((i) => seqs[i] ?? 0));
    // The pushed-out prompts are counted in this op: the close does not carry them again.
    held.dropped = 0;
  }

  /** This stamp is already in the ledger from a first step's early write. */
  #written(held: Held, seq: number): boolean {
    return seq <= (held.early ?? 0);
  }

  /**
   * Copies the file as it is now into the task's store, named by the SHA-256 of the copied bytes, once per hash; the diff
   * and the tracked state are those same bytes. `st` was read before the copy, so a write during it shows at the next sweep.
   * `hashOnly` keeps no bytes: the state is the file's fingerprint (a file past the scan caps). `secret` keeps no bytes either and
   * reads the file only to hash it (its SHA-256), for a secret file by name.
   */
  async #capture(file: string, st: BigIntStats, hashOnly: boolean, secret = false): Promise<Staged> {
    const stat0 = { mtimeNs: String(st.mtimeNs), ino: String(st.ino), ctimeNs: String(st.ctimeNs) };
    if (secret) {
      const sha = await sha256Stream(file);
      this.#learnSecret(sha);
      return { copy: "", sha, size: Number(st.size), ...stat0, fresh: false, kept: "hash", secret: true };
    }
    if (hashOnly) return { copy: "", sha: await sha256Stream(file), size: Number(st.size), ...stat0, fresh: false, kept: "hash" };
    // One file past the whole task budget could never be kept without breaking it, so it is a fingerprint, said in words.
    const budget = this.#opts.caps?.taskBytes ?? TASK_STORE_CAP_BYTES;
    if (Number(st.size) > budget && !this.#claimed(file)) {
      return { copy: "", sha: await sha256Stream(file), size: Number(st.size), ...stat0, fresh: false, kept: "hash", hashReason: `not copied: it is ${mbText(Number(st.size))}, over the ${mbText(budget)} a task keeps on disk, so only its fingerprint is kept` };
    }
    const taskId = this.#split ? undefined : this.#tasks.currentTaskId(this.#client);
    const dir = taskId === undefined ? this.#storeDir() : await ensureStoreDir(this.#opts.home, taskId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // The bytes are read once, hashed, and written only as ciphertext: plaintext never lands in the store, not even as a temp file.
    // A claimed file is stat'ed on both sides of the read. Bytes read while the file moved (a writer still writing,
    // whatever the format) are not one state of it, so they are cut short: kept and credited, never a diff base, read again next sweep.
    const claimed = this.#claimed(file);
    const before = claimed ? await stat(file, { bigint: true }).catch(() => undefined) : undefined;
    const plain = await readFile(file);
    this.#opts.fault?.(`capture-read:${file}`);
    const after = claimed ? await stat(file, { bigint: true }).catch(() => undefined) : undefined;
    const moved = claimed && (before === undefined || after === undefined || before.size !== after.size || before.mtimeNs !== after.mtimeNs || after.size !== BigInt(plain.length));
    const sha = sha256Hex(plain);
    const size = plain.length;
    // A secret is also what the text holds: a value a gitleaks rule finds makes the file a secret, kept as its hash only, never stored.
    const rule = secretRuleInBytes(plain);
    if (rule !== undefined) {
      this.#learnSecret(sha);
      return { copy: "", sha, size, ...stat0, fresh: false, kept: "hash", secret: true, secretWhy: `its text holds a value that looks like a secret (gitleaks rule ${rule}), so only its hash and size are kept` };
    }
    const final = path.join(dir, sha);
    let fresh = true;
    if (existsSync(final)) {
      fresh = false;
    } else {
      await writeSealed(final, plain);
      this.#storedNew = true;
    }
    const cut = !claimed ? undefined : moved ? MOVED_WHILE_READ : (this.#opts.cutShort ?? cutShortReason)(plain, file);
    return { copy: final, sha, size, ...stat0, fresh, kept: "whole", ...(cut === undefined ? {} : { cutShort: cut }) };
  }

  /**
   * A secret-named file's bytes were hashed: the hash joins the task's secret set. A state already tracked or stored with these
   * bytes under another name stops being kept whole: its copy and previews are deleted by `settleStore`, which records why.
   */
  #learnSecret(sha: string): void {
    if (sha === EMPTY_SHA) return;
    const known = (this.#state.secretShas ??= []);
    if (known.includes(sha)) return;
    known.push(sha);
    for (const t of Object.values(this.#state.files)) {
      if (t.sha !== sha) continue;
      t.copy = "";
      t.kept = "hash";
      t.secret = true;
    }
    delete this.#state.seen[sha];
    (this.#state.purge ??= []).push(sha);
  }

  /**
   * Whether this sweep copies `file` on name. Only at a call's Pre, only a file a connector claims that the call names, kept as
   * its hash only, no secret, not unreadable, and recorded as a plain SHA-256: a prefixed value (the legacy fingerprint format) cannot vouch for bytes.
   */
  #copyOnName(file: string, named: ReadonlySet<string>, prev: Tracked | undefined, secret: boolean): boolean {
    return this.#ev.kind === "tool-pre" && named.has(file) && prev !== undefined && prev.kept === "hash" && prev.secret !== true && !secret && prev.unreadable === undefined && this.#claimed(file);
  }

  /** The tracked files a call names (by full path or file name), of any type: these get a full hash at the sweep. */
  #namedAny(): Set<string> {
    const tool = this.#phase() === "Stop" ? undefined : this.#ev.toolInput;
    if (tool === undefined) return new Set();
    const text = JSON.stringify(tool).toLowerCase();
    return new Set(Object.keys(this.#state.files).filter((f) => text.includes(f.toLowerCase()) || text.includes(path.basename(f).toLowerCase())));
  }

  /**
   * Diffs every tracked file against its last-known state and points the state at the new one; the previous state stays in
   * the store, never deleted here. A file is only read when its size, mtime, ctime or inode moved, or when a full hash is due
   * (Stop, and a call that names it). ctime cannot be set by a program, so a write that restores mtime still moves it and is
   * credited to the call open at that sweep; the Stop hash stays as the backstop for anything that moved none of the four. A workbook that cannot be
   * read keeps its state for the next sweep; one that is gone is dropped and reported; one not seen before is diffed
   * against nothing. Every changed file becomes one state event of one step.
   */
  async #sweep(): Promise<Swept[]> {
    this.#lastStep = undefined;
    this.#rewrites = new Set();
    const out: Swept[] = [];
    const listing = this.#listing();
    const known = new Set(Object.keys(this.#state.files));
    for (const file of listing.whole) known.add(file);
    for (const file of listing.hashOnly.keys()) known.add(file);
    for (const file of listing.secret) known.add(file);
    // Off: an outside workbook tracked earlier is left alone, not diffed and not read.
    for (const file of this.#state.outside) {
      if (this.#on()) known.add(file);
      else known.delete(file);
    }
    const stop = this.#phase() === "Stop";
    const named = stop ? new Set<string>() : this.#namedAny();
    const changes: StateChange[] = [];
    const fileCap = this.#opts.caps?.fileBytes ?? STATE_FILE_CAP_BYTES;
    const links = new Map<string, boolean>();
    for (const file of [...known].sort()) {
      const prev = this.#state.files[file];
      const secret = this.#isSecret(file);
      // The scan caps limit the copy at the start of the task only. A file the task writes later is kept under the per-file and per-task rules.
      const hashOnly = secret;
      let st: BigIntStats | undefined;
      try {
        st = statSync(file, { bigint: true });
      } catch {
        st = undefined;
      }
      const linked = st !== undefined && prev ? this.#linkOnPath(file, links) : undefined;
      if (linked !== undefined) {
        // A tracked file, or a folder it sits in, was replaced by a symbolic link: the target is not read. Recorded as gone, in words.
        delete this.#state.files[file];
        const why = linked === "file" ? "replaced by a symbolic link, which CoCheck does not follow, so the file it points to is not copied" : "a folder it sits in was replaced by a symbolic link, which CoCheck does not follow, so what that points to is not copied";
        changes.push({ path: file, sha: "", prev: prev!.sha, size: 0, kept: "gone", note: this.#noted(file, why, prev!.secret === true) });
        if (this.#claimed(file)) out.push({ file, gone: true });
        continue;
      }
      if (st === undefined || !st.isFile()) {
        if (prev && !existsSync(file)) {
          delete this.#state.files[file];
          changes.push({ path: file, sha: "", prev: prev.sha, size: 0, kept: "gone", note: this.#noted(file, "", prev.secret === true) });
          if (this.#claimed(file)) out.push({ file, gone: true });
        }
        continue; // not a file right now: nothing to read
      }
      const layered = this.#claimed(file);
      const same = prev !== undefined && prev.mtimeNs === String(st.mtimeNs) && prev.ino === String(st.ino) && prev.ctimeNs === String(st.ctimeNs) && prev.size === Number(st.size);
      // A file whose newest state is unreadable is read again at every sweep: a reader that failed on whole bytes may succeed now.
      const retry = prev?.unreadable !== undefined;
      if (same && !stop && !named.has(file) && !retry) continue;
      let staged: Staged | undefined;
      try {
        if (this.#copyOnName(file, named, prev, secret) && prev) {
          // A claimed file kept as its hash only, named by the call about to run: read once now. The same SHA-256 as the
          // recorded state means these are that state's bytes: they are stored under it and the state becomes kept whole, with no new
          // state and no step. Any other SHA leaves the recorded state without bytes, and the change is recorded below like any other.
          const got = await this.#capture(file, st, false);
          if (got.sha === prev.sha && !retry) {
            if (got.kept === "whole" && got.cutShort === undefined) {
              prev.copy = got.copy;
              prev.kept = "whole";
            }
            prev.size = got.size;
            prev.mtimeNs = got.mtimeNs;
            prev.ino = got.ino;
            prev.ctimeNs = got.ctimeNs;
            continue;
          }
          staged = got;
        } else if (same && prev) {
          // Size, mtime and inode did not move: a full hash decides, so a writer that kept all three is still seen.
          const unchanged = (await sha256Stream(file)) === prev.sha;
          if (unchanged && !retry) continue;
        }
        if (staged === undefined && !secret && prev?.kept === "hash" && prev.secret !== true && prev.unreadable === undefined && (await sha256Stream(file)) === prev.sha) {
          // A file only fingerprinted at the start, touched but not changed: not a write, so nothing is copied.
          if (!stop) this.#rewrites.add(this.#rel(file));
          prev.size = Number(st.size);
          prev.mtimeNs = String(st.mtimeNs);
          prev.ino = String(st.ino);
          prev.ctimeNs = String(st.ctimeNs);
          continue;
        }
        staged ??= await this.#capture(file, st, hashOnly, secret);
      } catch {
        if (prev && !existsSync(file)) {
          delete this.#state.files[file];
          changes.push({ path: file, sha: "", prev: prev.sha, size: 0, kept: "gone", note: this.#noted(file, "", prev.secret === true) });
          if (layered) out.push({ file, gone: true });
        }
        continue; // unreadable right now: the previous state stays and the next sweep retries
      }
      if (prev && staged.sha === prev.sha && !retry) {
        // Touched, not changed: the stat is refreshed so the next sweep can skip the file. The touch is noted (a same-bytes rewrite), never a state.
        if (!stop && !secret && prev.secret !== true) this.#rewrites.add(this.#rel(file));
        prev.size = staged.size;
        prev.mtimeNs = staged.mtimeNs;
        prev.ino = staged.ino;
        prev.ctimeNs = staged.ctimeNs;
        continue;
      }
      const asOf = this.#asOf();
      const of = prev || !layered ? undefined : this.#state.seen[staged.sha];
      let changedClaimed = false;
      let copy: CopyClaim | undefined;
      let unreadable: Unreadable | undefined;
      let owned: Pick<Swept, "owners" | "ownerCalls" | "exact"> = {};
      let label = "";
      if (of) {
        // New to the task and exactly the bytes of a state already seen: one copy, no diff against empty.
        copy = { name: of.name, sha256: staged.sha, asOf: of.asOf };
      } else if (layered && staged.kept === "whole") {
        changedClaimed = true;
        // The last whole state is the diff base, also while the newest state is cut short.
        const back = prev?.unreadable ? prev.unreadable.base : prev && prev.copy !== "" ? { copy: prev.copy, sha: prev.sha } : null;
        const baseLost = prev?.unreadable !== undefined && back !== null && !existsSync(back.copy);
        if (staged.cutShort !== undefined) {
          if (prev?.unreadable && staged.sha === prev.sha) {
            // The same cut-short bytes: nothing changed, and the state already says so.
            prev.size = staged.size;
            prev.mtimeNs = staged.mtimeNs;
            prev.ino = staged.ino;
            prev.ctimeNs = staged.ctimeNs;
            continue;
          }
          // Half-written or corrupt: the bytes are a state of their own, kept, and the calls open now are credited with the change.
          const calls: Record<string, OpenCall> = { ...(prev?.unreadable?.calls ?? {}) };
          // At Stop the open calls are interrupted ones, which a Stop sweep never credits (see `stop`).
          if (!stop) for (const [id, call] of Object.entries(this.#state.open)) calls[id] = { ...call };
          const reason = staged.cutShort;
          unreadable = { reason, base: back, calls };
          label = `could not read at this point (${reason}); its bytes are kept, and the change is credited when it can be read`;
        } else {
          this.#remember(file, staged.sha, asOf);
          const u = prev?.unreadable;
          if (u) {
            // Whole again. The hash decides who made it: the cut-short state's own (the check, not the file, was at fault) is
            // the owners' alone; a hash that moved in between is joint with whoever is open now, and says so.
            const exact = staged.sha === prev!.sha;
            // A call that failed is credited with no later change. A hash that moved was changed by someone after it; the bytes the
            // failed call itself left (same hash) stay its own.
            const owners = Object.entries(u.calls).filter(([, c]) => exact || c.failed !== true).map(([id]) => id).sort();
            const failedBefore = Object.entries(u.calls).filter(([, c]) => !exact && c.failed === true).map(([id]) => id).sort();
            label = exact
              ? owners.length > 0
                ? `could not read at this point, readable now with the same bytes; the change is credited to the call that made it: ${owners.join(", ")}`
                : "could not read at this point, readable now with the same bytes; not from an agent call"
              : owners.length > 0
                ? `changed while unreadable, during call ${owners.join(", ")} and after`
                : failedBefore.length > 0
                ? `left unreadable by the failed call ${failedBefore.join(", ")}, changed after it`
                : "changed while unreadable, not from an agent call, and after";
            if (baseLost) label += "; the last readable state was deleted by a size cap";
            if (owners.length > 0) owned = { owners, ownerCalls: u.calls, exact };
          }
        }
      }
      const note = secret || staged.secret ? this.#noted(file, "", true, staged.secretWhy) : [staged.hashReason, staged.kept === "whole" ? this.#sizeNote(staged.size) : "", label].filter((x) => x).join("; ");
      if (prev && prev.copy !== "" && prev.size !== undefined && prev.size > fileCap && prev.sha !== (prev.first ?? prev.sha)) {
        this.#state.drops.push({ sha: prev.sha, reason: `over ${mbText(fileCap)} (${mbText(prev.size)}): only the file's first and current state are kept, so this state in between was deleted and its hash stays` });
      }
      this.#state.files[file] = { copy: staged.copy, sha: staged.sha, size: staged.size, mtimeNs: staged.mtimeNs, ino: staged.ino, ctimeNs: staged.ctimeNs, first: prev?.first ?? staged.sha, kept: staged.kept, ...(staged.secret ? { secret: true as const } : {}), ...(unreadable ? { unreadable } : {}) };
      changes.push({ path: file, sha: staged.sha, prev: prev?.sha ?? null, size: staged.size, kept: staged.kept, note, mtimeNs: staged.mtimeNs });
      if (copy) out.push({ file, copyOf: copy });
      else if (changedClaimed) out.push({ file, ...owned, ...(label ? { label } : {}) });
    }
    this.#queueStep(changes, Object.keys(this.#state.open).sort());
    this.#saySkips(listing.skipped, listing.capped);
    this.#opts.fault?.("after-sweep");
    return out;
  }

  #entries(swept: Swept, open: string[], origin?: string): Entry[] {
    const { file } = swept;
    const step = this.#lastStep;
    if (swept.gone) return [{ path: file, with: open, origin, step }];
    if (swept.copyOf) return [{ path: file, with: open, origin, step, copyOf: swept.copyOf }];
    return [{ path: file, with: open, origin, step, ...(swept.label !== undefined ? { note: swept.label } : {}) }];
  }

  /** Closes calls open longer than the expiry; what other calls' Posts gave them jointly is still logged. Then reads how open calls ended. */
  #expire(): void {
    const now = this.#now();
    for (const [id, call] of Object.entries(this.#state.open)) {
      if (now - call.at > OPEN_EXPIRY_MS) this.#close(id, call, "expiry");
    }
    this.#settleEvidence();
  }

  /** Open calls whose transcript showed them done at this event: the sweep of this event is the last that may credit them. */
  readonly #endingNow = new Set<string>();

  /**
   * Reads the host's transcripts for the tool_result of each open call that may still be credited. A call that never ran (blocked by
   * a PreToolUse hook, denied) is credited with nothing from now on; one that ran is credited by this event's sweep, the first after its
   * result, and by none after. A background Bash keeps running past its result, so only "never ran" counts for it. Each transcript is read
   * once, from the earliest place any of its calls needs. Nothing found leaves the call as it was (closed by its Post, Stop or expiry).
   */
  #settleEvidence(): void {
    const byFile = new Map<string, { from: number; ids: string[] }>();
    for (const [id, call] of Object.entries(this.#state.open)) {
      if (call.ended !== undefined || call.transcript === undefined || toolNeverWrites(call.tool)) continue;
      const entry = byFile.get(call.transcript.file) ?? { from: call.transcript.from, ids: [] };
      entry.from = Math.min(entry.from, call.transcript.from);
      entry.ids.push(id);
      byFile.set(call.transcript.file, entry);
    }
    for (const [file, { from, ids }] of byFile) {
      const { found, next } = evidenceSince(file, from, new Set(ids));
      for (const id of ids) {
        const ev = found.get(id);
        const call = this.#state.open[id]!;
        // the next read goes on from here: what was read holds no end for this call (the result is never before its Pre)
        call.transcript = { file, from: Math.max(call.transcript!.from, next) };
        if (ev === undefined || (runsOnAfterResult(call) && !neverRan(ev))) continue;
        call.ended = ev;
        if (!neverRan(ev)) this.#endingNow.add(id);
      }
    }
    this.#settleRefused();
  }

  /**
   * A host that records its own refusal to start a command (Codex: `exec_command failed ... Rejected(...)` quoting the command) in the
   * session file. The open shell call of the same thread whose command is exactly the quoted one never ran: it is closed as `refused`, with
   * `blocked` evidence, and takes no credit. Bound: exact command text, one open call with it in the thread (two identical open commands
   * leave both as they were); a rejection older than the call's Pre is another run of the same text. An early return is no rejection.
   */
  #settleRefused(): void {
    const sf = profileOf(this.#ev.host).sessionFile;
    if (sf.refusedCommands === undefined) return;
    const threads = new Map<string, string[]>();
    for (const [id, call] of Object.entries(this.#state.open)) {
      if (!isShellTool(call.tool) || call.command === "") continue;
      const key = `${call.session}\u0000${call.agentId ?? ""}`;
      threads.set(key, [...(threads.get(key) ?? []), id]);
    }
    for (const ids of threads.values()) {
      const first = this.#state.open[ids[0]!]!;
      const rollout = first.agentId === undefined ? sf.locate(first.session, first.at, this.#opts.codexSessions) : sf.locateHelper?.(first.session, first.agentId, first.at, this.#opts.codexSessions);
      const refused = rollout === undefined ? undefined : sf.refusedCommands(rollout);
      if (refused === undefined || refused.length === 0) continue;
      for (const id of ids) {
        const call = this.#state.open[id];
        if (call === undefined || call.ended !== undefined) continue;
        const same = ids.filter((o) => this.#state.open[o]?.command === call.command);
        let hit = refused.find((r) => r.command === call.command && r.at >= call.at - EVIDENCE_SLACK_MS);
        if (same.length !== 1) hit = undefined;
        // A rejection that quotes no command: it settles the one open shell call of the thread that began before it. Two such calls
        // (one may be a build still running beside the refused one) leave both open: the text cannot say which was refused.
        if (hit === undefined && same.length === 1) {
          // No slack: a bare rejection must come at or after the call's own Pre (the quoted match above keeps its slack).
          const bare = refused.find((r) => r.command === undefined && r.at >= call.at);
          const began = bare === undefined ? [] : ids.filter((o) => this.#state.open[o]!.ended === undefined && this.#state.open[o]!.at <= bare.at);
          if (bare !== undefined && began.length === 1 && began[0] === id) hit = bare;
        }
        if (hit === undefined) continue;
        call.ended = { at: hit.at, kind: "blocked" };
        this.#close(id, call, "refused");
      }
    }
  }

  /** Seam for positive evidence of who wrote a file (the per-call tag), ahead of every window rule. Set by `loadWriteEvidence`. */
  #writeEvidence: WriteEvidence | undefined = undefined;

  #close(id: string, call: OpenCall, closedBy: ClosedBy): void {
    // A call closed with no Post of its own still gets the words the host wrote after its Pre. Only when this event's cursor is the call's own file.
    if (call.narration?.source !== "agent" && call.session === this.#ev.session && call.agentId === cleanId(this.#ev.agentId)) this.#narrate(id, call);
    this.#log(id, call, this.#state.pending[id] ?? [], closedBy);
    delete this.#state.pending[id];
    delete this.#state.open[id];
    if (closedBy !== "stop" && closedBy !== "expiry") this.#keepClosedWriter(id, call);
    this.#markClosed(id);
    if (closedBy === "expiry") this.#state.expired = [...this.#state.expired.filter((c) => c !== id), id].slice(-CLOSED_KEEP);
  }

  /** Remembers a tagged call at its close (its child may still run); the record is what a late write's tag is matched to. */
  #keepClosedWriter(id: string, call: OpenCall): void {
    if (call.tagged !== true || !isShellTool(call.tool)) return;
    const kept = (this.#state.closedWriters ??= {});
    delete kept[id];
    kept[id] = { ...call };
    for (const old of Object.keys(kept).slice(0, -CLOSED_WRITERS_KEPT)) delete kept[old];
  }

  /**
   * The closed calls whose children's tagged write of `file` was recorded, no older than the window. Only a call the adapter
   * closed itself and still holds; a record naming any other call, or none, gives nobody (never the last open call by guess).
   */
  #lateWriters(file: string, spend = true): string[] {
    const hit = this.#state.writeEvidence?.byPath[file];
    const kept = this.#state.closedWriters;
    if (!hit || !kept || !Number.isFinite(this.#now()) || this.#now() - hit.at > LATE_WRITE_WINDOW_MS) return [];
    const ids = hit.calls.filter((id) => id in kept && !(id in this.#state.open));
    if (spend && ids.length > 0) this.#evidenceUsed.add(file);
    return ids;
  }

  /** A call whose command may leave an app running past its result stays a suspect after its Post (see `tails`). */
  #keepTail(id: string, call: OpenCall): void {
    if (!runsOnAfterResult(call) || !Number.isFinite(call.at)) return;
    const kept = (this.#state.tails ??= {});
    delete kept[id];
    // The open-call expiry, from the call's start: a tail never outlives the window the call would have had open (no clock read here).
    kept[id] = { call: { ...call }, until: call.at + OPEN_EXPIRY_MS };
    for (const old of Object.keys(kept).slice(0, -TAILS_KEPT)) delete kept[old];
  }

  /** The session `session`'s next call opened, or its Stop came: its app tails end. Expired tails go too. */
  #endTails(session: string | undefined, agentId?: string | null): void {
    const kept = this.#state.tails;
    if (kept === undefined) return;
    const now = this.#now();
    for (const [id, t] of Object.entries(kept)) {
      if ((session !== undefined && t.call.session === session && (agentId === null || t.call.agentId === agentId)) || !(now <= t.until)) delete kept[id];
    }
    if (Object.keys(kept).length === 0) delete this.#state.tails;
  }

  /**
   * The closed calls whose app tail covers `file`: still within `until`, not open again, and whose own command names the file
   * (`commandNamesFile`, the same test as the name tiebreak). The credit is inferred, basis `named`, never proof.
   */
  #tailWriters(file: string): string[] {
    const kept = this.#state.tails;
    if (kept === undefined) return [];
    const now = this.#now();
    return Object.entries(kept)
      .filter(([id, t]) => !(id in this.#state.open) && now <= t.until && commandNamesFile(t.call.command, file))
      .map(([id]) => id);
  }

  #markClosed(id: string): void {
    this.#state.closed = [...this.#state.closed.filter((c) => c !== id), id].slice(-CLOSED_KEEP);
  }

  /**
   * Shares what a sweep found with the calls that may have made it, each op naming them all; `origin` is the call whose Post found
   * it. A change is shared with `open`, the calls open at the sweep. The cells of a file that was unreadable belong to the calls
   * open when it was (`owners`, closed or not): alone when the hash is the unreadable state's own, jointly with `open` when it
   * moved. A closed owner gets a late op. `plainOpen` is who a file with no cells of its own is credited to (none, at Stop).
   */
  #credit(changed: Swept[], openAll: string[], origin?: string, plainAll: string[] = openAll): Entry[] {
    // The guards narrow who is credited, never who was open (the step keeps its full open list, so a change nobody can be credited with reads "during agent calls").
    // The hooks log a write before it happens, so reading the logs again after the sweep covers every write the sweep saw
    this.loadWriteEvidence();
    // Files whose credit was narrowed to the calls that name them; with the tag evidence for the file, this decides the stored basis.
    const narrowed = new Set<string>();
    const may = (file: string) => (ids: string[]): string[] => {
      const guarded = creditWithEvidence(ids, file, this.#writeEvidence, (id) => this.#mayCredit(id, file, origin), undefined, (id) => this.#cannotWrite(id, file));
      const byInput = this.#namedByInput(guarded, file);
      const out = this.#namedByRecord(byInput, file);
      if (out.length < guarded.length) narrowed.add(file);
      return out;
    };
    const basisOf = (rec: StateChange, credited: readonly string[]): ProofMethod => creditBasisOf({ credited, taggedWriters: this.#state.writeEvidence?.byPath[rec.path]?.calls ?? [], named: narrowed.has(rec.path), hostEdit: this.#hostEdit(rec, credited, origin) });
    const step = this.#lastStep === undefined ? undefined : this.#state.stepOutbox.find((x) => x.seq === this.#lastStep);
    const own: Entry[] = [];
    const late = new Map<string, Entry[]>();
    const touched = new Set<string>();
    const lateCalls = new Map<string, OpenCall>();
    for (const swept of changed) {
      const owners = swept.owners ?? [];
      const open = may(swept.file)(openAll);
      // A call already closed whose child's tagged write of this file is on record is credited with it, beside the calls open now.
      // So is a closed call whose app tail covers the file, inferred (basis `named`), with the side text saying when it was found.
      const tails = owners.length > 0 ? [] : this.#tailWriters(swept.file).filter((t) => !open.includes(t));
      if (tails.length > 0) narrowed.add(swept.file);
      const lateWriters = owners.length > 0 ? [] : [...new Set([...this.#lateWriters(swept.file), ...tails])];
      const targets = owners.length > 0 ? (swept.exact ? owners : [...new Set([...owners, ...open])].sort()) : lateWriters.length > 0 ? [...new Set([...open, ...lateWriters])].sort() : open;
      const change = step?.files.find((f) => f.path === swept.file);
      if (change) {
        change.credited = [...targets];
        change.basis = basisOf(change, change.credited);
        if (tails.some((t) => targets.includes(t)) && !change.note.split("; ").includes(TAIL_NOTE)) change.note = change.note ? `${change.note}; ${TAIL_NOTE}` : TAIL_NOTE;
      }
      const entries = this.#entries(swept, targets, origin);
      for (const other of targets) {
        if (other === origin) continue;
        const copies = entries.map((e) => (tails.includes(other) ? { ...e, note: e.note ? `${e.note}; ${TAIL_NOTE}` : TAIL_NOTE } : { ...e }));
        if (other in this.#state.open) {
          appendAll((this.#state.pending[other] ??= []), copies);
          touched.add(other);
        }
        else {
          const lateList = late.get(other) ?? [];
          appendAll(lateList, copies);
          late.set(other, lateList);
          const call = swept.ownerCalls?.[other] ?? this.#state.closedWriters?.[other] ?? this.#state.tails?.[other]?.call;
          if (call) lateCalls.set(other, call);
        }
      }
      if (origin === undefined || targets.includes(origin)) appendAll(own, entries);
    }
    // Every call open at this sweep is credited with the step, whatever the file type: only a call open at the sweep is.
    if (step) {
      // A file with no cells (JSON, CSV, a hash-only change) is credited the same way: the open calls, and the closed call a tagged write names
      for (const f of step.files) {
        if (f.credited !== undefined) continue;
        f.credited = [...new Set([...may(f.path)(plainAll), ...this.#lateWriters(f.path), ...this.#tailWriters(f.path)])].sort();
        f.basis = basisOf(f, f.credited);
      }
      step.credited = [...new Set(step.files.flatMap((f) => f.credited ?? []))].sort();
      for (const id of step.credited) if (id in this.#state.open) (this.#state.callSteps[id] ??= []).push(step.seq);
    }
    for (const id of touched) this.#foldPending(id);
    for (const [id, entries] of late) {
      const call = lateCalls.get(id);
      if (call && entries.length > 0) this.#log(id, call, entries, "late", false);
    }
    return own;
  }

  /**
   * Reads the write hooks' records appended since this folder's cursor (none when the tag setting is off). A folder seen for the
   * first time starts at the logs' current ends.
   */
  loadWriteEvidence(): void {
    if (this.#opts.attributionTag === "off") return;
    try {
      const st = (this.#state.writeEvidence ??= startEvidence(this.#opts.home));
      readEvidence(this.#opts.home, st, (p) => {
        const real = realish(p);
        return this.#inFolder(real) ? real : undefined;
      }, Date.now(), (r, key) => {
        // What each open call's children logged, for `#cannotWrite`
        const c = this.#state.open[r.call];
        if (!c) return;
        if (r.op === "spawn") c.hookSpawned = true;
        else if (r.op === "start") {
          if (r.pid !== undefined && (c.hookStarts ?? []).length < 512 && !(c.hookStarts ?? []).some((x) => x.pid === r.pid)) c.hookStarts = [...(c.hookStarts ?? []), { path: r.path, pid: r.pid, ...(r.ppid !== undefined ? { ppid: r.ppid } : {}) }];
        } else if (key !== undefined) c.hookWrote = (c.hookWrote ?? 0) + 1;
      }); // the log files are named by wall-clock UTC date; the injected clock (a test's) is never ticked here
      this.#writeEvidence = (file, candidates) => this.#proven(file, candidates);
    } catch {
      // evidence is an addition: unreadable logs leave the open-call rule as it was
    }
  }

  /** Drops the evidence a sweep used, and evidence whose calls are all closed (it can no longer prove anything). */
  settleWriteEvidence(): void {
    const st = this.#state.writeEvidence;
    if (!st) return;
    for (const file of this.#evidenceUsed) delete st.byPath[file];
    // A closed call's record waits for the write it may precede (the hook logs a write before it lands), for the window
    const kept = this.#state.closedWriters ?? {};
    let now: number | undefined;
    for (const [file, hit] of Object.entries(st.byPath)) {
      const holds = hit.calls.some((id) => id in kept);
      if (holds) now ??= this.#now();
      const waiting = holds && Number.isFinite(now) && now! - hit.at <= LATE_WRITE_WINDOW_MS;
      if (!waiting && !hit.calls.some((id) => id in this.#state.open)) delete st.byPath[file];
    }
    if (st.unobserved) st.unobserved = st.unobserved.filter((id) => id in this.#state.open);
  }

  /**
   * The write scope of this Pre's Bash command, from the command as it ran and the payload's cwd (none when the payload has no
   * absolute cwd). With outside watching off no outside path is kept, so a scope that writes outside the folder is kept as unknown.
   */
  #scopeNow(): { scope?: WriteScope } {
    if (!isShellTool(this.#ev.toolName)) return {};
    const raw = (this.#ev.toolInput as Record<string, unknown> | undefined)?.command;
    if (typeof raw !== "string") return {};
    // A PowerShell tool's command is read as PowerShell (win32 only, a bounded set of forms; unknown elsewhere, never excluded)
    const shell = /^(powershell|pwsh)$/i.test(this.#ev.toolName ?? "") ? ("powershell" as const) : undefined;
    // a helper's payload cwd is the main thread's, not its shell's: its relative paths count only after a cd to an absolute path
    const cwd = cleanId(this.#ev.agentId) === undefined && this.#ev.cwd && this.#guardKit.isAbs(this.#ev.cwd) ? this.#ev.cwd : null;
    const scope = writeScope(raw, cwd, { pre: (this.#probe ??= fsProbe(process.env, this.#guardKit)), kit: this.#guardKit, ...(shell ? { shell } : {}) });
    if (scope.known && !this.#on() && scope.targets.some((t) => this.#isOutside(t.path))) return { scope: { known: false, why: "writes outside the folder with outside watching off" } };
    return { scope };
  }

  #probe: PathProbe | undefined = undefined;
  #rootsCover: boolean | undefined = undefined;

  /** Whether the write hooks' registered roots hold the task folder (read once per event). */
  #hookCoversFolder(): boolean {
    if (this.#rootsCover === undefined) {
      try {
        const roots = (JSON.parse(readFileSync(rootsFile(this.#opts.home), "utf8")) as unknown[]).filter((r): r is string => typeof r === "string");
        const f = normalizePathForCompare(this.#folder);
        this.#rootsCover = roots.some((r) => {
          const q = normalizePathForCompare(r).replace(/\/+$/, "");
          return f === q || f.startsWith(q + path.sep);
        });
      } catch {
        this.#rootsCover = false;
      }
    }
    return this.#rootsCover;
  }

  /**
   * Whether the open call `id` provably cannot have written or removed `file`: its command's scope is known and does not hold the
   * file (every target checked on disk now: no user symlink, no hard link), and any Python or Node child it relies on was tagged, logged no
   * write and started no program, under roots that cover the file. Any doubt keeps it a suspect.
   */
  /**
   * The calls among `ids` whose own command names `file` (`commandNamesFile`: its basename outside a read-only part, or a page or
   * conversion a converter it runs writes under that name). On every host, exactly one such call is credited alone; none or several
   * leave `ids` unchanged. A host whose session file records each call's own words (Codex rollouts, one per helper) also reads the
   * recorded command and output, and there any non-empty set of naming calls is credited. Bound: the credit stays inferred (`named`);
   * a call that names a file it only read outside the recognised read forms still takes the credit, and a record not yet written (a
   * call that has not finished) names nothing.
   */
  #namedByRecord(ids: string[], file: string): string[] {
    if (ids.length < 2) return ids;
    const sf = profileOf(this.#ev.host).sessionFile;
    const callText = sf.callText;
    const base = path.basename(file).toLowerCase();
    const named = ids.filter((id) => {
      const c = this.#state.open[id];
      if (c === undefined) return false;
      if (commandNamesFile(c.command, file)) return true;
      if (callText === undefined) return false;
      const rollout = c.agentId === undefined ? sf.locate(c.session, this.#now(), this.#opts.codexSessions) : sf.locateHelper?.(c.session, c.agentId, this.#now(), this.#opts.codexSessions);
      const text = rollout === undefined ? undefined : callText(rollout)?.get(id);
      return text !== undefined && textNamesBase(text, base);
    });
    // Without a record, only shell calls are compared (a call of another tool whose input holds no command says nothing by naming
    // nothing), and a call the tag evidence names as a writer of the file is never dropped for a name.
    if (callText === undefined) {
      const tagged = this.#state.writeEvidence?.byPath[file]?.calls ?? [];
      const keep = named.length === 1 && ids.every((id) => isShellTool(this.#state.open[id]?.tool) && (id === named[0] || !tagged.includes(id)));
      return keep ? named : ids;
    }
    return named.length > 0 ? named : ids;
  }

  /**
   * Among overlapping open calls, the ones whose own tool input names `file` as a write target (a Write/Edit/create path, an apply_patch
   * header) take the credit alone, when there are any; else `ids` unchanged. Bound: the name is read from the call's input only, never from a
   * shell command; a call that names the file but did not write it still takes the credit (a patch whose header names it, a script writing it behind the patch is not seen).
   */
  #namedByInput(ids: string[], file: string): string[] {
    if (ids.length < 2) return ids;
    const named = ids.filter((id) => (this.#state.open[id]?.writes ?? []).some((w) => samePath(w, file, true, this.#guardKit)));
    return named.length > 0 ? named : ids;
  }

  /**
   * Whether the change `rec` stands on a host file-edit call alone. Only the call whose own successful Post this sweep is can prove it (a call
   * still open, or one that failed, never does), and only by exact reconstruction: the call's reported edit replayed on the recorded state before it
   * (`rec.prev`) must give the recorded state after (`rec.sha`). A call can fail only in its own Post event, so nothing proven needs downgrading later.
   * A credit stored at another call's sweep is proven at the call's own Post by `#proveAtOwnPost`.
   */
  #hostEdit(rec: Pick<StateChange, "path" | "prev" | "sha">, credited: readonly string[], origin: string | undefined): boolean {
    if (origin === undefined || this.#phase() !== "Post" || this.#failure() !== null) return false;
    const file = rec.path;
    const kit = pathKit();
    const sha256 = (x: string | Uint8Array): string => createHash("sha256").update(x).digest("hex");
    let before: Uint8Array | undefined | null = null;
    // The recorded state before the call: empty when the file did not exist, undefined when its copy is not kept or unreadable.
    const readBefore = (): Uint8Array | undefined => {
      if (before !== null) return before;
      before = undefined;
      if (rec.prev === null) return (before = new Uint8Array());
      try {
        const copy = this.#findCopy(rec.prev);
        if (copy === undefined) return before;
        const bytes = readFileSync(copy);
        const plain = hasSealHeader(bytes) ? openBytes(bytes, copy, this.#opts.home) : bytes;
        if (plain.length <= RECONSTRUCT_MAX_BYTES && sha256(plain) === rec.prev) before = plain;
      } catch { /* unreadable: unproven */ }
      return before;
    };
    return hostReportedEdit({
      content: (id) => {
        if (id !== origin) return false;
        const mine = (this.#state.open[id]?.reported ?? []).filter((c) => kit.same(c.path, file) || kit.same(realish(c.path), realish(file)));
        return mine.length === 1 && reconstructAll(mine[0]!, mine[0]!.sha !== undefined ? undefined : readBefore(), sha256).includes(rec.sha);
      },
      credited,
      taggedWriters: this.#state.writeEvidence?.byPath[file]?.calls ?? [],
      file,
      call: (id) => this.#state.open[id],
      same: (a, b) => kit.same(a, b) || kit.same(realish(a), realish(b)),
      failed: (id) => neverRan(this.#state.open[id]?.ended),
    });
  }

  /**
   * A change another call's sweep stored (credited to this call alone, basis inferred) is raised to host-reported-edit at this call's own
   * successful Post when the call's reported edit, replayed on the stored before-state, gives the stored after-state. A failure is this call's own
   * event and never reaches here, so a call that failed is never upgraded; nothing is upgraded while the call is open.
   */
  #proveAtOwnPost(id: string, call: OpenCall): void {
    if ((call.reported ?? []).length === 0 || this.#phase() !== "Post" || this.#failure() !== null) return;
    try {
      const taskId = this.#tasks.currentTaskId(this.#split ? (this.#clientOfCall(id) ?? this.#client) : this.#client);
      if (taskId === undefined) return;
      const kit = pathKit();
      for (const row of this.#ledger.inferredStatesOfCall(taskId, id)) {
        if (!(call.edits ?? []).some((e) => kit.same(e, row.filePath) || kit.same(realish(e), realish(row.filePath)))) continue;
        if (this.#hostEdit({ path: row.filePath, prev: row.prevSha256, sha: row.sha256 }, [id], id)) this.#ledger.proveFileState(row.id);
      }
    } catch { /* an addition: any doubt leaves the change inferred */ }
  }

  #cannotWrite(id: string, file: string): boolean {
    const c = this.#state.open[id];
    // A read-only shell form never takes write credit, whatever else was open (its command was parsed with no redirect, writing pipe or in-place flag)
    if (c?.readOnly === true) return true;
    if (!c || !isShellTool(c.tool) || c.scope === undefined || !c.scope.known) return false;
    const unobserved = this.#state.writeEvidence?.unobserved ?? [];
    const facts = {
      tagged: c.tagged === true && this.#state.writeEvidence !== undefined,
      wrote: c.hookWrote ?? 0,
      spawned: c.hookSpawned === true || unobserved.includes(id),
      covered: !this.#isOutside(file) && this.#hookCoversFolder(),
      starts: c.hookStarts ?? [],
    };
    return cannotHaveWritten(file, c.scope, facts, (this.#probe ??= fsProbe(process.env, this.#guardKit)), this.#guardKit);
  }

  /**
   * Behind the evidence seam: the calls whose children's writes to `file` were recorded, when the strict rule (`strictWriters`) holds
   * for `candidates`, the calls open at this sweep; undefined leaves the window rule. A call's own window guards (`#mayCredit`, without an
   * origin) say whether it could have written the file at all. Used evidence is spent, and each writer's op records the proven write
   * (`provenWrites`), the timeline's side of the seam.
   */
  #proven(file: string, candidates: readonly string[]): string[] | undefined {
    const st = this.#state.writeEvidence;
    const hit = st?.byPath[file];
    if (!st || !hit) return undefined;
    const facts = (id: string) => {
      const c = this.#state.open[id];
      if (!c) return undefined;
      const mayWrite = !isLauncherTool(c.tool) && !isWaitCall(c) && this.#mayCredit(id, file, undefined);
      // "logged nothing" counts only for a call whose children provably carried the hook
      // per process: as many start records as the command starts hooked interpreters, of each kind
      const hooked = c.scope !== undefined && hooksProven(c.scope, c.hookStarts ?? []);
      return { tool: c.tool, tagged: c.tagged === true, command: c.command, mayWrite, hooked };
    };
    const writers = strictWriters(file, candidates, hit.calls, facts, new Set(st.unobserved ?? []));
    if (writers === undefined) return undefined;
    this.#evidenceUsed.add(file);
    const step = this.#lastStep;
    if (step !== undefined) {
      for (const w of writers) {
        const call = this.#state.open[w];
        if (call && !(call.provenWrites ?? []).some((x) => x.path === file && x.step === step)) (call.provenWrites ??= []).push({ path: file, step });
      }
    }
    return writers;
  }

  /**
   * Whether an open call may be credited with a change to `file` found at this sweep (`origin`: the call whose Post it is, if any).
   * An internal agent call (agent_id, no agent_type, no launcher) is credited only at its own Post; a Write or Edit only with its own file_path;
   * Read, Glob, Grep and SendMessage with nothing. A call with no record here (a late owner) is left as it is.
   * Nor a tool that cannot write, a launch whose helper has a call open, or a call the transcript showed done before this sweep.
   */
  #mayCredit(id: string, file: string, origin: string | undefined): boolean {
    const call = this.#state.open[id];
    if (!call) return true;
    if (isInternalAgentCall({ agentId: call.agentId, agentType: call.agentType, launchId: call.launchToolUseId }) && id !== origin) return false;
    // A call the transcript showed done is credited only by the sweep at which that was seen; one that never ran, by none.
    if (call.ended !== undefined && (neverRan(call.ended) || !this.#endingNow.has(id))) return false;
    // A launch is no suspect at a sweep where a call of the agent it launched is open
    if (!launcherMayCredit(call.tool, Object.values(this.#state.open).some((c) => c.launchToolUseId === id || (c.linkedLaunch === true && c.session === call.session)))) return false;
    const fp = call.toolLabel?.fields?.file_path;
    return toolMayCredit(call.tool, typeof fp === "string" ? fp : null, file, (a, b) => samePath(a, b, true, this.#guardKit), this.#guardKit);
  }

  /** Keeps a call's carried entries bounded: one per file (its first step, every note, a copy claim), however many sweeps found it. */
  #foldPending(id: string): void {
    const list = this.#state.pending[id];
    if (!list || list.length <= 1) return;
    const byPath = new Map<string, Entry>();
    for (const e of list) {
      const have = byPath.get(e.path);
      if (have === undefined) {
        byPath.set(e.path, { path: e.path, with: e.with, ...(e.step === undefined ? {} : { step: e.step }), ...(e.origin === undefined ? {} : { origin: e.origin }), ...(e.copyOf ? { copyOf: e.copyOf } : {}), ...(e.note ? { note: e.note } : {}) });
        continue;
      }
      if (e.note && !(have.note ?? "").split("; ").includes(e.note)) have.note = have.note ? `${have.note}; ${e.note}` : e.note;
      if (e.copyOf && !have.copyOf) have.copyOf = e.copyOf;
    }
    this.#state.pending[id] = [...byPath.values()];
  }

  /**
   * What a sweep found when no call may claim it (no call open, Stop, or the Post of a call that was never seen): not from an agent
   * call, except a file that was cut short, which belongs to the calls open when it was. `open` are the calls it is shared with besides its owners.
   */
  #unclaimed(changed: Swept[], open: string[]): void {
    const owned = changed.filter((s) => (s.owners ?? []).length > 0);
    if (owned.length > 0) this.#credit(owned, open, undefined, []);
    // A file whose change a closed call's child is on record for (its tag) is that call's, not a hand edit, and is credited to it alone
    const step = this.#lastStep === undefined ? undefined : this.#state.stepOutbox.find((x) => x.seq === this.#lastStep);
    const lateFiles = new Set(step?.files.filter((f) => f.credited === undefined && (this.#lateWriters(f.path, false).length > 0 || this.#tailWriters(f.path).length > 0)).map((f) => f.path) ?? []);
    const late = changed.filter((s) => (s.owners ?? []).length === 0 && lateFiles.has(s.file));
    if (lateFiles.size > 0) this.#credit(late, [], undefined, []);
  }

  /**
   * The calls a sweep at this event may credit. At a helper's event (the payload carries `agent_id`), the main thread's open
   * waiting call is left out: it waits for the helper and never wrote what the helper's write moved.
   */
  #openCalls(): string[] {
    const all = Object.keys(this.#state.open).sort();
    if (cleanId(this.#ev.agentId) === undefined) return all;
    return all.filter((id) => {
      const c = this.#state.open[id]!;
      return !(c.agentId === undefined && isWaitCall(c));
    });
  }

  async pre(): Promise<void> {
    await this.#baseline();
    this.#expire();
    await this.#baselineOutside();
    if (this.#opts.heldReplay !== true) {
      const changed = await this.#sweep();
      const open = this.#openCalls();
      // Calls are running: they share what moved, as at a Post. No call open: nobody made it, it is a hand edit.
      if (open.length > 0) this.#credit(changed, open);
      else this.#unclaimed(changed, open);
    }
    const id = this.#ev.toolUseId;
    if (!id) return;
    // This session's next call opens, so its app tails end (after this Pre's sweep, which they may still be credited at).
    this.#endTails(cleanId(this.#ev.session), null);
    const call: OpenCall = { ...this.#callNow(), startSeq: ++this.#state.seq, ...this.#transcriptAt(), ...(this.#opts.taggedCall === true ? { tagged: true as const } : {}), ...this.#scopeNow() };
    // Claude Code writes the call's words to the transcript before its Pre; Codex writes the item after the call, so it is read at Post.
    if (this.#ev.narratesBeforeCall) this.#narrate(id, call, true);
    this.#state.open[id] = call;
    this.#noteSession(id, call.session);
    this.#markCalled(this.#ev.session, cleanId(this.#ev.agentId));
    const held = this.#state.held[this.#ev.session];
    if (held && cleanId(this.#ev.agentId) === undefined) this.#logEarly(held);
  }

  /**
   * The agent's own words on a call, from the host's session file. Context only: it is stored on the call and never
   * read by grouping, credit or ordering. A call that already has words keeps them; nothing found records "no narration recorded".
   */
  #narrate(id: string, call: OpenCall, atPre = false): void {
    if (call.narration?.source === "agent") return;
    let cursor: NarrationCursor | undefined;
    try {
      cursor = this.#narrationCursor(cleanId(this.#ev.agentId), !atPre);
      if (atPre) claimAtPre(this.#ev.host, cursor, id);
      const found = lookup(cursor, id);
      call.narration = found.text === undefined ? found : { ...found, text: this.#redactWords(found.text) };
      // The host's own per-call reason (a profile whose session file carries one) is the row's reason.
      const reason = reasonOf(cursor, id);
      if (reason !== undefined) call.description = this.#redactWords(reason);
    } catch {
      call.narration = none();
    }
  }

  /** A call that closed without words waits for its sentence to reach the file (Claude Code flushes a message's lines after the hooks of its calls can run). */
  #awaitLateNarration(id: string, call: OpenCall): void {
    if (call.narration?.source === "agent" || typeof call.session !== "string") return;
    const waiting = (this.#state.lateNarr ??= {});
    delete waiting[id];
    waiting[id] = { session: call.session, ...(call.agentId === undefined ? {} : { agentId: call.agentId }) };
    for (const old of Object.keys(waiting).slice(0, -LATE_NARRATION_KEPT)) delete waiting[old];
  }

  /**
   * After a read of the cursor `key`, every waiting call of that file whose tool_use_id the cursor now holds words for gets an
   * op of its own (the ledger is append-only). It is keyed by the call's id through `lateNarrationFor`, never by position, and carries no
   * `tool_use_id`, so nothing that counts calls or reads a call's outcome sees it. Words the cursor holds for another id never go to a call.
   */
  #settleLateNarration(key: string, cursor: NarrationCursor): void {
    const waiting = this.#state.lateNarr;
    if (waiting === undefined) return;
    for (const [id, w] of Object.entries(waiting)) {
      if ((w.agentId === undefined ? w.session : `${w.session}/${w.agentId}`) !== key) continue;
      const found = lookup(cursor, id);
      if (found.source !== "agent") continue;
      delete waiting[id];
      this.#state.outbox.push({
        key: `narr#${++this.#state.seq}`,
        tool: "hook",
        args: {
          hookAdapter: 1,
          hookEvent: "LateNarration",
          lateNarrationFor: id,
          host: this.#ev.host,
          session_id: w.session,
          ...(w.agentId === undefined ? {} : { agent_id: w.agentId }),
          narration: found.text === undefined ? found : { ...found, text: this.#redactWords(found.text) },
        },
        intent: "narration found after the call closed",
      });
    }
  }

  /** The host's session file for this event's session: the payload's path, else where the host's profile says to look. */
  #sessionFile(): string | undefined {
    const given = this.#ev.transcriptPath;
    if (typeof given === "string" && path.isAbsolute(given) && given.endsWith(".jsonl")) return given;
    const session = this.#ev.session;
    if (!this.#ev.sessionFileBySessionId || typeof session !== "string") return undefined;
    // The host's own folder layout names the file; `codexSessions` (the option's name is kept) points a test at a temp tree.
    return profileOf(this.#ev.host).sessionFile.locate(session, this.#now(), this.#opts.codexSessions);
  }

  /**
   * The session's place in the host's file, read up to the file's current end; undefined when there is no file. Never throws.
   * For a helper's call (`agentId`), the place in that helper's own transcript, kept apart from the session's; the helper's words
   * are not in the session file. No such regular file (a link, a missing folder, a host that keeps none) is no cursor.
   */
  #narrationCursor(agentId?: string, forward = false): NarrationCursor | undefined {
    try {
      const session = this.#ev.session;
      let file = this.#sessionFile();
      if (agentId !== undefined) {
        file = this.#ev.helperTranscriptPath ?? (typeof session === "string" ? profileOf(this.#ev.host).sessionFile.locateHelper?.(session, agentId, this.#now(), this.#opts.codexSessions) : undefined);
        if (file === undefined || !lstatSync(file).isFile()) return undefined;
      }
      if (file === undefined) return undefined;
      const key = agentId === undefined ? session : `${session}/${agentId}`;
      const held = this.#state.narr[key];
      const cursor = held !== undefined && held.path === file && validCursor(held) ? held : newCursor(file, agentId !== undefined);
      // The read goes on from the cursor's place window by window at every event, so a line flushed late is never stepped over; only
      // a file the budget could not catch up with falls back to its newest bytes (the call being looked at is there).
      // One budget (docs/hooks.md: 150 ms per event) covers the forward read and the newest-bytes read together.
      const deadline = performance.now() + READ_BUDGET_MS;
      advanceForward(this.#ev.host, cursor, { budgetMs: READ_BUDGET_MS });
      if (!forward) advance(this.#ev.host, cursor, { budgetMs: Math.max(1, deadline - performance.now()) });
      this.#settleLateNarration(key, cursor);
      delete this.#state.narr[key];
      this.#state.narr[key] = cursor;
      for (const old of Object.keys(this.#state.narr).slice(0, -SESSIONS_KEPT)) delete this.#state.narr[old];
      return cursor;
    } catch {
      return undefined;
    }
  }

  /**
   * Outside watching off: narration names no path outside the task folder, as the call's command does not. Only things that are
   * paths are masked: "~/x" and "~user/x" (a "~" before a digit, a space or the end is prose: "~100 cells"), and "/x" that begins an
   * absolute path (a "/" before a space, or inside a word, is prose: "a / b", "and/or"). A URL ("https://host/a/b") is not a local
   * path and is left whole: its "/" follows ":" , "/" or a word character, which never begin a path here.
   */
  #redactWords(text: string): string {
    if (this.#on()) return text;
    return this.#redact(text).replace(/(?<![\p{L}\p{N}_.~$:\/-])(?:~(?:[\p{L}_][\p{L}\p{N}_.-]*)?\/|\/(?=[\p{L}\p{N}_.$@%+-]))[^\s"'`<>)\]}]*/gu, (m) => {
      const trimmed = m.replace(/[.,;:!?]+$/, "");
      return m.startsWith("~") || this.#isOutside(trimmed) ? `[outside path]${m.slice(trimmed.length)}` : m;
    });
  }

  /**
   * A helper's call for a host that keeps no helper files (Copilot): the launch is the one open main-line launcher call of the session
   * (`task`). With none, or with several open at once, the launch is not named, so it stays a suspect at every sweep (never narrowed to someone else alone).
   * A call of a helper already seen takes the launch that helper's earlier call named.
   */
  #openLauncherOf(agentId: string): string | undefined {
    const earlier = Object.values(this.#state.open).find((c) => c.session === this.#ev.session && c.agentId === agentId && c.launchToolUseId !== undefined);
    if (earlier !== undefined) return earlier.launchToolUseId;
    const launches = Object.entries(this.#state.open).filter(([, c]) => c.session === this.#ev.session && c.agentId === undefined && isLauncherTool(c.tool));
    // The helper's first prompt matched exactly one launch; its args key finds that launch among those open, even with several open.
    if (this.#ev.launchKey !== undefined) {
      const named = launches.filter(([, c]) => c.argsKey === this.#ev.launchKey);
      if (named.length === 1) return named[0]![0];
    }
    return launches.length === 1 ? launches[0]![0] : undefined;
  }

  /** The call this payload describes, as it is when seen now. */
  #callNow(): OpenCall {
    const input = (this.#ev.toolInput ?? {}) as Record<string, unknown>;
    // A connector's command and description are input values, which are not stored.
    const own = !isMcpTool(this.#ev.toolName);
    const agentId = cleanId(this.#ev.agentId);
    const agentType = cleanId(this.#ev.agentType, true);
    const launchToolUseId = agentId === undefined ? undefined : agentLauncher(this.#ev.host, this.#ev.transcriptPath, this.#ev.session, agentId) ?? this.#openLauncherOf(agentId);
    return {
      tool: this.#ev.toolName ?? "",
      ...(profileOf(this.#ev.host).calls === undefined ? {} : { argsKey: profileOf(this.#ev.host).calls!.argsKey(this.#ev.toolInput) }),
      named: this.#named(),
      session: this.#ev.session,
      ...(agentId === undefined ? {} : { agentId, ...(agentType === undefined ? {} : { agentType }), ...(launchToolUseId === undefined ? {} : { launchToolUseId }), ...(this.#ev.launchKey !== undefined && launchToolUseId !== undefined ? { linkedLaunch: true as const } : {}) }),
      command: this.#redact(own && typeof input.command === "string" ? input.command : ""),
      description: this.#redact(own && typeof input.description === "string" ? input.description : ""),
      toolLabel: this.#label(),
      ...this.#turnPrompt(agentId),
      at: this.#now(),
      ...this.#reach(),
      ...(input.run_in_background === true ? { background: true } : {}),
      ...(waitsOnHelpers(this.#ev.toolName, input) ? { waits: true as const } : {}),
      ...this.#writeIntent(),
    };
  }

  /**
   * What the call's own input says about writing. `writes`: the files its input names as write targets (resolved against the payload's
   * cwd, kept only inside the task folder, so no outside path is stored). `readOnly`: a shell command made only of known read-only forms.
   * Both are read from the input alone; an input the readers do not understand says nothing, which keeps today's credit.
   */
  #writeIntent(): { writes?: string[]; readOnly?: true; patchRead?: OpenCall["patchRead"] } {
    const input = this.#ev.toolInput;
    const rel = (p: string) => path.resolve(this.#cwd(), p);
    const writes = [...new Set(writeTargetsOf(this.#ev.toolName, input).filter((p) => !p.startsWith("~")).map(rel).filter((p) => !this.#isOutside(p) && !isDeliveryPath(this.#folder, p) && !isHomePath(this.#opts.home, p)))];
    const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined;
    const readOnly = isShellTool(this.#ev.toolName) && typeof command === "string" && isReadOnlyCommand(command);
    const edits = editTargetsOf(this.#ev.toolName, input, (p) => pathKit().isAbs(p), rel)?.filter((p) => !this.#isOutside(p) && !isDeliveryPath(this.#folder, p) && !isHomePath(this.#opts.home, p));
    const reported = edits === undefined ? [] : reportedEditsOf(this.#ev.toolName, input, (p) => pathKit().isAbs(p), (t) => createHash("sha256").update(t, "utf8").digest("hex"), rel).filter((c) => !this.#isOutside(c.path) && !isDeliveryPath(this.#folder, c.path) && !isHomePath(this.#opts.home, c.path));
    // The input is already scrubbed at the entry (normalize.ts): a withheld section has no replay, so that file keeps inferred credit.
    const kept = reported.filter((c) => !(c.sections ?? []).some((s) => isWithheldSection(s.lines)));
    const cwd = this.#ev.cwd;
    const patchRead = isPatchTool(this.#ev.toolName)
      ? {
          input: input === undefined ? "none" : input === null ? "null" : Array.isArray(input) ? "array" : typeof input,
          quoted: typeof input === "string" && /^\s*"/.test(input),
          cwd: cwd === undefined || cwd === "" ? "absent" : /^[A-Za-z]:\\/.test(cwd) ? "drive-backslash" : /^[A-Za-z]:\//.test(cwd) ? "drive-slash" : cwd.startsWith("/") ? "posix" : /^\\\\/.test(cwd) ? "unc" : "other",
          named: writeTargetsOf(this.#ev.toolName, input).length,
          inside: (edits ?? []).length,
          reported: kept.length,
        }
      : undefined;
    return { ...(writes.length > 0 ? { writes } : {}), ...(edits !== undefined && edits.length > 0 ? { edits } : {}), ...(kept.length > 0 ? { reported: kept } : {}), ...(readOnly ? { readOnly: true as const } : {}), ...(patchRead === undefined ? {} : { patchRead }) };
  }

  /**
   * Where the call's tool_result will be: the helper's own transcript for a helper's call, else the session file; from its size now,
   * less a margin (the result is written after this Pre, so the margin only guards a slow stat). Only a host that keeps helper transcripts
   * beside its session file (Claude Code); none for a link or a missing file.
   */
  #transcriptAt(): { transcript?: { file: string; from: number } } {
    if (profileOf(this.#ev.host).helpers === undefined) return {};
    const file = cleanId(this.#ev.agentId) !== undefined ? this.#ev.helperTranscriptPath : this.#sessionFile();
    if (file === undefined) return {};
    try {
      const st = lstatSync(file);
      return st.isFile() ? { transcript: { file, from: Math.max(0, st.size - TRANSCRIPT_LOOKBACK_BYTES) } } : {};
    } catch {
      return {};
    }
  }

  /** The session's latest request, for a main-agent call on a host that shows narration as the reason. A wake prompt is not a request. */
  #turnPrompt(agentId: string | undefined): { turnPrompt?: string } {
    if (agentId !== undefined || !profileOf(this.#ev.host).narration.sources.some((s) => s.reason)) return {};
    const last = this.#state.held[this.#ev.session]?.prompts.at(-1);
    if (last === undefined || last.startsWith("<task-notification>")) return {};
    const text = this.#redactWords(last).replace(/\s+/g, " ").trim();
    return text === "" ? {} : { turnPrompt: text.slice(0, REASON_FALLBACK_MAX) };
  }

  /** What a row's reason falls back to when the host gave the call no reason of its own: the narration of a host that marks it a reason source, else the turn's request. */
  #reasonFallback(call: OpenCall): string {
    if (call.description !== "") return "";
    const n = call.narration;
    if (n?.source === "agent" && n.text !== undefined && profileOf(this.#ev.host).narration.sources.some((s) => s.reason)) {
      const text = n.text.replace(/\s+/g, " ").trim();
      if (text !== "") return text.slice(0, REASON_FALLBACK_MAX);
    }
    return call.turnPrompt ?? "";
  }

  /** The call's safe label; with outside watching off, paths outside the folder and path-like words are masked first. */
  #label(): ToolLabel {
    const text = (s: string) => (this.#ev.toolName?.toLowerCase() === "bash" ? this.#redact(s) : this.#redactWords(s));
    const mask = (p: string) => {
      if (this.#on()) return p;
      if (p.startsWith("~")) return "[outside path]";
      return this.#isOutside(path.resolve(this.#cwd(), p)) ? "[outside path]" : p;
    };
    const label = toolLabel(this.#ev.toolName, this.#ev.toolInput, { text, path: mask });
    // A withheld field also records where the host wrote the call (its transcript file and the call's id), so the person's own page can bring the text back.
    const id = this.#ev.toolUseId;
    const file = cleanId(this.#ev.agentId) !== undefined ? this.#ev.helperTranscriptPath : this.#sessionFile();
    if (label.withheld !== undefined && typeof id === "string" && id !== "" && typeof file === "string" && path.isAbsolute(file)) {
      for (const w of Object.values(label.withheld)) w.locator = { file, id };
    }
    return label;
  }

  /** Workbooks of the folder the call's input names, by full path or file name. */
  #named(): string[] {
    const text = JSON.stringify(this.#ev.toolInput ?? "").toLowerCase();
    return Object.keys(this.#state.files).filter((f) => this.#claimed(f) && (text.includes(f.toLowerCase()) || text.includes(path.basename(f).toLowerCase())));
  }

  async post(): Promise<void> {
    const id = this.#ev.toolUseId;
    await this.#baseline();
    this.#expire();
    const changed = await this.#sweep();
    const call = id ? this.#state.open[id] : undefined;
    if (id && this.#ev.failure === undefined) this.#ev = this.#withRolloutFailure(this.#ev, id, call);
    if (!id) {
      this.#unclaimed(changed, Object.keys(this.#state.open).sort());
      return;
    }
    if (!call) {
      // No open call: its Pre was never seen, or the call expired. Nothing can say this call made what moved.
      this.#unclaimed(changed, Object.keys(this.#state.open).sort());
      if (this.#state.expired.includes(id)) {
        // The Post of a call expiry closed: its real outcome replaces the expiry one (the reader takes the last op of a call). It credits nothing: the cells stay with the expiry op.
        this.#state.expired = this.#state.expired.filter((c) => c !== id);
        const late = this.#callNow();
        this.#narrate(id, late);
        this.#log(id, late, [], this.#failure() ? "failure" : "post", false);
      } else if (!this.#state.closed.includes(id)) {
        const ghost = this.#callNow();
        this.#narrate(id, ghost);
        this.#log(id, ghost, [], this.#failure() ? "failure" : "ghost-post", false);
        this.#markClosed(id);
      }
      return;
    }
    const open = this.#openCalls();
    const own = this.#credit(changed, open, id);
    this.#proveAtOwnPost(id, call);
    // A same-bytes rewrite found at this Post is noted on this call's op when the call could have written the file.
    const rewrote = [...this.#rewrites].filter((r) => this.#mayCredit(id, path.join(this.#folder, r), id));
    if (rewrote.length > 0) call.sameBytes = [...new Set([...(call.sameBytes ?? []), ...rewrote])].sort();
    this.#narrate(id, call);
    if (call.background && !isLauncherTool(call.tool)) {
      // The job outlives its Post: keep it open, with what this Post found, so its later writes are joint with it.
      appendAll((this.#state.pending[id] ??= []), own);
      this.#foldPending(id);
      return;
    }
    const carried = [...(this.#state.pending[id] ?? []), ...own];
    delete this.#state.pending[id];
    delete this.#state.open[id];
    this.#keepClosedWriter(id, call);
    if (!this.#failure()) this.#keepTail(id, call);
    this.#markClosed(id);
    // From its failure event on, the call is credited with nothing more, so a file it left unreadable no longer names it as an owner.
    if (this.#failure()) for (const f of Object.values(this.#state.files)) if (f.unreadable?.calls[id]) f.unreadable.calls[id].failed = true;
    this.#log(id, call, carried, this.#failure() ? "failure" : "post");
  }

  /**
   * A host whose session file records each call's exit status (`sessionFile.callExit`): a Post with no failure of its own whose call that file
   * lists as failed (matched by the call id, never by text) becomes a failure carrying the exit code, marked inferred so it says nothing about other calls.
   */
  #withRolloutFailure(ev: NormalizedEvent, id: string, call: OpenCall | undefined): NormalizedEvent {
    const sf = profileOf(ev.host).sessionFile;
    if (sf.callExit === undefined) return ev;
    const session = call?.session ?? (cleanId(ev.session));
    if (session === undefined) return ev;
    const agent = call === undefined ? cleanId(ev.agentId) : call.agentId;
    // The call's own start time places the rollout's day folder; the clock is read only when there is no open call (reading it moves a test clock).
    const at = call?.at ?? this.#now();
    const rollout = agent === undefined ? sf.locate(session, at, this.#opts.codexSessions) : sf.locateHelper?.(session, agent, at, this.#opts.codexSessions);
    const hit = rollout === undefined ? undefined : sf.callExit(rollout)?.get(id);
    if (hit === undefined) return ev;
    return { ...ev, failure: { raw: exitFailureText(hit), interrupted: false, inferred: true } };
  }

  /**
   * How this event says the call failed, or null. Only the host's own words count: a PostToolUseFailure event, or a PostToolUse whose
   * `tool_response` carries the flag `is_error` / `isError` set to true. Exit status, stderr and any text containing "error" are never read,
   * so a command that wrote to stderr and exited 0 stays a success. The text is the host's `error` (or the flagged response's text), with
   * outside paths masked when outside watching is off and any line that looks like a secret replaced.
   */
  #failure(): { text: string; interrupted: boolean; inferred?: true } | null {
    const f = this.#ev.failure;
    if (f === undefined) return null;
    const { raw, interrupted } = f;
    const inferred = f.inferred === true ? { inferred: true as const } : {};
    if (raw.trim() === "") return { text: interrupted ? "The call was interrupted before it finished." : FAILED_NO_TEXT, interrupted, ...inferred };
    const safe = this.#redactWords(raw)
      .split("\n")
      .map((line) => (looksSecret(line) ? "[line with a secret-looking value, not recorded]" : line))
      .join("\n");
    return { text: safe.length > ERROR_TEXT_MAX ? `${safe.slice(0, ERROR_TEXT_MAX)}... (${safe.length} characters)` : safe, interrupted, ...inferred };
  }

  /** Queues the call's ops: one per file it is credited with a change of, or one op naming no file. */
  #log(id: string, call: OpenCall, entries: Entry[], closedBy: ClosedBy, seenOpen = true): void {
    // Refused by the host, or a Pre that no Post and no transcript result ever followed, closed by this agent's Stop: it is not stored OK.
    const notRun = closedBy === "refused" || (closedBy === "stop" && (call.ended === undefined || neverRan(call.ended)));
    const { command, description } = call;
    this.#noteSession(id, call.session);
    this.#markCalled(call.session, call.agentId);
    if (closedBy !== "late") this.#awaitLateNarration(id, call);
    const closedAt = clockOrUnknown(this.#now());
    const jointWith = [...new Set([id, ...entries.flatMap((e) => e.with)])].sort();
    let intent = [command, description].filter((s) => s !== "").join(" - ") || call.tool || "tool call";
    if (jointWith.length > 1) intent += ` [joint attribution: calls ${jointWith.join(", ")} overlapped]`;
    // A late op carries cells found after the call closed, from a file that was unreadable during it.
    if (closedBy === "late") intent += " [cells found after this call closed, in a file it left unreadable]";
    const ownPaths = [...new Set(entries.filter((e) => e.origin === id).map((e) => e.path))];
    // The audit fields come first and stay small: if the ledger ever cuts the args to a stand-in, its preview keeps them.
    const failure = closedBy === "failure" ? this.#failure() : null;
    const base = {
      hookAdapter: 1,
      tool_use_id: id,
      closedBy,
      ...(notRun ? { notRun: true } : {}),
      // The host's error text for a failed call; absent on every call that did not fail and on ops written before this field.
      ...(failure === null ? {} : { error: failure.text, ...(failure.interrupted ? { interrupted: true } : {}), ...(failure.inferred === true ? { errorInferred: true } : {}) }),
      background: call.background === true,
      ...(call.waits === true ? { waits: true } : {}),
      // How the transcript showed the call ended, when it did before the call closed: the timeline credits it no further.
      ...(call.ended === undefined ? {} : { ended: call.ended }),
      // The call was tagged, and the files the tag's write evidence proved it wrote (the timeline's side of the evidence seam).
      ...(call.tagged === true ? { tagged: true, hook: { wrote: call.hookWrote ?? 0, spawned: call.hookSpawned === true, starts: call.hookStarts ?? [] } } : {}),
      ...(call.provenWrites === undefined ? {} : { provenWrites: call.provenWrites }),
      // Files this call rewrote with the bytes they already had (no state, no step); the stale rule reads it.
      ...(call.sameBytes === undefined ? {} : { sameBytesRewrites: call.sameBytes }),
      ...(seenOpen ? { openedAt: clockOrUnknown(call.at) } : {}),
      // The call's start order, from the counter requests are stamped with; the op key's own number is its close order.
      ...(call.startSeq === undefined ? {} : { startSeq: call.startSeq }),
      closedAt,
      // Wall-clock span of the call and the adapter's own time so far; "unknown" (never 0) when a clock is missing or skewed.
      wallMs: seenOpen && typeof closedAt === "number" && call.at <= closedAt ? closedAt - call.at : "unknown",
      processingMs: this.#processingMs(),
      host: this.#ev.host,
      session_id: call.session,
      tool_name: call.tool,
      // Forward-only: the subagent that made the call. Absent on the main line and on every op written before this field.
      ...(call.agentId === undefined ? {} : { agent_id: call.agentId, ...(call.agentType === undefined ? {} : { agent_type: call.agentType }), ...(call.launchToolUseId === undefined ? {} : { launch_tool_use_id: call.launchToolUseId }) }),
      jointWith,
      // The steps (sweeps that changed a file) found while the call was open: ids are filled in when the ledger is written.
      steps: [...new Set([...entries.flatMap((e) => (e.step === undefined ? [] : [e.step])), ...(this.#state.callSteps[id] ?? [])])].sort((a, b) => a - b),
      namedFiles: call.named,
      ownPaths,
      outsideWatching: this.#on(),
      // The host's own words for the call; the page shows these, not the command inside the intent.
      description: call.description,
      // The words a row shows as its reason when `description` is empty; absent when there are none.
      ...(this.#reasonFallback(call) === "" ? {} : { reasonFallback: this.#reasonFallback(call) }),
      // What the call's input names (skill, query, path, URL...), never content; see tool-label.ts.
      ...(call.toolLabel === undefined ? {} : { toolLabel: call.toolLabel }),
      // The agent's own words on the call, or "no narration recorded". Context only; no row, credit or order reads it.
      narration: call.narration ?? none(),
      ...(call.outside ? { outsideRefs: call.outside } : {}),
      ...(call.pathUnknown ? { pathUnknown: true } : {}),
      ...(call.outsideCount ? { outsideCount: call.outsideCount } : {}),
      ...(call.workedIn ? { workedIn: call.workedIn } : {}),
      ...(call.patchRead === undefined ? {} : { patchRead: call.patchRead }),
    };
    const record = (args: Record<string, unknown>) =>
      this.#state.outbox.push({ key: `${id}#${++this.#state.seq}`, tool: call.tool || "hook", args: { ...base, ...args }, intent, ...(closedBy === "failure" ? { failed: true } : {}), ...(notRun ? { notRun: true } : {}) });
    delete this.#state.callSteps[id];
    if (entries.length === 0) {
      record({});
      return;
    }
    const byPath = new Map<string, Entry[]>();
    for (const e of entries) {
      const list = byPath.get(e.path);
      if (list) list.push(e);
      else byPath.set(e.path, [e]);
    }
    for (const [file, list] of byPath) {
      record({
        path: file,
        ...(this.#isOutside(file) ? { outsideFolder: true } : {}),
        ...(list.some((e) => e.note) ? { fileNote: [...new Set(list.flatMap((e) => (e.note ?? "").split("; ").filter((x) => x !== "")))].join("; ") } : {}),
        ...(list.some((e) => e.copyOf) ? { copyOf: list.find((e) => e.copyOf)!.copyOf } : {}),
      });
    }
  }

  /**
   * UserPromptSubmit: queues the user's text as an op of the round the turn opens. It runs no sweep and needs no
   * workbook. No prompt text (a host whose payload lacks it) logs nothing, and the page says the request was not captured.
   */
  async prompt(): Promise<void> {
    const raw = this.#ev.prompt;
    if (typeof raw !== "string" || raw.trim() === "") return;
    const text = raw;
    // The ledger cuts args past 64 KB (up to 4 bytes a character): keep the prompt well under it so the op stays whole.
    const prompt = text.length <= PROMPT_MAX ? text : `${text.slice(0, PROMPT_MAX)}... (${text.length} characters)`;
    const held = (this.#state.held[this.#ev.session] ??= { prompts: [], dropped: 0, seqs: [], ats: [], firsts: [] });
    // A state written before prompts were stamped holds prompts without the stamps: pad them as unknown so the arrays stay parallel.
    held.seqs ??= held.prompts.map(() => 0);
    held.ats ??= held.prompts.map(() => "unknown" as const);
    held.firsts ??= held.prompts.map(() => null);
    held.prompts.push(prompt);
    held.seqs.push(++this.#state.seq);
    held.ats.push(clockOrUnknown(this.#now()));
    held.firsts.push(null);
    // With a task already open, the request is written now, not at the round's first call, so a live review page shows it at once.
    // A wake notification waits for the round's close as before (it is not something the person typed). The ledger ops are written once: `early` marks them.
    // The hook gate lets only a tracked session reach here, so a first prompt opens the session's task: the folder's starting copy is taken now,
    // before anything can change, and the prompt op is the one that opens it. An untracked session never gets this far and opens nothing.
    if (!prompt.startsWith("<task-notification>")) {
      const opens = !this.#sessionHasWork(this.#ev.session);
      if (opens) await this.#baseline();
      this.#logEarly(held, opens && !this.#sessionHasWork(this.#ev.session), parseFollowUpMarker(text));
    }
    if (held.prompts.length > PROMPTS_KEPT) {
      // A prompt already written mid-round is in the ledger: only the ones pushed out unwritten are "earlier".
      const out = held.prompts.length - PROMPTS_KEPT;
      held.dropped += held.seqs.slice(0, out).filter((q) => !this.#written(held, q)).length;
      held.prompts = held.prompts.slice(-PROMPTS_KEPT);
      held.seqs = held.seqs.slice(-PROMPTS_KEPT);
      held.ats = held.ats.slice(-PROMPTS_KEPT);
      held.firsts = held.firsts.slice(-PROMPTS_KEPT);
    }
    const sessions = Object.keys(this.#state.held);
    if (sessions.length > SESSIONS_KEPT) {
      const oldest = (id: string) => this.#state.held[id]?.seqs?.[0] ?? 0;
      sessions.sort((a, b) => oldest(a) - oldest(b));
      for (const id of sessions.slice(0, sessions.length - SESSIONS_KEPT)) delete this.#state.held[id];
      this.#state.called = this.#state.called.filter((id) => id in this.#state.held);
    }
  }

  /**
   * A task holds the session's work, or its queued ops are about to open one. With per-session tasks that is the session's own task,
   * or a change of its own waiting in the outbox; another session's queued ops count for nothing here (before, any queued op did).
   */
  #sessionHasWork(session: string): boolean {
    if (!this.#split) return this.#tasks.currentTaskId(this.#client) !== undefined || this.#state.outbox.length > 0;
    if (this.#tasks.currentTaskId(this.#clientOf(session)) !== undefined) return true;
    if (this.#state.outbox.some((op) => this.#sessionOfOp(op) === session && this.#opChanges(op))) return true;
    return this.#state.stepOutbox.some((step) => step.baseline !== true && step.files.some((f) => (f.credited ?? step.credited).some((id) => this.#sessionOfCall(id) === session)));
  }

  /**
   * The session's main agent made a call this round, so the round shows its held prompts. The mark is per agent. A helper
   * shares the session id but is not the turn the held prompts belong to, so its call leaves the mark alone: whether a main-agent
   * turn keeps its request and reply no longer depends on a helper's timing.
   */
  #markCalled(session: string, agentId?: string): void {
    if (agentId !== undefined) {
      const helped = (this.#state.helped ??= []);
      if (!helped.includes(session)) helped.push(session);
      if (helped.length > SESSIONS_KEPT) this.#state.helped = helped.slice(-SESSIONS_KEPT);
      return;
    }
    if (!this.#state.called.includes(session)) this.#state.called.push(session);
    if (this.#state.called.length > SESSIONS_KEPT) this.#state.called = this.#state.called.slice(-SESSIONS_KEPT);
  }

  /**
   * The round closes: each session that called in it logs its held prompts (the round's request); the stopping
   * session's held prompts are then spent. A session that has not stopped keeps them for its next round.
   */
  #closeRoundPrompts(): boolean {
    // A wake prompt is logged even when its turn made no call (a read-only agent finishing and Claude only replying).
    // So is a request prompt, once a task (or work waiting to open one) exists: Claude only talked, and the page shows the
    // request with the words of its reply. With no task there is nothing to attach it to, so it is dropped as before.
    const stopping = this.#ev.session;
    const taskOpen = this.#sessionHasWork(stopping);
    let talked = false;
    for (const session of this.#state.called.includes(stopping) ? this.#state.called : [...this.#state.called, stopping]) {
      let held = this.#state.held[session];
      if (!held || held.prompts.length === 0) continue;
      if (!this.#state.called.includes(session)) {
        const fresh = (i: number): boolean => held!.logged === undefined || (held!.seqs?.[i] ?? 0) > held!.logged;
        const keep = held.prompts.map((t, i) => ((taskOpen && fresh(i)) || t.startsWith("<task-notification>") ? i : -1)).filter((i) => i >= 0);
        if (keep.length === 0) continue;
        if (session === stopping && keep.some((i) => !held!.prompts[i]!.startsWith("<task-notification>"))) talked = true;
        held = { ...held, prompts: keep.map((i) => held!.prompts[i]!), seqs: keep.map((i) => held!.seqs?.[i] ?? 0), ats: keep.map((i) => held!.ats?.[i] ?? "unknown"), firsts: keep.map((i) => held!.firsts?.[i] ?? null) };
      }
      // What a first step already wrote mid-round is not written again.
      const source0 = this.#state.held[session];
      const rest = held.prompts.map((_, i) => i).filter((i) => source0 === undefined || !this.#written(source0, held!.seqs?.[i] ?? 0));
      if (rest.length > 0) {
        this.#state.outbox.push({
          key: `prompt#${++this.#state.seq}`,
          tool: "hook",
          args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: this.#ev.host, session_id: session, at: clockOrUnknown(this.#now()), earlier: held.dropped, prompts: rest.map((i) => held!.prompts[i]!), requests: rest.map((i) => ({ seq: held!.seqs?.[i] ?? 0, at: held!.ats?.[i] ?? "unknown", firstStepSeq: held!.firsts?.[i] ?? null })) },
          intent: "user prompt",
        });
      }
      const source = this.#state.held[session];
      if (source) source.logged = Math.max(source.logged ?? 0, ...held.seqs ?? [0]);
    }
    delete this.#state.held[this.#ev.session];
    this.#state.called = [];
    this.#state.helped = [];
    return talked;
  }

  async stop(): Promise<void> {
    await this.#baseline();
    this.#expire();
    // A Stop closes only the calls of its own agent. A background helper shares the main session id but has its own agent
    // id, and its call may still be running: it stays open, and it is the only thing that can still claim what moved. Another session's calls neither claim nor close.
    const mine = (call: OpenCall): boolean => call.session === this.#ev.session && call.agentId === cleanId(this.#ev.agentId);
    const staying = Object.entries(this.#state.open).filter(([, call]) => call.session === this.#ev.session && !mine(call)).map(([id]) => id).sort();
    const swept = await this.#sweep();
    this.#stopSweptNothing = swept.length === 0;
    // With no other call open, whatever moved by now was found by no call's own Post: it is not from an agent call. With helper
    // calls open, they share it as at a Pre. A helper call that never reaches Post is closed by expiry, as any call is.
    if (staying.length > 0) this.#credit(swept, staying);
    else this.#unclaimed(swept, []);
    // The session's Stop ends its agent's app tails (after the Stop's sweep).
    this.#endTails(cleanId(this.#ev.session), cleanId(this.#ev.agentId));
    // This agent's calls that never reached Post (interrupted) keep only what other calls' Posts gave them jointly.
    for (const [id, call] of Object.entries(this.#state.open)) {
      if (mine(call)) this.#close(id, call, "stop");
    }
    // The round exists when this session recorded a call in it and a task holds it (or its ops are queued to open one). Read before
    // the prompts close: that spends the mark. A chat-only Stop, or one after sign-off, cuts no round and so writes no claim.
    // A main turn with no call of its own still keeps its request and reply when helper work is in flight for it: a helper call
    // of this session open at this Stop, or one that ran since the last main Stop. Another session's calls never count.
    if (staying.length > 0 || (this.#state.helped ?? []).includes(this.#ev.session)) this.#markCalled(this.#ev.session);
    const roundExists = this.#state.called.includes(this.#ev.session) && this.#sessionHasWork(this.#ev.session);
    const talked = this.#closeRoundPrompts();
    this.#closeRoundClaim(roundExists || talked);
  }

  /**
   * A helper finished. Its open calls that never got a Post close now (as a Stop closes its own agent's), not 10 minutes later.
   * Only that agent's calls in this session close: the main agent's, another helper's and another session's stay open. An event that
   * names no agent closes nothing (the main agent's calls carry no agent id, so a missing id must never match them). It cuts no
   * round and holds no prompt: the round belongs to the main agent's Stop.
   */
  async subagentStop(): Promise<void> {
    const agent = cleanId(this.#ev.agentId);
    if (agent === undefined) return;
    await this.#baseline();
    this.#expire();
    const mine = (call: OpenCall): boolean => call.session === this.#ev.session && call.agentId === agent;
    const staying = Object.entries(this.#state.open).filter(([, call]) => call.session === this.#ev.session && !mine(call)).map(([id]) => id).sort();
    const swept = await this.#sweep();
    if (staying.length > 0) this.#credit(swept, staying);
    else this.#unclaimed(swept, []);
    for (const [id, call] of Object.entries(this.#state.open)) {
      if (mine(call)) this.#close(id, call, "stop");
    }
    this.#recordFinish(agent);
  }

  /**
   * The helper's finish as an op of its own, with its last message redacted the way a closing claim is and cut at CLOSING_MAX.
   * Claude Code also fires SubagentStop for its own internal agents; those carry no agent type and are no helper of the work, so they
   * write nothing. It cuts no round: the op joins whichever round is cut next, as a prompt does.
   */
  #recordFinish(agent: string): void {
    const type = cleanId(this.#ev.agentType, true);
    if (type === undefined) return;
    const raw = typeof this.#ev.lastAssistantMessage === "string" ? cut(this.#ev.lastAssistantMessage, CLOSING_MAX) : "";
    const text = raw.trim() === "" ? undefined : this.#redactWords(raw);
    this.#state.outbox.push({
      key: `finish#${++this.#state.seq}`,
      tool: "hook",
      args: { hookAdapter: 1, hookEvent: "SubagentStop", host: this.#ev.host, session_id: this.#ev.session, agent_id: agent, agent_type: type, at: clockOrUnknown(this.#now()), seq: this.#state.seq, finish: text === undefined ? {} : { text } },
      intent: "helper finished",
    });
  }

  /**
   * The agent's final message as the round's closing claim: an op of its own, after the request's op, for every round the
   * Stop cuts. A Stop that cuts no round (nothing called, no task open) writes no op, as it did before narration: the claim never
   * creates a task or a round. The host's own last message wins; else what its session file holds; else "no narration recorded".
   */
  #closeRoundClaim(roundExists: boolean): void {
    if (!roundExists) {
      spend(this.#state.narr[this.#ev.session]);
      return;
    }
    let cursor: NarrationCursor | undefined;
    try {
      cursor = this.#narrationCursor();
      // A host whose file lags its Stop gets a bounded wait for the closing message, only when the payload and the file gave none.
      const profile = profileOf(this.#ev.host);
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      for (let waited = 0; waited < (profile.narration.closingWaitMs ?? 0) && typeof this.#ev.lastAssistantMessage !== "string" && profile.narration.closing(cursor) === ""; waited += 25) {
        Atomics.wait(sleeper, 0, 0, 25);
        cursor = this.#narrationCursor();
      }
      const claim = closingClaim(this.#ev.host, cursor, this.#ev.lastAssistantMessage);
      const closing = claim.text === undefined ? claim : { ...claim, text: this.#redactWords(claim.text) };
      this.#state.outbox.push({
        key: `closing#${++this.#state.seq}`,
        tool: "hook",
        args: { hookAdapter: 1, hookEvent: "Stop", host: this.#ev.host, session_id: this.#ev.session, at: clockOrUnknown(this.#now()), closing },
        intent: "agent closing claim",
      });
    } catch {
      // A bad file never blocks the Stop.
    }
    spend(cursor);
  }

  /**
   * True when a round already exists for the task and the ledger holds no op and no step since it. A Stop that swept nothing
   * and finds this (a chat-only turn) would cut a round identical to the last one: no request, no calls, no claim. The first round
   * is never skipped, and a hand edit found at the Stop is a swept change, so it still cuts.
   */
  #nothingSinceLastRound(taskId: number): boolean {
    const last = this.#ledger.roundsForTask(taskId).at(-1);
    if (last === undefined) return false;
    if (this.#ledger.okOpsForTask(taskId, last.lastOpId, this.#ledger.maxOpId()).length > 0) return false;
    return !this.#ledger.stepsForTask(taskId).some((step) => step.ts > last.ts);
  }

  /** Cuts the round. Runs after the state and the ops are safely written, so a kill here loses nothing. */
  async submit(): Promise<HookResult> {
    const taskId = this.#tasks.currentTaskId(this.#client);
    if (taskId === undefined) return {};
    if (this.#stopSweptNothing && this.#nothingSinceLastRound(taskId)) return {};
    try {
      return { summary: await this.#tasks.submit(this.#client, "turn closed by the Stop hook", false) };
    } catch (error) {
      if (error instanceof TaskError && error.code === NO_OPEN_TASK) return {};
      throw error;
    }
  }
}

/** The `hookOpKey` of a logged op's args JSON, also from the ledger's stand-in for oversized args (the key leads, so the preview holds it). */
function opKeyOf(argsJson: string): string | undefined {
  try {
    const args = JSON.parse(argsJson) as { hookOpKey?: unknown; preview?: unknown };
    if (typeof args.hookOpKey === "string") return args.hookOpKey;
    if (typeof args.preview === "string") return /"hookOpKey":"([^"]+)"/.exec(args.preview)?.[1];
  } catch {
    // not JSON: no key
  }
  return undefined;
}

/**
 * The named-file miss rate for a task (criterion 3 of the probe): of the calls that changed a workbook
 * themselves, how many changed one their input did not name. Overlap-attributed changes belong to no call
 * alone and are left out. Not a gate; it sizes how much rests on the diff rather than on the call's own words.
 */
export function namedFileMissRate(ledger: Ledger, taskId: number): { changing: number; missed: number } {
  const calls = new Map<string, boolean>();
  for (const op of ledger.okOpsForTask(taskId, 0, ledger.maxOpId())) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(op.argsJson);
    } catch {
      continue;
    }
    if (args.hookAdapter !== 1 || typeof args.path !== "string" || typeof args.tool_use_id !== "string") continue;
    if (!Array.isArray(args.ownPaths) || !(args.ownPaths as string[]).includes(args.path)) continue;
    const named = Array.isArray(args.namedFiles) ? (args.namedFiles as string[]) : [];
    calls.set(args.tool_use_id, (calls.get(args.tool_use_id) ?? false) || !named.includes(args.path));
  }
  return { changing: calls.size, missed: [...calls.values()].filter(Boolean).length };
}
