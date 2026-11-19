# CoCheck platform knowledge base: format (v1, 2026-10-18)

Each platform gets one folder, `platforms/<key>/`. The keys are `claude-code`, `codex`, `copilot-cli`, `chatgpt-work` and `claude-cowork`. The folder holds:

- `capabilities.json`: the machine-readable facts, in the shape below.
- `guide.md`: plain-language state of the platform. Sections, in order:
  - What it is
  - How it runs on a Mac (install paths, processes, app bundles)
  - Versions seen
  - How CoCheck can observe it (hooks, or whatever else exists)
  - Narration (the model's own words about a step)
  - Session and log files
  - Config and auth locations
  - How to probe it safely
  - Quirks
  - Open questions
- `sources.md`: every URL used, with its fetch date, plus the local paths read.
- `versions/<version>/`: optional real recordings (payloads, session samples) with a short `README.md` saying how they were made.

## The fact rule

Every claim in `capabilities.json` carries:

- `kind`: `documented`, meaning a vendor doc says so, or `observed`, meaning we saw it on this Mac or in a recording.
- `source`: one of
  - a URL, or
  - `local:<path>`, a file we read, or
  - `probe:<path>`, a recording we made, or
  - `binary:<what>`, for strings, `--help` output or schema generation.
- `date`: `YYYY-MM-DD`, the day it was fetched or observed.
- `verified_on`: the platform version it was checked against, or `null`.
- `status`: one of
  - `confirmed`: at least one solid source, nothing against it.
  - `unverified`: a single weak source, or inferred.
  - `contradicted`: the sources disagree. Say how in `note`.

Never state a fact without a source. When we do not know, the fact goes in `open_questions`, not in a guessed value.

## capabilities.json shape

```json
{
  "schema": 1,
  "platform": "codex",
  "name": "OpenAI Codex CLI",
  "vendor": "OpenAI",
  "surfaces": ["cli", "desktop-app-bundled"],
  "checked_on": "2026-10-18",
  "versions_seen": [
    { "version": "0.162.0-alpha.2", "where": "local:~/.codex/packages/...", "date": "2026-10-18" }
  ],
  "cocheck_relevance": "one or two sentences: can CoCheck observe this platform today, and how",
  "install": [ FACT ],
  "processes_and_paths": [ FACT ],
  "auth": [ FACT ],
  "hooks": {
    "available": FACT,
    "config": [ FACT ],
    "trust_or_approval": [ FACT ],
    "events": [
      {
        "name": "PreToolUse",
        "when": "before each tool call",
        "can_block": true,
        "payload_fields": ["session_id", "tool_use_id", "..."],
        "fact": FACT
      }
    ],
    "missing_events": [ FACT ]
  },
  "other_observation_channels": [ FACT ],
  "call_ids": [ FACT ],
  "narration_sources": [
    {
      "name": "commentary message",
      "path": "rollout response_item message phase=commentary",
      "readable_at": "pre",
      "default_on": true,
      "fact": FACT
    }
  ],
  "session_files": [ FACT ],
  "helpers_or_subagents": [ FACT ],
  "limits_and_timeouts": [ FACT ],
  "update_channel": [ FACT ],
  "open_questions": ["..."]
}
```

A `FACT` is:

```json
{
  "claim": "plain sentence",
  "value": "optional machine value",
  "kind": "documented",
  "source": "https://...",
  "date": "2026-10-18",
  "verified_on": "0.162.0-alpha.2",
  "status": "confirmed",
  "note": "optional"
}
```

A field may be an empty list when nothing is known. Do not invent keys at the top level. Put anything extra in `other_observation_channels` or `open_questions`.

## Hook register (v1.1, 2026-10-24)

`claude-code`, `codex`, `copilot-cli` and `copilot-vscode` carry the full hook register: every event the vendor documents, not only the ones CoCheck consumes. The extra keys below are required for those four and optional (empty lists) for the other platforms.

Each `hooks.events[]` entry also carries:

- `name`: the exact name and casing the host uses. `aliases`: other spellings the host accepts (Copilot's PascalCase forms).
- `can_block`: boolean, or `null` when the docs say nothing. `can_rewrite`: whether the hook can change the tool input, tool output, prompt or response (boolean or `null`).
- `timeout_sec`: the default in seconds, or `null` for the host's own default.
- `matcher`: what the matcher is matched against (string), or `null` when the event takes none.
- `payload_fields`: fields read on an official page or a recording. `unverified_fields` (optional): fields guessed or read only through a summary. `absent_fields` (optional): fields the register states the event does not carry.

`hooks` also carries these fact lists:

- `absent_events`: facts whose `value` is a list of event names the host does not have.
- `config_paths`: `value` is `{scope, path}`, scope one of user, repo, managed, plugin, skill, agent.
- `surfaces`: `value` is `{surface, runs_hooks}`, `runs_hooks` true, false or `"unknown"`.
- `skill_and_plugin_paths` and `sandbox_and_network`: free `value`.

A `confirmed` hook fact in those four platforms must rest on an official vendor URL, a `probe:` or `binary:` record, or (kind `observed`) a `local:` file read on this Mac. A research note's `[V]` fact enters `confirmed` only with its URL; `[S]` and `[U]` facts enter `unverified`.

`platforms/discrepancies.json` is `{schema: 1, items: [{id, title, platforms, detail, fact}]}`. `matrix.md` prints it under "Discrepancies". `test/platforms-register.test.ts` fails when a host profile in `src/hosts/` installs an event, or reads a field of its `shape`, that the register marks absent or does not list.
