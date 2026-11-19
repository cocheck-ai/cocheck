# GitHub Copilot CLI (copilot-cli)

Checked 2026-10-18 against 1.0.93. Facts and sources are in capabilities.json.

## What it is
GitHub's terminal coding agent. `copilot -p "..."` runs one non-interactive turn; plain `copilot` is interactive. Same hook system is shared with the Copilot cloud agent, with differences (below).

## How it runs on a Mac
Homebrew cask. `/opt/homebrew/bin/copilot` links to `/opt/homebrew/Caskroom/copilot-cli/1.0.93/copilot` (arm64 binary). Newer versions auto-download to `~/Library/Caches/copilot/pkg/darwin-arm64/<ver>`; hooks run from that cache dir. Disable with `--no-auto-update`.

## Versions seen
1.0.93 installed. Releases page shows 1.0.98 and 1.0.100-1 published.

## How CoCheck can observe it
Command hooks, JSON files with `version: 1`. Put them in the repo `.github/hooks/*.json` or the user `~/.copilot/hooks/*.json` (or `$COPILOT_HOME/hooks/`). Use camelCase event names. Observed events on 1.0.93: userPromptSubmitted, sessionStart, preToolUse, postToolUse, agentStop, sessionEnd. Documented but not exercised: postToolUseFailure, subagentStart/Stop, errorOccurred, preCompact, notification, permissionRequest, userPromptTransformed.
Payload on stdin is one JSON object. All have `sessionId`, `cwd`; all observed payloads have `timestamp` (epoch ms). preToolUse: `toolName`, `toolArgs`. postToolUse adds `toolResult{resultType,textResultForLlm}`. agentStop: `transcriptPath`, `stopReason`, `stop_hook_active`.
Important: no tool call id on stdin. Join pre to post by order within a session plus toolName/toolArgs, and to the session file the same way.
Blocking (documented): preToolUse output `permissionDecision` allow/deny/ask; exit 2 denies; agentStop output `decision: block`. Timeouts fail open (default 30s).
Cloud agent: only `.github/hooks`, only bash/command entries, no permissionRequest/notification.

## Narration
In `session-state/<sessionId>/events.jsonl`, an `assistant.message` with `phase: "commentary"` carries the sentence in `content` and the pending calls in `toolRequests[]` (each with `toolCallId`, `name`, `arguments`, `intentionSummary`). It is stamped a few ms before `tool.execution_start` and the preToolUse hook. The final answer has `phase: "final_answer"`. Content can be empty if the model is not asked to narrate; `intentionSummary` is still there. Whether it is on disk when the preToolUse command runs is untested.

## Session and log files
`~/.copilot/session-state/<uuid>/` holds events.jsonl, workspace.yaml, checkpoints/, files/, research/, rewind-file-snapshots/. `hook.start`/`hook.end` events in events.jsonl duplicate every hook input; the preToolUse copy there includes `toolCalls[{id,name,args}]`. Logs: `~/.copilot/logs/process-<epochms>-<pid>.log`. `session-store.db` is a SQLite index.

## Config and auth locations
`~/.copilot/config.json` (auto-managed JSONC; trustedFolders), user settings in `~/.copilot/settings.json` (absent here). `COPILOT_HOME` moves all of it. Login was not in the scratch config (probably keychain, unverified).

## How to probe it safely
Proven recipe: scratch git repo with `.github/hooks/log.json`, `COPILOT_HOME=<scratch>`, `COPILOT_ALLOW_ALL=true` (trusts cwd, approves tools), `copilot -p "..." --no-auto-update --no-remote`. Real ~/.copilot was unchanged (hashes identical). See versions/1.0.93/README.md.

## Quirks
- userPromptSubmitted fired before sessionStart in -p mode.
- Stdin payload shape differs from the hook.start copy in the session file. The hook.start copy of preToolUse lacks timestamp/toolName/toolArgs but has toolCalls[].id.
- `COPILOT_ALLOW_ALL=true` exactly also trusts the folder and so loads its hooks; other truthy values do not.
- Model is Auto-routed; the probe turn ran on a model named gpt-5.6-luna.
- Docs concept page example path `~/.github/hooks/` is wrong versus the reference page.

## Open questions
See `open_questions` in capabilities.json.
