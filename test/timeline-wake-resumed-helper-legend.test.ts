import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRuns } from "../src/timeline/runs.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, state, stop, wakePrompt } from "./fixtures/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";

// Recorded-session shapes. Request 2 launches Helper 2, which finishes (wake); request 3 arrives; Claude launches three helpers, which
// finish (wakes); request 4 arrives; Claude resumes the three by SendMessage; they write again and finish again (a second notification
// whose tool-use-id is the SendMessage's and whose task-id is the agent).

const W = "/w/";
const agent = (id: string, launch: string) => ({ agent_id: id, agent_type: "general-purpose", launch_tool_use_id: launch });
const stamp = (seq: number) => ({ requests: [{ seq, at: seq * 10, firstStep: null }] });
const c = (id: string, seq: number, extra: Record<string, unknown> = {}, named: string[] = [], tool = "Edit") => call(id, { session: "s1", tool, desc: id, at: seq * 10, named, extra: { startSeq: seq, ...extra } });
const launch = (id: string, seq: number) => c(id, seq, { background: true }, [], "Agent");
const send = (id: string, seq: number, to?: string) => call(id, { session: "s1", tool: "SendMessage", desc: id, at: seq * 10, ...(to ? { input: { to } } : {}), extra: { startSeq: seq } });
const input = (ops: RawOp[], fileStates: RawState[] = []): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const model = (ops: RawOp[], fileStates: RawState[] = []) => buildRailModel(buildTimeline(input(ops, fileStates)));
const changed = (file: string, sha: string, by: string, step: number) => [state(W + file, sha + "0", null, { step: 1 }), state(W + file, sha + "1", sha + "0", { open: [by], credited: [by], step })];
const wake = (launcher: string, taskId: string, seq: number) => wakePrompt("s1", { toolUseId: launcher, taskId, summary: `Agent ${taskId} finished` }, seq);

const ops = [
  prompt("s1", ["Request one."], stamp(1)),
  prompt("s1", ["Request two."], stamp(2)),
  launch("L2", 3),
  c("h2", 4, agent("ag2", "L2"), [W + "two.txt"]),
  prompt("s1", ["Request three."], stamp(5)),
  wake("L2", "ag2", 6),
  launch("LX", 7),
  launch("LP", 8),
  launch("LM", 9),
  c("hx", 10, agent("agx", "LX"), [W + "x.txt"]),
  c("hp", 11, agent("agp", "LP"), [W + "p.txt"]),
  c("hm", 12, agent("agm", "LM"), [W + "m.txt"]),
  wake("LX", "agx", 13),
  wake("LP", "agp", 14),
  wake("LM", "agm", 15),
  prompt("s1", ["Request four."], stamp(16)),
  send("SX", 17),
  send("SP", 18),
  send("SM", 19),
  c("hx2", 20, agent("agx", "LX"), [W + "x.txt"]),
  c("hp2", 21, agent("agp", "LP"), [W + "p.txt"]),
  c("hm2", 22, agent("agm", "LM"), [W + "m.txt"]),
  wake("SX", "agx", 23),
  wake("SP", "agp", 24),
  wake("SM", "agm", 25),
  stop("s1", "done"),
];
const states = [
  ...changed("two.txt", "t", "h2", 2),
  ...changed("x.txt", "x", "hx", 3),
  ...changed("p.txt", "p", "hp", 4),
  ...changed("m.txt", "m", "hm", 5),
  state(W + "x.txt", "x2", "x1", { open: ["hx2"], credited: ["hx2"], step: 6 }),
  state(W + "p.txt", "p2", "p1", { open: ["hp2"], credited: ["hp2"], step: 7 }),
  state(W + "m.txt", "m2", "m1", { open: ["hm2"], credited: ["hm2"], step: 8 }),
];
const ids = (r: { calls: Array<{ id: string }> }) => r.calls.map((x) => x.id).sort();

describe("helper launches and work belong to the latest real request", () => {
  it("requests are numbered 1..4 with no notification among them, and each call sits with the request before it", () => {
    const { requests } = buildRuns(ops, states);
    assert.deepEqual(requests.map((r) => r.texts[0]), ["Request one.", "Request two.", "Request three.", "Request four."]);
    assert.deepEqual(requests.map(ids), [[], ["L2", "h2"], ["LM", "LP", "LX", "hm", "hp", "hx"], ["SM", "SP", "SX", "hm2", "hp2", "hx2"]]);
  });
  it("the rail asks: builders quote request 3, rebuilds quote request 4", () => {
    const m = model(ops, states);
    const ask = (file: string) => m.stops.filter((s) => s.change?.file === file).map((s) => s.change!.ask);
    assert.deepEqual(ask("x.txt"), ["Request three.", "Request four."]);
    assert.deepEqual(ask("m.txt"), ["Request three.", "Request four."]);
    assert.deepEqual(m.stops.filter((s) => s.request).map((s) => s.head), ["You made request 1", "You made request 2", "You made request 3", "You made request 4"]);
  });
});

