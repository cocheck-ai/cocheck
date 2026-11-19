// Claude Code. Its facts: the assistant text before a call is in the transcript at the call's Pre; a failed call sends its own event;
// helpers keep a transcript and a meta file beside the session's; settings live in ~/.claude/settings.json.
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import readline from "node:readline";
import path from "node:path";
import { readClaudeCalls } from "../coverage.ts";
import { CLOSING_MAX, NARRATION_MAX, joined, remember, type NarrationCursor } from "../narration.ts";
import { platform, type Platform } from "../platform/index.ts";
import { claudeShapeExtra, claudeShapeFailure } from "./shared.ts";
import { claudeSessionTitle } from "./session-titles.ts";
import { SHARED_EVENT_KINDS, SHARED_FIELDS, type HostProfile } from "./types.ts";

const ASSISTANT_LINE = /"type"\s*:\s*"assistant"/;
const USER_LINE = /"type"\s*:\s*"user"/;

/** One line of a Claude Code transcript. Only assistant lines are parsed. */
function claudeLine(cur: NarrationCursor, line: string): void {
  if (!ASSISTANT_LINE.test(line)) {
    // A user line that is not a tool result starts a new turn: text before it was the last turn's closing words.
    if (USER_LINE.test(line) && !line.includes('"tool_result"')) {
      cur.pending = [];
      cur.msg = undefined;
    }
    return;
  }
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  if (d === null || typeof d !== "object" || d.type !== "assistant" || (d.isSidechain === true && cur.agent !== true)) return;
  const content = d.message?.content;
  if (!Array.isArray(content)) return;
  const msgId = typeof d.message?.id === "string" ? d.message.id : undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim() !== "") cur.pending.push(block.text);
    } else if (block.type === "tool_use" && typeof block.id === "string") {
      const same = cur.msg;
      if (msgId !== undefined && same !== undefined && same.id === msgId) {
        // A parallel call: the first call of the message holds the words, this one points to it.
        if (same.first !== null) remember(cur, block.id, { sameAs: same.first });
        continue;
      }
      const text = joined(cur.pending, NARRATION_MAX);
      cur.pending = [];
      if (text !== "") remember(cur, block.id, { text });
      cur.msg = msgId === undefined ? undefined : { id: msgId, first: text === "" ? null : block.id };
    }
  }
}

class SettingsRefusal extends Error {}

type Json = Record<string, any>;

/** Parses the settings text. An empty file is an empty object. Anything that is not a settings object with sane hooks is refused untouched. */
function parseSettings(text: string, file: string): Json {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SettingsRefusal(`${file} is not valid JSON; nothing was changed`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SettingsRefusal(`${file} is not a JSON object; nothing was changed`);
  const hooks = (value as Json).hooks;
  if (hooks !== undefined) {
    if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) throw new SettingsRefusal(`${file}: "hooks" is not an object; nothing was changed`);
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) throw new SettingsRefusal(`${file}: hooks.${event} is not an array; nothing was changed`);
    }
  }
  return value as Json;
}

