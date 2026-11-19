import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { isReadOnlyMcpTool } from "../src/credit-guard.ts";
import { call, prompt, stop, state } from "./fixtures/timeline.ts";

// an MCP write with no connector is a rail stop of its own, "logged, not diffed", marked with an outbound paper plane; read-only
// MCP calls fold into the quiet count; no value is shown (the call's input and response are now stored, sealed, in the task's store; showing them is a later page feature). Tool names follow the shapes in test/timeline-call-labels-and-outside-scrub.test.ts.

const W = "/w";
const mcp = (id: string, at: number, tool: string, fields: string[]) => call(id, { tool, at, end: at + 1, cmd: tool, extra: { toolLabel: { fields: {}, inputFields: fields } } });

function build(calls: ReturnType<typeof call>[], connectorFor?: (server: string, tool: string) => boolean): RailModel {
  const input: TimelineInput = {
    taskId: 1, build: "t", ops: [...calls, prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")], fileStates: [],
    folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map(),
  };
  return buildRailModel(buildTimeline(input), connectorFor === undefined ? undefined : { connectorFor });
}

describe("model: an MCP write is a stop", () => {
  const m = build([mcp("a", 10, "mcp__github__create_issue", ["title", "body", "repo"]), mcp("b", 20, "mcp__github__list_issues", ["repo"]), mcp("c", 30, "mcp__github__get_issue", ["number"])]);
  const writes = m.stops.filter((s) => s.mcpWrite !== undefined);

  it("carries the write as data: server, tool, input field names, a paper-plane stop with no file parts", () => {
    assert.equal(writes.length, 1);
    const s = writes[0]!;
    assert.deepEqual(s.mcpWrite, { server: "github", tool: "create_issue", fields: ["title", "body", "repo"] });
    assert.equal(s.change, undefined);
    assert.equal(s.calls, undefined);
    assert.equal(s.path, undefined);
    assert.equal(m.files.length, 0, "never a file row");
  });

  it("read-only calls fold into the quiet count of the nearest stop, not stops", () => {
    const last = m.stops[m.stops.length - 1]!;
    assert.deepEqual(last.quiet?.calls.map((c) => c.id), ["b", "c"]);
    assert.equal(last.quiet?.count, 2);
  });

  it("holds no value: the stop is data of names only (the values are kept sealed in the store, never on the stop)", () => {
    assert.ok(!/secret-value/.test(JSON.stringify(writes[0])));
  });

  it("an unknown shape is a write; credit-guard's predicate is the one decider (a read verb with a write word is a write)", () => {
    const names = ["mcp__x__frobnicate", "mcp__x__get_and_delete", "mcp__x__list", "mcp__x__search_docs", "mcp__x__x"];
    const mm = build(names.map((n, i) => mcp("k" + i, 10 + i, n, [])));
    const asWrite = mm.stops.filter((s) => s.mcpWrite !== undefined).map((s) => s.mcpWrite!.tool);
    assert.deepEqual(asWrite, names.filter((n) => !isReadOnlyMcpTool(n)).map((n) => n.split("__")[2]));
    assert.deepEqual(asWrite, ["frobnicate", "get_and_delete", "x"]);
  });

  it("an installed connector matching the server or the tool keeps the call off the write rail", () => {
    const byServer = build([mcp("a", 10, "mcp__github__create_issue", [])], (s) => s === "github");
    const byTool = build([mcp("a", 10, "mcp__github__create_issue", [])], (_s, t) => t === "create_issue");
    const other = build([mcp("a", 10, "mcp__github__create_issue", [])], (s) => s === "notion");
    assert.equal(byServer.stops.filter((s) => s.mcpWrite).length, 0);
    assert.equal(byTool.stops.filter((s) => s.mcpWrite).length, 0);
    assert.equal(other.stops.filter((s) => s.mcpWrite).length, 1);
  });
});

// a non-read-only, connector-less, non-failed MCP call has exactly one mcpWrite stop whether or not credit-guard credited it a file
// change (a filesystem MCP server may really write a local file, so the file stop keeps naming the call). Accepted limit: a FAILED MCP write keeps today's failure stop.
describe("a credited MCP write still gets its write stop", () => {
  const build2 = () => {
    const c = call("m1", { tool: "mcp__github__create_issue", at: 10, end: 30, extra: { toolLabel: { fields: {}, inputFields: ["title"] } } });
    const input: TimelineInput = {
      taskId: 1, build: "t", ops: [c, prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")],
      fileStates: [{ ...state("/w/a.txt", "s0", null, { step: 1 }) }, { ...state("/w/a.txt", "s1", "s0", { open: ["m1"], credited: ["m1"] }), ts: 20000 } as never],
      folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map(),
    };
    const t = buildTimeline(input);
    return { t, m: buildRailModel(t) };
  };
  it("the call is credited a file change, yet has exactly one mcpWrite stop; the file stop still reads as a file change", () => {
    const { t, m } = build2();
    assert.equal(t.requests.flatMap((r) => r.runs.flatMap((x) => x.calls)).find((c) => c.id === "m1")!.changes.length, 1);
    const writes = m.stops.filter((s) => s.mcpWrite !== undefined);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]!.mcpWrite, { server: "github", tool: "create_issue", fields: ["title"] });
    const fileStop = m.stops.find((s) => s.change !== undefined);
    assert.ok(fileStop, "the file change is still a file stop");
    assert.match(fileStop!.label, /a\.txt/);
    assert.equal(fileStop!.mcpWrite, undefined);
  });
});

