# Build a CoCheck connector

CoCheck shows what an AI agent changed: the item before, the item after, and the change marked. For products CoCheck cannot read itself, you write a connector. A connector is a small program that is given two saved states of one item and answers a list of what changed, in words. This page takes you from nothing to a connector that passes CoCheck's own test (step 4). You need `cocheck` on your PATH and Node 22.18 or newer. Any language works; the examples use Node.

## 1. Record five pairs of states

Save real files from your product into a folder `states`, as five pairs. Each pair is `<name>.before.json` and `<name>.after.json`. The names are fixed and end in `.json` even when your product's format is not JSON.

- `create`: the second file has one more thing than the first.
- `edit`: one thing differs between the two files.
- `delete`: the second file has one less thing.
- `no-change`: both files are the same.
- `malformed`: the second file is broken (cut off, not valid).

## 2. Write the manifest

In a new folder `my-connector`, save this as `cocheck-connector.json`:

```json manifest
{
  "spec": "cocheck.connector/1",
  "id": "my-connector",
  "version": "0.1.0",
  "entry": "state",
  "matches": { "extensions": [".mything.json"] },
  "run": ["node", "connector.mjs"]
}
```

- `id` is a short name: letters, digits, `.`, `_`, `-`. `entry` is `state`: your program compares two state files.
- `matches` says what you handle: a file ending (CoCheck reads the file and gives you its bytes), or, for a product the agent reaches through MCP, the `mcpServers` and `subjects` of the section "A product reached through MCP" below.
- `run` is the program first, then each argument as its own item. It is a list, not one string.

## 3. Write the program

CoCheck starts your program and talks to it in lines: one JSON message per line on standard input, one JSON answer per line on standard output. Print nothing else to standard output; write notes to standard error. The first message is `hello`:

```json message
{"id": 1, "method": "hello", "params": {}}
```

Answer it with the same `id`, and declare `level` 1 (a change list in words):

```json hello
{"id": 1, "result": {"spec": "cocheck.connector/1", "level": 1, "methods": ["diff"]}}
```

Then CoCheck asks for `diff`. `before` and `after` are paths to two state files:

```json message
{"id": 2, "method": "diff", "params": {"before": "/tmp/a.json", "after": "/tmp/b.json"}}
```

You answer a change list, `cocheck.changes/1`:

```json changes
{
  "id": 2,
  "result": {
    "spec": "cocheck.changes/1",
    "changes": [
      { "id": "n1", "mark": "changed", "label": "Note n1", "before": "buy milk", "after": "buy oat milk" }
    ]
  }
}
```

Each change has:
- `id`: unique in the answer.
- `mark`: one of `added`, `removed`, `changed`, `moved`, `described`.
- `label`: where it is, in words.
- `before` and `after`: the old and new content in words. Leave out the side that does not exist.

