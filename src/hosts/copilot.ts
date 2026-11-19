// GitHub Copilot CLI and VS Code agent mode (one profile: both run the same hooks and payloads). Its facts (platforms/copilot-cli/, recorded on 1.0.93 and 1.0.98;
// platforms/copilot-vscode/, 1.140.0): camelCase event names that the payload does not carry (the
// hook command names the event); no call id on hook stdin, but the session's events.jsonl lists each tool request with its id, name and
// arguments, and a commentary `assistant.message` holds the words before the call; one CoCheck-owned file in `$COPILOT_HOME/hooks/`.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { CLOSING_MAX, NARRATION_MAX, cut, remember, type NarrationCursor } from "../narration.ts";
import { platform, type Platform } from "../platform/index.ts";
import { copilotSessionTitle } from "./session-titles.ts";
import { SHARED_FIELDS, type EventKind, type FailureRead, type HostProfile } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_LINE = /"type"\s*:\s*"(?:assistant|user)\.message"/;

/**
 * A prompt that is the host's own system notice, not the person's words ("Agent x has finished processing and is now idle").
 * Bound (a heuristic): the whole trimmed prompt is exactly one `<system_notification>...</system_notification>` element. The match is on the
 * wrapper only, never on the English inside. Anything else, including a prompt that quotes or contains such text, is a user prompt.
 */
const SYSTEM_NOTIFICATION = /^<system_notification>(?:(?!<\/?system_notification>)[\s\S])*<\/system_notification>$/;
const isSystemNotification = (prompt: unknown): boolean => typeof prompt === "string" && SYSTEM_NOTIFICATION.test(prompt.trim());

/** The arguments with keys sorted at every level, so equal arguments make equal text whatever order a host listed them in. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  }
  return value;
}

const argsKey = (toolInput: unknown): string => createHash("sha256").update(JSON.stringify(stable(toolInput ?? null))).digest("hex").slice(0, 16);

/** One line of a session's events.jsonl. Only assistant and user messages are parsed. */
function copilotLine(cur: NarrationCursor, line: string): void {
  if (!MESSAGE_LINE.test(line)) return;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const data = d?.data;
  if (data === null || typeof data !== "object") return;
  if (d.type === "user.message") {
    // A user.message with a `source` (a helper's task prompt, "agent-<session>") is not a new turn of the main line.
    if (typeof data.source !== "string") cur.closing = undefined;
    return;
  }
  if (d.type !== "assistant.message") return;
  const content = typeof data.content === "string" ? data.content : "";
  if (data.phase === "final_answer") {
    // A helper's final answer (it names the task call that launched it) lands in the same file; the closing is the main agent's.
    if (typeof data.parentToolCallId === "string" && data.parentToolCallId !== "") return;
    if (content.trim() !== "") cur.closing = cut(content, CLOSING_MAX);
    return;
  }
  if (data.phase !== "commentary" || !Array.isArray(data.toolRequests)) return;
  const text = cut(content, NARRATION_MAX);
  for (const req of data.toolRequests) {
    if (req === null || typeof req !== "object" || typeof req.toolCallId !== "string" || typeof req.name !== "string") continue;
    const reason = typeof req.intentionSummary === "string" && req.intentionSummary.trim() !== "" ? cut(req.intentionSummary, NARRATION_MAX) : undefined;
    const held = cur.byId[req.toolCallId];
    remember(cur, req.toolCallId, {
      text,
      ...(reason === undefined ? {} : { reason }),
      call: { name: req.name, argsKey: argsKey(parseArgs(req.arguments)) },
      // A line read again (the file was rotated) must not free a request a Pre already claimed.
      ...(held !== undefined && "taken" in held && held.taken === true ? { taken: true as const } : {}),
    });
  }
}

/** Tool arguments as an object: JSON text that holds an object is parsed; anything else passes through. */
function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    // A JSON-encoded string (a patch sent as text inside quotes) is the text itself; any other scalar stays as sent.
    return parsed !== null && typeof parsed === "object" ? parsed : typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/** `<root>/<session>/events.jsonl`; `root` defaults to `$COPILOT_HOME/session-state`. Only a full uuid names a session folder. */
function locateEvents(session: string, _now: number, root?: string): string | undefined {
  if (!UUID.test(session)) return undefined;
  if (root === undefined && !process.env.COPILOT_HOME && process.env.NODE_TEST_CONTEXT) {
    throw new Error("COPILOT_HOME is unset under the test runner; refusing to fall back to the real ~/.copilot/session-state");
  }
  const base = root ?? path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state");
  return path.join(base, session, "events.jsonl");
}

/** `<shellId: N completed with exit code K>`, the only place a failed shell command shows (it arrives as postToolUse success). The last marker wins. */
const SHELL_EXIT = /<shellId:\s*[^>]*?completed with exit code (-?\d+)>/g;

