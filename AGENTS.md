# CoCheck, for agents

You are probably an AI agent that found this repository for a person. This file tells you what CoCheck is, how it works, what state it is in, how to install it for your user, and how to use it. Everything here is drawn from the docs in this repository. Where this file and a doc disagree, the doc wins.

In one paragraph: CoCheck records what AI agents change in a person's files and shows every change on a local review page, before and after, with the agent action that made it. The person reads the page, passes or fails each step, and signs off. It hooks into Claude Code, Codex and Copilot. It runs on the person's own machine and sends nothing anywhere by default.

## Contents

1. [What it is](#1-what-it-is): a review page for agent work, built for the person, not the agent.
2. [How it works](#2-how-it-works): host hooks, whole-file states, a local ledger, a local page.
3. [State of the project](#3-state-of-the-project): early (`cocheck --version` prints the version), lightly tested. Read this before recommending it.
4. [Install it for your user](#4-install-it-for-your-user): ask first, then two commands on a Mac.
5. [Use it in a session](#5-use-it-in-a-session): `cocheck track start`, save inside the task folder, `cocheck open`.
6. [Commands](#6-commands): the whole command line in one table.
7. [Connectors](#7-connectors): Excel, Word and PowerPoint built in; a kit to build others.
8. [Where to read more](#8-where-to-read-more): the doc for each topic.
9. [Short version](#9-short-version): the five things to remember.

## 1. What it is

CoCheck is a work visualizer with agent attribution. An agent works in a folder. CoCheck keeps the state of each file before and after each step. The review page shows the two side by side with the change marked, and says which agent call made it.

It exists so a person can check agent work quickly and stay responsible for it. It does not grade the work and it does not block the agent. The person decides.

It handles any file type. Text and code get a line diff, and PDFs get pages with the changes boxed. Excel, Word and PowerPoint files are read by the three built-in connectors, which show a change list and, when the Office app is installed, pictures printed by that app. CoCheck itself does not read, draw or open Office files.

## 2. How it works

- **Hooks.** `cocheck install` adds hooks to the host's own configuration (Claude Code, Codex or Copilot). The host runs them before and after every tool call. The agent needs no special tools and cannot skip them.
- **Tracking is off by default.** Every session starts untracked. An untracked session records nothing and gets no extra text in its context. Tracking is per session.
- **States.** In a tracked session, each hook run compares the task folder with the last stored state and stores whole copies of files that changed. Copies live in the data folder the person chose at install.
- **Attribution.** A change is credited to the agent calls that were open when the hook found it. When several calls overlap, they share the credit, and the page says so. A change found with no call open is shown as not from an agent call. Stronger attribution is in the works and is not available yet.
- **The review page.** A local process serves the page to the person's browser. Nothing leaves the machine.
- **Storage.** Up to 1 GB per task. Stored copies are encrypted at rest; see `docs/security.md`. A task that is never signed off expires after 7 idle days.

## 3. State of the project

Be honest with your user about this.

- Early software (`cocheck --version` prints the version), lightly tested, with bugs expected.
- The code was written by an AI agent under the author's direction. The author says in the README that the author has not extensively reviewed the code. Treat it as unaudited.
- CoCheck is a preview release. It installs from Homebrew (macOS) or npm (macOS and Windows).
- Platforms: macOS, with Claude Code, Codex or Copilot. Windows works with Claude Code only, as a test build. Codex and Copilot are not supported on Windows yet. Linux is not supported.
- It needs Node 22.18 or newer. Homebrew installs Node for you on a Mac.
- Office pictures come from the Office connectors, and they need Microsoft Excel, Word or PowerPoint on the machine. No macOS permission is needed for them. Without the app the review still works, with the change list and no pictures.
- The author's own notes, including known limits, are at the top of `README.md`.

## 4. Install it for your user

Ask before you install. The install edits the host's settings file, adds a skill file, and makes every tool call run a hook (under 1 second per call). Tell your user that, and ask where CoCheck should keep its data. There is no default data folder.

From the folder CoCheck should watch. On a Mac:

```
brew install cocheck-ai/tap/cocheck
cocheck install --home ~/CoCheckData --for claude
```

On a Mac or Windows:

```
npm install -g cocheck
cocheck install --home ~/CoCheckData --for claude
```

- `--home` is required and must be an absolute path. It must not be `~/.cocheck` or inside it.
- `--for` names the host: `claude`, `codex`, `copilot`, a comma list, or `all`. Pass it every time, so only the hosts your user wants are touched.
- `--folder <dir>` sets the watched folder. It defaults to the folder you run the command from.
- The installer backs up each settings file it touches as `<file>.cocheck-backup` and puts everything back if its own check fails.

After installing:

1. Tell your user to quit the host and start it again. The host reads its settings at start.
2. For Codex, your user must trust the new hooks once when Codex asks. Until then Codex records nothing.
3. Run `cocheck status`. It says whether each host's hooks are installed and recording, and gives the reason when they are not.

For Windows details, and for installing from a source checkout, follow `docs/install.md`. Do not guess the steps.

To remove it, run `cocheck uninstall` first, then `brew uninstall cocheck` (or `npm uninstall -g cocheck`). Uninstall removes only what CoCheck added. It deletes none of the person's data and prints where that data is.

## 5. Use it in a session

When your user says "start tracking", run this as your own shell command:

```
cocheck track start
```

It only works when you run it inside your session, because the hook has to see it. Typing it in a separate terminal changes nothing. Tracking begins with your next tool call. The folder you are working in becomes the task folder.

While the session is tracked:

- Save your work inside the task folder. Files outside it are not recorded.
- Work as you normally would. You do not call CoCheck to record anything.
- When your user asks to see the review, run `cocheck open`. It opens the page in their browser.
- When your user says "is it tracking", run `cocheck track status`.
- When your user says "stop tracking", run `cocheck track stop`. What was recorded stays.

The review page is for the person. Do not pass or fail steps for them, and do not sign off for them.

If CoCheck says `CoCheck: not recording.`, read the reason it prints and tell your user. Do not keep working as if the session were recorded.

## 6. Commands

| Command | What it does |
|---|---|
| `cocheck install --home <dir> [--folder <dir>] [--for <hosts>]` | Adds the hooks and the skill for the named hosts and registers the watched folder. |
| `cocheck uninstall [--for <hosts>]` | Removes CoCheck's hooks and skill files. Keeps the data. |
| `cocheck status` | Says whether each host is installed and recording, and why not. |
| `cocheck track start` | Starts tracking this session. Run by the agent, inside the session. |
| `cocheck track stop` | Stops tracking this session. |
| `cocheck track status` | Lists the sessions tracked right now. |
| `cocheck open [task]` | Opens the review page, for the latest task or a numbered one. |
| `cocheck connector create <dir> --id <id>` | Writes a starter connector project. |
| `cocheck connector test <dir>` | Tests a connector against recorded states or the conformance cases. |
| `cocheck connector doctor [<id>]` | Reports the health of installed connectors. |
| `cocheck connector auth <id> --name <credential>` | Stores or deletes a credential for a connector. |
| `cocheck connector list` | For each file type, the connectors that claim it and which one is enabled. |
| `cocheck connector enable\|disable <id> <type>` | Chooses which connector shows a file type. |
| `cocheck --help`, `cocheck --version` | Usage and version. |

## 7. Connectors

A connector teaches CoCheck to read one product: given two saved states of an item, it answers what changed. Three ship with CoCheck: Microsoft Excel, Word and PowerPoint. They are connectors on the same standard as any other: the same manifest, the same answers, the same checks. CoCheck's own code does not read, draw or order Office files. The few things a built-in still has that an outside connector does not are listed in `public-kit/GUIDE.md`. Files with no connector still get a text diff, pages (PDF) or a fingerprint.

Anyone can build a connector, including for a product reached through an MCP tool. If your user asks for one, start at `public-kit/GUIDE.md`. An installed connector lives in `connectors/<id>/` inside the data folder passed to `cocheck install --home`. It goes from nothing to a connector that passes `cocheck connector test`. The specification is in `public-kit/spec/`.

## 8. Where to read more

- `README.md`: the author's notes and the overview.
- `docs/install.md`: every install path, tracking, uninstall, troubleshooting.
- `docs/hooks.md`: how the hooks record and attribute changes, and the harness model (how an agent is described by a manifest).
- `public-kit/harness/`: the harness kit, for adding another agent: `GUIDE.md` first, then `spec/v1.md`. Cursor and Antigravity CLI are supported through it. The README's Supported agents table lists every harness.
- `docs/timeline.md`: how the review page is built.
- `docs/security.md`: encryption of stored copies.
- `docs/release-notes.md`: what changed in each version.
- `platforms/README.md`: what each agent platform lets CoCheck do, with sources.
- `public-kit/`: the connector kit.
- `CONTRIBUTING.md` and `SECURITY.md`: building, testing, and reporting a security problem.

## 9. Short version

1. CoCheck shows a person what an agent changed in their files, before and after, on a local page. It is for the person's review.
2. It is early, unaudited and a preview. Say so when you recommend it.
3. Ask your user before installing. Then: `brew install cocheck-ai/tap/cocheck` (macOS) or `npm install -g cocheck` (macOS and Windows), `cocheck install --home <dir> --for <host>`, restart the host, `cocheck status`.
4. In a session: `cocheck track start` when asked, save inside the task folder, `cocheck open` when asked.
5. When unsure, read `docs/install.md`. It is the authority.
