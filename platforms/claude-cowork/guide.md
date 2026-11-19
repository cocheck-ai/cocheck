# Claude Cowork (checked 2026-10-18, app 2.31226.1)

## What it is
Agent mode of the Claude desktop app: uses the same agentic architecture as Claude Code (official wording), for non-terminal work on files in folders the user connects. Also on web/mobile as cloud sessions.

## How it runs on a Mac
Electron app /Applications/Claude.app (com.anthropic.claudefordesktop; helpers app-cu-helper, chrome-native-host). A Linux VM (rootfs.img etc. in Application Support/Claude/vm_bundles/claudevm.bundle, ~9.9G) managed by coworkd; user folders mounted via virtiofs. Bundled Claude Code CLI under Application Support/Claude/claude-code/<ver> (2.1.295).

## Versions seen
App 2.31226.1; bundled CLI 2.1.295; the one session log found used CLI 2.1.121.

## How CoCheck can observe it
- Hooks: none documented. Code shows settingSources ["user"] with the user dir apparently being the per-session .claude (inferred from layout), so ~/.claude hooks do not apply. Plugin hooks reportedly do not fire (issue 27398, unverified).
- Per-session audit.jsonl and Claude Code transcript jsonl (readable post hoc; real-time tailing untested).
- OTel export (Team/Enterprise admin, documented).
- File-system effects in connected folders.

## Narration
assistant text / thinking / SendUserMessage tool_use blocks in transcript and audit.jsonl.

## Session and log files
Application Support/Claude/local-agent-mode-sessions/<acct>/<org>/agent/local_ditto_<id>.json plus dir {audit.jsonl, .audit-key, .claude/{projects,sessions,.claude.json}, outputs, uploads, shim-lib, shim-perm}. Logs in ~/Library/Logs/Claude (coworkd, cowork_vm_*, mcp*, main).

## Config and auth
config.json (token cache keys, never read), claude_desktop_config.json (mcpServers, preferences), cowork-enabled-cli-ops.json, scheduled-tasks.json per org.

## How to probe it safely
Not done. Needs a real Cowork session; watch the session dir with fs events, never touch the user's account state beyond reading.

## Quirks
Audit lines carry an HMAC with key stored next to them. Only an April session exists locally; newer storage location unknown.

## Open questions
See capabilities.json open_questions. Notably: does the Claude Code process run inside the VM or on the Mac host (hostLoopMode)?
