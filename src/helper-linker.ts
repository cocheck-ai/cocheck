// Helpers (subagents) whose inner hook calls arrive under a session id CoCheck has never seen (a host with `capabilities.helperSessions`).
// Such a host may send no agent id on a helper's calls: they run under the helper's own session id, and the link to the main session
// appears only at the main session's helper-stop event (its agent id is that inner session id). With tracking off by default, those calls must neither be
// recorded as an untracked session's nor lost. The rules, in order, for an event whose session is not tracked:
//   1. a link is on file (the helper's id -> its main session): the event is that helper's call, rewritten to name both;
//   2. the event is a helper's first prompt and its text equals the `prompt` of a launcher call a tracked session has open: exact text, one
//      match per launch, makes the link (the same evidence the CLI gives with `agentId`);
//   3. a tracked session has a launcher call open and the event is a tool call: it is held (raw bytes, 0600, under the data home), to be
//      replayed when the link appears. The bound: held until the launching session's `subagentStop` names the helper, or HELD_TTL_MS
//      after the launch, whichever comes first; then it is deleted unrecorded. A held call of a session whose parent stops tracking is
//      deleted the same way;
//   4. nothing tracked has a launch open: the event is dropped, as every untracked session's events are.
// Only a tracked session's launcher calls open a launch, so an untracked session leaves nothing here.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { scrubPayloadBytes } from "./patch-secrets.ts";
import { writeFileAtomicSync } from "./home-perms.ts";
import path from "node:path";
import { withFileLock } from "./file-lock.ts";
import { trackingOf, type Tracking } from "./tracking.ts";
import type { NormalizedEvent } from "./normalize.ts";
import { allProfiles, profileOf, type PayloadFields } from "./hosts/index.ts";
import { isLauncherTool } from "./credit-guard.ts";

/** How long a launch stays open, and so how long a held call waits for its helper's link. */
const HELD_TTL_MS = 15 * 60_000;
/** How long a link stays on file, for the helper's late events. */
const LINK_TTL_MS = 60 * 60_000;
const MAX_HELD_EVENTS = 200;
const MAX_HELD_BYTES = 2_000_000;
const MAX_HELD_SESSIONS = 8;
const MAX_LAUNCHES = 32;

export interface Launch {
  parent: string;
  prompt: string;
  agentType?: string;
  /** The launch call's args key (the adapter's own `argsKey`): stdin names no call id for a `task` Pre, so the adapter finds the open launch by this. */
  key?: string;
  at: number;
}
interface Link {
  parent: string;
  agentType?: string;
  /** The `key` of the launch this helper's prompt matched; absent when no single launch matched. */
  launchKey?: string;
  at: number;
}
interface Store {
  launches: Launch[];
  links: Record<string, Link>;
}
export interface Held {
  event: string;
  bytes: Buffer;
}

// The three names below are files in the data home that installs already hold: legacy key kept on purpose.
const STORE = "copilot-helpers.json"; // legacy key kept on purpose
const HELD = "copilot-held"; // legacy key kept on purpose
const lockOf = (home: string) => path.join(home, "copilot-helpers.lock"); // legacy key kept on purpose

/** True when some host that links helper sessions tracks `session`. */
const trackedByHelperHost = (home: string, session: string): boolean => allProfiles().some((p) => p.capabilities.helperSessions && trackingOf(home, p.key, session) !== undefined);
const heldFile = (home: string, session: string) => path.join(home, HELD, createHash("sha256").update(session).digest("hex").slice(0, 40) + ".jsonl");

let lastRead = "";
function read(home: string): Store {
  try {
    lastRead = readFileSync(path.join(home, STORE), "utf8");
    const v = JSON.parse(lastRead);
    return { launches: Array.isArray(v?.launches) ? v.launches : [], links: v?.links !== null && typeof v?.links === "object" ? v.links : {} };
  } catch {
    lastRead = "";
    return { launches: [], links: {} };
  }
}

/** Writes the store only when it differs from `before` (the text read), so an untracked session's event leaves nothing behind. */
function write(home: string, store: Store, before?: string): void {
  if (before !== undefined && JSON.stringify(store) + "\n" === before) return;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, STORE);
  writeFileAtomicSync(file, JSON.stringify(store) + "\n");
}

/** Drops what is past its bound, and the launches whose main session is no longer tracked; deletes held files nothing waits for. */
function prune(home: string, store: Store, now: number): void {
  store.launches = store.launches.filter((l) => now - l.at < HELD_TTL_MS && trackedByHelperHost(home, l.parent)).slice(-MAX_LAUNCHES);
  for (const [id, link] of Object.entries(store.links)) if (now - link.at >= LINK_TTL_MS || !trackedByHelperHost(home, link.parent)) delete store.links[id];
  let names: string[] = [];
  try {
    names = readdirSync(path.join(home, HELD));
  } catch {
    return;
  }
  for (const n of names) {
    const file = path.join(home, HELD, n);
    let first: number | undefined;
    try {
      first = Number(JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!).at);
    } catch {
      first = undefined;
    }
    if (first === undefined || !Number.isFinite(first) || now - first >= HELD_TTL_MS || store.launches.length === 0) rmSync(file, { force: true });
  }
}

