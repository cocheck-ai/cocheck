# Contributing to CoCheck

## Build

You need Node 22.18 or newer. On a Mac you also need the Xcode command-line tools (`xcode-select --install`): the build compiles the native helpers with `swiftc`. Without `swiftc` the build warns and carries on, and the renderer that needs the helper is absent.

```
npm install
npm run typecheck
npm run build
```

`npm run build` clears `dist/`, compiles `src/` with `tsc`, copies the review page assets, the attribution hooks and the pdf.js files, builds the native helpers and stamps the build.

## Tests

Tests run under the Node test runner through `npm test`. There are two tiers:

- Fast: `npm run test:fast`. Every `*.test.ts` file except the slow ones. Run this before a pull request.
- Slow: `npm run test:slow`. Every `*.slow.test.ts` file: fuzz runs with many seeds, large-workbook ceilings, and renders that use the real PDF helper or the built output.

`npm test` runs both, naming every `*.test.ts` file explicitly. Anything under `test/` that must not run as a test (a stdio connector fixture, a helper) must not end in `.test.ts`; the runner never hands it to node. The runner takes a lock so two runs on one machine do not overlap.

Some tests need macOS (Keychain, `swiftc`, PDFKit). They run locally on a Mac. A CI run on another system skips them or does not cover them, so run the full suite on a Mac before you open a pull request that touches storage, rendering or the installer.

Tests never touch your real data folder, your agent settings or your Homebrew: they use temporary folders. Keep it that way.

## Architecture

This follows one hook event from the agent's host to the review page. [docs/hooks.md](docs/hooks.md) has the rules for each step.

**One hook event.**

- A host runs `dist/hook.js` for each hook event and writes the event's JSON on stdin. `src/hook.ts` hands it to `runHook` in `src/hook-cli.ts` and exits with the code `runHook` returns.
- `runHook` scrubs the payload first. Then the tracking gate returns at once, with nothing written, for a session that has not started tracking.
- For a tracked session `runHook` appends an index line to the hook journal, and then `normalize` in `src/normalize.ts` turns the host's payload into a `NormalizedEvent`.
- `runHook` then calls `handleEvent` in `src/hook-adapter.ts`. The adapter reads the `NormalizedEvent` only, never the raw payload.
- `handleEvent` takes a file lock on the folder's state and calls one handler for the event kind: `pre`, `post`, `stop`, `subagentStop` or `prompt`.
- A handler sweeps the task folder, decides which open calls get credit for each changed file, and queues steps and ops in the adapter's state file. The state is saved before anything is written to the ledger.
- The ledger is the SQLite file `src/ledger.ts` opens. The flush writes the queued steps (`recordStep`) and ops (`recordOp`) to it. A kill between the save and the flush is repaired by the next event.
- A Stop event ends with `TaskStore.submit`, which cuts the round the review page shows.

**Ledger to review page.**

- `loadTimeline` in `src/timeline/load.ts` reads a task's ops and file states from the ledger, and `buildTimeline` in `src/timeline/timeline.ts` turns them into one timeline document.
- The review server in `src/review-server.ts` builds that document for a task and serves it. `src/review-process.ts` starts the server as a long-lived process.

**Connectors.**

- Connector code is in `src/connector/`. The review process owns the connector pool (`createConnectorPool` in `src/review-server.ts`).
- The hook never starts a connector. For a tool that has a subject template, `src/hook-cli.ts` asks the review process for a snapshot before the call and after it, through `src/connector/local-process.ts`.
- A hook that cannot reach the review process records the subject as unknown and carries on.

**Hosts and operating systems.**

- Everything specific to one host is a profile in `src/hosts/` (`claude.ts`, `codex.ts`, `copilot.ts`). `src/hosts/index.ts` lists them, and the core asks a profile rather than comparing host names.
- Operating system code goes behind `platform()` in `src/platform/`, which returns the implementation for the running OS. A few older OS branches still sit outside that folder; do not add more.

## Changes

- Pull requests open and merge on https://github.com/cocheck-ai/cocheck. Work on a branch and open a pull request against `main`.
- To add a connector for another app, follow the guide in [public-kit/GUIDE.md](public-kit/GUIDE.md).
- Add a test for a bug fix, and check that it fails without the fix.
- Keep host names (Claude Code, Codex, Copilot) inside `src/hosts/`, and operating system calls inside `src/platform/`, so other agents and systems can follow.
- Do not add a dependency without saying why in the pull request.
- Third-party code or assets you add go in `THIRD_PARTY_NOTICES.md` with their licence and copyright line.

To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
