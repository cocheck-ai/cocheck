# Per-call attribution tag

Builds on an earlier probe. Each Claude Code Bash call is tagged with its `tool_use_id` and `agent_id`. Python and Node processes the call starts record the files they write under that tag, and attribution trusts those records ahead of open-call windows.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Tag | `src/attribution/tag.ts`, `src/hook-cli.ts` (`tagOutput`) | On a recorded Bash PreToolUse, the hook prints `hookSpecificOutput.updatedInput`: the whole tool input, with the command changed to `<command>\n# cocheck-call:<tool_use_id>:<agent_id or main>`. It returns no `permissionDecision`. |
| Untag | `src/hook-cli.ts` (`untag`) | The Post and failure payloads carry the tagged command. The tag is stripped before normalizing, so the ledger, the page and AI prompts keep the command the agent wrote. The raw hook journal keeps the raw bytes until Stop drops the bodies. |
| Session environment | SessionStart entry (installer), `prepareSession` | Writes guard loaders under `<home>/attribution/hooks/`, `roots.json` (the registered folders, as given and resolved) and a `ready/<session>` marker, then appends `COCHECK_WRITE_LOG`, `COCHECK_TAG_SESSION`, `PYTHONPATH` and `NODE_OPTIONS=--require <guard>` to `CLAUDE_ENV_FILE`. Each export first tests that its guard file exists, and the env file runs before every Bash command, so a guard that is gone sets nothing. The lines never carry a call id. |
| Guards | `nodeGuard`, `pythonGuard` | The environment names only these stable files in the CoCheck home, never the shipped hooks. A Homebrew upgrade or cleanup can remove the shipped hooks, because `import.meta.dirname` resolves through the Cellar. Each guard runs its target only while it exists; otherwise it does nothing, and the Python guard still chains to the user's own `sitecustomize`. |
| Session markers | `ready/<session>`, `active/<session>` | A Pre tags only in a session whose SessionStart ran (`ready`). Otherwise the tag would read as observed with no hooks behind it, which happens on an install from before this tag existed. The first tagged Pre writes `active`. The hooks do nothing at all, not even a process walk, in a session with no `active` marker. |
| Python write hook | `src/attribution/hooks/sitecustomize.py` | A `sys.addaudithook` hook on `open` in write modes, `os.rename`, `os.remove`, `os.truncate` and `shutil.copyfile`. It also records `spawn` for `subprocess.Popen`, `os.system`, `os.exec*`, `os.posix_spawn` and `os.spawn*` of anything other than python or node. |
| Node write hook | `src/attribution/hooks/cocheck-preload.cjs` | Wraps fs's write entry points: sync, callback and `fs.promises`, which covers ESM `node:fs/promises` too. It also records `spawn` for `child_process` spawn, exec and execFile of anything other than python or node, or of a shell. A re-entrancy guard keeps its own log write and `ps` lookup from being recorded. |
| Evidence | `src/attribution/evidence.ts`, `#proven` in `src/hook-adapter.ts` | Each event reads the records appended since the folder's cursor in `<home>/attribution/writes-<date>.jsonl` and keeps, per changed path, the calls that wrote it. |

How the write hooks find the tag: on the process's first write or program start, they walk up the process tree, nearest process first, until a command line contains the tag. They stop at the first `<shell> -c` they meet, which is the call's own shell, and never look past it, so an inner untagged session's child cannot take an outer call's tag. They read `/proc` on Linux and use `ps -o ppid=,command=` elsewhere. Writes are logged only under `roots.json`; files are 0600 and folders 0700. Claude Code 2.1.309 runs `<shell> -c "source <snapshot> && … && eval '<command>' < /dev/null && pwd -P >| <file>"`, so the tag is in that shell's command line (the shell's command line is part of its process tree). If no process up the tree carries the tag, the hook stops recording for that process. Each process looks once and records each path once.

## Why a trailing comment

