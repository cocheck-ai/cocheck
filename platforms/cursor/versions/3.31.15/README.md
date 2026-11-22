# cursor 3.31.15 recording

One agent chat in the Cursor 3.31.15 editor, run by hand on 2026-11-22 in a scratch project whose `.cursor/hooks.json` sent all 13 events below through the logging hook of `cocheck harness record` (one line per call: `event`, `argv`, `stdin`, `ts`). The hooks answered permission events with JSON (`{"permission":"allow"}`, `{"continue":true}`) so nothing was blocked. The prompt asked the agent to create hello.txt, edit seed.txt, run `ls -la`, run a failing `cat`, and read hello.txt through a Task helper.

- hook-calls-editor.jsonl: 28 hook calls. Events seen: sessionStart, beforeSubmitPrompt, preToolUse, postToolUse, postToolUseFailure, beforeShellExecution, afterShellExecution, afterFileEdit, subagentStart, subagentStop, afterAgentResponse, stop. sessionEnd was configured and did not fire during the run.

Trimmed for the repo: the developer home folder became `/Users/<user>`, the user name in `ls` output `<user>`, and `user_email` `user@example.com`. Nothing else was changed.
