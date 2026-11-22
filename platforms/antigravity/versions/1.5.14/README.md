# antigravity 1.5.14 recording

Six `agy -p` print runs on macOS in a scratch git folder, through the logging hook of `cocheck harness record`, with the hook config in `<folder>/.agents/hooks.json` and `--settings` (session only) trusting that folder. The runs: create a file, edit it, a shell command that succeeds, one that fails, a failed edit with a denied shell command, and a helper started with `invoke_subagent`.

- hook-calls-print.jsonl: 63 hook calls (`event`, `argv`, `stdin`, `ts`), the same file as `public-kit/harness/harnesses/antigravity/recordings/payloads.jsonl`. The workspace path is `<folder>` and the home folder `/Users/<user>`.