/** The failure a postToolUse reports through its text: a shell exit code other than 0. No marker (or a marker of 0) is not a failure read; a missing marker is unknown, never success. */
function shellFailure(p: Record<string, unknown>): FailureRead {
  const result = p.toolResult;
  const text = result !== null && typeof result === "object" && typeof (result as { textResultForLlm?: unknown }).textResultForLlm === "string" ? (result as { textResultForLlm: string }).textResultForLlm : "";
  const codes = [...text.matchAll(SHELL_EXIT)];
  const code = codes.length === 0 ? undefined : Number(codes[codes.length - 1]![1]);
  return code === undefined || code === 0 ? undefined : { raw: text, interrupted: false };
}

/**
 * True when a hook run carries a Copilot payload under a registration meant for another host: Copilot loads a repo's
 * `.claude/settings.json` hooks too (platforms/discrepancies.json copilot-reads-claude-repo-settings), and sends them its own
 * snake_case payload (an ISO `timestamp`, never Claude Code's `permission_mode` or `tool_use_id`, nor Codex's `turn_id`). Such a run would
 * record each Copilot call a second time under another host, so the hook records nothing for it; the copilot entry records.
 * The payload's shape alone decides. The environment never does: Copilot exports its variables to every child, so a real
 * Claude Code or Codex run started from a Copilot-launched shell carries them too.
 */
export function copilotRunsOtherHostsHook(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return p.timestamp !== undefined && typeof p.hook_event_name === "string" && p.permission_mode === undefined && p.tool_use_id === undefined && p.turn_id === undefined;
}

const copilotEvents = ["userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "subagentStop"] as const;
/** preToolUse is the one event where a non-zero exit blocks the person's tool call (recorded in capabilities.json), so its entry always exits 0. */
const failOpen = (event: string) => (event === "preToolUse" ? " || true" : "");

interface HooksFile {
  version?: unknown;
  hooks?: Record<string, Array<{ bash?: unknown; powershell?: unknown }>>;
}

function parse(text: string): HooksFile | undefined {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as HooksFile) : undefined;
  } catch {
    return undefined;
  }
}

// Windows entries are in `powershell`, macOS entries in `bash`; either field counts, so an uninstall finds both shapes.
const entryIsOurs = (e: { bash?: unknown; powershell?: unknown }, plat: Platform): boolean => [e?.bash, e?.powershell].some((c) => typeof c === "string" && (plat.hookCommand.isMarked(c) || platform().hookCommand.isMarked(c)));
const eventsWithOurs = (text: string, plat: Platform): string[] => {
  const hooks = parse(text)?.hooks;
  if (hooks === undefined || hooks === null || typeof hooks !== "object") return [];
  return Object.entries(hooks).filter(([, list]) => Array.isArray(list) && list.some((e) => entryIsOurs(e, plat))).map(([event]) => event);
};

