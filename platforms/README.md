# Platforms

CoCheck's sourced, versioned record of each host platform it serves or may serve: Claude Code, Codex, Copilot CLI, Copilot in VS Code, Cursor, Antigravity CLI, ChatGPT Work and Claude Cowork. Each platform has one folder with a machine-readable `capabilities.json`, a plain-language `guide.md`, its `sources.md`, and optional real recordings under `versions/`. The format is in `SCHEMA.md`. `matrix.md` is generated from the capabilities files and `discrepancies.json` and compares the platforms. The four hook-register hosts list every documented hook event; see "Hook register" in `SCHEMA.md`.

## The fact rule

Every claim in `capabilities.json` carries a kind (`documented` or `observed`), a source (URL, `local:`, `probe:` or `binary:`), the date it was checked, the platform version it was checked against, and a status (`confirmed`, `unverified` or `contradicted`). A fact without a source is not allowed; what we do not know goes in `open_questions`.

## Adding a platform

1. Create `platforms/<key>/` with `capabilities.json` in the shape of `SCHEMA.md`, `guide.md` with the sections listed there, and `sources.md`.
2. Put any real recordings in `versions/<version>/` with a short `README.md` saying how they were made. Replace email addresses with `user@example.com` and `/Users/<name>` with `/Users/<user>`, and check for tokens before committing.
3. Run `node scripts/platforms-check.ts --write` to validate the file and regenerate `matrix.md`. Plain `node scripts/platforms-check.ts` exits 1 if a file is invalid or the matrix is stale.

Daily checks of the vendor docs and per-update pull requests are planned, not built.
