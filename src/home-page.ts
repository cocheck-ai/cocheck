// The home page: one dense row per task, each linking to its review page. It reads the ledger's capture tables and the host's own session title, calls no model and
// states no verdict beyond the standing the review page already shows. This file draws and gathers; the standing of a task comes from the caller.
import { count, esc, fileBase, momentText, plural, userText, words, type Shown } from "./display.ts";
import { findProfile } from "./hosts/index.ts";
import type { FileStateRow, Ledger } from "./ledger.ts";
import { formatLocalTime } from "./signoff.ts";
import { HOOK_SESSION_MARK, hookFolderOf, stripHookSession } from "./tasks.ts";
import { hostName, hostOfClient } from "./timeline/attribution.ts";
import { designTokensCss } from "./timeline/rail/page.ts";

/** Where each host's own session files live, by host key (tests and scratch homes); a host with no entry uses its own default folder. */
export type TitleRoots = Readonly<Record<string, string>>;

/** The session id a hook client name carries (`<host>-hook:<folder>?session=<id>`), or undefined for a client with none. Exact, never a guess. */
export function sessionOfClient(client: string | null | undefined): string | undefined {
  if (typeof client !== "string" || stripHookSession(client) === client) return undefined;
  const id = client.slice(client.lastIndexOf(HOOK_SESSION_MARK) + HOOK_SESSION_MARK.length);
  return id === "" ? undefined : id;
}

/** A request shortened to a name: its first line, whitespace folded, cut at a word near `max` characters. */
export function shortenRequest(text: string, max = 64): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const one = line.replace(/\s+/g, " ");
  const chars = [...one];
  if (chars.length <= max) return one;
  const head = chars.slice(0, max).join("");
  const at = head.lastIndexOf(" ");
  return `${(at > max / 2 ? head.slice(0, at) : head).replace(/[ ,;:.-]+$/, "")}…`;
}

/**
 * The name of a task's session: the host's own title for that exact session id, else the first request shortened, else "Session N".
 * A reader that throws or finds nothing is the same as no reader.
 */
export function sessionName(ledger: Ledger, taskId: number, roots: TitleRoots = {}): { name: string; from: "host" | "request" | "none" } {
  const client = ledger.taskClient(taskId);
  const host = hostOfClient(client);
  const session = sessionOfClient(client);
  if (host !== null && session !== undefined) {
    try {
      const title = findProfile(host)?.sessionTitle?.(session, roots[host]);
      if (typeof title === "string" && title.trim() !== "") return { name: title, from: "host" };
    } catch {
      // best-effort: fall back below
    }
  }
  try {
    const first = ledger.firstPromptForTask(taskId);
    const short = first === undefined ? "" : shortenRequest(first);
    if (short !== "") return { name: short, from: "request" };
  } catch {
    // fall through
  }
  return { name: `Session ${taskId}`, from: "none" };
}

/**
 * Files credited to an agent against files only found changed. Credited: some call is credited with the change, the basis is not
 * 'unattributed', and the bytes differ from the file's previous state. Uncredited: a changed file with no credited state at all.
 * Counted by file path; `shown` is the credited files in the order first recorded.
 */
export function creditCounts(states: readonly FileStateRow[]): { credited: number; uncredited: number; shown: string[] } {
  const credited = new Map<string, true>();
  const seen = new Set<string>();
  for (const f of states) {
    if (f.sha256 === f.prevSha256) continue;
    seen.add(f.filePath);
    if (f.credited.length > 0 && f.creditBasis !== "unattributed") credited.set(f.filePath, true);
  }
  return { credited: credited.size, uncredited: [...seen].filter((p) => !credited.has(p)).length, shown: [...credited.keys()] };
}

export interface HomeSession {
  id: number;
  /** Newest activity, ISO. */
  ts: string;
  /** The review page's own standing: "waiting" with nothing marked is the unreviewed kind. */
  standing: "unreviewed" | "reviewed" | "signed" | "expired";
  /** The current sign-off, when there is one: who, when, and how many earlier ones sit under it. */
  signed?: { by: string; at: string; earlier: number };
  /** Work came after the sign-off, so it is not signed off again yet. */
  newWork?: boolean;
}

interface Card {
  id: number;
  ts: string;
  standing: HomeSession["standing"];
  host: string | null;
  hostLabel: Shown;
  name: string;
  folder: string | null;
  files: Shown[];
  credited: number;
  uncredited: number;
  steps: number;
  rounds: number;
  signed?: HomeSession["signed"];
  newWork?: boolean;
}

