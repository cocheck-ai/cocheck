# Installing CoCheck (Claude Code, Codex and Copilot)

CoCheck records what Claude Code, Codex and Copilot change in your files, and shows you every change on a review page. Sessions start untracked: CoCheck records nothing until you start tracking (see "Start tracking" below). You need a Mac with one of those agents, or Windows with Claude Code (a test build; see "Install with npm" below). Contributors who build CoCheck on a Mac also need the Xcode command-line tools (`xcode-select --install`), which provide `swiftc` for the native helpers. Microsoft Excel, Word and PowerPoint are optional for recording.

## Install with Homebrew (macOS)

You need Homebrew. It installs Node for you, and installing CoCheck upgrades Homebrew's own Node if it is old.

```
brew install cocheck-ai/tap/cocheck
cocheck install --home ~/CoCheckData
```

`cocheck install` runs from the folder you want CoCheck to watch (or pass `--folder <dir>`). `--home` is where CoCheck keeps its data; there is no default. Step 2 of the source install below lists exactly what the installer does; it is the same installer. Add `--for codex`, `--for copilot`, a comma list such as `--for claude,codex`, or `--for all` to choose the agents; with no flag it installs for every supported agent present on this machine (see "Which hosts `cocheck install` sets up"). Check the install with `cocheck --version`.

To upgrade: `brew update && brew upgrade cocheck`. The hook keeps working across upgrades, because it points at Homebrew's stable `opt` paths for CoCheck and Node.

## Install with npm (macOS and Windows)

You need Node 22.18.0 or newer (on Windows, download the installer from nodejs.org). Check in a terminal:

```
node -v
```

It should print `v22.18.0` or higher. Then install CoCheck globally:

```
npm install -g cocheck
cocheck --version
```

Then set up your agent. `--home` is required and must be an absolute path: it is where CoCheck keeps its data. Run this from the folder you want CoCheck to watch (or pass `--folder <dir>`). On a Mac:

```
cocheck install --home ~/CoCheckData
```

On Windows (Claude Code only, a test build), in PowerShell:

```
cocheck install --home "$env:USERPROFILE\CoCheckData" --for claude
```

Codex and Copilot are Mac only. Quit Claude Code and start it again so it reads the new settings. Tracking is off until a session starts it: tell the agent "start tracking" (it runs `cocheck track start`). To check that it is tracking, say "is it tracking" to the agent, or have it run `cocheck track status`, which lists the sessions tracked right now. `cocheck status` shows whether the hooks are installed and recording. To see the changes, run `cocheck open`.

To upgrade: `npm install -g cocheck@latest`.

To uninstall, remove the hooks first, then the package:

```
cocheck uninstall
npm uninstall -g cocheck
```

`cocheck uninstall` removes only CoCheck's hook entries and skill files and stops the review process; it deletes none of your data, and it prints where your data folder is. Delete that folder yourself if you want it gone.

## Which hosts `cocheck install` sets up

With no `--for`, `cocheck install` sets up every host that is present and nothing else. A host is present when its config folder exists on disk in your home: `~/.claude` (or `$CLAUDE_CONFIG_DIR`) for Claude Code, `~/.codex` (or `$CODEX_HOME`) for Codex, `~/.copilot` (or `$COPILOT_HOME`) for Copilot. CoCheck never creates a host's folder, so a host you have not run yet is skipped. If none is present, it installs no hooks and no skill, and says which folders it looked for.

For each host it installs, it writes the hooks into the host's config and the `cocheck` skill into the folder that host reads (`~/.claude/skills`, `~/.agents/skills` for Codex, `~/.copilot/skills`), and prints what it wrote where. If a `skills/cocheck/SKILL.md` is already there and is not CoCheck's (it lacks the line `<!-- written by cocheck install; cocheck uninstall removes it -->`), CoCheck says so and leaves it alone. `--for claude|codex|copilot` (or a comma list, `both`, `all`, `none`) narrows or overrides the detection: a host you name is installed, a host you do not name is never touched. If you use Copilot only through VS Code and have no `~/.copilot` folder, pass `--for copilot`: detection looks for the folder, so it will not find you.

