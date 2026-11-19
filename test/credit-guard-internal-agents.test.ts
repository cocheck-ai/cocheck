import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { guardKit } from "../src/credit-guard.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Claude Code's internal agents carry an agent_id with no agent_type and no launcher, and never get a Post. Their open calls
// were credited jointly with every change of the window ("X or Helper 16, CoCheck can't tell which"). They are non-crediting unless their own Post
// finds something; a real helper (agent_type) keeps every credit; a Write credits only its own file_path and Read/Glob/Grep/SendMessage nothing.
// A change nobody can be credited with while any call was open reads "during agent calls", never "outside the agents".
// The credit guards run with the win32 kit on any OS, so these tests are the same on Windows CI and on the Mac
const WIN = guardKit("win32");
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(bookName = "book.xlsx") {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const book = path.join(folder, bookName);
  await copyFile(probe(0), book);
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock, guardKit: WIN };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const who = (agent?: string, type?: string) => (agent ? { agent_id: agent, ...(type ? { agent_type: type } : {}) } : {});
  const pre = (id: string, o: { tool?: string; input?: Record<string, unknown>; agent?: string; type?: string } = {}) =>
    send({ hook_event_name: "PreToolUse", tool_name: o.tool ?? "Bash", tool_use_id: id, tool_input: o.input ?? { command: "python3 edit.py" }, ...who(o.agent, o.type) });
  const post = (id: string, o: { tool?: string; input?: Record<string, unknown>; agent?: string; type?: string } = {}) =>
    send({ hook_event_name: "PostToolUse", tool_name: o.tool ?? "Bash", tool_use_id: id, tool_input: o.input ?? { command: "python3 edit.py" }, ...who(o.agent, o.type) });
  const states = () => {
    const l = openLedger(home);
    try {
      const steps = new Map(l.stepsForTask(1).map((s) => [s.id, s]));
      return l.fileStatesForTask(1).filter((s) => s.filePath === book && s.prevSha256 !== null).map((s) => ({ credited: s.credited, open: steps.get(s.stepId)?.callsOpen ?? [] }));
    } finally {
      l.close();
    }
  };
  await pre("warm");
  await post("warm");
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  const alias = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-link-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const link = path.join(dir, "via");
    await symlink(folder, link);
    return path.join(link, bookName);
  };
  return { pre, post, states, book, folder, alias, write: (n: number) => copyFile(probe(n), book) };
}

describe("adapter: an internal agent call (agent_id, no agent_type, no launcher) is non-crediting", () => {
  it("a typeless call with no Post overlapping a real call does not share the real call's change", async () => {
    const t = await setup();
    await t.pre("i1", { agent: "internal1" });
    await t.pre("m1");
    await t.write(1);
    await t.post("m1");
    assert.deepEqual(t.states().map((s) => s.credited), [["m1"]]);
  });

  it("a typed helper (agent_type) keeps every credit, jointly with the real call", async () => {
    const t = await setup();
    await t.pre("h1", { agent: "helper1", type: "general-purpose" });
    await t.pre("m1");
    await t.write(1);
    await t.post("m1");
    assert.deepEqual(t.states().map((s) => s.credited), [["h1", "m1"]]);
  });

  it("a typeless call that does get a Post credits what its Post sweep found, and nothing found at another call's Post", async () => {
    const t = await setup();
    await t.pre("i1", { agent: "internal1" });
    await t.pre("m1");
    await t.write(1);
    await t.post("i1", { agent: "internal1" });
    await t.write(2);
    await t.post("m1");
    assert.deepEqual(t.states().map((s) => s.credited), [["i1", "m1"], ["m1"]]);
  });

  it("the sole open call is internal: the change is credited to nobody but was found while a call was open (during, never outside)", async () => {
    const t = await setup();
    await t.pre("i1", { agent: "internal1" });
    await t.write(1);
    await t.pre("m1");
    const [s] = t.states();
    assert.deepEqual(s!.credited, []);
    assert.deepEqual(s!.open, ["i1"]);
  });
});

describe("adapter: the second guard", () => {
  it("a Write credits only its own file_path; a Bash call open beside it keeps the change", async () => {
    const t = await setup();
    await t.pre("w1", { tool: "Write", input: { file_path: path.join(t.folder, "other.txt"), content: "x" } });
    await t.pre("b1");
    await t.write(1);
    await t.post("b1");
    assert.deepEqual(t.states().map((s) => s.credited), [["b1"]]);
  });

  it("a Write of the very file takes the credit alone (its own input names the file)", async () => {
    const t = await setup();
    await t.pre("w1", { tool: "Write", input: { file_path: t.book, content: "x" } });
    await t.pre("b1");
    await t.write(1);
    await t.post("b1");
    assert.deepEqual(t.states().map((s) => s.credited), [["w1"]]);
  });

  it("Read, Glob, Grep and SendMessage credit nothing, even at their own Post", async () => {
    const t = await setup();
    await t.pre("r1", { tool: "Read", input: { file_path: t.book } });
    await t.pre("g1", { tool: "Grep", input: { pattern: "x" } });
    await t.pre("m1", { tool: "SendMessage", input: { to: "a", message: "x" } });
    await t.pre("b1");
    await t.write(1);
    await t.post("b1");
    await t.write(2);
    await t.post("r1", { tool: "Read", input: { file_path: t.book } });
    assert.deepEqual(t.states().map((s) => s.credited), [["b1"], []]);
  });
});

