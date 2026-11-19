import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evidenceDir } from "../src/attribution/tag.ts";
import { creditBasisOf, hostReportedEdit } from "../src/attribution/basis.ts";
import { editTargetsOf, reportedEditsOf } from "../src/credit-guard.ts";
import { reconstruct } from "../src/attribution/reconstruct.ts";
import { buildTimeline, type FormatChanges, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call as fxCall, prompt as fxPrompt, state as fxState, stop as fxStop } from "./fixtures/timeline.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { createPathKit } from "../src/paths.ts";
import { platformFor } from "../src/platform/index.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a change credited only to host file-edit calls (Write/Edit/MultiEdit/...) that name the changed file by their own absolute path, with no
// failure and no other suspect, is stored as `host-reported-edit` (proof, no "Inferred" badge). Guards against: every case below that must
// stay inferred (shell alongside, other file, no/relative path, failed call, joint credit with a non-file tool, a process rewriting the file).
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
const last = (t: Awaited<ReturnType<typeof rig>>, file = "c.csv") => t.states().filter((s) => s.file === file).at(-1)!;

describe("host-reported-edit through the adapter", () => {
  const NEW = "a,b\n3,4\n";
  const proven = { file: "c.csv", credited: "W", basis: "host-reported-edit" };
  const run = async (t: Awaited<ReturnType<typeof rig>>, name: string, input: Record<string, unknown>, disk: string, post = "PostToolUse", extra: Record<string, unknown> = {}) => {
    await t.tool("PreToolUse", "W", name, input);
    await t.put(disk);
    await t.tool(post, "W", name, input, extra);
  };
  const edit = { old_string: "1,2", new_string: "3,4" };
  it("a Write whose reported content is the recorded bytes is host-reported-edit", async () => {
    const t = await rig();
    await run(t, "Write", { file_path: t.c, content: NEW }, NEW);
    assert.deepEqual(last(t), proven);
  });
  it("an Edit whose new string is in the recorded text, old string gone, is host-reported-edit", async () => {
    const t = await rig();
    await run(t, "Edit", { file_path: t.c, ...edit }, NEW);
    assert.deepEqual(last(t), proven);
  });
  it("a MultiEdit whose new strings are all in the recorded text is host-reported-edit", async () => {
    const t = await rig();
    await run(t, "MultiEdit", { file_path: t.c, edits: [edit, { old_string: "a,b", new_string: "x,y" }] }, "x,y\n3,4\n");
    assert.deepEqual(last(t), proven);
  });

  // must not
  it("a Write, then an untagged process rewriting the file with other bytes in the same window, stays inferred", async () => {
    const t = await rig();
    await run(t, "Write", { file_path: t.c, content: NEW }, "a,b\n3,4\n5,6\n");
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("an Edit whose new string is missing from the recorded text stays inferred", async () => {
    const t = await rig();
    await run(t, "Edit", { file_path: t.c, ...edit }, "a,b\n9,9\n");
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("an Edit whose old string is still there stays inferred", async () => {
    const t = await rig();
    await run(t, "Edit", { file_path: t.c, ...edit }, "a,b\n1,2\n3,4\n");
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("a call that reports no content (Write without content, Edit without strings) stays inferred", async () => {
    const t = await rig();
    await run(t, "Write", { file_path: t.c }, NEW);
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("a shell call credited alongside stays inferred", async () => {
    const t = await rig();
    // a shell merely open (not credited) does not block proof (see tests); one that wrote other bytes still leaves the change inferred
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.bash("PreToolUse", "S", `echo 5,6 >> ${t.c}`);
    await t.put("a,b\n3,4\n5,6\n");
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("a file tool whose path is a different file stays inferred", async () => {
    const t = await rig();
    await run(t, "Write", { file_path: t.b, content: NEW }, NEW);
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("a file tool with no path stays inferred", async () => {
    const t = await rig();
    await run(t, "Write", { content: NEW }, NEW);
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("a file tool with a relative path stays inferred", async () => {
    const t = await rig();
    await run(t, "Write", { file_path: "c.csv", content: NEW }, NEW);
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("a failed file-tool call stays inferred", async () => {
    const t = await rig();
    await run(t, "Write", { file_path: t.c, content: NEW }, NEW, "PostToolUseFailure", { error: "boom", is_interrupt: false });
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("two overlapping calls credited jointly, one not a file tool, stay inferred", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.tool("PreToolUse", "G", "Grep", { pattern: "x" });
    await t.bash("PreToolUse", "S", "python3 plain.py");
    await t.put("a,b\n3,4\n5,6\n"); // the shell's own bytes differ from the Write's report
    await t.bash("PostToolUse", "S", "python3 plain.py");
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    const rows = t.states().filter((s) => s.file === "c.csv");
    assert.ok(rows.length > 0, "a change was recorded");
    for (const r of rows) assert.notEqual(r.basis, "host-reported-edit", JSON.stringify(r));
  });
  it("a file also written by a tagged process in the window stays inferred", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.bash("PreToolUse", "S", "python3 plain.py", true);
    await t.wrote("S", t.c);
    await t.put(NEW);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
});

describe("the reviewer's four probes, and proof only by exact reconstruction", () => {
  const NEW = "a,b\n3,4\n";
  const rows = (t: Awaited<ReturnType<typeof rig>>) => t.states().filter((s) => s.file === "c.csv");
  const not = (t: Awaited<ReturnType<typeof rig>>) => {
    const rows = t.states().filter((s) => s.file === "c.csv");
    assert.ok(rows.length > 0, "a change was recorded");
    for (const r of rows) assert.notEqual(r.basis, "host-reported-edit", JSON.stringify(rows));
  };
  it("(a) a Write credited at another call's sweep, then failing, is never host-reported-edit", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.bash("PreToolUse", "S", "ls");
    await t.put(NEW);
    await t.bash("PostToolUse", "S", "ls");
    await t.tool("PostToolUseFailure", "W", "Write", { file_path: t.c, content: NEW }, { error: "boom", is_interrupt: false });
    not(t);
  });
  it("a call still open when the change is credited is inferred until its own successful Post proves it", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Write", { file_path: t.c, content: NEW });
    await t.bash("PreToolUse", "S", "ls");
    await t.put(NEW);
    await t.bash("PostToolUse", "S", "ls");
    not(t);
    await t.tool("PostToolUse", "W", "Write", { file_path: t.c, content: NEW });
    // proven at its own successful Post (exact reconstruction), not before
    assert.equal(last(t).basis, "host-reported-edit", JSON.stringify(rows(t)));
  });
  it("(b) an Edit whose new string only occurs in unrelated bytes is inferred", async () => {
    const t = await rig();
    await t.tool("PreToolUse", "W", "Edit", { file_path: t.c, old_string: "1,2", new_string: "a" });
    await t.put("xa\n");
    await t.tool("PostToolUse", "W", "Edit", { file_path: t.c, old_string: "1,2", new_string: "a" });
    not(t);
  });
  it("(c) a deletion-only Edit against bytes that merely lack the old string is inferred", async () => {
    const t = await rig();
    const input = { file_path: t.c, old_string: "1,2\n", new_string: "" };
    await t.tool("PreToolUse", "W", "Edit", input);
    await t.put("zzz\n");
    await t.tool("PostToolUse", "W", "Edit", input);
    not(t);
  });
  it("(d) an apply_patch with a blank + line against any other bytes is inferred", async () => {
    const t = await rig();
    const input = { input: `*** Begin Patch\n*** Update File: ${t.c}\n@@\n+\n*** End Patch` };
    await t.tool("PreToolUse", "W", "apply_patch", input);
    await t.put("other\n");
    await t.tool("PostToolUse", "W", "apply_patch", input);
    not(t);
  });
  it("an apply_patch that replays exactly is host-reported-edit", async () => {
    const t = await rig();
    const input = { input: `*** Begin Patch\n*** Update File: ${t.c}\n@@\n a,b\n-1,2\n+3,4\n*** End Patch` };
    await t.tool("PreToolUse", "W", "apply_patch", input);
    await t.put(NEW);
    await t.tool("PostToolUse", "W", "apply_patch", input);
    assert.deepEqual(last(t), { file: "c.csv", credited: "W", basis: "host-reported-edit" });
  });
  it("an Edit whose old string is ambiguous (twice in the file) is inferred, even if the bytes look right", async () => {
    const t = await rig();
    await writeFile(t.c, "a,b\n1,2\n1,2\n");
    await t.bash("PreToolUse", "R", "ls");
    await t.bash("PostToolUse", "R", "ls");
    const input = { file_path: t.c, old_string: "1,2", new_string: "3,4" };
    await t.tool("PreToolUse", "W", "Edit", input);
    await t.put("a,b\n3,4\n1,2\n");
    await t.tool("PostToolUse", "W", "Edit", input);
    assert.notEqual(last(t).basis, "host-reported-edit", JSON.stringify(last(t)));
  });
  it("the review page: a proven change shows no Inferred, every probe's change does", async () => {
    const FILE = "/w/c.csv";
    const FMT: FormatChanges = { module: "xlsx", rows: [], more: 0 };
    const inferred = (basis: string | null): true | undefined => {
      const ops: RawOp[] = [fxPrompt("s1", ["Update it."]), fxCall("c1", { host: "claude", at: 10, end: 40, cmd: "run" }), fxStop("s1")];
      const st: RawState = { ...fxState(FILE, "n1", "n0", { open: ["c1"], credited: ["c1"] }), credit_basis: basis } as RawState;
      const input = { taskId: 1, build: "b", ops, fileStates: [st], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map<string, number>(), formats: new Map([[st.id, FMT]]), quickLook: false, host: "claude" } as TimelineInput;
      const body = JSON.parse(JSON.stringify(buildTimeline(input))) as Timeline;
      const changes = body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((c) => c.changes)));
      assert.equal(changes.length, 1);
      assert.deepEqual(buildRailModel(body).stops.filter((x) => x.change).map((x) => x.change!.inferred), [changes[0]!.inferred]);
      return changes[0]!.inferred;
    };
    const proven = await rig();
    await proven.tool("PreToolUse", "W", "Write", { file_path: proven.c, content: NEW });
    await proven.put(NEW);
    await proven.tool("PostToolUse", "W", "Write", { file_path: proven.c, content: NEW });
    assert.equal(inferred(last(proven).basis), undefined);
    const probe = await rig();
    await probe.tool("PreToolUse", "W", "Edit", { file_path: probe.c, old_string: "1,2", new_string: "a" });
    await probe.put("xa\n");
    await probe.tool("PostToolUse", "W", "Edit", { file_path: probe.c, old_string: "1,2", new_string: "a" });
    assert.equal(inferred(last(probe).basis), true);
  });
});

describe("reconstruct and reportedEditsOf", () => {
  const sha = (t: string) => `sha:${t}`;
  const abs = (p: string) => p.startsWith("/");
  const bytes = (t: string) => new TextEncoder().encode(t);
  const one = (tool: string, input: unknown) => reportedEditsOf(tool, input, abs, sha)[0]!;
  it("Write/create: the reported content's hash, whatever came before", () => {
    assert.equal(reconstruct(one("Write", { file_path: "/w/a", content: "x\r\ny" }), undefined, sha), sha("x\r\ny"));
    assert.equal(reconstruct(one("create", { path: "/w/a", file_text: "q" }), undefined, sha), sha("q"));
  });
  it("Edit: exact replacement; not found, ambiguous, binary and missing before-state are not reconstructable", () => {
    const e = one("Edit", { file_path: "/w/a", old_string: "1", new_string: "2" });
    assert.equal(reconstruct(e, bytes("x1y"), sha), sha("x2y"));
    assert.equal(reconstruct(e, bytes("x1y1"), sha), undefined);
    assert.equal(reconstruct(e, bytes("xy"), sha), undefined);
    assert.equal(reconstruct(e, new Uint8Array([49, 0, 49]), sha), undefined);
    assert.equal(reconstruct(e, new Uint8Array([0xff, 0xfe]), sha), undefined);
    assert.equal(reconstruct(e, undefined, sha), undefined);
    assert.equal(reconstruct(one("Edit", { file_path: "/w/a", old_string: "1", new_string: "2", replace_all: true }), bytes("1_1"), sha), sha("2_2"));
  });
  it("MultiEdit replays in order; an edit with a missing field gives nothing", () => {
    const m = one("MultiEdit", { file_path: "/w/a", edits: [{ old_string: "a", new_string: "b" }, { old_string: "b", new_string: "c" }] });
    assert.equal(reconstruct(m, bytes("a"), sha), sha("c"));
    assert.deepEqual(reportedEditsOf("MultiEdit", { file_path: "/w/a", edits: [{ old_string: "a" }] }, abs, sha), []);
  });
  it("apply_patch: hunks replay; a blank + line is a real added line; an unmatched hunk, a move and a delete give nothing", () => {
    const p = one("apply_patch", "*** Begin Patch\n*** Update File: /w/a\n@@\n a\n+\n-b\n+B\n*** End Patch");
    assert.equal(reconstruct(p, bytes("a\nb\n"), sha), sha("a\n\nB\n"));
    assert.equal(reconstruct(p, bytes("a\nc\n"), sha), undefined);
    assert.equal(reconstruct(one("apply_patch", "*** Add File: /w/n\n+x\n+\n"), bytes(""), sha), sha("x\n\n"));
    assert.deepEqual(reportedEditsOf("apply_patch", "*** Update File: /w/a\n*** Move to: /w/b\n@@\n+x", abs, sha), []);
    assert.deepEqual(reportedEditsOf("apply_patch", "*** Delete File: /w/a", abs, sha), []);
  });
  it("a relative path, an unlisted tool and strings over the size cap give nothing", () => {
    assert.deepEqual(reportedEditsOf("Write", { file_path: "a", content: "x" }, abs, sha), []);
    assert.deepEqual(reportedEditsOf("Bash", { command: "x" }, abs, sha), []);
    assert.deepEqual(reportedEditsOf("Edit", { file_path: "/w/a", old_string: "a", new_string: "b".repeat(70000) }, abs, sha), []);
  });
});

describe("hostReportedEdit and editTargetsOf (Mac and win32 path forms)", () => {
  const kits = { mac: createPathKit(platformFor("darwin")), win: createPathKit(platformFor("win32")) };
  const call = (edits: string[]) => (id: string) => (id === "W" ? { edits } : undefined);
  const base = { credited: ["W"], guarded: ["W"], taggedWriters: [] as string[], failed: () => false, content: () => true };
  it("mac: absolute match proves, a different or missing path does not", () => {
    const same = kits.mac.same;
    assert.equal(hostReportedEdit({ ...base, file: "/w/a.xlsx", call: call(["/w/a.xlsx"]), same }), true);
    assert.equal(hostReportedEdit({ ...base, file: "/w/a.xlsx", call: call(["/w/b.xlsx"]), same }), false);
    assert.equal(hostReportedEdit({ ...base, file: "/w/a.xlsx", call: call([]), same }), false);
  });
  it("win32: drive-letter case, separators and Git Bash forms all name the same file", () => {
    const same = kits.win.same;
    for (const e of ["C:\\Users\\T\\work\\a.xlsx", "c:/users/t/work/A.xlsx", "/c/Users/T/work/a.xlsx"]) assert.equal(hostReportedEdit({ ...base, file: "C:/Users/T/work/a.xlsx", call: call([e]), same }), true, e);
    assert.equal(hostReportedEdit({ ...base, file: "C:/Users/T/work/a.xlsx", call: call(["C:\\Users\\T\\work\\b.xlsx"]), same }), false);
  });
  it("a second credited call, tag evidence for another call, a failure or an unknown call stay unproven", () => {
    const same = kits.mac.same;
    const f = { ...base, file: "/w/a.xlsx", call: call(["/w/a.xlsx"]), same };
    assert.equal(hostReportedEdit({ ...f, taggedWriters: ["S"] }), false);
    assert.equal(hostReportedEdit({ ...f, failed: () => true }), false);
    assert.equal(hostReportedEdit({ ...f, credited: ["W", "S"] }), false);
    assert.equal(hostReportedEdit({ ...f, credited: [] }), false);
    assert.equal(hostReportedEdit({ ...f, content: () => false }), false);
  });
  it("editTargetsOf: file tools and apply_patch with absolute paths only", () => {
    const abs = kits.win.isAbs;
    assert.deepEqual(editTargetsOf("Write", { file_path: "C:\\w\\a.xlsx" }, abs), ["C:\\w\\a.xlsx"]);
    assert.deepEqual(editTargetsOf("create", { path: "/c/w/a.xlsx" }, abs), ["/c/w/a.xlsx"]);
    assert.equal(editTargetsOf("Write", { file_path: "a.xlsx" }, abs), undefined);
    assert.equal(editTargetsOf("Write", {}, abs), undefined);
    assert.equal(editTargetsOf("Bash", { command: "echo > C:\\w\\a" }, abs), undefined);
    assert.deepEqual(editTargetsOf("apply_patch", "*** Begin Patch\n*** Update File: C:\\w\\a.xlsx\n*** End Patch", abs), ["C:\\w\\a.xlsx"]);
    assert.equal(editTargetsOf("apply_patch", "*** Update File: C:\\w\\a.xlsx\n*** Update File: rel.txt", abs), undefined);
  });
  it("creditBasisOf: argv-tag outranks, host edit outranks named/window, nothing credited stays unattributed", () => {
    assert.equal(creditBasisOf({ credited: ["a"], taggedWriters: [], named: true, hostEdit: true }), "host-reported-edit");
    assert.equal(creditBasisOf({ credited: ["a"], taggedWriters: ["a"], named: false, hostEdit: true }), "argv-tag");
    assert.equal(creditBasisOf({ credited: [], taggedWriters: [], named: false, hostEdit: true }), "unattributed");
  });
});
