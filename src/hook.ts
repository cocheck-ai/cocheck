#!/usr/bin/env node
// Host hook entry: `node src/hook.ts --host claude|codex [--folder <dir>] [--outside-watching on|off]`, hook payload JSON on stdin. See hook-cli.ts, hook-adapter.ts and docs/hooks.md.
// Prints nothing on stdout (a Claude Code Stop hook's stdout is read as a decision) except, on UserPromptSubmit in a watched folder, the
// short context text Claude Code adds to the session (src/session-context.ts), and on a Bash PreToolUse the attribution tag
// (src/attribution/tag.ts). Failure exits 1, never 2:
// exit 2 would block the host's tool call, and a broken adapter must not stop the agent's work.
import path from "node:path";
import { homedir } from "node:os";
import { resolveAdapterHome } from "./hook-adapter.ts";
import { runHook } from "./hook-cli.ts";
import { refreshStaleReview } from "./review-refresh.ts";

const result = await runHook({ argv: process.argv, env: process.env, stdin: process.stdin });
// A review server left over from an older install is replaced by a detached child; never delays or fails the hook beyond a 300 ms probe.
try {
  await refreshStaleReview(resolveAdapterHome(process.env, path.join(homedir(), ".cocheck")));
} catch {
  // best effort
}
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
if (result.exitCode !== 0) process.exit(result.exitCode);
