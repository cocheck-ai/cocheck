# Codex 0.169.0 recording (file-write tool)

Made with CoCheck's `node scripts/probe-host.ts codex --out <dir> --prompt-set write-tools` on 2026-11-21, in a scratch CODEX_HOME with hooks logging every event and --dangerously-bypass-hook-trust.

Prompt: "Step 1: run cat data.csv. Step 2: use apply_patch to create notes.txt with three lines (alpha, beta, gamma). Step 3: use apply_patch to modify data.csv, changing its second row to 9,9,9. Do not use shell commands to write files."

- payloads-write-tools.jsonl: one `{event, ts, stdin}` line per hook call (12 lines), raw stdin kept as text.
- sessions-write-tools/: the rollout the run wrote.

Tools seen by the hooks: Bash (`cat data.csv`, then a `cat notes.txt data.csv` check the model added) and apply_patch twice (one `*** Add File`, one `*** Update File`). The rollout records the calls as `custom_tool_call` items.

Scrubbed: scratch temp path prefix replaced by the placeholder used in the neighbouring recordings; in the rollout the creator user and account ids are `[id removed]`, `base_instructions`, the developer messages, the tool list and long strings of the world state are `[system prompt removed]`, and the timezone is `UTC`.

Replay limit: the `*** Update File` hunk for data.csv does not cover the whole file (it changes the second row and leaves the `7,8,9` row outside the hunk). The replay stand-in for data.csv is rebuilt from the hunk alone, so it lacks that row.
