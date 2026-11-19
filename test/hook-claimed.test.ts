import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAIMED_LAYER, claimedFor, claimedLayer, cutShortReason } from "../src/connector/claimed.ts";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";

const fwd = (p: string): string => p.replaceAll("\\", "/"); // a Bash command line names paths with forward slashes on every OS

// the hook builds no format layer. Its one test for "a connector reads this file" is `claimed(file)`, from the
// connectors' manifests and the per-type setting, never an extension list. Each site that asked the xlsx layer is decided and tested here:
// the task opening on claimed files, the hard stop on a failed copy, outside files a call names joining the task, and the value written to
// `snapshots.layer`. An installed connector claiming ".foo" gets every one of them, so no built-in is privileged.
const probe = (name: string) => path.join(import.meta.dirname, "fixtures", "probe", name);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setBuiltinConnectorsForTest(undefined);
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-h1b-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

/** A home with an installed connector `foo-reader` claiming ".foo" (the shape of a real manifest). */
async function homeWithFoo(): Promise<string> {
  const home = await tmp("home");
  const dir = path.join(home, "connectors", "foo-reader");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "foo-reader", version: "0.0.1", entry: "state", matches: { extensions: [".foo"] }, run: ["node", "c.mjs"], credentials: [], platforms: ["darwin", "win32", "linux"] }));
  return home;
}

async function rig(opts: { outsideWatching?: boolean; perSession?: boolean } = {}) {
  setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
  const home = await homeWithFoo();
  const folder = await tmp("folder");
  let clock = Date.parse("2026-11-16T12:00:00Z");
  const hook = { host: "claude" as const, home, folder, perSession: false, now: () => (clock += 1000), ...opts };
  const send = (over: Record<string, unknown>) => handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, hook);
  const pre = (id: string, command: string) => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command } });
  const post = (id: string, command: string) => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: { stdout: "", stderr: "", interrupted: false } });
  const read = <T,>(fn: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return fn(l);
    } finally {
      l.close();
    }
  };
  return { home, folder, send, pre, post, read };
}

describe("H1b: claimed(file) comes from the connectors, never an extension list", () => {
  it("the shipped connectors claim their types; an installed connector claims its own; nothing else is claimed", async () => {
    setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
    const claimed = claimedFor(await homeWithFoo());
    for (const f of ["/w/a.xlsx", "/w/b.docx", "/w/c.pptx", "/w/d.foo"]) assert.equal(claimed(f), true, f);
    for (const f of ["/w/a.csv", "/w/a.txt", "/w/a.pdf", "/w/a.png", "/w/a.xls"]) assert.equal(claimed(f), false, f);
  });

  it("with no connector registered nothing is claimed, workbooks included", async () => {
    setBuiltinConnectorsForTest([]);
    const claimed = claimedFor(await tmp("empty-home"));
    assert.equal(claimed("/w/a.xlsx"), false);
  });

  it("a type the user disabled is not claimed", async () => {
    const home = await homeWithFoo();
    await writeFile(path.join(home, "connector-types.json"), JSON.stringify({ types: { ".foo": null } }));
    assert.equal(claimedFor(home)("/w/d.foo"), false);
  });
});

describe("H1b site by site", () => {
  it("the task opens on the claimed files at the first event, each with a baseline snapshot; snapshots.layer is the opaque 'claimed'", async () => {
    const t = await rig();
    await copyFile(probe("S0.xlsx"), path.join(t.folder, "model.xlsx"));
    await writeFile(path.join(t.folder, "data.foo"), "foo v1");
    await writeFile(path.join(t.folder, "notes.txt"), "plain");
    await t.pre("A", "true");
    const snaps = t.read((l) => l.snapshotsForTask(1));
    const round0 = snaps.filter((s) => s.round === 0);
    assert.deepEqual([...new Set(round0.map((s) => path.basename(s.filePath)))].sort(), ["data.foo", "model.xlsx"], "the claimed files join at baseline, the text file is not snapshotted");
    assert.ok(round0.some((s) => path.basename(s.filePath) === "model.xlsx" && s.mode === "copy"), "the workbook's baseline is a copy");
    for (const s of round0) assert.equal(s.layer, CLAIMED_LAYER);
  });

  it("a folder with no claimed file still opens a task", async () => {
    const t = await rig();
    await writeFile(path.join(t.folder, "notes.txt"), "plain");
    await t.pre("A", "true");
    assert.deepEqual(t.read((l) => l.fileStatesForTask(1)).map((s) => path.basename(s.filePath)), ["notes.txt"]);
  });

  it("a claimed file that cannot be copied at the start stops the run; an unclaimed one is only left untracked", posixOnly("chmod 000 makes a file unreadable; Windows ignores it"), async () => {
    const t = await rig();
    const locked = path.join(t.folder, "locked.foo");
    await writeFile(locked, "foo");
    await chmod(locked, 0o000);
    cleanups.unshift(() => chmod(locked, 0o600).catch(() => undefined));
    await assert.rejects(t.pre("A", "true"), "a claimed file the hook cannot read at baseline is a hard stop, as a workbook was");
    const u = await rig();
    const other = path.join(u.folder, "locked.txt");
    await writeFile(other, "text");
    await chmod(other, 0o000);
    cleanups.unshift(() => chmod(other, 0o600).catch(() => undefined));
    await u.pre("A", "true");
    assert.deepEqual(u.read((l) => l.fileStatesForTask(1)).map((s) => path.basename(s.filePath)), [], "the unreadable text file is simply not tracked");
  });

  it("outside watching on: a claimed file a call names outside the folder joins the task at the call's Pre; an unclaimed one does not", async () => {
    const t = await rig({ outsideWatching: true });
    const away = await tmp("away");
    const book = path.join(away, "far.foo");
    const text = path.join(away, "far.txt");
    await writeFile(book, "foo outside v1");
    await writeFile(text, "text outside v1");
    await t.pre("A", `python3 edit.py ${fwd(book)} ${fwd(text)}`);
    await writeFile(book, "foo outside v2");
    await writeFile(text, "text outside v2");
    await t.post("A", `python3 edit.py ${fwd(book)} ${fwd(text)}`);
    const states = t.read((l) => l.fileStatesForTask(1)).map((s) => `${path.basename(s.filePath)}:${s.prevSha256 === null ? "start" : [...s.credited].join("+")}`);
    assert.deepEqual(states, ["far.foo:start", "far.foo:A"], "the claimed outside file is baselined and its change credited; the text file is not watched");
    assert.ok(t.read((l) => l.snapshotsForTask(1)).some((s) => s.filePath === book && s.round === 0), "it joined the task with a baseline snapshot");
  });
});

