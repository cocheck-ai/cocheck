# ChatGPT Work (checked 2026-10-18)

## What it is
Naming (confidence: high that the product is this, medium on launch details): "ChatGPT Work" is a mode of the ChatGPT app (alongside Chat and Codex) described by OpenAI as sharing "core execution, isolation, and permission mechanisms" with Codex. It "brings Codex technology into ChatGPT" for long multi-step tasks over files, apps and tools. Web and mobile Work run in OpenAI's cloud. The desktop app offers Work too, and "Local computer access with Work Cloud" lets cloud-coordinated tasks run steps on the user's Mac. Other products sharing the name space: "dots" (separate always-on agent feature with its own local toggle), Codex threads in the same app, ChatGPT agent/Atlas (Atlas reportedly being sunset, per a secondary source). Documented here: the desktop-app Work/Codex agent that works on local files. Codex itself is covered by the codex folder.

## How it runs on a Mac
/Applications/ChatGPT.app is the former Codex app (bundle id com.openai.codex, BundleSigningBaseName Codex, Electron). It bundles codex-cli 0.162.0-alpha.2, a code-mode host, plugins (browser, computer-use, documents, pdf, presentations, spreadsheets, code-review...), a Computer Use helper app and an app-server on unix sockets under ~/.codex.

## Versions seen
App 26.1002.52244 (build 13536); bundled codex-cli 0.162.0-alpha.2. Local computer access needs app >= 26.929.

## How CoCheck can observe it
- Local-only Work or Codex threads (local orchestration and execution): the Codex hook set (12 events: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, Subagent*, Pre/PostCompact, Interrupt, SessionEnd) via ~/.codex/hooks.json or config.toml. Hooks need user trust (hash-bound).
- Cloud-orchestrated Work, including Work Cloud with local computer access: command hooks and local/plugin hooks are NOT supported; only admin-managed remote mcp_tool hooks. A personal CoCheck cannot use them. Fallback: filesystem effects, plus any local thread records (unexamined).
- Enterprise-only: OpenTelemetry export from the local executor; Compliance API.
- Plugin/MCP: CoCheck could ship as a plugin/local MCP app, but that observes only calls to its own tools.

## Narration
Stop.last_assistant_message and transcript_path (unstable format) in hooks; rollout files in ~/.codex/sessions. Cloud-orchestrated narration has no local source known.

## Session and log files
~/.codex/sessions/YYYY/MM/DD, state_5.sqlite (threads table with rollout_path, cwd, originator, thread_source), session_index.jsonl, logs_2.sqlite. App logs under ~/Library/Logs/com.openai.codex/YYYY/MM/DD (not opened).

## Config and auth locations
~/.codex/config.toml (MCP, plugins, hooks), ~/.codex/hooks.json (absent now), auth.json (not opened), managed requirements.toml.

## How to probe it safely
No probe done. Safe approach: scratch CODEX_HOME with a hooks.json logging stdin, one local-only thread; compare originator in state_5.sqlite. Hash real config first.

## Quirks
Docs do not say ChatGPT Work by name in the hooks page; they say Work Cloud, dots, local Work and Codex threads. Work and Codex history are not merged.

## Open questions
See capabilities.json open_questions.
