# Antigravity CLI

## What it is
Google's command-line coding agent, `agy`. It replaced Gemini CLI, which CoCheck does not list as supported.

## How it runs on a Mac
A command, `agy`. Print mode (`agy -p`) was used for the recording.

## Versions seen
1.5.14, recorded 2026-11-22.

## How CoCheck can observe it
Command hooks in a `hooks.json`. The recording used a workspace file, `<folder>/.agents/hooks.json`. CoCheck's manifest installs to the documented global file, `~/.gemini/config/hooks.json`, which no recording has exercised. Tool calls arrive as `PreToolUse` and `PostToolUse` with the same `toolCall.id`; `PostToolUse` carries `error`, empty unless the tool failed. CoCheck reads Antigravity through a manifest only, as a harness from the kit, so its credit basis is "inferred" and `cocheck install --for antigravity` prints the hook entries instead of editing the config.

Known gaps:
- A shell command that exits non-zero has an empty `error`, so it reads as a call that worked.
- A call the headless permission check denies gets a `PreToolUse` and nothing after it.
- A helper's calls arrive under its own `conversationId`, with nothing naming the parent.
- `Stop` carries no closing message, and `PostToolUse` carries no result.

## Narration
None read.

## Session and log files
Every payload names `transcriptPath` and `artifactDirectoryPath`. CoCheck does not read them.

## Config and auth locations
`~/.gemini/config/hooks.json` (global, from the documentation, not exercised), `<folder>/.agents/hooks.json` (workspace, recorded).

## How to probe it safely
`cocheck harness record` writes the hook config to a scratch folder only. Run `agy -p` there with `--settings` that trust that folder, so your own settings are not changed.

## Quirks
The recording needed one entry carrying both hook shapes to show which part each event reads.

## Open questions
See `capabilities.json` `open_questions`.
