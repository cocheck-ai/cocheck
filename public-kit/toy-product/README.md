# Toy notes product

A tiny product that keeps notes in one JSON file. It exists so you can practice turning two states of a product into a list of changes.

`notes-store.mjs` reads and writes `notes.json`. The `states/` folder holds recorded pairs: each `<case>.before.json` is the file before an action, and `<case>.after.json` is the file after it.

Cases: `create` (a note is added), `edit` (a note's text changes), `delete` (a note is removed), `no-change` (the file is rewritten with the same content).
