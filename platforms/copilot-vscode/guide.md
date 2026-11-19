# GitHub Copilot in VS Code (agent mode hooks)

## What it is
Copilot's agent mode inside VS Code. Its hooks page is marked Preview and names nine events. This entry is research only: nothing was run or probed on this Mac, and CoCheck has no host profile for it.

## How it runs on a Mac
Inside VS Code, with config under `~/.copilot` and the repo. VS Code also has a separate Claude session target that uses Claude Code's own config and hook implementation.

## Versions seen
None.

## How CoCheck can observe it
Through the same hook files as Copilot CLI (`~/.copilot/hooks/*.json`, `.github/hooks/*.json`, repo `.claude/settings.json`). The VS Code parser ignores matcher values, so a hook runs on every tool. Payload fields are inherited from the CLI record and unverified.

## Narration (the model's own words about a step)
None recorded. VS Code chat session JSON lives under workspaceStorage (from memory, no official page).

## Session and log files
Not read.

## Config and auth locations
See `capabilities.json` `hooks.config_paths`.

## How to probe it safely
Not yet. A probe needs a temp `COPILOT_HOME` and a throwaway workspace; never the real `~/.copilot` or VS Code settings.

## Quirks
Enterprise-managed Copilot settings disable the Claude and Codex harnesses in VS Code.

## Open questions
See `capabilities.json` `open_questions`.
