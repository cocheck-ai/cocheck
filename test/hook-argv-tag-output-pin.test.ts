// Pins what Claude Code's PreToolUse hook prints for a real Bash call (the argv tag) and the exit code, byte for byte.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runHook } from "../src/hook-cli.ts";
import { startSession } from "./helpers/track.ts";
import { isWindows } from "./helpers/platform.ts";
import { prepareSession } from "../src/attribution/tag.ts";

const RECORDING = path.resolve(import.meta.dirname, "..", "platforms", "claude-code", "versions", "2.1.302", "payloads.jsonl");
const records = readFileSync(RECORDING, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; stdin: string });
const firstBashPre = records.find((r) => r.event === "PreToolUse")!;
const payload = JSON.parse(firstBashPre.stdin);

async function pre(extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "cocheck-tagpin-home-"));
  const folder = mkdtempSync(path.join(tmpdir(), "cocheck-tagpin-folder-"));
  prepareSession(home, payload.session_id, [folder], Date.now());
  startSession(home, "claude", payload.session_id);
  const body = Buffer.from(JSON.stringify({ ...payload, ...extra }));
  return runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", folder], env: { COCHECK_HOME: home, SHELL: "/bin/bash", ...env }, stdin: (async function* () { yield body; })() });
}

describe("Claude Code argv tag output", () => {
  it("the recording's first PreToolUse is a Bash call", () => {
    assert.equal(payload.hook_event_name, "PreToolUse");
    assert.equal(payload.tool_name, "Bash");
  });
  it("prints the whole input with the command tagged, as hookSpecificOutput.updatedInput, and exits 0", async () => {
    const res = await pre();
    assert.equal(res.exitCode, 0, res.stderr);
    // The per-call tag is POSIX-shell only by design (src/attribution/tag.ts: a session on another dialect sets nothing), so on Windows the hook tags nothing.
    if (isWindows) return assert.equal(res.stdout, "");
    const expected = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...payload.tool_input, command: `${payload.tool_input.command}\n# cocheck-call:${payload.tool_use_id}:main` } } }) + "\n";
    assert.equal(res.stdout, expected);
    assert.equal(res.stdout.startsWith('{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{'), true);
    assert.match(res.stdout, /\\n# cocheck-call:toolu_[A-Za-z0-9]+:main"/);
  });
  it("a non-Bash tool prints nothing, and tagging off prints nothing", async () => {
    assert.equal((await pre({ tool_name: "Read" })).stdout, "");
    const off = await pre({}, { COCHECK_ATTRIBUTION_TAG: "off" });
    assert.equal(off.exitCode, 0);
    assert.equal(off.stdout, "");
  });
});
