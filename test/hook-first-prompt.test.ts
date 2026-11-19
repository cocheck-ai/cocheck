import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { runHook } from "../src/hook-cli.ts";
import { dumpLedger, journalRecords, makeRig, type Rig } from "./hook-corpus.ts";
import { startSession } from "./helpers/track.ts";

// a tracked session's first prompt opens the task, so the request shows at UserPromptSubmit and a page opened at the start of a
// drive has it. An untracked session's prompt still opens nothing: no task, no ledger row, no journal record.
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.cleanup(); });
const rig = async () => { const r = await makeRig(); rigs.push(r); return r; };
const fire = (r: Rig, payload: unknown) => runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder], env: { COCHECK_HOME: r.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() });
const prompt = (r: Rig, session: string, text: string) => ({ session_id: session, cwd: r.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: text });
const ledgerText = (r: Rig) => JSON.stringify(dumpLedger(r.home, r.folder));

describe("the first prompt of a drive", () => {
  it("a tracked session's first prompt opens the task and writes the request", async () => {
    const r = await rig();
    startSession(r.home, "claude", "s-tracked", r.folder);
    await fire(r, prompt(r, "s-tracked", "Raise every price by 5%"));
    const d = dumpLedger(r.home, r.folder);
    assert.equal(d.tasks!.length, 1, "a task is open");
    assert.ok(ledgerText(r).includes("Raise every price by 5%"), "the request text is in the ledger");
  });

  it("an untracked session's prompt opens nothing and records nothing", async () => {
    const r = await rig();
    await fire(r, prompt(r, "s-untracked", "Raise every price by 5%"));
    assert.equal(existsSync(path.join(r.home, "ledger.sqlite")) ? (dumpLedger(r.home, r.folder).tasks ?? []).length : 0, 0, "no task");
    if (existsSync(path.join(r.home, "ledger.sqlite"))) assert.ok(!ledgerText(r).includes("Raise every price"), "no request text");
    assert.deepEqual(journalRecords(r.home), [], "no journal record");
  });

  it("a second tracked session's prompt does not reopen or duplicate: one task, the prompt once", async () => {
    const r = await rig();
    startSession(r.home, "claude", "s-tracked", r.folder);
    await fire(r, prompt(r, "s-tracked", "First ask"));
    await fire(r, prompt(r, "s-tracked", "Second ask"));
    const d = dumpLedger(r.home, r.folder);
    assert.equal(d.tasks!.length, 1);
    const text = ledgerText(r);
    assert.equal(text.split("First ask").length - 1, 1);
    assert.equal(text.split("Second ask").length - 1, 1);
  });
});
