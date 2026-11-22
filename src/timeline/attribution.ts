// Who made a change. Decided once, here, from the file state (`credited`, `calls_open`, `phase`), the calls CoCheck still has
// and the task's host. Every surface (the rail lane, chip, head and side text, the change and row notes, the page's who text and short
// who, the credit text, the timeline's missing list) takes its words from this module and branches on nothing else.
//
// CoCheck sees file content, not which process wrote it. The rule guards against a change an agent could have made reading as made
// outside the agents, so "outside" needs all three: no call credited, none open when the change was found, and not found at a call's Post.
// A change goes on one agent's lane only when every credited call is that agent's and every one of them is still on record. Anything
// else goes on the neutral lane, which names the possible makers and nothing more.

import { knownHostLabel } from "../hosts/index.ts";

/**
 * The rail's lane ids. A helper's lane is `agent:<n>`, numbered by the rail in the order helpers appear.
 * MAIN_LANE is a stored key, not a host decision: existing ledgers and pages carry the main lane as "claude" whatever host ran, so the
 * value stays and the lane's shown name comes from the task's host profile (`hostName`). Legacy key kept on purpose: never rename it.
 */
export const MAIN_LANE = "claude"; // legacy key kept on purpose: stored in ledger rows and the rail
export const OUTSIDE_LANE = "other";
export const UNSURE_LANE = "unsure";
export const HELPER_LANE = "agent:";

export const OUTSIDE_ACTOR = "Something outside the agents";
export const probablySideText = (probably: string): string => `Probably ${probably} (CoCheck can't tell for sure; it could also be you or another process).`;
export const OUTSIDE_SIDE_TEXT = "Changed between agent calls; CoCheck can't tell who or what wrote it (you, an app, or another process).";
export const LOST_CALL_ACTOR = "An agent call whose record is gone";
export const DURING_ACTOR = "Something, during agent calls,";
/** A call, or a main lane, with no host in the record and none in the task's client name. */
export const NO_HOST_ACTOR = "The agent";

/** One neutral grey for both unknown lanes: at least 3:1 against the sidebar in light and dark. */
const UNKNOWN_GREY = "#7a7f88";
export const OUTSIDE_LANE_ACTOR = { id: OUTSIDE_LANE, name: "Unknown", chip: "U", color: UNKNOWN_GREY } as const;
export const UNSURE_LANE_ACTOR = { id: UNSURE_LANE, name: "Unknown", chip: "U", color: UNKNOWN_GREY } as const;

export type ByKind = "call" | "joint" | "lost" | "during" | "outside";

/** The attribution of one change, stored on it as `change.by`. */
export interface By {
  kind: ByKind;
  /** The credited calls CoCheck still has, in credit order. */
  calls: string[];
  /** How many credited calls have no record (expired or gone). */
  lost: number;
  /** How many calls were open when the change was found. Context only, never credit. */
  open: number;
  /** The task's values expired. */
  expired: boolean;
  /** The name a note in the body starts with. The rail swaps it for its own name of the maker (a helper's number, the names of a joint). */
  actor: string;
  /** The host the record proves: the credited calls' one host, else the task's. Null when nothing proves one, and always for an outside change. */
  host: string | null;
  /** An outside change to a file the task's host app writes itself (`hostOwnedFiles`): who it probably was, in words ("the Claude app saving your permission choices"). A guess, never credit: it stays an outside change and the page says CoCheck can't tell for sure. */
  probably?: string;
}

/** What `attributionOf` reads of a call CoCheck still has. */
export interface CallRecord {
  session: string | null;
  host: string | null;
  agentId: string | null;
}

/** The name for a host. No host: "The agent". */
export function hostName(host: string | null | undefined): string {
  if (!host || host.trim() === "") return NO_HOST_ACTOR;
  const h = host.trim().toLowerCase();
  return knownHostLabel(h) ?? host.trim().replace(/^./, (c) => c.toUpperCase());
}

