import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { journalRecords, makeRig, type Rig } from "./hook-corpus.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { journalSessionKey, readJournalSession } from "../src/hook-journal.ts";

// A Copilot CLI payload is camelCase (`sessionId`, `toolName`, ...) and names no event: the hook command passes `--event`.
// The shapes are the real ones from platforms/copilot-cli/versions/1.0.103/raw-hook-stdin.jsonl. The journal record of such an
// event carries the host's event name and the session the adapter files it under, not "unknown".
const SESSION = "d9b2e3f7-09b6-44cb-bf5e-e3b760bb42b4";
const HELPER = "24353f5c-439a-42a5-a8b3-c3a7ae64d58e";
const rigs: Rig[] = [];
afterEach(async () => {
  delete process.env.COPILOT_HOME;
  for (const r of rigs.splice(0)) await r.cleanup();
});

/** The hook command as the host runs it, in process; Copilot's session-state folder is a temp dir. */
async function send(r: Rig, event: string, payload: unknown) {
  const copilotHome = await mkdtemp(path.join(tmpdir(), "cocheck-copilot-"));
  await mkdir(path.join(copilotHome, "session-state"), { recursive: true });
  process.env.COPILOT_HOME = copilotHome;
  return runHook({ argv: ["node", "hook.ts", "--host", "copilot", "--event", event, "--folder", r.folder], env: { COCHECK_HOME: r.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() });
}

describe("the journal names a Copilot event by the normalized event", () => {
  it("a camelCase preToolUse: its record carries the event name and a session file of its own", async () => {
    const r = await makeRig();
    rigs.push(r);
    const pre = { sessionId: SESSION, timestamp: 1792885640039, cwd: r.folder, toolName: "bash", toolArgs: { command: "ls", description: "list" } };
    const run = await send(r, "preToolUse", pre);
    assert.equal(run.exitCode, 0, run.stderr);
    const [ev] = journalRecords(r.home).filter((x) => x.k === "event");
    assert.equal(ev.event, "preToolUse");
    assert.equal(ev.host, "copilot");
    assert.equal(readJournalSession(r.home, journalSessionKey(SESSION)).filter((x) => x.k === "event").length, 1, "filed under the session's own journal");
    assert.equal(readJournalSession(r.home, "unknown").length, 0, "nothing in the shared unknown bucket");
  });
  it("a helper's event is filed under the main session, as the adapter does", async () => {
    const r = await makeRig();
    rigs.push(r);
    const stop = { sessionId: HELPER, parentAgentId: SESSION, agentId: HELPER, agentType: "memo-writer", timestamp: 1792885640039, cwd: r.folder, stopReason: "end_turn", stop_hook_active: false, transcriptPath: "/x/t.jsonl" };
    const run = await send(r, "agentStop", stop);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(readJournalSession(r.home, journalSessionKey(SESSION)).filter((x) => x.k === "event" && x.event === "agentStop").length, 1);
  });
});
