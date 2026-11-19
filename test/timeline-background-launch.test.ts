import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { backfillAgentLanes } from "../src/agent-transcripts.ts";
import { readRecord, type RawOp, type RawState } from "../src/timeline/runs.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// a helper the host ran in the background (the Agent input says so, or the agent's meta file says requestShape "background") branches
// at its launch; a lane with a merge but no start still draws its merge; a jointly credited change sits at its own step's time; the
// playhead line is centred on the node. Synthetic records only, in the field names the adapter writes.

const W = "/w/";
const T0 = Date.parse("2026-10-11T10:00:00Z");
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const stamp = (seq: number) => ({ requests: [{ seq, at: T0 + seq, firstStep: null }] });
const agent = (id: string, launch?: string) => ({ agent_id: id, agent_type: "general-purpose", ...(launch ? { launch_tool_use_id: launch } : {}) });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit", input?: unknown) =>
  call(id, { tool, desc: id, at: T0 + seq * 10, named, input, extra: { startSeq: seq, ...extra } });
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(buildTimeline(input(ops, fileStates)));
const at = (s: RawState, ms: number): RawState => ({ ...s, ts: iso(ms) });
// a launch is a step of its own, so a line "leaves at the launch" from that step: Claude's start step, after m0's stop and before m1's.
const assertLeavesAtLaunch = (o: RawOp[], states: RawState[], why: string): void => {
  const m = model(o, states);
  const start = m.actors.find((a) => a.id === "agent:1")!.startId ?? "";
  const ids = m.stops.map((x) => x.id);
  const m0 = m.stops.findIndex((x) => x.change?.file === "m0.txt");
  const m1 = m.stops.findIndex((x) => x.change?.file === "m1.txt");
  assert.ok(start.startsWith("start-"), why);
  assert.ok(m0 < ids.indexOf(start) && ids.indexOf(start) < m1, why);
  assert.equal(m.stops[ids.indexOf(start)]!.lane, "claude", why);
};
const changed = (file: string, sha: string, open: string[], credited: string[], step: number, ms: number): RawState[] => [state(W + file, sha + "0", null, { step: 1 }), at(state(W + file, sha + "1", sha + "0", { open, credited, step }), ms)];

describe("(1) a launch is background when the Agent input says so", () => {
  // Claude edits m0, launches h1's agent, edits m1, then h1 edits x. Background: h1 leaves at the launch (after m0). Foreground: the same, anchored at the launch (after m0).
  const build = (launchOp: RawOp) => [prompt("s1", ["Ask."], stamp(1)), c("m0", 2, {}, [W + "m0.txt"]), launchOp, c("m1", 4, {}, [W + "m1.txt"]), c("h1", 5, agent("ag1", "l1"), [W + "x.txt"]), stop("s1", "done")];
  const states = [...changed("m0.txt", "a", ["m0"], ["m0"], 2, 20), ...changed("m1.txt", "b", ["m1"], ["m1"], 3, 40), ...changed("x.txt", "c", ["h1"], ["h1"], 4, 50)];
  const startOf = (ops: RawOp[]) => model(ops, states).actors.find((a) => a.id === "agent:1")!.startId;

  it("an Agent call whose input has run_in_background true is a background launch: the lane leaves after m0", () => {
    const launch = c("l1", 3, {}, [], "Agent", { prompt: "go", run_in_background: true });
    assert.equal(readRecord(build(launch), []).calls.get("l1")!.background, true);
    assertLeavesAtLaunch(build(launch), states, "branched at the launch, after m0");
  });
  it("same for the Task tool", () => {
    assert.equal(readRecord(build(c("l1", 3, {}, [], "Task", { run_in_background: true })), []).calls.get("l1")!.background, true);
  });
  it("no flag, a false flag, or the flag on a non-launcher tool leaves the launch foreground, placed as before", () => {
    for (const launch of [c("l1", 3, {}, [], "Agent", { prompt: "go" }), c("l1", 3, {}, [], "Agent", { run_in_background: false }), c("l1", 3, {}, [], "Agent"), c("l1", 3, {}, [], "Bash", { run_in_background: true })]) {
      assert.equal(readRecord(build(launch), []).calls.get("l1")!.background, false);
    }
    assertLeavesAtLaunch(build(c("l1", 3, {}, [], "Agent", { prompt: "go" })), states, "foreground: after m0, anchored at the launch");
  });
});

