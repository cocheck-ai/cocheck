import { pathKit, type PathKit } from "../paths.ts";
import { isUriSubject } from "../connector/subject.ts";
import { subjectDisplay } from "./subject-display.ts";
import { fromDiffObject, type DiffObject } from "../connector/diff-object.ts";
import { createHash } from "node:crypto";
import { findProfile, profileOf } from "../hosts/index.ts";
import { isSecretPath, secretLine } from "../secret-files.ts";
import { EMPTY_SHA, secretShasOf } from "../secret-hashes.ts";
import path from "node:path";
import { readdirSync } from "node:fs";
import { platform } from "../platform/index.ts";
import { fingerprintTier, type Generic } from "./generic.ts";
import { NO_BEFORE_WORDING } from "../fingerprint.ts";
import { attributionOf, creditText, ledgerNoteOf, missingSentences, type By } from "./attribution.ts";
import { guardKit, creditWithEvidence, evidenceMayCredit, isInternalAgentCall, isLauncherTool, isWaitTool, launcherMayCredit, runsOnAfterResult, samePath, toolMayCredit, type CallEvidence, type CannotWrite, type WriteEvidence } from "../credit-guard.ts";
import { isInferredBasis } from "../attribution/basis.ts";
import { ENCRYPTED_BRIEF_NOTE, isEncryptedToken, isMcpTool } from "../tool-label.ts";
import { creditedAfterWriteSignal, scriptsWrittenBy, type ScriptLookup } from "./write-signal.ts";
import { callReads, callReadsUnknown, type ReadRef } from "./read-signal.ts";
import { changeNote, moreText, rowNote, type ConnectorChangeFacts, type MorePlace, type Note } from "./notes.ts";
import { registeredExtensions } from "./render/registry.ts";
import { imageTypeOf } from "./stored-image.ts";
import { LINE_RULE, SOURCE_NOTE, failedPart, isShell, lineOf, type LineSource } from "./describe.ts";
import { RUN_RULE, baseName, buildRuns, words, type Call, type RawOp, type RawState, type Run, type RunsResult, type State } from "./runs.ts";

/**
 * The timeline of a task: a pure read model. Ledger rows in, one JSON-able document out.
 * nothing here reads SQL, the disk or the clock. The loader (`load.ts`) reads the ledger and the state store and hands the rows over.
 *
 * Shape: requests, in call-start order, each split into runs by the four end rules (`runs.ts`), each run holding its calls.
 * A call has one line with its labelled source, and, for each file it was credited with, the file's state before and after and what
 * the format layer found changed in between. Credit is only what the record says (`file_states.credited_json`); a change open to two
 * calls stays joint. Who made a change is `change.by`, decided once by `attributionOf` (`attribution.ts`). Every absent piece is a
 * sentence in a `missing` list, never an empty field.
 *
 * Never in the body: the raw command (a separate fetch gives it), tool output, hidden reasoning, a path outside the task folder
 * (cut to its file name), another task's hashes. Paths inside the folder are relative to it.
 */

export const TIMELINE_SCHEMA = "cocheck.timeline/1";
const IMAGE_LABEL = "Image as stored";
const CLAIM_NOTE = "the agent's closing message, not checked against the files";
/** A prompt the host injected when a helper stopped (`<task-notification>`), not one the person typed. A notice that names no recorded launcher stays a request text, and is labelled so. */
export const NOTICE_LABEL = "the host's notice about a helper, not typed by the user";
const isHostNotice = (t: string): boolean => t.startsWith("<task-notification>");
const INFERRED_FAILURE_NOTE = "failure inferred from output text";
const FINISH_NOTE = "the helper's last message, not checked against the files";
const SEND_NOTE = "the message as the host recorded it";
const BRIEF_NOTE = "the brief as the host recorded it";

/** What the format layer found changed inside one file between two stored states, or why it could not say. */
export type FormatChanges =
  | { module: string; rows: FormatRow[]; more: number; moreIn?: MorePlace[]; identicalParts?: true }
  | { unavailable: string };

export interface FormatRow {
  location: string;
  kind: string;
  before: string | null;
  after: string | null;
  text: string;
  /** A label found left of or above the cell (`labelAt`), when the loader could read the sheet. Never set once values expire. */
  label?: string | null;
  /** The spreadsheet reader read both sides and found no cell difference: the file changed elsewhere. Set only then. */
  cellsUnchanged?: true;
  /** What also changed in the look of this cell when its value changed too ("turned bold"); the note appends it. */
  styleText?: string;
  /** One plain sentence on this row (`notes.ts`), set by the timeline; the loader leaves it out. */
  note?: Note;
}

export interface TimelineInput {
  taskId: number;
  /** The build serving this body, so a changed body shape never reads as an unchanged ETag. */
  build: string;
  ops: RawOp[];
  fileStates: RawState[];
  /** The folder the task watches (`folder.json`), or null when the record has none. */
  folder: string | null;
  /** `values_expired.ts`, when the task's values were expired. */
  valuesExpiredAt: string | null;
  /** States whose bytes were deleted, with the reason in words. */
  removals: ReadonlyArray<{ sha256: string; ts: string; reason: string }>;
  /** Hashes whose bytes are in the task's store right now, with their size. */
  stored: ReadonlyMap<string, number>;
  /** The format layer's findings, by `file_states.id`. */
  formats: ReadonlyMap<number, FormatChanges>;
  /** One DiffObject per change, by `file_states.id`. A built-in row's is `toDiffObject` of its FormatChanges, read back here through `fromDiffObject`; a connector row's is what the connector answered. Absent: `formats` alone. */
  diffs?: ReadonlyMap<number, DiffObject>;
  /** the plain reason of a failed known-subject capture, by the id of the call it belongs to. Only failures: an unchanged capture and an unmatched call are not here. */
  captureGaps?: ReadonlyMap<string, string>;
  /** No effect (images are shown by the browser on every OS); kept so callers that still pass it compile. */
  quickLook?: boolean;
  /** The generic entry (tier, label, picture or fingerprint) of a change, by `file_states.id`. A change with no entry reads as a fingerprint without bytes. */
  generics?: ReadonlyMap<number, Generic>;
  /** The task's host, from the `<host>-hook:` prefix of the client name its steps were written under; null when that proves none. */
  host?: string | null;
  /** The text of script files the task changed, by the hash of the version (`file_states.sha256`), for the calls that ran them. Only versions the store holds, as text. */
  scriptTexts?: ReadonlyMap<string, string>;
  /** Whether a file (absolute path, inside the folder) was there at task start and is not secret: on disk, older than the task's first step. Absent: no unchanged file is ever listed as read. */
  existsAtStart?: (file: string) => boolean;
  /** How each call ended, from the host's transcripts (`callEvidenceOf`), by tool_use id. Absent: only what the record says (an op's `ended`). */
  evidence?: ReadonlyMap<string, CallEvidence>;
  /** Positive write evidence (the per-call tag), ranked ahead of every open-call window. */
  writeEvidence?: WriteEvidence;
  /** Calls that provably cannot have written a file (their command's write scope is known and does not hold it). */
  cannotWrite?: CannotWrite;
  /** The path kit the credit guards compare with; defaults to the running platform's. A test passes the win32 kit on any OS. */
  guardKit?: PathKit;
  /** What the path scrub may read of the filesystem (directory names only, never contents); defaults to the real one. A test passes its own. */
  look?: PathLook;
}

/** The scrub's view of the filesystem. */
export interface PathLook {
  /** The names in a directory (not followed, not read), "missing" when it does not exist, null when it cannot be read. */
  list(dir: string): readonly string[] | "missing" | null;
  /** The account's home folder, for "$HOME", "${HOME}" and "%USERPROFILE%" in text. */
  home(): string;
}

const realLook: PathLook = {
  list(dir) {
    try {
      return readdirSync(pathKit().native(dir));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : null;
    }
  },
  home: () => platform().paths.userHome(),
};

export interface Line {
  text: string;
  /** Who said it. A rule-built line is always `cocheck-translation`, never `agent-words`. */
  source: "user" | "agent-words" | "agent-description" | "cocheck-translation" | "agent-claim";
  /** For a translation: what it was built from. */
  basis?: "tool-label" | "tool" | "shell";
  /** The source in words a page can print as is. */
  label: string;
  rule?: string;
  /** True when a path in the text was cut to its file name. */
  redacted?: boolean;
}

export interface StateRef {
  sha256: string;
  size: number | null;
  kept: "whole" | "hash" | "gone" | null;
  stored: boolean;
  /** Why the bytes are not in the store; null when they are. */
  why: string | null;
  preview: { label: string; ref: string | null; missing: string | null };
}

export interface Change {
  id: string;
  file: string;
  /** True when the file is outside the watched folder. Computed before the path is cut to its file name; no path text is added. */
  outside: boolean;
  /** When the change was recorded (epoch ms), or null when the record has no time for it. */
  at: number | null;
  kind: "created" | "modified" | "deleted";
  step: number | null;
  /** The file's modification time at the sweep (ns), the order of a call's changes; absent when the sweep did not record it. */
  mtimeNs?: string;
  before: StateRef | null;
  after: StateRef;
  credit: { calls: string[]; joint: boolean; text: string };
  /** Who made the change (`attributionOf`). Every surface takes its wording from this, never from `credit` or where the change is listed. */
  by: By;
  /** Set when the change is credited to a call but the credit is not proven (basis not argv-tag or host-reported-edit; none stored counts too). Absent otherwise. */
  inferred?: true;
  /** The ledger's own note on the change, without the hook's attribution words. */
  ledgerNote: string | null;
  /** One plain sentence on the change, built from rules (`notes.ts`); every number and quoted string in it is in this change's record. */
  note: Note;
  /**
   * Set when the file's very next change put it back to the exact bytes it had before this one (`undone`), or, for `restores`, when this
   * change put the file back to how it was before the previous change to it. `with` is the id of the other change of the pair.
   */
  roundTrip?: { role: "undone" | "restores"; with: string };
  format: { module: string; rows: FormatRow[]; more: number; moreIn?: MorePlace[]; identicalParts?: true } | null;
  /** A connector row's DiffObject (producer "connector"); the rail draws it natively. Absent on every built-in file change. */
  diff?: DiffObject;
  /**
   * a modified state whose frozen document from the claiming connector vouches that nothing changed (P3). With `by.kind`
   * "call" it stays on that agent's lane, muted; with any other kind it gets no lane stop and is left out of the missing sentences and the
   * lane counts. Absent otherwise (any other answer, or none, is a normal change).
   */
  resave?: true;
  /** How the change is shown whatever the file type: text, picture or fingerprint. A format part never replaces it. */
  generic: Generic;
  /** Earlier calls in the session that named the file without being credited with a change to it, since its previous change. */
  alsoNamedBy: Array<{ call: string; request: string }>;
  missing: string[];
}

