# replay-claude-casebook

Fixtures for `test/replay-claude-casebook.test.ts`: the Claude Code leg of a recorded live run (three turns on the casebook workbook; the build script rebuilt the workbook snapshots from a CoCheck-made model, see `../build-neutral-workbooks.py`), replayed through the real hook adapter.

- `events.json`: the Pre, Post and Stop hook events and the three turns' prompts, rebuilt once from the run's ledger by a one-off extractor script (deleted). The adapter keeps no raw payloads, so a Bash call's input is its command and description (split from the op intent) and any other call's input is only the path the op named. Paths are tokens (`{FOLDER}`, `{OUTSIDE}`, `{PROBE}`, `{SESSION}`, `{SCRATCH}`); the test maps them to a temp tree.
- `ledger-rows.json`: the run's own `review_rows` by round, file and status (originally the two workbook copies were 10,383 and 10,457 rows). the round-2 `derived` count is 92, what the neutral workbook recalculates; the live run's original workbook gave 235. The test uses it as the cross-check for the replayed cell rows.
- `notes-S0.xlsx`, `notes-S3.xlsx`: the second workbook in the folder at the start and after turn 2 (the casebook workbooks are shared with `../casebook-rerun/`: S0, S1, S3, S4; the outside copy is the S3 bytes).

Not on disk, so rebuilt in the test (each marked RECONSTRUCTED there): S2 (Sam's Excel save, S3 minus the agent's turn-2 XML edits), the single-cell states inside turn 1, and the Sensitivity sheet's partial states inside turn 2. Everything else is byte-identical to the run.