// ---- the page: review.js in a vm over a small DOM stand-in (the technique of test/helpers/connector-migration.ts pageOf) ----

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  focus() {}
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

async function pageAt(model: RailModel, index: number): Promise<{ all: N[]; byId: (id: string) => N }> {
  const m = JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
  m.excel = true;
  const src = await Promise.all(["view-table.js", "files-view.js", "review.js"].map((f) => readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8")));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const created: N[] = [];
  const document = { body, getElementById: byId, createElement: (t: string) => { const n = mkNode(t); created.push(n); return n; }, createElementNS: (_: string, t: string) => { const n = mkNode(t); created.push(n); return n; }, createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [], addEventListener() {}, activeElement: null };
  const json = (v: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(v)) });
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: `#${index}` }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (u: string) => (u.includes("/review/status") ? json({ stops: {}, passes: { markers: [], tags: {} } }) : u.includes("/review/model") ? json(m) : json({})) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  ["view-table.js", "files-view.js", "review.js"].forEach((f, k) => vm.runInContext(src[k]!, ctx, { filename: f }));
  for (let k = 0; k < 4; k++) await new Promise((r) => setTimeout(r, 40));
  return { all: [...nodes.values(), ...created], byId };
}

describe("page: review.js draws the stop", () => {
  const m = build([mcp("a", 10, "mcp__github__create_issue", ["title", "body"])]);
  const i = m.stops.findIndex((s) => s.mcpWrite !== undefined);

  // the card is "What <server> told the agent" from the kept values; it carries no "logged, not diffed" or "values not kept" line
  // from the card (the rail row's head keeps "(logged, not diffed)"). Here the route answers nothing, so the card falls back to words and the field names.
  it("with nothing kept the card names tool (spoken) and server, lists the field names, and says nothing was kept; no file pane", async () => {
    const p = await pageAt(m, i);
    const body = p.byId("bodyview");
    const text = body.textContent;
    assert.match(text, /What github told the agent/);
    assert.match(text, /create issue/);
    assert.match(text, /github/);
    assert.match(text, /title/);
    assert.match(text, /body/);
    assert.match(text, /did not keep what was sent/i);
    assert.equal(body.hidden, false);
    assert.equal(p.byId("stage").hidden, true, "no grid or page pane");
    assert.equal(p.byId("below").hidden, true);
    assert.equal(p.byId("openxl").textContent, "", "no open-in-app buttons (the container does not exist)");
    assert.equal(p.byId("hcalls").hidden, true, "no file chip or call list");
  });

  it("the rail row carries the outbound paper-plane mark", async () => {
    const p = await pageAt(m, i);
    const plane = p.all.filter((n) => /(^|\s)sent(\s|$)/.test(n.className));
    assert.ok(plane.length >= 1, "a paper-plane mark is on the rail row");
    assert.match(plane[0]!.attrs["aria-label"] ?? "", /outside CoCheck|external/i);
  });
});
