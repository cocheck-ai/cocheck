// The one place a host's raw hook payload is read. `normalize(host, raw)` returns a versioned NormalizedEvent; hook-adapter.ts
// consumes nothing else (a test fails if it reads a raw payload field or names a host). Values pass through unchanged, never coerced:
// the adapter's behaviour on an odd payload (a missing id, a non-string session) must stay what it was before the normalizer existed.
// Which hosts are wired, and where each keeps its fields, is declared by the profiles in src/hosts/; this file reads them.

import { scrubFailureText, scrubToolInput } from "./patch-secrets.ts";
import path, { isAbsolute } from "node:path";
import { isHostKey, profileOf, type EventKind, type HostKey } from "./hosts/index.ts";
import type { ExtraFields } from "./hosts/types.ts";
import { SHARED_EVENT_KINDS } from "./hosts/types.ts";
import type { ProofRecord } from "./attribution/basis.ts";

export type { EventKind };
export type HookHost = HostKey;

/** The version of the NormalizedEvent shape; a consumer refuses any other. */
const NORMALIZED_VERSION = 1;

export interface NormalizedEvent {
  v: typeof NORMALIZED_VERSION;
  host: HookHost;
  kind: EventKind;
  /** The host's own event name, kept for the record. */
  eventName: string;
  session: string;
  cwd?: string;
  toolName?: string;
  toolInput?: unknown;
  /** The call's result as the host sent it (a post event), unscrubbed; read only to keep an MCP call's response (scanned first). */
  toolResponse?: unknown;
  toolUseId?: string;
  agentId?: string;
  agentType?: string;
  /** The args key of the launch call a Copilot helper was linked to (put on the payload by src/copilot-helpers.ts, never sent by the host). */
  launchKey?: string;
  /** Set when the event reports a failed call: the host's failure event, or a post whose response carries the host's error flag. `raw` is the host's words, unredacted and unbounded. */
  failure?: { raw: string; interrupted: boolean; inferred?: true };
  /** The host's session file (Claude Code's transcript, Codex's rollout), when the payload names one. */
  transcriptPath?: string;
  /** The calling helper's own transcript, for a host that keeps one beside the session file (Claude Code: `<dir>/<session>/subagents/agent-<id>.jsonl`); absent for a main-thread call and for any other host. */
  helperTranscriptPath?: string;
  lastAssistantMessage?: string;
  prompt?: string;
  /** The host writes the call's words to its session file before the Pre (Claude Code); false: it writes them after the call, so they are read at Post. */
  narratesBeforeCall: boolean;
  /** The host's session file can be found from the session id alone, under the host's sessions folder (Codex rollouts). */
  sessionFileBySessionId: boolean;
  /** Host fields the adapter does not act on, kept so the record is whole. */
  extra: ExtraFields;
  /** What the event itself proves about who made a change (a tag in the call's argv, an edit the host reported). Empty for every host wired today: their proof is found by the adapter's sweep, not carried by the event. */
  proof: ProofRecord[];
  /** The call id was made up by CoCheck because the host sent none. False for every host wired today. */
  synthetic: boolean;
}

/** Every host event name the adapter handles; the installer must register exactly these. */
export const HANDLED_EVENTS: readonly string[] = Object.keys(SHARED_EVENT_KINDS);

