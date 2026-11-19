// The seam between CoCheck and a host (Claude Code, Codex). One profile per host declares everything CoCheck needs to know about it;
// the rest of the code asks the profile and never tests a host name. Profiles are plain modules in this repo, never loaded from outside.
// To add a host, see "Adding a host" in docs/hooks.md.
import type { NarrationCursor } from "../narration.ts";
import type { TranscriptCalls } from "../coverage.ts";
import type { HookCommandSpec, Platform } from "../platform/types.ts";

/** The host keys CoCheck can record. This is also the value `--host` takes and the value stored in ledger rows and journal records. */
export type HostKey = string;

/** What an event is, in the adapter's terms; "other" is an event name the adapter does not act on. */
export type EventKind = "tool-pre" | "tool-post" | "tool-failure" | "stop" | "subagent-stop" | "prompt" | "other";

/** Where each field CoCheck reads sits in a host's hook payload (a top-level payload key; the per-call reason is a path inside the input). */
export interface PayloadFields {
  eventName: string;
  session: string;
  cwd: string;
  toolName: string;
  toolInput: string;
  /** The key holding the call's result (a post event); absent when the host has none. */
  toolResponse?: string;
  toolUseId: string;
  agentId: string;
  agentType: string;
  transcriptPath: string;
  lastAssistantMessage: string;
  prompt: string;
  /** The per-call reason the host's own tool input carries (a key of the tool input), or undefined when the host carries none. */
  callReason?: string;
  /** A host whose helper events run under the helper's own session id and name the main session in this key: that value is the event's session, the helper's id stays its `agentId`. */
  parentSession?: string;
}

/** One place the call's words can come from, ranked first to last by the profile, and when each can be read. */
export interface NarrationSource {
  kind: "text-before-call" | "commentary-before-call" | "closing-message";
  /** "pre": readable at the call's PreToolUse; "post": only at its PostToolUse (or the Stop, for the closing message). */
  readableAt: "pre" | "post";
  /** True: the call's words from this source are also its row's reason (after the host's own per-call reason). */
  reason?: true;
}

/** Host fields the adapter does not act on, kept so the record is whole. */
export interface ExtraFields {
  turnId?: string;
  permissionMode?: string;
  model?: string;
  stopHookActive?: boolean;
}

/** The failure a post-like event reports, in the host's words; `raw` is unredacted and unbounded. */
/** `inferred`: the host sent no failure signal and CoCheck read the failure from the output text (a guess, never proof that other calls succeeded). */
export type FailureRead = { raw: string; interrupted: boolean; inferred?: true } | undefined;

/**
 * What a host can do. The core reads these, never a host name. A host without a capability gets the fallback: no tag and no SessionStart entry
 * without `argvTag`, no helper gate without `helperSessions`, and so on.
 */
export interface HostCapabilities {
  /** The host sends a failure event for a failed call, so a call that closes with none succeeded. */
  failureEvent: boolean;
  /** The host runs a Pre hook whose output can rewrite the call's command (the argv tag) and a SessionStart hook that can set the session's environment. */
  argvTag: boolean;
  /** Helper events arrive under the helper's own session id, so the hook links them to their main session or holds them (src/copilot-helpers.ts). */
  helperSessions: boolean;
  /** The host's payload may carry `cocheckLaunchKey`, the key that binds a helper launch to its calls. */
  launchKey: boolean;
  /** The host also runs the hooks of another host's config; a payload of such a run that another host's hook receives is not recorded by that hook. */
  readsForeignHooks: boolean;
}

export interface HostProfile {
  // ---- identity ----
  key: HostKey;
  /** The name shown to the person ("Claude"). */
  displayName: string;
  /** The product's full name where a page has room for it ("Claude Code"); absent: `displayName`. */
  fullName?: string;
  /** The one-letter chip on the rail. */
  chip: string;
  /** Host versions this profile was checked against. */
  testedVersions: readonly string[];

  // ---- events ----
  /** The host's hook event names, mapped to CoCheck's kinds. */
  eventKinds: Readonly<Record<string, EventKind>>;
  /** The host's payload carries no event name; the hook command names it (`--event <name>`) and the installer writes one entry per event. */
  eventFromArg?: true;
  /** Event names the host documents but no recording shows: declared, never mapped, never installed. */
  unverifiedEvents?: readonly string[];
  /** Missing capabilities. `failureEvent`: the host sends a failure event for a failed call, so a call that closes with no failure event succeeded. */
  capabilities: HostCapabilities;

  // ---- call fields ----
  fields: PayloadFields;
  /** The failure a post-like event reports (the host's failure event, or a post whose response carries the host's error flag); undefined when none. */
  failureOf(kind: EventKind, payload: Record<string, unknown>): FailureRead;
  /** The payload fields the adapter keeps but does not act on. */
  extraOf(payload: Record<string, unknown>): ExtraFields;
  /** A host whose event kind depends on more than the event name (a helper's own stop and prompt are not the main agent's): the kind this payload has, given the one the name maps to. */
  refineKind?(kind: EventKind, payload: Record<string, unknown>): EventKind;
  /** A host whose tool arguments may arrive as JSON text: the parsed value (anything that is not such text passes through). */
  parseToolInput?(value: unknown): unknown;

