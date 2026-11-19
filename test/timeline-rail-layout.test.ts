import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// the rail layout of review page v2 (docs/design/review-page-v2.md, "The rail"). Every row type has a slot of its own: call headers,
// quiet rows and failure groups never sit between or on top of stops. A run of failed calls by one actor is one counted stop, and a failure
// on a call group attaches once. Call headers collapse and the legend hides an actor's rows. The page code runs as is in a vm with a DOM stub.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, text: string, changes: Change[] = [], over: Record<string, unknown> = {}) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text, source: "agent-description", label: "l" }, agent: null, ...over });
const failed = (id: string, start: number, text: string, error: string, over: Record<string, unknown> = {}) => call(id, start, text, [], { outcome: "failed", error, ...over });
const timeline = (calls: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: calls.length, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls }] }] } as unknown as Timeline);

describe("a run of failed calls is one counted stop", () => {
  it("consecutive failed calls by one actor with no change between them are one stop, listing each call's last error line", () => {
    const m = buildRailModel(timeline([
      failed("f1", 1, "Fetch FRED", "Exit code 1\nTraceback\nTimeoutError: The read operation timed out"),
      failed("f2", 2, "Test the FRED site", "Exit code 92"),
      call("k1", 3, "write a", [change("a", "a.txt", "k1")]),
    ]));
    assert.deepEqual(m.stops.map((s) => s.id), ["req-r0", "fail-f1", "chg-a"]);
    const g = m.stops[1]!;
    assert.equal(g.label, "2 runs failed");
    // the whole output rides on a run when it says more than the error line; "Show output" opens it
    assert.deepEqual(g.runs, [{ id: "f1", text: "Fetch FRED", error: "TimeoutError: The read operation timed out", output: "Exit code 1\nTraceback\nTimeoutError: The read operation timed out" }, { id: "f2", text: "Test the FRED site", error: "Exit code 92" }]);
    assert.equal(g.change, undefined, "no panes: nothing changed");
    assert.match(JSON.stringify(g.card), /Exit code 92/);
  });

  it("a change between two failures ends the run, so each is a group of one", () => {
    const m = buildRailModel(timeline([
      failed("f1", 1, "Fetch FRED", "Exit code 1"),
      call("k1", 2, "write a", [change("a", "a.txt", "k1")]),
      failed("f2", 3, "Fetch again", "Exit code 2"),
    ]));
    assert.deepEqual(m.stops.map((s) => [s.id, s.label]), [["req-r0", "Your request"], ["fail-f1", "1 run failed"], ["chg-a", "Changed a.txt"], ["fail-f2", "1 run failed"]]);
  });

  it("another actor's failures between them do not end the run; each actor keeps its own group", () => {
    const h1 = { agent: { id: "a1", type: "general-purpose" } }, h2 = { agent: { id: "a2", type: "general-purpose" } };
    const m = buildRailModel(timeline([
      failed("x1", 1, "memo 1", "E1", h1), failed("y1", 2, "deck 1", "E2", h2), failed("x2", 3, "memo 2", "E3", h1), failed("y2", 4, "deck 2", "E4", h2), failed("y3", 5, "deck 3", "E5", h2),
    ]));
    const groups = m.stops.filter((s) => s.runs);
    assert.deepEqual(groups.map((s) => [s.label, s.runs!.map((r) => r.id)]), [["2 runs failed", ["x1", "x2"]], ["3 runs failed", ["y1", "y2", "y3"]]]);
    assert.notEqual(groups[0]!.lane, groups[1]!.lane);
  });

  it("a request between two failures ends the run too", () => {
    const tl = timeline([failed("f1", 1, "one", "E1")]);
    tl.requests.push({ ...tl.requests[0]!, id: "r1", index: 1, runs: [{ ...tl.requests[0]!.runs[0]!, calls: [failed("f2", 3, "two", "E2")] }] } as never);
    tl.requests[0]!.at = 0; tl.requests[1]!.at = 2;
    const m = buildRailModel(tl);
    assert.deepEqual(m.stops.map((s) => s.label), ["Your request", "1 run failed", "Your request", "1 run failed"]);
  });
});