// Which entries are CoCheck's is decided by the platform's hook command parser, which matches the shape CoCheck writes whole (launcher form,
// with the Homebrew COCHECK_NODE when present). An entry that merely contains the marker text is the user's own and is never matched.
const WITH_MATCHER = new Set<string>(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const isManaged = (hook: any, plat: Platform) => typeof hook?.command === "string" && plat.hookCommand.parse(hook.command)?.host === "claude";

/** Removes every CoCheck entry. Groups, events and `hooks` that this empties are dropped; ones the user left empty are not touched. Returns whether anything went. */
function removeManaged(settings: Json, plat: Platform = platform()): boolean {
  const hooks = settings.hooks;
  if (hooks === undefined) return false;
  let removed = false;
  for (const event of Object.keys(hooks)) {
    const kept: any[] = [];
    let touched = false;
    for (const group of hooks[event]) {
      if (!Array.isArray(group?.hooks) || !group.hooks.some((h: any) => isManaged(h, plat))) {
        kept.push(group);
        continue;
      }
      removed = touched = true;
      const rest = group.hooks.filter((h: any) => !isManaged(h, plat));
      if (rest.length > 0) kept.push({ ...group, hooks: rest });
    }
    if (touched) {
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
  }
  if (removed && Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

/** SessionStart sets the attribution write hooks' environment for the session's Bash calls (CLAUDE_ENV_FILE); it records nothing. */
export const CLAUDE_EXTRA_EVENTS: readonly string[] = ["SessionStart"];

function addManaged(settings: Json, command: string): void {
  settings.hooks ??= {};
  for (const event of [...Object.keys(SHARED_EVENT_KINDS), ...CLAUDE_EXTRA_EVENTS]) {
    const group: Json = WITH_MATCHER.has(event) ? { matcher: "*" } : {};
    group.hooks = [{ type: "command", command }];
    (settings.hooks[event] ??= []).push(group);
  }
}

const claudeText = (settings: Json) => JSON.stringify(settings, null, 2) + "\n";
const hasManaged = (settings: Json, event: string, plat: Platform = platform()) => Array.isArray(settings.hooks?.[event]) && settings.hooks[event].some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isManaged(h, plat)));

/** The longest transcript line read when looking for one call (a whole brief sits in one line). */
const REVEAL_LINE_MAX = 8 * 1024 * 1024;

/**
 * The raw string `field` of the input of the tool_use block `toolUseId` in a Claude Code transcript (JSON lines); undefined when the
 * block or field is not there. Read only, line by line; the caller has already checked the file is a regular file under the profile root.
 */
async function claudeFieldText(file: string, toolUseId: string, field: string): Promise<string | undefined> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > REVEAL_LINE_MAX || !line.includes(toolUseId) || !line.includes('"tool_use"')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use" && b.id === toolUseId) {
          const v = b.input?.[field];
          return typeof v === "string" ? v : undefined;
        }
      }
    }
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export const claude: HostProfile = {
  key: "claude",
  displayName: "Claude",
  fullName: "Claude Code",
  chip: "C",
  testedVersions: [],
  eventKinds: SHARED_EVENT_KINDS,
  capabilities: { failureEvent: true, argvTag: true, helperSessions: false, launchKey: false, readsForeignHooks: false },
  fields: { ...SHARED_FIELDS, callReason: "description" },
  failureOf: claudeShapeFailure,
  extraOf: claudeShapeExtra,
  narration: {
    sources: [
      { kind: "text-before-call", readableAt: "pre" },
      { kind: "closing-message", readableAt: "post" },
    ],
    foldLine: claudeLine,
    closing: (cur) => joined(cur?.pending ?? [], CLOSING_MAX),
  },
  // The desktop app's Code tab saves the user's permission approvals here; only the app's own file at the task folder root, not .claude/settings.json (the user's shared project config, which the app does not write).
  hostOwnedFiles: [".claude/settings.local.json"],
  hostOwnedWhat: "the Claude app saving your permission choices",
  sessionTitle: claudeSessionTitle,
  sessionFile: {
    // Claude names its session file in the payload (`transcript_path`); there is no folder layout to search.
    bySessionId: false,
    locate: () => undefined,
  },
  helpers: {
    dirOf: (sessionFile, session) => path.join(path.dirname(sessionFile), session, "subagents"),
    transcriptFile: (agentId) => `agent-${agentId}.jsonl`,
    metaFile: (agentId) => `agent-${agentId}.meta.json`,
    idOfTranscript: (name) => name.slice("agent-".length, -".jsonl".length),
    idOfMeta: (name) => name.slice("agent-".length, -".meta.json".length),
    transcriptName: /^agent-.+\.jsonl$/,
    metaName: /^agent-.+\.meta\.json$/,
    folderName: "subagents",
    // Under the node test runner the `~/.claude` default is refused, so a test cannot read the real transcripts.
    projectsRoot: () => {
      if (!process.env.CLAUDE_CONFIG_DIR && process.env.NODE_TEST_CONTEXT) {
        throw new Error("CLAUDE_CONFIG_DIR is unset under the test runner; refusing to fall back to the real ~/.claude/projects");
      }
      return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects");
    },
  },
  coverage: { readCalls: (sessionFile, session) => readClaudeCalls(sessionFile, session) },
  reveal: { fieldText: claudeFieldText },
  install: {
    skillRoot: path.join(".claude", "skills"),
    inBothAlias: true,
    timingLabel: "Claude Code",
    hostFlag: "claude",
    projectDirEnv: "CLAUDE_PROJECT_DIR",
    events: Object.keys(SHARED_EVENT_KINDS),
    afterInstall: "Restart Claude Code so it reads the new settings.",
    configFile: (env, userHome) => path.join(env.CLAUDE_CONFIG_DIR || path.join(userHome, ".claude"), "settings.json"),
    addHooks: (text, file, spec, plat = platform()) => {
      const settings = parseSettings(text, file);
      removeManaged(settings, plat);
      addManaged(settings, spec === undefined ? "" : plat.hookCommand.build(spec));
      return claudeText(settings);
    },
    removeHooks: (text, file, plat = platform()) => {
      const settings = parseSettings(text, file);
      const changed = removeManaged(settings, plat);
      return { text: changed ? claudeText(settings) : text, changed };
    },
    missingEvents: (text, file, plat = platform()) => {
      const settings = parseSettings(text, file);
      return Object.keys(SHARED_EVENT_KINDS).filter((e) => !hasManaged(settings, e, plat));
    },
  },
  shape: {
    PreToolUse: ["session_id", "tool_name", "tool_use_id", "tool_input"],
    PostToolUse: ["session_id", "tool_name", "tool_use_id", "tool_input", "tool_response"],
    PostToolUseFailure: ["session_id", "tool_name", "tool_use_id", "error"],
    Stop: ["session_id"],
    SubagentStop: ["session_id", "agent_id"],
    UserPromptSubmit: ["session_id", "prompt"],
  },
};