describe("adapter: one path comparison (case, NFD, symlink)", () => {
  const writeFor = async (t: Awaited<ReturnType<typeof setup>>, filePath: string) => {
    await t.pre("w1", { tool: "Write", input: { file_path: filePath, content: "x" } });
    await t.pre("b1");
    await t.write(1);
    await t.post("b1");
    return t.states().map((s) => s.credited);
  };
  it("a Write whose file_path differs only in case takes the credit alone", async () => {
    const t = await setup();
    assert.deepEqual(await writeFor(t, path.join(t.folder, "BOOK.xlsx")), [["w1"]]);
  });
  it("a Write whose file_path is the NFD spelling of an NFC file name takes the credit alone", async () => {
    const t = await setup("caf\u00e9.xlsx");
    assert.deepEqual(await writeFor(t, path.join(t.folder, "cafe\u0301.xlsx")), [["w1"]]);
  });
  it("a Write through a symlinked folder takes the credit alone", async () => {
    const t = await setup();
    assert.deepEqual(await writeFor(t, await t.alias()), [["w1"]]);
  });
  it("a Write of a different file is still dropped", async () => {
    const t = await setup();
    assert.deepEqual(await writeFor(t, path.join(t.folder, "books.xlsx")), [["b1"]]);
  });
});

// ---- the timeline builder on existing ledgers ----

const T0 = 1_792_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const FILE = "/w/book.xlsx";
const internal = { agent_id: "int1" };
const real = { agent_id: "h1", agent_type: "general-purpose" };
const withState = (over: Partial<RawState>, open: string[], credited: string[]): RawState => ({ ...state(FILE, "s1", "s0", { open, credited }), ...over });
const buildFrom = (ops: RawOp[], states: RawState[]) => {
  const input = { taskId: 1, build: "b", ops: [prompt("s1", ["Go."]), ...ops, stop("s1")], fileStates: [state(FILE, "s0", null, { step: 1 }), ...states], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude", guardKit: WIN } as TimelineInput;
  const t = buildTimeline(input);
  const body = JSON.parse(JSON.stringify(t)) as typeof t;
  const changes = [...body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((x) => x.changes))), ...body.unplaced];
  return { changes, model: buildRailModel(body), body };
};
const kind = (c: unknown) => (c as { by: { kind: string; calls: string[] } }).by;