/** Run at the start of every hook invocation, any host: deletes what is past its bound (a held call, a launch, a link). Touches nothing when no state exists. */
export async function pruneHelperState(home: string, now: number): Promise<void> {
  if (!existsSync(path.join(home, STORE)) && !existsSync(path.join(home, HELD))) return;
  await withFileLock(lockOf(home), async () => {
    const store = read(home);
    const before = lastRead;
    prune(home, store, now);
    write(home, store, before);
  });
}

/** A tracked session's launcher call opened: a helper may start under a session id of its own. */
async function noteLaunch(home: string, parent: string, prompt: unknown, agentType: unknown, now: number, key?: string): Promise<void> {
  if (typeof prompt !== "string" || prompt.trim() === "") return;
  await withFileLock(lockOf(home), async () => {
    const store = read(home);
    prune(home, store, now);
    store.launches.push({ parent, prompt: prompt.trim(), ...(typeof agentType === "string" && agentType !== "" ? { agentType } : {}), ...(key === undefined ? {} : { key }), at: now });
    store.launches = store.launches.slice(-MAX_LAUNCHES);
    write(home, store);
  });
}

interface GateResult {
  /** True: nothing more to do with this event (held, dropped, or handled). */
  stop: boolean;
  bytes: Buffer;
  started: Tracking | undefined;
  /** Held events of a helper that this event linked, to run before it. */
  replay: Held[];
}

/** The payload as the host sends a helper's event: the helper's id as the agent id, the main session as the parent session. The event keeps everything else. */
function relink(bytes: Buffer, helper: string, link: Link, f: PayloadFields): Buffer {
  if (f.parentSession === undefined || f.launchKey === undefined) return bytes;
  const p = JSON.parse(bytes.toString("utf8"));
  delete p[f.launchKey];
  return Buffer.from(JSON.stringify({ ...p, [f.agentId]: helper, [f.parentSession]: link.parent, ...(link.launchKey === undefined ? {} : { [f.launchKey]: link.launchKey }), ...(link.agentType === undefined || typeof p[f.agentType] === "string" ? {} : { [f.agentType]: link.agentType }) }));
}

/** An event of the host cannot carry the key itself: it is CoCheck's, put on by the gate. */
function stripLaunchKey(bytes: Buffer, f: PayloadFields): Buffer {
  if (f.launchKey === undefined) return bytes;
  try {
    const p = JSON.parse(bytes.toString("utf8"));
    if (p === null || typeof p !== "object" || !(f.launchKey in p)) return bytes;
    delete p[f.launchKey];
    return Buffer.from(JSON.stringify(p));
  } catch {
    return bytes;
  }
}

const isToolKind = (k: string) => k === "tool-pre" || k === "tool-post" || k === "tool-failure";

/**
 * The gate for an event of a host with helper sessions after the tracking switch was read (`started`). A tracked session's event goes on (a launcher call also opens a
 * launch, and a `subagentStop` links its helper and releases what was held for it). An untracked session's event follows the four rules above.
 */
