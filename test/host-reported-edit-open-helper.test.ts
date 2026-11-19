import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evidenceDir } from "../src/attribution/tag.ts";
import { hostReportedEdit } from "../src/attribution/basis.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { createPathKit } from "../src/paths.ts";
import { platformFor } from "../src/platform/index.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a Write or Edit is proven (host-reported-edit) even when another helper had a call open. Exact reconstruction is the proof, so an
// open-but-uncredited suspect no longer blocks it, and a change first credited at another call's sweep is upgraded at the editing call's own
// successful Post. The three recorded (Windows laptop, v0.1.21) cases are replayed below from the shapes in the drive report; the drive's raw ledger is
// not on this Mac. Accepted bound: a concurrent writer producing exactly the same bytes is undetectable (declared it).
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const BASE = "a,b\n1,2\n";
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);

async function rig() {
  const home = await tmp("home");
  const folder = await tmp("folder");
  const a = path.join(folder, "a.xlsx");
  await copyFile(probe(0), a);
  const b = path.join(folder, "b.xlsx");
  await copyFile(probe(0), b);
  const c = path.join(folder, "c.csv");
  await writeFile(c, BASE);
  let clock = Date.parse("2026-10-26T14:00:00Z");
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>, taggedCall = false) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, { ...opts, taggedCall });
  };
  const bash = (event: string, id: string, command: string, tagged = false) => send({ hook_event_name: event, tool_name: "Bash", tool_use_id: id, tool_input: { command } }, tagged);
  const tool = (event: string, id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => send({ hook_event_name: event, tool_name: name, tool_use_id: id, tool_input: input, ...extra });
  const wrote = async (call: string, file: string) => {
    await mkdir(evidenceDir(home), { recursive: true });
    await appendFile(path.join(evidenceDir(home), `writes-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ v: 1, call, pid: 1, ts: clock, op: "write", agent: "a1", path: file, via: "python" }) + "\n");
  };
  const states = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null).map((s) => ({ file: path.basename(s.filePath), credited: [...s.credited].sort().join("+"), basis: s.creditBasis }));
    } finally {
      l.close();
    }
  };
  await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  // a first change by a shell call opens the task
  await bash("PreToolUse", "F", "python3 first.py");
  await copyFile(probe(1), a);
  await bash("PostToolUse", "F", "python3 first.py");
  return { bash, tool, wrote, send, states, a, b, c, put: (text: string) => writeFile(c, text), write: (n: number) => copyFile(probe(n), a) };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const rows = (t: Rig, file = "c.csv") => t.states().filter((s) => s.file === file);
const last = (t: Rig, file = "c.csv") => rows(t, file).at(-1)!;
const NEW = "a,b\n3,4\n";
const PROVEN = "host-reported-edit";
const never = (t: Rig) => {
  assert.ok(rows(t).length > 0, "a change was recorded");
  for (const r of rows(t)) assert.notEqual(r.basis, PROVEN, JSON.stringify(rows(t)));
};

describe("recorded cases, replayed (red on v0.1.21: 82303f5)", () => {
  // Drive case 1: build_memo.js, Write by helper 1 while helper 2's `npm install` was open. v0.1.21 cause: `guarded` (the suspects before the credit was
  // narrowed to the Write that names the file) held the npm install, so `guarded` was not a subset of `credited` and the basis stayed "named".
  it("drive case 1: a Write with another helper's npm install open is host-reported-edit", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "N", "cd /scratch/helper2 && npm install docx");
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.put(NEW);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    assert.deepEqual(last(t), { file: "c.csv", credited: "W", basis: PROVEN });
  });
  // Drive case 2: build_deck.js, Write by helper 2 while helper 1's PowerShell Word call was open. Same cause as case 1, with a PowerShell tool as the suspect.
  it("drive case 2: a Write with another helper's PowerShell call open is host-reported-edit", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "P", "PowerShell", { command: "$w = New-Object -ComObject Word.Application" });
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.put(NEW);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    assert.deepEqual(last(t), { file: "c.csv", credited: "W", basis: PROVEN });
  });
  // Drive case 3: c37, the Edit of build_deck.js with only helper 1's Read open. v0.1.21 cause: the Read's Post sweep found the change while the Edit was
  // still open, so the change was stored there with origin = the Read; `#hostEdit` returns false unless the origin is the credit's own call, the stored
  // row was never revisited at the Edit's own Post, and with nothing narrowed the basis read "window".
  const edit = { old_string: "1,2", new_string: "3,4" };
  const c37 = async (t: Rig, post: () => Promise<unknown>) => {
    await t.tool("PreToolUse", "E", "Edit", { file_path: t.c, ...edit });
    await t.tool("PreToolUse", "R", "Read", { file_path: t.b });
    await t.put(NEW);
    await t.tool("PostToolUse", "R", "Read", { file_path: t.b });
    await post();
  };
  it("drive case 3 (c37): an Edit stored at another call's Read sweep is upgraded at its own Post", async () => {
    const t = await rig();
    await c37(t, () => t.tool("PostToolUse", "E", "Edit", { file_path: t.c, ...edit }));
    assert.deepEqual(last(t), { file: "c.csv", credited: "E", basis: PROVEN });
  });
  it("drive case 3: before the Edit's own Post the change is inferred (the Edit is still open)", async () => {
    const t = await rig();
    await c37(t, async () => {});
    assert.equal(last(t).credited, "E");
    assert.notEqual(last(t).basis, PROVEN);
  });
  it("control: a Write after the other helper finished was already host-reported-edit", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.put(NEW);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    assert.equal(last(t).basis, PROVEN);
  });
});

describe("these stay inferred", () => {
  it("a concurrent writer producing different bytes, helper's npm install open, stays inferred", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "N", "npm install");
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.put("a,b\n3,4\n5,6\n");
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    never(t);
  });
  it("an Edit stored at another call's sweep whose bytes are not what it reported is not upgraded", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "E", "Edit", { file_path: t.c, old_string: "1,2", new_string: "3,4" });
    await t.tool("PreToolUse", "R", "Read", { file_path: t.b });
    await t.put("a,b\n9,9\n");
    await t.tool("PostToolUse", "R", "Read", { file_path: t.b });
    await t.tool("PostToolUse", "E", "Edit", { file_path: t.c, old_string: "1,2", new_string: "3,4" });
    never(t);
  });
  // A shell is never credited jointly with a file tool that names the file: the credit narrows to the call whose own input names it (`#namedByInput`),
  // so the shell's own write shows up as bytes the file tool did not report. These two cases are that joint-shell direction.
  it("a shell alongside that writes other bytes stays inferred, with the Write still open and after its Post", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.bash("PreToolUse", "S", `echo 5,6 >> ${t.c}`);
    await t.put("a,b\n3,4\n5,6\n");
    await t.bash("PostToolUse", "S", `echo 5,6 >> ${t.c}`);
    never(t);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    never(t);
  });
  it("a shell whose output the Write then matches is still never credited with proof: two file-tool calls credited jointly stay inferred", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.tool("PreToolUse", "W2", "Write", { file_path: t.c, content: NEW });
    await t.put(NEW);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.tool("PostToolUse", "W2", "Write", { file_path: t.c, content: NEW });
    never(t);
  });
  it("a file also written by another call's tagged process stays inferred", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "S", "python3 plain.py", true);
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.wrote("S", t.c);
    await t.put(NEW);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    never(t);
  });
  it("a failed Write with another call open stays inferred", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "N", "npm install");
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.put(NEW);
    await t.tool("PostToolUseFailure", "W", "Write", { file_path: t.c, content: NEW }, { error: "boom", is_interrupt: false });
    never(t);
  });
  it("an Edit stored at another call's sweep, then failing, is never proven", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "E", "Edit", { file_path: t.c, old_string: "1,2", new_string: "3,4" });
    await t.tool("PreToolUse", "R", "Read", { file_path: t.b });
    await t.put(NEW);
    await t.tool("PostToolUse", "R", "Read", { file_path: t.b });
    await t.tool("PostToolUseFailure", "E", "Edit", { file_path: t.c, old_string: "1,2", new_string: "3,4" }, { error: "boom", is_interrupt: false });
    never(t);
    await t.tool("PostToolUse", "E", "Edit", { file_path: t.c, old_string: "1,2", new_string: "3,4" });
    never(t);
  });
  it("a still-open call is never proven: nothing is upgraded before its own Post", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.tool("PreToolUse", "R", "Read", { file_path: t.b });
    await t.put(NEW);
    await t.tool("PostToolUse", "R", "Read", { file_path: t.b });
    never(t);
  });
  it("two file-tool calls both credited (both name the file) stay inferred", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.tool("PreToolUse", "E", "Edit", { file_path: t.c, old_string: "1,2", new_string: "3,4" });
    await t.put(NEW);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.tool("PostToolUse", "E", "Edit", { file_path: t.c, old_string: "1,2", new_string: "3,4" });
    never(t);
  });
});

