# conformance

The cases that check a connector against the specification live here. The specification is `../spec/README.md`; its section "Testing your connector" says how to run them and what they do not check. Use the toy product in `../toy-product/` to explore how product states change.

## Cases

`cases/C1.json` to `cases/C17.json`, less the retired C7, C8, C9 and C15, are the conformance cases, as language-neutral data (in the style of the JSON Schema Test Suite). Each names its fixture (a connector folder under `public-kit/conformance/fixtures/`), its input state pair, and the expected result. Every connector is graded on `cocheck.changes/1` answers, per level (`public-kit/spec/v1.md`, "Conformance per level"); a connector with no `level` in hello is graded at level 3. C7 (locators), C8 (payload types), C9 (precision) and C15 (attribution keys) are retired with the older answer shape. Cases C3 and C6 give each input pair an `expectChanges` list (kind and entity, matched to the marks added, changed and removed), the exact set a correct connector emits: an empty or change-dropping diff fails them. Cases C5, C6, C12 and C17 each list a `failingFixtures` entry: a connector that must fail that case (C6: one that silently drops a real edit; C17: one whose state leaks between diffs). C17 asks its pairs A, B, A of one process and compares each answer, byte for byte, with a fresh process's answer: CoCheck keeps one process per connector for many diffs. C12's malformed states live in `../toy-product/states/`. C13's large pair is written by `generate-large.mjs <count> <outDir>`. The C16 golden is one file per fixture (`public-kit/conformance/fixtures/toy/golden.json`), shared by every OS.

`cocheck connector test <dir> --cases [<casesDir>]` runs the cases (the kit's `cases/` when no folder is given), prints one line per case with its id, pass or fail and the reason, and exits 0 only when every case passes. Without `--cases` the same command checks a connector on state pairs instead. See `../spec/README.md#testing`.

## Live tier

Cases that need a real product account run only behind `COCHECK_CONNECTOR_LIVE=1`, on a developer's machine, against that developer's own test account. The live tier never runs in CI: no workflow sets `COCHECK_CONNECTOR_LIVE`, and without it a live case is skipped.
