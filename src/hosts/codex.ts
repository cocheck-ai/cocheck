// Codex. Its facts: no failure event (a failed call arrives as a Post); the call's words are in the rollout, found by session id under
// ~/.codex/sessions; a tool call's hook `tool_use_id` equals the rollout's CommandExecution `id`; a subagent's words are in its own rollout, named by its thread id; no helper records, no settings install yet.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { addCoCheckHooks, inlineHooksProblem, missingCoCheckEvents, removeCoCheckHooks } from "../codex-config.ts";
import { CLOSING_MAX, NARRATION_MAX, cut, joined, remember, type NarrationCursor } from "../narration.ts";
import { platform } from "../platform/index.ts";
import { claudeShapeExtra, claudeShapeFailure } from "./shared.ts";
import { codexTrustProblem } from "./codex-trust.ts";
import { codexSessionTitle } from "./session-titles.ts";
import { SHARED_EVENT_KINDS, SHARED_FIELDS, type HostProfile } from "./types.ts";

const CODEX_LINE = /"(?:AgentMessage|CommandExecution|UserMessage|task_started)"/;

/** One line of a Codex rollout. Only the four item kinds above are parsed; a UserMessage is parsed for its kind and never read. */
function codexLine(cur: NarrationCursor, line: string): void {
  if (!CODEX_LINE.test(line)) return;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const p = d?.payload;
  if (d?.type !== "event_msg" || p === null || typeof p !== "object") return;
  if (p.type === "task_started") {
    cur.pending = [];
    cur.closing = undefined;
    return;
  }
  const item = p.type === "item_completed" ? p.item : undefined;
  if (item === null || typeof item !== "object") return;
  if (item.type === "UserMessage") {
    cur.pending = [];
    cur.closing = undefined;
  } else if (item.type === "AgentMessage") {
    const text = Array.isArray(item.content) ? item.content.map((c: any) => (c && typeof c.text === "string" ? c.text : "")).filter((t: string) => t.trim() !== "").join("\n\n") : "";
    if (text === "") return;
    if (item.phase === "final_answer") {
      cur.closing = cut(text, CLOSING_MAX);
      cur.pending = [];
    } else cur.pending.push(text);
  } else if (item.type === "CommandExecution" && typeof item.id === "string") {
    const text = joined(cur.pending, NARRATION_MAX);
    cur.pending = [];
    if (text !== "") remember(cur, item.id, { text });
  }
}

