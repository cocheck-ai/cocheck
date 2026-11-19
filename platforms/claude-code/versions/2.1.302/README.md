# Claude Code 2.1.302 recording

Made with CoCheck's `scripts/probe-host.ts` (one scripted `claude -p` session: two shell calls on a small CSV, prompt asks for one sentence before each command). Settings were isolated (`--setting-sources ""` plus a `--settings` file carrying logging hooks) in a scratch dir, permission mode bypassPermissions.

- `payloads.jsonl`: one `{event, ts, stdin}` line per hook call (raw stdin as text). Events seen: SessionStart, UserPromptSubmit, PreToolUse x2, PostToolUse x2, Stop, SessionEnd.
- `sessions/<id>.jsonl`: the session transcript the host wrote (48 lines). No subagent was spawned, so there is no `subagents/` folder here.

Scrubbed for the public release: in sessions/*.jsonl every harness prompt field (system prompt, rendered system reminders, tool, agent, skill and MCP listings, api request blobs) is replaced by `[system prompt removed]`, and the organization id too. Record order, ids, timestamps, the probe prompt, assistant turns and tool results are kept; no code reads this file.
