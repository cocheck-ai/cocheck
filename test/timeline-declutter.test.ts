import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asServed, served } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import { translateShell } from "../src/timeline/describe.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// each step's body is decluttered (docs/design/review-page-v2.md, "Every step has the same frame", "Layout per step type", "AI text",
// "Words to cut"). Failure steps have no panes; "created"
// is said once; a change too big to read cell by cell is one card; a text change has no notes column; the view's limits sit behind one
// disclosure under one engine line; and no step body carries the cut words. The page code runs as is in a vm with a DOM stub.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string, over: Record<string, unknown> = {}): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` }, ...over }) as unknown as Change;
const call = (id: string, start: number, text: string, changes: Change[] = [], over: Record<string, unknown> = {}) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", error: null, closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text, source: "agent-description", label: "l" }, agent: null, ...over });
const failed = (id: string, start: number, text: string, error: string, over: Record<string, unknown> = {}) => call(id, start, text, [], { outcome: "failed", error, ...over });
const timeline = (calls: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: calls.length, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls }] }] } as unknown as Timeline);

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ location: `gdp!B${i + 2}`, kind: "value", before: "1", after: "2", text: "t", note: { text: `changed B${i + 2}`, source: "rule" } }));
const BIG = { module: "xlsx", rows: rows(100), more: 900, moreIn: [{ place: "gdp", count: 900, from: 102, to: 1001 }] };

// One request; a new file; two failed calls; one failed call that changed b.txt and c.txt (a header); a rewrite; a text change.
const build = (): RailModel => buildRailModel(timeline([
  call("k1", 1, "Write the new file", [change("n", "data/new.csv", "k1", { kind: "created", before: null, note: { text: "Claude created new.csv in the data folder.", source: "rule" } })]),
  failed("f1", 2, "Fetch FRED", "TimeoutError: The read operation timed out", { errorFull: "Exit code 1\nTraceback\nTimeoutError: The read operation timed out" }),
  failed("f2", 3, "Test the site", "Exit code 92"),
  call("k2", 4, "Rerun the fetch", [change("b", "b.txt", "k2"), change("c", "c.txt", "k2")], { outcome: "failed", error: "ValueError: bad sheet" }),
  call("k3", 5, "Pull the series again", [change("x", "macro.xlsx", "k3", { format: BIG })]),
  call("k4", 6, "Fix the fetch", [change("t", "fetch.py", "k4")]),
]));

// A grid view with one boxed cell and one caveat, and a text view for fetch.py.
const gridView = (key: string) => ({ change: key, file: "f", engine: "drawn by CoCheck from the cells, not by Excel", kind: "grid",
  before: [{ id: "before:S", label: "S", grid: { sheet: "gdp", columns: [{ name: "B" }], rows: [{ row: 2, cells: { B: { ref: "B2", text: "1" } } }] } }],
  after: [{ id: "after:S", label: "S", grid: { sheet: "gdp", columns: [{ name: "B" }], rows: [{ row: 2, cells: { B: { ref: "B2", text: "2" } } }] } }],
  boxes: [{ change: key, side: "after", pane: "after:S", cell: "B2" }], caveats: ["Charts are not drawn."] });
const textView = (key: string) => ({ change: key, file: "fetch.py", engine: "drawn by CoCheck from the lines of the file", kind: "grid",
  before: [{ id: "before:t", label: "fetch.py", text: { lines: [{ n: 1, text: "a = 1", kind: "edit", marks: [] }] } }],
  after: [{ id: "after:t", label: "fetch.py", text: { lines: [{ n: 1, text: "a = 2", kind: "edit", marks: [] }] } }],
  boxes: [{ change: key, side: "after", pane: "after:t", line: 1 }], caveats: [] });

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
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { if (!s.className.split(/\s+/).includes(c)) s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

async function boot(model: RailModel, grid: (key: string) => unknown = gridView) {
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => asServed(v) });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (ms === 6000 || f.name === "poll" ? 0 : setTimeout(f, 0)), clearTimeout() {},
    fetch: async (u: string) => {
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      const v = /\/view\/([^?]+)/.exec(u);
      if (v) return json(decodeURIComponent(v[1]!) === "t" ? textView("t") : grid(decodeURIComponent(v[1]!)));
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const row = (label: string) => byId("tl").children.find((r) => has(r, "row") && r.textContent.includes(label));
  const go = async (label: string) => {
    /* a file under a closed call header is reached by opening the header first (a click on a header opens or closes it) */
    if (!row(label)) { const h = byId("tl").children.find((r) => has(r, "hdr") && r.attrs["aria-expanded"] === "false"); h?.click(); await settle(); await settle(); }
    const r = row(label); assert.ok(r, `a rail row reads ${label}`); r!.click(); await settle(); await settle();
  };
  const ai = byId("h2");
  /* everything the step's body shows: the AI line, the header's failure line and files, the body, the notes, the panes */
  const shown = () => ["h2", "callfail", "hdrview", "bodyview", "reqtext", "notes", "vb", "va"].map((id) => (byId(id).hidden ? "" : byId(id).textContent)).join(" | ");
  return { byId, go, ai, shown, settle };
}

