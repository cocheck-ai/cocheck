import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { profileOf, registerHost, type HostProfile } from "../src/hosts/index.ts";
const claude = profileOf("claude");
import { toolGroup } from "../src/hosts/tool-classes.ts";

// A harness that reports a file edit on its own event: when that is the first event the hook sees in a folder (nothing is recorded yet to diff
// against), the edit is still the agent's. It opens an op of its own in the sending session that names the file, credited and never proven.
const ide: HostProfile = {
  ...claude,
  key: "fixture-first",
  displayName: "Fixture First",
  chip: "F",
  extras: undefined,
  argvTag: undefined,
  sessionEnv: undefined,
  install: undefined,
  foreignHookFingerprint: undefined,
  capabilities: { failureEvent: false, argvTag: false, helperSessions: false, launchKey: false, readsForeignHooks: false },
  eventKinds: { afterFileEdit: "file-edit", preToolUse: "tool-pre", postToolUse: "tool-post", stop: "stop", beforeSubmitPrompt: "prompt" },
  fields: { ...claude.fields, session: "conversation_id" },
  perAction: { fileEditTool: "FileEdit", shellTool: "Shell", fields: { editPath: "file_path", editList: "edits", editContent: "content", command: "command" } },
  toolClasses: { ...toolGroup("edit", ["FileEdit"], { pathFields: ["file_path"], pathChecked: true, fileInput: true }), ...toolGroup("shell", ["Shell"]) },
};
let undo: (() => void) | undefined;
const dirs: string[] = [];
afterEach(async () => {
  undo?.();
  undo = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async (n: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${n}-`)));
  dirs.push(d);
  return d;
};

describe("a file-edit that is the first event in a folder", () => {
  it("opens its own op naming the file in the sending session, and the file is never shown as proven", async () => {
    undo = registerHost(ide);
    const home = await tmp("home");
    const folder = await tmp("folder");
    const file = path.join(folder, "notes.txt");
    await writeFile(file, "after\n");
    let clock = Date.parse("2026-11-21T14:00:00Z");
    const send = (over: Record<string, unknown>) => handleHook({ cwd: folder, conversation_id: "s1", ...over } as unknown as HookPayload, { host: "fixture-first", home, folder, now: () => (clock += 1000) });
    await send({ hook_event_name: "afterFileEdit", file_path: file, edits: [{ old_string: "before", new_string: "after" }] });
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    const ops = (db.prepare("SELECT args_json FROM ops ORDER BY id").all() as Array<{ args_json: string }>).map((r) => JSON.parse(r.args_json) as Record<string, any>);
    db.close();
    const mine = ops.find((o) => typeof o.tool_use_id === "string" && o.tool_use_id.startsWith("file-edit-"));
    assert.ok(mine, `an op of its own: ${JSON.stringify(ops)}`);
    assert.equal(mine!.session_id, "s1");
    assert.ok(JSON.stringify(mine).includes("notes.txt"), "the op names the file");
    const l = openLedger(home);
    try {
      const st = l.fileStatesForTask(1).filter((s) => path.basename(s.filePath) === "notes.txt");
      assert.ok(st.length > 0, "the file has a state");
      assert.ok(st.every((s) => s.creditBasis !== "host-reported-edit"), "no proof without a state to replay on");
      // With no earlier state of the file there is no change to credit a step to: the op that names the file is the agent's record of it.
    } finally {
      l.close();
    }
  });
  it("records the edit's old text as the file's before-state, so the step shows the change, credited to the edit and never proven", async () => {
    undo = registerHost(ide);
    const home = await tmp("home");
    const folder = await tmp("folder");
    const file = path.join(folder, "notes.txt");
    await writeFile(file, "line one\nafter\nline three\n");
    let clock = Date.parse("2026-11-21T14:00:00Z");
    const send = (over: Record<string, unknown>) => handleHook({ cwd: folder, conversation_id: "s1", ...over } as unknown as HookPayload, { host: "fixture-first", home, folder, now: () => (clock += 1000) });
    await send({ hook_event_name: "afterFileEdit", file_path: file, edits: [{ old_string: "before", new_string: "after" }] });
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const l = openLedger(home);
    try {
      const st = l.fileStatesForTask(1).filter((s) => path.basename(s.filePath) === "notes.txt");
      const change = st.find((s) => s.prevSha256 !== null);
      assert.ok(change, `a change of the file: ${JSON.stringify(st.map((s) => [s.prevSha256, s.sha256]))}`);
      assert.equal(change!.prevSha256, sha("line one\nbefore\nline three\n"), "the before-state is the file with the edit's old text");
      assert.equal(change!.sha256, sha("line one\nafter\nline three\n"));
      assert.ok(change!.credited.some((c) => c.startsWith("file-edit-")), `credited to the edit: ${JSON.stringify(change!.credited)}`);
      assert.notEqual(change!.creditBasis, "host-reported-edit", "a before-state rebuilt from the edit itself never proves the edit");
    } finally {
      l.close();
    }
  });

  it("rebuilds no before-state when the edit's new text is not found exactly once", async () => {
    undo = registerHost(ide);
    const home = await tmp("home");
    const folder = await tmp("folder");
    const file = path.join(folder, "notes.txt");
    await writeFile(file, "after\nafter\n");
    let clock = Date.parse("2026-11-21T14:00:00Z");
    const send = (over: Record<string, unknown>) => handleHook({ cwd: folder, conversation_id: "s1", ...over } as unknown as HookPayload, { host: "fixture-first", home, folder, now: () => (clock += 1000) });
    await send({ hook_event_name: "afterFileEdit", file_path: file, edits: [{ old_string: "before", new_string: "after" }] });
    const l = openLedger(home);
    try {
      const st = l.fileStatesForTask(1).filter((s) => path.basename(s.filePath) === "notes.txt");
      assert.ok(st.length > 0, "the file has a state");
      assert.ok(st.every((s) => s.prevSha256 === null), `no guessed before-state: ${JSON.stringify(st.map((s) => [s.prevSha256, s.sha256]))}`);
    } finally {
      l.close();
    }
  });
});