/** The host of a task from its client name, `<host>-hook:<folder>` (src/hook-adapter.ts); null for any other client. */
export function hostOfClient(client: string | null | undefined): string | null {
  const m = /^([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)-hook:/.exec(client ?? "");
  return m ? m[1]! : null;
}

/** The lane a call belongs to: the main lane, or its agent's (keyed by session and agent id, so two sessions' agents never share one). */
export const laneKeyOf = (session: string | null | undefined, agentId: string | null | undefined): string => (agentId == null ? MAIN_LANE : `${session ?? ""}\u0000${agentId}`);

/**
 * Who made a change. `state` is the file state as recorded; `calls` are the calls CoCheck still has (none once values expire);
 * `taskHost` comes from the task's client name.
 */
export function attributionOf(state: { credited: readonly string[]; open: readonly string[]; phase?: string | null }, calls: ReadonlyMap<string, CallRecord>, taskHost: string | null, expired: boolean, probably?: string): By {
  const resolvable = state.credited.filter((id) => calls.has(id));
  const lost = state.credited.length - resolvable.length;
  const base = { calls: resolvable, lost, open: state.open.length, expired };
  if (state.credited.length === 0) {
    if (state.open.length > 0 || state.phase === "Post") return { ...base, kind: "during", actor: DURING_ACTOR, host: taskHost };
    if (probably !== undefined) return { ...base, kind: "outside", actor: `Probably ${probably}`, host: null, probably };
    return { ...base, kind: "outside", actor: OUTSIDE_ACTOR, host: null };
  }
  if (lost > 0) return { ...base, kind: "lost", actor: LOST_CALL_ACTOR, host: taskHost };
  const records = resolvable.map((id) => calls.get(id)!);
  const hosts = [...new Set(records.map((c) => c.host).filter((h): h is string => !!h))];
  const host = hosts.length === 1 ? hosts[0]! : taskHost;
  const lanes = [...new Set(records.map((c) => laneKeyOf(c.session, c.agentId)))];
  if (lanes.length === 1) return { ...base, kind: "call", actor: hostName(host), host };
  const helpers = lanes.filter((l) => l !== MAIN_LANE).length;
  const some = helpers === 1 ? "a helper" : `one of ${helpers} helpers`;
  const actor = lanes.includes(MAIN_LANE) ? `${hostName(host)} or ${some}` : `One of ${helpers} helpers`;
  return { ...base, kind: "joint", actor, host };
}

/**
 * The attribution of a change in a body built before `by` existed (or a hand-built one). It never reads outside: with no credited call
 * on record it reads as found during agent calls, which claims no maker.
 */
export function byOf(change: { by?: By; credit: { calls: string[]; lost?: boolean } }, host: string | null): By {
  if (change.by) return change.by;
  const calls = change.credit.calls;
  if (calls.length > 0) return { kind: "call", calls, lost: 0, open: 0, expired: false, actor: hostName(host), host };
  if (change.credit.lost === true) return { kind: "lost", calls: [], lost: 1, open: 0, expired: false, actor: LOST_CALL_ACTOR, host: null };
  return { kind: "during", calls: [], lost: 0, open: 0, expired: false, actor: DURING_ACTOR, host: null };
}

// ---- the rail ----

/** The lane a change sits on. `callLane` is the lane of its calls, for a `call` change (main or a helper's). */
export function laneOf(by: By, callLane: string): string {
  if (by.kind === "call") return callLane;
  return by.kind === "outside" ? OUTSIDE_LANE : UNSURE_LANE;
}

const joinWith = (word: string, names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${word} ${names.at(-1)}`);

/** The maker as the rail names it. `laneNames` are the names of the lanes of the change's calls, in credit order, without repeats. */
export function railActor(by: By, laneNames: readonly string[]): string {
  if (by.kind === "call") return laneNames[0] ?? by.actor;
  if (by.kind === "joint") return joinWith("or", laneNames);
  return by.actor;
}

/** A note written in the body starts with `by.actor`; on the rail it starts with the rail's name for the maker instead. */
export function speakAs(text: string, by: By, actor: string): string {
  return actor !== by.actor && text.startsWith(by.actor + " ") ? actor + text.slice(by.actor.length) : text;
}

/** The side text of a stop: what CoCheck can and cannot say about who made it. None on an agent's own lane. */
export function sideText(by: By, laneNames: readonly string[]): string | undefined {
  const host = by.host ? hostName(by.host) : null;
  switch (by.kind) {
    case "call":
      return undefined;
    case "outside":
      return by.probably !== undefined ? probablySideText(by.probably) : OUTSIDE_SIDE_TEXT;
    case "joint":
      return `Changed while ${joinWith("and", laneNames)} were running; the record credits all of them, so CoCheck can't tell which one wrote it.`;
    case "lost":
      if (laneNames.length > 0) return `Credited to ${joinWith("and", laneNames)} and to an agent call whose record is gone; CoCheck can't tell which one made it.`;
      return `Credited to ${host ? `a ${host} call` : "an agent call"} whose record is gone${by.expired ? " (the task's values expired)" : ""}; CoCheck can't tell which agent made it.`;
    case "during":
      if (by.open > 0) return `Found while ${host ?? "agent"} calls were running, but none of them is credited with it. One of them may have written it, or something else did (you, an app, or another process).`;
      return `Found as ${host ? `a ${host} call` : "an agent call"} ended that CoCheck had not seen start, so it is not credited with it. That call may have written it, or something else did (you, an app, or another process).`;
  }
}