const BANNED = /the host|watched file|this moment|AI-written|Asked:|CoCheck saw no|Nothing in the work changed|workbook part/i;

describe("the model says each thing once", () => {
  it("a failure step has no subtitle, no 'no file changed' sentence, and each run keeps its whole output when it says more", () => {
    const g = build().stops.find((s) => s.runs)!;
    assert.equal(g.sub, undefined);
    assert.doesNotMatch(JSON.stringify(g.card), /no watched file|no file changed|the host/i);
    assert.deepEqual(g.runs, [
      { id: "f1", text: "Fetch FRED", error: "TimeoutError: The read operation timed out", output: "Exit code 1\nTraceback\nTimeoutError: The read operation timed out" },
      { id: "f2", text: "Test the site", error: "Exit code 92" },
    ]);
  });
  it("a new file's note does not say 'created' again", () => {
    const n = build().stops.find((s) => s.id === "chg-n")!;
    assert.match(n.head, /created/);
    assert.equal(n.change!.note, "");
  });
  it("a change too big to read cell by cell is one line: no cell notes, no more-changes line", () => {
    const x = build().stops.find((s) => s.id === "chg-x")!.change!;
    assert.equal(x.rewrite, true);
    assert.deepEqual(x.rowNotes, []);
    assert.equal(x.moreNote, null);
    assert.equal(x.note, "1000 changes in 'gdp'.");
  });
  it("a failed shell call is named by the step that failed, never by the harmless look before it", () => {
    assert.equal(translateShell("ls data/ && python3 fetch_fred.py"), "Listed files in data");
    assert.equal(translateShell("ls data/ && python3 fetch_fred.py", [], true), "Ran a Python script (fetch_fred.py), failed at a step in it"); // no error text, so no step is named as the failed one
    assert.equal(translateShell("cd macro && cat a.csv | head -3 && python3 x.py && echo done", [], true), "Ran a Python script (x.py), failed at a step in it");
    assert.equal(translateShell("cat a.csv", [], true), "Read a.csv");
  });
});