`cocheck status` lists each host with whether its hooks are installed and whether they fired in the last 24 hours (read from the hook journal). `cocheck uninstall` reverses all of it: with no `--for` it removes the hooks of every host the install recorded, the skill files CoCheck wrote, and the install record; a config file CoCheck created goes away, and one that existed is restored without CoCheck's entries (the first backup, `*.cocheck-backup`, keeps the original bytes). `cocheck uninstall` is the same command as `cocheck install --uninstall`.

Tracking is off by default in every host: the hooks record nothing until a session starts tracking (`cocheck track start`, or "start tracking" to the agent through the cocheck skill) and stop when it runs `cocheck track stop`. What each host's hooks send is documented under `platforms/` (see `platforms/README.md`, and the host's own folder: `claude-code`, `codex`, `copilot-cli`, `copilot-vscode`).

## Start tracking

Every session starts untracked, by default. CoCheck's hooks are installed, but they record nothing, and add nothing to the agent's context, until you start tracking in that session. Tracking is per session: a new session is untracked again.

To start, tell the agent in plain words: "start tracking". `cocheck install` writes one skill (named `cocheck`) for Claude Code, Codex and Copilot, and the skill makes the agent run this command as its own Bash command:

```
cocheck track start
```

Tracking begins with the agent's next tool call. The folder the agent is working in becomes the task folder, so keep the files for this work inside it. From then on, CoCheck records the session's work and, at the start of each request, tells the agent to save inside the task folder and to run `cocheck open` when you ask to see the review.

To check, say "is it tracking", or have the agent run `cocheck track status`. It lists the sessions tracked right now.

Only the agent's session can switch tracking: the command takes effect when the hook sees it run inside a session, so running `cocheck track start` yourself in a plain terminal changes nothing.

## Where the review page is

When the agent is done (or while it works), say "show me the review", or run this yourself in any terminal:

```
cocheck open
```

It starts the review process if needed and opens the page in your browser. `cocheck open 12` opens task 12. Read the changes, pass or fail each step, and send the failed ones back or sign off. To see whether CoCheck is recording, run `cocheck status`. If nothing can record, `status` and `open` print `CoCheck: not recording.` and the reason: Node missing or too old, the hook files moved, the host's settings no longer carrying CoCheck's hooks, or the last hook run failing (its error is kept in `<home>/not-recording.txt` until a hook records again). If only one installed host cannot record while another can, the output leads with a line such as `Codex is not recording: <reason>`, then `CoCheck: recording to ...`, and `status` exits 1.

## Stop tracking

Tell the agent "stop tracking". It runs:

```
cocheck track stop
```

Calls after it are not recorded. What was already recorded stays, and you can still open it with `cocheck open`. Starting again later in the same session picks tracking back up. To remove CoCheck's hooks altogether, see "Uninstall" below.

## Install from a source checkout (fallback)

Use this when you cannot use Homebrew or npm. It needs Node 22.18 or newer, a clone of the CoCheck repository (`git clone https://github.com/cocheck-ai/cocheck`), and the steps below. In the commands further down, `cocheck <command>` means `node /path/to/cocheck/scripts/cocheck.ts <command>`, and the installer is `node /path/to/cocheck/scripts/install.ts`.

### 1. Install Node

CoCheck needs Node 22.18.0 or newer. Node 24 (the current long-term-support version) is the easy choice: download the macOS installer from nodejs.org and run it. Check in Terminal:

```
node -v
```

It should print `v22.18.0` or higher.

### 2. Install CoCheck

In Terminal, go to your CoCheck clone (the folder with `package.json` in it), then run `npm install` once. Then, from the folder you want CoCheck to watch, run the installer with a place for CoCheck's data. There is no default: you choose it.