describe("a failure on a call group attaches once", () => {
  const m = buildRailModel(timeline([call("k2", 1, "Rerun the fetch", [change("b", "b.txt", "k2"), change("c", "c.txt", "k2"), change("e", "e.txt", "k2")], { outcome: "failed", error: "Exit code 1" })]));
  const files = m.stops.filter((s) => s.change);
  it("the run's first file carries it and the files after it carry none", () => {
    assert.deepEqual(files.map((s) => s.id), ["chg-b", "chg-c", "chg-e"]);
    assert.ok(files[0]!.change!.failed, "the first file says the call failed");
    assert.ok(files[0]!.failure, "and has the failure box");
    assert.deepEqual(files.slice(1).map((s) => [s.change!.failed, s.failure]), [[null, undefined], [null, undefined]]);
  });
  it("the call itself says a failure rides on it, for the header", () => {
    assert.ok(files.every((s) => s.call?.failed === true));
  });
  it("a lone failed change keeps its failure", () => {
    const one = buildRailModel(timeline([call("k1", 1, "write a", [change("a", "a.txt", "k1")], { outcome: "failed", error: "Exit code 1" })]));
    const a = one.stops.find((s) => s.id === "chg-a")!;
    assert.ok(a.change!.failed && a.failure);
    assert.equal(a.call?.failed, undefined, "a lone stop links to its call, and the failure rides on the stop, not the call");
  });
});

// ---------- the page ----------
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; focused = false;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  fire(k: string, e: Record<string, unknown> = {}) { (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this, ...e })); }
  click() { this.fire("click"); }
  focus() { this.focused = true; } select() {} scrollIntoView() {} scrollTo() {} showModal() { this.open = true; } close() { this.open = false; }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

// One request; a lone change a.txt; two failed calls; one call that changed b.txt and c.txt (a header); d.txt, then two calls that changed nothing.
const pageModel = buildRailModel(timeline([
  call("k1", 1, "write a", [change("a", "a.txt", "k1")]),
  failed("f1", 2, "Fetch FRED", "Exit code 1"), failed("f2", 3, "Test the site", "Exit code 92"),
  call("k2", 4, "Rerun the fetch", [change("b", "b.txt", "k2"), change("c", "c.txt", "k2")]),
  call("k3", 5, "write d", [change("d", "d.txt", "k3")]),
  call("q1", 6, "List the folder"), call("q2", 7, "Read a picture"),
]));

