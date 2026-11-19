# Encryption at rest

CoCheck keeps a copy of each file it watches (the baseline, the per-round copies and the hook sweep's per-step states). Those copies are encrypted on disk. Encryption is always on; there is no switch.

## How it works

- Each CoCheck home has one 32-byte random key. It lives in the macOS login Keychain (service `cocheck-store-key`, one item per home), reached through the system `security` tool. Nothing outside Node's `crypto` and `security` is used.
- A stored copy is `COCHECK\0 | version (1 byte) | iv (12) | AES-256-GCM ciphertext | tag (16)`. The header is also authenticated, so a flipped byte, a truncation or the wrong key fails loudly (`SEAL_AUTH`) and the bytes never reach the differ.
- A copy keeps its name: the sha-256 of its plaintext. CoCheck hashes first, then encrypts. Two sealed copies of the same bytes differ on disk (random iv) but have the same name and compare equal.
- A missing key raises `KEY_MISSING`. On a write it writes nothing and leaves no temp file. On a read it is never reported as "the state is gone".
- All code goes through `src/seal.ts`: `writeSealed(dest, bytes)` to write, `readSealed(file)` to read. A later item that stores other values can use the same two functions.
- Decrypted bytes exist only in memory or in a private temp folder (mode 0700, files 0600) that is removed when the reader is done.

## Windows (DPAPI)

On Windows the key is not in a Keychain. CoCheck asks Windows DPAPI, with the current-user scope, to protect the 32-byte key, and keeps only the protected result in a file: `AppData\Local\CoCheck\secrets\<hash>.dpapi` under your user profile, one file per home. Only the same Windows user can unprotect it. The key goes to PowerShell on standard input, not on the command line, and only the protected text is written to disk. CoCheck then limits that folder to your account with `icacls`, on a best-effort basis. A process running as your Windows user can unprotect the file the same way CoCheck does.

## Migration

The first time a store written before encryption is opened (a hook event or the task sweep), every file under `tasks/<id>/round-*`, `tasks/<id>/states`, `tasks/<id>/resolve` and the hook folders' `copies` is rewritten as ciphertext, ledger row or not. Each file is written beside the original and renamed over it, so no plaintext copy remains. A rerun never encrypts twice, and a crash between the write and the rename finishes on the next run. A file that starts with the header but does not authenticate is left alone and reported, never read as plaintext. A locked Keychain or a crash mid-run is resumable, not hardened.

## What it protects against

- A backup or copy of the disk (Time Machine, a cloned drive, a lost laptop with the Keychain still locked).
- Someone reading the store folder without the login Keychain.

## What it does not protect against

- A process running as you. It can ask the Keychain for the key (the first use may show a prompt) and read what CoCheck reads. On Windows it can unprotect the DPAPI file the same way.
- Anything that is still plaintext: the ledger's value columns, `state.json` and the preview render cache are outside this item.
- Your original files. Only CoCheck's copies are encrypted.

## Threat model

CoCheck is a record kept for you on your own machine, not a defence against a process that runs as you. Any process running as your user, the AI agent included, can read the key, the ledger and the review token (`<home>/review-token`). With them it can write to the ledger or send the review page's requests itself, so it can forge a pass or fail verdict and a sign-off. The page's check that a request came from the page (`originAllowed` in `src/review-server.ts`) only stops other websites in a browser, and a program that is not a browser can set the header. Other user accounts on the machine are kept out: the review server listens on 127.0.0.1 only, and the token file and the home are readable by you alone. A sign-off is a soft record: it is stored as signature kind "soft" and shown as "soft sign-off, not verified". It does not prove that a person made it.

## Keeping the store out of backups and search

CoCheck writes `.metadata_never_index` in the home, which keeps Spotlight out. Time Machine needs one command, run once by hand, with the folder you gave to `cocheck install --home <dir>`:

```
tmutil addexclusion <the folder you gave to --home>
```

CoCheck does not run this command for you. Keep that folder out of iCloud and Dropbox folders as well. If you never set `COCHECK_HOME` or `--home`, the fallback is `~/.cocheck`.

## Secret detection in recorded text

A helper's message or brief, a command, a query or a path is checked before CoCheck records it. If the text looks like it holds a secret, the whole field is withheld, never part of it, and the page says so. A helper's message or brief can still be shown on the person's own page again, read from the host's own transcript.

The detector is the open gitleaks default ruleset (gitleaks v8.30.1, MIT licence, pinned in `vendor/gitleaks/VERSION`) and nothing else. `scripts/gen-secret-rules.ts` translates `vendor/gitleaks/gitleaks.toml` into `src/secret-rules.generated.ts` (run `node scripts/gen-secret-rules.ts`); `src/secret-scan.ts` runs it. No rule is written or changed by hand. Each rule keeps its keywords, entropy floor, secret group and allowlists. A rule that cannot be translated is listed in `EXCLUDED_RULES` with the reason: the rules that only apply to a named file path (free text has no path). The gitleaks licence notice is in `vendor/gitleaks/LICENSE` and in `GITLEAKS_LICENSE` in the generated module, so it ships in the build.

A file's text is checked the same way, wherever CoCheck would copy its bytes: the hook's capture (`src/hook-adapter.ts`, the per-task store) and every round copy (`TaskStore.#snapshot` and `#copySnapshot` in `src/tasks.ts`: the baseline at the first touch, round folders `tasks/<id>/round-*`, a reopened task's rebuilt baseline). A file whose text holds a value a gitleaks rule finds is a secret file whatever its name. The hook keeps only its SHA-256 and size (`kept: "hash"`), with the note `A secret file was changed: <relative path>; its text holds a value that looks like a secret (gitleaks rule <id>), so only its hash and size are kept`. A round keeps only its fingerprint (snapshot mode `fingerprint`, no copy), so the files layer never diffs it and no line of it reaches the ledger's review rows: a change is one row, `A secret file was changed: <name>; it looks like it holds a secret, so only its fingerprint is kept`, with the two fingerprints. Its bytes are never stored, previewed, diffed or sent anywhere, and the review page shows it like a secret-named file. Other writers of file bytes only copy what one of these already stored (`#adoptCopies`, `#materialize`, the unreadable-workbook fallback in `#prepareRound`, the Excel before-copy), so a secret has nothing there to copy.

Accepted limits of the content check:
- Only UTF-8 or ASCII text is scanned. A file holding a NUL byte is not: binaries, UTF-16 text, and Office or PDF files (whose parts are compressed), so a token inside a `.docx`, `.xlsx`, `.pptx` or `.pdf` is not found.
- Text up to 4 MB is scanned whole. Longer text is scanned in its first and last 2 MB (`CONTENT_SCAN_CAP_BYTES` in `src/secret-scan.ts`), so the cost stays bounded; a secret only in the middle of a file over 4 MB is not found.
- gitleaks' own allowlists apply, so a value it allows is kept whole: AWS's documentation key `AKIAIOSFODNN7EXAMPLE`, and any value holding a run of the whole alphabet (a global stopword).

Bound, by design: a password in free prose with no vendor format (for example `password: hunter22`, `DB_PASS=...`, `Authorization: Bearer ...`, a plural `passwords:` map) is not detected. Only secrets in a format the gitleaks rules know are withheld.
