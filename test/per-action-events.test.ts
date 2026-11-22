import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { openLedger } from "../src/ledger.ts";
import { registerHost, type HostProfile } from "../src/hosts/index.ts";
import { profileOf } from "../src/hosts/index.ts";
const claude = profileOf("claude");
import { toolGroup } from "../src/hosts/tool-classes.ts";
import { workbookClaims } from "./helpers/claims.ts";

// A harness that reports each action on its own event (a file edit, a shell run) is read through the same paths as tool calls: a file edit is
// a Write/Edit call's proof for the session that sent it, and a shell Pre or Post that shares a tool call's id is that call, not a second one.
// The harness here is a test-only profile registered at test time; no profile for it ships in src/hosts/.

const ide: HostProfile = {
  ...claude,
  key: "fixture-ide",
  displayName: "Fixture IDE",
  chip: "F",
  extras: undefined,
  argvTag: undefined,
  sessionEnv: undefined,
  install: undefined,
  foreignHookFingerprint: undefined,
  capabilities: { failureEvent: false, argvTag: false, helperSessions: false, launchKey: false, readsForeignHooks: false },
  eventKinds: { preToolUse: "tool-pre", postToolUse: "tool-post", afterFileEdit: "file-edit", beforeShellExecution: "shell-pre", afterShellExecution: "shell-post", beforeSubmitPrompt: "prompt", stop: "stop", sessionStart: "session-start", sessionEnd: "session-end" },
  fields: { ...claude.fields, session: "conversation_id" },
  perAction: { fileEditTool: "FileEdit", shellTool: "Shell", fields: { editPath: "file_path", editList: "edits", editContent: "content", command: "command", exitCode: "exit_code", output: "output" } },
  toolClasses: {
    ...toolGroup("edit", ["Edit", "FileEdit"], { pathFields: ["file_path"], pathChecked: true, fileInput: true }),
    ...toolGroup("write", ["Write"], { pathFields: ["file_path"], pathChecked: true, fileInput: true }),
    ...toolGroup("shell", ["Shell", "Bash"]),
  },
};
let undo: (() => void) | undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  undo?.();
  undo = undefined;
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const BASE = "a,b\n1,2\n";
const NEW = "a,b\n3,4\n";

/** A tracked folder with a warmed session, a first change by a shell call (which opens the task), and a csv the edits change. */
async function rig(host: string) {
  const home = await tmp("home");
  const folder = await tmp("folder");
  const a = path.join(folder, "a.xlsx");
  await copyFile(probe(0), a);
  const c = path.join(folder, "c.csv");
  await writeFile(c, BASE);
  let clock = Date.parse("2026-10-26T14:00:00Z");
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ transcript_path: "/x/t.jsonl", cwd: folder, ...over } as HookPayload, { host, home, claimed: workbookClaims, folder, now: () => clock });
  };
  const sid = (session: string) => (host === "claude" ? { session_id: session } : { conversation_id: session, generation_id: `gen-${session}` });
  const ev = (event: string, session: string, over: Record<string, unknown> = {}) => send({ hook_event_name: event, ...sid(session), ...over });
  const pre = host === "claude" ? "PreToolUse" : "preToolUse";
  const post = host === "claude" ? "PostToolUse" : "postToolUse";
  await ev(pre, "s1", { tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await ev(post, "s1", { tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await ev(host === "claude" ? "Stop" : "stop", "s1", { last_assistant_message: "warmed" });
  await ev(pre, "s1", { tool_name: "Bash", tool_use_id: "F", tool_input: { command: "python3 first.py" } });
  await copyFile(probe(1), a);
  await ev(post, "s1", { tool_name: "Bash", tool_use_id: "F", tool_input: { command: "python3 first.py" } });
  const db = () => new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
  const states = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null && path.basename(s.filePath) === "c.csv").map((s) => ({ credited: [...s.credited].sort(), basis: s.creditBasis }));
    } finally {
      l.close();
    }
  };
  /** The ops that carry a call id, as `[call id, session, tool]`, in order. */
  const callOps = () => {
    const d = db();
    try {
      return (d.prepare("SELECT args_json FROM ops ORDER BY id").all() as Array<{ args_json: string }>)
        .map((r) => JSON.parse(r.args_json) as Record<string, unknown>)
        .filter((a) => typeof a.tool_use_id === "string")
        .map((a) => [a.tool_use_id, a.session_id, a.closedBy] as [string, string, string]);
    } finally {
      d.close();
    }
  };
  return { ev, c, folder, states, callOps, pre, post, put: (t: string) => writeFile(c, t), sid };
}