describe("(1) a launch is background when the agent's meta file says requestShape background", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
  const meta = (toolUseId: string, shape?: string) => JSON.stringify({ agentType: "general-purpose", description: "SECRET DESCRIPTION", toolUseId, spawnDepth: 1, ...(shape ? { requestShape: shape } : {}) });
  async function root(files: Record<string, Record<string, string>>): Promise<string> {
    const r = await mkdtemp(path.join(tmpdir(), "cocheck-"));
    dirs.push(r);
    for (const [session, byName] of Object.entries(files)) {
      const d = path.join(r, "-w", session, "subagents");
      await mkdir(d, { recursive: true });
      for (const [name, body] of Object.entries(byName)) await writeFile(path.join(d, name), body);
    }
    return r;
  }
  const ops = [prompt("s1", ["Ask."], stamp(1)), c("m0", 2, {}, [W + "m0.txt"]), c("l1", 3, {}, [], "Agent", { prompt: "go" }), c("m1", 4, {}, [W + "m1.txt"]), c("h1", 5, agent("ag1", "l1"), [W + "x.txt"]), stop("s1", "done")];
  const states = [...changed("m0.txt", "a", ["m0"], ["m0"], 2, 20), ...changed("m1.txt", "b", ["m1"], ["m1"], 3, 40), ...changed("x.txt", "c", ["h1"], ["h1"], 4, 50)];
  const startOf = (o: RawOp[]) => model(o, states).actors.find((a) => a.id === "agent:1")!.startId;

  it("the launcher becomes background and the lane leaves at the launch, even when no agent op needed a backfill", async () => {
    const r = await root({ s1: { "agent-ag1.meta.json": meta("l1", "background") } });
    const out = backfillAgentLanes(ops, { root: r, folder: "/w" });
    assert.equal(readRecord(out, []).calls.get("l1")!.background, true);
    assertLeavesAtLaunch(out, states, "background meta: at the launch");
    assert.equal(readRecord(ops, []).calls.get("l1")!.background, false, "the stored ops are not rewritten");
    assert.ok(!JSON.stringify(out).includes("SECRET DESCRIPTION"));
  });
  it("a foreground meta, no requestShape, another session's meta, or a non-launcher call with that id change nothing", async () => {
    const cases: Array<Record<string, Record<string, string>>> = [
      { s1: { "agent-ag1.meta.json": meta("l1", "foreground") } },
      { s1: { "agent-ag1.meta.json": meta("l1") } },
      { s1: { "agent-ag1.meta.json": "not json" } },
      { s2: { "agent-ag1.meta.json": meta("l1", "background") } },
      { s1: { "agent-ag1.meta.json": meta("other", "background") } },
    ];
    for (const files of cases) {
      const out = backfillAgentLanes(ops, { root: await root(files), folder: "/w" });
      assert.equal(readRecord(out, []).calls.get("l1")!.background, false, JSON.stringify(files));
      assertLeavesAtLaunch(out, states, "foreground: anchored at the launch");
    }
    const bash = ops.map((o) => (o.args_json!.includes('"l1"') ? { ...o, args_json: o.args_json!.replace('"tool_name":"Agent"', '"tool_name":"Bash"'), tool: "Bash" } : o));
    const out = backfillAgentLanes(bash, { root: await root({ s1: { "agent-ag1.meta.json": meta("l1", "background") } }), folder: "/w" });
    assert.equal(readRecord(out, []).calls.get("l1")!.background, false, "only an Agent or Task call is a launcher");
  });
  it("no subagents folder: the very same ops come back", async () => {
    const out = backfillAgentLanes(ops, { root: await root({}), folder: "/w" });
    assert.deepEqual(out, ops);
    assert.ok(out.every((o, i) => o === ops[i]));
  });
});

describe("(3) a change is placed by the time of its own step", () => {
  // b is left open across both of the agent's steps (its Post never came: closedBy stop); x and y are credited jointly to b and the step's own call.
  const ops = [prompt("s1", ["Ask."], stamp(1)), call("b", { tool: "Bash", desc: "b", at: T0 + 100, end: T0 + 1000, by: "stop", extra: { startSeq: 2, ...agent("ag1") } }), call("k1", { tool: "Edit", desc: "k1", at: T0 + 200, end: T0 + 210, extra: { startSeq: 3, ...agent("ag1") } }), call("k2", { tool: "Edit", desc: "k2", at: T0 + 300, end: T0 + 310, extra: { startSeq: 4, ...agent("ag1") } }), stop("s1", "done")];
  const states = [...changed("x.txt", "x", ["b", "k1"], ["b", "k1"], 2, 210), ...changed("y.txt", "y", ["b", "k2"], ["b", "k2"], 4, 310), ...changed("z.txt", "z", [], [], 3, 250).slice(1)];
  const order = (m: ReturnType<typeof model>) => m.stops.filter((s) => s.change).map((s) => s.change!.file);

  it("x (step at 210), then someone else's z (250), then y (310): not x and y together at b's start", () => {
    assert.deepEqual(order(model(ops, states)), ["x.txt", "z.txt", "y.txt"]);
  });
  it("reverses this: a change credited to one call sits at its own step time too (x at 800 after z at 500)", () => {
    const solo = [prompt("s1", ["Ask."], stamp(1)), call("only", { tool: "Edit", desc: "only", at: T0 + 100, end: T0 + 900, extra: { startSeq: 2 } }), stop("s1", "done")];
    const st = [...changed("x.txt", "x", ["only"], ["only"], 2, 800), ...changed("z.txt", "z", [], [], 3, 500).slice(1)];
    assert.deepEqual(order(model(solo, st)), ["z.txt", "x.txt"]);
  });
});

