# Release notes

## Unreleased

You now choose which connector shows each file type.

- Per-type connectors. `cocheck connector list` shows, for each file ending, the connectors that claim it and which one is enabled. `cocheck connector enable <id> <ending>` and `cocheck connector disable <id> <ending>` change it.
- CoCheck's own endings stay CoCheck's by default. An installed connector that claims one of CoCheck's own endings (`.png`, `.jpg`, `.md` and the rest of the text, csv, pdf, Office and picture endings) is no longer used for it unless you turn it on. For picture endings this is a change: an installed connector that claimed `.png` or `.jpg` used to be used for it, and after the upgrade it is not. `cocheck connector enable <id> <ending>` turns it back on; the same command turns a connector on for any of CoCheck's own endings.
- Code and other text files are unchanged. An installed connector that claims `.py`, `.json` or another ending CoCheck does not name itself is still used for it by default.

CoCheck no longer reads, draws or orders Office files itself. Excel, Word and PowerPoint are three connectors on the same standard as any connector you could build, and the review page draws their files from what the connector says. What you will notice:

- The open-in buttons are gone.
- The "look here" chip is gone.
- The Files view no longer lists Office files first.
- The structure banner on old steps is gone. Problems the connector finds show as its issues instead.
- Cell-level notes and cell credit are gone. A step lists what the connector says changed, and credit stays per step.
- The model cards are replaced by the connector's change list.
- A file a connector reads that CoCheck cannot copy at the start of a task is kept as its fingerprint with the reason in words, and the task goes on (`src/hook-adapter.ts:1885`).
- Pictures say "Drawn by <app>" in place of the old CoCheck line, using the name the connector gives.
- Office file icons in the Files view are plain.
- Skill names read "Loaded <name> instructions".
- The speaker-notes panel is gone. A change to speaker notes shows only as the PowerPoint connector reports it.
- A file a connector reads that has text in its saved copy shows the generic card, with no text view.
- An old Office step that was read later than the step says so ("This change list was read later than the step, from the copies CoCheck kept."), and one whose copies are gone says "no change list was kept".
- A plain re-save of an Office file reads "Saved again: nothing changed." in muted type. The connector only says so when the two files match part by part, or differ only in the details an Office app rewrites on every save.

## 0.3.4

Office pictures now come from the apps' own PDF pages, with the changes outlined, and no Screen Recording permission.

- PDF pages for Excel, Word and PowerPoint. Each side is printed by the real app to PDF in the background and shown page by page. Nothing appears on screen, and CoCheck no longer asks for Screen Recording. `cocheck setup excel-pictures` is gone.
- Changes outlined. Excel boxes changed cells, tied to the printed row numbers and column letters. Word boxes changed paragraphs when their words are unique on the page. PowerPoint boxes the changed shape, or the whole slide for an added or removed slide. Where a box can't be placed with certainty, the change is listed in words with a reason.
- Truer prints. The file's own paper size, black-and-white, draft and centring settings no longer change the picture, and a wide region fits on one page. Word prints full-size pages with tracked changes marked; comments are hidden on these pages and still listed.
- Repair prompts. When Office shows a repair prompt instead of opening a file, the page says so within seconds, and the other side still shows.
- Faster Excel. About 11 s for a 12-picture workbook.

Known limits in this build:

- Office pictures are Mac only; Windows shows the change list.
- A comment-only Word edit is listed as a whole-file change.
- The limits listed under 0.3.3 still apply.

## 0.3.3

CoCheck no longer uses LibreOffice.

- LibreOffice is gone. CoCheck stopped drawing Office files with LibreOffice in 0.3.1, and the leftover code is now removed. `cocheck install` no longer reports whether LibreOffice is present. Office pictures still come from the apps themselves, as in 0.3.1.
- Slide edits. On a machine that had LibreOffice, a text edit to a `.pptx` no longer says CoCheck can't read inside the file when the slide text is listed below it.
- `connector test` warnings. The warning about a reserved file ending no longer fires for a built-in connector reached through a symlink. The overlap and reserved-ending warnings now appear wherever the folder sits on the command line, including after an option such as `--timeout`.
- Smaller. The in-tree Office renderers that 0.3.1 replaced are deleted.

Known limits in this build:

- The limits listed under 0.3.2 and 0.3.1 still apply.

## 0.3.2

Connectors are easier to build and harder to get wrong.