describe("the step bodies on the page", () => {
  it("a failure step has no panes: one row per run with its error line, and Show output only where there is more", async () => {
    const p = await boot(build());
    await p.go("2 runs failed");
    assert.equal(p.byId("stage").hidden, true, "no panes");
    assert.equal(p.byId("below").hidden, true);
    assert.equal(p.byId("bodyview").hidden, false);
    const fr = p.byId("bodyview").descendants().filter((n) => has(n, "mcard") && n.children.some((c) => has(c, "what")));
    assert.deepEqual(fr.map((r) => r.children.filter((c) => has(c, "what") || has(c, "err")).map((c) => c.textContent)), [["Fetch FRED", "TimeoutError: The read operation timed out"], ["Test the site", "Exit code 92"]]);
    const btns = fr.map((r) => r.children.find((c) => c.tag === "button"));
    assert.equal(btns[1], undefined, "nothing more to show on the second run");
    const out = fr[0]!.children.find((c) => c.tag === "pre")!;
    assert.equal(out.hidden, true);
    btns[0]!.click();
    assert.equal(out.hidden, false);
    assert.equal(out.textContent, "Exit code 1\nTraceback\nTimeoutError: The read operation timed out");
  });

  it("a header says when its call failed", async () => {
    const p = await boot(build());
    await p.go("Rerun the fetch");
    assert.equal(p.byId("callfail").hidden, false);
    assert.equal(p.byId("callfail").textContent, "The call failed.ValueError: bad sheet");
  });

  it("'created' is said once: no new-file card and no note restating it", async () => {
    const p = await boot(build());
    await p.go("new.csv");
    assert.equal((`${p.byId("h1").textContent} ${p.shown()}`.match(/created/gi) ?? []).length, 1, p.shown());
    assert.doesNotMatch(p.shown(), /New file/);
  });

  it("a change too big to read cell by cell is one card", async () => {
    const p = await boot(build(), (k) => ({ change: k, file: "macro.xlsx", engine: "drawn by CoCheck from the cells, not by Excel", kind: "card", before: [], after: [], boxes: [], caveats: [] }));
    await p.go("macro.xlsx");
    const notes = p.byId("notes").children;
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.textContent, "Changed macro.xlsx1000 changes in 'gdp'.");
  });

  // the rc.rewrite branch (review.js) is shadowed by the later "no items, so the change's one note" fallback whenever nothing else fills
  // the column, so the test above alone cannot tell the branch from its absence. This one can: a card is also served for the same change, and the
  // rewrite note must still stand first and the cell-level card must not stand alone, never a big change read as one cell's trivia.
  it("a change too big to read cell by cell: its one card leads", async () => {
    const cell = { place: "Sheet gdp, B2", verb: "Changed", before: "1", after: "2", text: "", loc: "gdp!B2" };
    const p = await boot(build(), (k) => served({ change: k, file: "macro.xlsx", engine: "drawn by CoCheck from the cells, not by Excel", kind: "card", before: [], after: [], boxes: [], caveats: [] }, { cards: [cell] }));
    await p.go("macro.xlsx");
    const notes = p.byId("notes").children;
    assert.equal(notes[0]!.textContent, "Changed macro.xlsx1000 changes in 'gdp'.", "the one card for the whole change comes first");
    assert.equal(notes.length, 1);
  });

  it("a text change has no notes column; the diff gets the width", async () => {
    const p = await boot(build());
    await p.go("fetch.py");
    assert.equal(p.byId("notes").children.length, 0);
    assert.ok(p.byId("stage").classList.contains("nonotes"));
  });

  it("no engine line is printed and the view's limits are notes in the Details panel (fix/notes-panel), not under the panes", async () => {
    const p = await boot(build());
    await p.go("macro.xlsx");
    assert.equal(p.byId("engine").textContent, "", "no engine line is drawn");
    assert.equal(p.byId("caveats").textContent, "");
    assert.equal(p.byId("about").hidden, true);
    assert.equal(p.byId("pbdcount").hidden, false, "the Details count shows the note");
    const shell = renderReviewShell(7);
    assert.match(shell, /<details class="about" id="about" hidden><summary>About this view<\/summary><p class="caveats" id="caveats"><\/p><\/details>/);
    assert.doesNotMatch(shell, /id="eb"|id="ea"|id="lb"|id="la"|id="engine"/, "no engine line or caption per pane");
    assert.equal((shell.match(/id="caveats"/g) ?? []).length, 1);
  });

  it("a message is a card under 'To <name>', edged in the sender's color", async () => {
    const m: RailModel = { task: 7, folder: "work", actors: [{ id: "claude", name: "Claude", chip: "C", color: "#6fb0e3", main: true }, { id: "helper1", name: "Helper 1", chip: "1", color: "#e0a458", parent: "claude" }],
      stops: [{ id: "idle-1", label: "Helper 1", lane: "helper1", head: "Helper 1 changed no file" }, { id: "msg-1", label: "Message to memo-writer", lane: "claude", head: "Claude sent a message to memo-writer: align", message: { from: "claude", to: "helper1", toName: "Helper 1", lines: ["Align the memo with the deck.", "Use end-2022."] } }] } as RailModel;
    const p = await boot(m);
    await p.go("Message to memo-writer");
    const b = p.byId("bodyview");
    assert.equal(b.hidden, false);
    assert.equal(p.byId("stage").hidden, true);
    const to = b.descendants().find((n) => has(n, "to"))!;
    assert.equal(to.textContent, "Claude to Helper 1");
    const card = b.descendants().find((n) => has(n, "mcard"))!;
    assert.equal(b.descendants().find((n) => has(n, "msg"))!.style["--lc"], "#6fb0e3");
    assert.deepEqual(card.children.map((c) => c.textContent), ["Align the memo with the deck.", "Use end-2022."]);
  });

  it("every sender kind renders through the one message component: sender line, then one card", async () => {
    const actors = [{ id: "claude", name: "Claude", chip: "C", color: "#6fb0e3", main: true }, { id: "helper1", name: "Helper 1", chip: "1", color: "#e0a458", parent: "claude" }];
    const m = { task: 7, folder: "work", actors, stops: [
      { id: "idle-1", label: "Helper 1", lane: "helper1", head: "Helper 1 changed no file" },
      { id: "msg-1", label: "Message to Helper 1", lane: "claude", head: "m", message: { from: "claude", to: "helper1", toName: "Helper 1", lines: ["Align the memo."] } },
      { id: "fin-1", label: "Helper 1 finished", lane: "claude", head: "Helper 1 finished: Memo saved.", title: "Finished: Memo saved.", card: { title: "Helper 1 finished", lines: [] }, message: { from: "helper1", to: "claude", toName: "Claude", lines: ['Agent "Memo writer" finished', "Memo saved."], helper: "helper1" } },
      { id: "rep-1", label: "Reply", lane: "claude", head: "r", message: { from: "claude", to: null, toName: "you", lines: ["All done."] } },
      { id: "run-1", label: "1 run failed", lane: "helper1", head: "f", runs: [{ text: "Fetch FRED", error: "Traceback\nTimeoutError: timed out" }] },
    ] } as unknown as RailModel;
    const p = await boot(m);
    const sender = async (label: string) => {
      await p.go(label);
      const roots = p.byId("bodyview").children.filter((n) => has(n, "msg") || has(n, "fails"));
      const msgs = roots.flatMap((r) => (has(r, "fails") ? r.children : [r]));
      for (const r of msgs) {
        assert.ok(has(r, "msg"), `${label}: a .msg root`);
        assert.ok(has(r.children[0]!, "to") && has(r.children[0]!.children[0]!, "mdot") && has(r.children[0]!.children[1]!, "mname"), `${label}: dot and name on one line`);
        assert.ok(has(r.children[1]!, "mcard"), `${label}: one card under it`);
      }
      return msgs.map((r) => r.children[0]!.textContent);
    };
    assert.deepEqual(await sender("Message to Helper 1"), ["Claude to Helper 1"]);
    assert.deepEqual(await sender("Helper 1 finished"), ["Helper 1 to Claude"]);
    assert.equal(p.byId("h1").textContent, "Helper 1 finished", "the heading names the actor");
    assert.doesNotMatch(p.byId("bodyview").textContent, /Agent "Memo writer"/, "the notification's own finish line is not repeated");
    assert.match(p.byId("bodyview").textContent, /Memo saved\./);
    assert.deepEqual(await sender("Reply"), ["Claude to you"]);
    assert.deepEqual(await sender("1 run failed"), ["Helper 1 Failed"]);
    assert.equal(p.byId("bodyview").descendants().find((n) => has(n, "err"))!.textContent, "TimeoutError: timed out", "the error's last line");
    const shell = renderReviewShell(7);
    assert.match(shell, /id="reqview" hidden><div class="msg ask"><p class="to"><i class="mdot"><\/i><b class="mname">You<\/b><\/p><div class="reqtext mcard" id="reqtext">/, "the request is the same component");
  });

  it("a helper that said nothing beyond finishing gets no card: the heading says it once, the files it changed still follow", async () => {
    const actors = [{ id: "claude", name: "Claude", chip: "C", color: "#6fb0e3", main: true }, { id: "helper1", name: "Helper 1", chip: "1", color: "#e0a458", parent: "claude" }];
    const m = { task: 7, folder: "work", actors, stops: [
      { id: "c-1", label: "Created notes.md", lane: "helper1", head: "Created notes.md", change: { id: "ch-1", file: "notes.md", kind: "created" } },
      { id: "fin-1", label: "Helper 1 finished", lane: "claude", head: "Helper 1 finished", card: { title: "Helper 1 finished", lines: [] }, message: { from: "helper1", to: "claude", toName: "Claude", lines: ['Agent "Memo writer" finished'], helper: "helper1" } },
    ] } as unknown as RailModel;
    const p = await boot(m);
    await p.go("Helper 1 finished");
    assert.equal(p.byId("h1").textContent, "Helper 1 finished");
    const body = p.byId("bodyview");
    assert.ok(!body.descendants().some((n) => has(n, "msg")), "no message card");
    assert.doesNotMatch(body.textContent, /finished/i, "the finish is not said again under the heading");
    assert.match(body.textContent, /What it changed/);
  });

  it("no cut word reaches any step's body", async () => {
    const m = build();
    const p = await boot(m);
    for (const label of ["new.csv", "2 runs failed", "Rerun the fetch", "b.txt", "c.txt", "macro.xlsx", "fetch.py"]) {
      await p.go(label);
      assert.doesNotMatch(p.shown(), BANNED, `${label}: ${p.shown()}`);
    }
  });
});
