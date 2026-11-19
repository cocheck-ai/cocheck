# Codex 0.162.0-alpha.2 recording

Made with CoCheck's scripts/probe-host.ts (one tiny scripted session: two shell calls on a small CSV, with "say what you do before each command" in the prompt), in a scratch CODEX_HOME with hooks logging every event and --dangerously-bypass-hook-trust.

- payloads.jsonl: one `{event, ts, stdin}` line per hook call, raw stdin kept as text.
- sessions/: the rollout file the run wrote.

Copied from the probe output folder. capabilities.json cites only these two files from this run. An earlier second run (model_reasoning_summary="detailed", its own rollout and payloads) was not copied into the repo; facts that rested on it were repointed here or downgraded to unverified. Prompts and model text are from our own scripted task only.

Scrubbed for the public release: in the rollout (here and in test/fixtures/hosts/codex-0.162.0-alpha.2) `base_instructions`, the developer messages and the skill body are replaced by `[system prompt removed]`, and the creator user and account ids by `[id removed]`. Ordinals, item lines, commentary and tool items are untouched.