```
node /path/to/cocheck/scripts/install.ts --home ~/CoCheckData --folder .
```

`--home` is required and must be an absolute path (a leading `~` is expanded by your shell). It must not be `~/.cocheck` or inside it. `--folder` defaults to the folder you run the command from.

The command:

- checks Node, and builds CoCheck if it has not been built;
- adds CoCheck's hooks to the config of each host it installs for (see `--for` below); for Claude Code that is your user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`). The hook command names no Node path: a small launcher (`scripts/hook-launch.sh`) finds Node each time the hook fires, so upgrading Node does not stop recording; (On Windows the hook command starts `node` directly on `scripts/hook-launch.mjs`, the same launcher contract without a shell. If the host cannot start `node` at all, the launcher never runs and cannot write `not-recording.txt`; that case shows up as a stale last-recorded time.) Your other settings, hooks and permissions are kept. The first time, it saves the original as `settings.json.cocheck-backup` next to it, and never overwrites that backup;
- fires the hook once as a check through that same launcher. If the check fails, `settings.json` is put back to exactly its bytes from before the install (an `cocheck-backup` made by this run is removed too), nothing is registered, and the command exits with the reason;
- only then registers the folder in `<home>/watched.json`, remembers the home in `~/.config/cocheck/install.json`, and prints `CoCheck is watching <folder>`, how to open the page, and the notes below.

What to know before you rely on it:

- **Mac, or Windows with Claude Code (Windows is a test build).** Node 22.18 or newer. Windows installs with npm and covers Claude Code only (see "Install with npm" above).
- **Codex and Copilot: Mac only.** They are not supported on Windows yet.
- **In a tracked session, CoCheck tells Claude where to save and how to open the page.** At the start of each request in a tracked session, it tells the agent (Claude Code, Codex or Copilot) to save its work inside the task folder and to run the open command when you ask to see the review. An untracked session gets no such text and nothing is recorded.
- **Disk use** is up to 1 GB per task, for the saved before-and-after copies of your files, inside `--home`.
- **Hook timing.** Every tool call of the host you installed for (Claude Code, Codex or Copilot) runs CoCheck's hook twice, before and after it. Together that is held under 1 second per call (`scripts/hook-timing.ts` measures it on your machine).
- **Copilot (CLI and VS Code agent mode).** `--for copilot` writes one file, `~/.copilot/hooks/cocheck.json` (or `$COPILOT_HOME/hooks/`); uninstall removes it and leaves the rest of `~/.copilot` as it was. Copilot gives a hook no way to hand words to the agent at a prompt, so the "save inside the task folder" text reaches Copilot only through the `cocheck` skill (`~/.copilot/skills`). Calls a helper (subagent) makes are credited to that helper. VS Code sends no helper id on them, so CoCheck links them to the main session by the task's prompt, else holds them for up to 15 minutes until the main session's `subagentStop` names the helper; a helper of an untracked session is never recorded. A shell command that fails is read from the exit code in Copilot's result text. If you turn on Copilot's sandbox, its hooks stop working until `sandbox.userPolicy.filesystem.readwritePaths` in `~/.copilot/settings.json` lists the CoCheck folder and your data folder (`cocheck install` and `cocheck status` print both); CoCheck never edits that file. The Copilot cloud coding agent is not supported: it runs on GitHub's machines, outside the Mac and outside user-level hooks.

If the settings file is not valid JSON, the command stops with a message and changes nothing. A symlinked settings file is edited in place.

Run it again with another `--folder` to watch more folders. Running it twice for the same folder changes nothing.

Quit Claude Code and start it again so it reads the new settings.

CoCheck's hooks run for every session of the host on the machine, but they do nothing in a session that is not tracked, and nothing outside the registered folders: they exit at once and write nothing.

### Choosing the host: `--for`