export const copilot: HostProfile = {
  key: "copilot",
  displayName: "Copilot",
  chip: "P",
  testedVersions: ["1.0.93", "1.0.98", "1.140.0"],
  eventFromArg: true,
  eventKinds: {
    userPromptSubmitted: "prompt",
    // Seen in the recording; nothing to record from them.
    sessionStart: "other",
    sessionEnd: "other",
    preToolUse: "tool-pre",
    postToolUse: "tool-post",
    postToolUseFailure: "tool-failure",
    agentStop: "stop",
    // A helper's finish (1.0.98 and 1.140.0 both send it, with agentId and agentType, in the main session's id). subagentStart carries
    // nothing the helper's first call does not (VS Code sends it no id at all), so it is seen and not installed.
    subagentStart: "other",
    subagentStop: "subagent-stop",
    userPromptTransformed: "other",
    permissionRequest: "other",
    notification: "other",
  } satisfies Record<string, EventKind>,
  // Documented, never seen in a recording: not mapped, not installed.
  unverifiedEvents: ["errorOccurred", "preCompact"],
  // postToolUseFailure is documented, not recorded: a call that closes with no failure event is not assumed to have succeeded.
  capabilities: { failureEvent: false, argvTag: false, helperSessions: true, launchKey: true, readsForeignHooks: true },
  // The CLI marks every call inside a helper with agentId, agentType and parentAgentId (the main session); the helper's own sessionId
  // is its agentId, so the event belongs to the parent. VS Code sends none of the three (src/copilot-helpers.ts links those).
  fields: { ...SHARED_FIELDS, eventName: "hook_event_name", session: "sessionId", parentSession: "parentAgentId", toolName: "toolName", toolInput: "toolArgs", toolResponse: "toolResult", toolUseId: "toolCallId", agentId: "agentId", agentType: "agentType", transcriptPath: "transcriptPath", lastAssistantMessage: "response" },
  // A helper's own prompt (the task's prompt text) and its own agentStop are not the person's request nor the main agent's stop: the helper's
  // finish is the subagentStop. Only an event that names an agent is changed.
  // Nor is a host system notification a request (see isSystemNotification).
  refineKind: (kind, p) => ((kind === "prompt" || kind === "stop") && typeof p.agentId === "string" && p.agentId !== "" ? "other" : kind === "prompt" && isSystemNotification(p.prompt) ? "other" : kind),
  failureOf: (kind, p): FailureRead => (kind === "tool-failure" ? { raw: typeof p.error === "string" ? p.error : "", interrupted: false } : kind === "tool-post" ? shellFailure(p) : undefined),
  extraOf: (p) => (typeof p.stop_hook_active === "boolean" ? { stopHookActive: p.stop_hook_active } : {}),
  parseToolInput: parseArgs,
  calls: { argsKey, syntheticId: (session, n) => `copilot-${session}-${n}` },
  narration: {
    // The commentary reaches events.jsonl a few ms before the Pre (recorded); whether it is flushed before the Pre command runs is untested, so a Post reads again.
    sources: [
      { kind: "commentary-before-call", readableAt: "pre", reason: true },
      { kind: "closing-message", readableAt: "post" },
    ],
    foldLine: copilotLine,
    closing: (cur) => cur?.closing ?? "",
    // Live 1.0.93: the final_answer line carries a timestamp 2 ms before agentStop but was not in the file when the hook ran.
    closingWaitMs: 1000,
  },
  sessionTitle: copilotSessionTitle,
  sessionFile: { bySessionId: true, locate: locateEvents },
  install: {
    skillRoot: path.join(".copilot", "skills"),
    hostFlag: "copilot",
    folderFromPayloadCwd: true,
    ownsFile: true,
    // Copilot's hook output is JSON for some events and userPromptSubmitted has no output channel for context (platforms/copilot-cli/capabilities.json):
    // print nothing. The "save in the folder" words reach Copilot through the cocheck skill, which `cocheck install` writes to ~/.copilot/skills.
    promptContext: false,
    events: copilotEvents,
    configFile: (env, userHome) => path.join(env.COPILOT_HOME || path.join(userHome, ".copilot"), "hooks", "cocheck.json"),
    addHooks: (_text, _file, spec, plat = platform()) => {
      const command = spec === undefined ? "" : plat.hookCommand.build(spec);
      const hooks: Record<string, unknown[]> = {};
      // Choice: on Windows only `powershell` is written, not `bash` as well: Copilot runs `powershell` there, and a `bash` twin would
      // fire the hook twice for a Git Bash setup that reads both. PowerShell 5.1 has no `||`, so the fail-open is `; exit 0`.
      const windows = plat.shellDialect.kind === "cmd";
      for (const event of copilotEvents) {
        const line = `${command} --event ${event}${windows ? (event === "preToolUse" ? "; exit 0" : "") : failOpen(event)}`;
        hooks[event] = [windows ? { type: "command", powershell: line, timeoutSec: 30 } : { type: "command", bash: line, timeoutSec: 30 }];
      }
      return JSON.stringify({ version: 1, hooks }, null, 2) + "\n";
    },
    // The file is CoCheck's alone: it goes whole, but only when it carries CoCheck's marker (a file of the same name that is not ours stays).
    removeHooks: (text, _file, plat = platform()) => (eventsWithOurs(text, plat).length > 0 ? { text: "", changed: true } : { text, changed: false }),
    missingEvents: (text, _file, plat = platform()) => {
      const have = new Set(eventsWithOurs(text, plat));
      return copilotEvents.filter((e) => !have.has(e));
    },
    checkPayload: (folder) => ({ payload: { sessionId: "install-check", cwd: folder, toolName: "bash", toolArgs: { command: "true" } }, event: "preToolUse" }),
    notes: ({ launcherDir, home }) =>
      `If you turn on Copilot's sandbox (copilot --sandbox, or /sandbox enable), its hooks stop working unless settings.json grants them access: add ${launcherDir} and ${home} to sandbox.userPolicy.filesystem.readwritePaths. CoCheck does not edit your Copilot settings.`,
    afterInstall: "Copilot trust step for user-level hooks: unverified. Repo hooks need a trusted folder; whether hooks in ~/.copilot/hooks ask for trust too is not known yet. If Copilot asks, trust them once, or CoCheck records nothing from it.",
  },
  shape: {
    preToolUse: ["sessionId", "cwd", "toolName", "toolArgs"],
    postToolUse: ["sessionId", "cwd", "toolName", "toolArgs", "toolResult"],
    postToolUseFailure: ["sessionId", "cwd", "toolName", "toolArgs", "error"],
    agentStop: ["sessionId", "cwd", "transcriptPath"],
    userPromptSubmitted: ["sessionId", "cwd", "prompt"],
  },
};
