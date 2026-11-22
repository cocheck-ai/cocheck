# Antigravity CLI

A manifest for Antigravity CLI (`agy`), written from real recordings of version 1.5.14 on macOS and checked by its cases. It is not built in: it loads as a harness from your own folder (`cocheck harness test --cases public-kit/harness/harnesses/antigravity/cases --manifest public-kit/harness/harnesses/antigravity`, or copy the folder to `<CoCheck data home>/harnesses/antigravity/`), so its credit basis is `inferred`.

## How the recording was made

`cocheck harness record` with the hook config written to a workspace file, `<folder>/.agents/hooks.json` (a scratch git folder), and `agy -p` run there in print mode, `--mode accept-edits`, with `--settings` (session only, never saved) trusting that folder and allowing `command(echo)` and `command(cat)`. Six print runs: create a file, edit it, a shell command that succeeds, one that fails, a failed edit with a denied shell command, and a helper started with `invoke_subagent`. `recordings/payloads.jsonl` holds all 63 hook calls; the workspace path is replaced by `<folder>` and the home folder by `/Users/<user>`. The `--flat` and `--grouped` words in `argv` are the recorder's own markers (see "Hook config").

## What Antigravity sends

Every payload is camelCase JSON with `conversationId`, `cwd`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`, `lastUserInput` and `hookEventName`.

- `SessionStart`: once per conversation.
- `PreInvocation` and `PostInvocation`: around every model call, with `invocationNum` and `initialNumSteps` (numbers).
- `PreToolUse` and `PostToolUse`: `toolCall` with `id`, `name` and `args`, and `stepIdx`. The same `toolCall.id` on both. `PostToolUse` adds `error`: empty, or the tool's own words when the tool failed (a failed edit). It carries no result.
- `Stop`: `terminationReason`, `fullyIdle`, `continuationActive`, `executionNum`, `error`. No closing message.

Tool names seen: `write_file` (`Path`, `Content`), `edit_file` (`Path`, `Target`, `Replacement`), `run_command` (`CommandLine`, `WaitMsBeforeAsync`, `toolSummary`), `invoke_subagent` (`Prompt`, `Role`, `TypeName`), `send_message` (`Message`, `Recipient`).

## Level and gaps

Calls with a real call id and a failure read from `error` (a `tool-post` failure rule with `nonEmpty`: words in `error` mean the call failed): L2 for calls. It falls short of L2 in these ways:

- A shell command that exits non-zero has an empty `error` and no output or exit code, so it reads as a call that worked.
- A call the headless permission check denies gets a `PreToolUse` and nothing after it: no `PostToolUse` and no `Stop`.
- A helper runs under its own `conversationId`, with an empty `lastUserInput` and no field naming its parent; the only link is the `Recipient` of the helper's `send_message`. Its calls cannot be tied to the main session, so in real use they are not recorded unless that session is tracked. `invoke_subagent` returns at once, before the helper runs, and the main conversation's `Stop` can come before the helper's writes.
- No closing message on `Stop`, and no tool result on `PostToolUse`.
- The prompt is in `lastUserInput` on every event; no event marks a new turn that the manifest can tell apart (`invocationNum` 0 is a number, and `whenMatches` reads text only), so `PreInvocation` is not mapped to `prompt`.

## Hook config

`hooks.json` maps a hook name to its events. `PreToolUse` and `PostToolUse` take groups (`matcher` plus `hooks`); `SessionStart`, `PreInvocation`, `PostInvocation` and `Stop` take handler objects directly. The manifest writes each in its own shape: `entryTemplates` gives the two tool events a group, and `entryTemplate` gives `Stop` a plain handler. The recordings were made with one entry carrying both shapes, and showed which part Antigravity 1.5.14 reads for each event (each call once, `--grouped` for tool events and `--flat` for the rest); the split entries are what it read, not yet recorded on their own. The install path is the documented global file, `~/.gemini/config/hooks.json`, which no recording has exercised; the workspace file takes the same entries.