async function boot(model: RailModel, opts: { verdicts?: Record<string, "passed" | "failed">; hash?: string; markers?: unknown[]; files?: boolean; live?: boolean } = {}) {
  let served: RailModel = model;
  const polls: Array<() => void> = []; // the live poll timer (2 s) is fired by the test, never by the clock
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const stops: Record<string, { status: string; note: string; stale: boolean; history: unknown[] }> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  for (const [id, status] of Object.entries(opts.verdicts ?? {})) stops[`chg-${id}`] = { status, note: status === "failed" ? "x" : "", stale: false, history: [] };
  const summary = () => ({ anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: opts.hash ?? "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval: () => 0, clearInterval() {},
    setTimeout: (f: () => void, ms: number) => { if (f.name === "poll" && ms === 1000) { polls.push(f); return 0; } return ms === 6000 || f.name === "poll" ? 0 : setTimeout(f, 0); }, clearTimeout() {},
    fetch: async (u: string, init?: { body?: string }) => {
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(opts.live ? { ...served, live: true } : served)));
      if (u.includes("/review/status")) return json({ stops: JSON.parse(JSON.stringify(stops)), passes: { markers: opts.markers ?? [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], ...summary() });
      if (u.includes("/review/verdict")) {
        const b = JSON.parse(init!.body!);
        stops[b.stop] = { status: b.status, note: b.note, stale: false, history: [] };
        return json({ stop: b.stop, state: stops[b.stop], ...summary() });
      }
      if (u.includes("/view/")) return json({ change: "x", file: "f", engine: "e", kind: "card", before: [], after: [], boxes: [], caveats: [] });
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
  const ctx = vm.createContext(g);
  for (const f of opts.files ? ["view-table.js", "files-view.js", "review.js"] : ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const press = async (k: string, target: unknown = { tagName: "BODY" }) => { handlers.keydown!({ key: k, target, preventDefault() {} }); await settle(); };
  const tl = () => byId("tl");
  const rows = () => tl().children.filter((n) => has(n, "row"));
  const row = (label: string) => rows().find((r) => r.textContent.includes(label));
  const on = () => { const h = byId("h1").textContent; return h === "Rerun the fetch" ? "hdr" : model.stops.find((s) => (s.title ?? s.head) === h)?.id; };
  /* every slot in the column: steps, quiet rows, open quiet lists, markers; top and height in px */
  const slots = () => tl().children.filter((n) => has(n, "row") || has(n, "quiet") || has(n, "qlist")).map((n) => ({ n, top: parseFloat(String(n.style.top)), h: has(n, "qlist") ? 0 : parseFloat(String(n.style.height)) }));
  return { byId, press, settle, serve: async (m: RailModel) => { served = m; polls.splice(0).forEach((f) => f()); await settle(); }, tl, rows, row, on, slots, legend: () => byId("legend").children };
}

describe("every row has a slot of its own", () => {
  it("call headers, quiet rows and failure groups are rows in the column, and no row overlaps another", async () => {
    const p = await boot(pageModel);
    const s = p.slots().sort((x, y) => x.top - y.top);
    for (let i = 1; i < s.length; i++) assert.ok(s[i]!.top >= s[i - 1]!.top + s[i - 1]!.h, `${s[i]!.n.textContent} starts at ${s[i]!.top}, inside ${s[i - 1]!.n.textContent} (${s[i - 1]!.top} + ${s[i - 1]!.h})`);
    const kinds = s.map((x) => (has(x.n, "quiet") ? `quiet:${x.n.textContent}` : has(x.n, "hdr") ? `hdr:${x.h}` : has(x.n, "fgroup") ? `fail:${x.h}` : `stop:${x.h}`));
    // every row is 28 px; a request is a section header with 8 px of air above its 28 px line
    assert.deepEqual(kinds, ["stop:36", "stop:28", "fail:28", "hdr:28", "stop:28", "quiet:2 commands, no file changed"]);
    assert.equal(parseFloat(String(s[s.length - 1]!.n.style.height)), 22, "a quiet row is 22 px");
  });

  it("the failure group is a stop whose label carries its count and whose node is the failure ring", async () => {
    const p = await boot(pageModel);
    const f = p.row("2 runs failed")!;
    assert.ok(f, "the two failed calls are one row");
    assert.ok(f.children.some((c) => has(c, "mark") && has(c, "fail")));
    assert.equal(p.rows().filter((r) => /run failed|runs failed/.test(r.textContent)).length, 1);
  });

  // the rail keeps one quiet line; selecting it opens the calls in the main area. Nothing raw is drawn in the rail.
  it("a quiet row is a button the keyboard reaches; selecting it opens its calls in the main area and moves nothing in the rail", async () => {
    const p = await boot(pageModel, { hash: "#1" });
    const q = p.tl().children.find((n) => has(n, "quiet"))!;
    const line = q.children.find((c) => has(c, "qline"))!;
    assert.notEqual(line.attrs.tabindex, "-1", "reachable by Tab");
    const before = p.slots().map((x) => x.top);
    line.click(); await p.settle();
    assert.equal(p.tl().children.some((n) => has(n, "qlist")), false, "nothing raw is drawn in the rail");
    assert.deepEqual(p.slots().map((x) => x.top), before, "no rail row moved");
    assert.equal(p.byId("h1").textContent, "2 commands, no file changed");
    const body = p.byId("bodyview");
    assert.equal(body.hidden, false);
    const labels = body.descendants().filter((c) => has(c, "what")).map((c) => c.textContent);
    assert.deepEqual(labels, ["List the folder", "Read a picture"]);
    assert.ok(body.descendants().filter((c) => c.tag === "pre").every((c) => has(c, "codeblock") && c.hidden), "each command is a closed code block");
    await p.press("p");
    assert.equal(p.byId("pbpass").attrs["aria-pressed"], "false", "P does nothing here");
    await p.press("ArrowUp");
    assert.notEqual(p.byId("h1").textContent, "2 commands, no file changed", "an arrow leaves it for a step");
  });
});

describe("the opened calls of a quiet group", () => {
  it("show no line under the heading", async () => {
    const bare = await boot(pageModel, { hash: "#1" });
    bare.tl().children.find((n) => has(n, "quiet"))!.children.find((c) => has(c, "qline"))!.click(); await bare.settle();
    assert.equal(bare.byId("h2").hidden, true, "no line, never a placeholder");
  });
});

describe("call headers collapse", () => {
  it("a header starts closed even with files that need a verdict: chevron, a count of its files, and no file rows", async () => {
    const p = await boot(pageModel);
    const h = p.row("Rerun the fetch")!;
    assert.equal(h.attrs["aria-expanded"], "false");
    assert.ok(h.descendants().some((c) => c.attrs.class === "chev"), "the chevron is in the row's label, centred with it");
    assert.match(h.textContent, /2 files/);
    assert.equal(p.row("b.txt"), undefined);
    assert.equal(p.row("c.txt"), undefined);
  });

  it("a click opens it and a redraw (hiding and showing an actor) does not close it again", async () => {
    const p = await boot(pageModel);
    p.row("Rerun the fetch")!.click(); await p.settle();
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "true");
    assert.ok(p.row("b.txt") && p.row("c.txt"));
    const [you] = p.legend();
    you!.click(); await p.settle(); you!.click(); await p.settle();
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "true", "a redraw never re-collapses a group the person opened");
    assert.ok(p.row("b.txt"));
  });

  it("a link to a step inside a closed header opens it and shows the step (never hidden in a closed group)", async () => {
    const p = await boot(pageModel, { hash: "#5" });
    assert.equal(p.on(), "chg-c");
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "true");
    assert.ok(p.row("c.txt"), "the selected step has a row");
    await p.press("ArrowUp");
    assert.equal(p.on(), "chg-b");
    assert.ok(p.row("b.txt"), "left by an arrow, the group stays open");
  });

  it("landing on Deliverables opens nothing; switching to the Timeline selects the closed header, never a step hidden in it", async () => {
    const p = await boot(pageModel, { files: true, hash: "#v=files&f=b.txt&p=1" });
    assert.equal(p.byId("filesview").hidden, false, "landed on Deliverables, on a file whose step is under the header");
    p.byId("vsteps").click(); await p.settle();
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "false");
    assert.equal(p.on(), "hdr", "the header is the selected row");
    assert.equal(p.row("b.txt"), undefined, "the selected step is not hidden in a closed group");
  });

  it("a deep link, a jump and the arrows still open a group to show their step", async () => {
    const p = await boot(pageModel, { files: true, hash: "#5" });
    assert.equal(p.on(), "chg-c");
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "true");
    await p.press("ArrowUp");
    assert.equal(p.on(), "chg-b");
    assert.ok(p.row("b.txt"));
    const q = await boot(pageModel, { files: true, hash: "#1" });
    await q.press("ArrowDown"); await q.press("ArrowDown");
    assert.equal(q.on(), "hdr");
    assert.equal(q.row("Rerun the fetch")!.attrs["aria-expanded"], "false");
    await q.press("ArrowRight");
    assert.equal(q.row("Rerun the fetch")!.attrs["aria-expanded"], "true", "Right on the header opens it");
    assert.ok(q.row("b.txt"));
  });

  it("a poll that forms a header around the step on show opens it, so the step stays visible", async () => {
    const one = buildRailModel(timeline([call("k2", 4, "Rerun the fetch", [change("b", "b.txt", "k2")])]));
    const two = buildRailModel(timeline([call("k2", 4, "Rerun the fetch", [change("b", "b.txt", "k2"), change("c", "c.txt", "k2")])]));
    const p = await boot(one, { hash: "#v=timeline", live: true });
    await p.press("ArrowDown");
    assert.equal(p.on(), "chg-b");
    await p.serve(two);
    assert.equal(p.on(), "chg-b", "the step on show stays selected");
    assert.ok(p.row("b.txt"), "it has a row, not hidden in a closed header");
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "true");
  });

  it("closed once every file under it has a verdict: it reads N files, its node is a ringed dot, and its files are gone", async () => {
    const p = await boot(pageModel, { verdicts: { b: "passed", c: "passed" } });
    const h = p.row("Rerun the fetch")!;
    assert.equal(h.attrs["aria-expanded"], "false");
    assert.match(h.textContent, /2 files/);
    assert.ok(h.children.some((c) => has(c, "mark") && has(c, "hring")));
    assert.equal(p.row("b.txt"), undefined);
    assert.equal(p.row("c.txt"), undefined);
  });

  it("a click on the header opens or closes it and selects it; the state set by hand is kept", async () => {
    const p = await boot(pageModel, { verdicts: { b: "passed", c: "passed" }, hash: "#1" });
    p.row("Rerun the fetch")!.click(); await p.settle();
    assert.equal(p.on(), "hdr");
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "true");
    assert.ok(p.row("b.txt"));
    await p.press("ArrowDown"); await p.press("ArrowDown"); await p.press("ArrowDown");
    assert.equal(p.on(), "chg-d", "moved past the files");
    assert.ok(p.row("b.txt"), "opened by hand, it stays open after the current step leaves it");
  });

  it("with the header current, Right opens it and Left closes it; neither steps away", async () => {
    const p = await boot(pageModel, { hash: "#0" });
    await p.press("ArrowDown"); await p.press("ArrowDown"); await p.press("ArrowDown");
    assert.equal(p.on(), "hdr");
    await p.press("ArrowLeft");
    assert.equal(p.on(), "hdr");
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "false");
    assert.equal(p.row("b.txt"), undefined);
    await p.press("ArrowDown");
    assert.equal(p.on(), "chg-d", "the arrows skip the files of a closed header");
    await p.press("ArrowUp");
    await p.press("ArrowRight");
    assert.equal(p.on(), "hdr");
    assert.ok(p.row("b.txt"));
  });

  it("Left on a file under a header closes that header and lands on it", async () => {
    const p = await boot(pageModel, { hash: "#5" });
    assert.equal(p.on(), "chg-c");
    await p.press("ArrowLeft");
    assert.equal(p.on(), "hdr");
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "false");
  });

  it("a header passed with P folds away as the page moves on", async () => {
    const p = await boot(pageModel, { verdicts: { a: "passed" }, hash: "#3" });
    assert.equal(p.on(), "hdr");
    await p.press("p");
    assert.equal(p.on(), "chg-d");
    assert.equal(p.row("Rerun the fetch")!.attrs["aria-expanded"], "false");
    assert.equal(p.row("b.txt"), undefined);
  });
});

