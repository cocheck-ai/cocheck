# Cursor

A manifest for Cursor, written from a real recording of the 3.31.15 editor agent chat on macOS and checked by its case. It is not built in: it loads as a harness from your own folder (`cocheck harness test --cases public-kit/harness/harnesses/cursor/cases --manifest public-kit/harness/harnesses/cursor`, or copy the folder to `<CoCheck data home>/harnesses/cursor/`), so its credit basis is `inferred`. The platform record is `platforms/cursor/`.

## How the recording was made

A scratch project whose `.cursor/hooks.json` sent 13 events through the logging hook of `cocheck harness record`, opened and trusted in Cursor 3.31.15, and one agent-chat prompt: create hello.txt, edit seed.txt, run `ls -la`, run a failing `cat`, read hello.txt through a Task helper. Permission events were answered with JSON so nothing was blocked. `recordings/payloads.jsonl` holds all 28 hook calls; the project path is replaced by `<folder>`, the home folder by `/Users/<user>`, the user name by `<user>` and the account email by `user@example.com`.

## What Cursor sends

Every payload carries `conversation_id`, `session_id` (the same value), `generation_id`, `model`, `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email` and `transcript_path` (a path on `stop` and `afterAgentResponse`, null elsewhere).

- `preToolUse`, `postToolUse`, `postToolUseFailure`: `tool_name`, `tool_input` (an object for Read and Shell, JSON text for Write and Task), `tool_use_id`; Post adds `tool_output` and `duration`; the failure event adds `error_message`, `failure_type` and `is_interrupt`.
- `beforeShellExecution`, `afterShellExecution`: the Shell call's `command`, `cwd` (empty), `sandbox`, and its `tool_use_id`; after adds `output`.
- `afterFileEdit`: `file_path` and `edits` (`old_string`, `new_string`), no call id, sent between the Write call's Pre and Post.
- `subagentStart`, `subagentStop`: `subagent_id`, `subagent_type`, `task`, `description`, `parent_conversation_id`; stop adds `child_conversation_id` and `status`.
- `beforeSubmitPrompt`: `prompt`. `afterAgentResponse`: `text`. `stop`: `status`, token counts.

Tool names seen: `Read`, `Write` (new files and edits alike, whole `content`), `Shell`, `Task`.

## Level and gaps

Calls with a real call id and a failure event: L2 for calls.

- `afterFileEdit` is read as context, not as a call: it has no call id and arrives inside the Write call, so as a call of its own it would share that call's credit. It also drops events in batch edits (a confirmed Cursor bug); the Write call is the record.
- Checkpoint restore, Tab completions and Accept-All formatting change files with no tool event: CoCheck's folder check shows them as changes made outside the agents.
- File-tool call ids hold a line break, and consecutive calls of one model step can share one id (a failed Read, then a Write): the credit names the id both share.
- No closing message: `stop` has none; the text is on `afterAgentResponse`, which may fire more than once a turn.
- A Task helper's calls carry `parent_agent_id`, so they join the main session; they are not told apart from the main agent's (no `agentId` mapped).
- The headless CLI skips the prompt, stop and closing events (Cursor docs); the CLI was not recorded.
- Cloud agents run hooks remotely, out of CoCheck's reach.
- Cursor's docs say a permission hook (`preToolUse`, `beforeShellExecution`, `subagentStart`) whose answer is not valid JSON blocks the action. CoCheck's hook prints nothing on these events, and whether Cursor blocks on that is not yet tested.

## Hook config

Project level, `{project}/.cursor/hooks.json`, merged into the file: `{"version": 1, "hooks": {"<event>": [{"command": ..., "timeout": 30}]}}`. User-level hooks are reported broken in CLI 2026.11.05. Cursor runs project hooks only in a trusted workspace.

## Claude hooks

Cursor 3.31.15 also runs the Claude Code hooks in `~/.claude/settings.json` ("from claude-user config" in Cursor's hooks log), with the same Cursor payload it gives its own hooks: Cursor event names (`preToolUse`, not `PreToolUse`), `conversation_id`, `cursor_version` and `workspace_roots`. Without a guard, CoCheck's Claude hook would record Cursor's work as Claude's. The manifest declares `readsForeignHooks` and a `foreignHookFingerprint` keyed on `cursor_version` (present in every Cursor payload, never sent by Claude Code or by Copilot's runs of Claude hooks), with `workspace_roots` present and `conversation_id` and `hook_event_name` as text. While CoCheck's Cursor entries are in that folder's `.cursor/hooks.json`, the Claude hook skips these payloads and the Cursor entry records them; before that, the Claude hook records them as it did. `cocheck status` shows `Claude hook skips payloads from Cursor` while the guard is in force.