describe("timeline: the same rules on ledgers written before them", () => {
  const m = () => call("m1", { tool: "Bash", at: T0, end: T0 + 50_000 });
  const i = (by = "expiry", end = T0 + 60_000) => call("i1", { tool: "Write", at: T0 + 1000, end, by, extra: internal });

  it("a typeless call never closed by a Post is dropped from a joint credit", () => {
    const { changes, model } = buildFrom([m(), i()], [withState({ phase: "Post", ts: iso(T0 + 50_000) }, ["m1", "i1"], ["m1", "i1"])]);
    assert.equal(changes.length, 1);
    assert.deepEqual(kind(changes[0]).calls.length, 1);
    assert.equal(kind(changes[0]).kind, "call");
    assert.ok(!model.stops.some((s) => s.lane === "unsure"));
  });

  it("a real helper (agent_type) keeps its credit: the change stays joint", () => {
    const h = call("h1c", { tool: "Bash", at: T0 + 1000, end: T0 + 60_000, extra: real });
    const { changes } = buildFrom([m(), h], [withState({ phase: "Post", ts: iso(T0 + 50_000) }, ["m1", "h1c"], ["m1", "h1c"])]);
    assert.equal(kind(changes[0]).kind, "joint");
    assert.equal(kind(changes[0]).calls.length, 2);
  });

  it("a typeless call that got a Post keeps what was found at that Post", () => {
    const { changes } = buildFrom([m(), i("post", T0 + 20_000)], [withState({ phase: "Post", ts: iso(T0 + 20_000) }, ["m1", "i1"], ["m1", "i1"])]);
    assert.equal(kind(changes[0]).kind, "joint");
    assert.equal(kind(changes[0]).calls.length, 2);
  });

  it("a typeless call with a Post is dropped from a change found at another time", () => {
    const { changes } = buildFrom([m(), i("post", T0 + 20_000)], [withState({ phase: "Post", ts: iso(T0 + 45_000) }, ["m1", "i1"], ["m1", "i1"])]);
    assert.equal(kind(changes[0]).kind, "call");
    assert.equal(kind(changes[0]).calls.length, 1);
  });

  it("the sole credited call is internal: the change reads during agent calls, never outside the agents", () => {
    const { changes, model } = buildFrom([i()], [withState({ phase: "Pre", ts: iso(T0 + 5000) }, ["i1"], ["i1"])]);
    assert.equal(kind(changes[0]).kind, "during");
    const stop = model.stops.find((s) => s.change !== undefined)!;
    assert.notEqual(stop.lane, "other");
    assert.ok(!JSON.stringify(model).includes("outside the agents") || !JSON.stringify(model.stops).includes("Something outside the agents"));
    assert.match(stop.head, /during agent calls/);
  });

  it("a Write of another file and a Read are dropped from a joint credit; a Write of this file stays", () => {
    const lab = (p: string) => ({ toolLabel: { fields: { file_path: p } } });
    const other = call("w1", { tool: "Write", at: T0, end: T0 + 50_000, extra: lab("/w/other.txt") });
    const rd = call("r1", { tool: "Read", at: T0, end: T0 + 50_000, extra: lab(FILE) });
    const mine = call("w2", { tool: "Write", at: T0, end: T0 + 50_000, extra: lab(FILE) });
    const bash = call("b1", { tool: "Bash", at: T0, end: T0 + 50_000 });
    const a = buildFrom([other, rd, bash], [withState({ phase: "Post", ts: iso(T0 + 50_000) }, ["w1", "r1", "b1"], ["w1", "r1", "b1"])]);
    assert.equal(kind(a.changes[0]).kind, "call");
    assert.deepEqual(kind(a.changes[0]).calls.length, 1);
    const b = buildFrom([mine, bash], [withState({ phase: "Post", ts: iso(T0 + 50_000) }, ["w2", "b1"], ["w2", "b1"])]);
    assert.equal(kind(b.changes[0]).calls.length, 2);
  });
});

describe("timeline: path comparison folds NFC and case only (no realpath for historical paths)", () => {
  const lab = (p: string) => ({ toolLabel: { fields: { file_path: p } } });
  const both = (p: string, file: string) => {
    const w = call("w1", { tool: "Write", at: T0, end: T0 + 50_000, extra: lab(p) });
    const bash = call("b1", { tool: "Bash", at: T0, end: T0 + 50_000 });
    const input = { taskId: 1, build: "b", ops: [prompt("s1", ["Go."]), w, bash, stop("s1")], fileStates: [state(file, "s0", null, { step: 1 }), { ...state(file, "s1", "s0", { open: ["w1", "b1"], credited: ["w1", "b1"] }), ts: iso(T0 + 50_000) }], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude" } as TimelineInput;
    const body = JSON.parse(JSON.stringify(buildTimeline(input))) as ReturnType<typeof buildTimeline>;
    return [...body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((x) => x.changes))), ...body.unplaced].map((c) => kind(c).calls.length).slice(-1);
  };
  it("a Write path differing only in case keeps its credit (joint with the Bash call)", () => {
    assert.deepEqual(both("/w/BOOK.xlsx", "/w/book.xlsx"), [2]);
  });
  it("a Write path in NFD for an NFC file name keeps its credit", () => {
    assert.deepEqual(both("/w/cafe\u0301.xlsx", "/w/caf\u00e9.xlsx"), [2]);
  });
  it("a different file is still dropped", () => {
    assert.deepEqual(both("/w/other.xlsx", "/w/book.xlsx"), [1]);
  });
});

// Known limits of the old-ledger window (steps carry no tool_use_id, so "its own Post" is a time test: a Post-phase state within 1500 ms of closedAt).
describe("timeline: the own-Post window, pinned as known limits", () => {
  const m = () => call("m1", { tool: "Bash", at: T0, end: T0 + 50_000 });
  const i = () => call("i1", { tool: "Write", at: T0 + 1000, end: T0 + 20_000, by: "post", extra: internal });
  it("limit: another call's Post state landing within the window keeps the internal call's credit", () => {
    const { changes } = buildFrom([m(), i()], [withState({ phase: "Post", ts: iso(T0 + 20_800) }, ["m1", "i1"], ["m1", "i1"])]);
    assert.equal(kind(changes[0]).calls.length, 2);
  });
  it("limit: its own Post state written after a sweep slower than the window is dropped", () => {
    const { changes } = buildFrom([m(), i()], [withState({ phase: "Post", ts: iso(T0 + 23_000) }, ["m1", "i1"], ["m1", "i1"])]);
    assert.equal(kind(changes[0]).calls.length, 1);
  });
});
