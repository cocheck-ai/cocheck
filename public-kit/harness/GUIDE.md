# Add a harness to CoCheck

CoCheck shows what an AI agent changed in a folder. It learns that from the hooks a harness runs around each of its tool calls. To add a harness you describe those hooks in a manifest and prove the description with a recorded session. This page takes you from nothing to a harness that passes CoCheck's own test (step 4), tries it on your machine (step 5) and ships it (step 6). You need `cocheck` on your PATH and Node 22.18 or newer. The full reference is `spec/v1.md`.

## 1. Start from the scaffold

```text
cocheck harness create myagent
```

This writes a folder `myagent/` with a manifest to fill in, a README and an empty `recordings/` folder. The key (`myagent`) is lowercase letters, digits and dashes, at most 32, and it cannot be a key that already exists.

## 2. Record a real session

Run your harness once with CoCheck's recorder in place of the hooks, on a small task that writes one file, for example "read data.csv, then write totals.csv with the column sums".

```text
cocheck harness record myagent --manifest myagent/cocheck-harness.json --out myagent/recordings -- <the command that starts your harness>
```

The recorder saves `payloads.jsonl` in `--out`: one line for every hook call, exactly as the harness sent it (`{"event", "argv", "stdin", "ts"}`). Real payloads matter: a manifest written from the harness's documentation alone is wrong about something, and the recording is how you find out what.

The command runs in a scratch folder, with the hook config written there only (your own config is never touched), and is stopped after 600 seconds unless you pass `--timeout <seconds>`. The recorder scrubs emails and your home path, and fails rather than write a token-shaped string. It refuses an `--out` that already holds a `payloads.jsonl`.

If the harness needs to be run by hand, leave off `-- <command>`: the recorder prints a scratch folder and the environment to export, you run the harness there, then finish with `cocheck harness record --stop <scratch folder>`.

If you cannot use the recorder, save each hook call's stdin yourself, one per line, in the same shape.

## 3. Write the manifest

Open `myagent/cocheck-harness.json`. Fill in, from your recording:

- `events`: each event name the harness sends, mapped to a kind (`prompt`, `tool-pre`, `tool-post`, `tool-failure`, `stop`, `subagent-stop`). And `eventFrom`: where the name is (a payload path, or the hook command's `--event` argument).
- `fields`: the payload path of the session id, the folder, the tool name, the tool input, the result, the prompt and the closing message. Start with `session`, `toolName` and `toolInput`: that is level 1, and already credits changes to calls.
- `toolClasses`: every tool the harness reports, and what it does (`write`, `edit`, `shell`, `read`, ...). A tool not listed is unknown: its input is not read, and it is credited only by what changed while its call was open. List a tool that never writes as `never-credited`.
- `callId`: where the call id is, or `{ "synthesized": true }` when there is none.
- `failure`: how a failed call looks, to reach level 2.
- `install`: where the harness's hook config is (`{project}` for a config inside the workspace) and what an entry looks like (`entryTemplates` when some events take another shape).

Each step up in level is one more field: see "Levels" and "What degrades without each field" in `spec/v1.md`. A mistake is named by field when CoCheck loads the manifest, for example `myagent/cocheck-harness.json: events.beforeTool: unknown kind "tool-pree"`.

## 4. Write cases and test them

A case is a recorded run plus what CoCheck must make of it (`spec/v1.md`, "Cases"). Copy `examples/toyagent/cases/write-notes.json` and replace its recording with lines from your `payloads.jsonl`:

- Put each line in `recording` with its `argv` (the `--event` words, if the harness does not name its event in the payload).
- Write into `files.before` the files that existed before the session, and into `files.writes` each file a call left behind, after which recorded call (`afterEvent`, counting from 1). A recording holds no file contents, so a stand-in is enough.
- Fill `expect.normalized` with what each event should be (at least `kind` and `session`), and `expect.credit` with each written file, the call it should be credited to, and the basis (`inferred`).

Then run:

```text
cocheck harness test --cases myagent/cases --manifest myagent
```

CoCheck replays each case through the real hook path in a temporary home (your own data and configs are never touched) and prints one line per case. A pass prints `pass  <case>` and the run ends `N cases passed`, exit 0. A failure prints `FAIL  <case>: <the first difference>` and exits 1. What you will probably see:

| Printed | Meaning and fix |
| --- | --- |
| `the manifest did not load: ...` | The manifest has a mistake; the field is named. |
| `call 3 (afterTool): normalized event kind: expected "tool-post", got "tool-pre"` | `events` maps that name to another kind. |
| `file notes.txt: expected credit to call:..., but no state was recorded for it` | The file was not seen to change: check `files.writes` and `afterEvent`, and that the writing tool is in `toolClasses`. |
| `file notes.txt: expected credit to call:a, got call:b` | The credit went to another call: check the call ids (`callId`), or that overlapping calls carry different ids. |
| `expected credit basis host-reported-edit, got inferred` | A harness in your own folder is held to `inferred` (`spec/v1.md`, "Outsider policy"). |
| `holds no credited file` | A case must credit a file, or say in its `description` why it has none (use the words "no credit"). |

## 5. Try it from your home folder

Copy the folder to `<CoCheck data home>/harnesses/myagent/` (the folder holding `cocheck-harness.json`), then install:

```text
cocheck install --for myagent
```

For a harness in your own folder, install prints the config path and the hook entries to add instead of editing your harness's config: add them yourself. Run your harness on a real task, then `cocheck open`. `cocheck status` shows the last event seen from each harness, and names any manifest that was skipped and why.

If your harness also runs another harness's hooks (Cursor runs the Claude hooks in `~/.claude/settings.json`), that other harness's CoCheck hook would record your harness's work under its name. Set `capabilities.readsForeignHooks` to `true` and give a `foreignHookFingerprint` that only your harness's payloads match (a key only it sends, such as Cursor's `cursor_version`). The other hook then skips those payloads, but only while your harness's own CoCheck hook is installed for that folder, so nothing goes unrecorded before you add the entries. `cocheck status` prints a line such as `Claude hook skips payloads from Cursor` while it is in force.

## 6. Ship it

A harness that works and has its cases can be added to CoCheck by a pull request: the manifest under `harnesses/myagent/` at the repository root (a data folder: no code changes), the cases under `public-kit/harness/cases/myagent/`, and the recording they came from. Once built in, a harness may earn the stronger credit bases an outsider cannot, and its cases run with every release.