**Permission rules are matched against the rewritten command.** The hooks reference, PreToolUse decision control, `updatedInput`, says: "Claude Code evaluates permission rules and a Bash command's auto-background eligibility against the input your hook returns, not the input Claude sent." So any rewrite has to keep every rule matching as it did before.

From the permissions page (Bash rules):
- "A rule must match each subcommand independently." and "Deny and ask rules apply when any subcommand matches them, including a command nested inside a subshell, a command substitution, or a control-flow body."
- "Claude Code also strips a leading assignment of certain known-safe environment variables … An allow rule won't match past an assignment of any other variable. A deny or ask rule matches past any leading assignment."
- Redirections: "for `> file`, `>> file`, or `2> file`, the check covers your `Edit` allow and deny rules, protected paths, and the working directories."
- "A deny rule doesn't match the same program by path or inside `sh -c`." Also, `env` is not in the stripped wrapper list (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`).

What each candidate form does:

| Form | Allow rules (`Bash(git status:*)`) | Deny/ask rules |
|---|---|---|
| `COCHECK_CALL=.. cmd` (env form) | broken: the variable is not a known-safe one | still match |
| `export COCHECK_CALL=..; cmd` | `export …` is a new subcommand an allow rule must also match | still match |
| pid registry `printf … >> <home>/reg; cmd` | new subcommand plus a redirect outside the working directories: prompts | still match |
| `env COCHECK_CALL=.. cmd`, `bash -c '…'` | broken | **bypassed**: a security bug. Rejected. |
| trailing `\n# cocheck-call:…` (chosen) | no new subcommand; the command text is unchanged | still match: every original subcommand is still there |

**Verdict.** None of the prefix forms can bypass a deny rule, provided the original command stays a parseable top-level command. Wrapping forms do bypass deny rules. The prefix forms break allow rules, which means extra prompts in Manual mode and refusals in `dontAsk` mode or under `-p` with allow lists. The comment form adds no subcommand, so by the documented rules it changes neither allow nor deny matching. The docs do not say how the matcher treats a comment line. If the parser rejected it, the documented fallback is "it asks for approval", which fails closed: a prompt, never a bypass.

**Default: `on`, in every permission mode.** One fenced live run, run once, used Claude Code 2.1.309 with `--settings` holding this hook, `allow: ["Bash(git status:*)"]`, `deny: ["Bash(rm:*)"]` and `defaultMode: "dontAsk"`. Its folder and CoCheck home were deleted afterwards. Results:
- **Allow rules still match.** The tagged `git status` ran with no refusal.
- **Deny rules still match.** The tagged `rm -f x` was denied; the denial shows the rewritten input `rm -f x\n# cocheck-call:toolu_018o5Qie…:main`.
- **The write was recorded under its call.** The Python write of `py.txt` was logged under its call (`toolu_018CtYic…`, agent `main`, via python).

`auto` (tag only in `bypassPermissions`) and `off` (never tag, set no environment, read no evidence) stay available through `--attribution-tag on|auto|off` or `COCHECK_ATTRIBUTION_TAG`. The SessionStart payload documents no `permission_mode`, so SessionStart sets the environment whenever the setting is not `off`. That environment stays inert until a Pre tags a call and marks the session.

## When a command is left untagged

The tag is a comment, so it must never land where the shell reads it as data. A command is left as it is when any of these holds:
- it is empty, longer than 9,000 characters (Claude Code always prompts past 10,000), or contains NUL;
- it still contains `# cocheck-call:` once any trailing tag lines are stripped (a command copied from an earlier call has its trailing tag lines replaced);
- it turns on verbose echo: `set -v`, `set -o verbose` or `setopt verbose`. Bash's `set -v` prints every line read, the comment included. `set -x` prints only commands that run, so it never prints the comment;
- it ends in a backslash;
- it does not parse under the call's shell (`$CLAUDE_CODE_SHELL` or `$SHELL`, bash or zsh only, `-n`, nothing runs);
- its end is not at the top level, that is, it still parses with an unmatched `'` appended (an unterminated heredoc);
- the tagged text does not parse;
- an id is not `[A-Za-z0-9_-]{1,128}`.

The tag goes on a trailing line so that every line number an error message quotes stays the same.

## Crediting

`#proven(file)` gives the change to the calls the evidence names, alone, only when every such call is open now and every other open call that may be credited meets all of these:
- it is a Bash call that was tagged;
- its command is only Python (without `-I`, `-E` or `-S`), Node, and builtins or readers that write nothing (`observedOnly`): no redirect, substitution, `exec`, script, `osascript`, `soffice` or any other program;
- none of its children recorded a `spawn`;
- its command does not name the file.

An untagged call, such as another session not in bypass mode, a Write or Edit naming the file, or any other creditable tool, keeps the change joint. Launchers, waits and internal agent calls are not counted. Otherwise the open-call window rule runs unchanged. The evidence a sweep used is then spent, and evidence whose calls have all closed is dropped. The integration is two expressions in `#credit`, kept apart from the rest of the window logic so it rebases onto the change before it.

## Behaviour identity

`test/attribution-call-tag.test.ts` runs the 30-command probe corpus (`test/fixtures/command-behaviour-corpus.ts`), rebuilt from the probe note because its scratch was not kept. Each command runs under bash and under zsh, wrapped the way Claude Code wraps it, with the session environment set, once plain and once tagged. Results:
- stdout, stderr and exit code are identical for 30 of 30 commands under both shells;
- 28 commands are tagged; the 2 that do not parse are left untagged;
- the tag is never printed;
- the Python and Node children of the tagged runs record their writes under the right call and agent.

## Known limits and risks

- **A child that outlives its call.** A forked pipeline stage can outlive its call's shell (zsh aborts `python x.py | grep a.*b` with "no matches found" while python runs), so no ancestor is left to read the tag from. Each call's env-file line therefore reads the tag from its own shell's command line and exports `COCHECK_WRITE_CALL=<call>:<agent>` (cleared on an untagged call, set only while the session is tracked). The Python and Node hooks use it only when the ancestor walk finds the shell gone, never past a live `-c` shell. A write that lands after the call's Post is credited to that call when its record is no older than 5 minutes; a write with no record is credited to nobody.
- **Where the tag is visible.** The tag is not in the environment as `cocheck-call`, but the call and agent ids are: an env dump prints `COCHECK_WRITE_CALL`. It is also visible to anything that reads the calling shell's own command line: `ps` on that shell, and `$ZSH_EXECUTION_STRING` / `$BASH_EXECUTION_STRING`. That same command line already holds the whole command.
- **What gets recorded.** Only Python and Node writes. Shell redirects, `cp`, `awk`, compiled tools, Python run with `-I` or `-E`, and Node with NODE_OPTIONS ignored all leave no record, and the window rule covers them. Commands that `exec` replace the tagged shell's command line, so their children find no tag.
- **The session environment is visible.** `PYTHONPATH` and `NODE_OPTIONS` show in env dumps and in `sys.path`. They are the same for every call, but not the same as a session without CoCheck.
- **Other hooks.** Behaviour when another PreToolUse hook also returns `updatedInput` is not documented.
- **Upgrades.** An existing install has no SessionStart entry until the installer is re-run (`cocheck install` writes it: 7 managed entries). Until then its sessions are never tagged (no `ready` marker), so attribution stays exactly as before. There is no silent migration, and the status check does not flag it, because recording is unaffected.
- **Nested shells.** A tagged command that runs Python under its own `sh -c` / `bash -c` (one that stays alive) loses evidence for that child, which is safe: the window rule covers it.
- **Evidence trusted too far.** If a hook-less writer in another open call (one that does not name the file) changes the same file during the same window, the change is credited to the evidence call alone.
