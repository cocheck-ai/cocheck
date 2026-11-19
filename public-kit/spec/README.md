# CoCheck connector specification

Status: v1, experimental. Names and shapes can still change between releases, and a change that breaks a connector will be listed in the release notes. Spec identifier: `cocheck.connector/1`. The change list a connector answers is `cocheck.changes/1`.

A connector teaches CoCheck about one product that CoCheck does not read itself: a notes app, an issue tracker, a document store. CoCheck records that an agent changed something in that product. The connector is the small program that says what the change was. This page is the whole specification. If you want a short walk-through first, read [../GUIDE.md](../GUIDE.md). The toy product in `../toy-product/` gives you recorded before and after states to practice on.

A connector is a folder with two things: a manifest (`cocheck-connector.json`) and a program. CoCheck starts the program, sends it one JSON message per line on standard input, and reads one JSON answer per line from standard output. The program never talks to CoCheck any other way.

There are four kinds of connector, named by the manifest field `entry`. A state connector (`state`) can read the full state of a thing on demand, and answers `diff` over two state files. A diff connector (`diff`) cannot read a state but can list the changes that happened in a time window. A connector with entry `both` offers both. An export connector (`export`) only prints the item as text, and CoCheck works out the change; see [Export entry](#export).

The change document (the list of changes, its fields, marks, pictures and anchor systems, and fifteen examples) is defined in [v1.md](v1.md). That file is part of this specification: this page says how a connector is built, tested and chosen, and v1.md says what the change list contains.

<a id="manifest"></a>
## Manifest

The manifest is one JSON object in a file named `cocheck-connector.json`, at the top of the connector folder. Installed connectors live in `connectors/<id>/` under the CoCheck home folder; see [Installing](#installing).

```json manifest
{
  "spec": "cocheck.connector/1",
  "id": "toy-notes",
  "version": "0.1.0",
  "entry": "state",
  "matches": { "extensions": [".notes.json"] },
  "run": ["node", "connector.mjs"],
  "credentials": [],
  "platforms": ["darwin", "win32"],
  "requires": { "binaries": ["node"] },
  "beforeReadMs": 1500,
  "permissions": { "env": ["NOTES_REGION"] }
}
```

Fields:

- `spec` (required): the text `cocheck.connector/1`.
- `id` (required): a short unique name, such as `toy-notes`. Letters, digits, `.`, `_` and `-`, starting with a letter or digit.
- `version` (required): your own release number, as text.
- `entry` (required): `state`, `diff`, `both` or `export`.
- `matches` (required): what the connector handles. It is an object with at least one non-empty list from `extensions`, `schemes`, `mcpServers` and `mcpTools`. Every list holds text items.
  - `extensions`: the file types the connector claims to view, as file endings, such as `.notes.json`. Claiming a type does not by itself make the connector the one used for it: per type, at most one connector is enabled, and the user can see and change which with `cocheck connector list` and `cocheck connector enable|disable <id> <ending>`. By default, a connector that claims a type a built-in connector also claims, or one of CoCheck's own endings (plain text, Markdown, csv, pdf, Office and picture endings, such as `.md`, `.pdf` or `.png`, and longer endings of them such as `.notes.md`), starts disabled for it until the user enables it. Every other type, including code, `.json` and the other text formats CoCheck reads by content, goes to the connector that claims it unless the user changes it. See [One winner](#one-winner).
  - `schemes`: URI schemes, such as `notes`, for things that are not files. A subject like `notes://page/abc` belongs to the connector that names `notes`.
  - `mcpServers`: names of MCP servers whose write tools the connector covers.
  - `mcpTools`: single tool names, either `tool` or the full `mcp__server__tool` form.
  - `subjects` (optional): an object from a full MCP tool name to a template that turns the tool's input into a subject. A template is text with `{field}` or `{field:hex}` parts, for example `"notes://page/{page_id:hex}"`. A field is word characters only. `{field:hex}` reads the field as an id that may be written with or without dashes.
  - `calls` (optional): tools that create an item, whose id exists only in the tool's answer. See [Items a tool creates](#items-a-tool-creates).
- `run` (required): how to start the program, as a list of text items: the program first, then each argument as its own item. There is no shell, so write `["node", "connector.mjs"]`, not `"node connector.mjs"`. Instead of one list you can give an object from platform name (`darwin`, `win32`) to a list; see [Platforms](#platforms).
- `credentials` (optional): a list of objects, each with a `name`. See [Credentials](#credentials).
- `platforms` (optional): a list of platform names the connector runs on. CoCheck checks that it is a list of text and does not act on it yet.
- `requires` (optional): an object with the lists `apps`, `binaries` and `runtimes`, naming what must be installed on the machine, and the text `session`, which may only be `"desktop"` (the connector needs a logged-in desktop session). CoCheck checks that each list is a list. `cocheck connector test` acts on `session` and `binaries`: when one is unmet it prints `unverified` and runs nothing. `apps` and `runtimes` document your connector for a person.
- `beforeReadMs` (optional): how long, in milliseconds, CoCheck waits for the connector to read the "before" state of a call. A whole number from 0 to 3000. When it is absent the wait is 1500.
- `diffMs` (optional): how long, in milliseconds, CoCheck waits for the answer to one `diff` (or `export`) request, in a capture and in `cocheck connector test` (unless `--timeout` is given). A whole number from 1 to 60000. When it is absent the wait is 10000.
- `permissions` (optional): an object with one field, `env`: a list of environment variable names. CoCheck starts the connector with those variables and a fixed base set, nothing else.

`openInProduct`, `permissions.network` and `permissions.files` (the `network` and `files` fields) are not part of v1. CoCheck never drew a link into the product and never enforced a network or file rule, so a manifest that still has one is refused with a message naming the field: remove it.

A field that is not listed here is ignored, so a manifest can carry your own notes. A mistake in a listed field is reported with the field's path, what was expected, what was found, and one sentence that fixes it. A manifest without the optional fields is valid.

<a id="items-a-tool-creates"></a>
### Items a tool creates

A `subjects` template reads the tool's input, so it cannot name an item that does not exist yet. For a tool that creates an item, name the tool in `matches.calls` instead, with a template that reads the tool's answer:

```json manifest
{
  "spec": "cocheck.connector/1",
  "id": "my-vendor",
  "version": "0.1.0",
  "entry": "state",
  "matches": {
    "schemes": ["my-vendor"],
    "calls": {
      "mcp__myvendor__create_note": { "subjects": [{ "from": "response", "template": "my-vendor://note/{note.id}", "created": true }] }
    }
  },
  "run": ["node", "connector.mjs"]
}
```

- Each tool has exactly one entry in `subjects`, with `"from": "response"` and `"created": true`. Anything else, or a tool also named in `matches.subjects`, is a manifest problem that says it is not supported yet. Other keys inside a tool's object are ignored.
- A template is text with `{path}` or `{path:hex}` parts. A path is word parts joined by dots, such as `{note.id}`. There is no `[]`.

CoCheck reads the answer into an object by its shape, in this order:

1. the answer's `structuredContent`, when it is an object;
2. else its content, when it holds exactly one text block and that text parses as a JSON object;
3. else the answer itself, when it is text that parses as a JSON object.

Otherwise the template does not render. An answer marked `isError: true`, and a call that failed, give no subject and no row. An answer over 1 MiB is not read.

After a successful call CoCheck renders the subject, sends your program `snapshot` once for the after state, and records the change as a creation. Your `created: true` is a claim: when CoCheck already holds a state for that item in the task, that state is the before side, not "did not exist". A successful call whose answer does not name the item shows on the page as a gap: "This change wasn't recorded, because the tool's answer didn't name the item."

Mark a tool `created: true` only if it can never return an item that already exists. `created` is your statement, and CoCheck trusts it unless it has its own record of the item. One case is not covered: if an earlier call in the same task read the item and then failed, was stopped, or is still running, and your tool then returns that item, CoCheck shows it as created and does not show what was there before.

The test needs `samples/calls.json` in the connector folder: a list of `{ "tool", "response", "expect" }`, one or more per tool in `calls`. `response` is the answer as the tool returned it, and `expect` is the subject it should name. The test renders each and compares. A tool with no sample prints `untested` and exits 1.

<a id="hello"></a>
## Hello

The first message CoCheck sends is always `hello`. Your program answers it before anything else.

Every message is one line of JSON. A request has an `id` (a whole number), a `method` and `params`. CoCheck sends:

```json message
{"id": 1, "method": "hello", "params": {}}
```

A connector with credentials gets them here, and nowhere else: `params` is then `{"credentials": {"<name>": "<value>"}}`. Your program answers with the same `id` and a `result`:

```json hello
{
  "id": 1,
  "result": {
    "spec": "cocheck.connector/1",
    "level": 1,
    "methods": ["snapshot", "diff"]
  }
}
```

The `result` fields:

- `spec` (required): the text `cocheck.connector/1`.
- `level` (required for a change-list connector): `1`, `2` or `3`, the most your answers contain. See [Levels](#levels). An export connector declares no level.
- `methods` (required): the methods your program answers besides `hello`. A connector with entry `state` or `both` lists `diff`, a connector with entry `diff` lists `diffs`, and a connector with entry `export` lists `export`. `snapshot` is optional; see [Snapshot](#snapshot).
- `payloads` (optional): a note for people. CoCheck does not read it.

`hello` must be answered within 10 seconds. The conformance tests ask for 5.

<a id="diff-answer"></a>
## Change-list answer

For a state connector, CoCheck asks `diff` with two files: the state before and the state after. Both are paths on the local disk. The params are `{"before": "<path>", "after": "<path>"}`. The answer is a change document, `cocheck.changes/1`:

```json changes
{
  "spec": "cocheck.changes/1",
  "changes": [
    {
      "id": "n1",
      "mark": "changed",
      "label": "Note n1",
      "before": "buy milk",
      "after": "buy oat milk"
    }
  ],
  "caveats": []
}
```

The document has:

- `spec` (required): the text `cocheck.changes/1`.
- `changes` (required): a list, empty when nothing changed. Each change has an `id` (unique in the document), a `mark` (`added`, `removed`, `changed`, `moved` or `described`), a `label` (where it is, in words) and `before` and `after` in words, leaving out the side that does not exist. The other change fields are in [v1.md](v1.md).
- `pictures` (optional, level 2 and up): see [Levels](#levels).
- `caveats` (optional): a list of short sentences for anything the reader should know, such as "page 2 of history was not read".

An empty file is a state that did not exist. A thing that was just created has an empty before file, and a thing that was deleted has an empty after file. Answer an `added` change with no `before` for the first and a `removed` change with no `after` for the second, and answer an empty list when both files are empty. An empty file is not a broken file: do not answer it with an error. An error is for content you cannot read, such as a cut-off or invalid state.

Who made a change is CoCheck's decision, because only CoCheck knows which call wrote the file. A connector never says it.

The same answer must come back every time. The tests ask five times: no field may depend on the time, on a random number, or on the operating system.

A change that fails the check is rejected with a message that names the field. This answer gives a change a mark that does not exist:

```json bad-changes
{
  "spec": "cocheck.changes/1",
  "changes": [
    { "id": "n1", "mark": "new", "label": "Note n1", "after": "buy oat milk" }
  ]
}
```

and the message is:

```text rejected
changes[0].mark: expected one of "added", "removed", "changed", "moved", "described", found "new"
fix: Set mark to "added", "removed", "changed", "moved", "described".
```

<a id="levels"></a>
## Levels

A change document comes in three levels, and each is complete on its own: a connector can stop at level 1 and still be fully drawn. Every change keeps its level-1 fields at every level.

1. Level 1, a change list: each change has a `label`, a `mark`, and `before` and `after` in words. CoCheck draws a card for each. No pictures.
2. Level 2 adds `pictures`: what can be shown for each side. CoCheck shows them beside the cards.
3. Level 3 adds `boxes` on a change: where the change sits on a picture, in pixels (`image`), cells (`grid`) or text lines (`text`). CoCheck outlines the change in place.

Picture content has one carrier rule for `html`: an `html` picture's markup is given only as a `data:text/html,...` address in its `src`. CoCheck draws it in a sandboxed frame and never anchors a box on it, and any other `src` on an `html` picture is dropped. A `text` picture with no content of its own is drawn from CoCheck's stored state, as numbered lines.

The fields, the five marks, the picture types and anchor systems, and one example per mark at each level are in [v1.md](v1.md). The page says "Change list from <name>" for level 1 and "Picture from <name>" for levels 2 and 3.

<a id="export"></a>
## Export entry

A manifest with `"entry": "export"` names a connector that does not diff. CoCheck calls the method `export` with `{ "subject": "..." }`. The connector answers the item as plain text, or `null` when the item does not exist:

```json message
{"id": 5, "result": {"text": "n1: buy milk\nn2: call the plumber\n"}}
```

CoCheck stores the text of the before and after states and draws the difference with its own text renderer. The page says "Drawn by CoCheck from the text". An export connector declares no `level`, and its `hello` lists `export` in `methods`. Make the text the same every time for the same state. A malformed product state is answered with an error, never with empty text.

<a id="errors"></a>
## Errors

Answer a request you cannot serve with an error in place of a result:

```json message
{"id": 7, "error": {"code": "bad-product-response", "message": "the notes file is not valid JSON"}}
```

`error` is an object with a short `code` and a `message` for a person, or just a string. CoCheck shows your message, so keep credentials out of it. Use `unknown-method` as the code for a method you do not know.

An error is the right answer for a broken input. An empty list of changes means "nothing changed", and CoCheck believes it, so never answer a state you could not read with an empty list. A malformed state must produce an error.

Keep running after an error. Each request has a timeout (10 seconds in `cocheck connector test` and when CoCheck captures a file change, 20 seconds when CoCheck diffs for a person, 30 seconds for the large pair in the conformance tests; the manifest's `diffMs` replaces the first two for `diff` and `export` requests). A program that does not answer in time is stopped and not restarted, and a program that exits stays down. A single output line over 16 MB stops the connector too.

Write notes for yourself to standard error. Standard error, and any standard output line that is not a JSON reply, are kept as the connector's log, with credential values replaced by `[redacted]`.

<a id="credentials"></a>
## Credentials

List what the connector needs in the manifest: `"credentials": [{ "name": "token" }]`. The `name` is the key your program finds the value under.

The person using your connector stores each value once, with `cocheck connector auth <id> --name <credential>`. The value is read from standard input, never from a command-line argument, and it goes into the operating system's secret store (the macOS Keychain, or the Windows Credential Manager). Add `--delete` to remove it.

CoCheck reads every declared credential before it starts your program, and refuses to start the connector if one is missing. It sends the values in the `hello` request, in `params.credentials`, and nowhere else: not in arguments and not in files. Keep the value in memory, send it only to the product's own address, and never print it. The conformance tests plant a fake token and fail the connector if it shows up in an answer, in `hello` or in the log.

<a id="snapshot"></a>
## Snapshot

A state connector that covers things that are not files (a page in a web product, for instance) answers `snapshot`. CoCheck asks for the state of a subject before and after an agent's call, stores both, and later asks `diff` over the two.

```json message
{"id": 3, "method": "snapshot", "params": {"subject": "toy://notes/list"}}
```

The answer is the full current state of the subject as text, or `null` when the thing does not exist:

```json message
{"id": 3, "result": {"subject": "toy://notes/list", "state": "{\"notes\":[{\"id\":\"n1\",\"text\":\"buy milk\"}]}"}}
```

Rules:

- `subject` (required) echoes the subject you were asked about.
- `state` (required) is a string, or `null` for a missing thing. Any other type is rejected.
- Null means only that the thing positively does not exist; a read that could not be done is an error. Answer a failed read (no credentials, no access, the product unreachable, an I/O error) with an `error`, never with `null`: CoCheck records a `null` before and a real after as a created thing.
- Make the text canonical. The same state must always give the same text, so write JSON with sorted keys and leave out fields that change on every read, such as an expiring link or a read time. CoCheck stores the bytes exactly as you send them and identifies a state by the SHA-256 of its UTF-8 bytes, so a field that changes on every read makes every read look like a change.
- Answer fast. The state before an agent's call is read under the budget `beforeReadMs` (1500 milliseconds unless the manifest says otherwise), and a connector that is slower gives CoCheck no before state for that call.

For subjects that are files, CoCheck reads and stores the file itself and does not call `snapshot`.

<a id="diffs"></a>
## Diffs for diff-entry connectors

A connector with entry `diff` has no state to read. A product that keeps its own change history (an issue tracker, for example) can say what changed in a window instead. CoCheck asks after an agent's call, with the window of that call:

```json message
{"id": 4, "method": "diffs", "params": {"subject": "tracker://issue/ABC-12", "since": "2026-11-07T14:00:00.000Z", "until": "2026-11-07T14:00:09.000Z"}}
```

`subject` is the thing the call wrote. `since` and `until` are ISO 8601 times. `since` is the start of the call and `until` is its end plus five seconds, which absorbs a product's slow clock and write delay. Return the entries whose own time falls in `since <= time < until`, and decide membership by the time alone, whoever made the entry.

The answer is a change document, exactly as in [Change-list answer](#diff-answer). A change for a field that moved is usually a `changed` mark with the old and new value in words:

```json changes
{
  "spec": "cocheck.changes/1",
  "changes": [
    { "id": "state", "mark": "changed", "label": "Status", "before": "Todo", "after": "In Progress" }
  ],
  "caveats": []
}
```

An empty `changes` list records nothing. A history entry you cannot place in the window, or a field you cannot read, belongs in `caveats` or in a `described` change, not in a guess presented as exact. A read you could not do (no credentials, no access, the product unreachable) is an `error`, never an empty list: an empty list says nothing changed, and the change would be lost.

<a id="diff-samples"></a>
### Samples for the test

`cocheck connector test` cannot see your product's history, and it never invents a window. You supply the samples. Put a `samples` folder in the connector folder with a file `samples.json` and the history you recorded from your product beside it, in any form your program reads. Each sample is the `params` of one `diffs` request and the `class` you say it is:

- `changed`: a window in which the item changed. The answer must hold at least one change.
- `no-change`: a window in which nothing changed. The answer must hold no change.
- `failed-read`: a request your product cannot answer (an item you may not read, for example). The answer must be an error, never `null`, an empty document or a document that says nothing changed.

```json samples
{
  "samples": [
    { "class": "changed", "params": { "subject": "toy-tracker://issue/ABC-12", "since": "2026-11-07T14:00:00.000Z", "until": "2026-11-07T14:00:09.000Z" } },
    { "class": "no-change", "params": { "subject": "toy-tracker://issue/ABC-12", "since": "2026-11-07T15:00:00.000Z", "until": "2026-11-07T15:00:09.000Z" } },
    { "class": "failed-read", "params": { "subject": "toy-tracker://issue/ABC-99", "since": "2026-11-07T14:00:00.000Z", "until": "2026-11-07T14:00:09.000Z" } }
  ]
}
```

At least one sample of each of the three classes is required. More samples, and samples of another class, are welcome: each one is sent and graded, and a class other than the three is graded only on the checks every answer gets. While the test runs, the variable `COCHECK_TEST_SAMPLES` names the `samples` folder: answer from the history recorded there instead of calling the product, as `COCHECK_TEST_STATES` does for a snapshot connector. The kit's `examples/toy-tracker` is a working one, with its history in `samples/history.json`.

<a id="platforms"></a>
## Platforms

CoCheck runs on macOS and Windows, and a connector should not care which.

- Launch: CoCheck starts your program from the `run` list with no shell, in the connector's own folder. Relative paths in `run` resolve from that folder. Do not rely on a `#!` line. A bare program name (`node`, `python3`) is looked up on the `PATH`, and on Windows with the `PATHEXT` endings. A `.cmd` or `.bat` file works on Windows but is discouraged.
- Per platform: when the programs differ, give `run` as an object from `darwin` or `win32` to a list. A platform with no entry cannot run the connector.
- Messages: one JSON message per line on standard input and standard output, UTF-8. A trailing carriage return is tolerated, so a Windows program that writes `\r\n` is fine. Never print anything else to standard output.
- Paths: the files in a `diff` request are ordinary local paths in the platform's own form. Do not assume `/` or a drive letter.
- Bytes: do not normalize line endings or text encoding in a state. CoCheck compares the exact bytes.
- Same answer everywhere: given the same states, your program must give byte-identical output on all three systems. The conformance tests compare a hash of the canonical answer to one recorded value.

<a id="testing"></a>
## Testing your connector

Four commands help you build and install one:

```text
cocheck connector create <dir> --id <id>
cocheck connector test <dir> [--states <dir>] [--timeout <ms>]
cocheck connector test <dir> --cases [<casesDir>]
cocheck connector doctor [<id>]
```

`create` writes a starter project that already passes at level 1. `test` has two modes, below. `doctor` checks an installed connector (the one named, or all of them) and says what is wrong with its setup; see [Installing](#installing).

Mode one, the state pairs (no `--cases`). The command checks the manifest and `hello`, then runs five state pairs from the toy product, or from the folder you give with `--states`. For a product that is not the toy notes, always give `--states` with pairs of your own product: the toy pairs are notes files, and your program cannot read them. A pair is two files named `<name>.before.json` and `<name>.after.json`. The names are fixed and end in `.json` whatever format your product uses: put iCalendar, CSV or any other text in files with these names. All five pairs must be present. Your connector answers `diff` over each, and the connector must return:

- `create`: a change with the mark `added`.
- `edit`: a change with the mark `changed`.
- `delete`: a change with the mark `removed`.
- `no-change`: the two states are the same, so the answer is an empty `changes` list.
- `malformed`: the after state is broken (cut off, not valid). The right answer is an error. An empty list of changes here is reported as a problem, because it would call a broken input "no change".

A missing or partial states folder is not a pass. The same run also checks that nothing credential-shaped appears in `hello`, in an answer, or in the log. `test` prints one block per problem, with the file, the field, what was expected, what was found, a fix and the section of this page to read, then either `passed` or the number of problems. It exits 0 only on `passed`.

<a id="conformance-levels"></a>
### Conformance per level

`cocheck connector test <dir>` grades a connector that declares a level at that level, and prints the level passed (`level 3 passed`, or `level passed: 2 (declared 3)` and exit 1). The checks are exactly these:

- Levels 1 and 2: the document is valid at the declared level (the document holds nothing above the level declared in `hello`: a picture is level 2 and a box level 3; every change has its fields, the marks are the five marks, every `id` is unique), and the same pair answered again gives an identical document (five runs). Level 2 adds that pictures are well formed.
- Level 3 adds: every box resolves in its picture's system (an image `rect` or `highlights` rectangle is inside the picture's `width` and `height`; a grid `cell` is inside the picture's `rows` and `cols`; text `lines` and `range` are inside the text of that side's state file); and a box over identical before and after pixels is demoted, with the warning "this box may not point at a real change", never silently. A demoted box means the connector did not earn level 3. A declared level the documents never reach (level 3 with no boxes on any pair) fails: the level printed is the one the documents hold. Pictures whose pixels cannot be read give a warning that no pixel check ran, not a pass or a demotion.
- Every answer depends on the states: the `edit` pair is asked again with its two sides swapped, and an answer identical to the first fails. A `changed` change on `edit` carries a `before` and an `after` in words, and they differ. A create is asked against an empty before file and a delete against an empty after file (production sends an empty file for a side that does not exist); an error on either fails.
- A connector with a `matches.subjects` template is asked `snapshot` of the URI the template makes for each state (the name of the pair and side where the template has a field, hex-encoded for `{field:hex}`), with `COCHECK_TEST_STATES` set to the states folder so the connector can answer from `<name>.json` there instead of the product, and `diff` runs on the states it answered. A template with no `snapshot` answer fails. A connector with only file endings is given the state files themselves, as CoCheck gives it the bytes of a file.
- On every pair, an `added` change for `create`, `changed` for `edit`, `removed` for `delete`, no change for `no-change`, and an error for `malformed`.
- An export connector is graded on its `export` answers: valid, the same text every run, a different text for each pair that changes, the same text for the pair that does not, an error for the malformed state, and text CoCheck can draw. An export that is only the file's own text, unchanged, on every pair is flagged and fails: CoCheck already draws a line diff of a text file. A connector with a template is asked `export` of the template's URI. It prints `export: CoCheck draws the difference of the exported text`.

Mode two, the conformance cases (`--cases`). The command runs the conformance cases `C1` to `C16` from `<casesDir>`, which is the kit's `conformance/cases` when you leave it out. It prints one line per case with the case id, `pass` or `fail`, and the reason, and exits 0 only when every case passes. `--cases` replaces the state-pair run: the two modes are separate runs, so run both. The cases are described in `../conformance/`.

A connector with entry `diff` is checked in mode one on its manifest and `hello`, then sent `diffs` from the samples you supply (see [Samples for the test](#diff-samples)); `--states` does not apply to it. Each sample is sent five times. Every answer must be the same, and the document must pass the checks of the level `hello` declares, or below: a `changed` sample holds at least one change, a `no-change` sample none, and a `failed-read` sample is an error. A missing class, or no samples at all, is not a pass: the output names what was not tested on lines starting `untested:`, ends with `untested`, and exits 1. The output says once that the answers came from your recorded history and that the live product was not contacted. Passing proves your connector reads the history you recorded; it does not prove the history matches the live product.

Read these limits before you trust a green run:

- The test does not deny network. Case C10 sets proxy variables to a closed port and an offline flag, which stops a polite connector but not one that opens a socket itself. Treat C10 as best-effort.
- Memory is not measured. Case C13 checks the time bound on a large pair (5000 notes, 500 changes, 30 seconds) but not the memory limit its file names.
- Connector processes are not sandboxed. The tests run your program with your own permissions and the same environment as CoCheck.
- Passing the tests does not prove a connector right. It proves the checks above, on the pairs given.

<a id="installing"></a>
### Installing

To install a built connector, copy its folder (the one with `cocheck-connector.json` at its top) to `connectors/<id>/` under the CoCheck home folder (the folder named by `$COCHECK_HOME`, else `~/.cocheck`), where `<id>` is the `id` in the manifest. Then run `cocheck connector doctor <id>`: it reads the manifest in that folder and reports what is wrong, or that the connector is fine. If the connector declares credentials, store each one with `cocheck connector auth` first; see [Credentials](#credentials).

<a id="one-winner"></a>
## One winner

When two installed connectors match the same call or subject, exactly one is used. The order, by what the manifest matched on: `matches.mcpTools`, then a `matches.subjects` template, then `matches.mcpServers`, then `matches.schemes`, then `matches.extensions` (the longest ending wins, so `.notes.json` beats `.json`). A tie goes to the first folder by name. `cocheck connector doctor` and `cocheck connector test` print a warning for every overlap, naming the winner and the losers.

For a changed file, only connectors enabled for the file's type take part: a file goes to the connector enabled for the longest ending it has, and with none enabled CoCheck draws it with its own readers. By default an installed connector is not enabled for CoCheck's own endings or for a type a built-in claims; it is enabled for any other type it claims, code and other text formats included. CoCheck's default rule, the full list of its own endings and the setting are in [v1.md, One winner](v1.md#one-winner).

<a id="security"></a>
## Security

A connector is a program you run, with your permissions, just like an editor extension. Install only connectors you trust. CoCheck starts a connector without any sandbox and does not limit what it can read, write or send. The protections below are about what a connector can do to CoCheck's own page, not about the connector process.

- Credentials go only to the connector that declared them, in `hello`, and are redacted from the connector's log. See [Credentials](#credentials).
- The connector never says who made a change. See [Change-list answer](#diff-answer).
- A level 2 or 3 picture of type `html` or `image` is drawn in a frame served from a second local address, separate from the review page. The frame carries the policy `default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`: no scripts, no network requests, no form submission, and only inline styles and `data:` images. The markup is shown as written, so do not count on CoCheck to clean it; leave scripts, external links and external resources out.
- HTML is limited to 512 KiB and an image to 4 MiB. Text in a change is shown as text, never as markup.

<a id="versioning"></a>
## Versioning

The spec identifier is `cocheck.connector/1`. This is version 1 and experimental: the `1` in the identifier is the first major version of the contract, and it will not change for an addition. New optional fields, new levels and new methods can appear at any time, and CoCheck ignores a field it does not know, so your connector should do the same with what it receives.

A change that would break a working connector (a field removed, a meaning changed, a required field added) gets a new identifier, `cocheck.connector/2`, and CoCheck will keep reading `/1` connectors for a published period. Until the spec leaves "experimental", expect smaller breaks and read the release notes. Set your own `version` in the manifest on every release.

A `diff` answer must be a `cocheck.changes/1` document. An answer in the older shape (`changes` entries with `kind`, `anchors` and `confidence`) is refused with a message saying so.

Known gaps:

- A diff-entry connector cannot pass `--cases`: the conformance cases are state pairs. Its `diffs` answers are graded in mode one, on your samples.
- The state pair file names `<name>.before.json` and `<name>.after.json` are fixed, whatever the product's format.

<a id="thinking-about-not-built"></a>
### Thinking about, not built

These are ideas we are thinking about. None of them is built, and there is no date for any of them.

- One call that touches many items.
- The service's own revision number, stored with a snapshot.
- Work that finishes after the call returns.
- A connector naming the items itself when the tool's answer is prose, not JSON.

If one of these would be valuable to you, please open an issue and tell us what you would use it for.