describe("the legend hides and shows an actor", () => {
  it("hiding an actor drops its rows; the current step moves to the nearest shown one; the last actor can't be hidden", async () => {
    // requests are section headers, not a lane: the person has no legend token, so Claude is the only token here and the last shown actor
    const p = await boot(pageModel, { hash: "#1" });
    assert.equal(p.on(), "chg-a");
    const [claude] = p.legend();
    assert.equal(p.legend().some((b) => b.attrs["data-g"] === "you"), false, "no token for the person");
    claude!.click(); await p.settle();
    assert.equal(claude!.attrs["aria-pressed"], "true", "the last shown actor stays");
    assert.equal(p.legend()[0], claude, "the legend's buttons stay in place, so the pill can ease");
    assert.ok(p.rows().some((r) => r.textContent.includes("a.txt")));
  });
});

describe("small, quick motion, off under reduced motion", () => {
  it("rows glide and fade in 120 to 180 ms by transform and opacity only, and the reduced-motion rule turns it off", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    // a duration is a literal or one of the motion tokens on :root (var(--dur-fast) and the like), resolved here
    const D = "(\\.\\d+s|\\d+(?:\\.\\d+)?s|var\\(--[\\w-]+\\))";
    const sec = (v: string): number => { const t = /^var\((--[\w-]+)\)$/.exec(v); if (!t) return parseFloat(v); const m = new RegExp(`${t[1]}:([\\d.]+)s`).exec(css); assert.ok(m, t[1]); return parseFloat(m![1]!); };
    const ms = (pre: string) => { const re = new RegExp(pre + D); const m = re.exec(css); assert.ok(m, String(re)); return sec(m![1]!) * 1000; };
    for (const d of [ms("\\.tl \\.flip\\{transition:transform "), ms("\\.tl \\.enter\\{animation:railin "), ms("\\.row\\.hdr \\.chev\\{[^}]*transition:transform "), ms("\\.lg\\{transition:background-color ")]) {
      assert.ok(d >= 120 && d <= 180, `${d} ms`);
    }
    assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition:none!important\}\}/);
    const js = await readFile(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    assert.match(js, /prefers-reduced-motion: reduce/, "the script skips the motion there too");
  });
});