// Per-session tasks (the default): a session's task opens at its first credited change, from the states the hook kept.
// the round does not diff a claimed file, so the credit is read from the file states: a change no call made has an empty credit.
describe("file states for claimed files: a change no call made is credited to nobody", () => {
  const statesOf = (t: Awaited<ReturnType<typeof rig>>, name: string) => t.read((l) => l.allTaskIds().flatMap((id) => l.fileStatesForTask(id))).filter((s) => path.basename(s.filePath) === name).map((s) => [s.prevSha256 === null, [...s.credited]]);
  const stop = (t: Awaited<ReturnType<typeof rig>>) => t.send({ hook_event_name: "Stop", last_assistant_message: "done" });

  it("a person creates a claimed file with no call open, then an agent edits it in the same round: the create is credited to nobody", async () => {
    const t = await rig({ perSession: true });
    await writeFile(path.join(t.folder, "notes.txt"), "plain");
    await t.pre("A0", "true");
    await t.post("A0", "true");
    await writeFile(path.join(t.folder, "made.foo"), "foo by a person");
    await t.pre("A", "python3 edit.py made.foo");
    await writeFile(path.join(t.folder, "made.foo"), "foo by a person, edited by the agent");
    await t.post("A", "python3 edit.py made.foo");
    await stop(t);
    const states = t.read((l) => l.allTaskIds().flatMap((id) => l.fileStatesForTask(id))).filter((s) => s.filePath.endsWith("made.foo")).map((s) => [s.prevSha256 === null, [...s.credited]]);
    assert.deepEqual(states, [[true, []], [false, ["A"]]], "the person's create is credited to nobody, the edit to A");
  });

  it("an agent creates and edits a claimed file: each change is credited to its call", async () => {
    const t = await rig({ perSession: true });
    await writeFile(path.join(t.folder, "notes.txt"), "plain");
    await t.pre("A", "python3 make.py made.foo");
    await writeFile(path.join(t.folder, "made.foo"), "foo by the agent");
    await t.post("A", "python3 make.py made.foo");
    await t.pre("B", "python3 edit.py made.foo");
    await writeFile(path.join(t.folder, "made.foo"), "foo by the agent, edited");
    await t.post("B", "python3 edit.py made.foo");
    await stop(t);
    assert.deepEqual(statesOf(t, "made.foo"), [[true, ["A"]], [false, ["B"]]]);
  });

  it("a person edits a claimed workbook between two agent edits: that change is credited to nobody", async () => {
    const t = await rig({ perSession: true });
    await copyFile(probe("S0.xlsx"), path.join(t.folder, "model.xlsx"));
    await t.pre("A", "python3 a.py");
    await copyFile(probe("S1.xlsx"), path.join(t.folder, "model.xlsx"));
    await t.post("A", "python3 a.py");
    await copyFile(probe("S2.xlsx"), path.join(t.folder, "model.xlsx"));
    await t.pre("B", "python3 b.py");
    await copyFile(probe("S3.xlsx"), path.join(t.folder, "model.xlsx"));
    await t.post("B", "python3 b.py");
    await stop(t);
    assert.deepEqual(statesOf(t, "model.xlsx"), [[true, []], [false, ["A"]], [false, []], [false, ["B"]]]);
  });
});

describe("the claimed layer and the cut-short check", () => {
  it("two states differ when their bytes do, as one whole-file row no op explains", async () => {
    const d = await tmp("layer");
    const a = path.join(d, "a"), b = path.join(d, "b"), c = path.join(d, "c");
    await writeFile(a, "one");
    await writeFile(b, "one");
    await writeFile(c, "two");
    const layer = claimedLayer(() => true);
    assert.deepEqual(await layer.diff(a, b), []);
    const rows = await layer.diff(a, c);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.wholeFile, true);
    const op = { opId: 1, tool: "Bash", args: { hookAdapter: 1, path: c }, intent: "", client: null };
    assert.equal(layer.touches(op, c, rows[0]!), true);
    assert.equal(layer.explains(op, c, rows[0]!), false);
    assert.equal((await layer.diff(null, c)).length, 1, "a created file is one row");
  });

  it("a workbook cut short (first half of its bytes) or empty is cut short; the whole file and plain text are not", async () => {
    const whole = await readFile(probe("S0.xlsx"));
    assert.equal(cutShortReason(whole), undefined);
    assert.match(cutShortReason(whole.subarray(0, Math.floor(whole.length / 2))) ?? "", /zip directory/);
    assert.match(cutShortReason(whole.subarray(0, whole.length - 10)) ?? "", /zip directory/, "only the last bytes missing");
    assert.match(cutShortReason(new Uint8Array(0)) ?? "", /empty/);
    assert.equal(cutShortReason(Buffer.from("PK is how this note starts\n")), undefined, "text that starts with PK is no zip");
  });
});
