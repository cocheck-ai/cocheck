# myagent: a CoCheck harness manifest

This folder describes one agent harness to CoCheck. `cocheck-harness.json` is the whole description; it holds data only, no code.
JSON has no comments, so each part of the manifest is explained here. The full reference is `spec/v1.md` in the kit (public-kit/harness/).

## Next three commands

1. Record real hook calls from your harness (it runs in a scratch folder; your own config is never touched):
   `cocheck harness record myagent --manifest ./cocheck-harness.json --out ./recordings -- <your harness command>`
2. Edit `cocheck-harness.json` until the recorded payloads read right (field paths, event names, tool names).
3. Run the cases against it: `cocheck harness test --cases <cases folder> --manifest ./cocheck-harness.json`

To try it for real, copy this whole folder to `<CoCheck data home>/harnesses/myagent/` (or the folder `COCHECK_HARNESS_DIR` names), then run `cocheck status`.
To ship it with CoCheck, open a pull request that adds it under `harnesses/myagent/` at the repository root (data only, no code change).

## What each part means

- `schema`: always `cocheck-harness/1`.
- `key`: the short name; it must equal this folder's name. Lowercase letters, digits and dashes.
- `displayName`, `fullName`, `chip`: the names and the one-letter badge shown to people.
- `testedVersions`: harness versions you have recorded against.
- `events`: the harness's event names, each mapped to a CoCheck kind (`prompt`, `tool-pre`, `tool-post`, `tool-failure`, `stop`, ...).
- `eventFrom`: where the event name comes from: `{"arg": "--event"}` (the hook command names it) or `{"payload": "<path>"}`.
- `unverifiedEvents`: event names you have not seen in a recording.
- `fields`: where each value sits in the payload (`a.b`, `a[0].b`). Only `session` is required; each missing one lowers what CoCheck can tell.
- `toolInputEncoding`: `json-text` when the tool input arrives as JSON text, else `object`.
- `callId`: the call's id path, or `synthesized` to make one up per session.
- `extraFields`: values kept in the record that CoCheck does not act on.
- `failure`: how a failed call looks (flags, text, interrupt) for `tool-failure` and `tool-post`.
- `refine`: rules that change an event's kind when a payload field is present or matches.
- `toolNameStrip`: a prefix taken off tool names.
- `toolClasses`: each tool name mapped to a class (`read`, `write`, `edit`, `shell`, ...) and its path fields. A tool not listed is unknown and still credited by inference; list a tool that never writes as `never-credited`.
- `narration`: where the harness's own words about what it is doing can be read.
- `sessionFile`: where the harness keeps its session file, from the session id.
- `capabilities`: what the harness can do (`failureEvent`, `helperSessions`, `launchKey`).
- `readsConfigsOf`: other harnesses whose hook config this one also reads.
- `sessionEnv`: the environment variable that holds the session id inside a shell call.
- `perAction`: for harnesses that send one event per edit or shell command: the tools and their field paths.
- `hostOwnedFiles`, `hostOwnedWhat`: files the harness writes itself, and a plain phrase for them.
- `install`: the hook config file (`path`, with `{home}` and `{env:NAME|fallback}`), its shape, and the events to install. Outsider install prints the snippet; it does not edit your config.
- `extras`: names of first-party code to opt into. A manifest in your own folder can name only the outsider-safe ones.
- `shape`: extra payload key lists used to tell this harness's payloads from another's.
