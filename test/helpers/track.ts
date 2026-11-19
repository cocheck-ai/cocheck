// Every session starts untracked, so a test that wants the hook to record starts the session first. `runHookTracked` is
// `runHook` after one `startSession` for the payload's own session (a session already tracked is left as it is); the tests that pin
// the untracked behaviour call `runHook` itself.
import { homedir } from "node:os";
import path from "node:path";
import { runHook, type HookExit, type HookRun } from "../../src/hook-cli.ts";
import { resolveAdapterHome } from "../../src/hook-adapter.ts";
import { normalize } from "../../src/normalize.ts";
import { isHostKey } from "../../src/hosts/index.ts";
import { setTracking, trackingOf } from "../../src/tracking.ts";

/** Starts `session` of `host` in the home, the way a hook that saw `cocheck track start` would. */
export function startSession(home: string, host: string, session: string, folder?: string): void {
  setTracking(home, host, session, true, folder);
}

/** Starts the session a hook command line and its stdin bytes name (unless already tracked), the way `runHookTracked` does; an unusable payload starts nothing. */
export function startFromPayload(home: string, args: string[], input: Buffer | string): void {
  try {
    const host = args[args.indexOf("--host") + 1];
    if (!isHostKey(host)) return;
    const eventIdx = args.indexOf("--event");
    const ev = normalize(host, JSON.parse(input.toString("utf8")), eventIdx >= 0 ? args[eventIdx + 1] : undefined);
    if (typeof ev.session === "string" && ev.session !== "" && trackingOf(home, host, ev.session) === undefined) startSession(home, host, ev.session);
  } catch {
    // an unusable payload: the hook reports it itself
  }
}

export async function runHookTracked(run: HookRun): Promise<HookExit> {
  const chunks: Buffer[] = [];
  for await (const chunk of run.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const bytes = Buffer.concat(chunks);
  const host = run.argv[run.argv.indexOf("--host") + 1];
  try {
    const home = resolveAdapterHome(run.env, path.join(homedir(), ".cocheck"));
    if (isHostKey(host)) {
      const eventIdx = run.argv.indexOf("--event");
      const ev = normalize(host, JSON.parse(bytes.toString("utf8")), eventIdx >= 0 ? run.argv[eventIdx + 1] : undefined);
      if (typeof ev.session === "string" && ev.session !== "" && trackingOf(home, host, ev.session) === undefined) startSession(home, host, ev.session);
    }
  } catch {
    // an unusable payload or home: the hook reports it itself
  }
  return runHook({ ...run, stdin: (async function* () { yield bytes; })() });
}
