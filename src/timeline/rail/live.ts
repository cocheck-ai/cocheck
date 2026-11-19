import type { RawOp } from "../runs.ts";

/**
 * Whether the task's agent is still working, from the ledger alone. A session is working from its UserPromptSubmit until its Stop;
 * the task is live while any session is. One long call (a build, a data pull) fires no hook, so silence alone never ends live: after
 * LIVE_IDLE_MS the answer says how long it has been quiet and the page slows down. Only a Stop (or the mark `cocheck track stop` writes), or LIVE_MAX_QUIET_MS of silence (a turn
 * that never reached Stop: interrupted, host closed), ends it. A wake notification is not a turn the person started and it is written at
 * the round's close, so it never makes a task live.
 */
export const LIVE_IDLE_MS = 15 * 60 * 1000;
export const LIVE_MAX_QUIET_MS = 2 * 60 * 60 * 1000;

export function isLive(ops: readonly RawOp[], nowMs: number): boolean {
  return liveState(ops, nowMs).live;
}

/** `quietMin` is whole minutes of silence once it passes the idle window, else null. */
export function liveState(ops: readonly RawOp[], nowMs: number): { live: boolean; quietMin: number | null } {
  const quiet = quietFor(ops, nowMs);
  if (quiet === null || quiet > LIVE_MAX_QUIET_MS) return { live: false, quietMin: null };
  return { live: true, quietMin: quiet >= LIVE_IDLE_MS ? Math.floor(quiet / 60000) : null };
}

/** Milliseconds since the newest recorded time while some session is mid-turn; null when none is (or no time is known). */
function quietFor(ops: readonly RawOp[], nowMs: number): number | null {
  const last = new Map<string, "prompt" | "stop">();
  let newest = 0;
  for (const o of [...ops].sort((x, y) => x.id - y.id)) {
    const a = (o.args ?? (o.args_json ? safe(o.args_json) : {})) as Record<string, unknown>;
    for (const k of ["at", "openedAt", "closedAt"]) if (typeof a[k] === "number" && Number.isFinite(a[k])) newest = Math.max(newest, a[k] as number);
    const session = typeof a.session_id === "string" ? a.session_id : "";
    if (a.hookEvent === "Stop" || a.hookEvent === "TrackingStopped") last.set(session, "stop");
    else if (a.hookEvent === "UserPromptSubmit") {
      const typed = ((a.prompts as unknown[]) ?? []).some((p) => typeof p === "string" && !p.startsWith("<task-notification>"));
      if (typed) last.set(session, "prompt");
    }
  }
  if (newest === 0 || ![...last.values()].includes("prompt")) return null;
  return Math.max(0, nowMs - newest);
}

function safe(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