// every maximal run of adjacent quiet slots, across lanes and actors, is one row; a real node ends the run.
describe("quiet rows collapse across actors", () => {
  const withQuiet = (edit: (m: { stops: Array<{ id: string; quiet?: { count: number; calls: Array<{ id: string; text: string; lane: string }> } }>; actors: Array<{ id: string; name: string }>; quiet?: unknown }) => void): RailModel => {
    const m = JSON.parse(JSON.stringify(pageModel)); edit(m); return m as RailModel;
  };
  const quietRows = (p: Awaited<ReturnType<typeof boot>>) => p.tl().children.filter((n) => has(n, "quiet")).map((n) => n.textContent);
  const lanes = pageModel.actors.map((a) => a.id);

  it("calls of two actors in one place are one row, and opening it groups the calls by actor", async () => {
    const a = lanes[0]!, b = "codex";
    const m = withQuiet((x) => {
      if (!x.actors.some((o) => o.id === b)) x.actors.push({ ...x.actors[0]!, id: b, name: "Codex", main: false, col: x.actors.length } as never);
      const last = x.stops.find((s) => s.quiet)!;
      last.quiet = { count: 3, calls: [{ id: "q1", text: "List the folder", lane: a }, { id: "q2", text: "Other actor call", lane: b }, { id: "q3", text: "Read a picture", lane: a }] };
    });
    const p = await boot(m, { hash: "#1" });
    assert.deepEqual(quietRows(p), ["3 commands, no file changed"]);
    p.tl().children.find((n) => has(n, "quiet"))!.children.find((c) => has(c, "qline"))!.click(); await p.settle();
    const body = p.byId("bodyview");
    assert.deepEqual(body.descendants().filter((c) => has(c, "what")).map((c) => c.textContent), ["List the folder", "Read a picture", "Other actor call"], "grouped by actor");
    assert.equal(body.descendants().filter((c) => has(c, "qactor")).length, 2, "a heading per actor when more than one");
  });

  // a merged row spanning lanes draws one mark, not one dot per lane.
  it("a merged quiet row draws one mark on the rail, a group pill, and a single-lane row keeps its plain dot", async () => {
    const a = lanes[0]!, b = "codex";
    const m = withQuiet((x) => {
      if (!x.actors.some((o) => o.id === b)) x.actors.push({ ...x.actors[0]!, id: b, name: "Codex", main: false, col: x.actors.length } as never);
      x.stops.find((s) => s.quiet)!.quiet = { count: 3, calls: [{ id: "q1", text: "List the folder", lane: a }, { id: "q2", text: "Other actor call", lane: b }, { id: "q3", text: "Read a picture", lane: a }] };
    });
    const p = await boot(m, { hash: "#1" });
    const marks = p.tl().children.find((n) => has(n, "quiet"))!.children.filter((c) => has(c, "qtick"));
    assert.equal(marks.length, 1, "one mark, no loose dots");
    assert.ok(has(marks[0]!, "qgroup"), "it reads as a collapsed group");
    const one = await boot(pageModel, { hash: "#1" });
    const q = one.tl().children.find((n) => has(n, "quiet"))!.children.filter((c) => has(c, "qtick"));
    assert.equal(q.length, 1);
  });

  // three new files whose names share a long start must differ in the part that survives a narrow row.
  it("a file stop's label keeps the end of the file name apart from the part that can be cut", async () => {
    const names = ["unemployment_rate_2024.csv", "unemployment_rate_2025.csv", "unemployment_rate_2026.csv"];
    const p = await boot(buildRailModel(timeline(names.map((n, i) => call("w" + i, i + 1, "write " + n, [change("n" + i, n, "w" + i)])))), { hash: "#1" });
    const tx = p.tl().descendants().filter((c) => has(c, "tx") && has(c, "split"));
    assert.equal(tx.length, 3, "file stops split their label");
    assert.equal(new Set(tx.map((t) => t.children[1]!.textContent)).size, 3, "the three kept tails differ");
    for (const t of tx) {
      const [h, e] = t.children;
      assert.ok(has(h!, "txh") && has(e!, "txt"));
      assert.equal(h!.textContent + e!.textContent, t.textContent);
      assert.ok(e!.textContent.length >= 9 && e!.textContent.length <= 24, "the kept tail is the distinguishing end, never the whole name");
    }
  });

  it("quiet calls at the origin and after the first stop stay apart, because a step sits between", async () => {
    const m = withQuiet((x) => { x.quiet = { count: 1, calls: [{ id: "o1", text: "Early", lane: lanes[0]! }] }; });
    const p = await boot(m, { hash: "#1" });
    assert.deepEqual(quietRows(p), ["1 command, no file changed", "2 commands, no file changed"]);
  });
  // a reply is a marker slot of its own, so it ends a run of quiet calls; nothing may merge across it.
  it("a reply marker between two quiet runs keeps them as two rows, with the marker between them", async () => {
    const m = withQuiet((x) => { x.stops.find((s) => s.id === "chg-a")!.quiet = { count: 1, calls: [{ id: "e1", text: "Early call", lane: lanes[0]! }] }; });
    const reply = { id: "m1", kind: "send_back", label: "Your reply", ts: 1, pass: 2, beforeStop: "chg-d" };
    const p = await boot(m, { hash: "#1", markers: [reply] });
    const seq = p.tl().children.filter((n) => has(n, "quiet") || has(n, "pmark") || has(n, "row")).map((n) => (has(n, "quiet") ? `quiet:${n.textContent}` : has(n, "pmark") ? "marker" : "step"));
    const q1 = seq.indexOf("quiet:1 command, no file changed"), mk = seq.indexOf("marker"), q2 = seq.indexOf("quiet:2 commands, no file changed");
    assert.ok(q1 >= 0 && mk > q1 && q2 > mk, `quiet, marker, quiet in that order: ${seq.join(" | ")}`);
    assert.deepEqual(quietRows(p).filter((t) => /^[12] commands?, no file changed$/.test(t)), ["1 command, no file changed", "2 commands, no file changed"], "two rows, not one 3-call row");
  });

  it("a merged row of two actors opens as one calls view", async () => {
    const a = lanes[0]!, b = "codex";
    const m = withQuiet((x) => {
      if (!x.actors.some((o) => o.id === b)) x.actors.push({ ...x.actors[0]!, id: b, name: "Codex", main: false, col: x.actors.length } as never);
      x.stops.find((s) => s.quiet)!.quiet = { count: 3, calls: [{ id: "q1", text: "List the folder", lane: a }, { id: "q2", text: "Other actor call", lane: b }, { id: "q3", text: "Read a picture", lane: a }] };
    });
    const p = await boot(m, { hash: "#1" });
    assert.deepEqual(quietRows(p), ["3 commands, no file changed"]);
    p.tl().children.find((n) => has(n, "quiet"))!.children.find((c) => has(c, "qline"))!.click(); await p.settle();
    assert.equal(p.byId("h2").hidden, true);
  });
});