export interface TimelineCall {
  id: string;
  index: number;
  of: number;
  host: string | null;
  tool: string | null;
  start: number | null;
  end: number | null;
  /** Files (relative to the watched folder) the call rewrote with the bytes they already had; absent when none. */
  rewrote?: string[];
  outcome: "succeeded" | "failed" | "unknown";
  closedBy: string | null;
  /** The host's error text when the call failed and the record holds it; null otherwise. */
  error: string | null;
  /** The host's whole error text, outside paths masked and cut at 4000 characters, behind a failed step's "Show output" (the rail's line is `error`). Absent unless it says more than `error` does. */
  errorFull?: string;
  /** On a failed shell call of several chained segments, the plain line of the segment that failed (read from the error text, else the first that ran without output). */
  failedPart?: string;
  background: boolean;
  /** True when the call ran no command (a Write or Edit tool call): the command route has nothing to show. Absent when it has one. */
  noCommand?: true;
  /** Whether the call named or changed a file (false for a lookup). */
  onTarget: boolean;
  /** The subagent that made the call, from the hook payload. Null on the main line, for a host that sends no agent id, and for ops written before the field. */
  agent: { id: string; type: string | null } | null;
  /** a known-subject capture of this call failed (no before side, no time window, a rejected or failed connector answer). `reason` is a plain sentence. Absent when nothing failed and for an unchanged or unmatched call. */
  captureGap?: { reason: string };
  /** For an agent's call, the id of the call that launched the agent (the lane's launcher), when the record holds it. */
  launchedBy?: string;
  /** For an agent's call made after a SendMessage resumed the agent, the id of that SendMessage call. */
  resumedBy?: string;
  /** On a SendMessage call, what the message said, when the record holds it: the recipient, the short summary, and the text, each scrubbed. Absent on every other call. */
  send?: { to: string | null; summary: string | null; text: string | null; /** The hook withheld the message, its content or its summary whole as secret-looking. */ withheld?: true };
  /** On a connector call (`mcp__server__tool`): the server, the tool's own name and the input field NAMES the record holds (never a value). Absent on every other call. */
  mcp?: { server: string; tool: string; inputFields: string[] };
  /** On an Agent or Task launch, what the helper was started for (the launch's own description, scrubbed), whatever form the call's line took. Absent on every other call and when the launch carries none. */
  purpose?: string;
  /** On an Agent or Task launch, the brief the main agent gave the helper (the call's prompt, scrubbed; a long one keeps its head and its ending). Absent on every other call and when the record holds none. */
  brief?: string;
  /** The hook withheld this launch's brief as secret-looking. */
  briefWithheld?: boolean;
  /** The host keeps this launch's brief encrypted (Codex): no text exists to show. */
  briefEncrypted?: boolean;
  /** The withheld fields of this call the person's own page can bring back from the host's transcript (names only, never text). Absent when none. */
  revealable?: string[];
  files: string[];
  /** The files the call read (`read-signal.ts`): paths as the call or its script wrote them, `inferred` false only for a Read tool call. Absent when none. */
  reads?: ReadRef[];
  /** True when the call ran a script whose text is missing, or whose file-opening calls name a path the text does not state: what it read cannot be fully told. Absent otherwise. */
  readsUnknown?: true;
  line: Line;
  changes: Change[];
  missing: string[];
}

export interface TimelineRun {
  id: string;
  rule: string;
  files: string[];
  callCount: number;
  failedCount: number | null;
  changedFiles: string[];
  changedAtCall: number | null;
  endedBy: "change" | "other target" | "end of request";
  calls: TimelineCall[];
  missing: string[];
}

/** A background agent's wake, owned by the request that owns the agent's launcher call. The raw notification text is never in the body. */
export interface TimelineWake {
  /** The launching call's id. */
  launch: string;
  /** The woken agent's id, when the record names one. */
  agentId: string | null;
  at: number | null;
  /** The host's status word; "completed" when the notification named none. */
  status: string;
  /** The notification's summary, scrubbed and cut at 300 characters; null when it had none. */
  summary: string | null;
}

/** A helper finished (the host's SubagentStop), with its last message when the record holds one. */
export interface TimelineFinish {
  agentId: string;
  agentType: string | null;
  at: number | null;
  text: Line | null;
}

/** One turn's closing message and the time it came. */
export interface TimelineReply {
  at: number | null;
  line: Line;
}

export interface TimelineRequest {
  id: string;
  index: number;
  session: string | null;
  texts: Line[];
  /** When the request was submitted (epoch ms), or null when the record has no time for it. */
  at: number | null;
  placement: { kind: "recorded" | "inferred"; note: string };
  closing: Line | null;
  /** Every turn's closing message this request owns, in order (`closing` is the last). Absent when none has words. */
  replies?: TimelineReply[];
  /** Where a shell command in the session switched tracking off, with its time. Absent when none did. */
  trackingStops?: Array<{ at: number | null }>;
  /** The helpers that finished for this request, in the order they came. Absent when none did. */
  finishes?: TimelineFinish[];
  runs: TimelineRun[];
  /** The wakes of background agents this request owns, in the order they came. */
  wakes?: TimelineWake[];
  missing: string[];
}

export interface Timeline {
  schema: typeof TIMELINE_SCHEMA;
  build: string;
  task: number;
  /** What the body was built from: the ETag hashes these. */
  builtFrom: { highestOpId: number; highestStateId: number; valuesExpiredAt: string | null };
  folder: string | null;
  hosts: string[];
  /** The task's host, from its client name (`TimelineInput.host`). */
  host: string | null;
  expired: { at: string; text: string } | null;
  requests: TimelineRequest[];
  /** Changes shown under no call: nobody's call is credited with them, or the record of the call is gone. */
  unplaced: Change[];
  missing: string[];
}

/** The validator for the body: the highest op id, the highest state id, the expiry stamp and the schema, plus what else moves the body. */
export function timelineEtag(input: Pick<TimelineInput, "ops" | "fileStates" | "valuesExpiredAt" | "removals" | "build" | "evidence" | "captureGaps"> & { captures?: string }): string {
  const hash = createHash("sha256");
  // Transcript evidence can grow while the ledger does not (a blocked call); its size and latest time are part of the tag.
  const ev = input.evidence === undefined ? "" : `${input.evidence.size}:${[...input.evidence.values()].reduce((m, e) => Math.max(m, e.at), 0)}`;
  hash.update(JSON.stringify([TIMELINE_SCHEMA, highest(input.ops), highest(input.fileStates), input.valuesExpiredAt ?? "", input.removals.length, input.build, ...(ev === "" ? [] : [ev]), ...(input.captureGaps === undefined || input.captureGaps.size === 0 ? [] : [`gaps:${[...input.captureGaps.keys()].sort().join(",")}`]), ...(input.captures === undefined ? [] : [`captures:${input.captures}`])]));
  return `"${hash.digest("hex").slice(0, 32)}"`;
}

function highest(rows: Array<{ id: number }>): number {
  return rows.reduce((m, r) => Math.max(m, r.id), 0);
}

const SOURCE: Record<LineSource, Pick<Line, "source" | "basis">> = {
  words: { source: "agent-words" },
  description: { source: "agent-description" },
  label: { source: "cocheck-translation", basis: "tool-label" },
  tool: { source: "cocheck-translation", basis: "tool" },
  shell: { source: "cocheck-translation", basis: "shell" },
};