  // ---- call ids ----
  /**
   * A host whose hook stdin carries no call id. At a Pre the id comes from the narration cursor (the host's session file names its tool
   * requests), else a synthetic per-session id; a Post binds to the oldest open Pre of the same session, tool and arguments.
   */
  calls?: {
    /** A short stable key of the tool arguments, equal for equal arguments whatever their key order. */
    argsKey(toolInput: unknown): string;
    /** The synthetic id for the `n`th call of a session without a file id. */
    syntheticId(session: string, n: number): string;
  };

  /** The host's reply text as shown (a directive the host renders itself is turned into plain words); the ledger keeps the original. */
  displayText?: (text: string) => string;

  // ---- narration ----
  narration: {
    /** Ranked, best first. */
    sources: readonly NarrationSource[];
    /** Folds one line of the host's session file into the cursor. */
    foldLine(cur: NarrationCursor, line: string): void;
    /** A host whose words reach its session file before the call is run, but are bound to a call only after it: gives the words the cursor holds, not yet bound, to the call `id` at its Pre. */
    claimAtPre?(cur: NarrationCursor, id: string): void;
    /** The closing words the cursor holds at a Stop, when the payload gave none. */
    closing(cur: NarrationCursor | undefined): string;
    /** The most ms a Stop waits for the closing message to reach a session file that lags the hook (Copilot flushes it after agentStop starts). Absent: no wait. */
    closingWaitMs?: number;
  };

  // ---- session file ----
  sessionFile: {
    /** The file can be found from the session id alone, under the host's own folder. */
    bySessionId: boolean;
    /** The host's own folder layout, used when the payload names no session file. `root` overrides the host's default folder (tests). */
    locate(session: string, now: number, root?: string): string | undefined;
    /** A host whose helper writes its own session file named by the helper's id: the file of helper `agent` of `session`, only when the file's own header says so. */
    locateHelper?(session: string, agent: string, now: number, root?: string): string | undefined;
    /**
     * A host whose session file records each call's own words (the command it ran and what it printed), by call id. Read at a sweep to
     * narrow who may have written a file: a call that names the file in its command or record is credited ahead of one that names nothing.
     * Capped like the Claude transcript reads; undefined for a file that is missing, a link or over the cap.
     */
    callText?(file: string): ReadonlyMap<string, string> | undefined;
    /**
     * A host whose session file records each call's exit status: the calls that failed (a nonzero exit code, or a failed status with no
     * code), by call id. A call with exit code 0, or with no status, is absent. Undefined for a file that is missing, a link or over the cap.
     */
    callExit?(file: string): ReadonlyMap<string, { exitCode: number | null; output: string }> | undefined;
    /**
     * A host whose session file records, as text, that the host itself refused to start a command: each such command as the file quotes
     * it, with the time of the line (epoch ms). A refusal that quotes no command has no `command`. Only an explicit refusal counts; a command that returned early or failed is not in the list.
     * Undefined for a file that is missing, a link or over the cap.
     */
    refusedCommands?(file: string): ReadonlyArray<{ command?: string; at: number }> | undefined;
  };

  // ---- the host's own name for a session ----
  /** The title the host gave session `session`, read-only and best-effort from its own files (`root` overrides the folder, for tests); undefined when it cannot be told. Only the title leaves the reader. */
  sessionTitle?(session: string, root?: string): string | undefined;

  // ---- helpers (subagents) ----
  /** Where a helper's own record lives, when the host keeps one; undefined: the host keeps none. */
  helpers?: {
    /** The folder of a session's helper files, from the session file's path. */
    dirOf(sessionFile: string, session: string): string;
    /** The helper's own transcript and meta file names, and the patterns that list them. */
    transcriptFile(agentId: string): string;
    metaFile(agentId: string): string;
    /** The helper id a transcript or meta file name carries (the name already matched `transcriptName` or `metaName`). */
    idOfTranscript(name: string): string;
    idOfMeta(name: string): string;
    transcriptName: RegExp;
    metaName: RegExp;
    /** The folder name inside a project folder where a session's helper folder sits, and the folder holding all project folders. */
    folderName: string;
    projectsRoot(): string;
  };

  // ---- files the host app writes itself ----
  /** Task-folder-relative paths (forward slashes) the host app writes for its own bookkeeping, such as the user's saved permission choices. Never skipped: a change found with no agent call to credit is recorded as on any file, and the page says it was probably the app (`hostOwnedWhat`). CoCheck can't tell the app's write from an agent's background write. Undefined: none. */
  hostOwnedFiles?: readonly string[];
  /** What the app is probably doing when it writes a `hostOwnedFiles` file, after "Probably ", e.g. "the Claude app saving your permission choices". */
  hostOwnedWhat?: string;

