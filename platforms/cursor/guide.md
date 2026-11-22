# Cursor

## What it is
An AI code editor (a VS Code fork) by Anysphere, with an agent chat, a `cursor-agent` CLI and cloud agents.

## How it runs on a Mac
The editor is `/Applications/Cursor.app`. The CLI is installed by a fetched script and was not installed for the recording.

## Versions seen
3.31.15 (editor), recorded 2026-11-22.

## How CoCheck can observe it
Command hooks in `.cursor/hooks.json` (`{"version": 1, "hooks": {...}}`), shared by the editor and the CLI. CoCheck installs at project level, because user-level hooks are reported broken in CLI 2026.11.05. Tool calls arrive as `preToolUse` / `postToolUse` / `postToolUseFailure` with `tool_use_id`; Write covers both new files and edits (whole content). `afterFileEdit` also fires inside each Write call, without a call id, and is read as context only.

Known gaps:
- `afterFileEdit` drops events in batch edits (a confirmed Cursor bug), so the Write call's Pre/Post is the primary record.
- Checkpoint restore, Tab completions and Accept-All formatting change files with no tool event: CoCheck's folder check shows them as changes made outside the agents.
- The headless CLI skips the prompt, stop and closing events.
- No closing message: `stop` carries none; the text is on `afterAgentResponse`, which can fire more than once a turn.
- Cloud agents run hooks remotely, out of CoCheck's reach.
- A permission hook whose answer is not valid JSON blocks the action (docs); CoCheck's hook answers nothing, and whether Cursor blocks on that is not yet tested.

## Narration
None read: Cursor's transcript (`transcript_path`, on stop only) is not read by CoCheck.

## Session and log files
`~/.cursor/projects/<folder slug>/agent-transcripts/<conversation>/<conversation>.jsonl`.

## Config and auth locations
`.cursor/hooks.json` (project), `~/.cursor/hooks.json` (user). Every payload carries the account email (`user_email`).

## How to probe it safely
A scratch folder with its own `.cursor/hooks.json` that logs stdin and answers permission events with JSON; never edit `~/.cursor/hooks.json`. Trust the folder when Cursor asks.

## Quirks
File-tool call ids contain a line break, and consecutive calls of one model step can share an id (a failed Read, then a Write).

## Open questions
See `capabilities.json` `open_questions`.