describe("a notification launched by a SendMessage is a wake", () => {
  it("renders as Helper N finished, never a request, and no XML reaches the page", () => {
    const m = model(ops, states);
    assert.equal(m.stops.filter((s) => s.head.startsWith("Helper") && s.head.includes("finished")).length, 7);
    assert.ok(!JSON.stringify(m).includes("task-notification"));
    assert.ok(!JSON.stringify(m).includes("<task-id>"));
  });
});

describe("a resumed helper forks from the SendMessage", () => {
  it("the resumed work is its own line leaving Claude's line at the SendMessage, merging at the second wake", () => {
    const m = model(ops, states);
    const lanes = m.actors.filter((a) => a.parent);
    const first = lanes.find((a) => a.id === "agent:2")!;
    assert.ok(first, "no first lane for the builder");
    const again = lanes.filter((a) => a.chip === first.chip && a.id !== first.id);
    assert.equal(again.length, 1, JSON.stringify(lanes.map((a) => [a.id, a.name])));
    const r = again[0]!;
    assert.equal(r.parent, "claude");
    assert.equal(r.chip, first.chip);
    const idx = (id: string | null | undefined) => m.stops.findIndex((s) => s.id === id);
    // starts at a Claude stop after the lane's first line merged, merges at a later wake, and every stop on it sits between
    assert.ok(idx(r.startId) > idx(first.mergeId), `${r.startId} vs ${first.mergeId}`);
    const mine = m.stops.map((s, i) => [s, i] as const).filter(([s]) => s.lane === r.id);
    assert.ok(mine.length > 0);
    for (const [, i] of mine) assert.ok(i > idx(r.startId) && i < idx(r.mergeId), "stop outside the fork");
    assert.equal(m.stops[idx(r.mergeId)]!.label, `Helper ${first.chip} finished`);
    // the first line holds nothing after its own end
    const lastFirst = Math.max(...m.stops.map((s, i) => (s.lane === first.id ? i : -1)));
    assert.ok(lastFirst < idx(first.mergeId));
  });
  it("the SendMessage's recipient can also come from its own input, without a second notification", () => {
    const o = [
      prompt("s1", ["Ask A."], stamp(1)),
      launch("L1", 2),
      c("a1", 3, agent("ag1", "L1"), [W + "x.txt"]),
      wake("L1", "ag1", 4),
      prompt("s1", ["Ask B."], stamp(5)),
      send("S1", 6, "ag1"),
      c("a2", 7, agent("ag1", "L1"), [W + "x.txt"]),
      stop("s1"),
    ];
    const { requests } = buildRuns(o, [...changed("x.txt", "x", "a1", 2)]);
    assert.deepEqual(requests.map(ids), [["L1", "a1"], ["S1", "a2"]]);
  });
});

describe("a resumed segment never starts at Start, even with no stop of its own", () => {
  const idxOf = (m: ReturnType<typeof model>, id: string | null | undefined) => m.stops.findIndex((s) => s.id === id);
  const base = [
    prompt("s1", ["Ask A."], stamp(1)),
    launch("L1", 2),
    c("a1", 3, agent("ag1", "L1"), [W + "x.txt"]),
    wake("L1", "ag1", 4),
    prompt("s1", ["Ask B."], stamp(5)),
    c("pre", 6, {}, [W + "pre.txt"]),
    send("S1", 7),
  ];
  const baseStates = [...changed("x.txt", "x", "a1", 2), ...changed("pre.txt", "q", "pre", 3)];
  it("a resume whose only output is a ambiguous-lane change forks from Claude's stop at the SendMessage", () => {
    const o = [...base, c("a2", 8, agent("ag1", "L1"), [W + "x.txt"]), c("mm", 8, {}, [W + "x.txt"]), wake("S1", "ag1", 9), stop("s1")];
    const m = model(o, [...baseStates, state(W + "x.txt", "x2", "x1", { open: ["a2", "mm"], credited: ["a2", "mm"], step: 4 })]);
    const r = m.actors.find((a) => a.id === "agent:1r1")!;
    assert.ok(r, JSON.stringify(m.actors.map((a) => a.id)));
    assert.equal(m.stops.filter((s) => s.lane === r.id).length, 0, "expected no stop of its own");
    assert.ok(r.startId && r.startId !== "start", String(r.startId));
    assert.ok(idxOf(m, r.startId) >= idxOf(m, "req-r002"), `${r.startId}`);
    assert.ok(idxOf(m, r.startId) < idxOf(m, r.mergeId));
  });
  it("a resume whose only output is a wake forks from the SendMessage's point, not Start", () => {
    const o = [...base, wake("S1", "ag1", 9), stop("s1")];
    const m = model(o, baseStates);
    const r = m.actors.find((a) => a.id === "agent:1r1")!;
    assert.ok(r);
    assert.ok(r.startId && r.startId !== "start", String(r.startId));
    assert.ok(idxOf(m, r.startId) >= idxOf(m, "req-r002"));
  });
  it("a resumed line shares its helper's name and chip and names the first line as its group", () => {
    const m = model(ops, states);
    const resumed = m.actors.filter((a) => a.group !== undefined);
    assert.ok(resumed.length >= 2, String(resumed.length));
    for (const r of resumed) {
      const first = m.actors.find((a) => a.id === r.group)!;
      assert.ok(first && first.group === undefined);
      assert.equal(r.name, first.name);
      assert.equal(r.chip, first.chip);
      assert.ok(!/resumed/.test(r.name));
    }
  });
});

