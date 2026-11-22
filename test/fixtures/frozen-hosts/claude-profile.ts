// Claude Code. Its facts: the assistant text before a call is in the transcript at the call's Pre; a failed call sends its own event;
// helpers keep a transcript and a meta file beside the session's; settings live in ~/.claude/settings.json.
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import readline from "node:readline";
import path from "node:path";
import { readClaudeCalls } from "../../../src/coverage.ts";
import { CLOSING_MAX, NARRATION_MAX, joined, remember, type NarrationCursor } from "../../../src/narration.ts";
import { claudeShapeExtra, claudeShapeFailure } from "../../../src/hosts/shared.ts";
import { jsonHookEditor, type JsonInstallBlock } from "../../../src/hosts/install-block.ts";
import { claudeSessionTitle } from "../../../src/hosts/session-titles.ts";
import { SHARED_EVENT_KINDS, SHARED_FIELDS, type HostProfile } from "../../../src/hosts/types.ts";
import { toolGroup, type ToolTable } from "../../../src/hosts/tool-classes.ts";

const ASSISTANT_LINE = /"type"\s*:\s*"assistant"/;
const USER_LINE = /"type"\s*:\s*"user"/;

/** One line of a Claude Code transcript. Only assistant lines are parsed. */
export function claudeLine(cur: NarrationCursor, line: string): void {
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

/** SessionStart sets the attribution write hooks' environment for the session's Bash calls (CLAUDE_ENV_FILE); it records nothing. */
export const CLAUDE_EXTRA_EVENTS: readonly string[] = ["SessionStart"];

const CLAUDE_INSTALL: JsonInstallBlock = {
  format: "json",
  path: "{env:CLAUDE_CONFIG_DIR|{home}/.claude}/settings.json",
  mode: "merge",
  rootKey: "hooks",
  events: Object.keys(SHARED_EVENT_KINDS),
  extraEvents: CLAUDE_EXTRA_EVENTS as string[],
  entryTemplate: { hooks: [{ type: "command", command: "{command}" }] },
  matcherEvents: { PreToolUse: "*", PostToolUse: "*", PostToolUseFailure: "*" },
  managedHost: "claude",
};

/** The longest transcript line read when looking for one call (a whole brief sits in one line). */
const REVEAL_LINE_MAX = 8 * 1024 * 1024;

/**
 * The raw string `field` of the input of the tool_use block `toolUseId` in a Claude Code transcript (JSON lines); undefined when the
 * block or field is not there. Read only, line by line; the caller has already checked the file is a regular file under the profile root.
 */
export async function claudeFieldText(file: string, toolUseId: string, field: string): Promise<string | undefined> {
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

/** Claude Code's tools by class. Names are the ones its hook reports. */
const CLAUDE_TOOLS: ToolTable = {
  ...toolGroup("read", ["Read"]),
  ...toolGroup("read-only", ["Glob", "Grep", "LS", "NotebookRead"]),
  ...toolGroup("never-credited", [
    "WebFetch", "WebSearch", "ToolSearch", "Skill", "TodoWrite", "TodoRead",
    "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "BashOutput", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode",
    "ListMcpResourcesTool", "ReadMcpResourceTool",
  ]),
  ...toolGroup("never-credited", ["SendMessage"], { resumesHelper: true }),
  ...toolGroup("write", ["Write"], { pathFields: ["file_path", "path"], pathChecked: true, fileInput: true, anyCase: true }),
  ...toolGroup("edit", ["Edit"], { pathFields: ["file_path", "path"], pathChecked: true, fileInput: true, anyCase: true }),
  ...toolGroup("edit", ["MultiEdit"], { pathFields: ["file_path"], pathChecked: true, fileInput: true, anyCase: true }),
  ...toolGroup("notebook-edit", ["NotebookEdit"], { pathFields: ["notebook_path"], fileInput: true, anyCase: true }),
  // Claude Code has no patch tool of its own; a patch tool a hook run reports under this host is still read as a patch (its secrets are withheld, its headers name the files).
  ...toolGroup("patch", ["apply_patch", "patch"], { anyCase: true }),
  ...toolGroup("launcher", ["Agent", "Task"], { backgroundFlag: true }),
  ...toolGroup("shell", ["Bash"], { dialect: "bash", backgroundable: true, anyCase: true }),
  ...toolGroup("shell", ["PowerShell", "pwsh"], { dialect: "powershell", anyCase: true }),
};

/** Where a Claude Code session keeps its helpers' own records, beside the session file. */
export const CLAUDE_HELPERS: NonNullable<HostProfile["helpers"]> = {
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
};

/** The closing words a Claude Code cursor holds. */
export const claudeClosing = (cur: NarrationCursor | undefined): string => joined(cur?.pending ?? [], CLOSING_MAX);

export const claude: HostProfile = {
  key: "claude",
  displayName: "Claude",
  fullName: "Claude Code",
  chip: "C",
  testedVersions: [],
  eventKinds: SHARED_EVENT_KINDS,
  capabilities: { failureEvent: true, argvTag: true, helperSessions: false, launchKey: false, readsForeignHooks: false },
  // transcript-helpers: the helper-lane rebuild reads helper transcripts; transcript-coverage: the transcript's call ids; install-default: the host an install
  // record without a host list (the settings file fields) and a hook check without a host fall back to.
  extras: ["transcript-helpers", "transcript-coverage", "install-default"],
  argvTag: {
    tool: "Bash",
    preOutput: (eventName, updatedInput) => JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, updatedInput } }) + "\n",
    envFileVar: "CLAUDE_ENV_FILE",
    shellEnv: "CLAUDE_CODE_SHELL",
    sessionStartEvent: "SessionStart",
  },
  sessionEnv: "CLAUDE_CODE_SESSION_ID",
  toolClasses: CLAUDE_TOOLS,
  fields: { ...SHARED_FIELDS },
  failureOf: claudeShapeFailure,
  extraOf: claudeShapeExtra,
  narration: {
    sources: [
      { kind: "text-before-call", readableAt: "pre" },
      { kind: "closing-message", readableAt: "post" },
    ],
    foldLine: claudeLine,
    closing: claudeClosing,
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
  helpers: CLAUDE_HELPERS,
  coverage: { readCalls: (sessionFile, session) => readClaudeCalls(sessionFile, session) },
  reveal: { fieldText: claudeFieldText },
  install: {
    skillRoot: path.join(".claude", "skills"),
    inBothAlias: true,
    timingLabel: "Claude Code",
    hostFlag: "claude",
    projectDirEnv: "CLAUDE_PROJECT_DIR",
    checkPayload: (folder) => ({ payload: { session_id: "install-check", cwd: folder, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "install-check-1", tool_input: { command: "true" } } }),
    events: Object.keys(SHARED_EVENT_KINDS),
    afterInstall: "Restart Claude Code so it reads the new settings.",
    ...jsonHookEditor(CLAUDE_INSTALL),
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