// ---- The path scrub: what it promises and how it decides ----
// Promise: a path in free text the page shows (briefs, error text, notes) shows relative to the watched folder when it is inside it, and is
// otherwise never shown: cut to "[outside path]", or to its file name where the rules below allow. Text alone cannot tell "<folder>, then
// words" from a sibling folder named "<folder>, words", nor "pages/home/x" (relative) from "pages" glued to "/home/x"; where the text is
// ambiguous, the filesystem decides.
// Definition. 0. Web URLs (http, https): the scheme and host are never a path, nor is the path of a remote host (a dotted public name such
// as "github.com"). A local path inside a URL is scrubbed like any other: an absolute path starting a parameter value after "?", "&", ";" or "#"
// ("?file=/Users/...", "#file=/Users/..."), or a fragment starting at a known root or home ("#/Users/..."), on any host; and the path right after a host that may be this machine (localhost, *.localhost, *.local, an IP literal, a name without a dot,
// or none: when unsure, local) when it starts at a known root, a home or a drive. Other schemes are cut as links. "$HOME", "${HOME}", "%USERPROFILE%" and
// "%HOMEDRIVE%%HOMEPATH%" before a separator and a name are the account's home. Then, for each candidate path the shapes below find
// (normalised, ".." resolved; trailing sentence punctuation and closing brackets are not part of it and stay in the text):
//   1. Wholly inside the folder, with one root start: shown relative to it.
//   2. Otherwise a match running over whitespace may be split into a path and plain words, at the longest head that is
//      a. strictly inside the folder, at any whitespace (whatever follows stays inside: a match with ".." is never split), or
//      b. the folder itself, at a sentence boundary (punctuation, then whitespace), and only when no entry beside the folder has a name
//         that the folder's last name plus the following text starts with ("Smith" then ", Jane/..." is refused when "Smith, Jane" is
//         there), or
//      c. under a root outside the known list (and not starting with the folder, which reads as in a and b), at its first space, only
//         when the head is one name and no entry in "/" is carried on by the following text ("/2 and/or 3/4" stays). A deeper head
//         ("/srv/data/My Taxes/x.pdf", "/data/clients/acme/secret plans/x.pdf") is cut whole without reading anything.
//      The rest is read again as text. If no head qualifies, the match is cut whole. A real outside entry ("Smith, Jane") therefore
//      always fails 2b, so a path naming it is never split.
//   3. The folder itself, not split, followed by words that carry on an entry beside it ("<folder>, Jane notes" with "Smith, Jane notes"
//      there): that entry is the path, cut through its name.
//   4. A home root glued to the word before it ("x/Users/<name>/...") is a path when that home is on disk; when the home is not there
//      ("pages/home/components/x.tsx") the words are a relative path and stay, read again past the root name.
//   5. Any other outside path is cut like this: whole when it holds a space, a glued root or several roots; to its file name otherwise.
// Reads: directory listings only (names, never contents; entries never followed), cached per render, and only of the folder's parent,
// the home roots (/Users, /home, /Volumes, /mnt) and "/" (rule 2c); never of an arbitrary outside path's directory.
// A directory that cannot be read fails closed: a split or text that needs it is refused (the match is cut whole) and a glued root counts
// as a path. Names compare case-folded and NFC-normalised, the direction that refuses more.
// Path shapes the scrub cuts. A folder name may hold spaces, so an inner segment runs to its next separator; the last segment may
// run over a few words when it ends in a file extension ("final report.txt"). Over-cutting is the safe direction here.
const NOT_NAME = `"'\`<>|*?\\n`;
const BOUND = "(?=$|[\\s\"'`<>|,;:)!?])";
const LAST_POSIX = `(?:[^\\s${NOT_NAME}/]+\\.[A-Za-z0-9]{1,8}${BOUND}|(?:[^\\s${NOT_NAME}/]+ ){1,4}[^\\s${NOT_NAME}/]*\\.[A-Za-z0-9]{1,8}${BOUND}|[^\\s${NOT_NAME}/]+)`;
const INNER_POSIX = `(?:/[^\\s${NOT_NAME}/][^${NOT_NAME}/]*(?=/))*`;
const ROOT_NAMES = "Users|tmp|private|var|etc|home|opt|Volumes|usr|Library|Applications|System|mnt|root";
// A home root ("/Users/<name>/", "/home/<name>/", a mounted volume) names someone's files wherever it appears, so the scrub finds it
// even glued to the word before it ("x/Users/...", "./Users/...", "~user/Users/..."). Such a match never shows a file name.
const HOME_ROOT = `/(?:Users|home|Volumes|mnt)/[^\\s${NOT_NAME}/]+/`;
const HOME_AT = new RegExp(`^${HOME_ROOT}`);
// Another user's home ("~bob/...") is home-relative like "~/..."; the name starts with a letter so "~2/3" stays a number.
const TILDE = /^~(?:[A-Za-z][\w.-]*)?\//;
const POSIX_PATH = new RegExp(`(?:(?<![\\w./~])~(?:[A-Za-z][\\w.-]*)?/*(?=/)|(?<![\\w./~])|(?<=\\S)(?=${HOME_ROOT}))${INNER_POSIX}/${LAST_POSIX}/?`, "g");
const SCHEME_URL = new RegExp(`\\b(?!https?:)[a-z][a-z0-9+.-]*://[^\\s${NOT_NAME}/]*(?:${INNER_POSIX}/${LAST_POSIX}/?)?|\\bfile:${INNER_POSIX}/${LAST_POSIX}/?`, "gi");
const LAST_WIN = `(?:[^\\s${NOT_NAME}\\\\/]+\\.[A-Za-z0-9]{1,8}${BOUND}|(?:[^\\s${NOT_NAME}\\\\/]+ ){1,4}[^\\s${NOT_NAME}\\\\/]*\\.[A-Za-z0-9]{1,8}${BOUND}|[^\\s${NOT_NAME}\\\\/]+)`;
// A drive root or UNC start is found wherever it appears ("9C:/", ".\\C:\\", "x\\\\server"); after a letter only in its backslash form
// ("xC:\\"), so "note:/usr" stays a word and a posix path. A forward-slash UNC ("//server/share") is found unless a ":" (a URL) or another
// separator comes before it.
const WIN_PATH = new RegExp(`(?:(?:(?<![A-Za-z])[A-Za-z]:[\\\\/]|[A-Za-z]:\\\\)(?![\\\\/])|\\\\\\\\|(?<![:/\\\\])//(?=[^\\s${NOT_NAME}\\\\/]+/[^\\s${NOT_NAME}\\\\/]))(?:[^\\s${NOT_NAME}\\\\/][^${NOT_NAME}\\\\/]*(?=[\\\\/])[\\\\/])*${LAST_WIN}[\\\\/]?`, "g");
const OUTSIDE = "[outside path]";
// Sentence punctuation and closing brackets after a path are not part of it; they stay in the text after the relabel or cut.
const CLOSE_TAIL = /[.,;:)\]}»”’›]+$/;
const WIN_TAIL = /[\s,;)\]}»”’›]*$/;
const WEB_URL = /\bhttps?:\/\/[^\s"'`<>]+/gi;
// A home variable before a separator and a name ("$HOME/x", "%USERPROFILE%\\x") is the account's home.
const ENV_HOME = /(?:\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)(?=[\\/][^\s\\/])/gi;
const nameKey = (s: string): string => s.normalize("NFC").toLowerCase();

// The path right after a host that may be this machine is a local path when it starts at a known root, a home, or a drive.
const LOCAL_URL_PATH = new RegExp(`^/(?:(?:${ROOT_NAMES})(?=[/?#]|$)|~|[A-Za-z]:[\\\\/])`);
/**
 * Whether a URL host may be this machine: localhost and *.localhost, *.local, any IP literal, a name without a dot, or none. Only a dotted
 * public name ("github.com", "x.test") is remote; when unsure the host counts as local, so its path is scrubbed.
 */
function localHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "" || !h.includes(".") || /(?:^|\.)(?:localhost|local)$/.test(h) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.startsWith("[");
}

// A local path as a parameter value after "?", "&", ";" or "#" ("?file=/Users/...", "#file=/Users/..."), or a fragment that starts at a
// known root or home ("#/Users/..."): the match ends where the path starts.
const URL_PARAM_PATH = new RegExp(`[?&;#][^=&;#]*=(?=/[^\\s/]|~/|[A-Za-z]:[\\\\/])|#(?=/(?:${ROOT_NAMES})/|~/)`);

type Scanned = string | { text: string; used: number };
/** `text.replace(re, fn)`, except `fn` sees the whole text (so a lookbehind reads real context) and may consume less than its match. */
function scan(text: string, re: RegExp, fn: (m: string, off: number, all: string) => Scanned): string {
  const r = new RegExp(re.source, re.flags);
  let out = "";
  let pos = 0;
  for (let mm = r.exec(text); mm !== null; mm = r.exec(text)) {
    if (mm[0] === "") {
      r.lastIndex++;
      continue;
    }
    const got = fn(mm[0], mm.index, text);
    out += text.slice(pos, mm.index) + (typeof got === "string" ? got : got.text);
    pos = mm.index + (typeof got === "string" ? mm[0].length : Math.max(1, got.used));
    r.lastIndex = pos;
  }
  return out + text.slice(pos);
}

const NAME_CHAR = /[\p{L}\p{N}._-]/u;
/**
 * Whether a scrub match holds a root start after its own (scanning from `from`, past the first root). A root start is a drive root, or
 * a "/" or "\\" whose previous character is not a name character or another separator (a space, bracket, "=", quote and the like all count).
 * A match with one is more than one path, so the scrub cuts it whole.
 */
function hasLaterRoot(m: string, from: number): boolean {
  for (let i = from; i < m.length; i++) {
    const c = m[i]!;
    if (/[A-Za-z]/.test(c) && m[i + 1] === ":" && /[\\/]/.test(m[i + 2] ?? "")) return true;
    if (c === "/" || c === "\\") {
      const prev = m[i - 1]!;
      if (!NAME_CHAR.test(prev) && prev !== "/" && prev !== "\\") return true;
      // A home root after a segment that is empty ("//Users/...") or holds a space or other non-name character ("then x/Users/...").
      if (c === "/" && HOME_AT.test(m.slice(i))) {
        const seg = m.slice(0, i).split(/[\\/]/).pop()!;
        if (seg === "" || [...seg].some((ch) => !NAME_CHAR.test(ch))) return true;
      }
    }
    if (c === "~" && !NAME_CHAR.test(m[i - 1] ?? " ") && TILDE.test(m.slice(i))) return true;
  }
  return false;
}

/** A ".." segment anywhere in a scrub match: such a match is never split into an inside head and plain words. */
const HAS_DOTDOT = /(^|[\\/\s])\.\.(?=$|[\\/\s.,;:)!?])/;
/**
 * The path a scrub match holds before a sentence boundary at `i`, or null. A boundary is a whitespace character at `i` right after a run
 * of sentence punctuation (". , ; : ) ! ?"); the path is what comes before that run and must end at a segment end (a name character,
 * not a separator or a space). "Work Private/x.pdf" has no boundary after "Work"; "proj-run. Create t09/x.txt" has one.
 */
/**
 * Where a spaced scrub match may be split at `i` into a path and plain words: the boundary stem (see `boundaryStem`), or, at any other
 * whitespace, the whole head as a strict stem. A strict stem is accepted only when it is strictly inside the folder: without a ".." segment
 * whatever continues it is still inside, whereas the folder itself can run on into a sibling's name ("Work Private").
 */
function splitStem(m: string, i: number): { stem: string; strict: boolean } | null {
  if (!/\s/.test(m[i] ?? "")) return null;
  const b = boundaryStem(m, i);
  if (b !== null) return { stem: b, strict: false };
  const head = m.slice(0, i);
  return head === "" || /[\s\\/]$/.test(head) ? null : { stem: head, strict: true };
}
function boundaryStem(m: string, i: number): string | null {
  if (!/\s/.test(m[i] ?? "")) return null;
  const head = m.slice(0, i);
  const punct = /[.,;:)!?]+$/.exec(head)?.[0];
  if (punct === undefined) return null;
  const stem = head.slice(0, head.length - punct.length);
  return stem === "" || /[\s\\/]$/.test(stem) ? null : stem;
}

const WAKE_SUMMARY_MAX = 300;
const clampText = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1) + "…" : t);

const KNOWN_ROOTS = new RegExp(`^/(?:${ROOT_NAMES})\\b`);

/** Files whose renderer is available on this machine (PDF): the view reads their text, so a note makes no reading claim. */
const rendererReads = (file: string): boolean => registeredExtensions().includes(path.extname(file).toLowerCase());

/**
 * A line shaped like a raised error, the form runtimes share when they print one: an error or exception type name (optionally
 * namespace-qualified, optionally with a bracketed code) then a colon and the message: "Error: ...", "ValueError: ...",
 * "java.lang.IllegalStateException: ...", "TypeError [ERR_X]: ...". A short lead-in of plain words (at most 60 characters) may come first ("Caused by: ",
 * "Unhandled exception. ", "Uncaught "). A quoted source line ("throw new Error('...')", "raise ValueError(...)") or a trace frame naming a
 * file never has the shape.
 */
