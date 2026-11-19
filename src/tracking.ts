// The per-session tracking switch. Every session starts untracked: the hook records nothing and injects no context until the
// session is started. The switch is one small file per session under `<home>/tracking/`, written only by the hook, which recognises
// the exact command `cocheck track start|stop` on a PreToolUse and keys the switch by the hook's own session id (the CLI alone never
// guesses a session). `stop` removes the switch file and nothing else: what was recorded stays in the ledger.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFileAtomicSync } from "./home-perms.ts";
import path from "node:path";
import { onDir, SESSION } from "./attribution/tag.ts";

const TRACKING_DIR = "tracking";

export interface Tracking {
  host: string;
  session: string;
  /** The task folder: the cwd the session was started in. */
  folder?: string;
  since: string;
}

const dirOf = (home: string) => path.join(home, TRACKING_DIR);
const fileOf = (home: string, host: string, session: string) => path.join(dirOf(home), createHash("sha256").update(`${host}\0${session}`).digest("hex").slice(0, 40) + ".json");

/** The switch of a session, or undefined when it is untracked (never started, stopped, or an unreadable file: untracked is the safe side). */
export function trackingOf(home: string, host: string, session: unknown): Tracking | undefined {
  if (typeof session !== "string" || session === "") return undefined;
  try {
    const value = JSON.parse(readFileSync(fileOf(home, host, session), "utf8"));
    return value !== null && typeof value === "object" && value.host === host && value.session === session ? (value as Tracking) : undefined;
  } catch {
    return undefined;
  }
}

/** Turns the session's tracking on (recording its task folder) or off. Off removes only the switch. Throws when the switch cannot be written. */
export function setTracking(home: string, host: string, session: string, on: boolean, folder?: string, now: () => number = Date.now): void {
  const file = fileOf(home, host, session);
  // The write hooks' switch: a file named by the session id that exists only while the session is tracked.
  const marker = SESSION.test(session) ? path.join(onDir(home), session) : undefined;
  if (!on) {
    rmSync(file, { force: true });
    if (marker !== undefined) rmSync(marker, { force: true });
    return;
  }
  mkdirSync(dirOf(home), { recursive: true, mode: 0o700 });
  const body: Tracking = { host, session, ...(folder !== undefined && path.isAbsolute(folder) ? { folder } : {}), since: new Date(now()).toISOString() };
  writeFileAtomicSync(file, JSON.stringify(body) + "\n");
  if (marker !== undefined) {
    mkdirSync(onDir(home), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "", { mode: 0o600 });
  }
}

/** Every session currently tracked in `home`. */
export function listTracked(home: string): Tracking[] {
  let names: string[];
  try {
    names = readdirSync(dirOf(home));
  } catch {
    return [];
  }
  const out: Tracking[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const value = JSON.parse(readFileSync(path.join(dirOf(home), name), "utf8"));
      if (typeof value?.host === "string" && typeof value?.session === "string") out.push(value as Tracking);
    } catch {
      // a half-written file is not a switch
    }
  }
  return out;
}

/**
 * The ways a command can start with the cocheck launcher: `cocheck`, `cocheck.cmd`, `cocheck.ps1`, `node <path>cocheck.ts`, a path
 * ending in `/cocheck` or `\cocheck[.cmd|.ps1]` (bare, or quoted and so allowed spaces), each with an optional PowerShell call operator `& `.
 */
const LAUNCHER = String.raw`(?:&\s+)?(?:cocheck(?:\.cmd|\.ps1)?|node\s+["']?[^\s"'$\x60;&|<>()]*cocheck\.ts["']?|["']?[^\s"'$\x60;&|<>()]*[\\/]cocheck(?:\.cmd|\.ps1)?["']?|"[^"$\x60]*[\\/]cocheck(?:\.cmd|\.ps1)?"|'[^']*[\\/]cocheck(?:\.cmd|\.ps1)?')`;
const OPEN_RE = new RegExp(String.raw`^\s*${LAUNCHER}\s+open(?:\s+[1-9][0-9]*)?[ \t]*(?:$|[\n;&|])`);
const TRACK_RE = new RegExp(String.raw`^\s*${LAUNCHER}\s+track\s+(start|stop|status)[ \t]*(?:$|[\n;&|])`);

/** True when the command's first simple command is exactly `cocheck open` (with or without a task id), in the same forms as `trackCommand`. */
export function isOpenCommand(command: unknown): boolean {
  return typeof command === "string" && OPEN_RE.test(command);
}

type TrackVerb = "start" | "stop" | "status";

/**
 * The verb when the command's first simple command is exactly `cocheck track start|stop|status` (also `node <path>/cocheck.ts track ...`,
 * the source-checkout form, and the launcher forms in `LAUNCHER`). The command is read from its start: text inside a string, a heredoc, an
 * `echo` or a later command never matches, and nothing but whitespace may sit between the verb and the next command separator.
 */
export function trackCommand(command: unknown): TrackVerb | undefined {
  if (typeof command !== "string") return undefined;
  const m = TRACK_RE.exec(command);
  return m === null ? undefined : (m[1] as TrackVerb);
}
