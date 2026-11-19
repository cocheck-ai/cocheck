# codex 0.164.0-alpha.11.1 probe

Made by two `codex exec` runs of the codex binary bundled in ChatGPT.app, in a scratch workspace with a scratch `CODEX_HOME` (never the real ~/.codex). The prompt is in prompt.txt (write a file, run a failing `ls`, spawn a helper that writes a second file, wait for it). A probe hook (a shell script that appends its stdin plus uid, an outside-workspace write result and a localhost curl status to a log) was registered for every event.
- run1-untrusted.out / .err: hooks present but not trusted, default sandbox (read-only). The hook log was never created and stderr shows no trace of the hooks.
- hook-calls-run2.jsonl: 28 hook calls from the second run (`--dangerously-bypass-hook-trust`, `-s workspace-write`). One JSON per call: probe_event, ts, uid, cwd, outside_write, curl, stdin (the raw hook payload).
- app-server-hooks-list.json: `codex app-server` `hooks/list` for a scratch copy of the real CoCheck config, trimmed to non-identifying fields (commands, paths, keys and hashes dropped).
Trimmed for the repo: the logged environment-variable name field was removed from every line, scratch paths became `<scratch>`, the developer home folder became `/Users/<user>`. The `message` field of the spawn call is an opaque encoded blob from the model.
Not exercised: PermissionRequest, PreCompact, PostCompact, Interrupt. The ChatGPT.app GUI was not driven. Sandbox mode tested: workspace-write only.