// ---- the page ----

/** The page's who text. `names` describe the change's calls on record ("claude call 1 of 2 (Bash)"), in credit order. */
export function whoText(by: By, names: readonly string[]): string {
  const host = by.host ? hostName(by.host) : null;
  switch (by.kind) {
    case "call":
    case "joint":
      return by.kind === "joint" || by.calls.length > 1 ? `Joint: ${names.join(" and ")} overlapped, so the change is credited to all of them.` : `Credit: ${names.join(", ")}.`;
    case "lost":
      if (names.length > 0) return `Credited to ${names.join(" and ")} and to an agent call whose record is gone, so CoCheck can't tell which one made it.`;
      return `Credited to ${host ? `a ${host} call` : "an agent call"} whose record is gone${by.expired ? " (the task's values expired)" : ""}, so CoCheck can't tell which agent made it.`;
    case "during":
      return "Found during agent calls, but none of them is credited with it, so CoCheck can't tell what made it.";
    case "outside":
      if (by.probably !== undefined) return `Found between agent calls, with no call running. ${probablySideText(by.probably)}`;
      return "Made outside the agents: found between agent calls, with no call running. CoCheck can't tell who or what wrote it.";
  }
}

/** The page's short who, one per kind of change in a file. */
export function whoShort(by: By): string {
  switch (by.kind) {
    case "call":
      return by.calls.length > 1 ? "joint" : "credit";
    case "joint":
      return "joint";
    case "lost":
      return "record gone";
    case "during":
      return "during agent calls";
    case "outside":
      return "outside the agents";
  }
}

/** How a call is named on the page: its host (the task's when the call has none), its place and its tool. */
export function callName(call: { host: string | null; index: number; of: number; tool: string | null }, by: By): string {
  return `${call.host ?? by.host ?? "agent"} call ${call.index} of ${call.of}${call.tool ? ` (${call.tool})` : ""}`;
}

// ---- the body ----

/** The credit text of a change in the body. */
export function creditText(by: By): string {
  switch (by.kind) {
    case "call":
    case "joint":
      return by.calls.length > 1 ? `credited jointly to ${by.calls.length} calls that overlapped` : "credited to this call";
    case "lost":
      if (by.calls.length > 0) return `credited jointly to ${by.calls.length + by.lost} calls; the record no longer holds ${by.lost === 1 ? "one of them" : `${by.lost} of them`}`;
      return by.expired ? "credited to a call whose record expired" : "credited to a call the record no longer holds";
    case "during":
      return by.open > 0 ? "calls were still open, but none can be shown to have made it" : "found as a call ended that CoCheck had not seen start, so none can be shown to have made it";
    case "outside":
      return "found between agent calls, with no call running";
  }
}

/** The timeline's missing list: one sentence per kind of change CoCheck can't credit to a call on record. */
export function missingSentences(all: ReadonlyArray<By>, expired: boolean): string[] {
  const count = (k: ByKind): number => all.filter((b) => b.kind === k).length;
  const out: string[] = [];
  const n = (k: number): string => (k === 1 ? "One change is" : `${k} changes are`);
  const was = (k: number): string => (k === 1 ? "it was" : "they were");
  const lost = count("lost");
  if (lost > 0) out.push(`${n(lost)} credited to an agent call whose record ${expired ? "expired" : "is gone"}, so CoCheck can't tell which agent made ${lost === 1 ? "it" : "them"}.`);
  const during = count("during");
  if (during > 0) out.push(`${n(during)} shown under no call: ${was(during)} found during agent calls, but none of the calls is credited with ${during === 1 ? "it" : "them"}.`);
  const outside = count("outside");
  if (outside > 0) out.push(`${n(outside)} shown under no call: ${was(outside)} found between agent calls, with no call running.`);
  return out;
}

/** The hook's own attribution words on a file state (src/hook-adapter.ts, `flush`). They are not shown: `by` says who. */
const HOOK_ATTRIBUTION = new Set(["not from an agent call", "calls were still open, but none can be shown to have made it"]);

/** A ledger note without the hook's attribution words; null when nothing else is left. */
export function ledgerNoteOf(note: string | null | undefined): string | null {
  if (!note) return null;
  const kept = note.split("; ").filter((part) => !HOOK_ATTRIBUTION.has(part.trim()));
  return kept.length === 0 ? null : kept.join("; ");
}