  // ---- coverage ----
  /** Every call id the host's own session file holds, to check the hook saw them all; undefined: the host's file is not read for coverage. */
  coverage?: { readCalls(sessionFile: unknown, session: string): TranscriptCalls };

  // ---- reveal ----
  /**
   * A host whose own transcript holds a call's input text: the raw string `field` of call `toolUseId` in `file`, or undefined. The caller has checked
   * the file is a regular file whose realpath is under the profile root, so this only reads. A host without it can never reveal a withheld field.
   */
  reveal?: { fieldText(file: string, toolUseId: string, field: string): Promise<string | undefined> };

  // ---- install ----
  install?: {
    /** The skill folder under the person's home that the host reads (`.claude/skills`). */
    skillRoot: string;
    /** The host's hook has no `--folder`, so an install for it reuses `--home` and `--folder` from the record a first install wrote. */
    reusesRecord?: true;
    /** The host is part of what `--for both` means. Kept for the `both` flag; a new host leaves it out. */
    inBothAlias?: true;
    /** The host's name in the hook-timing line, when it differs from `displayName`. */
    timingLabel?: string;
    /** The `--host` value written into the hook command. */
    hostFlag: string;
    /** The environment variable the host sets to the project folder, used when the hook command names no `--folder`. */
    projectDirEnv?: string;
    /** The payload a hook check sends to prove the hook records (a Pre of a harmless call, in the host's own shape), and the `--event` it names. Default: Claude's shape. */
    checkPayload?(folder: string): { payload: Record<string, unknown>; event?: string };
    /** The config file is wholly CoCheck's: uninstall deletes it (only when it carries CoCheck's marker) instead of editing it. */
    ownsFile?: true;
    /** The host's payload carries the task folder as its `cwd`; the hook uses that when the command names no `--folder` and no variable is set. */
    folderFromPayloadCwd?: boolean;
    /** False: the hook prints nothing at a recorded prompt (no context text for the agent). Default true. */
    promptContext?: false;
    /** The hook events CoCheck installs for this host. */
    events: readonly string[];
    /** The host's config file, from the environment and the user's home. */
    configFile(env: NodeJS.ProcessEnv, userHome: string): string;
    /**
     * The config text with CoCheck's entries added (any earlier ones replaced). The command is built by `platform.hookCommand` from `spec`
     * (undefined: a dry run that only checks the file is safe to edit). Throws an Error (with the file named) when it is not.
     */
    addHooks(text: string, file: string, spec: HookCommandSpec | undefined, platform?: Platform): string;
    /** The config text with every CoCheck entry removed (found through `platform.hookCommand`), and whether anything went. Throws for a file that is not safe to edit. */
    removeHooks(text: string, file: string, platform?: Platform): { text: string; changed: boolean };
    /** The events in `events` that have no CoCheck entry in this config text. */
    missingEvents(text: string, file: string, platform?: Platform): string[];
    /** Why the host will not run CoCheck's installed hooks (its own trust state), read live; undefined when it will or cannot be told. `hookPath`: CoCheck's hook script. */
    trustProblem?(configFile: string, env: NodeJS.ProcessEnv, hookPath: string, read?: (codexHome: string, env: NodeJS.ProcessEnv) => unknown): string | undefined;
    /** Said after an install, when the host needs a step from the person before the hooks run. */
    afterInstall?: string;
    /** A standing note about the install that depends on where CoCheck lives (also shown by `cocheck status`); `launcherDir` holds the hook's scripts and build, `home` is the data folder. */
    notes?(where: { launcherDir: string; home: string }): string;
  };

  // ---- expected shape (stub for the drift check) ----
  /** The fields each event is expected to carry. Not read yet. */
  shape: Readonly<Record<string, readonly string[]>>;
}

/** The marker every hook entry CoCheck writes carries; uninstall removes exactly the entries that carry it. */
export const MARKER = "COCHECK_MANAGED=1";

/** The hook events every host here sends under these names; a host that lacks one says so in `capabilities`. */
export const SHARED_EVENT_KINDS: Readonly<Record<string, EventKind>> = {
  PreToolUse: "tool-pre",
  PostToolUse: "tool-post",
  PostToolUseFailure: "tool-failure",
  Stop: "stop",
  SubagentStop: "subagent-stop",
  UserPromptSubmit: "prompt",
};

/** The payload keys both hosts use. */
export const SHARED_FIELDS: PayloadFields = {
  eventName: "hook_event_name",
  session: "session_id",
  cwd: "cwd",
  toolName: "tool_name",
  toolInput: "tool_input",
  toolResponse: "tool_response",
  toolUseId: "tool_use_id",
  agentId: "agent_id",
  agentType: "agent_type",
  transcriptPath: "transcript_path",
  lastAssistantMessage: "last_assistant_message",
  prompt: "prompt",
};
