# Claude Code (Anthropic CLI), checked 2026-10-18 against 2.1.302

Machine-readable facts: `capabilities.json`. Recording: `versions/2.1.302/`.

## What it is
Anthropic's terminal coding agent (also bundled in the desktop app, VS Code and the SDK; `claude -p` runs it headless). It runs tools (Bash, Edit, Write, Read, Agent and others) and fires hooks around them.

## How it runs on a Mac
Native install: `~/.local/bin/claude` is a symlink to `~/.local/share/claude/versions/<version>` (here 2.1.302, with 2.1.300 and 2.1.301 kept). A `ClaudeCode.app` also sits in `~/.local/share/claude/`. User state is in `~/.claude`.

## Versions seen
2.1.302 (running, changelog dated 2026-10-16), 2.1.301, 2.1.300 on disk. `claude --version` prints `2.1.302 (Claude Code)`.

## How CoCheck can observe it
User-level hooks in `~/.claude/settings.json`. CoCheck uses PreToolUse, PostToolUse, PostToolUseFailure (matcher `*`), Stop, SubagentStop and UserPromptSubmit. Every payload has `session_id`, `transcript_path`, `cwd`, `hook_event_name`, usually `prompt_id`, `permission_mode`, `effort`. Tool events add `tool_name`, `tool_input`, `tool_use_id`; Post adds `tool_response` and `duration_ms`; failure adds `error` and `is_interrupt`. `tool_input.description` (Bash) is the model's one-line reason for the call; optional. Hooks inside a subagent also carry `agent_id` and `agent_type`.

Full event list (docs): SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd. Seen in the recording: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd.

Matchers: tool events match tool name (exact list with `|`, else JS regex; MCP tools are `mcp__server__tool`); SessionStart matches source; SubagentStart/Stop match agent type; Notification, PreCompact, SessionEnd, StopFailure have their own value lists; UserPromptSubmit, PostToolBatch, Stop and a few others take none. An `if` field filters by permission-rule syntax (`Bash(git *)`).

Blocking: exit 0 = success (stdout JSON parsed); exit 2 = block with stderr as reason on blocking events (PreToolUse, UserPromptSubmit, Stop, SubagentStop, PostToolBatch, PreCompact and others); any other exit is a non-blocking error. Exit 2 does not block PostToolUse, PostToolUseFailure, SubagentStart, SessionStart/End, Notification, PermissionRequest. JSON can set `permissionDecision` (PreToolUse), `decision: block`, `continue: false`. `onFailure: "block"` (2.1.295+) turns failures into blocks. CoCheck only observes and never blocks.

Timeouts: 600 s default; 30 s on UserPromptSubmit; SessionEnd shares a 1.5 s budget (up to 60 s with a longer per-hook timeout). A timed-out hook's output is discarded.

Config locations (merged, not overridden): user `~/.claude/settings.json`, project `.claude/settings.json`, local `.claude/settings.local.json`, plugin `hooks/hooks.json`, skill/subagent frontmatter, managed policy (macOS `/Library/Application Support/ClaudeCode/managed-settings.json` and `managed-settings.d/`, Linux `/etc/claude-code/`, MDM domain `com.anthropic.claudecode`). Precedence: managed, `--settings`, local, project, user. Managed `allowManagedHooksOnly` can switch off the others; `disableAllHooks` cannot disable managed hooks; `--bare` skips hooks.

## Narration
Read from the transcript, not the hook. In the recording the assistant's sentence before each command is its own `assistant` line with one `text` block; the `tool_use` block follows on the next line with the same `message.id` (`apiBlockIndex` 0 then 1, `stop_reason: tool_use`). So the text since the previous tool_use belongs to the next tool_use; parallel tool_use lines of one message share it. The closing words are the last text of the turn, and also arrive as `Stop.last_assistant_message`. Thinking blocks were empty. Ignore lines with `isSidechain: true` for the main thread; subagent transcripts are separate files.

## Session and log files
- Main: `~/.claude/projects/<cwd-slug>/<session_id>.jsonl` (path given in `transcript_path`).
- Subagents: `<cwd-slug>/<session_id>/subagents/agent-<agent_id>.jsonl` plus `agent-<agent_id>.meta.json` (keys: agentType, description, toolUseId of the launching call, spawnDepth, model, finished). Lines have `isSidechain: true` and `agentId`. `SubagentStop.agent_transcript_path` names the file.
- Line types seen: user (prompt, or tool_result), assistant (thinking/text/tool_use blocks), attachment, system (`stop_hook_summary`), queue-operation, last-prompt, api-request/-shape/-blob, atis-latch, cost-state. Transcripts can lag the hooks.

## Config and auth locations
`~/.claude/settings.json` (hooks, env, permissions, plugins), `~/.claude.json`, `~/.claude/plugins/`, `CLAUDE_CONFIG_DIR` to relocate. Auth files were not read.

## How to probe it safely
`node scripts/probe-host.ts claude --out <dir>`: `claude -p` with `--setting-sources ""` and a scratch `--settings` file carrying logging hooks; real config untouched. That is how the 2.1.302 recording was made.

## Quirks
- Version updates in the background take effect next start; old versions pile up (keeps launcher target plus two newest).
- `transcript_path` writes are asynchronous; use `last_assistant_message` for final text.
- Hook `effort` is absent on UserPromptSubmit and session events.
- Plugin subagent types look like `plugin:name`; anchor matchers.
- Real settings backups (`settings.json.*`) sit next to the live file.

## Open questions
See `capabilities.json` `open_questions`: transcript flush timing at Pre, agent_id on in-subagent tool hooks (not recorded), MessageDisplay as a narration channel, Windows managed path, changelog before 2.1.293.
