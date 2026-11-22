# Release notes

## 0.4.1 Preview

- **Agents as data.** Each supported agent is now described by a manifest file instead of code. Claude Code, Codex and Copilot ship built in. Cursor and Antigravity CLI work through the harness kit: `cocheck install --for cursor` prints the hooks to add. See [hooks.md](hooks.md).
- **Add an agent without touching CoCheck's code.** `cocheck harness create`, `record` and `test` take you from a recording of an agent's hooks to a tested manifest. Try one from your data folder, or send it by pull request ([CONTRIBUTING.md](../CONTRIBUTING.md)).
- **Agents that run other agents' hooks.** Cursor also runs Claude Code's hooks. A harness can now declare this, so CoCheck credits Cursor's work to Cursor, not to Claude, once Cursor's own hook is installed.
- **Fixes.** Files already in a folder are no longer listed as "Created" when tracking starts. A session's task stops collecting changes after "stop tracking". Copilot events are read under their real event names. An edit reported as a folder's first event now shows its change. A tool call that reuses an earlier call's id is kept as its own call, so its changes are credited to it.

## 0.4.0 Preview (first public release)

The first public build of CoCheck. It works, and it has bugs: please open an issue when something breaks or reads wrong.

CoCheck shows what AI agents changed in your files, step by step, on a local review page that says which agent action made each change.

- **Agents.** CoCheck hooks into Claude Code, Codex and Copilot as they work. The agent needs no special tools. It runs on a Mac, and on Windows with Claude Code; Windows, Codex and Copilot have had less testing than Claude Code on a Mac.
- **Install.** `brew install cocheck-ai/tap/cocheck` or `npm install -g cocheck`, then `cocheck install --home <data folder>` from the folder you want watched. With no `--for`, it sets up every supported agent present on the machine. `cocheck status` says whether it is recording; `cocheck uninstall` removes the hooks and keeps your data. See [install.md](install.md).
- **Tracking is per session and off by default.** Tell the agent "start tracking" and "stop tracking". An untracked session records nothing.
- **The review page.** Say "show me the review" or run `cocheck open`. For each step you see the before and after of every file the task touched, which agent call made each change (or that several overlapping calls share it, or that it was a hand edit), and a pass or fail control so you can send failed steps back or sign off.
- **File types.** Text and code get a line diff, PDFs get pages with the changes boxed, and common image formats are shown from the stored file. Excel, Word and PowerPoint files are read by three built-in connectors; when the Office app is installed they also show the app's own printed pages. A file with no reader gets a fingerprint.
- **Connectors.** Anyone can add support for another file type or app with a connector; [public-kit/GUIDE.md](../public-kit/GUIDE.md) walks through building one. `cocheck connector list`, `enable` and `disable` choose which connector shows each file type.
- **Local and encrypted.** The page is served on your machine, and the record and file copies stay in the data folder you chose, with stored file copies encrypted at rest (see [security.md](security.md)).