- Starter kit in the Mac install. `cocheck connector create` and `cocheck connector test` now work from a Homebrew install. Before, the kit was missing there. If the template is ever missing, `connector create` says so plainly.
- Created items. A remote item that an agent creates during a call is now recorded as created. Before, the page said CoCheck could not read it.
- Tools that create items. A connector can now name a new item from the tool's answer, with the new `matches.calls` block in its manifest. Before, such a call got no row, because the item's id exists only after the call. See "Items a tool creates" in the connector spec.
- A stricter `connector test`. It sends real `diffs` requests from samples the author supplies, and a sample kind or a create tool it did not exercise is reported as untested, never as passed. `connector test` and `connector doctor` warn when a connector claims a file ending that CoCheck keeps for its own connectors. The spec lists all eleven.
- No silent misses. When CoCheck's review process is not running or does not answer, a remote change it could not record shows on the page as a gap for that call.
- Releases check themselves. A release fails if a native helper is missing or built for one architecture only. A test builds an install from the Homebrew formula and runs the connector commands from it.
- Docs. `docs/hooks.md` is checked against the code, and `CONTRIBUTING.md` has an architecture section.
- For connector authors. The spec has a new section, "Thinking about, not built". It lists four ideas we have not built. If one would be valuable to you, open an issue and tell us.

Known limits in this build:

- `created: true` is the connector author's word. If an earlier call in the same task read an item and then failed, was stopped, or is still running, and a create tool then returns that same item, CoCheck shows it as created and does not show what was there before.
- Naming a new item from the tool's answer is checked with Claude Code. On Copilot such a call shows as a gap for now. Codex has not been checked.
- A tool that answers in prose, not JSON, shows as a gap.
- The limits listed under 0.3.1 still apply.

## 0.3.1

On macOS, the pictures of Word, Excel and PowerPoint files now come from the apps themselves.

- Real app pictures. When an agent changes a `.docx`, `.xlsx` or `.pptx`, the review shows Word's pages, PowerPoint's slides and Excel's sheets as the app draws them. The app runs hidden on a private display, so nothing appears on your screen. When the app cannot be drawn from the screen, the card shows the app's print pages and says so.
- Excel. Changed regions are marked on the picture. A chart edit says what changed (title, type, series, axis). A sheet that holds only charts is pictured.
- Faster. Fixed waits on the screen path are now polls, two Excel sheets share one launch, and a view Excel's grid cannot be located in costs no launch.
- What it needs. macOS asks for the Screen Recording grant for the app that hosts your agent. Run `cocheck setup excel-pictures` once; `cocheck connector doctor` says where things stand. See [excel-screen-look.md](excel-screen-look.md).

Known limits in this build:

- A large workbook can run out of screen time; the sheets that did not fit are shown from Excel's print pages, with a note.
- A Word document that mixes portrait and landscape pages is shown from Word's print pages.
- A session started in a folder that already holds files can list those files as created outside the agents. Start in a new folder to avoid it.
- Windows is unchanged in this build: the new pictures are macOS only.

## 0.1.4

The review page gets a bar, notes and leader lines. The brand is final. The command line is tidier.

- The review bar. A bar on the review page steps through the changes, with Pass and Fail and their keys, in both views. Failing opens a composer in the bar for your note and the boxes or freehand marks. This replaces the old fail box and region tool. The step arrows are centred.
- Sticky notes. A Note button in the bar adds a note to a task. You can list, edit and delete notes, and the page marks where they sit. Sending a task back carries the notes and marks them as sent.
- Leaders. Each change card gets one leader line to its place: a slide card to the slide's box, a Word card to the box for its matched text (whole words, three letters or more), otherwise the first box.
- Clean view. A toggle hides notes, leaders and change boxes so you see the plain diff.
- Newest first. A button beside the view switch flips the rail so the newest step is on top. CoCheck remembers your choice.
- Faster refresh. The page polls every second while the task is live and every three seconds when idle, and skips rebuilding when nothing changed.
- Structure issues. Problems with a file's structure are shown in plain words with a fix prompt you can copy to the agent.
- Saved drafts. A failed step's draft saves again when you restore and re-save it.
- Region pictures. Pictures of marked regions are copied into the task folder, under `.cocheck/regions`. They are removed file by file when the task expires.
- Command line. `cocheck help` exits 0. `cocheck uninstall` no longer prints a backup date it did not measure, and cleans up the review files of a review process it has confirmed is yours. `cocheck install` says where the key lives. The skill no longer offers a close action. Send-back says when tracking is off.
- The brand. CoCheck has its final look: the wordmark in the page header, the mark as the page icon, and the new top of the README.

## Windows test build

CoCheck can now be installed on Windows with Claude Code. Install it from the release tarball: download `cocheck-X.Y.Z.tgz` from the GitHub release, run `npm install -g` on the file, then `cocheck install --home "$env:USERPROFILE\CoCheckData" --for claude`. You need Node 22.18 or newer. `docs/install.md` has the steps under "Install on Windows".