function cardOf(ledger: Ledger, s: HomeSession, roots: TitleRoots): Card {
  const client = ledger.taskClient(s.id);
  const host = hostOfClient(client);
  const counts = creditCounts(ledger.fileStatesForTask(s.id));
  const dir = hookFolderOf(client);
  return {
    id: s.id,
    ts: s.ts,
    standing: s.standing,
    host,
    hostLabel: userText(host === null ? "Agent" : (findProfile(host)?.fullName ?? hostName(host))),
    name: sessionName(ledger, s.id, roots).name,
    folder: dir === null ? null : dir.replace(/\\/g, "/").split("/").filter((x) => x !== "").pop() ?? null,
    files: counts.shown.slice(0, 3).map(fileBase),
    credited: counts.credited,
    uncredited: counts.uncredited,
    steps: ledger.stepsForTask(s.id).length,
    rounds: ledger.roundsForTask(s.id).length,
    ...(s.signed === undefined ? {} : { signed: s.signed }),
    ...(s.newWork === true ? { newWork: true } : {}),
  };
}

const PALETTE = ["var(--after)", "var(--extra)", "var(--before)", "var(--teal)", "var(--warn)"];
const dotColor = (host: string | null): string => PALETTE[[...(host ?? "")].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length]!;

/** The status glyph of a row: none for the default (waiting for review), a glyph with a spoken name for the other standings. */
const GLYPH: Record<HomeSession["standing"], { mark: string; label: string; cls: string } | null> = {
  unreviewed: null,
  reviewed: { mark: "&#9680;", label: "In review", cls: "rev" },
  signed: { mark: "&#10003;", label: "Signed off", cls: "ok" },
  expired: { mark: "&#9676;", label: "Expired", cls: "exp" },
};

const uncreditedNote = (n: number): string => (n > 0 ? `+ ${esc(count(n))} found changed on disk, not credited` : "");

/** Under a row with a sign-off: who signed and when, the earlier sign-offs, and work that came after. */
function signedNote(c: Card): string {
  if (c.signed === undefined) return "";
  const earlier = c.signed.earlier > 0 ? `; ${esc(count(c.signed.earlier))} earlier sign-off${c.signed.earlier === 1 ? "" : "s"}` : "";
  const fresh = c.newWork === true ? " - new work since, not yet signed off again" : "";
  return `signed off by ${esc(userText(c.signed.by))} on ${esc(momentText(formatLocalTime(c.signed.at)))}${earlier}${fresh}`;
}

function rowHtml(c: Card, token: string): string {
  const g = GLYPH[c.standing];
  const when = c.ts === "" ? "" : esc(momentText(formatLocalTime(c.ts)));
  const folder = c.folder === null ? "" : ` <span class="quiet">&middot; ${esc(userText(c.folder))}</span>`;
  const notes = [uncreditedNote(c.uncredited), signedNote(c)].filter((x) => x !== "");
  return (
    `<a class="row" href="/timeline/${c.id}/review?t=${encodeURIComponent(token)}">` +
    `<span class="gl${g === null ? "" : ` ${g.cls}`}"${g === null ? "" : ` title="${g.label}" role="img" aria-label="${g.label}"`}>${g === null ? "" : g.mark}</span>` +
    `<span class="nm"><span class="t">${esc(userText(c.name))}</span>${notes.length > 0 ? `<span class="sub quiet">${notes.join(" &middot; ")}</span>` : ""}</span>` +
    `<span class="ag"><span class="dot" style="background:${dotColor(c.host)}"></span>${esc(c.hostLabel)}${folder}</span>` +
    `<span class="fl">${esc(count(c.credited))} ${c.credited === 1 ? "file" : "files"}</span>` +
    `<span class="tm">${when}</span>` +
    `</a>`
  );
}

/** A session whose tracking is on but that has no listed task yet: nothing recorded, so no review page to link; it is told plainly. */
export interface StartedSession {
  host: string;
  folder?: string;
}

const startedName = (s: StartedSession): Shown => {
  const folder = s.folder === undefined ? "" : s.folder.replace(/\\/g, "/").split("/").filter((x) => x !== "").pop() ?? "";
  return userText(folder === "" ? (findProfile(s.host)?.fullName ?? hostName(s.host)) : folder);
};

