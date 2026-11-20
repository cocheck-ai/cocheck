// The host registry: the one place that lists the profiles. Lookups are functions, not a table built at load, so the profiles and the
// modules they import can load in any order. The built-in list is read at call time too: narration.ts imports this file and the profiles import narration.ts, so a module-level array would hit a profile before it is initialized.
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { copilot } from "./copilot.ts";
import type { HostCapabilities, HostKey, HostProfile } from "./types.ts";

export type { EventKind, HostCapabilities, HostKey, HostProfile, NarrationSource, PayloadFields } from "./types.ts";
export { MARKER } from "./types.ts";

/** Every profile, in the order they are listed to the person. */
export const allProfiles = (): readonly HostProfile[] => [...builtIn(), ...added];

/** The registry line: a new host is one entry here (plus its own profile module). */
const builtIn = (): readonly HostProfile[] => [claude, codex, copilot];
const added: HostProfile[] = [];

/** Adds a profile after the built-in ones until the returned function is called. For tests that prove a new host needs no core edit. */
export function registerHost(profile: HostProfile): () => void {
  added.push(profile);
  return () => {
    const at = added.indexOf(profile);
    if (at >= 0) added.splice(at, 1);
  };
}

/** True when the host's profile declares the capability. A host with no profile has none. */
export const hasCapability = (host: string | null | undefined, cap: Exclude<keyof HostCapabilities, "failureEvent">): boolean => findProfile(host)?.capabilities[cap] === true;

export function isHostKey(v: unknown): v is HostKey {
  return allProfiles().some((p) => p.key === v);
}

/** The profile for a host key as stored on a record, or undefined when the key has none. */
export const findProfile = (key: string | null | undefined): HostProfile | undefined => allProfiles().find((x) => x.key === key);

/** The profile for a host key. Throws for a key with no profile. */
export function profileOf(key: string): HostProfile {
  const p = allProfiles().find((x) => x.key === key);
  if (p === undefined) throw new Error(`unknown hook host: ${String(key)}`);
  return p;
}

/** A stored tool name read the way the hook records it today: the host's own name for the tool (see `HostProfile.toolName`). */
export function toolNameOf(host: string | null | undefined, reported: string): string {
  const p = findProfile(host);
  return p?.toolName === undefined ? reported : p.toolName(reported, {});
}

/** The host a task is assumed to run under when nothing says otherwise: the default main lane, and the folder variable the hook falls back to. */
export const defaultProfile = (): HostProfile => claude;

/** Clients that name themselves in a record but have no profile (nothing is recorded for them). Label only. */
const OTHER_CLIENTS: Readonly<Record<string, string>> = { gemini: "Gemini", cursor: "Cursor" };

/** The name for a host as stored on a record ("claude", "codex", or any client name). Undefined when nothing is known of it. */
export function knownHostLabel(host: string): string | undefined {
  const p = allProfiles().find((x) => x.key === host);
  return p !== undefined ? p.displayName : OTHER_CLIENTS[host];
}

/** True when a record from this host proves a failed call would have sent a failure event (so a call with none succeeded). */
export function reportsFailureEvents(host: string | null | undefined): boolean {
  return allProfiles().some((p) => p.key === host && p.capabilities.failureEvent);
}
