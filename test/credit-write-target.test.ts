import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { writeTargetsOf } from "../src/credit-guard.ts";
import { isReadOnlyCommand } from "../src/attribution/write-scope.ts";
import { workbookClaims } from "./helpers/claims.ts";

// A call whose own input names the changed file wins the credit, and a read-only shell command never takes write credit. The Copilot
// 1.0.103 replay of the real stdin is in copilot-write-credit.test.ts; here the Codex shape (the shared harness): a `cat` reader open
// beside a silent writer, and the named-writer cases.
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const book = path.join(folder, "a.xlsx");
  await copyFile(probe(0), book);
  let clock = 1_000_000;
  const opts = { perSession: false, host: "codex" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const call = (event: string, id: string, tool: string, input: unknown, agent?: string) =>
    send({ hook_event_name: event, tool_name: tool, tool_use_id: id, tool_input: input, ...(agent ? { agent_id: agent } : {}) });
  const credited = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.filePath === book && s.credited.length > 0).map((s) => s.credited);
    } finally {
      l.close();
    }
  };
  await call("PreToolUse", "warm", "shell", { command: "true" });
  await call("PostToolUse", "warm", "shell", { command: "true" });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  return { call, credited, write: (n: number) => copyFile(probe(n), book) };
}

/** A main-thread shell call with `command` open beside a helper's silent writer (`python3 edit.py`, whose scope is a hooked run, not a read). */
async function readerBesideWriter(command: string) {
  const t = await setup();
  await t.call("PreToolUse", "r1", "shell", { command });
  await t.call("PreToolUse", "w1", "shell", { command: "python3 edit.py" }, "helperA");
  await t.write(1);
  await t.call("PostToolUse", "w1", "shell", { command: "python3 edit.py" }, "helperA");
  return t.credited();
}

describe("(Codex): a read-only reader open beside a silent writer is not credited", () => {
  it("`cat a.xlsx` takes no credit; the writer alone does", async () => {
    assert.deepEqual(await readerBesideWriter("cat a.xlsx"), [["w1"]]);
  });
  for (const cmd of ["wc -l a.xlsx", "git status --short", "head -c 10 a.xlsx", "rg x a.xlsx && ls", "git diff HEAD", "stat a.xlsx", "file a.xlsx", "less a.xlsx", "tail -n 2 a.xlsx 2>/dev/null"]) {
    it(`read-only form: ${cmd}`, async () => {
      assert.deepEqual(await readerBesideWriter(cmd), [["w1"]]);
    });
  }
  // Must not happen: a command that writes through a read-only verb stays a suspect, as before (these name no file, so the Codex name-match stays out of it)
  for (const cmd of ["cat x > f", "wc -l x > b", "git status > f", "head x | tee f", "sed -i s/a/b/ x", "git diff > p", "cat x >> log", "git diff --output=p", "less -o out x", "rg --pre ./x y z", "git -c core.pager=x log", "git commit -am x", "cat x | tee f"]) {
    it(`never read-only: ${cmd}`, async () => {
      assert.deepEqual(await readerBesideWriter(cmd), [["r1", "w1"]]);
    });
  }
});

describe("a call whose own input names the file takes the credit alone", () => {
  it("an apply_patch with an Update File header beats an unrelated overlapping shell call", async () => {
    const t = await setup();
    await t.call("PreToolUse", "s1", "shell", { command: "python3 other.py" });
    await t.call("PreToolUse", "p1", "apply_patch", "*** Begin Patch\n*** Update File: a.xlsx\n@@\n-x\n+y\n*** End Patch", "helperA");
    await t.write(1);
    await t.call("PostToolUse", "p1", "apply_patch", "*** Begin Patch\n*** Update File: a.xlsx\n@@\n-x\n+y\n*** End Patch", "helperA");
    assert.deepEqual(t.credited(), [["p1"]]);
  });

  it("must not: a patch naming another file leaves the credit joint", async () => {
    const t = await setup();
    await t.call("PreToolUse", "s1", "shell", { command: "python3 other.py" });
    await t.call("PreToolUse", "p1", "apply_patch", "*** Begin Patch\n*** Add File: notes.md\n+x\n*** End Patch", "helperA");
    await t.write(1);
    await t.call("PostToolUse", "p1", "apply_patch", "*** Begin Patch\n*** Add File: notes.md\n+x\n*** End Patch", "helperA");
    assert.deepEqual(t.credited(), [["p1", "s1"]]);
  });
});

describe("write targets named by a call's own input", () => {
  it("apply_patch headers, create/edit paths, Write/Edit file_path", () => {
    assert.deepEqual(writeTargetsOf("apply_patch", "*** Begin Patch\n*** Add File: a.md\n+x\n*** Update File: sub/b.md\n*** Move to: c.md\n*** Delete File: d.md\n*** End Patch"), ["a.md", "sub/b.md", "c.md", "d.md"]);
    assert.deepEqual(writeTargetsOf("apply_patch", { input: "*** Begin Patch\n*** Update File: a.md\n*** End Patch" }), ["a.md"]);
    assert.deepEqual(writeTargetsOf("create", { path: "/w/x.md", file_text: "t" }), ["/w/x.md"]);
    assert.deepEqual(writeTargetsOf("edit", { path: "/w/x.md", old_str: "a", new_str: "b" }), ["/w/x.md"]);
    assert.deepEqual(writeTargetsOf("Write", { file_path: "/w/x.md", content: "t" }), ["/w/x.md"]);
    assert.deepEqual(writeTargetsOf("Edit", { file_path: "/w/x.md" }), ["/w/x.md"]);
  });
  it("nothing from a shell command, a read tool, or a header-looking line that is not at a line start", () => {
    assert.deepEqual(writeTargetsOf("bash", { command: "echo '*** Add File: a.md'" }), []);
    assert.deepEqual(writeTargetsOf("view", { path: "/w/x.md" }), []);
    assert.deepEqual(writeTargetsOf("apply_patch", "+ *** Add File: a.md"), []);
    assert.deepEqual(writeTargetsOf(undefined, { path: "x" }), []);
  });
});

describe("isReadOnlyCommand", () => {
  it("known read-only forms", () => {
    for (const c of ["wc -l memo.md", "cat a", "head -n 3 a", "tail -f a", "less a", "grep -n x a", "rg x", "ls -la", "stat a", "file a", "git status --short", "git diff", "git log --oneline", "git show HEAD", "test -f a && wc -l a", "cat a 2>/dev/null", "cat a 2>&1 | wc -l", "echo a && cat b"]) assert.equal(isReadOnlyCommand(c), true, c);
  });
  it("must not: a write through a read-only verb is never read-only", () => {
    for (const c of ["cat x > f", "cat x >> f", "wc -l a > b", "git status > f", "head x | tee f", "sed -i s/a/b/ a", "git diff > p", "cat a &> f", "cat a >| f", "ls | xargs rm", "cat a; rm a", "cat a && touch b", "cat a && mkdir d", "cp a b", "git checkout .", "git commit -m x", "git status; git add .", "python3 -c 1", "less -o f a", "less +!touch a", "file -C", "rg --pre sh x", "git diff --output=p", "git log --ext-diff", "git -C d status", "cat $(touch f)", "cat a <<EOF > f\nx\nEOF", "", "sed -n 1p a", "echo one", "pwd", "printf x", "test -f a", "date"]) assert.equal(isReadOnlyCommand(c), false, JSON.stringify(c));
  });
});
