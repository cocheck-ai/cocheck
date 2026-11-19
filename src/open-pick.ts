// Which task `cocheck open` (no id) lands on. The folder the command runs in decides, never "the newest task of any host". Two
// sessions in one folder are told apart by a short-lived record the PreToolUse hook writes when it sees `cocheck open` (the CLI alone
// knows no session). Nothing matches, or the match is ambiguous: the answer is the task list, with the reason, never a guessed task.
import { pathKit } from "./paths.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { writeFileAtomicSync } from "./home-perms.ts";
import path from "node:path";
import { HOOK_PREFIX, HOOK_SESSION_MARK, stripHookSession } from "./tasks.ts";

const OPEN_DIR = "open-requests";
/** A record older than this no longer says which session asked. */
const OPEN_FRESH_MS = 10_000;
const OPEN_KEEP_MS = 60_000;

interface OpenRecord {
  host: string;
  session: string;
  at: number;
}

const dirOf = (home: string) => path.join(home, OPEN_DIR);

/** Writes the record for the session that is about to run `cocheck open`; older records are dropped. Throws when it cannot be written. */
export function writeOpenRecord(home: string, host: string, session: string, now: number): void {
  mkdirSync(dirOf(home), { recursive: true, mode: 0o700 });
  for (const r of readOpenRecords(home)) if (now - r.at >= OPEN_KEEP_MS) rmSync(fileOf(home, r.host, r.session), { force: true });
  const file = fileOf(home, host, session);
  writeFileAtomicSync(file, JSON.stringify({ host, session, at: now } satisfies OpenRecord) + "\n");
}
const fileOf = (home: string, host: string, session: string) => path.join(dirOf(home), createHash("sha256").update(`${host}\0${session}`).digest("hex").slice(0, 40) + ".json");

export function readOpenRecords(home: string): OpenRecord[] {
  let names: string[];
  try {
    names = readdirSync(dirOf(home));
  } catch {
    return [];
  }
  const out: OpenRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const v = JSON.parse(readFileSync(path.join(dirOf(home), name), "utf8"));
      if (typeof v?.host === "string" && typeof v?.session === "string" && typeof v?.at === "number") out.push(v as OpenRecord);
    } catch {
      // a half-written file is not a record
    }
  }
  return out;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The folder a hook task's client names (`<host>-hook:<folder>?session=<id>`), or undefined for any other client. */
export function clientFolder(client: string | null | undefined): string | undefined {
  if (typeof client !== "string" || !HOOK_PREFIX.test(client)) return undefined;
  const folder = stripHookSession(client).replace(HOOK_PREFIX, "");
  return path.isAbsolute(folder) ? folder : undefined;
}

const sessionOfClient = (client: string): string => (stripHookSession(client) === client ? "" : client.slice(client.lastIndexOf(HOOK_SESSION_MARK) + HOOK_SESSION_MARK.length));
const sanitize = (s: string): string => s.trim().replace(/[^A-Za-z0-9_.-]/g, "_");

export interface OpenTask {
  id: number;
  client: string | null | undefined;
  /** Newest activity, ISO; "" when none. */
  ts: string;
}
export type OpenChoice = { task: number } | { list: string };

/**
 * `tasks` are the listed tasks. `cwd` is where `cocheck open` ran; `env` may carry CLAUDE_CODE_SESSION_ID; `records` are the open records
 * on disk; `now` is the clock.
 */
export function chooseOpenTask(tasks: OpenTask[], cwd: string, env: NodeJS.ProcessEnv, records: OpenRecord[], now: number): OpenChoice {
  const here = real(cwd);
  const inside = tasks.flatMap((t) => {
    const f = clientFolder(t.client);
    if (f === undefined) return [];
    const rf = real(f);
    return pathKit().same(here, rf) || pathKit().inside(rf, here) ? [{ ...t, folder: rf, client: t.client as string }] : [];
  });
  if (inside.length === 0) return { list: `no task is recorded for ${cwd} or a folder above it. Sessions start untracked: tell the agent "start tracking" to begin one` };
  const deepest = inside.reduce((n, t) => Math.max(n, t.folder.length), 0);
  const here1 = inside.filter((t) => t.folder.length === deepest);
  const newest = (ts: typeof here1) => ts.reduce((a, b) => (b.ts > a.ts || (b.ts === a.ts && b.id > a.id) ? b : a));
  const sessions = new Set(here1.map((t) => sessionOfClient(t.client)));
  if (sessions.size === 1) return { task: newest(here1).id };
  // Several sessions worked in this folder: only a session that asked decides.
  const claude = typeof env.CLAUDE_CODE_SESSION_ID === "string" && env.CLAUDE_CODE_SESSION_ID !== "" ? sanitize(env.CLAUDE_CODE_SESSION_ID) : undefined;
  if (claude !== undefined) {
    const mine = here1.filter((t) => t.client.startsWith("claude-hook:") && sessionOfClient(t.client) === claude);
    if (mine.length > 0) return { task: newest(mine).id };
  }
  const fresh = records.filter((r) => now - r.at < OPEN_FRESH_MS && r.at - now < OPEN_FRESH_MS);
  if (fresh.length !== 1) return { list: `${sessions.size} sessions worked in ${here1[0]!.folder} and ${fresh.length === 0 ? "no hook record says which one asked" : "several sessions asked at once"}` };
  const rec = fresh[0]!;
  const mine = here1.filter((t) => t.client.startsWith(`${rec.host}-hook:`) && sessionOfClient(t.client) === sanitize(rec.session));
  if (mine.length === 0) return { list: `${sessions.size} sessions worked in ${here1[0]!.folder} and the session that asked has no task there` };
  return { task: newest(mine).id };
}