export async function helperGate(home: string, started: Tracking | undefined, ev: NormalizedEvent, bytes: Buffer, eventName: string, now: number): Promise<GateResult> {
  const go = (b: Buffer, s: Tracking | undefined, replay: Held[] = []): GateResult => ({ stop: false, bytes: b, started: s, replay });
  const stop: GateResult = { stop: true, bytes, started, replay: [] };
  if (typeof ev.session !== "string" || ev.session === "") return go(bytes, started);
  const profile = profileOf(ev.host);
  const f = profile.fields;
  const promptEvents = Object.entries(profile.eventKinds).filter(([, k]) => k === "prompt").map(([n]) => n);
  const input = ev.toolInput !== null && typeof ev.toolInput === "object" ? (ev.toolInput as Record<string, unknown>) : {};
  if (started !== undefined) {
    if (ev.kind === "tool-pre" && isLauncherTool(ev.toolName, ev.host) && ev.agentId === undefined) await noteLaunch(home, ev.session, input.prompt, input.agent_type, now, profile.calls?.argsKey(ev.toolInput));
    if (typeof ev.agentId === "string" && ev.agentId !== "" && ev.kind !== "subagent-stop" && existsSync(path.join(home, STORE))) {
      // A helper's first prompt (the CLI sends agentId on it) is matched, word for word, to the one open launch carrying that prompt;
      // its later calls name that launch. Two launches with the same prompt make no link; the helper's calls then name no launch.
      return withFileLock(lockOf(home), async () => {
        const store = read(home);
        const before = lastRead;
        const agent = ev.agentId!;
        if (ev.eventName !== undefined && promptEvents.includes(ev.eventName) && typeof ev.prompt === "string" && store.links[agent] === undefined) {
          const same = store.launches.filter((l) => l.parent === ev.session && l.prompt === ev.prompt!.trim());
          if (same.length === 1 && same[0]!.key !== undefined) {
            store.launches.splice(store.launches.indexOf(same[0]!), 1);
            store.links[agent] = { parent: ev.session, ...(same[0]!.agentType === undefined ? {} : { agentType: same[0]!.agentType }), launchKey: same[0]!.key, at: now };
          }
        }
        const link = store.links[agent];
        write(home, store, before);
        return go(link?.launchKey !== undefined && link.parent === ev.session ? relink(bytes, agent, link, f) : stripLaunchKey(bytes, f), started);
      });
    }
    if (ev.kind === "subagent-stop" && typeof ev.agentId === "string") {
      return withFileLock(lockOf(home), async () => {
        const store = read(home);
        const linked = store.links[ev.agentId!];
        const i = linked !== undefined && linked.parent === ev.session ? -1 : store.launches.findIndex((l) => l.parent === ev.session && (ev.agentType === undefined || l.agentType === undefined || l.agentType === ev.agentType));
        const launch = i >= 0 ? store.launches.splice(i, 1)[0] : undefined;
        const link: Link = linked !== undefined && linked.parent === ev.session ? { ...linked, at: now } : { parent: ev.session, ...(launch?.agentType !== undefined ? { agentType: launch.agentType } : {}), at: now };
        const held = takeHeldLocked(home, ev.agentId!, link, now, f);
        store.links[ev.agentId!] = link;
        prune(home, store, now);
        write(home, store);
        return go(bytes, started, held);
      });
    }
    return go(bytes, started);
  }
  // Untracked from here on: with no launch or link ever filed there is nothing to link or hold, and nothing is written.
  if (!existsSync(path.join(home, STORE))) return stop;
  return withFileLock(lockOf(home), async () => {
    const store = read(home);
    const before = lastRead;
    prune(home, store, now);
    const link = store.links[ev.session];
    if (link !== undefined) {
      const parent = trackingOf(home, ev.host, link.parent);
      write(home, store, before);
      return parent === undefined ? stop : go(relink(bytes, ev.session, link, f), parent);
    }
    // A helper's first prompt carrying a tracked session's open launch prompt, word for word.
    if (ev.kind === "prompt" && typeof ev.prompt === "string") {
      const same = store.launches.filter((l) => l.prompt === ev.prompt!.trim());
      const i = same.length === 1 ? store.launches.indexOf(same[0]!) : -1;
      if (i >= 0) {
        const launch = store.launches.splice(i, 1)[0]!;
        const made: Link = { parent: launch.parent, ...(launch.agentType === undefined ? {} : { agentType: launch.agentType }), ...(launch.key === undefined ? {} : { launchKey: launch.key }), at: now };
        store.links[ev.session] = made;
        write(home, store);
        return go(relink(bytes, ev.session, made, f), trackingOf(home, ev.host, made.parent));
      }
    }
    if (ev.kind === "subagent-stop" && typeof ev.agentId === "string") rmSync(heldFile(home, ev.agentId), { force: true });
    if (isToolKind(ev.kind) && store.launches.length > 0) hold(home, ev.session, eventName, bytes, now);
    write(home, store, before);
    return stop;
  });
}

/** Appends one raw event to the session's held file, within the bounds; an event past a bound is not kept. */
function hold(home: string, session: string, event: string, bytes: Buffer, now: number): void {
  const file = heldFile(home, session);
  mkdirSync(path.join(home, HELD), { recursive: true, mode: 0o700 });
  let lines = 0;
  let size = 0;
  try {
    const text = readFileSync(file, "utf8");
    size = text.length;
    lines = text.split("\n").filter(Boolean).length;
  } catch {
    if (readdirSync(path.join(home, HELD)).length >= MAX_HELD_SESSIONS) return;
  }
  if (lines >= MAX_HELD_EVENTS || size + bytes.length > MAX_HELD_BYTES) return;
  appendFileSync(file, JSON.stringify({ event, at: now, body: scrubPayloadBytes(bytes).toString("utf8") }) + "\n", { mode: 0o600 });
}

/** The held events of `helper`, relinked to its main session, oldest first; the file goes. */
function takeHeldLocked(home: string, helper: string, link: Link, now: number, f: PayloadFields): Held[] {
  const file = heldFile(home, helper);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  rmSync(file, { force: true });
  const out: Held[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const v = JSON.parse(line);
      if (typeof v?.event === "string" && typeof v?.body === "string" && typeof v?.at === "number" && now - v.at < HELD_TTL_MS) out.push({ event: v.event, bytes: relink(Buffer.from(v.body), helper, link, f) });
    } catch {
      // a half-written line is not an event
    }
  }
  return out;
}
