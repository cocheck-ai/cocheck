# Codex (OpenAI Codex CLI) : platform guide, checked 2026-10-18

Facts and sources are in capabilities.json. Version checked: 0.162.0-alpha.2.

## What it is
OpenAI's coding agent. It runs as a CLI, as `codex exec` (non-interactive), and behind the ChatGPT Desktop app through a shared local app-server daemon.

## How it runs on a Mac
The binary lives inside `~/.codex/packages/app-server-daemon/releases/<id>/CodexCLI.app/Contents/MacOS/codex`, with a `current` symlink. A daemon with sockets under `~/.codex/app-server-control` and `~/.codex/ipc` is running. ChatGPT.app is in /Applications; `codex app` launches it. Whether ChatGPT.app embeds the same binary is not checked.

## Versions seen
Local 0.162.0-alpha.2 (recorded). Latest stable on GitHub: 0.163.0 (2026-10-15). Prerelease 0.164.0-alpha.3 (2026-10-17). Payloads on those are not recorded.

## How CoCheck can observe it
Command hooks, 12 event names configurable: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt, SessionEnd. Seen live: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd. Config is `[[hooks.<Event>]]` plus `[[hooks.<Event>.hooks]]` in ~/.codex/config.toml (or hooks.json). Hooks are not run until trusted (hash based; `/hooks` in the CLI), or the run uses `--dangerously-bypass-hook-trust`. Docs and `features list` say the `hooks` feature is on by default; our earlier note that it must be set is contradicted (our run set it, so it was never tested off). No PostToolUseFailure exists. Shell calls arrive as tool_name "Bash". The hook `tool_use_id` is `exec-<uuid>`, equal to the rollout CommandExecution id, not the model-facing `call_<hex>` of the custom_tool_call. Stop carries last_assistant_message.

## Narration
The sentence before a call is an AgentMessage with `phase: "commentary"`; the final text is `phase: "final_answer"`. In the recording the commentary line preceded PreToolUse by about 0.4 s, so it is likely readable at Pre, but flush-to-disk is unproven; CoCheck reads at Post, which is safe. Reasoning summaries were empty even with model_reasoning_summary = "detailed" (one sample).

## Session and log files
`~/.codex/sessions/YYYY/MM/DD/rollout-<local ts>-<session uuid>.jsonl`, each line `{timestamp,type,payload}`. Also archived_sessions/, session_index.jsonl (id, thread_name, updated_at), and sqlite files (state, logs, thread_history). Header says history_mode "paginated". Docs call the transcript format unstable.

## Config and auth locations
~/.codex/config.toml (user), <repo>/.codex/config.toml and hooks.json (project, trusted layers only), requirements.toml (admin). Auth in ~/.codex/auth.json (never read). CODEX_HOME relocates everything.

## How to probe it safely
Scratch CODEX_HOME with a config that sets hooks and logs each event, copy auth in mode 0600, pass `--dangerously-bypass-hook-trust`, run two tiny turns, delete the scratch home. CoCheck's `scripts/probe-host.ts codex --out <dir>` does exactly this. Hash ~/.codex/config.toml before and after.

## Quirks
- Hook tool_name is Bash though the model calls a JS `exec` tool.
- SessionEnd payload has cwd and transcript_path but no model or permission_mode; reason is always "other".
- (docs, not observed) Matchers are ignored for UserPromptSubmit, Stop, Interrupt.
- `codex exec` waits on stdin when stdin is not a TTY ("Reading additional input from stdin..."), so scripted runs need `< /dev/null`.
- Hook output goes to context only for SessionStart, UserPromptSubmit, SubagentStart; Stop and SubagentStop must print JSON.
- Rollout order: commentary, then CommandExecution; hook timestamps interleave closely (Pre after commentary, Post just after CommandExecution, 2 samples).

## Open questions
See open_questions in capabilities.json. Main ones: hooks with no features key, Pre-time readability of commentary, failing-command Post shape, apply_patch and MCP payloads, subagent and interrupt events, and ChatGPT.app embedding.