describe("per-action events", () => {
  it("normalizes a file edit, a shell Pre and a shell Post onto the tool the profile declares, and the new kinds map through", () => {
    undo = registerHost(ide);
    const edit = normalize("fixture-ide", { hook_event_name: "afterFileEdit", conversation_id: "c1", tool_use_id: "t1", file_path: "/w/a.txt", edits: [{ old_string: "x", new_string: "y" }] });
    assert.equal(edit.kind, "file-edit");
    assert.equal(edit.toolName, "FileEdit");
    assert.deepEqual(edit.toolInput, { file_path: "/w/a.txt", edits: [{ old_string: "x", new_string: "y" }] });
    assert.equal(edit.session, "c1");
    assert.equal(edit.toolUseId, "t1");
    const whole = normalize("fixture-ide", { hook_event_name: "afterFileEdit", conversation_id: "c1", file_path: "/w/a.txt", content: "all" });
    assert.deepEqual(whole.toolInput, { file_path: "/w/a.txt", content: "all" });
    const sh = normalize("fixture-ide", { hook_event_name: "beforeShellExecution", conversation_id: "c1", command: "ls", cwd: "/w" });
    assert.deepEqual([sh.kind, sh.toolName, sh.toolInput, sh.cwd, sh.toolResponse], ["shell-pre", "Shell", { command: "ls" }, "/w", undefined]);
    const done = normalize("fixture-ide", { hook_event_name: "afterShellExecution", conversation_id: "c1", command: "ls", exit_code: 2, output: "boom" });
    assert.deepEqual([done.kind, done.toolResponse], ["shell-post", { exit_code: 2, output: "boom" }]);
    assert.equal(normalize("fixture-ide", { hook_event_name: "sessionStart", conversation_id: "c1" }).kind, "session-start");
    assert.equal(normalize("fixture-ide", { hook_event_name: "sessionEnd", conversation_id: "c1" }).kind, "session-end");
    // a host with no per-action declaration reads these kinds as plain events, never as a tool call
    assert.equal(normalize("claude", { hook_event_name: "afterFileEdit", session_id: "s", file_path: "/w/a" }).toolName, undefined);
  });

  it("a file-edit credits the changed file to the session that sent it with host-reported-edit proof, exactly as a Claude Edit call does", async () => {
    undo = registerHost(ide);
    const viaEdit = await rig("claude");
    await viaEdit.ev("PreToolUse", "s1", { tool_name: "Edit", tool_use_id: "W", tool_input: { file_path: viaEdit.c, old_string: "1,2", new_string: "3,4" } });
    await viaEdit.put(NEW);
    await viaEdit.ev("PostToolUse", "s1", { tool_name: "Edit", tool_use_id: "W", tool_input: { file_path: viaEdit.c, old_string: "1,2", new_string: "3,4" } });
    const twin = viaEdit.states().at(-1)!;
    assert.equal(twin.basis, "host-reported-edit");

    const viaEvent = await rig("fixture-ide");
    await viaEvent.put(NEW);
    await viaEvent.ev("afterFileEdit", "s1", { tool_use_id: "W", file_path: viaEvent.c, edits: [{ old_string: "1,2", new_string: "3,4" }] });
    const got = viaEvent.states().at(-1)!;
    assert.deepEqual(got, twin);
    assert.deepEqual(viaEvent.callOps().filter((o) => o[0] === "W"), [["W", "s1", "post"]]);
  });

  it("a file-edit with no id is credited to its own call of the session that sent it, even with another session's call open", async () => {
    undo = registerHost(ide);
    const t = await rig("fixture-ide");
    // session s2 has a shell call open that only reads; session s1 reports the edit
    await t.ev(t.pre, "s2", { tool_name: "Bash", tool_use_id: "other", tool_input: { command: "cat c.csv" } });
    await t.put(NEW);
    await t.ev("afterFileEdit", "s1", { file_path: t.c, edits: [{ old_string: "1,2", new_string: "3,4" }] });
    const s = t.states().at(-1)!;
    const ops = t.callOps();
    const mine = ops.find((o) => o[0].startsWith("file-edit-"));
    assert.ok(mine, "the edit became an op of its own, not dropped");
    assert.equal(mine![1], "s1");
    assert.ok(s.credited.every((id) => id !== "other"), "credited to the sending session's call, not the other session's");
    assert.deepEqual(s.credited, [mine![0]]);
    assert.equal(s.basis, "host-reported-edit");
  });

  it("an edit that does not replay on the recorded state stays inferred: a harness that only says a file changed never outranks a Write call", async () => {
    undo = registerHost(ide);
    const t = await rig("fixture-ide");
    await t.put("a,b\n9,9\n");
    await t.ev("afterFileEdit", "s1", { tool_use_id: "W", file_path: t.c, edits: [{ old_string: "1,2", new_string: "3,4" }] });
    const s = t.states().at(-1)!;
    assert.notEqual(s.basis, "host-reported-edit");
    assert.deepEqual(s.credited, ["W"]);
    // and an event naming no strings (nothing to replay) is credited but never proven
    await t.put("a,b\n5,6\n");
    await t.ev("afterFileEdit", "s1", { tool_use_id: "V", file_path: t.c });
    const v = t.states().at(-1)!;
    assert.deepEqual(v.credited, ["V"]);
    assert.notEqual(v.basis, "host-reported-edit");
  });

  it("a file-edit that reports whole content proves like a Write", async () => {
    undo = registerHost(ide);
    const t = await rig("fixture-ide");
    await t.put(NEW);
    await t.ev("afterFileEdit", "s1", { tool_use_id: "W", file_path: t.c, content: NEW });
    assert.deepEqual(t.states().at(-1), { credited: ["W"], basis: "host-reported-edit" });
  });

  describe("one call reported by two events is one op", () => {
    const run = async (shellId: string) => {
      const t = await rig("fixture-ide");
      await t.ev(t.pre, "s1", { tool_name: "Bash", tool_use_id: "C1", tool_input: { command: "echo hi" } });
      await t.ev("beforeShellExecution", "s1", { tool_use_id: shellId, command: "echo hi" });
      await t.ev("afterShellExecution", "s1", { tool_use_id: shellId, command: "echo hi", exit_code: 0 });
      await t.ev(t.post, "s1", { tool_name: "Bash", tool_use_id: "C1", tool_input: { command: "echo hi" } });
      return t.callOps().filter((o) => o[0] === "C1" || o[0] === shellId);
    };
    it("a tool-pre and a shell-pre with one id give one op", async () => {
      undo = registerHost(ide);
      assert.deepEqual(await run("C1"), [["C1", "s1", "post"]]);
    });
    it("different ids give two ops", async () => {
      undo = registerHost(ide);
      assert.deepEqual((await run("C2")).map((o) => o[0]).sort(), ["C1", "C2"]);
    });
    it("a shell-pre first and then the tool-pre of the same id is still one op, and a shell-post then tool-post closes it once", async () => {
      undo = registerHost(ide);
      const t = await rig("fixture-ide");
      await t.ev("beforeShellExecution", "s1", { tool_use_id: "C3", command: "echo hi" });
      await t.ev(t.pre, "s1", { tool_name: "Bash", tool_use_id: "C3", tool_input: { command: "echo hi" } });
      await t.ev("afterShellExecution", "s1", { tool_use_id: "C3", command: "echo hi", exit_code: 0 });
      await t.ev(t.post, "s1", { tool_name: "Bash", tool_use_id: "C3", tool_input: { command: "echo hi" } });
      assert.deepEqual(t.callOps().filter((o) => o[0] === "C3"), [["C3", "s1", "post"]]);
    });
    it("a shell call reported only by its shell events is a call of its own, and is write-scoped like a shell call", async () => {
      undo = registerHost(ide);
      const t = await rig("fixture-ide");
      await t.ev("beforeShellExecution", "s1", { tool_use_id: "S1", command: "cat c.csv" });
      await t.put(NEW);
      await t.ev("afterShellExecution", "s1", { tool_use_id: "S1", command: "cat c.csv", exit_code: 0 });
      assert.deepEqual(t.callOps().filter((o) => o[0] === "S1"), [["S1", "s1", "post"]]);
      // a read-only command takes no write credit, as a Bash call of that command would not
      assert.deepEqual(t.states().filter((s) => s.credited.includes("S1")), []);
    });
  });

  describe("a file-edit and a tool call", () => {
    it("with a matching id attaches its proof to the open call: one op, host-reported-edit", async () => {
      undo = registerHost(ide);
      const t = await rig("fixture-ide");
      await t.ev(t.pre, "s1", { tool_name: "Bash", tool_use_id: "W", tool_input: { command: "true" } });
      await t.put(NEW);
      await t.ev("afterFileEdit", "s1", { tool_use_id: "W", file_path: t.c, edits: [{ old_string: "1,2", new_string: "3,4" }] });
      await t.ev(t.post, "s1", { tool_name: "Bash", tool_use_id: "W", tool_input: { command: "true" } });
      assert.deepEqual(t.callOps().filter((o) => o[0] === "W"), [["W", "s1", "post"]]);
      assert.deepEqual(t.states().at(-1), { credited: ["W"], basis: "host-reported-edit" });
    });
    it("without an id opens its own op beside the open tool call", async () => {
      undo = registerHost(ide);
      const t = await rig("fixture-ide");
      await t.ev(t.pre, "s1", { tool_name: "Edit", tool_use_id: "W", tool_input: { file_path: t.c, old_string: "1,2", new_string: "3,4" } });
      await t.put(NEW);
      await t.ev("afterFileEdit", "s1", { file_path: t.c, edits: [{ old_string: "1,2", new_string: "3,4" }] });
      await t.ev(t.post, "s1", { tool_name: "Edit", tool_use_id: "W", tool_input: { file_path: t.c, old_string: "1,2", new_string: "3,4" } });
      const ids = t.callOps().map((o) => o[0]).filter((id) => id === "W" || id.startsWith("file-edit-"));
      assert.equal(ids.length, 2);
      assert.ok(ids.includes("W"));
    });
    it("an id another session's call holds is not that call: the edit gets its own op in its own session", async () => {
      undo = registerHost(ide);
      const t = await rig("fixture-ide");
      await t.ev(t.pre, "s2", { tool_name: "Bash", tool_use_id: "W", tool_input: { command: "true" } });
      await t.put(NEW);
      await t.ev("afterFileEdit", "s1", { tool_use_id: "W", file_path: t.c, edits: [{ old_string: "1,2", new_string: "3,4" }] });
      const mine = t.callOps().find((o) => o[0].startsWith("file-edit-"));
      assert.ok(mine);
      assert.equal(mine![1], "s1");
    });
  });

  it("session-start and session-end are recognised kinds the adapter records nothing for", async () => {
    undo = registerHost(ide);
    const t = await rig("fixture-ide");
    const before = t.callOps();
    await t.ev("sessionStart", "s9");
    await t.ev("sessionEnd", "s9");
    assert.deepEqual(t.callOps(), before);
  });
});