/** Throws for a host that is not wired or a null payload. Never throws for a field of an odd type. */
export function normalize(host: HookHost, raw: unknown, eventArg?: string): NormalizedEvent {
  if (!isHostKey(host)) throw new Error(`unknown hook host: ${String(host)}`);
  const profile = profileOf(host);
  const f = profile.fields;
  // `null` threw (a TypeError, exit 1) before the normalizer existed; any other JSON value read as an event with no fields and was ignored (exit 0).
  if (raw === null || raw === undefined) throw new Error("hook payload is null");
  const p = raw as Record<string, unknown>;
  // A host whose payload names no event is told it by the hook command (`--event`).
  const eventName = (profile.eventFromArg === true ? eventArg : p[f.eventName]) as string;
  const named: EventKind = (typeof eventName === "string" && Object.hasOwn(profile.eventKinds, eventName) ? profile.eventKinds[eventName] : undefined) ?? "other";
  const kind: EventKind = profile.refineKind === undefined ? named : profile.refineKind(named, p);
  // A helper's event under its own session id names the main session; that is the session the event belongs to.
  const parent = f.parentSession === undefined ? undefined : p[f.parentSession];
  const rawInput = profile.parseToolInput === undefined ? p[f.toolInput] : profile.parseToolInput(p[f.toolInput]);
  return {
    v: NORMALIZED_VERSION,
    host,
    kind,
    eventName,
    session: (typeof parent === "string" && parent !== "" ? parent : p[f.session]) as string,
    cwd: p[f.cwd] as string | undefined,
    toolName: p[f.toolName] as string | undefined,
    // The raw input of a file-writing call (a patch is the new file contents) is scrubbed here, once; every consumer reads this form.
    toolInput: scrubToolInput(p[f.toolName], rawInput),
    toolResponse: f.toolResponse === undefined ? undefined : p[f.toolResponse],
    toolUseId: p[f.toolUseId] as string | undefined,
    agentId: p[f.agentId] as string | undefined,
    agentType: p[f.agentType] as string | undefined,
    ...(profile.capabilities.launchKey && typeof p.cocheckLaunchKey === "string" && p.cocheckLaunchKey !== "" ? { launchKey: p.cocheckLaunchKey } : {}),
    failure: scrubbedFailure(profile.failureOf(kind, p), p[f.toolName], rawInput),
    transcriptPath: p[f.transcriptPath] as string | undefined,
    ...helperTranscript(host, p),
    lastAssistantMessage: p[f.lastAssistantMessage] as string | undefined,
    prompt: p[f.prompt] as string | undefined,
    narratesBeforeCall: profile.narration.sources[0]?.readableAt === "pre",
    sessionFileBySessionId: profile.sessionFile.bySessionId,
    extra: profile.extraOf(p),
    proof: [],
    synthetic: false,
  };
}

/** A host's error text with echoes of a withheld patch section removed (see patch-secrets.ts). */
function scrubbedFailure<T extends { raw: string } | undefined | null>(failure: T, tool: unknown, input: unknown): T {
  return failure == null || typeof failure.raw !== "string" ? failure : { ...failure, raw: scrubFailureText(failure.raw, tool, input) };
}

/** Throws unless `ev` is a NormalizedEvent of the version this build reads. */
export function assertNormalized(ev: unknown): asserts ev is NormalizedEvent {
  const v = ev !== null && typeof ev === "object" ? (ev as { v?: unknown }).v : undefined;
  if (v !== NORMALIZED_VERSION) throw new Error(`unsupported NormalizedEvent version: ${String(v)}`);
}

/** The same short plain id the adapter keeps (it is never `.`, `..` or a dotfile when used in a path). */
const PLAIN_ID = /^[\w:-][\w.:-]{0,127}$/;

/** Where a helper's own transcript is, when the host keeps one and the payload names the helper, the session and an absolute session file. */
function helperTranscript(host: HookHost, p: Record<string, unknown>): { helperTranscriptPath?: string } {
  const helpers = profileOf(host).helpers;
  const f = profileOf(host).fields;
  const { [f.agentId]: agent, [f.session]: session, [f.transcriptPath]: file } = p;
  if (helpers === undefined || typeof agent !== "string" || typeof session !== "string" || typeof file !== "string") return {};
  if (!PLAIN_ID.test(agent) || !PLAIN_ID.test(session) || !isAbsolute(file)) return {};
  return { helperTranscriptPath: path.join(helpers.dirOf(file, session), helpers.transcriptFile(agent)) };
}