describe("(2) and (4) in the real page code", () => {
  interface Node { attrs: Record<string, unknown>; style: Record<string, unknown>; children: unknown[]; textContent: string; [k: string]: unknown }
  function boot(m: unknown) {
    const paths: string[] = [];
    const nodes = new Map<string, Node>();
    const make = (tag = ""): Node => {
      const base = { attrs: {}, style: { setProperty() {} }, children: [] as unknown[], textContent: "", hidden: false, dataset: {}, classList: { toggle: () => false, add() {}, remove() {}, contains: () => false }, setAttribute(k: string, v: unknown) { (base.attrs as Record<string, unknown>)[k] = v; if (tag === "path" && k === "d") paths.push(String(v)); }, getAttribute: () => null, append(...c: unknown[]) { base.children.push(...c); } } as unknown as Node;
      return new Proxy(base, { get: (t, k) => (k in t ? (t as unknown as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make() : undefined), set: (t, k, v) => { (t as unknown as Record<PropertyKey, unknown>)[k] = v; return true; } });
    };
    const byId = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id)!; };
    const body = make(); body.getAttribute = (() => "7") as never;
    const document = { body, getElementById: byId, createElement: (t: string) => make(t), createElementNS: (_n: string, t: string) => make(t), createTextNode: (t: string) => ({ nodeType: 3, textContent: t }), querySelectorAll: () => [] };
    const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, addEventListener() {}, setInterval, clearInterval, console, fetch: async (u: string) => (u.includes("/review/model") ? { ok: true, json: async () => m } : { ok: false, status: 404, json: async () => ({}) }) };
    g.window = g; g.globalThis = g;
    return { g, paths, byId };
  }
  const run = async (m: unknown) => {
    const p = boot(m);
    const ctx = vm.createContext(p.g);
    for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
    await new Promise((r) => setTimeout(r, 20));
    return p;
  };
  const claude = { id: "claude", name: "Claude", chip: "C", color: "#111111", main: true };
  const helper = (extra: Record<string, unknown>) => ({ id: "agent:1", name: "Helper 1", chip: "1", color: "#e04a4a", parent: "claude", ...extra });
  const stopOf = (id: string, lane: string | null) => ({ id, label: id, lane, head: id });
  const mdl = (h: Record<string, unknown>) => ({ task: 7, folder: "work", actors: [claude, helper(h)], stops: [stopOf("c0", "claude"), stopOf("h0", "agent:1"), stopOf("h1", "agent:1"), stopOf("w", "claude")] });
  // Column x = 9 + col * 26 + 13: Claude 22, helper 48. Rows are 28 px below the origin's 22 (no start stop; a stop's slot is 28 px), a node's centre at 22 + row * 28 + 14.
  const ends = (paths: string[], x: number, y: number) => paths.filter((d) => d.endsWith(` L${x},${y}`) || d.includes(` ${x},${y}`));

  const uniq = (d: string[]) => [...new Set(d)];
  it("a lane with a merge point but no start still draws its merge back into its spawner", async () => {
    const withMerge = uniq((await run(mdl({ startId: null, mergeId: "w" }))).paths);
    const noMerge = uniq((await run(mdl({ startId: null, mergeId: null }))).paths);
    const merge = withMerge.filter((d) => !noMerge.includes(d));
    assert.equal(merge.length, 1, "exactly one more path: the merge");
    assert.match(merge[0]!, /^M48,/, "leaves the helper's column");
    assert.match(merge[0]!, / 22,120$/, "ends in Claude's column on the merge row");
    assert.deepEqual(noMerge.filter((d) => !withMerge.includes(d)), [], "nothing else moved");
  });
  it("a lane with a start and a merge draws both; one with neither draws neither", async () => {
    const both = uniq((await run(mdl({ startId: "c0", mergeId: "w" }))).paths);
    const none = uniq((await run(mdl({ startId: null, mergeId: null }))).paths);
    assert.equal(both.length, none.length + 2);
    assert.ok(both.some((d) => d.startsWith("M22,36 ") && d.endsWith(" L48,64")), "the branch leaves Claude's c0 row for the helper's first row");
  });

  it("(4) no playhead: the current row is marked by its own fill and dot ring, and the rail scrolls to a step's centre", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.doesNotMatch(css, /\.ph\{|\.grip\{/, "the playhead line and grip rules are gone");
    const js = await readFile(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    assert.doesNotMatch(js, /\$\('ph'\)|\$\('grip'\)/, "nothing places a playhead");
    // rows have heights of their own, so a step's centre is read from its slot: its top plus half its height
    assert.match(js, /var ly = YC\[r\], y = sy\(ly\);/, "the scroll target is the node's centre");
    assert.match(js, /YC\[POS\[sl\.si\]\] = sl\.top \+ sl\.h \/ 2/, "a step's centre is the middle of its own slot");
  });
});
