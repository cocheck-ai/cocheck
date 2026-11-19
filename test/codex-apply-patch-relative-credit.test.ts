import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { editTargetsOf, reportedEditsOf } from "../src/credit-guard.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Codex's apply_patch names its files RELATIVE to the session cwd (live run 2026-11-01, Codex 0.162/0.166: `*** Add File: t04/notes.md`, the patch
// text in tool_input.command). The exact-credit path (`host-reported-edit`) only took absolute paths, so every Codex apply_patch was "Inferred".
// Must not happen: a relative patch path that resolves to a different file than the one that changed must stay inferred.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-cxpatch-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const abs = (p: string) => p.startsWith("/");
const sha = (t: string) => `h:${t}`;
const rel = (cwd: string) => (p: string) => path.posix.resolve(cwd, p); // the POSIX paths this test pins, on any OS

async function rig(cwdSub: string) {
  const home = await tmp("home");
  const root = await tmp("folder");
  // like the live run: the watched folder holds a session cwd with a space in the parent's name
  const folder = path.join(root, "CoCheck Testing");
  const cwd = path.join(folder, cwdSub);
  await mkdir(path.join(cwd, "t04"), { recursive: true });
  const a = path.join(cwd, "a.xlsx");
  await copyFile(probe(0), a);
  const notes = path.join(cwd, "t04", "notes.md");
  const other = path.join(cwd, "t04", "other.md");
  await writeFile(other, "x\n");
  let clock = Date.parse("2026-11-01T14:00:00Z");
  const opts = { host: "codex" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const call = (event: string, id: string, name: string, input: unknown) => send({ hook_event_name: event, tool_name: name, tool_use_id: id, tool_input: input });
  const states = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).map((s) => ({ file: path.basename(s.filePath), prev: s.prevSha256 !== null, basis: s.creditBasis }));
    } finally {
      l.close();
    }
  };
  await call("PreToolUse", "warm", "Bash", { command: "true" });
  await call("PostToolUse", "warm", "Bash", { command: "true" });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  await call("PreToolUse", "F", "Bash", { command: "python3 first.py" });
  await copyFile(probe(1), a);
  await call("PostToolUse", "F", "Bash", { command: "python3 first.py" });
  return { call, states, notes, other, cwd };
}

describe("Codex apply_patch with a relative path", () => {
  const ADD = "*** Begin Patch\n*** Add File: t04/notes.md\n+# Plan\n+- a\n*** End Patch";
  const UPD = "*** Begin Patch\n*** Update File: t04/notes.md\n@@\n # Plan\n-- a\n+- b\n*** End Patch";
  const patch = async (t: Awaited<ReturnType<typeof rig>>, id: string, command: string, disk: string, file = t.notes) => {
    const input = { command };
    await t.call("PreToolUse", id, "apply_patch", input);
    await writeFile(file, disk);
    await t.call("PostToolUse", id, "apply_patch", input);
  };
  const notesStates = (t: Awaited<ReturnType<typeof rig>>) => t.states().filter((s) => s.file === "notes.md");

  it("Add File then Update File by relative path are host-reported-edit (cwd is a subfolder with a space in its parent)", async () => {
    const t = await rig("codex run");
    await patch(t, "P1", ADD, "# Plan\n- a\n");
    await patch(t, "P2", UPD, "# Plan\n- b\n");
    assert.deepEqual(notesStates(t).map((s) => s.basis), ["host-reported-edit", "host-reported-edit"], JSON.stringify(t.states()));
  });
  it("must not: a relative patch naming notes.md while other.md changed stays inferred", async () => {
    const t = await rig("codex-run");
    await patch(t, "P1", ADD, "unrelated\n", t.other);
    assert.ok(t.states().every((s) => s.basis !== "host-reported-edit" || s.file === "a.xlsx"), JSON.stringify(t.states()));
  });
  it("must not: the patch text differs from the bytes on disk stays inferred", async () => {
    const t = await rig("codex-run");
    await patch(t, "P1", ADD, "# Plan\n- zzz\n");
    assert.ok(notesStates(t).every((s) => s.basis !== "host-reported-edit"), JSON.stringify(t.states()));
  });
  it("reportedEditsOf and editTargetsOf resolve relative apply_patch headers when given a resolver; Delete and Move to stay dropped", () => {
    const r = rel("/w/cwd");
    assert.deepEqual(reportedEditsOf("apply_patch", { command: ADD }, abs, sha, r).map((e) => e.path), ["/w/cwd/t04/notes.md"]);
    assert.deepEqual(editTargetsOf("apply_patch", { command: UPD }, abs, r), ["/w/cwd/t04/notes.md"]);
    assert.deepEqual(reportedEditsOf("apply_patch", { command: "*** Delete File: t04/a\n" }, abs, sha, r), []);
    assert.deepEqual(reportedEditsOf("apply_patch", { command: "*** Update File: t04/a\n*** Move to: t04/b\n@@\n+x" }, abs, sha, r), []);
    // a file tool's relative path is still not resolved (it stays inferred)
    assert.deepEqual(reportedEditsOf("Write", { file_path: "a", content: "x" }, abs, sha, r), []);
    assert.equal(editTargetsOf("Write", { file_path: "a" }, abs, r), undefined);
  });
});