// A Codex reply can end with `:codex-file-citation{path="/abs/File.csv" purpose="output"}`, a directive Codex's own UI renders as a file chip.
// Shown text replaces each with the path's base name (nothing when the path is missing or a `<placeholder>`); attributes are never shown.
// Display only: the ledger keeps the host's words. Only this exact directive name followed by a brace group of `key="value"` pairs matches.
const CITATION = /:codex-file-citation\{((?:\s*[A-Za-z_][\w-]*="(?:[^"\\]|\\.)*")*)\s*\}/g;
const CITATION_PATH = /(?:^|\s)path="((?:[^"\\]|\\.)*)"/;
function codexDisplayText(text: string): string {
  if (!text.includes(":codex-file-citation{")) return text;
  const out = text.replace(CITATION, (_m, attrs: string) => {
    const raw = CITATION_PATH.exec(attrs)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
    if (raw.trim() === "" || /^<.*>$/s.test(raw.trim())) return "";
    return raw.split(/[\\/]/).filter((x) => x !== "").pop() ?? "";
  });
  return out === text ? text : out.replace(/[ \t]+(?=\n|$)/g, "").trimEnd();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The rollout named by a thread id: today's folder and the two days before it, matched on the whole name with a full uuid, never on a suffix a longer id could share. */
function locateRollout(thread: string, now: number, root?: string): string | undefined {
  if (!UUID.test(thread)) return undefined;
  const rollout = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${thread}\\.jsonl$`, "i");
  const base = root ?? path.join(homedir(), ".codex", "sessions");
  const two = (n: number) => String(n).padStart(2, "0");
  for (let back = 0; back < 3; back++) {
    const day = new Date(now - back * 86_400_000);
    const dir = path.join(base, String(day.getFullYear()), two(day.getMonth() + 1), two(day.getDate()));
    try {
      const name = readdirSync(dir).find((f) => rollout.test(f));
      if (name !== undefined) return path.join(dir, name);
    } catch {
      // no such day
    }
  }
  return undefined;
}

const HEADER_MAX = 512 * 1024;

/** The `session_meta` payload on a rollout's first line; undefined when the line is missing, too long or not that. */
function rolloutHeader(file: string): { id?: unknown; session_id?: unknown; parent_thread_id?: unknown } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEADER_MAX);
    const n = readSync(fd, buf, 0, HEADER_MAX, 0);
    const end = buf.subarray(0, n).indexOf(10);
    if (end < 0 && n === HEADER_MAX) return undefined;
    const d = JSON.parse(buf.subarray(0, end < 0 ? n : end).toString("utf8"));
    return d?.type === "session_meta" && d.payload !== null && typeof d.payload === "object" ? d.payload : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A subagent writes its own rollout, named by its own thread id (the hook's `agent_id`). The file is used only when its header names
 * that thread and the calling session as its parent or root, so a helper never reads the parent's file or another helper's.
 */
function locateHelperRollout(session: string, agent: string, now: number, root?: string): string | undefined {
  if (!UUID.test(session) || agent.toLowerCase() === session.toLowerCase()) return undefined;
  const file = locateRollout(agent, now, root);
  if (file === undefined) return undefined;
  const h = rolloutHeader(file);
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  if (h === undefined || !same(h.id, agent)) return undefined;
  return same(h.session_id, session) || same(h.parent_thread_id, session) ? file : undefined;
}

// SessionStart, SubagentStart and SubagentStop fired in the 0.164.0-alpha.11.1 probe. SessionStart and SubagentStart record nothing (kind "other");
// SubagentStop closes a helper with its last message. No hook of CoCheck's ever prints a decision, so none can block or alter a Codex call.
/** Most bytes of one rollout read for call words; the same cap as a Claude agent transcript (AGENT_TRANSCRIPT_MAX_BYTES in agent-transcripts.ts). */
const ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;
/** Most characters kept per call: its command and the start of its output. */
const CALL_TEXT_MAX = 8000;
/** A CommandExecution item that failed: its exit code (null when it recorded none) and the start of its output. */
type CallExit = { exitCode: number | null; output: string };
const callTextCache = new Map<string, { key: string; texts: Map<string, string>; exits: Map<string, CallExit> }>();

/**
 * The words of each call in a rollout, by the call's id: a `CommandExecution` item's command and aggregated output (its id equals the
 * hook's `tool_use_id`). Read whole once per file state. Nothing else in the file is kept.
 * Bound: a call whose command and output do not name a file gives the credit no evidence about that file.
 */
function rolloutCallText(file: string): ReadonlyMap<string, string> | undefined {
  return rolloutCalls(file)?.texts;
}

/**
 * The calls of a rollout that failed, by the call's id (the hook's `tool_use_id`): a `CommandExecution` item whose `exit_code` is a
 * nonzero number, or whose `status` is "failed" with no exit code. An item with exit code 0, or neither field, is not listed.
 * Bound: only a call whose item is already in the file is seen; the item is written just before the call's PostToolUse.
 */
function rolloutCallExits(file: string): ReadonlyMap<string, CallExit> | undefined {
  return rolloutCalls(file)?.exits;
}

function rolloutCalls(file: string): { texts: Map<string, string>; exits: Map<string, CallExit> } | undefined {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > ROLLOUT_MAX_BYTES) return undefined;
    const key = `${st.size}:${st.mtimeMs}`;
    const held = callTextCache.get(file);
    if (held?.key === key) return held;
    const texts = new Map<string, string>();
    const exits = new Map<string, CallExit>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"CommandExecution"')) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const item = d?.payload?.item;
      if (d?.payload?.type !== "item_completed" || item?.type !== "CommandExecution" || typeof item.id !== "string") continue;
      const cmd = Array.isArray(item.command) ? item.command.filter((x: unknown) => typeof x === "string").join(" ") : "";
      const out = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      texts.set(item.id, `${cmd}\n${out}`.slice(0, CALL_TEXT_MAX));
      const code = typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? item.exit_code : null;
      if (code === null ? item.status === "failed" : code !== 0) exits.set(item.id, { exitCode: code, output: out.slice(0, 500) });
    }
    if (callTextCache.size >= 64) callTextCache.delete(callTextCache.keys().next().value!);
    const entry = { key, texts, exits };
    callTextCache.set(file, entry);
    return entry;
  } catch {
    return undefined;
  }
}

const refusedCache = new Map<string, { key: string; refused: Array<{ command?: string; at: number }> }>();
/** Rust Debug string escapes, undone once: `\\n` newline, `\\"` quote, `\\\\` backslash. */
const unRustEscape = (s: string): string => s.replace(/\\(.)/gs, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
// `exec_command failed: CreateProcess { message: "Rejected(\"`<shell> -lc '<command>'` rejected: <reason>\")" }`; the command is escaped twice
const REFUSAL = /exec_command failed: CreateProcess \{ message: "Rejected\(\\"`(.*?)` rejected: /s;
// A rejection that quotes no command (policy text only, as on Windows: `Rejected("approval required by policy, ...")`); only when no quoted command is in the text
const REFUSAL_UNQUOTED = /exec_command failed: CreateProcess \{ message: "Rejected\(\\"(?!`)(?!.*` rejected: )/s;
const SHELL_WRAP = /^\S*\/(?:zsh|bash|sh) -l?c '(.*)'$/s;

/**
 * The commands the host refused to start (a policy rejection), from the `exec_command failed ... Rejected(...)` text in a tool output,
 * with the line's time. The refused command has no completed item and its id appears nowhere in the rollout, so the quoted text is the only
 * evidence. A command that returned early (`yield_time_ms`) prints no such text. Read whole once per file state.
 * A rejection that quotes no command is listed with no `command`: the caller matches it by position. Bound: a command whose quote does
 * not unwrap to a shell wrapper and one single-quoted body is skipped.
 */
function rolloutRefusedCommands(file: string): Array<{ command?: string; at: number }> | undefined {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > ROLLOUT_MAX_BYTES) return undefined;
    const key = `${st.size}:${st.mtimeMs}`;
    const held = refusedCache.get(file);
    if (held?.key === key) return held.refused;
    const refused: Array<{ command?: string; at: number }> = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("Rejected(")) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const out = d?.payload?.output;
      const texts: unknown[] = Array.isArray(out) ? out.map((o: any) => o?.text) : [out];
      const at = Date.parse(d?.timestamp);
      for (const t of texts) {
        const quoted = typeof t === "string" ? REFUSAL.exec(t)?.[1] : undefined;
        const body = quoted === undefined ? undefined : SHELL_WRAP.exec(unRustEscape(unRustEscape(quoted)))?.[1];
        if (body !== undefined && Number.isFinite(at)) refused.push({ command: body.replace(/'\\''/g, "'"), at });
        else if (quoted === undefined && typeof t === "string" && Number.isFinite(at) && REFUSAL_UNQUOTED.test(t)) refused.push({ at });
      }
    }
    if (refusedCache.size >= 64) refusedCache.delete(refusedCache.keys().next().value!);
    refusedCache.set(file, { key, refused });
    return refused;
  } catch {
    return undefined;
  }
}

const codexEvents = ["SessionStart", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "UserPromptSubmit"] as const;

// A failed Bash call arrives as PostToolUse with the bare output as `tool_response` and no exit code (discrepancies.json codex-posttooluse-no-exit-code).
// Inferred as failed only when every non-empty output line is a shell error line; any other output, and empty output, reads as no failure.
const SHELL_ERROR_LINE = /^[^\s:][^\n]*: (?:.*: )?(?:No such file or directory|Permission denied|command not found|Not a directory|Is a directory|Operation not permitted)$/;
function codexFailure(kind: Parameters<typeof claudeShapeFailure>[0], p: Record<string, unknown>) {
  const known = claudeShapeFailure(kind, p);
  if (known !== undefined || kind !== "tool-post" || typeof p.tool_response !== "string") return known;
  const lines = p.tool_response.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.length > 0 && lines.every((l) => SHELL_ERROR_LINE.test(l)) ? { raw: lines.join("\n"), interrupted: false, inferred: true as const } : undefined;
}

export const codex: HostProfile = {
  key: "codex",
  displayName: "Codex",
  chip: "C",
  testedVersions: ["0.162.0-alpha.2", "0.164.0-alpha.11.1"],
  eventKinds: SHARED_EVENT_KINDS,
  capabilities: { failureEvent: false, argvTag: false, helperSessions: false, launchKey: false, readsForeignHooks: false },
  fields: { ...SHARED_FIELDS },
  failureOf: codexFailure,
  displayText: codexDisplayText,
  extraOf: claudeShapeExtra,
  narration: {
    // Codex writes the commentary to the rollout before the call runs but binds it to a call only when the call's item completes: the Pre claims it, the Post reads the bound one when the Pre found none.
    sources: [
      { kind: "commentary-before-call", readableAt: "pre", reason: true },
      { kind: "closing-message", readableAt: "post" },
    ],
    foldLine: codexLine,
    claimAtPre(cur, id) {
      const text = joined(cur.pending, NARRATION_MAX);
      cur.pending = [];
      if (text !== "") remember(cur, id, { text });
    },
    closing: (cur) => cur?.closing ?? "",
  },
  sessionTitle: codexSessionTitle,
  sessionFile: { bySessionId: true, locate: locateRollout, locateHelper: locateHelperRollout, callText: rolloutCallText, callExit: rolloutCallExits, refusedCommands: rolloutRefusedCommands },
  install: {
    skillRoot: path.join(".agents", "skills"),
    inBothAlias: true,
    reusesRecord: true,
    hostFlag: "codex",
    // Codex sets no project-folder variable; its payload carries the folder as `cwd`.
    folderFromPayloadCwd: true,
    // The events that fired in the probe run and that the adapter acts on; Codex sends no failure event.
    events: codexEvents,
    configFile: (env, userHome) => path.join(env.CODEX_HOME || path.join(userHome, ".codex"), "config.toml"),
    addHooks: (text, file, spec, plat = platform()) => {
      const problem = inlineHooksProblem(text);
      if (problem !== undefined) {
        throw new Error(`${file} already has ${problem} for hooks, and CoCheck's [[hooks.X]] entries would make the file invalid. Nothing was changed. Move your hooks to [[hooks.X]] tables, then run the installer again`);
      }
      const command = spec === undefined ? "" : plat.hookCommand.build(spec);
      return addCoCheckHooks(removeCoCheckHooks(text).toml, { command: () => command, events: [...codexEvents] }).toml;
    },
    removeHooks: (text) => {
      const r = removeCoCheckHooks(text);
      return { text: r.toml, changed: r.changed };
    },
    missingEvents: (text) => missingCoCheckEvents(text, codexEvents),
    trustProblem: (configFile, env, hookPath, read) => {
      if (read === undefined) return undefined;
      const result = read(path.dirname(configFile), env);
      return result === undefined ? undefined : codexTrustProblem(result, hookPath);
    },
    afterInstall: "Codex asks you to trust new hooks before they run: open Codex and trust the new hooks in Codex once, or CoCheck records nothing from it.",
  },
  shape: {
    SessionStart: ["session_id"],
    SubagentStart: ["session_id", "agent_id"],
    SubagentStop: ["session_id", "agent_id"],
    PreToolUse: ["session_id", "tool_name", "tool_use_id", "tool_input"],
    PostToolUse: ["session_id", "tool_name", "tool_use_id", "tool_input", "tool_response"],
    Stop: ["session_id"],
    UserPromptSubmit: ["session_id", "prompt"],
  },
};