`--for <claude|codex|copilot|both|all|none>` (or a comma list such as `claude,copilot`) picks which agent gets CoCheck's hooks; `both` is `claude,codex` and `all` is every host with an installer. With no flag the installer sets up every host that is present (see "Which hosts `cocheck install` sets up" above).

- `claude` installs for Claude Code, as described above.
- `codex` adds the hooks to Codex's config, `$CODEX_HOME/config.toml` (`~/.codex/config.toml` when `CODEX_HOME` is unset). CoCheck appends `[[hooks.X]]` entries for `PreToolUse`, `PostToolUse`, `Stop` and `UserPromptSubmit`, each line ending in `# cocheck`, and does not touch `[features]`: Codex's docs say hooks are on by default, and no source names a version where that changed, so there is no version check. An install by an older CoCheck that wrote `hooks = true` is cleaned up on reinstall or uninstall; a `hooks = false` of yours stays and keeps Codex from running any hook. `--for codex` reuses `--home` and `--folder` from the last install when you leave them out. Your own lines stay as they are, byte for byte. The Codex hook has no `--folder`: Codex tells the hook which folder it is working in (the payload's `cwd`), and the hook records only when that folder is inside a watched one.
- `both` does the two together. If either host's check fails, both configs are put back to their bytes from before the install.
- `none` sets up the data folder, the watched folder and the review page, and puts no hooks in any host.

**Trust the new hooks in Codex once.** Codex does not run a hook it has not been told to trust. After installing for Codex, open Codex and trust the new hooks when it asks; until then Codex records nothing. `cocheck status` lists it as `Codex: installed, hooks not trusted`, and when another host is recording, it leads with `Codex is not recording: <reason>` and exits 1.

Codex refuses a config that defines hooks twice, so the installer stops, and changes nothing for any host, when `config.toml` already has a `[hooks]` or `[hooks.X]` table, or top-level `hooks.X = [...]` keys. Move your hooks to `[[hooks.X]]` tables and run it again.

Each config CoCheck touches is saved first as `<file>.cocheck-backup` (the first backup is never overwritten). Uninstall takes the same flag: `cocheck uninstall --for codex` removes only CoCheck's entries (the lines ending in `# cocheck`) from the Codex config and leaves Claude Code installed; with no flag it removes the entries of every host the install recorded. The review process stops and the install record goes only when no host is left. `cocheck status` lists each host as installed or not installed.

### 3. Start tracking

Continue at "Start tracking" above. From a source checkout, `cocheck <command>` means `node /path/to/cocheck/scripts/cocheck.ts <command>`.

## Uninstall

```
cocheck uninstall
brew uninstall cocheck
```

(With the npm install, use `npm uninstall -g cocheck` instead.)

From a source checkout, use `node /path/to/cocheck/scripts/install.ts --uninstall`. Run `cocheck uninstall` before `brew uninstall`, so the hook entries are removed while the command still exists.

This removes exactly the entries CoCheck added (they carry `COCHECK_MANAGED=1`) and leaves everything else, including any hook of yours that is not CoCheck's. It also stops the review process, and then prints what stays on your Mac: your data folder with its path and size, the Keychain item `cocheck-store-key` in your login Keychain (the key that seals your data; delete it in Keychain Access only after deleting the data), and the settings backup file. Nothing is deleted for you.

## If something goes wrong

- **The installer says the hook check failed.** Nothing was installed: `settings.json` is back as it was. Read the message, fix the cause (usually a missing build: run `npm run build`, or Node not on your PATH), and run the installer again.
- **The installer says the settings are not valid JSON.** Fix the file by hand (or restore `settings.json.cocheck-backup`), then run it again.
- **Claude recorded nothing.** The usual cause is that the session is untracked: say "start tracking" in it (see "Start tracking"). Then run `cocheck status`; it names the cause when the hook cannot record. Otherwise check that the folder Claude works in is inside a registered folder (see `<home>/watched.json`), and that you restarted Claude Code after installing.
- **`node -v` is too old.** Install a newer Node (step 1), then run the installer again.
