# Sources (codex), fetched or read 2026-10-18

## Web
- https://developers.openai.com/codex/hooks : 308 redirect to the page below, 2026-10-18
- https://learn.chatgpt.com/docs/hooks : official hooks reference (events, payload fields, matchers, trust, timeouts, output semantics), fetched 2026-10-18 (via summarizing fetch, not raw HTML)
- https://api.github.com/repos/openai/codex/releases/latest : rust-v0.163.0, 2026-10-15, fetched 2026-10-18 (body truncated)
- https://api.github.com/repos/openai/codex/releases?per_page=8 : showed rust-v0.164.0-alpha.3 prerelease 2026-10-17, fetched 2026-10-18 (truncated)

## Local, read-only
- ~/.codex/packages/app-server-daemon/current/codex-package.json and the binary CodexCLI.app/Contents/MacOS/codex (--version, --help, `features list`, `app-server generate-json-schema`), run with CODEX_HOME=./work/home
- ~/.codex: directory listing, version.json, session_index.jsonl key names only, shasum of config.toml (unchanged 9f0a87f7...); auth.json not opened
- ~/code/cocheck/src/hosts/codex.ts, src/codex-config.ts, docs/hooks.md

## Our recordings
- codex-run/home/config.toml, codex-run/log-hook.sh, codex-run/payloads-run2.jsonl, codex-run/home/sessions/2026/10/18/rollout-...596f-7f20-8bb8-03992b514e02.jsonl
- codex-schema/ (generated schemas, strings.txt)
- probe-out/codex-0.162.0-alpha.2/ (copied to versions/0.162.0-alpha.2/)

## Additions (2026-10-24)
- https://learn.chatgpt.com/docs/hooks (read 2026-10-24, redirected from developers.openai.com/codex/hooks)
- https://github.com/openai/codex/tree/rust-v0.164.0/codex-rs (hooks/src, config/src; source read 2026-10-24)
- https://github.com/openai/codex/pull/55144 and https://github.com/openai/codex/pull/55657 (read 2026-10-24)
- probe:versions/0.164.0-alpha.11.1/ (live probe 2026-10-24)