/** Tracking sessions with nothing recorded, in one line: "Tracking in a and 2 more, nothing recorded yet". */
function startedLine(started: readonly StartedSession[]): string {
  if (started.length === 0) return "";
  const rest = started.length - 1;
  return `<p class="started quiet">Tracking in ${esc(startedName(started[0]!))}${rest > 0 ? ` and ${esc(count(rest))} more` : ""}, nothing recorded yet</p>`;
}

// The review page's tokens (designTokensCss), so both pages share one type, colour and surface system and one typeface token.
const HOME_CSS = `
body{font:var(--fs-body)/var(--lh-body) var(--font);color:var(--ink);background:var(--canvas);font-variant-numeric:tabular-nums}
.home{--ink-mute:var(--ink-2);max-width:960px;margin:0 auto;padding:var(--s6) var(--s5)}
.home .quiet{color:var(--ink-mute)}
.home h1{font-size:var(--fs-display);line-height:var(--lh-display);font-weight:var(--w-semi);letter-spacing:-.02em;margin:0 0 var(--s2)}
.home .started{margin:0 0 var(--s4)}
.home h3{font-size:var(--fs-cap);line-height:var(--lh-cap);font-weight:var(--w-semi);color:var(--ink-mute);margin:var(--s5) 0 var(--s1);padding:0 var(--s3)}
.home .list{border-top:1px solid var(--hairline)}
.home .row{display:grid;grid-template-columns:16px minmax(0,1fr) minmax(0,220px) 72px 168px;align-items:center;column-gap:var(--s3);min-height:36px;padding:var(--s1) var(--s3);border-bottom:1px solid var(--hairline);color:var(--ink);text-decoration:none}
.home .row:hover{background:var(--surface)}
.home .nm{display:flex;flex-direction:column;min-width:0}.home .t{font-weight:var(--w-med);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.home .sub{font-size:var(--fs-cap);line-height:var(--lh-cap);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.home .ag{color:var(--ink-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.home .fl{color:var(--ink-mute);text-align:right;white-space:nowrap}.home .tm{color:var(--ink-mute);text-align:right;white-space:nowrap}
.home .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.home .gl{text-align:center;font-size:var(--fs-body);line-height:var(--lh-body)}.home .gl.rev{color:var(--before)}.home .gl.ok{color:var(--pass)}.home .gl.exp{color:var(--ink-mute)}
@media (max-width:640px){.home .row{grid-template-columns:16px minmax(0,1fr) 72px}.home .ag,.home .tm{display:none}}
`;

/**
 * The whole home document: one dense row per task, newest first, under "Today" and "Earlier". Sessions that are tracking but have recorded
 * nothing are one line. With no task at all the page says so (and how to start).
 */
export function renderHome(ledger: Ledger, token: string, sessions: readonly HomeSession[], roots: TitleRoots = {}, started: readonly StartedSession[] = []): string {
  const newest = (a: HomeSession, b: HomeSession) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id);
  const sorted = [...sessions].sort(newest);
  // Waiting, as the review list always counted it: not signed off (or work since) and not expired. When none is unreviewed, say how many still wait.
  const waiting = sorted.filter((s) => s.standing === "unreviewed" || s.standing === "reviewed").length;
  const unreviewed = sorted.some((s) => s.standing === "unreviewed");
  const idle = sorted.length === 0 ? "No sessions yet. Sessions start untracked: tell the agent \"start tracking\" in a session to begin." : waiting === 0 ? "Nothing is waiting for review." : esc(words`${plural(waiting, words`session`, words`sessions`)} marked but not signed off yet.`);
  const head = sorted.length === 0 ? `<h1>${started.length > 0 ? "Nothing recorded yet" : idle}</h1>` : `<h1>Sessions</h1>${unreviewed ? "" : `<p class="quiet">${idle}</p>`}`;
  const today = new Date().toDateString();
  const isToday = (s: HomeSession): boolean => s.ts !== "" && new Date(s.ts).toDateString() === today;
  const group = (title: string, list: readonly HomeSession[]): string =>
    list.length === 0 ? "" : `<h3>${title}</h3><div class="list">${list.map((s) => rowHtml(cardOf(ledger, s, roots), token)).join("")}</div>`;
  const rows = group("Today", sorted.filter(isToday)) + group("Earlier", sorted.filter((s) => !isToday(s)));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CoCheck review</title><style>${designTokensCss()}${HOME_CSS}</style></head><body><div class="home">${head}${startedLine(started)}${rows}</div></body></html>`;
}