What is tested on Windows CI: the typecheck and every Windows-specific test file (the hook launcher, the platform layer, the DPAPI key that seals your data, an install round trip for three hosts, Open in Excel, and the review process identity). Codex and Copilot are tested on Windows CI but not yet claimed. The fast tier also runs on Windows CI, but it has known failures there, mostly tests that assume a Mac, and we are working through them. CI is a portability signal and does not block a merge. The "Pack and install the npm tarball" step also passes on windows-latest, from Git Bash, cmd.exe and PowerShell. Open a new PowerShell window after `npm install -g` so `cocheck` is on PATH.

What is not done yet: live Excel capture through COM is parked, and the plugin is parked. Codex and Copilot are documented for Mac only; this build claims Claude Code on Windows and nothing more. No code changed in this docs item.

## Front-door docs: install, README and package description

`docs/install.md` now walks a first-time user in order: install, start tracking, find the review page, stop tracking. It says plainly that every session starts untracked, so a user who skips "start tracking" sees an empty review page. It also says that only tracked sessions get the where-to-save and how-to-open text, because untracked sessions get none. `README.md` is rewritten for what CoCheck is today (hooks capture agent work across Claude Code, Codex and Copilot; the live before-and-after review page with attribution; Mac today, other platforms planned) and no longer describes the retired MCP gateway. `package.json` carries the same description and a version number that has since been superseded by the 0.1.x releases below. No code changed.

## Next build: every file state of a task is kept for its life

The hook adapter now keeps the whole bytes of every file in the task folder at every step where it changed, in `~/.cocheck/tasks/<id>/states/` (owner-only), named by hash and written once per hash.
**This replaces the earlier promise that file copies are kept "as briefly as possible": rules (c), (d) and (g) are retired for these states**.

- What is kept: a copy of every file at the start of the task (any type, under the scan caps: 500 files, 200 MB), then every state of each file that changed, with the step it changed at. The scan caps limit only that starting copy: a file past them is a fingerprint at the start, but every later state of a file the task writes is kept whole.
- How long: across rounds. At sign-off the states between each file's first and final state are deleted; the first and final stay until the 30-day value expiry, then they are deleted too. A task that is never signed off ends at the 7-day idle expiry, which deletes its states. The record of what changed (hashes, cells, calls) stays in the ledger.
- Size limits, each said in words in the record: above 25 MB a file keeps its first and current state only; past 1 GB for a task the middle states drop to hashes (largest non-office files first, other non-office files next, office files xlsx, xlsm, docx and pptx last; when that is not enough, the first and current states of non-office files drop too, largest first, then office files; the current state of a workbook stays until its next state is saved); a file past the scan caps at the start is kept as a fingerprint only; one file larger than the 1 GB budget is a fingerprint only.
- The old folder-keyed `hooks/<key>/copies` moves into the task's store at the next hook event.
- The ledger moves to schema version 12 (adds the `steps`, `file_states` and `state_removals` tables, with `credited_json` on the first two); an older build can't open it afterwards.
- The gateway's own round copies (the diff bases of `cocheck_submit`) are unchanged and still follow the earlier rules (c), (d) and (g).

## Also in the next build: file copies kept as briefly as possible (the earlier rules), as amended by the entry above

**Back up `~/.cocheck` before you install this build if you want to keep its file copies.**
The first start of this build deletes file copies under `~/.cocheck/tasks/`, which sit outside git:

- Every copy of a signed-off task, and every copy of a task with no activity for 7 days.
- Every older copy of a still-open task, keeping only the latest copy of each file.
- For a task that was submitted final but not signed off, the copies of files the task never touched.

What stays: the ledger (rows, decisions, sign-off records, file hashes), the review pages and exports.
A task with no agent or reviewer activity for 7 days closes as "expired, not signed off".
The before and after values of a task closed (signed off or expired) more than 30 days ago are removed from the ledger; locations and file fingerprints stay, and its page says the values were expired.
Everything under `~/.cocheck` becomes owner-only (files 0600, folders 0700).
**The first start also rewrites the ledger, and that cannot be undone.** It closes every unsigned task with no agent or reviewer activity for 7 days as "expired, not signed off", and it removes the before and after values, notes and answers from every task closed (signed off or expired) more than 30 days ago. Both are irreversible once the ledger is rewritten, so the backup you take before installing is the only way back, and it covers the ledger as well as the file copies.
Activity means any agent tool call on the task or any reviewer action (page open, round cut, decision, request). The sweep runs at start and then hourly while CoCheck runs.
The ledger moves to schema version 10; an older build can't open it afterwards.
