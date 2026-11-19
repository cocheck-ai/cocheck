# copilot-cli 1.0.93 probe

Made by one `copilot -p` turn (two shell commands on a 3-line CSV, "say what you do before each command") in a scratch git repo with `.github/hooks/log.json` (copied here as hook-config-log.json) whose commands append raw stdin to files.
Fence: `COPILOT_HOME` pointed at a scratch dir, `COPILOT_ALLOW_ALL=true` (grants tools and trusts the cwd), `--no-auto-update --no-remote --log-level debug`. Model was Auto-routed (gpt-5.6-luna in the session). Real ~/.copilot non-log files shasum'd before and after: identical.
- hook-payloads/*.jsonl: raw stdin per event (one JSON per line). env.txt: COPILOT*/PWD/HOME env seen by a hook.
- session-events.jsonl, session-workspace.yaml: that session's state (scratch home). Contains encrypted reasoning blobs; the system message text is replaced by `[system prompt removed]`, and the scratch paths are `<scratch>`.
Not exercised: postToolUseFailure, subagentStop, errorOccurred, notification, permissionRequest, blocking output.