// The page code runs as is in a vm with a DOM stub (as in the other page tests); the legend is read from the nodes it builds.
class Nd {
  attrs: Record<string, string> = {}; children: Nd[] = []; parentNode: Nd | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; nodeType = 1; scrollTop = 0;
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: Nd[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {}
  scrollIntoView() {}
  scrollTo() {}
  scrollBy() {}
  removeAttribute() {}
  insertBefore() {}
  remove() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
}
const mk = (tag = "div"): Nd => new Proxy(new Nd(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

async function legendOf(modelIn: unknown) {
  const model = JSON.parse(JSON.stringify(modelIn));
  const nodes = new Map<string, Nd>();
  const byId = (id: string): Nd => { if (!nodes.has(id)) { const n = mk(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const timers: unknown[] = [];
  const body = mk(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mk(t), createElementNS: (_: string, t: string) => mk(t), createTextNode: (t: string) => { const n = mk("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener() {}, setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); timers.push(id); return id; }, clearInterval,
    // The page opens on a change (no start stop), so the view route answers a plain view.
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? model : u.includes("/view/") ? { change: "x", file: "f", engine: "e", kind: "card", before: [], after: [], boxes: [], caveats: [] } : {}) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  const buttons = () => byId("legend").children;
  return { buttons, labels: () => buttons().map((b) => b.textContent), pressed: () => buttons().map((b) => b.attrs["aria-pressed"]), done: () => timers.forEach((t) => clearInterval(t as never)) };
}

describe("the legend lists each helper once", () => {
  it("the recorded shape: one legend entry per helper, though a resumed helper has two lines", async () => {
    const m = model(ops, states);
    assert.ok(m.actors.filter((a) => a.parent).length > new Set(m.actors.filter((a) => a.parent).map((a) => a.chip)).size, "the shape must have resumed lines");
    const l = await legendOf(m);
    try {
      // a token is a dot and the name (no letter chip): a helper's token reads "Helper <chip>"
      const chips = l.labels().map((t) => /^Helper (\S+)$/.exec(t)?.[1]).filter((c): c is string => c !== undefined);
      const wanted = new Set(m.actors.filter((a) => a.parent).map((a) => a.chip));
      assert.ok(wanted.size > 0);
      assert.deepEqual([...chips].sort(), [...wanted].sort(), l.labels().join(","));
    } finally { l.done(); }
  });
  it("one button hides and shows every line of its helper", async () => {
    const m = model(ops, states);
    const l = await legendOf(m);
    try {
      const at = l.labels().findIndex((t) => t.includes("Helper 3"));
      assert.ok(at >= 0, l.labels().join(","));
      l.buttons()[at]!.click();
      assert.equal(l.pressed()[at], "false");
      assert.ok(l.pressed().filter((p) => p === "true").length >= 1);
      l.buttons()[at]!.click();
      assert.equal(l.pressed()[at], "true");
    } finally { l.done(); }
  });
  it("the two lanes named Unknown are one legend entry, and its button hides both", async () => {
    const m = JSON.parse(JSON.stringify(model(ops, states)));
    const base = m.stops.find((x: { lane: string }) => x.lane === "claude");
    m.actors.push({ id: "other", name: "Unknown", chip: "U", color: "#7a7f88" }, { id: "unsure", name: "Unknown", chip: "U", color: "#7a7f88" });
    m.stops.push({ ...base, id: "u-other", lane: "other" }, { ...base, id: "u-unsure", lane: "unsure" });
    const l = await legendOf(m);
    try {
      assert.equal(l.labels().filter((t) => t.includes("Unknown")).length, 1, l.labels().join(","));
    } finally { l.done(); }
  });
});