describe("hostReportedEdit without the open-suspect clause (Mac and win32 path forms)", () => {
  const kits = { mac: createPathKit(platformFor("darwin")), win: createPathKit(platformFor("win32")) };
  const base = (same: (a: string, b: string) => boolean, edits: string[]) => ({ credited: ["W"], taggedWriters: [] as string[], file: "", call: (id: string) => (id === "W" ? { edits } : undefined), same, failed: () => false, content: () => true });
  it("mac: an uncredited suspect no longer matters; a tagged writer, a failure and a bad reconstruction still do", () => {
    const f = { ...base(kits.mac.same, ["/w/a.xlsx"]), file: "/w/a.xlsx" };
    assert.equal(hostReportedEdit(f), true);
    assert.equal(hostReportedEdit({ ...f, taggedWriters: ["S"] }), false);
    assert.equal(hostReportedEdit({ ...f, failed: () => true }), false);
    assert.equal(hostReportedEdit({ ...f, content: () => false }), false);
    assert.equal(hostReportedEdit({ ...f, credited: ["W", "S"] }), false);
  });
  it("win32: drive-letter case, separators and Git Bash forms all prove", () => {
    for (const e of ["C:\\Users\\T\\work\\a.xlsx", "c:/users/t/work/A.xlsx", "/c/Users/T/work/a.xlsx"]) {
      const f = { ...base(kits.win.same, [e]), file: "C:/Users/T/work/a.xlsx" };
      assert.equal(hostReportedEdit(f), true, e);
      assert.equal(hostReportedEdit({ ...f, taggedWriters: ["S"] }), false, e);
    }
  });
});