Answer `"changes": []` when nothing you list changed. To have CoCheck say "saved again, nothing changed" for it, add `"nothingChanged": true` to your hello answer; then answer `"changes": []` only when you compared everything, and when the states differ in something you do not read, list one `described` change in your own words. CoCheck keeps the files your connector claims whole, up to 1 GB and 2,000 files a task, so a plain re-save reaches you with both sides. Your empty `"changes": []` for it is how it stays quiet: a muted step for the agent that saved, and no stop at all when no single agent did. Two optional fields: `"issues": [{ "text": "the total no longer adds up", "where": "Note n2" }]` lists problems you found in a state, and `"more": 3` says how many changes you left out of the list (spec/v1.md has both). To refuse a request, answer an `error` with a `code` and a `message` instead of a `result`. A complete program (change `readState` to read your product's files):

```js
import readline from "node:readline";
import { readFileSync } from "node:fs";

// Turn one state file into a Map of id -> words. An empty file means "did not exist".
function readState(file) {
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return new Map();
  const state = JSON.parse(text); // a broken file throws, and the loop below answers an error
  return new Map(state.notes.map((n) => [n.id, n.text]));
}

function diff(beforeFile, afterFile) {
  const b = readState(beforeFile), a = readState(afterFile), changes = [];
  for (const [id, text] of a) {
    if (!b.has(id)) changes.push({ id, mark: "added", label: `Note ${id}`, after: text });
    else if (b.get(id) !== text) changes.push({ id, mark: "changed", label: `Note ${id}`, before: b.get(id), after: text });
  }
  for (const [id, text] of b) if (!a.has(id)) changes.push({ id, mark: "removed", label: `Note ${id}`, before: text });
  return { spec: "cocheck.changes/1", changes };
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  let reply;
  try {
    if (msg.method === "hello") reply = { result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"] } };
    else if (msg.method === "diff") reply = { result: diff(msg.params.before, msg.params.after) };
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) {
    reply = { error: { code: "bad-product-response", message: String(err.message) } };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
});
```

Save it as `my-connector/connector.mjs`. Shortcut: `cocheck connector create my-connector --id my-connector` writes a starter for the toy notes product.

The test checks that the same two files give the identical answer every time (no clock, no random numbers), that a broken state gives an error and never an empty list, and that an empty file is a thing that did not exist, not an error: CoCheck sends an empty file for a side that does not exist, so the test asks your program a create against an empty before and a delete against an empty after. It also swaps the two states of the `edit` pair and fails an answer that stays the same, because an answer that does not depend on the states shows nothing about the product. A "changed" change must say what it was (`before`) and what it became (`after`).

## 4. Test it

```text
cocheck connector test ./my-connector --states ./states
```
Always pass `--states`. Without it the test uses a built-in toy notes product, and your program cannot read those files. A pass prints `level 1 passed`, then `passed`, and exits 0. A failure prints one block per problem and exits 1. What you will probably see:

| Printed | Meaning and fix |
| --- | --- |
| `found a missing state file` | One of the five pairs is not in `states`. |
| `found an error` on `create`, `edit`, `delete` | Your program threw on a state file. Check `readState`, or you forgot `--states`. |
| `an error for a malformed state` | You answered the broken file with a list. Throw instead. |
| `a different answer when the before and after states are swapped` | The answer does not depend on the states. Read the two files and report what differs. |
| `an answer when one side is an empty file` | Your program threw on an empty file. Read an empty file as an item that does not exist. |
| `expected one of "added", "removed"` | `mark` is a word that is not one of the five. |
| `run: expected a non-empty list of strings` | `run` is one string. Make it a list. |

## The no-protocol option: export

If you would rather not compare states, print the item as text and let CoCheck draw the difference. Set `"entry": "export"` in the manifest. Your `hello` answer lists `"methods": ["export"]` and has no `level`. CoCheck asks:

```json message
{"id": 3, "method": "export", "params": {"subject": "/tmp/a.json"}}
```

You answer the whole item as plain text, or `null` for an item that does not exist. A broken item is an error, not empty text:

```json message
{"id": 3, "result": {"text": "n1: buy milk\nn2: call the plumber\n"}}
```

Make the text the same for the same state, then run the same `cocheck connector test ./my-connector --states ./states`. Export what the product means, in a stable order and with ids, not positions (a deleted item must not rename the next one). An export that is just the file's own text, unchanged, is flagged and fails the test: CoCheck already draws a line diff of any text file.

## A product reached through MCP

A product that is not a file (a page, an issue) is reached by the agent through an MCP tool. CoCheck learns which item a call touches from a `subjects` template in the manifest: the tool's name, and a URI built from its input. Without a template nothing is ever captured, whatever `schemes` says.

```json vendor-manifest
{
  "spec": "cocheck.connector/1",
  "id": "my-vendor",
  "version": "0.1.0",
  "entry": "state",
  "matches": { "mcpServers": ["myvendor"], "subjects": { "mcp__myvendor__update_note": "my-vendor://note/{note_id}" } },
  "run": ["node", "connector.mjs"],
  "permissions": { "env": ["MY_VENDOR_TOKEN"] }
}
```

Before and after the call CoCheck sends your program `snapshot` with that URI and seals the `state` text you answer (`null` when the item does not exist, which is how a create is seen), then asks `diff` over the two sealed states, as in step 3. Null means only that the item positively does not exist; a read that could not be done is an error. A missing token, no access, a store you cannot reach or any other failed read is answered with an `error`, never with `null`, because CoCheck would show a create for an item that existed. List `"methods": ["snapshot", "diff"]` in `hello`. `permissions.env` names the variables your program may read (a token, a base address); it sees no others.

The test command does what CoCheck does: it asks `snapshot` for the URI the template makes for each state (`my-vendor://note/edit.before`) and runs `diff` on what you answered. While it runs, the variable `COCHECK_TEST_STATES` names the `states` folder: answer from `<note_id>.json` there (`edit.before.json`) instead of calling the product. A connector with a template and no `snapshot` fails. The kit's `examples/toy-vendor` is a working one.

## A tool that creates an item

This is for a tool that makes something new, such as `create_issue`, whose id the agent only learns from the tool's answer. A `subjects` template cannot name that item, because the input has no id yet. Name the tool in `matches.calls` with a template that reads the answer, such as `"my-vendor://note/{note.id}"`, and add `samples/calls.json` with an answer you recorded and the subject it should give. After the call CoCheck reads the item once and shows it as created. The spec's section "Items a tool creates" has the details.

## A product that keeps its own history

A product that records its own changes (an issue tracker, for example) can skip states. Set `"entry": "diff"` and list `"methods": ["diffs"]` in `hello`. After an agent's call CoCheck asks `diffs` with the item's `subject` and the call's window, `since` and `until`, and you answer the changes your product dated in that window. A read you could not do is an `error`, never an empty list.

The test cannot see your product's history, so you supply samples. Put a `samples` folder in the connector folder with `samples.json`, a list of `diffs` requests each marked `changed`, `no-change` or `failed-read`, and the history you recorded beside it. While the test runs, the variable `COCHECK_TEST_SAMPLES` names that folder: answer from the recorded history there instead of calling the product. One sample of each of the three is required; a missing one prints `untested` and exits 1. The kit's `examples/toy-tracker` is a working one, and the spec's diffs section shows the file.

## 5. Install it

Copy the folder (the one with `cocheck-connector.json` at its top) to `connectors/<id>/` under the CoCheck home folder (`$COCHECK_HOME`, else `~/.cocheck`):

```sh
cp -r my-connector ~/.cocheck/connectors/my-connector
```

From then on a file the agent writes with your ending, or an MCP call your template covers, is captured and the answer is kept with the step: upgrading or removing your connector later does not change how an old step draws. For a file, the agent's hook only records the write; CoCheck's own background process asks your connector right after (or, if it was not running, when the step is first opened), so a slow connector never holds the agent up. A connector that hangs or fails gets a step that says why. A connector with a file ending is given the file's bytes and is never sent `snapshot` for a file. `spec/README.md` has the rest (credentials, which connector wins when two overlap).

Going further: level 2 adds pictures and level 3 puts boxes on them (pixels, cells or text lines). Read `spec/v1.md` for them, and `spec/README.md` for installing, credentials and the rest. Recording more real states than the five is a good habit, not a requirement.