const RAISED_ERROR_LINE = /^(?:[A-Za-z][\w .:]{0,60}\s)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?: \S/;

export function buildTimeline(input: TimelineInput): Timeline {
  const expired = input.valuesExpiredAt !== null;
  const taskHost = input.host ?? null;
  // After the 30-day expiry the ops hold no arguments (the words are gone with the values); read none, whatever is left.
  const ops = expired ? [] : input.ops;
  const R = buildRuns(ops, input.fileStates);
  const folder = input.folder === null ? null : pathKit().trimEnd(input.folder);
  const missing: string[] = [];
  let redactions = 0;
  let outsideNamed = 0;

  // ---- paths: inside the folder they are relative to it; anywhere else they are never shown ----
  // Normalised first, so a "../" segment can't make an outside path read as inside.
  const kit = pathKit();
  const norm = (p: string): string => kit.canon(p);
  const inside = (p: string): boolean => folder !== null && kit.inside(folder, p);
  // A connector's URI subject (its row has the `connector` column set) is shown by the one display function; any other path, a URI-pathed one included, is a path.
  const connectorSubjects = new Set(R.states.filter((s) => isUriSubject(s.file_path) && s.connector != null).map((s) => s.file_path));
  for (const s of R.states) if (s.connector == null) connectorSubjects.delete(s.file_path);
  const rel = (p: string): string => (connectorSubjects.has(p) ? subjectDisplay(p).text : (folder === null ? null : kit.rel(folder, p)) ?? baseName(p));
  // An outside path shows only its file name; one with a space in it can't be told from the words around it, so it is cut whole.
  const cut = (p: string): string => (/\s/.test(p) ? OUTSIDE : baseName(p.replace(/[\\/]+$/, "")) || OUTSIDE);
  // What the scrub reads of the filesystem (see the definition above the path shapes): directory listings, cached for this render.
  const look = input.look ?? realLook;
  const listed = new Map<string, readonly string[] | "missing" | null>();
  const dirOf = (c: string): string => {
    const d = kit.dirName(c);
    return d === "" ? "/" : /^[A-Za-z]:$/.test(d) ? d + "/" : d;
  };
  const list = (dir: string): readonly string[] | "missing" | null => {
    const k = kit.key(dir);
    if (!listed.has(k)) {
      let got: readonly string[] | "missing" | null;
      try {
        got = look.list(dir);
      } catch {
        got = null;
      }
      listed.set(k, got);
    }
    return listed.get(k)!;
  };
  /** Whether an absolute path names an entry on disk; null when its directory can't be read (or the path is not absolute). */
  const onDisk = (p: string): boolean | null => {
    if (!kit.isAbs(p)) return null;
    const c = kit.canon(kit.trimEnd(p));
    const names = list(dirOf(c));
    if (names === null) return null;
    const name = nameKey(kit.baseName(c));
    return names !== "missing" && names.some((e) => nameKey(e) === name);
  };
  /**
   * How far the text after `head` carries on the name of an entry beside it ("Smith" then ", Jane/will.pdf" with "Smith, Jane" there): the
   * length of the longest such continuation, 0 for none, null when that directory can't be read. With `mustExist`, a missing directory
   * also answers null.
   */
  const sibling = (head: string, after: string, mustExist = false): number | null => {
    const c = kit.canon(head);
    const names = list(dirOf(c));
    if (names === null || (names === "missing" && mustExist)) return null;
    if (names === "missing") return 0;
    const last = nameKey(kit.baseName(c));
    const a = nameKey(after);
    let best = 0;
    for (const e of names) {
      const n = nameKey(e);
      if (n.length > last.length && n.startsWith(last) && a.startsWith(n.slice(last.length))) best = Math.max(best, n.length - last.length);
    }
    return best;
  };
  /**
   * An outside match `p` at `off` about to be cut: when the text after it carries on an entry beside it ("<folder>, Jane notes" with
   * "Smith, Jane notes" there), that entry is the path, so the cut runs over its name and the rest of that word; when the directory
   * can't be read the match is cut whole. Null when neither applies.
   */
  const cutOver = (p: string, off: number, all: string): Scanned | null => {
    if (!kit.isAbs(p)) return null;
    const cont = sibling(p, all.slice(off + p.length));
    if (cont === 0) return null;
    if (cont === null) return OUTSIDE;
    const word = /^\S*/.exec(all.slice(off + p.length + cont))![0].replace(CLOSE_TAIL, "");
    return { text: OUTSIDE, used: p.length + cont + word.length };
  };
  /** Whether a match starts with the folder (then a separator, punctuation, whitespace or its end): read like a known root's, rule 2a/b. */
  const folderLed = (m: string): boolean => {
    if (folder === null) return false;
    const f = kit.canon(folder).toLowerCase();
    return m.toLowerCase().startsWith(f) && /^(?:$|[\s/\\.,;:)!?])/.test(m.slice(f.length));
  };
  const scrubPlain = (text: string): { text: string; redacted: boolean } => {
    let redacted = false;
    let out = text.replace(SCHEME_URL, () => {
      redacted = true;
      return "[outside link]";
    });
    // A web URL's scheme and host are never a path, and neither is a remote host's own path ("https://github.com/Users/foo/bar"). A local
    // path inside it is: a parameter value or fragment starting at a path, on any host, or the path right after a host that may be this
    // machine (rule 0). Those are left in the text for the passes below; everything before them is set aside and put back at the end.
    const urls: { text: string; slash: boolean }[] = [];
    if (!/[\uE000\uE001]/.test(out)) {
      out = out.replace(WEB_URL, (u) => {
        const [, lead, auth, rest] = /^([a-z]+:\/\/)([^/?#]*)(.*)$/is.exec(u)!;
        const host = auth!.replace(/^[^@]*@/, "").replace(/:\d*$/, "");
        let k = rest!.length;
        let slash = false;
        if (localHost(host) && LOCAL_URL_PATH.test(rest!)) {
          k = 0;
          slash = true;
        } else {
          const q = URL_PARAM_PATH.exec(rest!);
          if (q !== null) k = q.index + q[0].length;
        }
        return `\uE000${urls.push({ text: lead! + auth! + rest!.slice(0, k), slash }) - 1}\uE001` + rest!.slice(k);
      });
    }
    // A home variable is the account's home; the passes below then read the path like any other.
    out = out.replace(ENV_HOME, () => {
      const h = kit.trimEnd(look.home());
      return kit.isAbs(h) ? h : OUTSIDE;
    });
    const str = (s: Scanned): string => (typeof s === "string" ? s : s.text);
    // A match is relabelled only when it holds exactly one root start and is wholly inside the folder; anything else is cut whole.
    const winOf = (m: string, off: number, all: string): Scanned => {
      // A "//" right after a path-like word ("Work//sub/a.txt", "~bob//x") is a doubled separator, not a UNC start; the posix pass reads it.
      if (m.startsWith("//") && /(?:[\\/]\S*|(?<!\S)~[\w.-]*)$/.test(all.slice(0, off))) return m;
      const tail = WIN_TAIL.exec(m)![0];
      const one = m.slice(0, m.length - tail.length);
      const wstart = one.startsWith("\\\\") || one.startsWith("//") ? 2 : 3;
      if (!hasLaterRoot(one, wstart) && inside(one)) return rel(one) + tail;
      // As for posix: an inside head splits off at any whitespace, the folder itself only at a sentence boundary and when no sibling
      // carries the following words. A rest with a root the rescan would not see (after a name character) is never split off.
      if (/\s/.test(one) && !HAS_DOTDOT.test(one)) {
        for (let i = one.length - 1; i > wstart; i--) {
          const at = splitStem(one, i);
          if (at === null) continue;
          const { stem, strict } = at;
          const head = one.slice(0, i);
          const rest = one.slice(i);
          if (/[\w/\\][A-Za-z]:[\\/]/.test(rest) || /[\w/]\\\\/.test(rest)) continue;
          if (hasLaterRoot(stem, wstart)) continue;
          const isFolder = folder !== null && kit.same(folder, stem);
          if (isFolder ? strict : !inside(stem)) continue;
          if (isFolder && sibling(stem, all.slice(off + stem.length)) !== 0) continue;
          return (isFolder ? baseName(folder!) : rel(stem)) + head.slice(stem.length) + scan(rest, WIN_PATH, winOf) + tail;
        }
      }
      redacted = true;
      const over = folder !== null && kit.same(folder, one) ? cutOver(one, off, all) : null;
      return over === null || typeof over === "string" ? OUTSIDE + tail : over;
    };
    out = scan(out, WIN_PATH, winOf);
    // A space inside a path is read only for a path that starts at a known root or the home folder; elsewhere ("/2 and/or 3/4")
    // the match is split at its first space when the filesystem allows (definition, rule 3), and the rest of the text is scanned again.
    const posix = (m: string, off: number, all: string): Scanned => {
      const glued = off > 0 && /[\w./~]/.test(all[off - 1]!);
      // A home root glued to the word before it is a path only when that home is on disk (rule 4); otherwise the words stay as written
      // ("pages/home/components/Hero.tsx") and the text is read again past the root name, so a later glued root is still found.
      if (glued && HOME_AT.test(m)) {
        const [, root, name] = /^\/([^/]+)\/([^/]+)\//.exec(m)!;
        if (onDisk(`/${root}/${name}`) === false) return { text: m.slice(0, root!.length + 1), used: root!.length + 1 };
      }
      const tilde = TILDE.exec(m)?.[0].length;
      if (/\s/.test(m) && !(tilde !== undefined || KNOWN_ROOTS.test(m) || folderLed(m))) {
        const head = m.split(/\s/)[0]!;
        const whole = m.replace(CLOSE_TAIL, "");
        const headPath = head.replace(CLOSE_TAIL, "");
        // Only a one-name head ("/2") may split, and only "/" is read for it; a deeper head is cut whole unread.
        if (/^\/[^/]+$/.test(headPath) && sibling(headPath, all.slice(off + headPath.length), true) === 0) {
          return str(posix(head, off, all)) + scan(m.slice(head.length), POSIX_PATH, posix);
        }
        redacted = true;
        return OUTSIDE + m.slice(whole.length);
      }
      const path = m.replace(CLOSE_TAIL, "");
      const tail = m.slice(path.length);
      const segs = path.split("/").filter(Boolean);
      // A lone root name ("/usr", "/tmp") names no one's file.
      if (segs.length < 2) return m;
      const start = tilde ?? 1;
      if (!hasLaterRoot(path, start) && inside(path)) return rel(path) + tail;
      // A spaced match that is not wholly inside may be an inside path followed by plain words ("<folder>. Create x/y.txt"); rule 3 picks
      // the head. A match with a ".." segment anywhere is never split (the rest could climb back out), nor is a rest holding a root the
      // rescan would not see, nor a match that names an entry on disk.
      if (/\s/.test(path) && !HAS_DOTDOT.test(path)) {
        for (let i = path.length - 1; i > start; i--) {
          const at = splitStem(path, i);
          if (at === null) continue;
          const { stem, strict } = at;
          const head = path.slice(0, i);
          const rest = path.slice(i);
          if (/[:~)\\]\//.test(rest) || /\\/.test(rest)) continue;
          if (stem.split("/").filter(Boolean).length < 2 || hasLaterRoot(stem, start)) continue;
          // The folder itself shows by its own name (it is not "inside" itself).
          const isFolder = folder !== null && kit.same(folder, stem);
          if (isFolder ? strict : !inside(stem)) continue;
          if (isFolder && sibling(stem, all.slice(off + stem.length)) !== 0) continue;
          return (isFolder ? baseName(folder!) : rel(stem)) + head.slice(stem.length) + scan(rest, POSIX_PATH, posix) + tail;
        }
      }
      redacted = true;
      const over = folder !== null && kit.same(folder, path) ? cutOver(path, off, all) : null;
      if (over !== null) return typeof over === "string" ? OUTSIDE + tail : over;
      return (glued ? OUTSIDE : cut(path)) + tail;
    };
    out = scan(out, POSIX_PATH, posix);
    // A local path cut to its file name keeps the "/" after the host ("http://localhost:8000/x.pdf").
    if (urls.length > 0) out = out.replace(/\uE000(\d+)\uE001(?=(.?))/gs, (t, i: string, next: string) => {
      const u = urls[Number(i)];
      return u === undefined ? t : u.text + (u.slash && !/^[/?#\s]?$/.test(next) ? "/" : "");
    });
    if (redacted) redactions++;
    return { text: out, redacted };
  };
  /** Every URI subject the task changed reaches the body through here: a connector row's by `subjectDisplay` (a clean display form is left whole, the rest is read by the path scrub), any other URI-pathed row's as the file name. The text around it is scrubbed as usual. */
  const subjects = [...new Set(R.states.filter((s) => isUriSubject(s.file_path)).map((s) => s.file_path))].sort((a, b) => b.length - a.length);
  const scrub = (text: string): { text: string; redacted: boolean } => {
    const at = subjects.map((u) => ({ u, k: text.indexOf(u) })).filter((m) => m.k >= 0).sort((a, b) => a.k - b.k || b.u.length - a.u.length)[0];
    if (at === undefined) return scrubPlain(text);
    const shown = connectorSubjects.has(at.u) ? subjectDisplay(at.u) : { text: baseName(at.u) || OUTSIDE, whole: false };
    const head = scrubPlain(text.slice(0, at.k)), mid = shown.whole ? { text: shown.text, redacted: false } : scrubPlain(shown.text), tail = scrub(text.slice(at.k + at.u.length));
    return { text: head.text + mid.text + tail.text, redacted: head.redacted || mid.redacted || tail.redacted };
  };
  // The host's error text on the rail is its first error line, outside paths masked. The rest of a stack trace stays in the host.
  // A line shaped like a raised error comes first (see RAISED_ERROR_LINE); else the first line with an error word; else the first line.
  const hostErrorLine = (raw: string | null): string | null => {
    const lines = (raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const one = lines.find((l) => RAISED_ERROR_LINE.test(l)) ?? lines.find((l) => /error|exception|\bfailed\b|cannot|no such|not found|denied|invalid/i.test(l)) ?? lines[0];
    return one === undefined ? null : clampText(scrub(one).text, 240);
  };
  /** The whole error text with outside paths masked, for "Show output". */
  const hostErrorFull = (raw: string | null): string | null => {
    const t = (raw ?? "").trim();
    return t === "" ? null : clampText(scrub(t).text, 4000);
  };
  // A host's own markup in its reply text (Codex file citations) becomes plain words here; the stored text is untouched.
  // By the host of the op that carries the text; the task host only when that op names none.
  const hostShown = (text: string, opHost: string | null): string => {
    try {
      const h = opHost ?? taskHost;
      return (h === null ? undefined : profileOf(h).displayText?.(text)) ?? text;
    } catch {
      return text;
    }
  };
  const lineFrom = (text: string, base: Omit<Line, "text" | "redacted">): Line => {
    const s = scrub(text);
    return { text: s.text, ...base, ...(s.redacted ? { redacted: true } : {}) };
  };

  /** A launch's purpose: the tool label's description, else the call's description; nothing for another tool or a launch without one. */
  const mcpOf = (c: { tool: string | null; toolLabel: { inputFields?: string[] } | null }): { mcp?: NonNullable<TimelineCall["mcp"]> } => {
    if (c.tool === null || !isMcpTool(c.tool)) return {};
    const rest = c.tool.slice("mcp__".length), cut = rest.lastIndexOf("__");
    return { mcp: { server: cut > 0 ? rest.slice(0, cut) : "", tool: cut > 0 ? rest.slice(cut + 2) : rest, inputFields: [...(c.toolLabel?.inputFields ?? [])] } };
  };
  const purposeOf = (c: { tool: string | null; description?: string | null; toolLabel: { fields: Record<string, string | string[]> } | null }): { purpose?: string } => {
    if (!isLauncherTool(c.tool)) return {};
    const label = c.toolLabel?.fields.description ?? c.toolLabel?.fields.task_name;
    const raw = typeof label === "string" && label.trim() !== "" ? label : (c.description ?? "");
    const text = raw.trim() === "" ? "" : scrub(raw.trim()).text.trim();
    return text === "" ? {} : { purpose: text };
  };

  /** A launch's brief from the call's label (the hook scrubbed and cut it); nothing for another tool or a label without one. */
  const briefOf = (c: { tool: string | null; toolLabel: { fields: Record<string, string | string[]>; dropped?: Record<string, string> } | null }): { brief?: string; briefWithheld?: true; briefEncrypted?: true } => {
    if (!isLauncherTool(c.tool) || c.toolLabel === null) return {};
    const raw = c.toolLabel.fields.prompt ?? c.toolLabel.fields.message;
    // Encrypted by the host: said so, never shown (records written before the hook dropped it still hold the token in `fields`).
    if (isEncryptedToken(raw) || c.toolLabel.dropped?.message === ENCRYPTED_BRIEF_NOTE || c.toolLabel.dropped?.prompt === ENCRYPTED_BRIEF_NOTE) return { briefEncrypted: true };
    if (typeof raw === "string" && raw.trim() !== "") return { brief: lineFrom(raw, { source: "agent-claim", label: BRIEF_NOTE }).text };
    // A brief the hook withheld as secret-looking is said so, never shown as "no brief".
    return c.toolLabel.dropped?.prompt ? { briefWithheld: true } : {};
  };

  /** The call's withheld free-text fields that have a transcript locator (the field names only). */
  const revealOf = (c: { toolLabel: { withheld?: Record<string, { locator?: unknown }> } | null }): { revealable?: string[] } => {
    const names = Object.entries(c.toolLabel?.withheld ?? {}).filter(([, w]) => w.locator !== undefined).map(([k]) => k);
    return names.length === 0 ? {} : { revealable: names };
  };

  /** A SendMessage's recipient, summary and text from the call's label (the hook scrubbed and cut them); nothing for another tool or a label without them. */
  const sendOf = (c: { tool: string | null; toolLabel: { fields: Record<string, string | string[]>; dropped?: Record<string, string> } | null }): { send?: NonNullable<TimelineCall["send"]> } => {
    if (c.tool !== "SendMessage" || c.toolLabel === null) return {};
    const f = c.toolLabel.fields;
    const one = (k: string): string | null => (typeof f[k] === "string" && (f[k] as string).trim() !== "" ? lineFrom(f[k] as string, { source: "agent-claim", label: SEND_NOTE }).text : null);
    const d = c.toolLabel.dropped ?? {};
    // When the message was withheld, the short `content` field is never shown in its place.
    const text = d.message !== undefined ? null : (one("message") ?? one("content"));
    const to = one("to");
    const summary = one("summary");
    const withheld = d.message !== undefined || d.content !== undefined || d.summary !== undefined;
    return to === null && summary === null && text === null && !withheld ? {} : { send: { to, summary, text, ...(withheld ? { withheld: true as const } : {}) } };
  };

  // ---- states ----
  const removalReason = new Map(input.removals.map((r) => [r.sha256, r.reason]));
  const known = new Map<string, { size: number | null; kept: StateRef["kept"] }>();
  for (const s of R.states) {
    if (!known.has(s.sha256)) known.set(s.sha256, { size: typeof s.size === "number" ? s.size : null, kept: asKept(s.kept) });
  }
  const secretShas = secretShasOf(input.fileStates.map((r) => ({ path: r.file_path, sha: r.sha256, prev: r.prev_sha256, note: r.note })));
  const refOf = (sha: string, secret = false, file = ""): StateRef => {
    const k = known.get(sha);
    const stored = input.stored.has(sha);
    const why = stored ? null : (removalReason.get(sha) ?? (k?.kept === "hash" ? "the file was too large to keep this version, so only its hash is kept" : k?.kept === "gone" ? "the file was deleted" : "its bytes are not in the store"));
    const preview = secret
      ? { label: IMAGE_LABEL, ref: null, missing: "No preview: this is a secret file." }
      : stored && imageTypeOf(file) !== null
      ? { label: IMAGE_LABEL, ref: `/timeline/${input.taskId}/preview/${sha}`, missing: null }
      : { label: IMAGE_LABEL, ref: null, missing: stored ? "No preview: only png, jpg, gif, webp and svg images are shown as pictures." : `No preview: ${why}.` };
    return { sha256: sha, size: stored ? (input.stored.get(sha) ?? k?.size ?? null) : (k?.size ?? null), kept: k?.kept ?? null, stored, why, preview };
  };

  // ---- the order calls came in, per session, for "named earlier" ----
  const position = new Map<string, number>();
  const sessionCalls = new Map<string | null, Call[]>();
  for (const r of R.requests) {
    for (const c of r.calls) {
      const list = sessionCalls.get(c.session) ?? [];
      position.set(c.id, list.length);
      list.push(c);
      sessionCalls.set(c.session, list);
    }
  }
  const requestOfCall = new Map<string, string>();
  for (const r of R.requests) for (const c of r.calls) requestOfCall.set(c.id, r.id);

  const { changeStates, scriptsOf } = creditStates(input, R, folder);
  // The script text a call may run, for what it read: the text an earlier call of the agent wrote, and the stored version of a script file an earlier call changed.
  const readScriptsOf = (id: string): ScriptLookup => {
    const written = scriptsOf(id);
    const me = R.calls.get(id);
    return (name) => {
      const texts = [...(written?.(name) ?? [])];
      if (me?.openedAt == null || !input.scriptTexts) return texts;
      let stored: string | undefined;
      for (const s of changeStates) {
        if (s.file_path.slice(s.file_path.lastIndexOf("/") + 1) !== name) continue;
        const t = input.scriptTexts.get(s.sha256);
        if (t !== undefined && s.credited.some((cid) => { const c = R.calls.get(cid); return c?.openedAt != null && c.openedAt < me.openedAt!; })) stored = t;
      }
      if (stored !== undefined) texts.push(stored);
      return texts;
    };
  };
  const readsOf = (c: Call): { reads?: ReadRef[]; readsUnknown?: true } => {
    const file = c.toolLabel?.fields.file_path;
    const readCall = { tool: c.tool, command: c.command, input: c.input, readPath: typeof file === "string" ? file : null, named: [...c.named] };
    const reads = callReads(readCall, readScriptsOf(c.id));
    const unknown = callReadsUnknown(readCall, readScriptsOf(c.id)) ? { readsUnknown: true as const } : {};
    // a path inside the watched folder is given relative to it; one outside is never shown (the rule for every path in the body)
    // A script's string literals are mostly not paths: only one that names (or ends the path of) a file the task changed is kept.
    const changed = changeStates.map((s) => (inside(s.file_path) ? rel(s.file_path) : ""));
    const names = (p: string): boolean => { const q = p.replace(/^(\.\/)+/, ""); return changed.some((f) => f !== "" && (f === q || f.endsWith("/" + q))); };
    // A read that names no changed file but resolves to a file the task found and never changed is a source (`unchanged`). A relative path is tried from the folder, from the folders of the
    // files the call named, and from the folder of a changed file whose name the command holds (the script it ran).
    const dirs = [folder ?? "", ...[...c.named].filter(inside).map((n) => path.posix.dirname(norm(n))), ...changeStates.filter((s) => inside(s.file_path) && (c.command ?? "").includes(baseName(s.file_path))).map((s) => path.posix.dirname(norm(s.file_path)))];
    const found = (p: string): string | null => {
      // A connector's URI subject is not a relative path: it is never tried from a folder, and no filesystem check names it.
      if (!input.existsAtStart || folder === null || isUriSubject(p)) return null;
      const hits = new Set((kit.isAbs(p) ? [norm(p)] : dirs.map((d) => path.posix.normalize(d + "/" + p))).filter((a) => inside(a) && input.existsAtStart!(a)));
      return hits.size === 1 ? [...hits][0]! : null;
    };
    // A bare name read next to a folder the call also names ("output/deck/" and "x.png") stands for that folder's changed file when exactly one is; a same-named file elsewhere is not it
    const dirsRead = reads.filter((r) => r.path.endsWith("/")).map((r) => (kit.isAbs(r.path) ? rel(r.path) : r.path.replace(/^(\.\/)+/, "")));
    const inDir = (r: ReadRef): ReadRef => {
      if (r.path.includes("/") || dirsRead.length === 0) return r;
      const hit = dirsRead.map((d) => d + r.path).filter((x) => changed.some((f) => f !== "" && (f === x || f.endsWith("/" + x))));
      return new Set(hit).size === 1 ? { ...r, path: hit[0]! } : r;
    };
    const shown = reads.map(inDir).flatMap((r): ReadRef[] => {
      const abs = kit.isAbs(r.path);
      if (abs && !inside(r.path)) return [];
      if (abs ? changed.includes(rel(r.path)) : names(r.path)) return [abs ? { ...r, path: rel(r.path) } : r];
      const at = found(r.path);
      return at !== null ? [{ ...r, path: rel(at), unchanged: true }] : abs ? [{ ...r, path: rel(r.path) }] : [];
    });
    return shown.length > 0 ? { reads: shown, ...unknown } : unknown;
  };
  const creditedTo = new Map<string, State[]>();
  for (const s of changeStates) for (const id of s.credited) creditedTo.set(id, [...(creditedTo.get(id) ?? []), s]);

  // Equal bytes prove identical content, never where it came from (a delete beside a copy reads the same), so no change is called a move or a
  // rename. The literal fact is stated only under strict evidence: ONE call is the sole credit of both records, and among every record any credit
  // ties to that call exactly one file went gone and exactly one appeared with the same non-empty bytes. Each side then names the other path.
  // Anything else (joint credit, calls apart, several same-bytes files, an empty file, a secret or an outside path) states nothing.
  const twinPool = (id: string): State[] => changeStates.filter((x) => x.credited.includes(id));
  const goneBytes = (x: State): string | null => (x.prev_sha256 !== null && x.kept === "gone" && x.prev_sha256 !== EMPTY_SHA ? x.prev_sha256 : null);
  const newBytes = (x: State): string | null => (x.prev_sha256 === null && x.kept !== "gone" && x.sha256 !== EMPTY_SHA ? x.sha256 : null);
  const plainState = (x: State): boolean => inside(x.file_path) && !isSecretPath(x.file_path) && !secretShas.has(x.sha256) && (x.prev_sha256 === null || !secretShas.has(x.prev_sha256));
  const twinOf = (s: State): { path: string } | null => {
    if (s.credited.length !== 1 || !plainState(s)) return null;
    const bytes = goneBytes(s) ?? newBytes(s);
    if (bytes === null) return null;
    const pool = twinPool(s.credited[0]!);
    const gone = pool.filter((x) => goneBytes(x) === bytes), made = pool.filter((x) => newBytes(x) === bytes);
    if (gone.length !== 1 || made.length !== 1) return null;
    const other = goneBytes(s) !== null ? made[0]! : gone[0]!;
    if (other === s || other.file_path === s.file_path || other.credited.length !== 1 || other.credited[0] !== s.credited[0] || !plainState(other)) return null;
    return { path: rel(other.file_path) };
  };

  const changeOf = (s: State): Change => {
    const resolvable = s.credited.filter((id) => R.calls.has(id));
    const secretFile = isSecretPath(s.file_path) || secretShas.has(s.sha256) || (s.prev_sha256 !== null && secretShas.has(s.prev_sha256));
    const before = s.prev_sha256 ? refOf(s.prev_sha256, secretFile, s.file_path) : null;
    const after = refOf(s.sha256, secretFile, s.file_path);
    const kind: Change["kind"] = !s.prev_sha256 ? "created" : s.kept === "gone" ? "deleted" : "modified";
    const sentences: string[] = [];
    if (before && !before.stored) sentences.push(`The state before this change is not in the store: ${before.why}.`);
    if (!after.stored) sentences.push(`The state after this change is not in the store: ${after.why}.`);
    // A built-in row's format findings come back out of its DiffObject (the shim is lossless); a connector row has no FormatChanges at all.
    const d = input.diffs?.get(s.id);
    const viaConnector = d !== undefined && d.producer === "connector";
    const f = d !== undefined && !viaConnector ? fromDiffObject(d).changes : viaConnector ? undefined : input.formats.get(s.id);
    let format: Change["format"] = null;
    const generic = input.generics?.get(s.id) ?? fingerprintTier(
      {
        file: s.file_path,
        kind,
        before: before ? { sha: before.sha256, size: secretFile ? null : before.size, bytes: null, why: null } : null,
        after: kind === "deleted" ? null : { sha: after.sha256, size: secretFile ? null : after.size, bytes: null, why: null },
        secret: secretFile,
        ...(secretFile ? { secretLabel: secretLine(rel(s.file_path)) } : {}),
      },
      "The loader did not read this change, so only its fingerprint is shown.",
    );
    // A secret file's contents never reach the body, whatever a format layer read from them.
    if (generic.secret) sentences.push("This is a secret file: nothing inside it is listed.");
    else if (viaConnector) {
      if (d.unavailable !== undefined) sentences.push(`No changes inside this item are listed: ${d.unavailable}.`);
    } else if (f === undefined) sentences.push("The format layer did not read this change.");
    else if ("unavailable" in f) sentences.push(`No changes inside the file are listed: ${f.unavailable}.`);
    else {
      format = { module: f.module, rows: f.rows.map((row) => ({ ...row, text: scrub(row.text).text })), more: f.more, ...(f.moreIn ? { moreIn: f.moreIn } : {}), ...(f.identicalParts ? { identicalParts: true as const } : {}) };
      if (f.more > 0) sentences.push(f.moreIn && f.moreIn.length > 0 ? moreText(f.more, f.moreIn) : `${f.more} more changes inside the file are not listed.`);
    }
    // Calls that named the file before this change and were not credited with a change to it, since the file's previous change.
    const alsoNamedBy: Change["alsoNamedBy"] = [];
    const first = resolvable.map((id) => position.get(id)).filter((p): p is number => p !== undefined).sort((a, b) => a - b)[0];
    if (first !== undefined) {
      const session = R.calls.get(resolvable[0]!)!.session;
      const list = sessionCalls.get(session) ?? [];
      let from = 0;
      for (const prev of changeStates) {
        if (prev.id >= s.id || prev.file_path !== s.file_path) continue;
        for (const id of prev.credited) if (R.calls.get(id)?.session === session) from = Math.max(from, (position.get(id) ?? -1) + 1);
      }
      for (let p = from; p < first; p++) {
        const c = list[p]!;
        if (!c.named.has(s.file_path)) continue;
        if ((creditedTo.get(c.id) ?? []).some((x) => x.file_path === s.file_path)) continue;
        alsoNamedBy.push({ call: c.id, request: requestOfCall.get(c.id)! });
      }
    }
    const hostProfile = findProfile(taskHost);
    const probably = s.credited.length === 0 && hostProfile?.hostOwnedWhat !== undefined && (hostProfile.hostOwnedFiles ?? []).includes(rel(s.file_path)) ? hostProfile.hostOwnedWhat : undefined;
    const by = attributionOf(s, R.calls, taskHost, expired, probably);
    const facts = {
      actor: by.actor,
      file: rel(s.file_path),
      secret: generic.secret === true,
      expired,
    };
    // A value in a note is cut like any other text in the body: an outside path in a cell shows as its file name.
    const clean = (v: string | null | undefined): string | null => (v == null ? null : scrub(v).text);
    const rowFacts = (format?.rows ?? []).map((r) => ({ location: r.location, kind: r.kind, before: clean(r.before), after: clean(r.after), text: r.text }));
    // a connector's step is worded from its own document (label, words, plain sentence), the same text the page draws.
    const words = (v: unknown): string | null => (typeof v === "object" && v !== null && (v as { type?: unknown }).type === "text" && typeof (v as { value?: unknown }).value === "string" ? clean((v as { value: string }).value) : null);
    const connectorFacts = viaConnector && !generic.secret ? {
      changes: d.changes.map((c): ConnectorChangeFacts => ({ label: clean(c.anchors[0]?.label ?? "") ?? "", mark: c.kind, before: words(c.before), after: words(c.after), text: clean(typeof c.note === "string" ? c.note : c.note?.text ?? null) })),
      ...(d.nothing !== undefined ? { nothing: d.nothing } : {}),
    } : null;
    const ruled = changeNote({
      ...facts,
      change: kind,
      twin: twinOf(s),
      tier: generic.tier,
      unopened: generic.unopened ?? [],
      rendererReads: rendererReads(rel(s.file_path)),
      bothPictures: !!generic.picture && generic.picture.before !== null && generic.picture.after !== null,
      hunkOps: generic.text?.hunks.flatMap((h) => h.lines.map((l) => l.op)),
      rows: rowFacts,
      connector: connectorFacts,
    });
    // for any file type, a change whose before-side has no bytes reads the one wording, whatever its ending: CoCheck cannot
    // tell a re-save from an edit without that side. A connector's own subject (a URI) keeps its own sentence.
    // Only a change nothing was read of (no format row, no connector change, no text hunks): a reading says what changed, whatever the bytes.
    const unread = (format?.rows.length ?? 0) === 0 && !(viaConnector && d.changes.length > 0) && generic.tier !== "text";
    // The before-side was only ever a hash (past the caps, or a copy that failed): an evicted or expired copy keeps its own words.
    const noBefore = kind === "modified" && before !== null && before.kept === "hash" && !before.stored && unread && !generic.secret && !connectorSubjects.has(s.file_path);
    const [doneWhat, keptWhat] = NO_BEFORE_WORDING.split("; ");
    const note = noBefore ? { ...ruled, text: `${facts.actor} ${doneWhat} ${facts.file}; ${keptWhat}.` } : ruled;
    const notedFormat = format ? { ...format, rows: format.rows.map((r, k) => ({ ...r, note: rowNote(facts, rowFacts[k]!) })) } : null;
    return {
      id: `c${s.id}`,
      file: rel(s.file_path),
      outside: !connectorSubjects.has(s.file_path) && !inside(s.file_path),
      at: s.ts ? (Number.isFinite(Date.parse(s.ts)) ? Date.parse(s.ts) : null) : null,
      kind,
      step: typeof s.step_id === "number" ? s.step_id : null,
      ...(typeof s.mtime_ns === "string" && /^\d+$/.test(s.mtime_ns) ? { mtimeNs: s.mtime_ns } : {}),
      before,
      after,
      credit: { calls: resolvable, joint: resolvable.length > 1, text: creditText(by) },
      by,
      ...(resolvable.length > 0 && isInferredBasis(s.credit_basis) ? { inferred: true as const } : {}),
      ledgerNote: ledgerNoteOf(s.note ? scrub(s.note).text : null),
      note,
      format: notedFormat,
      ...(viaConnector && !generic.secret ? { diff: { ...d, subject: rel(s.file_path) } } : {}),
      ...(viaConnector && d.nothing === "changed" && kind === "modified" && !generic.secret ? { resave: true as const } : {}),
      generic,
      alsoNamedBy,
      missing: sentences,
    };
  };
  const changeById = new Map<number, Change>();
  const changeFor = (s: State): Change => {
    let c = changeById.get(s.id);
    if (!c) changeById.set(s.id, (c = changeOf(s)));
    return c;
  };

  // ---- requests, runs, calls ----
  const hosts = new Set<string>();
  const failuresReported = (run: Run): boolean => run.failuresReported;
  const requests: TimelineRequest[] = R.requests.map((r) => {
    const rMissing: string[] = [];
    const userLines: Line[] = r.texts.map((t) => lineFrom(t, { source: "user", label: isHostNotice(t) ? NOTICE_LABEL : "the user's request" }));
    if (!r.captured) rMissing.push("Request not captured.");
    if (r.placement === "inferred") rMissing.push("The record carries no submit order for this request, so it is placed before its first run (inferred).");
    if (r.texts.length > 1 && r.placement === "inferred") rMissing.push(r.reading.texts ?? "Several requests were sent in one turn and are shown together.");
    const closingText = r.closing?.source === "agent" ? words(r.closing.text) : "";
    if (!closingText) rMissing.push(r.closing ? "The closing message has no words recorded." : "No closing message recorded.");
    const closing = closingText ? lineFrom(hostShown(closingText, r.replies.at(-1)?.host ?? null), { source: "agent-claim", label: CLAIM_NOTE }) : null;
    const replies: TimelineReply[] = r.replies.flatMap((x) => {
      const t = x.closing.source === "agent" ? words(x.closing.text) : "";
      return t ? [{ at: x.at, line: lineFrom(hostShown(t, x.host), { source: "agent-claim" as const, label: CLAIM_NOTE }) }] : [];
    });
    const finishes: TimelineFinish[] = r.finishes.map((f) => ({
      agentId: f.agentId,
      agentType: f.agentType === null ? null : f.agentType.slice(0, 80),
      at: f.at,
      text: f.text === null ? null : lineFrom(hostShown(f.text, f.host), { source: "agent-claim", label: FINISH_NOTE }),
    }));

    const runs: TimelineRun[] = r.runs.map((run, runIndex) => {
      const reports = failuresReported(run);
      const runMissing: string[] = [];
      if (!reports) runMissing.push("This host does not report failed calls, so no failed count is given and no finished call is shown as succeeded.");
      const calls: TimelineCall[] = run.calls.map((c) => {
        if (c.host) hosts.add(c.host);
        const cMissing: string[] = [];
        const mine = (creditedTo.get(c.id) ?? []).map(changeFor);
        const named = [...c.named];
        const files = named.filter(inside).map(rel);
        const outside = named.length - named.filter(inside).length;
        outsideNamed += outside;
        if (outside > 0) cMissing.push(`${outside === 1 ? "A path" : `${outside} paths`} outside the watched folder ${outside === 1 ? "was" : "were"} named and ${outside === 1 ? "is" : "are"} not shown.`);
        const l = lineOf(c);
        const line = lineFrom(l.text, { ...SOURCE[l.source], label: SOURCE_NOTE[l.source], rule: LINE_RULE });
        let outcome: TimelineCall["outcome"] = "unknown";
        if (c.closedBy === "failure") {
          outcome = "failed";
          if (c.errorInferred) cMissing.push(INFERRED_FAILURE_NOTE);
        } else if (c.closedBy === "post" && reports) outcome = "succeeded";
        else if (c.closedBy === "post") cMissing.push("Outcome not reported: this host does not say whether a finished call succeeded.");
        else if (c.closedBy === "expiry" || (c.closedBy === "stop" && !c.background)) cMissing.push("No result was recorded for this call: the host sent no Post event for it.");
        else if (c.closedBy === "refused") cMissing.push("The host refused this call before running it: nothing ran.");
        else if (c.closedBy !== "post") cMissing.push("The host did not say how this call ended.");
        return {
          id: c.id,
          index: c.index!,
          of: r.calls.length,
          host: c.host,
          tool: c.tool,
          start: c.openedAt,
          end: c.closedAt,
          ...(c.rewrote === undefined ? {} : { rewrote: c.rewrote.filter((f) => !kit.isAbs(f) && !f.split("/").includes("..")) }),
          outcome,
          closedBy: c.closedBy,
          error: outcome === "failed" ? hostErrorLine(c.error) : null,
          ...(outcome === "failed" && (hostErrorFull(c.error) ?? "").includes("\n") ? { errorFull: hostErrorFull(c.error)! } : {}),
          ...(outcome === "failed" && isShell(c) && c.command ? (() => { const fp = failedPart(c.command, c.error); return fp ? { failedPart: fp } : {}; })() : {}),
          background: c.background,
          ...(c.command && c.command !== c.tool ? {} : { noCommand: true as const }),
          onTarget: c.target!.size > 0,
          agent: c.agentId === null ? null : { id: c.agentId, type: c.agentType === null ? null : c.agentType.slice(0, 80) },
          ...(c.launcherCall ? { launchedBy: c.launcherCall.id } : {}),
          ...(c.resumedBy ? { resumedBy: c.resumedBy.id } : {}),
          ...sendOf(c),
          ...mcpOf(c),
          ...(input.captureGaps?.has(c.id) ? { captureGap: { reason: input.captureGaps.get(c.id)! } } : {}),
          ...purposeOf(c),
          ...briefOf(c),
          ...revealOf(c),
          files,
          ...readsOf(c),
          line,
          changes: mine,
          missing: cMissing,
        };
      });
      const changedAt = calls.filter((c) => c.changes.length > 0).map((c) => c.index);
      const lastRun = runIndex === r.runs.length - 1;
      return {
        id: `run:${run.calls[0]!.id}`,
        rule: RUN_RULE,
        files: [...run.target].filter(inside).map(rel),
        callCount: calls.length,
        failedCount: reports ? calls.filter((c) => c.outcome === "failed").length : null,
        changedFiles: [...new Set(calls.flatMap((c) => c.changes.map((x) => x.file)))],
        changedAtCall: changedAt.length ? Math.min(...changedAt) : null,
        endedBy: run.endsInChange ? "change" : lastRun ? "end of request" : "other target",
        calls,
        missing: runMissing,
      };
    });
    return {
      id: r.anchorSeq != null ? `q${r.anchorSeq}` : r.id,
      index: r.index,
      session: r.session,
      texts: userLines,
      at: typeof r.anchor === "number" ? r.anchor : null,
      placement: {
        kind: r.placement,
        note: r.placement === "recorded" ? "placed by the submit order the record carries" : "placed before its first run (inferred: the record carries no submit order)",
      },
      closing,
      ...(replies.length > 0 ? { replies } : {}),
      ...(finishes.length > 0 ? { finishes } : {}),
      ...(r.trackingStops && r.trackingStops.length > 0 ? { trackingStops: r.trackingStops.map((t) => ({ at: t.at })) } : {}),
      runs,
      wakes: r.wakes.map((w) => ({ launch: w.toolUseId, agentId: w.agentId, at: w.at, status: w.status ?? "completed", summary: w.summary === null ? null : clampText(lineFrom(w.summary.slice(0, 2000), { source: "user", label: "the host's notice" }).text, WAKE_SUMMARY_MAX) })),
      missing: rMissing,
    };
  });

  // ---- changes shown under no call ----
  const unplaced: Change[] = changeStates.filter((s) => !s.credited.some((id) => R.calls.has(id))).map(changeFor);

  // ---- A step the very next step on the same file undid, and the file's net change across the task ----
  // A pair is only two neighbouring changes of one file where the second starts from the state the first ended in and ends in the state the first started from.
  // The same bytes reached from a different state is not a pair. A secret file is never described here.
  {
    const ordered = [...changeStates].sort((a, b) => a.id - b.id);
    const byFile = new Map<string, State[]>();
    for (const s of ordered) byFile.set(s.file_path, [...(byFile.get(s.file_path) ?? []), s]);
    const addSentence = (s: State, text: string): void => {
      const c = changeFor(s);
      if (c.generic.secret === true) return;
      c.note = { ...c.note, text: `${c.note.text}${/[.!?]$/.test(c.note.text) ? "" : "."} ${text}`.trim() };
    };
    for (const list of byFile.values()) {
      for (let i = 0; i + 1 < list.length; i++) {
        const m = list[i]!;
        const n = list[i + 1]!;
        if (m.prev_sha256 === null || m.kept === "gone" || n.kept === "gone") continue;
        if (n.prev_sha256 !== m.sha256 || n.sha256 !== m.prev_sha256 || m.sha256 === m.prev_sha256) continue;
        const cm = changeFor(m);
        const cn = changeFor(n);
        if (cm.generic.secret === true || cn.generic.secret === true) continue;
        cm.roundTrip = { role: "undone", with: cn.id };
        cn.roundTrip = { role: "restores", with: cm.id };
        addSentence(m, "The next change to this file undid this one.");
        addSentence(n, "This puts the file back to how it was before the previous change to this file.");
      }
      // Net change across the task, said once on the file's last change: from the state before its first change to the state after its last.
      const first = list[0]!;
      const last = list[list.length - 1]!;
      // Only a net change of none is said: a file that ends different from how it began already reads that way from its own steps.
      if (list.length > 1 && first.prev_sha256 !== null && last.kept !== "gone" && last.sha256 === first.prev_sha256) {
        addSentence(last, "Across the task the file ends as it began: the net change is none.");
      }
    }
  }

  // ---- the top-level sentences ----
  let expiredBlock: Timeline["expired"] = null;
  if (expired) {
    const text = `The values of this task expired on ${input.valuesExpiredAt}: the requests, the agent's words, the call lines and every cell value were deleted. What stays is which files changed, and their hashes.`;
    expiredBlock = { at: input.valuesExpiredAt!, text };
    missing.push(text);
  }
  if (folder === null) missing.push("The record does not say which folder the task watched, so files are shown by name only.");
  if (!expired && R.requests.length === 0 && input.ops.length > 0) missing.push("No requests or calls could be read from the record.");
  const truncated = ops.filter((o) => String(o.args_json ?? "").includes('"_truncated":true')).length;
  if (truncated > 0) missing.push(`${truncated === 1 ? "One record was" : `${truncated} records were`} too large to keep whole, so some of what ${truncated === 1 ? "it" : "they"} held is missing.`);
  if (outsideNamed > 0) missing.push(`${outsideNamed === 1 ? "A path" : `${outsideNamed} paths`} outside the watched folder ${outsideNamed === 1 ? "was" : "were"} named by calls and ${outsideNamed === 1 ? "is" : "are"} not shown.`);
  // a vouched nothing-changed state of no single call is no missing credit: it is only a muted line in the file's history.
  missing.push(...missingSentences(changeStates.map((s) => changeFor(s)).filter((c) => !(c.resave === true && c.by.kind !== "call")).map((c) => c.by), expired));
  if (redactions > 0) missing.push(`${redactions === 1 ? "A path" : `${redactions} paths`} outside the watched folder in the text below ${redactions === 1 ? "was" : "were"} shortened to the file name.`);

  return {
    schema: TIMELINE_SCHEMA,
    build: input.build,
    task: input.taskId,
    builtFrom: { highestOpId: highest(input.ops), highestStateId: highest(input.fileStates), valuesExpiredAt: input.valuesExpiredAt },
    folder: folder === null ? null : baseName(folder),
    hosts: [...hosts].sort(),
    host: taskHost,
    expired: expiredBlock,
    requests,
    unplaced,
    missing,
  };
}

function asKept(k: unknown): StateRef["kept"] {
  return k === "whole" || k === "hash" || k === "gone" ? k : null;
}

/**
 * Who each change is credited to, a pure function of the call records and the sweeps (the replay harness scores exactly this).
 * Starts from what the record credited, then narrows it, never widens it except the outside-file rule: positive write evidence first
 * (`input.writeEvidence`, the seam for the per-call tag), else the guards of credit-guard.ts (an internal agent call, a tool that cannot write,
 * a launch whose helper has a call open at the sweep, a file tool's own path, a call the transcript shows never ran or had ended), then the
 * write signal among those left.
 */
export function creditStates(input: TimelineInput, R: RunsResult, folder: string | null): { changeStates: State[]; scriptsOf: (id: string) => ScriptLookup | undefined } {
  const kit = pathKit();
  const inside = (p: string): boolean => folder !== null && kit.inside(folder, p);
  // A change credited to several open calls, of which exactly one shows a write signal for the file in its command or input text, is that call's alone (`write-signal.ts`).
  // A script a call runs counts when an earlier call of the same agent (same session and agent id) wrote it whole.
  const scriptsOf = (id: string): ScriptLookup | undefined => {
    const me = R.calls.get(id);
    const myOpen = me?.openedAt ?? null;
    if (!me || myOpen === null) return undefined;
    return (name) => {
      const texts: Array<{ at: number; text: string }> = [];
      for (const c of R.calls.values()) {
        if (c.id === id || c.session !== me.session || c.agentId !== me.agentId || c.openedAt === null || c.openedAt >= myOpen) continue;
        for (const w of scriptsWrittenBy(c)) if (w.name === name) texts.push({ at: c.openedAt, text: w.text });
      }
      return texts.sort((a, b) => a.at - b.at).map((t) => t.text);
    };
  };
  // An office file outside the folder is only ever seen because a call named it. One first seen with no call open (the sweep before the call that named it)
  // is credited to the calls that named it and were open at that moment, not to "outside the agents".
  const OUTSIDE_SLACK_MS = 1000;
  const namedWhenFound = (s: State): string[] => {
    if (s.credited.length > 0 || s.open.length > 0 || s.phase === "Post" || inside(s.file_path) || !s.ts) return s.credited;
    const at = Date.parse(s.ts);
    if (!Number.isFinite(at)) return s.credited;
    const named = [...R.calls.values()].filter((c) => c.named.has(s.file_path) && c.openedAt !== null && c.openedAt - OUTSIDE_SLACK_MS <= at && (c.closedAt === null || c.closedAt >= at)).map((c) => c.id);
    return named;
  };
  // The adapter's two credit guards, applied to ledgers written before them (see credit-guard.ts). A call with no record is left as it is.
  // An internal agent call (agent_id, no agent_type, no launcher) keeps only a change found at its own Post: a Post state at the time the call closed.
  const INTERNAL_POST_SLACK_MS = 1500;
  // The sweeps, in time order, for "the first sweep at or after a call's result": every recorded step, and every call's open and close
  // (a Pre, a Post, a Stop or the event that expired it each sweeps, though a sweep that changed nothing leaves no step).
  const gKit = input.guardKit ?? guardKit();
  const sweepTimes = [...new Set([...R.states.map((s) => (s.ts ? Date.parse(s.ts) : NaN)), ...[...R.calls.values()].flatMap((c) => [c.openedAt ?? NaN, c.closedAt ?? NaN])].filter((t) => Number.isFinite(t)))].sort((x, y) => x - y);
  const firstSweepAtOrAfter = (t: number): number | null => {
    let lo = 0;
    let hi = sweepTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sweepTimes[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo < sweepTimes.length ? sweepTimes[lo]! : null;
  };
  const guard = (s: State) => (id: string): boolean => {
    const c = R.calls.get(id);
    if (!c) return true;
    const at = s.ts ? Date.parse(s.ts) : NaN;
    if (isInternalAgentCall(c)) {
      const ownPost = s.phase === "Post" && (c.closedBy === "post" || c.closedBy === "failure") && c.closedAt !== null && Number.isFinite(at) && Math.abs(at - c.closedAt) <= INTERNAL_POST_SLACK_MS;
      if (!ownPost) return false;
    }
    const ev = input.evidence?.get(id) ?? c.ended ?? undefined;
    if (!evidenceMayCredit(ev, { background: runsOnAfterResult(c), closedByOwnEvent: c.closedBy === "post" || c.closedBy === "failure" }, Number.isFinite(at) ? at : null, firstSweepAtOrAfter)) return false;
    // A launch is no suspect at a sweep where a call of its own helper is open
    if (c.waits === true || isWaitTool(c.tool)) return false;
    if (!launcherMayCredit(c.tool, s.open.some((o) => R.calls.get(o)?.launchId === id))) return false;
    const fp = c.toolLabel?.fields.file_path;
    return toolMayCredit(c.tool, typeof fp === "string" ? fp : null, s.file_path, (a, b) => samePath(a, b, false, gKit), gKit);
  };
  const cannot = input.cannotWrite;
  const guarded = (s: State, ids: readonly string[]): string[] => creditWithEvidence(ids, s.file_path, input.writeEvidence, guard(s), s.step_id ?? null, cannot === undefined ? undefined : (id) => cannot(id, s.file_path, s.step_id ?? null));
  const changeStates = R.states.filter((s) => s.change).map((s) => {
    const found = guarded(s, namedWhenFound(s));
    const credited = creditedAfterWriteSignal(found, s.file_path, (id) => R.calls.get(id), scriptsOf, s.kept === "gone");
    return credited.length === s.credited.length && credited.every((id, i) => id === s.credited[i]) ? s : { ...s, credited };
  });
  return { changeStates, scriptsOf };
}
